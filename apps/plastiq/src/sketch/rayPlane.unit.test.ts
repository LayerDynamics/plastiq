import { describe, expect, it } from "vitest";
import { planeXY, planeXZ } from "@plastiq/cad";
import { rayFromCameraThrough, rayIntersectPlane } from "./rayPlane.js";
import { uvToWorld, worldToUv } from "./worldMap.js";

describe("rayIntersectPlane", () => {
  it("hits the XY plane from above and returns UV", () => {
    const hit = rayIntersectPlane(
      { origin: [0.01, 0.02, 1], direction: [0, 0, -1] },
      planeXY(),
    );
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.uv[0]).toBeCloseTo(0.01, 12);
    expect(hit.uv[1]).toBeCloseTo(0.02, 12);
    expect(hit.t).toBeCloseTo(1, 12);
  });

  it("rejects a ray parallel to the plane", () => {
    const hit = rayIntersectPlane(
      { origin: [0, 0, 1], direction: [1, 0, 0] },
      planeXY(),
    );
    expect(hit).toEqual({ ok: false, reason: "parallel" });
  });

  it("rejects a ray pointing away from the plane", () => {
    const hit = rayIntersectPlane(
      { origin: [0, 0, 1], direction: [0, 0, 1] },
      planeXY(),
    );
    expect(hit).toEqual({ ok: false, reason: "behind" });
  });

  it("works on XZ (normal +Y) so free-camera draws still land on the plane", () => {
    const plane = planeXZ();
    // Camera at +Y, looking toward origin. planeXZ v-axis = N×X = −Z, so world z=+0.03 → v=−0.03.
    const hit = rayIntersectPlane(
      { origin: [0.05, 2, 0.03], direction: [0, -1, 0] },
      plane,
    );
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.uv[0]).toBeCloseTo(0.05, 12);
    expect(hit.uv[1]).toBeCloseTo(-0.03, 12);
  });
});

describe("worldMap UV ↔ world round-trip", () => {
  it("uvToWorld → worldToUv is identity on XY", () => {
    const p = planeXY();
    const w = uvToWorld(p, 0.04, -0.02);
    const uv = worldToUv(p, w);
    expect(uv[0]).toBeCloseTo(0.04, 12);
    expect(uv[1]).toBeCloseTo(-0.02, 12);
  });

  it("rayFromCameraThrough builds a direction through the far point", () => {
    const r = rayFromCameraThrough([0, 0, 5], [1, 2, 0]);
    expect(r.origin).toEqual([0, 0, 5]);
    expect(r.direction[0]).toBeCloseTo(1, 12);
    expect(r.direction[1]).toBeCloseTo(2, 12);
    expect(r.direction[2]).toBeCloseTo(-5, 12);
  });
});
