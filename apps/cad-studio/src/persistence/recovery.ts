// Crash recovery (SPEC-5 FR-40). A lightweight snapshot of the live document is
// written (debounced) to localStorage on every edit — including an *untitled*
// document that was never saved to a named project. A successful save marks the
// snapshot clean; a crash/reload leaves it dirty, so on next launch the app can
// offer to recover the unsaved work. Storage is pluggable so it round-trips in
// Node tests (a Map fallback when localStorage is absent).

import type { CadDocument } from "../store/types.js";

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

const KEY = "cad-studio:recovery";

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

/** Persist the recovery snapshot (overwrites the previous one). */
export function writeRecovery(snap: RecoverySnapshot): void {
  try {
    store().setItem(KEY, JSON.stringify(snap));
  } catch {
    // Storage full / unavailable — recovery is best-effort, never fatal.
  }
}

/** Read the recovery snapshot, or null if none / corrupt. */
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

/** Drop the recovery snapshot (after recover/discard). */
export function clearRecovery(): void {
  try {
    store().removeItem(KEY);
  } catch {
    // ignore
  }
}
