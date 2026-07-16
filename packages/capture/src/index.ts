// @plastiq/capture — browser client for Plastiq's MLX capture/completion service.
//
// An oriented point cloud goes in (or a partial scan for /complete); a base64 GLB (a
// marching-cubes surface of the fitted MLX field) comes out, ready to wrap as a MeshDoc and feed
// the mesh → B-rep reconstruct path. The heavy fit runs server-side on Apple Silicon
// (services/capture, MLX); this package is the submit→poll client plus the PLY/XYZ/JSON parsers
// that turn scan files into the service's raw-array schema, sharing the wire contract of
// services/nerf and services/reconstruct.

/** Package version, surfaced for tooling/diagnostics. */
export const CAPTURE_VERSION = "0.1.0" as const;

export { capturePointCloud, completePartialScan, cancelJob } from "./client.js";
export { parsePointCloud, parsePlyAscii, parseXyz, parsePointCloudJson, type ParsedPointCloud } from "./pointcloud.js";
export { MIN_POINTS } from "./types.js";
export type {
  CaptureInput,
  CompleteInput,
  CaptureReport,
  CaptureResult,
  CaptureOptions,
} from "./types.js";
