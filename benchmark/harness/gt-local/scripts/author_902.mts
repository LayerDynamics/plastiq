// GT 902 — plate 60 x 40 x 8 mm with a centred 10 mm diameter through hole.
//
// Source of dimensions: SUBMIT.md — "a 60×40×8 plate with a centred 10 mm hole is
// `box → sketch(circle @ [0.03,0.02], r 0.005) → cut(depth 0.008)`". This document
// is verbatim the one proven in apps/plastiq/src/headless/generate.test.ts
// ("authorStep builds a plate-with-hole (box→sketch→cut) into a valid solid"),
// where its volume is asserted analytically: 1.92e-5 − π·0.005²·0.008 ≈ 1.8572e-5 m³.
// Scored history: runs/holescore2/902 = 1.0 (exact), runs/holescore/902 = 0.6839
// (candidate built 10 mm thick vs the GT's 8 mm).
import { writeGt } from "./_lib.mjs";

writeGt("902", {
  features: [
    { id: "plate", type: "box", params: { dx: 0.06, dy: 0.04, dz: 0.008 } },
    { id: "sk", type: "sketch", data: { profile: { kind: "circle", center: [0.03, 0.02], radius: 0.005 } } },
    { id: "hole", type: "cut", params: { depth: 0.008 } },
  ],
  params: {},
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
