// A default document so a fresh CAD Studio session shows geometry immediately
// (SPEC-5 M0.5). A single ~6×4×3 cm box — the simplest feature the kernel
// rebuild + tagged tessellation can render, exercising face groups and edges.
// Dimensions are SI metres, matching the kernel/sim convention.

import type { CadDocument } from "./types.js";

export function defaultDocument(): CadDocument {
  return {
    features: [{ id: "f1", type: "box", name: "Box 1", params: { dx: 0.06, dy: 0.04, dz: 0.03 } }],
    params: {},
  };
}
