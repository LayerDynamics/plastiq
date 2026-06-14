// MemoryBlobStore — UNIT: in-memory BlobStore (load/save) with copy isolation.

import { describe, expect, it } from "vitest";

import { MemoryBlobStore } from "./memory.js";

describe("MemoryBlobStore (unit)", () => {
  it("load returns null before anything is saved", async () => {
    expect(await new MemoryBlobStore().load()).toBeNull();
  });

  it("save then load round-trips the bytes, copied (not aliased)", async () => {
    const store = new MemoryBlobStore();
    const data = new Uint8Array([1, 2, 3]);
    await store.save(data);
    const loaded = await store.load();
    expect(Array.from(loaded!)).toEqual([1, 2, 3]);
    // Mutating the source must not change the stored blob (save copies).
    data[0] = 99;
    const again = await store.load();
    expect(again![0]).toBe(1);
  });
});
