// GT 903 — drilled plate: 80 x 50 x 6 mm, two Ø8 mm through holes on the
// mid-width line (y = 25 mm) centred at x = 20 mm and x = 60 mm.
//
// Dimensions are exactly ../inputs/903/description.yaml (a self-owned fixture:
// the prompt and this GT are authored together, prompt-first).
// Volume: 0.08·0.05·0.006 − 2·π·0.004²·0.006 ≈ 2.33968e-5 m³.
import { writeGt } from "./_lib.mjs";

writeGt("903", {
  features: [
    { id: "plate", type: "box", params: { dx: 0.08, dy: 0.05, dz: 0.006 } },
    { id: "sk1", type: "sketch", data: { profile: { kind: "circle", center: [0.02, 0.025], radius: 0.004 } } },
    { id: "hole1", type: "cut", params: { depth: 0.006 } },
    { id: "sk2", type: "sketch", data: { profile: { kind: "circle", center: [0.06, 0.025], radius: 0.004 } } },
    { id: "hole2", type: "cut", params: { depth: 0.006 } },
  ],
  params: {},
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
