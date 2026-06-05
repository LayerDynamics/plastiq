// Project-store factory (SPEC-5 M5). Wires the real browser stack: sql.js (its
// WASM resolved through Vite's ?url) over an IndexedDB-backed DB image. Tests
// build a SqliteProjectStore directly with a MemoryBlobStore instead.

import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { IdbBlobStore } from "./idb.js";
import { createSqliteProjectStore } from "./sqlite.js";
import type { ProjectStore } from "./types.js";

let cached: Promise<ProjectStore> | null = null;

/** The app's project store (memoized): SQLite-in-browser persisted to IndexedDB. */
export function projectStore(): Promise<ProjectStore> {
  cached ??= (async () => {
    const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
    return createSqliteProjectStore({ SQL, blob: new IdbBlobStore() });
  })();
  return cached;
}

export type { Project, ProjectMeta, ProjectStore } from "./types.js";
