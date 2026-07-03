// GT 905 — bossed plate: 50 x 50 x 6 mm square plate, centred Ø20 mm boss
// standing 10 mm above the plate top (16 mm overall), Ø6 mm hole through
// boss + plate on the shared centre axis.
//
// Dimensions are exactly ../inputs/905/description.yaml (self-owned fixture,
// prompt-first). The boss is a boolean-union tool body modelled as its own
// feature subtree (sketch circle → extrude to z = 0.016, overlapping the plate,
// so the fuse is a robust solid-solid union); the hole is a full-depth cut.
// Volume: 0.05·0.05·0.006 + π·0.01²·0.01 − π·0.003²·0.016 ≈ 1.76892e-5 m³.
import { writeGt } from "./_lib.mjs";

writeGt("905", {
  features: [
    { id: "plate", type: "box", params: { dx: 0.05, dy: 0.05, dz: 0.006 } },
    {
      id: "boss",
      type: "boolean",
      data: {
        op: "union",
        toolFeatures: [
          { id: "bosssk", type: "sketch", data: { profile: { kind: "circle", center: [0.025, 0.025], radius: 0.01 } } },
          { id: "bossex", type: "extrude", params: { height: 0.016 } },
        ],
      },
    },
    { id: "holesk", type: "sketch", data: { profile: { kind: "circle", center: [0.025, 0.025], radius: 0.003 } } },
    { id: "hole", type: "cut", params: { depth: 0.016 } },
  ],
  params: {},
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
