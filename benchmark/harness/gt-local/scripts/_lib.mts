// Shared write-out for the gt-local GT authoring scripts (CB6.3 self-owned mini-GT).
//
// Each author_<id>.mts defines one fixture's CadDocument (SI metres, exactly the
// dimensions in ../inputs/<id>/description.yaml) and calls writeGt, which builds
// the solid through the real kernel (authorStep: rebuildDocument -> exportStep)
// and lands it in the layout `score` expects:
//
//     gt-local/gt/<id>/ground_truth.step
//
// Run from the app dir so @plastiq/cad + OCCT resolve, e.g.:
//     cd apps/plastiq && npx tsx ../../benchmark/harness/gt-local/scripts/author_901.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorStep } from "../../../../apps/plastiq/src/headless/nodeBuild.js";
import type { CadDocument } from "../../../../apps/plastiq/src/store/types.js";

const GT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "gt");

export async function writeGt(id: string, doc: CadDocument): Promise<void> {
  const step = await authorStep(doc);
  const dir = join(GT_ROOT, id);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "ground_truth.step");
  writeFileSync(out, step);
  console.log(`wrote ${out} (${step.length} bytes)`);
}
