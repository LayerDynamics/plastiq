// In-memory BlobStore (SPEC-5 M5): backs fast unit tests of the SQLite store
// without IndexedDB. Holds one copy of the DB image in RAM, so the same store
// logic that runs in the browser is exercised against real SQLite.

import type { BlobStore } from "./types.js";

export class MemoryBlobStore implements BlobStore {
  private buf: Uint8Array | null = null;

  async load(): Promise<Uint8Array | null> {
    return this.buf ? this.buf.slice() : null;
  }

  async save(blob: Uint8Array): Promise<void> {
    this.buf = blob.slice();
  }
}
