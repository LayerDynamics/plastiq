import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "./init.js";
import { OcArena, withArena } from "./arena.js";

const INIT_TIMEOUT_MS = 120_000;

describe("OcArena", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("tracks then frees handles (size returns to 0)", () => {
    const arena = new OcArena();
    arena.track(new oc.BRepPrimAPI_MakeBox_2(1, 2, 3));
    arena.track(new oc.BRepPrimAPI_MakeBox_2(4, 5, 6));
    expect(arena.size).toBe(2);
    arena.delete();
    expect(arena.size).toBe(0);
    arena.delete(); // idempotent — must not throw
  });

  it("withArena returns the value and frees temporaries on success", () => {
    const faces = withArena((a) => {
      const box = a.track(new oc.BRepPrimAPI_MakeBox_2(1, 1, 1));
      return box.Solid(); // returned value is the caller's; track nothing else
    });
    expect(faces).toBeDefined();
    faces.delete();
  });

  it("does not leak the WASM heap across repeated create/delete cycles", () => {
    const heap = () => (oc as unknown as { HEAP8: { byteLength: number } }).HEAP8.byteLength;
    // Warm up (first allocation may grow the heap once).
    withArena((a) => a.track(new oc.BRepPrimAPI_MakeBox_2(10, 20, 30)));
    const before = heap();
    for (let i = 0; i < 50; i++) {
      withArena((a) => {
        const mk = a.track(new oc.BRepPrimAPI_MakeBox_2(10, 20, 30));
        a.track(new oc.BRepCheck_Analyzer(mk.Solid(), true, false));
      });
    }
    // Freed memory is reused: the wasm Memory must not have grown.
    expect(heap()).toBe(before);
  });
});
