// Geometry worker RPC protocol (SPEC-5 FR-5). The main thread posts a build
// request with the document; the worker rebuilds it through @plastiq/cad and posts
// back a tagged mesh in transferable typed-array form (or a typed error).

import type { FaceGroup, SimManifest } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";

type Vec3 = [number, number, number];
/** The two adjacent-face normals that form an edge's persistent EdgeRef. */
export type EdgePolylineNormals = readonly [Vec3, Vec3];

/** Tagged mesh in transferable form (typed arrays instead of number[]). */
export interface TransferMesh {
  vertices: Float32Array;
  indices: Uint32Array;
  /** Per-face groups carry the FaceRef `normal` signature (SPEC-4 FR-16). */
  faceGroups: FaceGroup[];
  /** Edges carry the EdgeRef `faceNormals` signature for persistent selection. */
  edges: { edgeId: number; positions: Float32Array; faceNormals: EdgePolylineNormals }[];
  /** B-rep corner ids, parallel to `vertexPositions` (groups of 3). */
  vertexIds: number[];
  /** Flat SI corner coordinates `[x0,y0,z0, …]`, one per `vertexIds` entry. */
  vertexPositions: Float32Array;
  /** Solid volume in m³ — a mass property surfaced in the properties panel.
   *  Always set by a real build; optional so partial test fixtures need not. */
  volume?: number;
  /** Geometric centre of mass (centroid) in SI metres (same caveat as `volume`). */
  com?: Vec3;
}

export interface BuildRequest {
  id: number;
  op: "build";
  doc: CadDocument;
  /** Linear tessellation deflection (SI metres). */
  deflection: number;
}

/** Lower the document's assembly to a SimManifest (M4.5). */
export interface LowerRequest {
  id: number;
  op: "lower";
  doc: CadDocument;
}

/** Interchange formats the part can be exported to (M6.2/M6.3). */
export type ExportFormat = "gltf" | "step" | "iges";

/** Export the rebuilt part to a neutral interchange string (kernel io). */
export interface ExportRequest {
  id: number;
  op: "export";
  doc: CadDocument;
  format: ExportFormat;
}

export type WorkerRequest = BuildRequest | LowerRequest | ExportRequest;

export type WorkerResponse =
  | { id: number; ok: true; op: "build"; mesh: TransferMesh | null }
  | {
      id: number;
      ok: true;
      op: "lower";
      manifest: SimManifest;
      skippedJoints: string[];
      localCom: [number, number, number];
    }
  | { id: number; ok: true; op: "export"; format: ExportFormat; content: string }
  | { id: number; ok: false; error: string };
