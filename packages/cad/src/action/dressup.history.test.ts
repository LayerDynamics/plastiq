// §13.1 — fillet/chamfer expose maker-backed history via *WithHistory.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { faceIdRemap } from "../mesh/remap.js";
import {
  chamferWithHistory,
  draftWithHistory,
  filletWithHistory,
  shellWithHistory,
} from "./dressup.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("§13.1 dress-up history (fillet/chamfer makers)", () => {
  it("filletWithHistory returns maker history usable by faceIdRemap", () => {
    const box = makeBox(oc, mm(40), mm(40), mm(40));
    const prevMesh = tessellateTagged(oc, box);
    const edge = prevMesh.edges[0]!;
    const ref = {
      faceNormals: edge.faceNormals,
      midpoint: edge.midpoint,
      faceSurfaces: edge.faceSurfaces,
    };
    const r = filletWithHistory(oc, box, [ref], mm(4));
    try {
      expect(r.history, "fillet maker Modified/Generated/IsDeleted must be callable").toBeDefined();
      const curMesh = tessellateTagged(oc, r.solid);
      // Box 6 faces → filleted 7 (new cylinder).
      expect(curMesh.faceGroups.length).toBe(7);
      const map = faceIdRemap(oc, prevMesh, box, curMesh, r.solid, r.history);
      expect(map.size).toBe(6);
      expect(new Set(map.values()).size).toBe(6);
    } finally {
      r.history?.delete();
      r.solid.delete();
      box.delete();
    }
  });

  it("chamferWithHistory returns maker history usable by faceIdRemap", () => {
    const box = makeBox(oc, mm(40), mm(40), mm(40));
    const prevMesh = tessellateTagged(oc, box);
    const edge = prevMesh.edges[0]!;
    const ref = {
      faceNormals: edge.faceNormals,
      midpoint: edge.midpoint,
      faceSurfaces: edge.faceSurfaces,
    };
    const r = chamferWithHistory(oc, box, [ref], mm(3));
    try {
      expect(r.history).toBeDefined();
      const curMesh = tessellateTagged(oc, r.solid);
      // Chamfer also adds a new face (plane, not cylinder).
      expect(curMesh.faceGroups.length).toBeGreaterThanOrEqual(7);
      const map = faceIdRemap(oc, prevMesh, box, curMesh, r.solid, r.history);
      expect(map.size).toBe(6);
    } finally {
      r.history?.delete();
      r.solid.delete();
      box.delete();
    }
  });

  it("shellWithHistory retains inherited MakeShape history through faceIdRemap", () => {
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const prevMesh = tessellateTagged(oc, box);
    const top = prevMesh.faceGroups.find((face) => Math.round(face.normal[2]) === 1)!;
    const r = shellWithHistory(
      oc,
      box,
      [{ normal: top.normal, centroid: top.centroid, surface: top.surface }],
      mm(2),
    );
    try {
      expect(r.history).toBeDefined();
      const curMesh = tessellateTagged(oc, r.solid);
      const map = faceIdRemap(oc, prevMesh, box, curMesh, r.solid, r.history);
      expect(map.size).toBe(6);
      expect([...map.values()].some((id) => id >= 0)).toBe(true);
    } finally {
      r.history?.delete();
      r.solid.delete();
      box.delete();
    }
  });

  it("draftWithHistory retains inherited MakeShape history through faceIdRemap", () => {
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const prevMesh = tessellateTagged(oc, box);
    const side = prevMesh.faceGroups.find((face) => Math.round(face.normal[0]) === 1)!;
    const r = draftWithHistory(oc, box, {
      face: { normal: side.normal, centroid: side.centroid, surface: side.surface },
      pullDirection: [0, 0, 1],
      neutralOrigin: [0, 0, 0],
      neutralNormal: [0, 0, 1],
      angle: (5 * Math.PI) / 180,
    });
    try {
      expect(r.history).toBeDefined();
      const curMesh = tessellateTagged(oc, r.solid);
      const map = faceIdRemap(oc, prevMesh, box, curMesh, r.solid, r.history);
      expect(map.size).toBe(6);
      expect([...map.values()].every((id) => id >= 0)).toBe(true);
    } finally {
      r.history?.delete();
      r.solid.delete();
      box.delete();
    }
  });
});
