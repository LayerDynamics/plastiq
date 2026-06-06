// IndexedDB-backed BlobStore (SPEC-5 M5): durably holds the SQLite DB image so
// projects survive a page reload (FR-39). A single key/value record — the whole
// SQLite file lives under one key. Minimal, dependency-free.

import type { BlobStore } from "./types.js";

const DB_NAME = "plastiq";
const STORE = "kv";
const KEY = "project-db";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

export class IdbBlobStore implements BlobStore {
  async load(): Promise<Uint8Array | null> {
    const db = await openDb();
    try {
      const v = await tx<unknown>(db, "readonly", (s) => s.get(KEY));
      return v instanceof Uint8Array ? v : null;
    } finally {
      db.close();
    }
  }

  async save(blob: Uint8Array): Promise<void> {
    const db = await openDb();
    try {
      await tx(db, "readwrite", (s) => s.put(blob, KEY));
    } finally {
      db.close();
    }
  }
}
