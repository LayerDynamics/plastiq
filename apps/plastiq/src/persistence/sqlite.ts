// SQLite-backed ProjectStore (SPEC-5 M5, FR-37) via sql.js (SQLite compiled to
// WASM). The SQLite DB is a lightweight METADATA INDEX only (id/name/units/
// created/updated); each project's heavy payload — its document and its thumbnail
// — lives in a per-id ProjectRecordStore. After a mutation only the (tiny) index
// image is exported to a BlobStore and only the ONE changed project's records are
// written, so a save costs O(changed-project) rather than O(whole-library) as it
// did when the whole DB (all docs + all PNG thumbnails) was re-serialized each
// time. Backend-agnostic of HOW sql.js was loaded — the caller passes the
// initialized SqlJsStatic (with the right locateFile).
//
// Pre-split databases (a single combined image whose `projects` table carried
// `doc`/`thumbnail` columns inline) are migrated to this layout on first open:
// each row's payload is moved into the record store and the table is rebuilt
// metadata-only. The migration is idempotent and gated by `PRAGMA user_version`.

import type { Database, SqlJsStatic } from "sql.js";
import type { PersistedDoc } from "../store/types.js";
import type {
  Project,
  ProjectMeta,
  ProjectStore,
  BlobStore,
  ProjectRecordStore,
} from "./types.js";

export interface SqliteStoreOptions {
  SQL: SqlJsStatic;
  /** Durable sink for the lightweight SQLite metadata-index image. */
  blob: BlobStore;
  /** Durable sink for per-project documents + thumbnails (keyed by project id). */
  records: ProjectRecordStore;
  /** Clock for metadata timestamps (injectable for tests). */
  now?: () => number;
  /** Id generator for new projects (injectable for tests). */
  newId?: () => string;
}

/** Bumped whenever the on-disk schema changes; gates the one-time migration. */
const SCHEMA_VERSION = 2;

const SCHEMA = `CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  units TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);`;

function defaultId(): string {
  // Metadata id (not in the document path); crypto UUID when available.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `p-${Date.now()}-${Math.round(performance.now())}`;
}

/** Open (or create) the project store, restoring any persisted DB image and
 * migrating a pre-split (inline doc/thumbnail) image into the record store. */
export async function createSqliteProjectStore(opts: SqliteStoreOptions): Promise<ProjectStore> {
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? defaultId;
  const records = opts.records;
  const existing = await opts.blob.load();
  const db: Database = existing ? new opts.SQL.Database(existing) : new opts.SQL.Database();

  const persistIndex = async (): Promise<void> => {
    await opts.blob.save(db.export());
  };

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

  const userVersion = (): number => {
    const res = db.exec("PRAGMA user_version");
    const v = res[0]?.values[0]?.[0];
    return typeof v === "number" ? v : 0;
  };

  /** Column names of a table (empty if it doesn't exist). `table` is always a
   * trusted literal here, so the interpolation is injection-safe. */
  const tableColumns = (table: string): string[] => {
    const res = db.exec(`PRAGMA table_info(${table})`);
    const head = res[0];
    if (!head) return [];
    const nameIdx = head.columns.indexOf("name");
    return head.values.map((row) => String(row[nameIdx]));
  };

  // Migrate a pre-split image: move each project's inline doc/thumbnail into the
  // record store, then rebuild `projects` as a metadata-only table. Returns true
  // if it rewrote the DB (so the caller persists the now-shrunk image). Idempotent
  // — re-running re-writes the same records and is gated by user_version.
  const migrate = async (): Promise<boolean> => {
    if (userVersion() >= SCHEMA_VERSION) return false;
    if (tableColumns("projects").includes("doc")) {
      for (const r of query("SELECT id, doc, thumbnail FROM projects")) {
        const id = String(r["id"]);
        await records.putDoc(id, JSON.parse(String(r["doc"])) as PersistedDoc);
        await records.putThumbnail(id, r["thumbnail"] == null ? null : String(r["thumbnail"]));
      }
      db.run("ALTER TABLE projects RENAME TO projects_legacy");
      db.run(SCHEMA);
      db.run(
        "INSERT INTO projects (id, name, units, created, updated) " +
          "SELECT id, name, units, created, updated FROM projects_legacy",
      );
      db.run("DROP TABLE projects_legacy");
      db.run("VACUUM"); // reclaim the freed doc/thumbnail pages so the image shrinks
    }
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return true;
  };

  const migrated = existing ? await migrate() : false;
  db.run(SCHEMA);
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  if (migrated) await persistIndex();

  // Thumbnails are shown in the project list but are heavy data-URL PNGs, so they
  // live in the record store, not the re-serialized index. Warm them once (a
  // single cursor over the thumbnails, no document reads) and keep the cache in
  // step on save/create/delete so list() stays a fast metadata-only query.
  let thumbCache: Map<string, string | null> | null = null;
  const warmThumbs = async (): Promise<Map<string, string | null>> => {
    if (!thumbCache) thumbCache = await records.allThumbnails();
    return thumbCache;
  };

  const metaFromRow = (r: Record<string, unknown>, thumbnail: string | null): ProjectMeta => ({
    id: String(r["id"]),
    name: String(r["name"]),
    units: String(r["units"]),
    created: Number(r["created"]),
    updated: Number(r["updated"]),
    thumbnail,
  });

  return {
    async list(): Promise<ProjectMeta[]> {
      const thumbs = await warmThumbs();
      return query(
        "SELECT id, name, units, created, updated FROM projects ORDER BY updated DESC",
      ).map((r) => metaFromRow(r, thumbs.get(String(r["id"])) ?? null));
    },

    async load(id: string): Promise<Project | null> {
      const rows = query(
        "SELECT id, name, units, created, updated FROM projects WHERE id = ?",
        [id],
      );
      const r = rows[0];
      if (!r) return null;
      const doc = await records.getDoc(id);
      if (doc == null) {
        // Metadata row present but its document payload is missing — the split
        // halves are out of sync (a partial write / corruption). Fail loudly
        // rather than fabricate an empty document and silently lose geometry.
        throw new Error(
          `load: project '${id}' has metadata but its document payload is missing`,
        );
      }
      const thumbnail = thumbCache?.get(id) ?? (await records.getThumbnail(id));
      return { meta: metaFromRow(r, thumbnail), doc };
    },

    async create(name: string, doc: PersistedDoc, units = "mm"): Promise<ProjectMeta> {
      const t = now();
      const meta: ProjectMeta = {
        id: newId(),
        name,
        units,
        created: t,
        updated: t,
        thumbnail: null,
      };
      await records.putDoc(meta.id, doc);
      await records.putThumbnail(meta.id, null);
      db.run("INSERT INTO projects (id, name, units, created, updated) VALUES (?,?,?,?,?)", [
        meta.id,
        meta.name,
        meta.units,
        meta.created,
        meta.updated,
      ]);
      thumbCache?.set(meta.id, null);
      await persistIndex();
      return meta;
    },

    async save(id: string, doc: PersistedDoc, thumbnail?: string | null): Promise<void> {
      // Bump the metadata row FIRST and check it matched before writing any
      // payload: an UPDATE that matches no row means the project was deleted (e.g.
      // in another tab), so persisting would report success while the document is
      // silently lost — and would orphan a payload record. Reject instead.
      db.run("UPDATE projects SET updated = ? WHERE id = ?", [now(), id]);
      if (db.getRowsModified() === 0) {
        throw new Error(`save: no project with id '${id}' — nothing was written`);
      }
      await records.putDoc(id, doc);
      // `undefined` thumbnail means "leave the existing thumbnail untouched"
      // (parity with the old SET-without-thumbnail UPDATE); `null` clears it.
      if (thumbnail !== undefined) {
        await records.putThumbnail(id, thumbnail);
        thumbCache?.set(id, thumbnail);
      }
      await persistIndex();
    },

    async rename(id: string, name: string): Promise<void> {
      db.run("UPDATE projects SET name = ?, updated = ? WHERE id = ?", [name, now(), id]);
      await persistIndex();
    },

    async delete(id: string): Promise<void> {
      db.run("DELETE FROM projects WHERE id = ?", [id]);
      await records.delete(id);
      thumbCache?.delete(id);
      await persistIndex();
    },
  };
}
