// Geometry worker RPC protocol (SPEC-5 FR-5). The main thread posts a build
// request with the document; the worker rebuilds it through @plastiq/cad and posts
// back a tagged mesh in transferable typed-array form (or a typed error).

import type { FaceGroup, FaceRef, SimManifest } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
// Type-only: rebuild.ts does not import this module, so there is no cycle.
import type { FeatureBuildStatus } from "./rebuild.js";

export type { FeatureBuildStatus };

type Vec3 = [number, number, number];
/** The two adjacent-face normals that form an edge's persistent EdgeRef. */
export type EdgePolylineNormals = readonly [Vec3, Vec3];

/** Tagged mesh in transferable form (typed arrays instead of number[]). */
export interface TransferMesh {
  vertices: Float32Array;
  indices: Uint32Array;
  /** Per-face groups carry the FaceRef `normal` signature + `centroid` positional
   * disambiguator (SPEC-4 FR-16). */
  faceGroups: FaceGroup[];
  /** Edges carry the EdgeRef `faceNormals` signature + `midpoint` positional
   * disambiguator for persistent selection. */
  edges: {
    edgeId: number;
    positions: Float32Array;
    faceNormals: EdgePolylineNormals;
    /** Adjacent face ids in the current mesh, when topology data is available. */
    faceIds?: readonly [number, number];
    midpoint: Vec3;
  }[];
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

/** Resolve a picked face on `doc` to a sketch datum frame (M3 on-face sketching).
 * The main thread can't run OCCT, so the worker derives the plane for the camera. */
export interface FacePlaneRequest {
  id: number;
  op: "facePlane";
  doc: CadDocument;
  face: FaceRef;
}

/** A sketch datum frame (origin + orthonormal normal/xAxis), in SI metres. */
export interface PlaneFrame {
  origin: Vec3;
  normal: Vec3;
  xAxis: Vec3;
}

export type WorkerRequest = BuildRequest | LowerRequest | ExportRequest | FacePlaneRequest;

export type WorkerResponse =
  | {
      id: number;
      ok: true;
      op: "build";
      mesh: TransferMesh | null;
      /**
       * Every feature's fate this pass (FR-24). The build ISOLATES per-feature
       * failures, so `ok: true` with a null/partial mesh plus error statuses is
       * a normal outcome — the UI badges features from this list instead of
       * regex-parsing an error string.
       */
      statuses: FeatureBuildStatus[];
    }
  | {
      id: number;
      ok: true;
      op: "lower";
      manifest: SimManifest;
      skippedJoints: string[];
      localCom: [number, number, number];
    }
  | {
      id: number;
      ok: true;
      op: "export";
      format: ExportFormat;
      content: string;
      /** How many bodies the file carries — assembly instances, or 1 for a bare
       * part (§2.11.2). The UI reports it so "exported STEP" can never again
       * mean "exported one unposed body and silently dropped the assembly". */
      bodyCount: number;
    }
  | { id: number; ok: true; op: "facePlane"; plane: PlaneFrame | null }
  | { id: number; ok: false; error: string };
