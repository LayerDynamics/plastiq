# gt-local — self-owned CADGenBench ground truth (CB6.3 mini-GT)

Five self-owned fixtures with kernel-authored ground truth, laid out exactly as
`cadgenbench.common.paths.data_gt_dir` expects, so `score` produces **real local
CAD Scores** without the private official GT:

```text
gt-local/
  inputs/<id>/description.yaml    # the fixture prompt (run_bench's load_fixture contract)
  gt/<id>/ground_truth.step       # the authored solid (generated, committed)
  scripts/author_<id>.mts         # one kernel-authoring script per fixture
  scripts/_lib.mts                # shared write-out (authorStep -> gt/<id>/ground_truth.step)
```

This tree replaces the throwaway `/tmp/mini_gt*` trees used for the original
CB6.3 proof (those are gone; fixtures 901/902 below re-author them exactly —
verified by reproducing the historical run scores to full precision).

## Scoring against this GT

```bash
export CADGENBENCH_DATA_DIR=/absolute/path/to/cad-studio/benchmark/harness/gt-local
mamba run -n cadgenbench python -m cadbench_harness score <run>   # real CAD Scores
```

Generate candidates for these fixtures by pointing a run at the prompts in
`inputs/<id>/description.yaml` (text-only fixtures: no drawing, no captioner
needed — the prompt fully specifies the part).

## Regenerating the GT

Each script builds its solid through the real kernel (`authorStep` in
`apps/plastiq/src/headless/nodeBuild.ts`: `rebuildDocument` → `exportStep`),
with every dimension taken verbatim from the fixture prompt (SI metres):

```bash
cd apps/plastiq
npx tsx ../../benchmark/harness/gt-local/scripts/author_901.mts   # etc. per id
```

## Fixtures

| id | part (dimensions from `inputs/<id>/description.yaml`) | document | analytic volume (m³) |
|---|---|---|---|
| 901 | block 60 × 40 × 8 mm | `box(0.06, 0.04, 0.008)` | 1.92e-5 |
| 902 | plate 60 × 40 × 8 mm, centred Ø10 through hole | `box → sketch(circle @ [0.03,0.02], r 0.005) → cut(0.008)` | 1.8572e-5 |
| 903 | plate 80 × 50 × 6 mm, two Ø8 through holes at (20, 25) and (60, 25) mm | `box → 2 × (sketch circle r 0.004 → cut 0.006)` | 2.3397e-5 |
| 904 | L-bracket 60 mm long; legs 40 × 6 mm and 6 mm × 40 mm tall | `box ∪ boolean(union, box @ [0,0,0] 0.06×0.006×0.04)` | 2.664e-5 |
| 905 | plate 50 × 50 × 6 mm, centred Ø20 boss 10 mm proud (16 mm overall), Ø6 hole through both | `box ∪ boolean(union, sketch→extrude 0.016) → sketch → cut 0.016` | 1.7689e-5 |

901/902 are the parts proven in the original CB6.3 loop; their prompts and
dimensions come from that record (`SUBMIT.md` self-owned mini-GT section; the 902
document is verbatim the one volume-asserted in
`apps/plastiq/src/headless/generate.test.ts`). 903–905 are new self-owned
fixtures: the prompt was written first and the GT authored exactly from it.

## Verification record (2026-07-03)

All GT files pass the scorer's validity gate (`cadbench_harness sanity`):
watertight single solids, bboxes as specified.

Existing run candidates re-scored against this tree
(`CADGENBENCH_DATA_DIR=.../gt-local`):

| run / fixture | CAD Score | meaning |
|---|---|---|
| `runs/llama` 901 | **1.0** | exact candidate — reproduces the historical score |
| `runs/holescore2` 902 | **1.0** | exact candidate — reproduces the historical score |
| `runs/holescore` 902 | **0.6838759174362078** | 10-mm-thick candidate — matches the pre-existing `score.json` to full precision, so this GT is geometrically identical to the original |

New fixtures self-scored (GT staged as its own candidate through
`score_run`'s scored branch, per-fixture subprocess): 903 = 1.0, 904 = 1.0,
905 = 1.0. Scorer-measured volumes match the analytic values above (904 exact;
903/905 within 0.25 % mesh tessellation on the cylindrical terms).
