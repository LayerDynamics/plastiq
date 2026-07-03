// Content-addressed recovery payload store (Review #13). Large import payloads
// (an importStep feature's verbatim STEP text) are heavy and immutable, so the
// crash-recovery snapshot must not re-serialize them into localStorage on every
// debounced edit — a single big import can blow the ~5 MB localStorage quota and
// silently kill crash recovery. Instead each payload is stored ONCE here, keyed
// by its content hash, and the snapshot carries a tiny `data.stepRef` in its
// place; recovery.ts compacts on write and re-inflates on read.
//
// The store lives in its own IndexedDB database (NOT idb.ts's "plastiq" DB) so
// it needs no schema-version coupling with the project store, and it falls back
// to an in-memory Map when IndexedDB is absent — mirroring recovery.ts's
// localStorage fallback so the whole path round-trips in Node tests.

const DB_NAME = "plastiq-recovery";
const DB_VERSION = 1;
const STORE = "payloads"; // key = content hash, value = payload text

/** In-memory fallback (Node tests / environments without IndexedDB). */
const memoryPayloads = new Map<string, string>();

function hasIdb(): boolean {
  return typeof (globalThis as { indexedDB?: IDBFactory }).indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

/** Run a single request against the payloads store and resolve with its result. */
async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await request(op(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

/** Pure-JS content hash — fallback when WebCrypto is unavailable (non-secure
 * contexts). Two independent FNV-1a lanes plus the length: collision-safe
 * enough for content-addressing a handful of import payloads; SHA-256 is used
 * whenever `crypto.subtle` exists. */
function fallbackHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ ((c + i + 1) & 0xffff), 0x01000193) >>> 0;
  }
  const hex = (n: number): string => n.toString(16).padStart(8, "0");
  return `fnv-${hex(a)}${hex(b)}-${text.length.toString(16)}`;
}

/** Content hash of a payload (SHA-256 hex via WebCrypto, with a pure-JS
 * fallback). Deterministic: the same text always yields the same key. */
export async function hashPayload(text: string): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) return fallbackHash(text);
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Store a payload under its content hash (idempotent overwrite). Throws on a
 * storage failure — the caller (recovery.ts) classifies and falls back. */
export async function putRecoveryPayload(hash: string, text: string): Promise<void> {
  if (!hasIdb()) {
    memoryPayloads.set(hash, text);
    return;
  }
  await run("readwrite", (s) => s.put(text, hash));
}

/** Fetch a payload by content hash, or null when absent. */
export async function getRecoveryPayload(hash: string): Promise<string | null> {
  if (!hasIdb()) return memoryPayloads.get(hash) ?? null;
  const v = await run<unknown>("readonly", (s) => s.get(hash));
  return typeof v === "string" ? v : null;
}

/** Delete every payload whose hash is not in `keep` (omit/empty `keep` to drop
 * them all). Best-effort garbage collection: recovery.ts calls this after a
 * successful compacted snapshot write and from clearRecovery. */
export async function pruneRecoveryPayloads(keep?: ReadonlySet<string>): Promise<void> {
  if (!hasIdb()) {
    for (const hash of [...memoryPayloads.keys()]) {
      if (!keep?.has(hash)) memoryPayloads.delete(hash);
    }
    return;
  }
  if (!keep || keep.size === 0) {
    await run("readwrite", (s) => s.clear());
    return;
  }
  const keys = await run("readonly", (s) => s.getAllKeys());
  for (const k of keys) {
    const hash = String(k);
    if (!keep.has(hash)) await run("readwrite", (s) => s.delete(hash));
  }
}
