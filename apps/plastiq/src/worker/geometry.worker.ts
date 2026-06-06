// Geometry Web Worker (SPEC-5 FR-5): runs @plastiq/cad (opencascade.js) off the
// main thread. It lazily inits OCCT, then on each build request rebuilds the
// document's feature tree, tags its tessellation (FR-6), and posts the result
// back as transferable typed arrays so the UI thread never blocks on OCCT.

import wasmUrl from "@plastiq/cad/vendor/occt/plastiq-occt.wasm?url";
import {
  exportGltf,
  exportIges,
  exportStep,
  initDecomposer,
  initOcct,
  type Occt,
  type TaggedMesh,
} from "@plastiq/cad";
import { rebuildDocument, rebuildTaggedWithProps } from "./rebuild.js";
import { lowerAssembly } from "./lower.js";
import type { TransferMesh, WorkerRequest, WorkerResponse } from "./protocol.js";

// Loose worker-scope typing (avoids pulling the WebWorker lib alongside DOM).
const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

let ocPromise: Promise<Occt> | null = null;
const getOc = (): Promise<Occt> => (ocPromise ??= initOcct({ wasmUrl }));

function toTransfer(
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
    })),
    vertexIds: t.vertexPoints.map((v) => v.vertexId),
    vertexPositions: Float32Array.from(t.vertexPoints.flatMap((v) => [...v.position])),
    volume,
    com,
  };
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>): void => {
  const req = ev.data;
  void (async (): Promise<void> => {
    try {
      const oc = await getOc();
      if (req.op === "lower") {
        // Assembly → SimManifest (M4.5/M6.1): rebuild the part, lower its
        // instances. A bare part (no instances) lowers as one identity body so
        // Simulate works on the modelled part directly.
        const solid = rebuildDocument(oc, req.doc);
        if (!solid) throw new Error("lower: the document has no geometry to instance");
        // A concave part is decomposed into convex pieces during lowering; make
        // sure the V-HACD decomposer's wasm is ready before exportForSim runs.
        await initDecomposer();
        try {
          const assembly = req.doc.assembly ?? { instances: [], mates: [], joints: [] };
          const effective =
            assembly.instances.length > 0
              ? assembly
              : {
                  instances: [
                    {
                      id: "body0",
                      name: "Part",
                      pose: {
                        position: [0, 0, 0] as [number, number, number],
                        orientation: [0, 0, 0, 1] as [number, number, number, number],
                      },
                    },
                  ],
                  mates: [],
                  joints: [],
                };
          const { manifest, skippedJoints, localCom } = lowerAssembly(
            oc,
            solid,
            effective,
            "plastiq:assembly",
          );
          ctx.postMessage({ id: req.id, ok: true, op: "lower", manifest, skippedJoints, localCom });
        } finally {
          solid.delete();
        }
        return;
      }
      if (req.op === "export") {
        // Interchange export (M6.2/M6.3): rebuild the part, serialize via io.
        const solid = rebuildDocument(oc, req.doc);
        if (!solid) throw new Error("export: the document has no geometry");
        try {
          const content =
            req.format === "step"
              ? exportStep(oc, solid)
              : req.format === "iges"
                ? exportIges(oc, solid)
                : exportGltf(oc, solid, { linearDeflection: 0.0005 });
          ctx.postMessage({ id: req.id, ok: true, op: "export", format: req.format, content });
        } finally {
          solid.delete();
        }
        return;
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
      ctx.postMessage({ id: req.id, ok: true, op: "build", mesh }, transfer);
    } catch (err) {
      ctx.postMessage({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
