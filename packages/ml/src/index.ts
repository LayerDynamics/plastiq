// @plastiq/ml — shared submit→poll + cancel primitives for domain ML clients.
// Domain packages (@plastiq/capture, nerf, nurbs, photogrammetry, recon) own
// their request/result types; this package only exports the common job knobs
// and the DELETE cancel helper so cancel/onJob auth shape cannot drift.

export type { JobCancelOptions, JobClientOptions, JobState } from "./types.js";
export { cancelServiceJob, serviceHttpError, type CancelServiceJobOptions } from "./http.js";
