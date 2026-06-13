// Pure request-handling core of the geometry worker (SPEC-5 FR-5), split out from
// geometry.worker.ts so it can be unit-tested without a Worker runtime: it takes
// an already-initialized Occt and returns the response + transfer list instead of
// touching `self` / postMessage or importing the wasm `?url`. The worker module is
// a thin shim that lazily inits OCCT and wires this to onmessage/postMessage.

import {
  decomposerReady,
  exportGltf,
  exportIges,
  exportStep,
  faceDatumPlane,
  initDecomposer,
  resolveFaceRef,
  type Occt,
  type TaggedMesh,
} from "@plastiq/cad";
import { rebuildDocument, rebuildTaggedWithProps } from "./rebuild.js";
import { lowerAssembly } from "./lower.js";
import type { AssemblyModel } from "../assembly/model.js";
import type { CadDocument } from "../store/types.js";
import type { TransferMesh, WorkerRequest, WorkerResponse } from "./protocol.js";

export function toTransfer(
  t: TaggedMesh,
  volume: number,
  com: [number, number, number],
): TransferMesh {
  return {
    vertices: Float32Array.from(t.vertices),
    indices: Uint32Array.from(t.indices),
    faceGroups: t.faceGroups,
    edges: t.edges.map((e) => ({
      edgeId: e.edgeId,
      positions: Float32Array.from(e.positions),
      faceNormals: e.faceNormals,
      midpoint: e.midpoint,
    })),
    vertexIds: t.vertexPoints.map((v) => v.vertexId),
    vertexPositions: Float32Array.from(t.vertexPoints.flatMap((v) => [...v.position])),
    volume,
    com,
  };
}

/**
 * The assembly to lower for a document: its own instances if present, else a
 * single identity-posed "body0" wrapping the bare part — so Simulate/lowering
 * works on the modelled part directly even before any assembly is built.
 */
export function effectiveAssembly(doc: CadDocument): AssemblyModel {
  const assembly = doc.assembly ?? { instances: [], mates: [], joints: [] };
  if (assembly.instances.length > 0) return assembly;
  return {
    instances: [
      {
        id: "body0",
        name: "Part",
        pose: {
          position: [0, 0, 0],
          orientation: [0, 0, 0, 1],
        },
      },
    ],
    mates: [],
    joints: [],
  };
}

/**
 * Handle one worker request against an initialized OCCT. Returns the response and
 * the list of transferable buffers (empty for non-mesh responses). Never throws —
 * a processing failure becomes an `ok: false` error response carrying `req.id`.
 */
export async function handleRequest(
  oc: Occt,
  req: WorkerRequest,
): Promise<{ response: WorkerResponse; transfer: Transferable[] }> {
  try {
    if (req.op === "lower") {
      const solid = rebuildDocument(oc, req.doc);
      if (!solid) throw new Error("lower: the document has no geometry to instance");
      // A concave part is decomposed into convex pieces during lowering; make sure
      // the V-HACD decomposer's wasm is ready before exportForSim runs. Gate the
      // (idempotent) init on decomposerReady() so a warm worker skips the re-init.
      if (!decomposerReady()) await initDecomposer();
      try {
        const { manifest, skippedJoints, localCom } = lowerAssembly(
          oc,
          solid,
          effectiveAssembly(req.doc),
          "plastiq:assembly",
        );
        return {
          response: { id: req.id, ok: true, op: "lower", manifest, skippedJoints, localCom },
          transfer: [],
        };
      } finally {
        solid.delete();
      }
    }
    if (req.op === "export") {
      const solid = rebuildDocument(oc, req.doc);
      if (!solid) throw new Error("export: the document has no geometry");
      try {
        const content =
          req.format === "step"
            ? exportStep(oc, solid)
            : req.format === "iges"
              ? exportIges(oc, solid)
              : exportGltf(oc, solid, { linearDeflection: 0.0005 });
        return {
          response: { id: req.id, ok: true, op: "export", format: req.format, content },
          transfer: [],
        };
      } finally {
        solid.delete();
      }
    }
    if (req.op === "facePlane") {
      const solid = rebuildDocument(oc, req.doc);
      if (!solid) {
        return { response: { id: req.id, ok: true, op: "facePlane", plane: null }, transfer: [] };
      }
      try {
        const face = resolveFaceRef(oc, solid, req.face);
        if (!face) {
          return { response: { id: req.id, ok: true, op: "facePlane", plane: null }, transfer: [] };
        }
        // Free `face` on every exit — including a throw from faceDatumPlane — so the
        // resolved face isn't leaked on the error path.
        try {
          const p = faceDatumPlane(oc, face);
          return {
            response: {
              id: req.id,
              ok: true,
              op: "facePlane",
              plane: {
                origin: [p.origin[0], p.origin[1], p.origin[2]],
                normal: [p.normal[0], p.normal[1], p.normal[2]],
                xAxis: [p.xAxis[0], p.xAxis[1], p.xAxis[2]],
              },
            },
            transfer: [],
          };
        } finally {
          face.delete();
        }
      } finally {
        solid.delete();
      }
    }
    const built = rebuildTaggedWithProps(oc, req.doc, { linearDeflection: req.deflection });
    const mesh = built ? toTransfer(built.mesh, built.volume, built.com) : null;
    const transfer: Transferable[] = mesh
      ? [
          mesh.vertices.buffer,
          mesh.indices.buffer,
          mesh.vertexPositions.buffer,
          ...mesh.edges.map((e) => e.positions.buffer),
        ]
      : [];
    return { response: { id: req.id, ok: true, op: "build", mesh }, transfer };
  } catch (err) {
    return {
      response: {
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      transfer: [],
    };
  }
}
