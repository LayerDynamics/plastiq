# ADR 0001 — Scaled Chamfer Distance (SCD) surface-fidelity metric in `services/reconstruct`

**Status:** Accepted · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M1
**Tier:** T2 (optional self-hosted Python service)

## Context

`services/reconstruct` turns a triangle mesh into a B-rep STEP solid and today validates the result
**only by volume** (`detect.py:125 _volume_ok`; `csg.py:244`, `revolution.py:114`, `fitted.py:194`,
`topology.py:208`) plus a coarse **per-region RMS** during fitting (`fitted.py:140,184`). Volume is a
single scalar — two very different shapes can share a volume — so it does not measure how faithfully
the reconstructed *surface* tracks the input mesh. The `Expanse.md` review of `ref/StepForge`
identified a pose/scale-invariant **Scaled Chamfer Distance** as a finer, complementary fidelity
measure (top-ranked, license-clean, no new heavy deps).

## Decision

Port StepForge's **deterministic surface sampler** and **Scaled Chamfer Distance** math into a new
`app/fidelity.py`, and report a `surface_deviation` (SCD) on every reconstruction.

- **Provenance / license:** StepForge is **Apache-2.0** (`ref/StepForge/LICENSE`). We port the *math*
  of `reward/step_to_pointcloud.py` (adaptive-deflection `BRepMesh_IncrementalMesh` tessellation →
  area-weighted barycentric surface sampling, seeded for determinism) and `reward/scd_reward.py`
  (`chamfer_distance`; `scaled_chamfer_distance` = CD ÷ GT-RMS-radius²). Attribution recorded here and
  in `services/reconstruct/README.md`. The StepForge **LLM/RL path is not used** (it carries
  Llama/Text2CAD encumbrances and is irrelevant here).
- **The metric MATH runs in MLX** (`mlx.core`, Apple Silicon — see memory `mlx-m4max-ml-milestones`):
  area-weighted barycentric sampling (categorical + uniform with explicit keys) and the bidirectional
  Chamfer as a **brute-force pairwise distance matrix → per-point min** (MLX has no kd-tree, so we
  replace StepForge's `scipy.spatial.cKDTree` — a few-thousand-point matrix is trivial on the GPU).
  OCCT/trimesh still produce the raw triangles; everything numerical after that is MLX. (MLX added to
  `environment.yml` as a pip dep.)
- **Drop the alignment stage.** StepForge runs FPFH+RANSAC+ICP (`reward/alignment.py`, the only part
  needing **open3d**) because it compares an LLM-generated STEP against ground truth in an *arbitrary*
  pose. **Our reconstructed B-rep is built directly from the input mesh — same coordinate frame** — so
  alignment is unnecessary. We add **no open3d dependency**.
- **Determinism (NFR-2).** Sampling is seeded (an explicit MLX key from a stable hash of the input
  geometry), so the same mesh always yields the same `surface_deviation`. No global RNG use; MLX with a
  fixed key is reproducible.
- **Metric definition.** `surface_deviation` = `CD(P_recon, P_mesh) / scale²`, where `CD` is the
  bidirectional mean-squared nearest-neighbour distance and `scale` is the RMS distance of the input
  mesh's sampled points from their centroid (dimensionless; matches the SCD paper Eq. 1–2). A
  companion `fidelity_tol` records the advisory threshold.
- **Advisory, not a gate (M1.5) — decided on evidence.** `surface_deviation` is reported for NFR-4
  honesty. We *tried* it as an acceptance gate in the `auto` ladder (reject an analytic fit whose
  volume passes but whose surface deviates beyond tol) and measured every analytic route:

  | route | surface_deviation | < tol (0.01)? |
  |---|---|---|
  | box / cylinder / sphere / cone (primitives) | 0.0038–0.0042 | yes |
  | csg (box ± holes/bosses) | 0.0041–0.0045 | yes |
  | revolution (stepped shaft) | 0.0040 | yes |
  | **oblique cut-cylinder** | **0.0200** | **no** |
  | sphere reconstructed for a box mesh (gross mismatch) | ~0.13 | no |

  A hard `SCD ≤ tol` gate **over-rejected the oblique cut-cylinder** — a *correct*, watertight analytic
  reconstruction (volume error only 1.5%) that is merely coarser (its analytic elliptical cap deviates
  from the faceted mesh rim by the sagitta). Gating it out would downgrade a good analytic solid to the
  faceted fallback — a quality regression. Because SCD also scales with input tessellation density, a
  fixed hard gate is fragile. The existing **volume + per-region-RMS + shape-coverage** gates already
  reject wrong primitives. **Decision: ship `surface_deviation` report-only.** It remains available as
  the acceptance gate for the *freeform/fitted* path (M-future) where there is no volume self-validation.

## Consequences

- New `app/fidelity.py`; new fields `surface_deviation: float`, `fidelity_tol: float` on
  `ReconstructionReport` (server) and optional `surface_deviation?`/`fidelity_tol?` on the client
  `ReconstructReport` (older-server compatible, mirroring `curved_faces?`).
- No new runtime dependency. No change to the submit→poll API shape.
- `SPEC-7` §6 report contract and `Expanse.md` rec #1 updated in the same change (CLAUDE.md docs rule).
