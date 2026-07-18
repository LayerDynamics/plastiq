// Pure request-handling core of the geometry worker (SPEC-5 FR-5), split out from
// geometry.worker.ts so it can be unit-tested without a Worker runtime: it takes
// an already-initialized Occt and returns the response + transfer list instead of
// touching `self` / postMessage or importing the wasm `?url`. The worker module is
// a thin shim that lazily inits OCCT and wires this to onmessage/postMessage.

import {
  decomposerReady,
  describeOcctError,
  exportGltfAssembly,
  exportIgesAssembly,
  exportStepAssembly,
  faceDatumPlane,
  initDecomposer,
  resolveFaceRef,
  transformRigid,
  type Occt,
  type Placement,
  type Solid,
  type TaggedMesh,
} from "@plastiq/cad";
import { buildDocumentIsolated, rebuildDocument } from "./rebuild.js";
import { lowerAssembly } from "./lower.js";
import type { AssemblyModel } from "../assembly/model.js";
import type { CadDocument } from "../store/types.js";
import { placementPoseOf } from "../viewport/placement.js";
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
 * The world poses a document's geometry occupies — the ONE source both Simulate
 * and file export read (§2.11.1/§2.11.2), so the two can never disagree about
 * where the part is. Exactly `effectiveAssembly`'s instance poses: N instance
 * poses for an assembly, or a single body0 at the document's placement for a
 * bare part. (Matching the viewport: when instances exist the base part's
 * placement is not applied — the instances carry the poses.)
 */
export function exportPoses(doc: CadDocument): Placement[] {
  return effectiveAssembly(doc).instances.map((i) => ({
    position: i.pose.position,
    orientation: i.pose.orientation,
  }));
}

/**
 * Pose the rebuilt (local-frame) solid into each world placement — the bodies a
 * file export ships (§2.11.2). Each is an independent copy, so a 3-instance
 * mated assembly exports as 3 posed bodies instead of one unposed body.
 * Identity placements copy the solid too, so every returned solid is owned by
 * the caller and freed uniformly. A kernel failure mid-loop frees the copies
 * made so far before rethrowing — nothing leaks in the long-lived worker.
 */
export function poseSolidsForExport(
  oc: Occt,
  solid: Solid,
  placements: readonly Placement[],
): Solid[] {
  const out: Solid[] = [];
  try {
    for (const p of placements) {
      out.push(transformRigid(oc, solid, p.orientation, p.position));
    }
  } catch (e) {
    for (const s of out) s.delete();
    throw e;
  }
  return out;
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
      // WYSIWYG (§2.11.1/§2.11.2): the file carries EVERY body the viewport
      // shows, each at its world pose — N assembly instances, or the single
      // placement-posed part.
      const placements = exportPoses(req.doc);
      // B-rep formats need real posed geometry (one solid per body); glTF
      // instances one shared tessellation through per-node transforms instead,
      // so it poses from `placements` directly and needs no posed copies.
      const posed = req.format === "gltf" ? [] : poseSolidsForExport(oc, built, placements);
      try {
        const content =
          req.format === "step"
            ? exportStepAssembly(oc, posed)
            : req.format === "iges"
              ? exportIgesAssembly(oc, posed)
              : exportGltfAssembly(oc, built, placements, { linearDeflection: 0.0005 });
        return {
          response: {
            id: req.id,
            ok: true,
            op: "export",
            format: req.format,
            content,
            bodyCount: placements.length,
          },
          transfer: [],
        };
      } finally {
        for (const s of posed) s.delete();
        built.delete();
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
