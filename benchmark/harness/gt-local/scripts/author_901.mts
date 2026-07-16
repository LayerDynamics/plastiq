// GT 901 — rectangular block, 60 x 40 x 8 mm.
//
// Source of dimensions: the proven CB6.3 run (`runs/llama/901`, CAD Score 1.0) —
// SUBMIT.md "60×40×8 block" / plan CB6.3 "authored a 60×40×8 GT via the kernel".
// Volume check: 0.06 * 0.04 * 0.008 = 1.92e-5 m³ (matches runs/llama/901/result.json
// volume_intersection with IoU 1.0).
import { writeGt } from "./_lib.mjs";

writeGt("901", {
  features: [
    { id: "block", type: "box", params: { dx: 0.06, dy: 0.04, dz: 0.008 } },
  ],
  params: {},
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
