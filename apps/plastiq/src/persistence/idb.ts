// IndexedDB-backed persistence (SPEC-5 M5). Two durable sinks share one database:
//   • IdbBlobStore — the lightweight SQLite metadata-index image, under one key.
//   • IdbProjectRecordStore — each project's heavy payload (document + thumbnail)
//     under its own key, so a mutation rewrites only the changed project rather
//     than the whole library (FR-39 durability, dependency-free).
// Documents and thumbnails live in separate object stores so the project list can
// warm its thumbnails (a cursor over `thumbs`) without reading any documents.

import type { CadDocument } from "../store/types.js";
import type { BlobStore, ProjectRecordStore } from "./types.js";

const DB_NAME = "plastiq";
// v2 adds the per-project `docs`/`thumbs` stores alongside the original `kv`
// image store. The upgrade only creates missing stores, so a v1 database (which
// has the old single combined image) upgrades in place; createSqliteProjectStore
// then migrates that image's inline doc/thumbnail columns into these stores.
const DB_VERSION = 2;
const KV_STORE = "kv"; // single-image SQLite metadata index
const DOC_STORE = "docs"; // per-project document, keyed by project id
const THUMB_STORE = "thumbs"; // per-project thumbnail, keyed by project id
const IMAGE_KEY = "project-db";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE);
      if (!db.objectStoreNames.contains(THUMB_STORE)) db.createObjectStore(THUMB_STORE);
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

/** Run a single request against one object store and resolve with its result. */
function run<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return request(op(db.transaction(store, mode).objectStore(store)));
}

export class IdbBlobStore implements BlobStore {
  async load(): Promise<Uint8Array | null> {
    const db = await openDb();
    try {
      const v = await run<unknown>(db, KV_STORE, "readonly", (s) => s.get(IMAGE_KEY));
      return v instanceof Uint8Array ? v : null;
    } finally {
      db.close();
    }
  }

  async save(blob: Uint8Array): Promise<void> {
    const db = await openDb();
    try {
      await run(db, KV_STORE, "readwrite", (s) => s.put(blob, IMAGE_KEY));
    } finally {
      db.close();
    }
  }
}

export class IdbProjectRecordStore implements ProjectRecordStore {
  async getDoc(id: string): Promise<CadDocument | null> {
    const db = await openDb();
    try {
      const v = await run<unknown>(db, DOC_STORE, "readonly", (s) => s.get(id));
      return v == null ? null : (v as CadDocument);
    } finally {
      db.close();
    }
  }

  async getThumbnail(id: string): Promise<string | null> {
    const db = await openDb();
    try {
      const v = await run<unknown>(db, THUMB_STORE, "readonly", (s) => s.get(id));
      return typeof v === "string" ? v : null;
    } finally {
      db.close();
    }
  }

  async allThumbnails(): Promise<Map<string, string | null>> {
    const db = await openDb();
    try {
      return await new Promise<Map<string, string | null>>((resolve, reject) => {
        const out = new Map<string, string | null>();
        const req = db.transaction(THUMB_STORE, "readonly").objectStore(THUMB_STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(out);
            return;
          }
          out.set(String(cursor.key), typeof cursor.value === "string" ? cursor.value : null);
          cursor.continue();
        };
        req.onerror = () => reject(req.error ?? new Error("indexedDB cursor failed"));
      });
    } finally {
      db.close();
    }
  }

  async putDoc(id: string, doc: CadDocument): Promise<void> {
    const db = await openDb();
    try {
      await run(db, DOC_STORE, "readwrite", (s) => s.put(doc, id));
    } finally {
      db.close();
    }
  }

  async putThumbnail(id: string, thumbnail: string | null): Promise<void> {
    const db = await openDb();
    try {
      await run(db, THUMB_STORE, "readwrite", (s) => s.put(thumbnail, id));
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    const db = await openDb();
    try {
      await run(db, DOC_STORE, "readwrite", (s) => s.delete(id));
      await run(db, THUMB_STORE, "readwrite", (s) => s.delete(id));
    } finally {
      db.close();
    }
  }
}
