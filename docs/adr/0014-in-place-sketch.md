# ADR-0014 — Fusion-style in-place sketch (3D plane-native)

**Status:** Accepted  
**Date:** 2026-07-09  
**Context:** Sketch rewrite to match Fusion “draw on the body” UX

## Context

Plastiq’s sketcher (SPEC-5 M3) was a **modal full-viewport SVG overlay** with a camera forced normal-to the sketch plane. The solid stayed visible under a transparent overlay, but interaction was **2D-screen-native**, not **3D-plane-native**: orbit disabled, no Project, curves not scene objects, Extrude required a pre-finished sketch.

That model is fundamentally wrong for a Fusion-like CAD product.

## Decision

1. **Authoritative sketch data remains 2D parametric** (`SketchModel` in plane UV + planegcs). 3D is a view of UV via the active `DatumPlane`.
2. **Primary authoring surface is the 3D scene** on the sketch plane (R3F curves, plane grid, points). DOM HUD only for tools, dims text, Finish/Cancel, DOF.
3. **Drawing maps ray ∩ plane → UV** at every click/drag, whether the camera is normal-to or free-orbit.
4. **Orbit is allowed during sketch**; a **Look At plane** action re-orients the camera (default on enter).
5. **Project/Include** of solid edges is a first-class path (fixed projected entities linked to `EdgeRef`).
6. **Entry paths:** standalone sketch **and** feature-driven Extrude/Cut/Revolve sessions that Finish into sketch + solid feature.
7. **Session state** may remain outside document undo for live drag solve (SPEC-5 M3 sketch-session principle — **not** ADR-0013, which is photogrammetry). Commit still writes the sketch feature into the document history.

## Consequences

- `Sketcher.tsx` SVG curve/grid interaction is replaced by `SketchScene` + raycast interactor.
- E2Es that assume forced normal-to + SVG hit targets must be adapted.
- Face-plane frames must drive 3D chrome (not only datum `resolveDatumPlane`).
- Rebuild / profile extraction paths stay stable; consumer session only extends Finish.

## Alternatives considered

- **Polish the SVG overlay only** — rejected; still not in-place.
- **Full OCAF rewrite** — out of scope; keep Zustand feature tree.
