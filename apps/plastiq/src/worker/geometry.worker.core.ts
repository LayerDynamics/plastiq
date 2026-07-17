// Pure request-handling core of the geometry worker (SPEC-5 FR-5), split out from
// geometry.worker.ts so it can be unit-tested without a Worker runtime: it takes
// an already-initialized Occt and returns the response + transfer list instead of
// touching `self` / postMessage or importing the wasm `?url`. The worker module is
// a thin shim that lazily inits OCCT and wires this to onmessage/postMessage.

import {
  decomposerReady,
  describeOcctError,
  exportGltf,
  exportIges,
  exportStep,
  faceDatumPlane,
  initDecomposer,
  resolveFaceRef,
  rotate,
  translate,
  type Occt,
  type Solid,
  type TaggedMesh,
} from "@plastiq/cad";
import { buildDocumentIsolated, rebuildDocument } from "./rebuild.js";
import { lowerAssembly } from "./lower.js";
import type { AssemblyModel } from "../assembly/model.js";
import type { CadDocument } from "../store/types.js";
import {
  findPlacement,
  isIdentityPlacement,
  placementFromFeature,
  placementPoseOf,
} from "../viewport/placement.js";
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
      faceIds: e.faceIds,
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
 * single "body0" wrapping the bare part — so Simulate/lowering works on the
 * modelled part directly even before any assembly is built. body0 is posed at
 * the document's placement (§2.11.1): the pose the viewport shows becomes the
 * body's world pose, so Simulate starts the part exactly where it is on screen
 * instead of teleporting it to origin (identity when no placement exists).
 */
export function effectiveAssembly(doc: CadDocument): AssemblyModel {
  const assembly = doc.assembly ?? { instances: [], mates: [], joints: [] };
  if (assembly.instances.length > 0) return assembly;
  return {
    instances: [
      {
        id: "body0",
        name: "Part",
        pose: placementPoseOf(doc.features),
      },
    ],
    mates: [],
    joints: [],
  };
}

/**
 * Bake the document's placement pose into the rebuilt solid for file export
 * (§2.11.1 WYSIWYG): the exported body sits exactly where the viewport shows
 * it. The intrinsic-XYZ placement equals fixed-frame rotations about Z, then
 * Y, then X — all about the part's local origin — followed by the translation.
 * Consumes (deletes) the input whenever a transform applies; returns it
 * untouched for an identity placement. A kernel failure mid-chain frees the
 * newest solid before rethrowing, so nothing leaks.
 */
export function posePlacementForExport(oc: Occt, solid: Solid, doc: CadDocument): Solid {
  const p = placementFromFeature(findPlacement(doc.features));
  if (isIdentityPlacement(p)) return solid;
  let s = solid;
  const step = (next: Solid): void => {
    s.delete();
    s = next;
  };
  try {
    if (p.rz !== 0) step(rotate(oc, s, [0, 0, 0], [0, 0, 1], p.rz));
    if (p.ry !== 0) step(rotate(oc, s, [0, 0, 0], [0, 1, 0], p.ry));
    if (p.rx !== 0) step(rotate(oc, s, [0, 0, 0], [1, 0, 0], p.rx));
    if (p.tx !== 0 || p.ty !== 0 || p.tz !== 0) step(translate(oc, s, [p.tx, p.ty, p.tz]));
  } catch (e) {
    s.delete();
    throw e;
  }
  return s;
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
      const built = rebuildDocument(oc, req.doc);
      if (!built) throw new Error("export: the document has no geometry");
      // WYSIWYG (§2.11.1): the file carries the part AT its placement pose.
      const solid = posePlacementForExport(oc, built, req.doc);
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
    // Isolating build (FR-24): a bad feature is reported in `statuses` and
    // skipped rather than blanking the whole model, so the response carries
    // BOTH whatever geometry survived and every feature's fate. The caller
    // badges features from `statuses` — it never parses the message text.
    const { part, statuses } = buildDocumentIsolated(oc, req.doc, {
      linearDeflection: req.deflection,
    });
    const mesh = part ? toTransfer(part.mesh, part.volume, part.com) : null;
    const transfer: Transferable[] = mesh
      ? [
          mesh.vertices.buffer,
          mesh.indices.buffer,
          mesh.vertexPositions.buffer,
          ...mesh.edges.map((e) => e.positions.buffer),
        ]
      : [];
    return { response: { id: req.id, ok: true, op: "build", mesh, statuses }, transfer };
  } catch (err) {
    return {
      response: {
        id: req.id,
        ok: false,
        // describeOcctError, not String(err): a raw OCCT Standard_Failure is a
        // pointer, so String(err) rendered "5286968" and `.message` rendered
        // "undefined".
        error: describeOcctError(err),
      },
      transfer: [],
    };
  }
}
