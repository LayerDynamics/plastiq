// MemoryBlobStore / MemoryProjectRecordStore — UNIT: the in-memory persistence
// backings (load/save + per-project records) with copy isolation.

import { describe, expect, it } from "vitest";

import { MemoryBlobStore, MemoryProjectRecordStore } from "./memory.js";
import type { CadDocument } from "../store/types.js";

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

describe("MemoryProjectRecordStore (unit)", () => {
  const doc = (dx: number): CadDocument => ({
    features: [{ id: "f1", type: "box", name: "Box 1", params: { dx } }],
    params: {},
  });

  it("getDoc / getThumbnail return null for an absent id", async () => {
    const store = new MemoryProjectRecordStore();
    expect(await store.getDoc("nope")).toBeNull();
    expect(await store.getThumbnail("nope")).toBeNull();
  });

  it("putDoc round-trips a deep copy (stored doc is not aliased to the input)", async () => {
    const store = new MemoryProjectRecordStore();
    const input = doc(0.05);
    await store.putDoc("a", input);
    input.features[0]!.name = "MUTATED"; // mutate the source after storing
    expect(((await store.getDoc("a"))! as CadDocument).features[0]!.name).toBe("Box 1");
  });

  it("putThumbnail stores the value, including an explicit null", async () => {
    const store = new MemoryProjectRecordStore();
    await store.putThumbnail("a", "data:image/png;base64,XX");
    expect(await store.getThumbnail("a")).toBe("data:image/png;base64,XX");
    await store.putThumbnail("a", null);
    expect(await store.getThumbnail("a")).toBeNull();
  });

  it("allThumbnails returns every stored thumbnail in one map", async () => {
    const store = new MemoryProjectRecordStore();
    await store.putThumbnail("a", "data:image/png;base64,A");
    await store.putThumbnail("b", null);
    const all = await store.allThumbnails();
    expect(all.get("a")).toBe("data:image/png;base64,A");
    expect(all.get("b")).toBeNull();
    expect(all.size).toBe(2);
  });

  it("delete removes both the document and the thumbnail", async () => {
    const store = new MemoryProjectRecordStore();
    await store.putDoc("a", doc(0.05));
    await store.putThumbnail("a", "data:image/png;base64,A");
    await store.delete("a");
    expect(await store.getDoc("a")).toBeNull();
    expect(await store.getThumbnail("a")).toBeNull();
    expect((await store.allThumbnails()).size).toBe(0);
  });
});
