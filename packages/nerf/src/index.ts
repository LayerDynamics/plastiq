// @plastiq/nerf — browser client for Plastiq's MLX NeRF / surface-capture service.
//
// Posed images + a transforms.json go in; a base64 GLB (a marching-cubes surface of the trained
// MLX field) comes out, ready to wrap as a MeshDoc and feed the mesh → B-rep reconstruct path. The
// heavy training runs server-side on Apple Silicon (services/nerf, MLX); this package is only the
// submit→poll client, sharing the wire contract of services/capture and services/reconstruct.

/** Package version, surfaced for tooling/diagnostics. */
export const NERF_VERSION = "0.1.0" as const;

export { cancelJob, trainNerf } from "./client.js";
export type {
  NerfMethod,
  NerfEncoding,
  NerfTrainInput,
  NerfReport,
  NerfResult,
  NerfOptions,
  NerfCancelOptions,
} from "./types.js";
