// Tests the geometry worker's pure request-handling core (handleRequest +
// effectiveAssembly) against the real OCCT wasm — the message handlers and the
// single-body fallback that geometry.worker.ts wires to onmessage/postMessage.

import { beforeAll, describe, expect, it } from "vitest";
import { importStep, initOcct, massProperties, mm, type Occt } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import { eulerXYZQuat } from "../viewport/placement.js";
import { effectiveAssembly, handleRequest } from "./geometry.worker.core.js";

const INIT_TIMEOUT_MS = 120_000;

const boxDoc = (): CadDocument => ({
  features: [{ id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } }],
  params: {},
});

/** The same box, gizmo-moved: rotated π/2 about Z then lifted 0.5 m (§2.11.1). */
const placedBoxDoc = (): CadDocument => ({
  features: [
    { id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } },
    { id: "f2", type: "placement", params: { tz: 0.5, rz: Math.PI / 2 } },
  ],
  params: {},
});

/** The same box as a 3-instance assembly: a mated row along +X (§2.11.2). */
const assemblyDoc = (): CadDocument => ({
  features: [{ id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } }],
  params: {},
  assembly: {
    instances: [
      { id: "i1", name: "A", pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] } },
      { id: "i2", name: "B", pose: { position: [0.1, 0, 0], orientation: [0, 0, 0, 1] } },
      {
        id: "i3",
        name: "C",
        pose: { position: [0.2, 0, 0], orientation: eulerXYZQuat(0, 0, Math.PI / 2) },
      },
    ],
    mates: [],
    joints: [],
  },
});

const emptyDoc = (): CadDocument => ({ features: [], params: {} });

/** The centre of mass of the solid a STEP string carries (SI metres). */
const stepCom = (oc: Occt, content: string): [number, number, number] => {
  const solid = importStep(oc, content);
  try {
    const c = massProperties(oc, solid, 1).com;
    return [c[0], c[1], c[2]];
  } finally {
    solid.delete();
  }
};

/** The total volume of everything a STEP string carries (SI m³). */
const stepVolume = (oc: Occt, content: string): number => {
  const solid = importStep(oc, content);
  try {
    return massProperties(oc, solid, 1).volume;
  } finally {
    solid.delete();
  }
};

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, INIT_TIMEOUT_MS);

describe("effectiveAssembly", () => {
  it("wraps a bare part (no instances) as a single identity-posed body0", () => {
    const a = effectiveAssembly(boxDoc());
    expect(a.instances).toHaveLength(1);
    expect(a.instances[0]!.id).toBe("body0");
    expect(a.instances[0]!.pose.position).toEqual([0, 0, 0]);
    expect(a.instances[0]!.pose.orientation).toEqual([0, 0, 0, 1]);
    expect(a.mates).toHaveLength(0);
    expect(a.joints).toHaveLength(0);
  });

  it("poses body0 at the document's placement (§2.11.1 — no teleport to origin)", () => {
    const a = effectiveAssembly(placedBoxDoc());
    expect(a.instances).toHaveLength(1);
    expect(a.instances[0]!.pose.position).toEqual([0, 0, 0.5]);
    const q = eulerXYZQuat(0, 0, Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      expect(a.instances[0]!.pose.orientation[i]).toBeCloseTo(q[i]!, 12);
    }
  });

  it("passes an assembly that already has instances through unchanged", () => {
    const doc: CadDocument = {
      ...boxDoc(),
      assembly: {
        instances: [
          { id: "i1", name: "A", pose: { position: [1, 2, 3], orientation: [0, 0, 0, 1] } },
          { id: "i2", name: "B", pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] } },
        ],
        mates: [],
        joints: [],
      },
    };
    const a = effectiveAssembly(doc);
    expect(a.instances).toHaveLength(2);
    expect(a.instances.map((i) => i.id)).toEqual(["i1", "i2"]);
  });
});

describe("handleRequest — build", () => {
  it("rebuilds a box doc into a transferable mesh and lists its buffers", async () => {
    const { response, transfer } = await handleRequest(oc, {
      id: 1,
      op: "build",
      doc: boxDoc(),
      deflection: mm(0.5),
    });
    expect(response.ok).toBe(true);
    if (!response.ok || response.op !== "build") throw new Error("expected a build response");
    expect(response.mesh).not.toBeNull();
    expect(response.mesh!.faceGroups).toHaveLength(6);
    expect(response.mesh!.volume).toBeCloseTo(mm(40) * mm(30) * mm(20), 9);
    // The transfer list carries the mesh's typed-array buffers (zero-copy hand-off).
    expect(transfer).toContain(response.mesh!.vertices.buffer);
    expect(transfer).toContain(response.mesh!.indices.buffer);
  });

  it("returns mesh=null (no transfer) for a document with no geometry", async () => {
    const { response, transfer } = await handleRequest(oc, {
      id: 2,
      op: "build",
      doc: emptyDoc(),
      deflection: mm(0.5),
    });
    expect(response.ok).toBe(true);
    if (!response.ok || response.op !== "build") throw new Error("expected a build response");
    expect(response.mesh).toBeNull();
    expect(transfer).toHaveLength(0);
  });
});

describe("handleRequest — lower (single-body fallback)", () => {
  it("lowers a bare part as ONE body via the body0 fallback", async () => {
    const { response } = await handleRequest(oc, { id: 3, op: "lower", doc: boxDoc() });
    expect(response.ok).toBe(true);
    if (!response.ok || response.op !== "lower") throw new Error("expected a lower response");
    // The bare part (no assembly) lowers to exactly one rigid body.
    expect(response.manifest.bodies).toHaveLength(1);
    expect(response.manifest.bodies[0]!.colliders.length).toBeGreaterThanOrEqual(1);
    expect(response.skippedJoints).toEqual([]);
    expect(response.localCom).toHaveLength(3);
  });

  it("returns a typed error when there is no geometry to lower", async () => {
    const { response } = await handleRequest(oc, { id: 4, op: "lower", doc: emptyDoc() });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("expected an error response");
    expect(response.error).toMatch(/no geometry/);
  });

  it("lowers a placed part AT its placement pose (§2.11.1 — sim starts where the viewport shows it)", async () => {
    const { response } = await handleRequest(oc, { id: 10, op: "lower", doc: placedBoxDoc() });
    expect(response.ok).toBe(true);
    if (!response.ok || response.op !== "lower") throw new Error("expected a lower response");
    expect(response.manifest.bodies).toHaveLength(1);
    // The manifest body's world COM composes the placement over the local COM:
    // Rz(π/2)·localCom + (0, 0, 0.5); Rz(π/2) maps (x, y, z) → (−y, x, z).
    const local = response.localCom;
    const world = response.manifest.bodies[0]!.com;
    expect(world[0]).toBeCloseTo(-local[1]!, 9);
    expect(world[1]).toBeCloseTo(local[0]!, 9);
    expect(world[2]).toBeCloseTo(local[2]! + 0.5, 9);
  });
});

describe("handleRequest — export", () => {
  it("exports the rebuilt part to a STEP string", async () => {
    const { response } = await handleRequest(oc, {
      id: 5,
      op: "export",
      doc: boxDoc(),
      format: "step",
    });
    expect(response.ok).toBe(true);
    if (!response.ok || response.op !== "export") throw new Error("expected an export response");
    expect(response.format).toBe("step");
    expect(response.content).toContain("ISO-10303"); // STEP header marker
  });

  it("bakes the placement pose into the exported STEP (§2.11.1 WYSIWYG)", async () => {
    const unposed = await handleRequest(oc, { id: 11, op: "export", doc: boxDoc(), format: "step" });
    const posed = await handleRequest(oc, { id: 12, op: "export", doc: placedBoxDoc(), format: "step" });
    if (!unposed.response.ok || unposed.response.op !== "export") throw new Error("unposed export failed");
    if (!posed.response.ok || posed.response.op !== "export") throw new Error("posed export failed");
    // Round-trip both files through importStep: the posed file's COM must be the
    // unposed COM rotated π/2 about Z ((x, y, z) → (−y, x, z)) then lifted 0.5 m.
    const c0 = stepCom(oc, unposed.response.content);
    const c1 = stepCom(oc, posed.response.content);
    expect(c1[0]).toBeCloseTo(-c0[1], 6);
    expect(c1[1]).toBeCloseTo(c0[0], 6);
    expect(c1[2]).toBeCloseTo(c0[2] + 0.5, 6);
  });

  it("§2.11.2: a 3-instance assembly exports ALL THREE posed bodies (STEP)", async () => {
    const one = await handleRequest(oc, { id: 13, op: "export", doc: boxDoc(), format: "step" });
    const many = await handleRequest(oc, { id: 14, op: "export", doc: assemblyDoc(), format: "step" });
    if (!one.response.ok || one.response.op !== "export") throw new Error("single export failed");
    if (!many.response.ok || many.response.op !== "export") throw new Error("assembly export failed");

    // The response says how many bodies shipped — the UI reports this.
    expect(one.response.bodyCount).toBe(1);
    expect(many.response.bodyCount).toBe(3);

    // Re-imported, the file carries 3× the volume: the assembly is really there,
    // not one body with the other two silently dropped.
    const v1 = stepVolume(oc, one.response.content);
    const v3 = stepVolume(oc, many.response.content);
    expect(v1).toBeCloseTo(mm(40) * mm(30) * mm(20), 9);
    expect(v3).toBeCloseTo(3 * v1, 9);

    // ...and at the right places: the centroid of the three posed copies. The
    // third is rotated π/2 about Z, so its local centroid (cx,cy,cz) maps to
    // (−cy, cx, cz) before its +0.2 x offset.
    const c1 = stepCom(oc, one.response.content);
    const expectedX = (c1[0] + (c1[0] + 0.1) + (-c1[1] + 0.2)) / 3;
    const expectedY = (c1[1] + c1[1] + c1[0]) / 3;
    const c3 = stepCom(oc, many.response.content);
    expect(c3[0]).toBeCloseTo(expectedX, 6);
    expect(c3[1]).toBeCloseTo(expectedY, 6);
    expect(c3[2]).toBeCloseTo(c1[2], 6);
  });

  it("§2.11.2: glTF exports one shared mesh instanced by N posed nodes", async () => {
    const { response } = await handleRequest(oc, {
      id: 15,
      op: "export",
      doc: assemblyDoc(),
      format: "gltf",
    });
    expect(response.ok).toBe(true);
    if (!response.ok || response.op !== "export") throw new Error("expected an export response");
    expect(response.bodyCount).toBe(3);
    const gltf = JSON.parse(response.content) as {
      meshes: unknown[];
      nodes: { mesh: number; translation?: number[]; rotation?: number[] }[];
      scenes: { nodes: number[] }[];
    };
    // ONE mesh (the geometry is transmitted once), three nodes referencing it.
    expect(gltf.meshes).toHaveLength(1);
    expect(gltf.nodes).toHaveLength(3);
    expect(gltf.scenes[0]!.nodes).toEqual([0, 1, 2]);
    expect(gltf.nodes.every((n) => n.mesh === 0)).toBe(true);
    // Node poses match the instances: identity, +0.1 x, +0.2 x with a Z rotation.
    expect(gltf.nodes[0]!.translation).toBeUndefined(); // identity omitted
    expect(gltf.nodes[0]!.rotation).toBeUndefined();
    expect(gltf.nodes[1]!.translation).toEqual([0.1, 0, 0]);
    expect(gltf.nodes[2]!.translation).toEqual([0.2, 0, 0]);
    expect(gltf.nodes[2]!.rotation![2]).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it("errors on export with no geometry", async () => {
    const { response } = await handleRequest(oc, {
      id: 6,
      op: "export",
      doc: emptyDoc(),
      format: "step",
    });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("expected an error response");
    expect(response.error).toMatch(/no geometry/);
  });
});

describe("handleRequest — facePlane", () => {
  it("resolves a picked +Z face to a Z-normal datum frame", async () => {
    // Capture the +Z face's persistent signature from a build first.
    const build = await handleRequest(oc, {
      id: 7,
      op: "build",
      doc: boxDoc(),
      deflection: mm(0.5),
    });
    if (!build.response.ok || build.response.op !== "build" || !build.response.mesh) {
      throw new Error("setup build failed");
    }
    const top = build.response.mesh.faceGroups.find((g) => Math.round(g.normal[2]) === 1)!;

    const { response } = await handleRequest(oc, {
      id: 8,
      op: "facePlane",
      doc: boxDoc(),
      face: { normal: top.normal, centroid: top.centroid },
    });
    expect(response.ok).toBe(true);
    if (!response.ok || response.op !== "facePlane") throw new Error("expected a facePlane response");
    expect(response.plane).not.toBeNull();
    expect(Math.abs(response.plane!.normal[2])).toBeCloseTo(1, 6);
  });

  it("returns plane=null when there is no geometry", async () => {
    const { response } = await handleRequest(oc, {
      id: 9,
      op: "facePlane",
      doc: emptyDoc(),
      face: { normal: [0, 0, 1] },
    });
    expect(response.ok).toBe(true);
    if (!response.ok || response.op !== "facePlane") throw new Error("expected a facePlane response");
    expect(response.plane).toBeNull();
  });
});
