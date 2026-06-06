// Persistence contract (SPEC-5 M5, FR-37). A thin ProjectStore interface so the
// backend is swappable (R4/Q3): the document is just the serialized feature-tree
// (+ assembly), so any store that round-trips it reproducibly (FR-39) works. The
// SQLite (sql.js) backend is the real implementation; an in-memory one backs
// fast unit tests.

import type { CadDocument } from "../store/types.js";

/** Metadata for a saved project (NOT part of the deterministic document path). */
export interface ProjectMeta {
  readonly id: string;
  name: string;
  /** Display units tag (e.g. "mm"); the document is always SI internally. */
  units: string;
  /** Epoch ms — metadata only (the document path stays time/RNG-free, NFR-2). */
  created: number;
  updated: number;
  /** Data-URL PNG thumbnail of the viewport, or null. */
  thumbnail: string | null;
}

/** A full project: its metadata + the serialized document. */
export interface Project {
  readonly meta: ProjectMeta;
  readonly doc: CadDocument;
}

/** A durable key/value blob sink (the SQLite DB image lives here). */
export interface BlobStore {
  load(): Promise<Uint8Array | null>;
  save(blob: Uint8Array): Promise<void>;
}

/** CRUD over saved projects (FR-37). All async; persists after every mutation. */
export interface ProjectStore {
  /** Project metadata, newest-updated first. */
  list(): Promise<ProjectMeta[]>;
  /** Full project by id, or null if absent. */
  load(id: string): Promise<Project | null>;
  /** Create a new project from a document; returns its metadata (new id). */
  create(name: string, doc: CadDocument, units?: string): Promise<ProjectMeta>;
  /** Overwrite an existing project's document + optional thumbnail (updates `updated`). */
  save(id: string, doc: CadDocument, thumbnail?: string | null): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  delete(id: string): Promise<void>;
}
