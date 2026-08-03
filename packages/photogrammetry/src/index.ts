// @plastiq/photogrammetry — browser client for Plastiq's SfM+MVS photogrammetry service.
//
// Unposed photos go in; a transforms.json (nerfstudio/OpenGL convention) + a sparse cloud + an
// optional dense oriented point cloud come out — the front-end half of photogrammetry that feeds
// both existing legs: services/nerf `/train` (poses + the original uploads, paired to the emitted
// frames by filename) and services/capture
// `/capture` (dense cloud → MeshDoc → reconstruct). The heavy SfM+MVS solve runs server-side on
// Apple Silicon (services/photogrammetry, MLX + numpy/scipy); this package is only the submit→poll
// client, sharing the wire contract of services/capture/nerf/reconstruct/nurbs.

/** Package version, surfaced for tooling/diagnostics. */
export const PHOTOGRAMMETRY_VERSION = "0.1.0" as const;

export { cancelJob, solvePhotos } from "./client.js";
export type {
  PhotogrammetryMatching,
  PhotogrammetrySolveInput,
  PhotogrammetryCamera,
  PhotogrammetryNormalization,
  PhotogrammetryReport,
  PhotogrammetryResult,
  PhotogrammetryOptions,
  PhotogrammetryCancelOptions,
} from "./types.js";
