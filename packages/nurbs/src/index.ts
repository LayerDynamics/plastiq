// @plastiq/nurbs — browser client for Plastiq's MLX NURBS surface-fitting service.
//
// A GLB mesh goes in; STEP text plus validated NURBS-surface JSON comes out, ready for the app's
// existing stepToImportDocument → importStep path. The heavy fitting runs server-side on Apple
// Silicon (services/nurbs, MLX, port :8003); this package is only the submit→poll client, sharing
// the wire-contract shape of @plastiq/nerf and services/capture/reconstruct.

/** Package version, surfaced for tooling/diagnostics. */
export const NURBS_VERSION = "0.1.0" as const;

export { fitNurbs } from "./client.js";
export type {
  NurbsFitMode,
  NurbsFitInput,
  NurbsSurfaceJson,
  NurbsReport,
  NurbsResult,
  NurbsOptions,
} from "./types.js";
