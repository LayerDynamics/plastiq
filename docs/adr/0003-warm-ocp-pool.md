# ADR 0003 — Warm-OCP process pool (forgent3d) — NOT adopted; cold-import already amortized

**Status:** Accepted (decision: do not build) · **Date:** 2026-06-22
**Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M3 · **Tier:** T2 · **License:** forgent3d MIT

## Context

M3 proposed porting forgent3d's **warm `build123d`/OCP rebuild-daemon** to `services/reconstruct` to
"kill the ~2.2 s pythonOCC cold-import per request." On reading the actual code, that premise does not
hold for our architecture.

## Finding (verified)

- **forgent3d's daemon solves a per-process-spawn problem.** It is an Electron desktop app that
  shells out to a fresh Python process *per rebuild*; without a warm daemon each rebuild re-pays the
  OCP import. (`ref/forgent3d/packages/cad-runtime/python/rebuild_daemon.py`.)
- **`services/reconstruct` is a long-running FastAPI server, not a per-rebuild CLI.** All OCC imports
  are **module-level** (`app/curved_faces.py:19+`, `app/fidelity.py`, `app/detect.py`, `app/csg.py`,
  … — `grep` finds no function-local `import OCC`). They are triggered once at startup via
  `app/main.py:25 from .pipeline import reconstruct` → the pipeline import chain. Each request then
  reuses that already-imported, warm OCC through `asyncio.to_thread(reconstruct, …)` (`main.py:75`).
  **The ~2.2 s import is a one-time startup cost, paid once per server lifetime — there is no
  per-request cold-import to remove.**

## Why the fallback justifications also don't apply (no evidence)

A process pool could still add (a) crash-isolation and (b) parallelism. Neither is warranted here:

- **Crash isolation is StepForge's threat model, not ours.** StepForge's subprocess isolation exists
  because OCC **SIGSEGVs while *parsing* untrusted LLM-generated STEP text**. Our service does the
  opposite — it **constructs** STEP from meshes through our own pipeline, gated by volume checks,
  `BRepCheck_Analyzer` validity, closure/`NbFreeEdges` checks, and a faceted fallback. No OCC segfault
  has been observed across the 85-test suite, including the degenerate/open-mesh cases
  (`test_open_mesh_falls_back_to_a_shell_not_a_solid`, `test_degenerate_triangles_are_skipped`). With
  no crash evidence, building `BrokenProcessPool` recovery is speculative.
- **Parallelism buys ~nothing.** The service is **local, single-user, self-hosted** (SPEC-7 D-6).

## Decision

**Do not build a multiprocessing warm-OCP pool.** Adding a `spawn` `ProcessPoolExecutor` with
crash-recovery, IPC pickling, and lifecycle management is real complexity for a benefit that is
already achieved (warm OCC) or speculative (isolation/parallelism). That is the over-engineering this
project's guidance explicitly warns against; the simple long-running-server + `to_thread` design is
correct for a local single-user service.

## Revisit criteria

Reopen only with **evidence**: a real OCC SIGSEGV in this pipeline (not a parse of untrusted STEP), or
the service becoming multi-user/hosted (would reverse D-6). At that point adopt StepForge's persistent
**warm** pool (`ProcessPoolExecutor(mp_context="spawn", initializer=<import OCC>)` so workers stay warm
— isolation without reintroducing per-request cold-import), with crash-recovery tests.

The forgent3d warm-daemon idea remains correctly credited for per-process-spawn tooling — it is simply
not the right fit for a long-running server.
