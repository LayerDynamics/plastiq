# ADR 0004 — Declarative `.assy` assembly description + auto-BOM (partcad-inspired)

**Status:** Accepted · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M4
**Tier:** T1 (browser, deterministic) · **Source idea:** partcad (Apache-2.0; concept reuse, our own schema)

## Context

`Expanse.md` flagged partcad's **declarative assembly-as-data + automatic BOM** as a net-new *concept*
worth harvesting (partcad itself is a heavyweight Python PLM, not embeddable; we reuse the idea, not the
code). Plastiq's assembly today (`apps/plastiq/src/assembly/model.ts`) is an `AssemblyModel`
(`instances` + `mates` + `joints`) authored interactively; there is no declarative document a human or
the AI agent can write to lay out a multi-part assembly, and no bill of materials.

## Decision

Add a small, dependency-free **declarative assembly description** (`.assy`) + a loader that realizes it
into the existing `AssemblyModel`, plus an **auto-BOM** derived from it.

- **Home: app-side (`apps/plastiq/src/assembly/assy.ts`).** The plan said "@plastiq/cad", but the
  `AssemblyModel` the loader targets lives in the app (`assembly/model.ts`), and the kernel only owns
  the index-based mate *solver*. The loader realizes into the app model, so it belongs with it. (Doc
  reconciled here, per CLAUDE.md.)
- **Schema (plain JSON object — no YAML dependency; partcad uses YAML, we keep it dep-free):**
  - `AssyLocation` = `{ position?: [x,y,z], axis?: [x,y,z], angle?: deg }` — a rigid placement.
  - `AssyLink` = `{ part: string, location?: AssyLocation, name?: string }` — one placed occurrence;
    `part` names a leaf part OR a key in `subAssemblies` (recursive nesting).
  - `AssyDoc` = `{ name?, links: AssyLink[], subAssemblies?: Record<string, AssyNode> }`.
- **`realizeAssembly(doc) → AssemblyModel`** — flattens the (possibly nested) links into
  `ComponentInstance[]`, composing each sub-assembly link's placement with its children's
  (`worldPos = parentPos + quatRotate(parentQ, childPos)`, `worldQ = parentQ ∘ childQ`, reusing
  `model.ts`'s `quatMul`/`quatRotate`/`axisAngleQuat`). Deterministic.
- **`deriveBOM(doc) → BomEntry[]`** — recursively expands sub-assemblies and counts leaf `part`
  occurrences, rolled up to `{ part, count }`, sorted by part name (deterministic).
- **`assemblyToAssy(model) → AssyDoc`** — the inverse, so an interactively-built assembly can be
  exported to a `.assy` document (round-trip).
- **Honest scope.** Plastiq has no multi-part library yet (all instances reference the current part),
  so `part` is a NAME (string) — the realized instances carry it for the BOM and display; binding a
  name to distinct geometry is a future multi-part-library milestone. The format and BOM are real and
  complete; only the geometry-per-name binding is deferred (documented, not stubbed).

## Consequences

- New `apps/plastiq/src/assembly/assy.ts` + tests. Optional BOM panel + import/export UI (the data
  layer is the substance and is fully tested; the panel consumes `deriveBOM`).
- New `docs/specs/SPEC-9-authoring-extensions.md` §assembly; `Expanse.md` partcad item updated.
- No new dependency; pure TS; deterministic (NFR-aligned).
