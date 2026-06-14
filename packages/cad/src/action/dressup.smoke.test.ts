// action/dressup — SMOKE (real OCCT): fillet/chamfer/shell/draft run on a box using
// refs captured from its tessellation. Exact geometry is in dressup.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { deg, mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { EdgeRef, FaceRef } from "../mesh/tagged.js";
import { chamfer, draft, fillet, shell } from "./dressup.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("dressup — smoke", () => {
  it("fillet / chamfer / shell / draft all run on a box", () => {
    const box = makeBox(oc, mm(40), mm(40), mm(40));
    const mesh = tessellateTagged(oc, box);
    const edge: EdgeRef = { faceNormals: mesh.edges[0]!.faceNormals };
    const top: FaceRef = { normal: mesh.faceGroups.find((g) => Math.round(g.normal[2]) === 1)!.normal };
    const side: FaceRef = { normal: mesh.faceGroups.find((g) => Math.round(g.normal[0]) === 1)!.normal };

    const f = fillet(oc, box, [edge], mm(3));
    expect(f.volume()).toBeGreaterThan(0);
    f.delete();

    const c = chamfer(oc, box, [edge], mm(3));
    expect(c.volume()).toBeGreaterThan(0);
    c.delete();

    const hollow = shell(oc, box, [top], mm(3));
    expect(hollow.volume()).toBeGreaterThan(0);
    expect(hollow.volume()).toBeLessThan(box.volume()); // shelling removes material
    hollow.delete();

    const tapered = draft(oc, box, {
      face: side,
      pullDirection: [0, 0, 1],
      neutralOrigin: [0, 0, 0],
      neutralNormal: [0, 0, 1],
      angle: deg(5),
    });
    expect(tapered.volume()).toBeGreaterThan(0);
    tapered.delete();

    box.delete();
  });
});
