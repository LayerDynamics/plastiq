// GT 904 — L-bracket, 60 mm long: horizontal leg 40 x 6 mm, vertical leg
// 6 mm thick rising to 40 mm overall height along the y = 0 edge.
//
// Dimensions are exactly ../inputs/904/description.yaml (self-owned fixture,
// prompt-first). Built as horizontal-leg box ∪ vertical-leg box (the boolean
// feature's inline box tool = makeBoxAt(corner, dx, dy, dz)); the legs overlap
// in the corner region so the fuse is a robust solid-solid union.
// Volume: 0.06·0.04·0.006 + 0.06·0.006·0.04 − 0.06·0.006·0.006 = 2.664e-5 m³.
import { writeGt } from "./_lib.mjs";

writeGt("904", {
  features: [
    { id: "hleg", type: "box", params: { dx: 0.06, dy: 0.04, dz: 0.006 } },
    {
      id: "vleg",
      type: "boolean",
      data: { op: "union" },
      params: { tx: 0, ty: 0, tz: 0, dx: 0.06, dy: 0.006, dz: 0.04 },
    },
  ],
  params: {},
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
