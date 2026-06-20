# Plan — SPEC-6 R0: Foundations (validation + unit conversion)

**Date:** 2026-06-20
**Spec:** `docs/specs/SPEC-6-ai-generation.md` → milestone **R0**
**Execution:** inline sequential · **TDD (test-first)** · CI deterministic-only
**Commit:** conventional commits, one commit at milestone end (ask before committing)

## Goal

Land the two zero-risk foundations every later milestone depends on: the dependency set,
and a validated, unit-converting bridge between the AI's **mm/deg authoring document** and
the kernel's **SI `CadDocument`**. No UI, no network — pure functions + unit tests.

## Why first

R1–R4 all consume `cadDocumentSchema` + `toCadDocument`/`toAuthoringDoc`. Closing the
verified "no `CadDocument` validator / no `zod`" gap (spec §3.2) here unblocks everything
and is independently shippable + fully unit-testable in Node.

## Prerequisites / grounding (verified)

- Target type: `CadDocument` / `EditorFeature` — `apps/plastiq/src/store/types.ts:19-41`.
- Feature dispatch + per-feature param/data shapes: `apps/plastiq/src/worker/rebuild.ts`
  (every `case` is the source of truth for what a feature needs).
- Sketch `Profile`: `apps/plastiq/src/sketch/profile.ts:22`.
- Unit helpers: `packages/cad/src/unit/index.ts` (`mm`, `deg`, `toMm`, `toDeg`).
- Test scripts filter by filename: `*.unit.test.ts` → `pnpm test:unit`.

## Tasks

### T0.1 — Add dependencies

- **Files:** `apps/plastiq/package.json`; lockfile.
- **Do:** add `zod`, `@anthropic-ai/sdk`, `openai` to `apps/plastiq` deps; `pnpm install`.
- **Verify:** `pnpm -C apps/plastiq run build` (tsc + vite) stays green; `pnpm typecheck`.
- **Done when:** all three resolve and the app still builds in the browser target.

### T0.2 — Authoring schema (mm/deg) as zod, one feature type at a time

- **Files (new):** `apps/plastiq/src/ai/tools/schema.ts`,
  `apps/plastiq/src/ai/tools/schema.unit.test.ts`.
- **Test-first:** for each feature `type` in `rebuild.ts`, write a unit test that a
  representative authoring object **parses** and an invalid one (missing/typo param)
  **fails** with a useful path. Run `pnpm test:unit` → red.
- **Implement:** a discriminated-union `authoringFeatureSchema` keyed on `type`, covering
  exactly the `rebuild.ts` set: `box, sketch, extrude, revolve, loft, sweep, cut,
  fillet, chamfer, shell, draft, transform, mirror, linearPattern, circularPattern,
  boolean, importStep, placement`. Reuse the `Profile` shape (`sketch/profile.ts`) for
  sketch. Numbers are **mm/deg**. Wrap in `authoringDocumentSchema = { features:[…],
  params }`.
- **Done when:** every feature type has a passing parse + reject test.

### T0.3 — `cadDocumentSchema` (SI) validator for untrusted output

- **Files:** `schema.ts`; `schema.unit.test.ts`.
- **Test-first:** assert a hand-built SI `CadDocument` validates; a structurally broken
  one (e.g. `features` not an array, unknown `type`) is rejected. Red first.
- **Implement:** `cadDocumentSchema` mirroring `CadDocument`/`EditorFeature`
  (`store/types.ts:19-41`) — the structural gate applied to anything before
  `loadDocument` (spec decision 9).
- **Done when:** valid/invalid SI docs are correctly accepted/rejected.

### T0.4 — `toCadDocument` (mm→SI) and `toAuthoringDoc` (SI→mm), round-trip

- **Files:** `schema.ts`; `schema.unit.test.ts`.
- **Test-first:** property/round-trip test — for each feature type, an authoring object →
  `toCadDocument` → `toAuthoringDoc` returns the original mm/deg values (within float
  tolerance); and lengths convert by `mm()`/`toMm`, angles by `deg()`/`toDeg`
  (`unit/index.ts`). Assert a `40` mm length becomes `0.04`. Red first.
- **Implement:** the two mappers. Centralize **every** length/angle conversion here (the
  single choke-point, spec R-7); non-dimensional `data` (profiles, selectors, refs) passes
  through unchanged except 2-D sketch coordinates (mm→m).
- **Done when:** round-trip is loss-free both ways for all feature types.

## Milestone exit criteria

- `pnpm test:unit` green; `pnpm typecheck` green; `pnpm -C apps/plastiq run build` green.
- `schema.ts` exports `authoringDocumentSchema`, `cadDocumentSchema`, `toCadDocument`,
  `toAuthoringDoc`; all covered by `schema.unit.test.ts`.
- No app behavior change yet (pure additions) → zero regressions in the existing suite.

## Risks specific to R0

- Sketch coordinate units: 2-D profile points are lengths and **must** convert mm→m —
  cover explicitly (easy to miss vs. scalar params). (R-7)
- `importStep`/`placement` carry no dimensional params — assert they pass through untouched.

## Commit

`feat(app): SPEC-6 R0 — zod validation + mm↔SI authoring schema` (after exit criteria pass; ask first).
