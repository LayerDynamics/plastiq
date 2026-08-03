// mesh/resolve — PARAMETRIC survival (R1 / SPEC-4 FR-16, the P0-1 keystone).
//
// The core FR-16 promise: a FaceRef/EdgeRef captured on CURVED topology survives a
// parametric edit that MOVES or RESIZES that topology. Before R1 the analytic
// `surface`/`faceSurfaces` signatures never reached production and, when they did,
// a moved/resized face fell off a cliff — the exact `surfacesMatch` filter matched
// nothing and `resolve*` returned null (§4.3). These tests capture a hole-rim edge
// and the hole's cylindrical wall — both carrying their analytic signatures exactly
// as production now emits them — then prove they re-resolve after:
//   (i)  a hole-diameter change   (cylinder radius drifts → exact surface fails)
//   (ii) a hole translation       (cylinder axis drifts   → exact surface fails)
//   (iii) a union across UnifySameDomain (the boolean that FR-16 must survive)
// Each assertion is RED on the pre-R1 resolver (which returns null for a drifted
// analytic ref) and GREEN on the surface→kind→legacy fallback.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox, makeBoxAt, makeCylinder } from "../solid/primitives.js";
import { subtract, union } from "../action/boolean.js";
import { mm } from "../unit/index.js";
import type { Solid } from "../solid/solid.js";
import { edgeMidpoint } from "./normals.js";
import { resolveEdgeRef, resolveFaceRef } from "./resolve.js";
import { faceSurfaceSignature } from "./surface.js";
import { tessellateTagged } from "./tessellate.js";
import type { EdgeRef, FaceRef } from "./tagged.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** A 60×40×30 mm block with a through-hole of radius `r` (mm) along +Z, centred
 * at (cx, cy) mm. The rim edges (top/bottom circles where the plane meets the
 * cylinder) and the cylindrical wall are exactly the curved topology FR-16 tracks. */
function holedBlock(r: number, cx = 30, cy = 20): Solid {
  const block = makeBox(oc, mm(60), mm(40), mm(30));
  const drill = makeCylinder(oc, mm(r), mm(40), { origin: [mm(cx), mm(cy), mm(-5)] });
  const cut = subtract(oc, block, drill);
  block.delete();
  drill.delete();
  if (!cut.ok) throw new Error(`holedBlock: subtract failed: ${cut.error}`);
  return cut.solid;
}

/** The TOP hole-rim EdgeRef (plane∧cylinder circle, highest midpoint.z), carrying
 * `faceSurfaces` — exactly the shape the worker transfer now delivers (R1a/b). */
function topRimRef(solid: Solid): EdgeRef {
  const mesh = tessellateTagged(oc, solid, { linearDeflection: mm(0.2) });
  let best: EdgeRef | null = null;
  let bestZ = -Infinity;
  for (const e of mesh.edges) {
    const kinds = new Set([e.faceSurfaces[0].kind, e.faceSurfaces[1].kind]);
    if (!(kinds.has("plane") && kinds.has("cylinder"))) continue;
    if (e.midpoint[2] > bestZ) {
      bestZ = e.midpoint[2];
      best = { faceNormals: e.faceNormals, midpoint: e.midpoint, faceSurfaces: e.faceSurfaces };
    }
  }
  if (!best) throw new Error("topRimRef: no plane∧cylinder rim edge found");
  return best;
}

/** The cylindrical-wall FaceRef, carrying its analytic `surface` signature. */
function wallRef(solid: Solid): FaceRef {
  const mesh = tessellateTagged(oc, solid, { linearDeflection: mm(0.2) });
  const wall = mesh.faceGroups.find((g) => g.surface.kind === "cylinder");
  if (!wall) throw new Error("wallRef: no cylindrical face found");
  return { normal: wall.normal, centroid: wall.centroid, surface: wall.surface };
}

describe("R1 — analytic refs survive parametric edits on curved topology", () => {
  it("a hole-rim EdgeRef re-resolves after a DIAMETER change (exact surface drifts)", () => {
    const a = holedBlock(8);
    const ref = topRimRef(a);
    a.delete();

    const b = holedBlock(10); // Ø16 → Ø20: cylinder radius (and thus faceSurfaces) changes
    const edge = resolveEdgeRef(oc, b, ref);
    expect(edge).not.toBeNull(); // RED pre-R1: exact surfacesMatch fails → null (the cliff)
    const midB = edgeMidpoint(oc, edge!);
    expect(midB[2]).toBeCloseTo(mm(30), 4); // still the TOP rim, not the bottom one
    edge!.delete();
    b.delete();
  });

  it("a hole-rim EdgeRef re-resolves after a TRANSLATION (axis drifts)", () => {
    const a = holedBlock(8, 30, 20);
    const ref = topRimRef(a);
    a.delete();

    const b = holedBlock(8, 35, 20); // hole slid +5 mm in x
    const edge = resolveEdgeRef(oc, b, ref);
    expect(edge).not.toBeNull(); // RED pre-R1: cylinder axisPoint moved → surfacesMatch fails
    const midB = edgeMidpoint(oc, edge!);
    expect(midB[2]).toBeCloseTo(mm(30), 4);
    edge!.delete();
    b.delete();
  });

  it("a hole-rim EdgeRef survives a UNION across UnifySameDomain", () => {
    const a = holedBlock(8);
    const ref = topRimRef(a);

    const block2 = makeBoxAt(oc, [mm(60), 0, 0], mm(20), mm(40), mm(30)); // abuts +x face
    const fused = union(oc, a, block2);
    a.delete();
    block2.delete();
    if (!fused.ok) throw new Error(`union failed: ${fused.error}`);

    const edge = resolveEdgeRef(oc, fused.solid, ref);
    expect(edge).not.toBeNull();
    const midB = edgeMidpoint(oc, edge!);
    expect(midB[2]).toBeCloseTo(mm(30), 4);
    edge!.delete();
    fused.solid.delete();
  });

  it("the cylindrical-WALL FaceRef re-resolves after a diameter change (kind fallback)", () => {
    const a = holedBlock(8);
    const ref = wallRef(a);
    a.delete();

    const b = holedBlock(10);
    const face = resolveFaceRef(oc, b, ref);
    expect(face).not.toBeNull(); // RED pre-R1: closed cylinder normal is residue → legacy can't match
    // The resolved face is genuinely the (resized) cylindrical wall, not a plane.
    expect(faceSurfaceSignature(oc, face!).kind).toBe("cylinder");
    face!.delete();
    b.delete();
  });

  it("an unchanged analytic ref still resolves by the exact PRIMARY path (no regression)", () => {
    const a = holedBlock(8);
    const ref = wallRef(a);
    a.delete();

    const b = holedBlock(8); // identical rebuild — exact surfacesMatch must hit
    const face = resolveFaceRef(oc, b, ref);
    expect(face).not.toBeNull();
    expect(faceSurfaceSignature(oc, face!).kind).toBe("cylinder");
    face!.delete();
    b.delete();
  });
});
