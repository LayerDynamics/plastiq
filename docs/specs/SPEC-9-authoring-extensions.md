# SPEC-9 — Authoring extensions (declarative assembly + BOM; agent planning-IR; voxel mode)

**Status:** In progress (M4 shipped) · **Date:** 2026-06-22
**Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M4/§M5/§M10

This spec collects the T1 (browser, no-server) authoring extensions harvested as *ideas* from the
`ref/` corpus (`Expanse.md`). Each section is independent; they share only the "deterministic, pure
TypeScript, no new dependency" posture.

## §assembly — declarative `.assy` description + auto-BOM (M4 · shipped)

**ADR:** [`docs/adr/0004-declarative-assembly-bom.md`](../adr/0004-declarative-assembly-bom.md) ·
**Source idea:** partcad (Apache-2.0; concept only, our own schema)

A small, dependency-free declarative document a human or the AI agent can write to lay out a multi-part
assembly, plus an automatically-derived bill of materials.

**Schema** (`apps/plastiq/src/assembly/assy.ts`):

```jsonc
{
  "name": "bracket-assembly",
  "links": [
    { "part": "plate" },
    { "part": "bolt", "name": "bolt-1", "location": { "position": [10, 0, 0] } },
    { "part": "bracket-sub", "location": { "axis": [0, 0, 1], "angle": 90 } }
  ],
  "subAssemblies": {
    "bracket-sub": { "links": [ { "part": "bolt" }, { "part": "bolt" } ] }
  }
}
```

- `AssyLocation` = `{ position?, axis?, angle? (deg) }` — a rigid placement.
- `AssyLink` = `{ part, location?, name? }` — `part` names a leaf part OR a `subAssemblies` key (recursive).
- **`parseAssy(input)`** validates untrusted/AI-authored JSON into a typed `AssyDoc` (throws with a
  descriptive message).
- **`realizeAssembly(doc)`** flattens it into the interactive `AssemblyModel`
  (`apps/plastiq/src/assembly/model.ts`), composing each sub-assembly placement with its children
  (`worldPos = parentPos + quatRotate(parentQ, childPos)`, `worldQ = parentQ ∘ childQ`); cycle-guarded,
  deterministic instance ids.
- **`deriveBOM(doc)`** rolls up leaf-part occurrence counts (sub-assemblies expanded), sorted by part.
  Rendered by **`BomPanel.tsx`**.
- **`assemblyToAssy(model)`** exports an interactively-built assembly back to a flat `.assy` (round-trips).

`ComponentInstance` gained `part?` (the BOM key; defaults to `name`). **Honest scope:** Plastiq has no
multi-part geometry library yet, so `part` is a name — instances carry it for the BOM/display; binding
a name to distinct geometry is a future multi-part-library milestone (the format + BOM are complete).

**Tests:** `apps/plastiq/src/assembly/assy.test.ts` (parse/realize/nesting/rotation/BOM/round-trip) +
`BomPanel.test.tsx`.

## §planning-ir — agent decomposition-graph planning-IR (M5 · pending)

See `docs/adr/0005-agent-planning-ir.md` (to be written): the AI agent emits a hierarchical
decomposition plan before `build_part` tool calls. Independent design (Graph-CAD is inspiration only;
no license).

## §voxel — ray-pick voxel-editing mode (M10 · pending)

See `docs/adr/0010-voxel-mode.md` (to be written): an opt-in dense-occupancy editing mode (voxel-editor
idea, Apache-2.0), gated like `MeshDoc`, exporting voxels→mesh into the reconstruct path.
