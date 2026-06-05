import { beforeAll, describe, expect, it } from "vitest";
import { cut } from "../action/cut.js";
import { fillet } from "../action/fillet.js";
import { extrude } from "../action/extrude.js";
import { planeXY } from "../environment/plane.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { Sketch } from "../sketch/sketch.js";
import { mm } from "../unit/index.js";
import { tessellateTagged } from "./tagged.js";

const INIT_TIMEOUT_MS = 120_000;

describe("tagged tessellation (FR-6 — typed-selection support)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("a box: 6 face groups covering every triangle + 12 edge polylines", () => {
    const box = makeBox(oc, mm(20), mm(30), mm(40));
    try {
      const m = tessellateTagged(oc, box, { linearDeflection: mm(0.5) });
      expect(m.faceGroups).toHaveLength(6);
      expect(m.edges).toHaveLength(12);

      // Face groups partition the index buffer exactly (contiguous, no gaps).
      const sorted = [...m.faceGroups].sort((a, b) => a.start - b.start);
      let cursor = 0;
      for (const g of sorted) {
        expect(g.start).toBe(cursor);
        expect(g.count % 3).toBe(0); // whole triangles
        cursor += g.count;
      }
      expect(cursor).toBe(m.indices.length);
      expect(m.indices.length).toBeGreaterThanOrEqual(36); // ≥ 2 tris/face

      // faceIds are 1..6, edgeIds present, all coords finite, indices in range.
      expect(m.faceGroups.map((g) => g.faceId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(m.vertices.every(Number.isFinite)).toBe(true);
      const nVerts = m.vertices.length / 3;
      expect(m.indices.every((i) => i >= 0 && i < nVerts)).toBe(true);
      // Each box edge is straight → 2 endpoints (6 coords).
      for (const e of m.edges) expect(e.positions.length).toBeGreaterThanOrEqual(6);

      // A box has 8 corners; each is a distinct B-rep vertex with a finite point.
      expect(m.vertexPoints).toHaveLength(8);
      expect(m.vertexPoints.map((v) => v.vertexId).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(m.vertexPoints.every((v) => v.position.every(Number.isFinite))).toBe(true);
      // Corners sit at the box extents (0..20, 0..30, 0..40 mm in SI metres).
      for (const v of m.vertexPoints) {
        expect([0, mm(20)]).toContainEqual(expect.closeTo(v.position[0], 9));
        expect([0, mm(30)]).toContainEqual(expect.closeTo(v.position[1], 9));
        expect([0, mm(40)]).toContainEqual(expect.closeTo(v.position[2], 9));
      }
    } finally {
      box.delete();
    }
  });

  it("a filleted box: curved faces/edges tessellate to >1 segment", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const rounded = fillet(
      oc,
      box,
      [
        {
          faceNormals: [
            [0, 0, 1],
            [1, 0, 0],
          ],
        },
      ],
      mm(3),
    );
    try {
      const m = tessellateTagged(oc, rounded, { linearDeflection: mm(0.3) });
      // Filleting adds a cylindrical face + extra edges (more than the box's 6/12).
      expect(m.faceGroups.length).toBeGreaterThan(6);
      // The rounded edge discretizes to a polyline with interior points (>2).
      expect(m.edges.some((e) => e.positions.length > 6)).toBe(true);
      // Still a clean partition.
      const total = m.faceGroups.reduce((s, g) => s + g.count, 0);
      expect(total).toBe(m.indices.length);
    } finally {
      rounded.delete();
      box.delete();
    }
  });

  it("an extruded + pocketed part tessellates with per-face groups", () => {
    const base = extrude(oc, Sketch.rectangle(planeXY(), mm(40), mm(30)), mm(20));
    const tool = makeBoxAt(oc, [mm(10), mm(10), mm(-5)], mm(20), mm(20), mm(30));
    const part = cut(oc, base, tool);
    try {
      const m = tessellateTagged(oc, part, { linearDeflection: mm(0.4) });
      expect(m.faceGroups.length).toBeGreaterThanOrEqual(6);
      expect(m.edges.length).toBeGreaterThan(0);
      expect(m.indices.length).toBeGreaterThan(0);
    } finally {
      part.delete();
      tool.delete();
      base.delete();
    }
  });
});
