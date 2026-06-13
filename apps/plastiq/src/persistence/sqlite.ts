// SQLite-backed ProjectStore (SPEC-5 M5, FR-37) via sql.js (SQLite compiled to
// WASM). The DB lives in memory; after every mutation its image is exported and
// handed to a BlobStore (IndexedDB in the browser, in-memory in tests) so it is
// durable across reloads. Backend-agnostic of HOW sql.js was loaded — the caller
// passes the initialized SqlJsStatic (with the right locateFile).

import type { Database, SqlJsStatic } from "sql.js";
import type { CadDocument } from "../store/types.js";
import type { Project, ProjectMeta, ProjectStore, BlobStore } from "./types.js";

export interface SqliteStoreOptions {
  SQL: SqlJsStatic;
  blob: BlobStore;
  /** Clock for metadata timestamps (injectable for tests). */
  now?: () => number;
  /** Id generator for new projects (injectable for tests). */
  newId?: () => string;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  units TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  doc TEXT NOT NULL,
  thumbnail TEXT
);`;

function defaultId(): string {
  // Metadata id (not in the document path); crypto UUID when available.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `p-${Date.now()}-${Math.round(performance.now())}`;
}

/** Open (or create) the project store, restoring any persisted DB image. */
export async function createSqliteProjectStore(opts: SqliteStoreOptions): Promise<ProjectStore> {
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? defaultId;
  const existing = await opts.blob.load();
  const db: Database = existing ? new opts.SQL.Database(existing) : new opts.SQL.Database();
  db.run(SCHEMA);

  const persist = async (): Promise<void> => {
    await opts.blob.save(db.export());
  };

  const metaFromRow = (r: Record<string, unknown>): ProjectMeta => ({
    id: String(r["id"]),
    name: String(r["name"]),
    units: String(r["units"]),
    created: Number(r["created"]),
    updated: Number(r["updated"]),
    thumbnail: r["thumbnail"] == null ? null : String(r["thumbnail"]),
  });

  /** Run a query → array of column-keyed row objects. */
  const query = (sql: string, params: unknown[] = []): Record<string, unknown>[] => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  };

  return {
    async list(): Promise<ProjectMeta[]> {
      return query(
        "SELECT id, name, units, created, updated, thumbnail FROM projects ORDER BY updated DESC",
      ).map(metaFromRow);
    },

    async load(id: string): Promise<Project | null> {
      const rows = query("SELECT * FROM projects WHERE id = ?", [id]);
      const r = rows[0];
      if (!r) return null;
      return { meta: metaFromRow(r), doc: JSON.parse(String(r["doc"])) as CadDocument };
    },

    async create(name: string, doc: CadDocument, units = "mm"): Promise<ProjectMeta> {
      const t = now();
      const meta: ProjectMeta = {
        id: newId(),
        name,
        units,
        created: t,
        updated: t,
        thumbnail: null,
      };
      db.run(
        "INSERT INTO projects (id, name, units, created, updated, doc, thumbnail) VALUES (?,?,?,?,?,?,?)",
        [meta.id, meta.name, meta.units, meta.created, meta.updated, JSON.stringify(doc), null],
      );
      await persist();
      return meta;
    },

    async save(id: string, doc: CadDocument, thumbnail?: string | null): Promise<void> {
      if (thumbnail === undefined) {
        db.run("UPDATE projects SET doc = ?, updated = ? WHERE id = ?", [
          JSON.stringify(doc),
          now(),
          id,
        ]);
      } else {
        db.run("UPDATE projects SET doc = ?, updated = ?, thumbnail = ? WHERE id = ?", [
          JSON.stringify(doc),
          now(),
          thumbnail,
          id,
        ]);
      }
      // An UPDATE that matches no row writes nothing; persisting + resolving here
      // would report the save as succeeded while the document is silently lost
      // (e.g. the project was deleted in another tab). Reject so the caller knows.
      if (db.getRowsModified() === 0) {
        throw new Error(`save: no project with id '${id}' — nothing was written`);
      }
      await persist();
    },

    async rename(id: string, name: string): Promise<void> {
      db.run("UPDATE projects SET name = ?, updated = ? WHERE id = ?", [name, now(), id]);
      await persist();
    },

    async delete(id: string): Promise<void> {
      db.run("DELETE FROM projects WHERE id = ?", [id]);
      await persist();
    },
  };
}
