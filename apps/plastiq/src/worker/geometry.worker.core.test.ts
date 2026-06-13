// Tests the geometry worker's pure request-handling core (handleRequest +
// effectiveAssembly) against the real OCCT wasm — the message handlers and the
// single-body fallback that geometry.worker.ts wires to onmessage/postMessage.

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, mm, type Occt } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import { effectiveAssembly, handleRequest } from "./geometry.worker.core.js";

const INIT_TIMEOUT_MS = 120_000;

const boxDoc = (): CadDocument => ({
  features: [{ id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } }],
  params: {},
});

const emptyDoc = (): CadDocument => ({ features: [], params: {} });

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
