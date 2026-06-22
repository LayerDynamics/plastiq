# ADR 0009 — `truck` as an alternative WASM B-rep kernel: evaluation (NO-GO, now)

**Status:** Accepted (decision: do not adopt now; watch-list) · **Date:** 2026-06-22
**Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M9 · **Tier:** T1 research · **Decision: NO-GO**

## Context

`Expanse.md` (CADmium card) flagged **`truck`** ([ricosjp/truck](https://github.com/ricosjp/truck), the
pure-Rust OCCT-free B-rep kernel CADmium wraps) as a possible smaller-WASM alternative to our trimmed
`opencascade.js` (OCCT). M9 is a feasibility spike → a go/no-go, **not** an OCCT replacement (that would
be its own epic).

## License gate (hard stop) — PASSES

Verified directly (not assumed): `truck` at the pinned rev `c84318b8dec` ships a `LICENSE` file that is
the **Apache License 2.0** (fetched from `raw.githubusercontent.com/ricosjp/truck/c84318b8dec/LICENSE`).
Permissive, commercially usable. (CADmium's own code is Elastic-2.0 and unusable — but `truck` is a
*separate* repo, and it is the asset of interest. CADmium is not.) **Gate clears.**

## Evidence (truck scope vs our shipped kernel)

`truck` crates (from its README): `truck-geometry` (NURBS / B-spline), `truck-topology` (B-rep),
`truck-modeling` (sweep/revolve), `truck-shapeops` ("boolean operations to Solid"), `truck-polymesh` /
`truck-meshalgo` (meshing), `truck-stepio` (STEP), and **`truck-js` (a wasm binding already exists)**.

What `truck` does **not** provide that `@plastiq/cad` ships and tests today:

| Capability | `@plastiq/cad` (OCCT) | `truck` |
|---|---|---|
| Dress-ups: fillet / chamfer / shell / draft | ✅ (`action/dressup.ts`) | ❌ none |
| 2D sketch constraint solver | ✅ planegcs (FreeCAD PlaneGCS, wasm) | ❌ none |
| Assembly mate/joint solver | ✅ (`assembly/solver.ts`) | ❌ none |
| Feature set | ~18 ops (extrude/revolve/loft/sweep/pattern/transform/boolean/…) | modeling/shapeops primitives |
| I/O | STEP **+ IGES + glTF** | STEP only |
| Persistent tagged refs (selection survival) | ✅ | ❌ |
| Reconstruct service (pythonOCC, mesh→B-rep) | ✅ shares OCCT | would need a parallel story |
| Maturity signal | shipped, ~1050 JS + 85 py tests green | CADmium (built on truck) is **inactive / pre-MVP**, ~2 features, weaker (penalty) sketch solver (Expanse A1) |

The shipped OCCT wasm is **~5.6 MB gzip** (already a custom-trimmed build). A `truck` build *might* be
smaller — but **size is not the binding constraint; coverage and maturity are.**

## Decision — NO-GO (now); keep on the watch-list

Adopting `truck` would mean re-implementing dress-ups, the sketch constraint solver, assemblies, IGES/
glTF, and persistent tagging on a **less battle-tested** kernel (truck-shapeops booleans are far younger
than OCCT's), plus a parallel story for the pythonOCC reconstruct service — a multi-month epic for a
**speculative WASM-size win that doesn't address any current blocker.** The CADmium-on-truck immaturity
is direct evidence of the gap. **No production code is written** (as the spike intends).

`truck` stays a **noted watch-list** option (Apache-2.0, pure-Rust, NURBS B-rep, has wasm bindings): if
OCCT/WASM size, build complexity, or licensing ever becomes a real blocker, **re-evaluate then** — and
*that* re-evaluation should include the actual WASM-size prototype this spike deferred (the prototype
would not change today's decision, which coverage/maturity already settle).

## Consequences

- No code. `Expanse.md` CADmium/`truck` note + plan M9 updated to record the verified Apache-2.0
  license and the NO-GO recommendation with its revisit criteria.
