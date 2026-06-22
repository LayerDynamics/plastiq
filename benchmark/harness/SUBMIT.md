# Submitting to CADGenBench & getting a CAD Score

The official ground truth (`HuggingAI4Engineering/cadgenbench-data-gt`) is
**private**, so the headline **CAD Score is produced server-side by the
leaderboard Space**, not locally. This account (`LayerDynamics`) is not in the
`HuggingAI4Engineering` org, so `cadbench-harness score` runs the *validity-only*
fallback until GT access is granted (see below).

## 1. Generate, validate, package

```bash
# (start a local model first — see README / serve-model.sh)
mamba run -n cadgenbench python -m cadbench_harness run myrun \
    --model <hf-model> --base-url http://localhost:8080/v1 --vision

mamba run -n cadgenbench python -m cadbench_harness validate myrun
mamba run -n cadgenbench python -m cadbench_harness package myrun \
    --submitter "Your Name" --name "plastiq parametric v1" --agree -o myrun.zip
```

`package` delegates to `cadgenbench baseline package`, so the zip layout and
`meta.json` (`submitter_name`, `submission_name`, `agent_url`, `notes`,
`agree_to_publish`) are exactly what the Space validates. `agree_to_publish`
stays `false` unless you pass `--agree`.

## 2. Upload to the leaderboard Space

1. Open the **Submit** tab on
   [`HuggingAI4Engineering/CADGenBench`](https://huggingface.co/spaces/HuggingAI4Engineering/CADGenBench).
2. Upload `myrun.zip`.
3. The Space validates the zip, runs the CAD Score pipeline against the private
   GT, publishes a leaderboard row, and writes a per-submission HTML report.

Rows publish as **unvalidated**; promotion to a validated tier is a separate
methodology review (see the benchmark's `docs/benchmark/validation.md`).

## 3. Requesting ground-truth access (to score locally)

Local CAD Scores need read access to the GT dataset. To request it:

1. **Ask the maintainers.** Open a discussion on the GT dataset page
   ([`HuggingAI4Engineering/cadgenbench-data-gt`](https://huggingface.co/datasets/HuggingAI4Engineering/cadgenbench-data-gt))
   or contact the [`HuggingAI4Engineering`](https://huggingface.co/HuggingAI4Engineering)
   org, stating your account (`LayerDynamics`) and intended use (local evaluation
   / research, not redistribution). The inputs are ODC-BY; the GT is withheld so
   the leaderboard stays the single source of truth, so access is at the
   maintainers' discretion.
2. **If granted**, set the env so the harness resolves the GT and set your token:
   ```bash
   export HF_TOKEN=hf_...                                   # an account with GT read access
   export CADGENBENCH_DATA_GT_REPO=HuggingAI4Engineering/cadgenbench-data-gt
   mamba run -n cadgenbench python -m cadbench_harness score myrun
   ```
   `score` then runs the full `evaluate_result` per fixture and prints real CAD
   Scores — no code change required.

   Alternatively, point `CADGENBENCH_DATA_DIR` at a local tree laid out as
   `inputs/` + `gt/` (each a per-fixture-id subdir) and `score` will use it.

### Ready-to-send access request

> Subject: CADGenBench ground-truth (read) access for local evaluation
>
> Hi HuggingAI4Engineering team — I'm evaluating our own CAD-generation model
> (Plastiq) against CADGenBench and would like **read** access to
> `cadgenbench-data-gt` for **local scoring only** (HF account: `LayerDynamics`).
> I understand the GT is withheld to keep the leaderboard authoritative; I won't
> redistribute it and I'm happy to keep submitting through the Space for official
> numbers. Could you grant read access, or advise the preferred path? Thanks!

Send it as a discussion on the GT dataset page or to the org.

## Self-owned mini-GT (score locally *today*, without the official GT)

`score` is ground-truth-source-agnostic. You can author your own GT for a subset
of fixtures and score against it immediately — independent of the private set. Lay
it out and point `CADGENBENCH_DATA_DIR` at the parent:

```text
<my-gt>/
  gt/
    <id>/ground_truth.step          # the solved solid you authored
         jig_<ctx>__<i>__KOR.step   # optional mating sub-volumes (interface metric)
```

```bash
export CADGENBENCH_DATA_DIR=/path/to/my-gt
mamba run -n cadgenbench python -m cadbench_harness score myrun   # real CAD Scores
```

This path is verified end-to-end (`tests/test_score_local_gt.py`): a correct
candidate scores ~1.0 and a broken one strictly lower, against an authored GT.
Authoring correct GT for a real drawing is genuine CAD work — start with a few
simple fixtures (solve them in Plastiq, export `ground_truth.step`).

## Notes

- The input fixtures themselves are mounted from your own bucket
  (`LayerDynamics/cadgenbench-data-bucket` → `<repo>/local`); that bucket holds
  **inputs only** and is not a ground-truth source.
- Until GT access lands, `cadbench-harness score` and `validate` report validity
  (the hard `cad_score = 0` gate) — your local go/no-go before uploading.
