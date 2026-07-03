// Crash recovery (SPEC-5 FR-40). A lightweight snapshot of the live document is
// written (debounced) to localStorage on every edit — including an *untitled*
// document that was never saved to a named project. A successful save marks the
// snapshot clean; a crash/reload leaves it dirty, so on next launch the app can
// offer to recover the unsaved work. Storage is pluggable so it round-trips in
// Node tests (a Map fallback when localStorage is absent).
//
// Robustness (Review #13):
//   • writeRecovery REPORTS its outcome (RecoveryWriteResult) instead of
//     swallowing failures — the caller surfaces quota exhaustion on the status
//     line. The write itself stays best-effort: it never throws into editing.
//   • Large import payloads (an importStep feature's verbatim STEP text) are
//     NOT re-serialized into every snapshot. Each payload is stored once,
//     content-addressed by hash, in the recovery payload store
//     (recoveryPayloads.ts); the snapshot carries a tiny
//     `data.stepRef = { hash, bytes }` in its place. readRecovery returns that
//     compact form; hydrateRecovery re-inflates it before the document is
//     loaded, so a recovered document rebuilds IDENTICALLY (the STEP text is
//     the import feature's source of truth). If a payload is missing, the ref
//     is left in place and the rebuild fails loudly for that feature
//     (worker/rebuild.ts) — geometry is never fabricated.

import type { CadDocument, EditorFeature } from "../store/types.js";
import {
  getRecoveryPayload,
  hashPayload,
  pruneRecoveryPayloads,
  putRecoveryPayload,
} from "./recoveryPayloads.js";

export interface RecoverySnapshot {
  doc: CadDocument;
  name: string;
  /** The named project this document belongs to, or null if still untitled. */
  currentId: string | null;
  /** True = edited since the last successful save (recover on next launch). */
  dirty: boolean;
  /** Epoch ms of the snapshot (for the recovery prompt). */
  savedAt: number;
}

/** Outcome of a recovery-snapshot write: best-effort, but never silent. `quota`
 * means browser storage is full — recovery is NOT protecting the current work,
 * so the caller should tell the user to save. */
export type RecoveryWriteResult =
  | { ok: true }
  | { ok: false; reason: "quota" | "error"; message: string };

/** A compacted import payload reference (`data.stepRef`) inside a snapshot:
 * the content hash addressing the payload store, plus the payload's length so
 * hydration can sanity-check what it fetches. */
export interface StepPayloadRef {
  hash: string;
  bytes: number;
}

/** Import payloads at/above this size are externalized from the snapshot into
 * the payload store. localStorage quota is typically ~5 MB TOTAL, so anything
 * beyond tens of KB per feature is meaningful; below it, inlining is simpler. */
export const COMPACT_MIN_BYTES = 64 * 1024;

const KEY = "plastiq:recovery";

interface KeyValue {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const memoryFallback = new Map<string, string>();
const memoryStore: KeyValue = {
  getItem: (k) => memoryFallback.get(k) ?? null,
  setItem: (k, v) => void memoryFallback.set(k, v),
  removeItem: (k) => void memoryFallback.delete(k),
};

function store(): KeyValue {
  const ls = (globalThis as { localStorage?: KeyValue }).localStorage;
  return ls ?? memoryStore;
}

/** True for a storage quota-exhaustion error (localStorage or IndexedDB), in
 * any of the dialects browsers signal it with. */
export function isQuotaError(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return (
      err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED" || // legacy Firefox
      err.code === 22 ||
      err.code === 1014
    );
  }
  return err instanceof Error && /quota/i.test(`${err.name} ${err.message}`);
}

export function isStepPayloadRef(v: unknown): v is StepPayloadRef {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as StepPayloadRef).hash === "string" &&
    typeof (v as StepPayloadRef).bytes === "number"
  );
}

/** Session memo: payload text → content hash, so the debounced snapshot writes
 * don't re-hash a multi-MB import on every edit. Small and bounded. */
const HASH_MEMO_LIMIT = 8;
const hashMemo = new Map<string, string>();

async function memoHash(text: string): Promise<string> {
  const hit = hashMemo.get(text);
  if (hit) return hit;
  const hash = await hashPayload(text);
  hashMemo.set(text, hash);
  if (hashMemo.size > HASH_MEMO_LIMIT) hashMemo.delete(hashMemo.keys().next().value!);
  return hash;
}

/** Hashes known to be in the payload store this session — skips the redundant
 * multi-MB IndexedDB put on every debounced snapshot. Cleared on prune/clear. */
const persistedHashes = new Set<string>();

/** Rewrite every feature — including any nested boolean-tool subtree
 * (`data.toolFeatures`) — through `fn`, immutably. */
function mapFeatures(
  features: EditorFeature[],
  fn: (f: EditorFeature) => EditorFeature,
): EditorFeature[] {
  return features.map((f) => {
    const tools = f.data?.["toolFeatures"];
    const withTools = Array.isArray(tools)
      ? { ...f, data: { ...f.data, toolFeatures: mapFeatures(tools as EditorFeature[], fn) } }
      : f;
    return fn(withTools);
  });
}

/** Every inline import payload at/above `minBytes`, across nested subtrees. */
function collectLargeSteps(
  features: EditorFeature[],
  minBytes: number,
  out: string[] = [],
): string[] {
  for (const f of features) {
    const step = f.data?.["step"];
    if (f.type === "importStep" && typeof step === "string" && step.length >= minBytes) {
      out.push(step);
    }
    const tools = f.data?.["toolFeatures"];
    if (Array.isArray(tools)) collectLargeSteps(tools as EditorFeature[], minBytes, out);
  }
  return out;
}

/** Every unhydrated payload ref (a `stepRef` with no inline `step`) in the doc. */
function collectStepRefs(features: EditorFeature[], out: StepPayloadRef[] = []): StepPayloadRef[] {
  for (const f of features) {
    const ref = f.data?.["stepRef"];
    if (isStepPayloadRef(ref) && typeof f.data?.["step"] !== "string") out.push(ref);
    const tools = f.data?.["toolFeatures"];
    if (Array.isArray(tools)) collectStepRefs(tools as EditorFeature[], out);
  }
  return out;
}

/** Replace each large inline payload with its content-addressed ref. Returns
 * the compact document plus the payloads (hash → text) it now depends on. */
async function compactDoc(
  doc: CadDocument,
  minBytes: number,
): Promise<{ doc: CadDocument; payloads: Map<string, string> }> {
  const payloads = new Map<string, string>();
  const refByText = new Map<string, StepPayloadRef>();
  for (const text of collectLargeSteps(doc.features, minBytes)) {
    if (refByText.has(text)) continue;
    const hash = await memoHash(text);
    refByText.set(text, { hash, bytes: text.length });
    payloads.set(hash, text);
  }
  const features = mapFeatures(doc.features, (f) => {
    const step = f.data?.["step"];
    const ref = typeof step === "string" ? refByText.get(step) : undefined;
    if (!ref) return f;
    const data: Record<string, unknown> = { ...f.data, stepRef: ref };
    delete data["step"];
    return { ...f, data };
  });
  return { doc: { ...doc, features }, payloads };
}

function failed(err: unknown): RecoveryWriteResult {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, reason: isQuotaError(err) ? "quota" : "error", message };
}

/** The final localStorage write — synchronous, classified, never throws. */
function persistSnapshot(snap: RecoverySnapshot): RecoveryWriteResult {
  try {
    store().setItem(KEY, JSON.stringify(snap));
    return { ok: true };
  } catch (err) {
    return failed(err);
  }
}

async function writeCompacted(
  snap: RecoverySnapshot,
  minBytes: number,
): Promise<RecoveryWriteResult> {
  try {
    const { doc, payloads } = await compactDoc(snap.doc, minBytes);
    for (const [hash, text] of payloads) {
      if (persistedHashes.has(hash)) continue;
      await putRecoveryPayload(hash, text);
      persistedHashes.add(hash);
    }
    const result = persistSnapshot({ ...snap, doc });
    if (result.ok) {
      // GC payloads the snapshot no longer references (best-effort, async).
      const keep = new Set(payloads.keys());
      for (const h of [...persistedHashes]) if (!keep.has(h)) persistedHashes.delete(h);
      void pruneRecoveryPayloads(keep).catch(() => undefined);
    }
    return result;
  } catch (err) {
    // The payload store failed (unavailable, or its own quota): fall back to
    // the full inline snapshot — bigger, but recovery stays complete. Only if
    // THAT also fails is the write reported lost (quota wins as the reason).
    const inline = persistSnapshot(snap);
    if (inline.ok) return inline;
    return isQuotaError(err) ? failed(err) : inline;
  }
}

/**
 * Persist the recovery snapshot (overwrites the previous one), externalizing
 * large import payloads into the content-addressed payload store first.
 * Best-effort: never rejects and never throws into the editing path — the
 * returned result says whether the snapshot actually landed (and why not).
 * When nothing needs externalizing, the localStorage write happens
 * synchronously before the returned promise resolves (the pre-#13 behaviour).
 */
export function writeRecovery(
  snap: RecoverySnapshot,
  opts?: { compactMinBytes?: number },
): Promise<RecoveryWriteResult> {
  const minBytes = opts?.compactMinBytes ?? COMPACT_MIN_BYTES;
  try {
    if (collectLargeSteps(snap.doc.features, minBytes).length === 0) {
      return Promise.resolve(persistSnapshot(snap));
    }
    return writeCompacted(snap, minBytes);
  } catch (err) {
    return Promise.resolve(failed(err));
  }
}

/** Read the recovery snapshot, or null if none / corrupt. May contain
 * compacted `stepRef` payload references — pass it through hydrateRecovery
 * before loading the document. */
export function readRecovery(): RecoverySnapshot | null {
  try {
    const raw = store().getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as RecoverySnapshot;
    if (!v || typeof v !== "object" || !v.doc) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Re-inflate a snapshot's compacted import payloads (`data.stepRef` → inline
 * `data.step`) from the payload store, so the recovered document rebuilds
 * identically to the one that was snapshotted. Never throws: a missing or
 * unavailable payload leaves its ref in place, and the rebuild fails loudly
 * for that feature (worker/rebuild.ts) — geometry is never fabricated.
 */
export async function hydrateRecovery(snap: RecoverySnapshot): Promise<RecoverySnapshot> {
  try {
    const texts = new Map<string, string>();
    for (const ref of collectStepRefs(snap.doc.features)) {
      if (texts.has(ref.hash)) continue;
      try {
        const text = await getRecoveryPayload(ref.hash);
        // Length check: never inflate a payload that isn't the one referenced.
        if (typeof text === "string" && text.length === ref.bytes) texts.set(ref.hash, text);
      } catch {
        // Payload store unavailable — leave the ref; rebuild reports it loudly.
      }
    }
    if (texts.size === 0) return snap;
    const features = mapFeatures(snap.doc.features, (f) => {
      const ref = f.data?.["stepRef"];
      if (!isStepPayloadRef(ref)) return f;
      const text = texts.get(ref.hash);
      if (typeof text !== "string") return f;
      const data: Record<string, unknown> = { ...f.data, step: text };
      delete data["stepRef"];
      return { ...f, data };
    });
    return { ...snap, doc: { ...snap.doc, features } };
  } catch {
    return snap;
  }
}

/** Drop the recovery snapshot (after recover/discard), and GC its
 * content-addressed payloads (best-effort, async). */
export function clearRecovery(): void {
  try {
    store().removeItem(KEY);
  } catch {
    // ignore
  }
  persistedHashes.clear();
  void pruneRecoveryPayloads().catch(() => undefined);
}
