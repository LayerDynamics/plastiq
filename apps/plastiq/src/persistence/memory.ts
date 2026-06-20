// In-memory stores (SPEC-5 M5): back fast unit tests of the SQLite project store
// without IndexedDB. MemoryBlobStore holds one copy of the metadata-index image
// in RAM; MemoryProjectRecordStore holds the per-project documents + thumbnails —
// so the same split-store logic that runs in the browser is exercised against
// real SQLite. Both copy on write/read so a stored value can't be aliased and
// mutated out from under the store (matching IndexedDB's structured-clone).

import type { CadDocument } from "../store/types.js";
import type { BlobStore, ProjectRecordStore } from "./types.js";

export class MemoryBlobStore implements BlobStore {
  private buf: Uint8Array | null = null;

  async load(): Promise<Uint8Array | null> {
    return this.buf ? this.buf.slice() : null;
  }

  async save(blob: Uint8Array): Promise<void> {
    this.buf = blob.slice();
  }
}

export class MemoryProjectRecordStore implements ProjectRecordStore {
  private docs = new Map<string, CadDocument>();
  private thumbs = new Map<string, string | null>();

  async getDoc(id: string): Promise<CadDocument | null> {
    const d = this.docs.get(id);
    return d === undefined ? null : (structuredClone(d) as CadDocument);
  }

  async getThumbnail(id: string): Promise<string | null> {
    return this.thumbs.get(id) ?? null;
  }

  async allThumbnails(): Promise<Map<string, string | null>> {
    return new Map(this.thumbs);
  }

  async putDoc(id: string, doc: CadDocument): Promise<void> {
    this.docs.set(id, structuredClone(doc) as CadDocument);
  }

  async putThumbnail(id: string, thumbnail: string | null): Promise<void> {
    this.thumbs.set(id, thumbnail);
  }

  async delete(id: string): Promise<void> {
    this.docs.delete(id);
    this.thumbs.delete(id);
  }
}
