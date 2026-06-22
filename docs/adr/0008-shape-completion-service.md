# ADR 0008 — Shape completion ("Complete Scan / Fill Gaps"): MLX occupancy network

**Status:** Accepted · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M8
**Tier:** T2 (self-hosted Python) · **Source idea:** DLR-RM shape-completion (MIT) · **Framework:** MLX (Apple Silicon)

## Context

`Expanse.md` ranked shape completion (partial scan → full watertight mesh) as the one modern, MIT,
genuinely-net-new capability in its batch — but DLR-RM `shape-completion` ships **no weights** and is
**CUDA-only** (PyTorch3D, custom C++/CUDA Chamfer/EMD/MISE). Per the M4 Max / MLX directive (memory
`mlx-m4max-ml-milestones`), this is a **self-contained MLX implementation**, trainable on the M4 Max —
not a port.

## Decision

Add an MLX **conditional occupancy network** and a `/complete` endpoint to the capture service.

- **`app/completion_mlx.py` — ONet-style completion:** a PointNet encoder (per-point MLP → global
  max-pool → latent) + an occupancy decoder ((query, latent) → inside/outside logit of the FULL
  shape). Trained with logits-BCE on (partial, query, full-occupancy) triples; `complete` marching-cubes
  the predicted occupancy → mesh. Pure MLX, trains on the M4 Max. Deterministic by seed.
- **Demo dataset = synthetic primitives** (hemisphere-masked sphere scans → the full ball). The test
  asserts the completion **fills the missing hemisphere the partial never saw** (genuine completion,
  not echo). **For general objects, train on a ShapeNet-style partial/full dataset and load the
  checkpoint** (`CAPTURE_COMPLETION_CHECKPOINT`) — documented, not faked.
- **Service:** `POST /complete {points}` on the capture service (submit→poll), returning a GLB → the
  existing `MeshDoc` → reconstruct path. A lazily-trained-or-loaded cached model serves requests.
- **Lives in the capture service, NOT reconstruct.** It is ML/non-deterministic, so it must stay out of
  the deterministic mesh→B-rep reconstruct (NFR-2). Co-locating with capture (also MLX) avoids a third
  service+env while keeping the key separation (from reconstruct). *(Plan said `services/complete/`; we
  consolidate into `services/capture/` since both are MLX mesh services — recorded here.)*

## Honest scope

- **Built + trained here:** the MLX completion network + training loop + a synthetic completer that
  demonstrably fills holes (asserted on the M4 Max, ~2 s). Save/load (`CompletionNet.load_weights`) for
  checkpoints.
- **Not built:** a general pretrained model. Completion quality is **class-dependent** — the demo
  completes the family it trained on (spheres); real objects need ShapeNet training. This is the same
  honesty the upstream repo carries (it ships no weights either).

## Consequences

- `services/capture/app/completion_mlx.py` + `pipeline.complete_partial` + `/complete` endpoint + tests
  (completion fills the gap, GLB export, determinism; HTTP test gated on fastapi+mlx).
- `SPEC-10 §completion` + `Expanse.md` rec #3 updated; capture README notes the second capability.
