# Grok.md — Deep Code Investigation: CAD Actions (extrude, sweep, and the full feature pipeline)

**Date:** 2026-07-09  
**Branch:** `code-review-fixes`  
**Method:** `/deep-code-investigation` — exhaustive multi-layer trace of every CAD feature action from UI entry → store document → geometry worker rebuild → `@plastiq/cad` kernel → OCCT embind, with `file:line` evidence.  
**Product thesis:** Plastiq is a fully client-side parametric CAD editor: sketch a 2D profile, build an ordered B-rep feature history on a real OCCT-via-WASM kernel, select faces/edges, assemble with mates/joints, and export/simulate. The marquee path is **sketch → feature action → rebuild → tagged mesh in the viewport**.

---

## Phase 1 — Investigation scope (framing)

| # | Question | Answer |
|---|----------|--------|
| 1 | **Entry points** | (a) Ribbon/context-menu `ActionDef.run` (`apps/plastiq/src/actions/registry.ts`, `three/contextmenu/config.ts`); (b) AI `build_part` → `toCadDocument` (`ai/tools/schema.ts`); (c) direct store `addFeature` / load; (d) kernel unit tests calling `extrude`/`sweep`/… |
| 2 | **Terminal effect** | A single owned OCCT `Solid` (or null), tessellated to a `TaggedMesh` in the geometry worker, published to the viewport; optional STEP/IGES/glTF export. |
| 3 | **Boundaries crossed** | UI (React/Zustand) → worker postMessage (`protocol.ts`) → `rebuildDocument` → `@plastiq/cad` pure TS wrappers → OCCT WASM embind heap. |
| 4 | **Looking for** | Gaps between advertised CAD capability and actual implementation of extrude, sweep, revolve, loft, cut, dress-ups, patterns, booleans — wiring, data contracts, cleanup, and missing options. |

---

## 1. Executive summary

Plastiq’s CAD kernel (`packages/cad/src/action/*`) implements a real, tested set of B-rep feature ops (extrude, extrude-to-face, revolve, loft, sweep, cut-via-boolean, fillet/chamfer/shell/draft, transform/mirror, linear/circular pattern, union/subtract/intersect) against OpenCascade WASM. The editor rebuild loop (`apps/plastiq/src/worker/rebuild.ts`) is the single feature-tree evaluator that maps document features onto those ops.

**Most important findings:** (1) several rebuild bindings are narrower than the kernel API (revolve origin fixed at world origin; sweep profile forced onto world-XY; loft sections only stack on XY+z); (2) `extrude()` lacks the try/finally failure-path cleanup every peer op has, so a `Standard_Failure` from `MakePrism` can leak WASM handles in the long-lived worker; (3) spine paths are polyline-only despite rebuild/UI comments advertising “polyline/arc”; (4) cut lacks direction/two-sided options that extrude already has; (5) loft/sweep ribbon actions inject hard-coded demo geometry rather than a real selection-driven authoring path.

---

## 2. Entry points

| # | Entry | File:line | What it does |
|---|-------|-----------|--------------|
| E1 | Context menu Extrude/Cut/Revolve/Fillet/… | `apps/plastiq/src/three/contextmenu/config.ts:148–239` | `addFeature` with default params + dress-up refs from picks |
| E2 | Ribbon Loft/Sweep/Mirror/Pattern/Boolean | `apps/plastiq/src/actions/registry.ts:206–300` | Demo-profile features (hard-coded rects/paths) |
| E3 | Dress-up feature builders | `apps/plastiq/src/viewport/dressup.ts:30–137` | Build feature `data` (EdgeRef/FaceRef/sections/path) from selection |
| E4 | AI authoring | `apps/plastiq/src/ai/tools/schema.ts:70–121` | Zod schema + mm/deg → SI conversion → same CadDocument |
| E5 | Geometry worker | `apps/plastiq/src/worker/geometry.worker.core.ts` → `rebuild.ts:144` | `rebuildDocument(oc, doc)` |
| E6 | Kernel direct API | `packages/cad/src/index.ts:50–72` | Re-exports every action for tests and the worker |

---

## 3. Execution trace (primary path: sketch → extrude)

```
[UI] CONTEXT_ACTIONS "extrude".run
  apps/plastiq/src/three/contextmenu/config.ts:148-155
  → cad().addFeature({ type: "extrude", params: { height: EXTRUDE_H } })
      apps/plastiq/src/store/store.ts (addFeature)
  → document change triggers worker rebuild

[Worker] rebuildDocument(oc, doc)
  apps/plastiq/src/worker/rebuild.ts:144-230
  case "sketch":
    extract profile + resolve plane → activeSketch { profile, plane }
  case "extrude":
    sk = profileSketch(activeSketch.profile, activeSketch.plane)   // :200
    if toFace: extrudeToFace → union with base                         // :216-226
    else:      extrude(oc, sk, height, { back, direction })            // :228

[Kernel] extrude(oc, sketch, height, opts?)
  packages/cad/src/action/extrude.ts:40-76
  → sketch.toFace(oc) → optional shifted back-face
  → BRepPrimAPI_MakePrism_1(baseFace, vec, false, true)
  → new Solid(oc, shape)

[Terminal] rebuildTaggedWithProps
  rebuild.ts:478-490
  → tessellateTagged → mesh + volume + COM → postMessage to UI
```

### Parallel traces (other actions)

| Feature | Rebuild case | Kernel call | OCCT primitive |
|---------|--------------|-------------|----------------|
| revolve | `:232-242` | `revolve` | `BRepPrimAPI_MakeRevol_1` |
| loft | `:244-252` | `loft` | `BRepOffsetAPI_ThruSections` |
| sweep | `:254-261` | `sweep` | `BRepOffsetAPI_MakePipeShell` |
| cut | `:263-275` | `extrude` + `cut` | prism + `BRepAlgoAPI_Cut` |
| fillet/chamfer | `:277-292` | `fillet`/`chamfer` | `BRepFilletAPI_MakeFillet` / `MakeChamfer` |
| shell | `:294-300` | `shell` | `BRepOffsetAPI_MakeThickSolid` |
| draft | `:302-322` | `draft` | `BRepOffsetAPI_DraftAngle` |
| transform | `:324-339` | `translate`/`rotate` | `BRepBuilderAPI_Transform` |
| mirror | `:341-357` | `mirror` + optional `union` | `gp_Trsf.SetMirror` |
| linearPattern | `:359-369` | `linearPattern` + `unionAll` | repeated translate |
| circularPattern | `:371-389` | `circularPattern` + `unionAll` | repeated rotate |
| boolean | `:391-428` | `union`/`subtract`/`intersect` | Fuse/Cut/Common |
| importStep | `:430-452` | `importStep` | STEP reader |

---

## 4. Data flow

```
[UI Action / AI]
  AuthoringFeature { type, params (mm/deg), data }
        ↓ toCadDocument (schema.ts) — lengths mm→m, angles deg→rad
[CadDocument]
  EditorFeature { id, type, params (SI), data, deps?, suppressed? }
        ↓ rebuildDocument switch
[Kernel inputs]
  Sketch (plane + ops) | Solid | EdgeRef[] | FaceRef[] | SpinePath | sections
        ↓ action/*
[Solid] owned TopoDS_Shape
        ↓ tessellateTagged
[TaggedMesh] vertices, faceGroups (FaceRef), edges (EdgeRef) → viewport picks
```

**Lossy / asymmetric transforms:**

- Blind `extrude` **replaces** the current solid (`replace(...)`); only `extrudeToFace` **unions** with the base (`rebuild.ts:221-223`). A second boss on an existing body is not a join unless the user uses boolean or extrude-to-face.
- `activeSketch` is a **single** slot (`rebuild.ts:149`). Loft/sweep do **not** consume the feature-tree sketch history; they require profiles baked into `data.sections` / `data.profile`.
- Sweep path unit conversion scales polyline points (`schema.ts:195-199`) but there is no arc path shape to convert.
- Revolve axis origin is **not** in params — always `[0,0,0]` at rebuild (`rebuild.ts:239-240`).

---

## 5. Boundary analysis

| # | From | To | Mechanism | Auth | Error handling | Timeout | Data contract |
|---|------|----|-----------|------|----------------|---------|---------------|
| 1 | UI store | Geometry worker | postMessage `build` | none (same origin) | worker returns error string; feature marked errored | none explicit | `CadDocument` JSON-cloneable |
| 2 | rebuild | `@plastiq/cad` | direct TS import | n/a | throws typed `Error` per feature | n/a | SI metres/radians |
| 3 | action/* | OCCT WASM | embind constructors | n/a | `IsNull`/`IsDone`/`HasErrors`; fail-loud | n/a | owned handles + `.delete()` |
| 4 | AI schema | CadDocument | `toCadDocument` | n/a | zod structural validate | n/a | mm/deg → SI; must mirror rebuild |
| 5 | Dress-up picks | Feature data | FaceRef/EdgeRef signatures | n/a | unresolved edges → kernel throw | n/a | FR-16 persistent refs |

**Contract mismatches found:**

- Rebuild comment “polyline/**arc** path” (`rebuild.ts:255`) vs `SpinePath.kind: "polyline"` only (`spine.ts:19-22`).
- AI revolve schema omits origin params (`schema.ts:85`); kernel accepts `origin: Vec3` (`revolve.ts:12-17`).
- Sweep rebuild ignores profile plane (`rebuild.ts:260` → `profileSketch(prof)` defaults to `planeXY()`).

---

## 6. Dependency graph

```
apps/plastiq
  actions/registry.ts ──► store, dressup, voxel, assembly
  three/contextmenu/config.ts ──► dressup, store, sketch
  worker/rebuild.ts ──► @plastiq/cad (all actions)
  ai/tools/schema.ts ──► featureUnits (LENGTH/ANGLE params)

packages/cad
  action/{extrude,revolve,loft,dressup,boolean,pattern,transform}.ts
    ├── sketch/{sketch,spine}.ts
    ├── mesh/{resolve,normals,tagged}.ts
    ├── solid/solid.ts
    ├── env/plane.ts
    └── oc/init.ts (Occt)
```

**Callers of kernel actions:** rebuild worker, kernel smoke/integration tests, sketch integration tests (extrude/sweep), mesh tessellate tests (revolve).

---

## 7. Risk areas & findings (actionable gaps)

### G1 · HIGH · `extrude()` missing try/finally cleanup on failure path  
**Evidence:** `packages/cad/src/action/extrude.ts:40-76` — allocates `face`, optional `shifted` face, `gp_Vec`, `BRepPrimAPI_MakePrism` without a `try/finally`. Peers (`revolve.ts:34-55`, `loft.ts:25-44`, `sweep.ts:67-91`, `dressup` fillet/shell) free every temporary on `Standard_Failure`.  
**Impact:** A prism failure in the long-lived geometry worker leaks WASM handles (same class of bug fixed elsewhere in `cleanup.unit.test.ts`).  
**Also:** `shifted()` (`extrude.ts:23-33`) has the same non-finally structure.

### G2 · HIGH · Revolve axis origin hard-coded to world origin in rebuild  
**Evidence:** Kernel `revolve(oc, sketch, origin, axis, angle)` (`revolve.ts:12-17`); rebuild always passes `[0, 0, 0]` (`rebuild.ts:239-240`). Params only expose `ax/ay/az` (direction), not `ox/oy/oz`. `featureUnits.ts` LENGTH_PARAMS for revolve is empty; AI schema (`schema.ts:85`) has no origin fields.  
**Impact:** Cannot revolve about an offset axis (common CAD: revolve about a sketch line not through the world origin). Kernel already supports it.

### G3 · HIGH · Sweep profile always rebuilt on world-XY  
**Evidence:** `rebuild.ts:260` — `profileSketch(prof)` with default plane `planeXY()` (`:84`). Extrude/revolve correctly pass `activeSketch.plane`. Sweep feature data has no `plane` field (`schema.ts:106`, `dressup.ts:112-114`).  
**Impact:** A profile intended on XZ/YZ or an on-face plane is forced onto XY; swept solids are wrong for non-XY profiles.

### G4 · MEDIUM · SpinePath is polyline-only; “arc path” is advertised but unbuilt  
**Evidence:** `spine.ts:19-22` — only `{ kind: "polyline"; points }`. Rebuild comment `rebuild.ts:255` and dressup `dressup.ts:111` say “polyline/arc”. `buildSpineWire` only emits line edges (`spine.ts:38-54`). OCCT can build arc edges; no path kind for them.  
**Impact:** Curved sweeps require many polyline samples (or fail to express a true circular arc spine).

### G5 · MEDIUM · Cut lacks direction / two-sided options that extrude has  
**Evidence:** Cut always `extrude(..., num(f, "depth"))` with no direction/back (`rebuild.ts:269`). Extrude supports `direction`, `directionEdge`, `back`, `toFace`. Cut params only `depth` (`featureUnits.ts:36`, `schema.ts:86`).  
**Impact:** Cannot pocket reverse-side, two-sided, or along a picked edge without workarounds.

### G6 · MEDIUM · Loft sections locked to offset world-XY planes  
**Evidence:** `rebuild.ts:250` — `offsetPlane(planeXY(), s.z)` only. Kernel `loft` accepts any `Sketch[]` on any planes (`loft.ts:17`). Data contract `{ profile, z }` (`schema.ts:104`, `dressup.ts:103-108`).  
**Impact:** Cannot loft between profiles on non-parallel or non-XY planes (e.g. face-sketched sections).

### G7 · MEDIUM · Blind extrude replaces body; only extrude-to-face joins  
**Evidence:** `rebuild.ts:228` `replace(extrude(...))` vs `:221-223` `union(base, pad)`. Single-body history model means a second pad **destroys** the prior solid rather than joining a boss.  
**Impact:** Multi-feature “add material” modeling requires boolean-body workarounds; inconsistent with extrude-to-face join semantics.

### G8 · MEDIUM · Sweep transition/frame options not exposed  
**Evidence:** `sweep` hard-codes corrected Frenet + `RightCorner` (`loft.ts:68-71`). No `SweepOptions` (RoundCorner / Transformed / fixed frame).  
**Impact:** Miters only; no rounded corners or fixed-orientation pipe sections for consumers that need them.

### G9 · LOW–MEDIUM · Draft is single-face only at rebuild  
**Evidence:** Kernel `draft` takes one `FaceRef` (`dressup.ts:177`); rebuild takes first face only (`rebuild.ts:305`). Multi-face mold draft requires N features.  
**Impact:** Usability gap vs typical CAD draft multi-select.

### G10 · LOW–MEDIUM · Ribbon loft/sweep are demo injectors, not authoring tools  
**Evidence:** `registry.ts:216-243` hard-codes `rectProfile` + fixed z heights / polyline. No pick-sections / draw-path workflow.  
**Impact:** Users get a fixed demo solid; real loft/sweep authoring is AI-data or hand-edited document only.

### G11 · LOW · Linear pattern does not normalize direction  
**Evidence:** `pattern.ts:21` — `scale(dir, spacing * i)` without unitizing `dir`. Rebuild defaults `dx=1` (`rebuild.ts:362`) so unit X works; a non-unit AI/user dir scales spacing incorrectly.  
**Impact:** Wrong spacing when direction is not unit length.

### G12 · LOW · Fillet/chamfer are constant-radius / symmetric-setback only  
**Evidence:** `fillet` uses `Add_2(radius, edge)` (`dressup.ts:31`); `chamfer` uses `Add_2(distance, edge)` (`:78`). No variable-radius fillet, no two-distance chamfer (OCCT APIs exist on the makers).  
**Impact:** Capability ceiling for dress-up; not a bug in current constant-radius path.

### G13 · LOW · Shell always hollows inward (negative offset)  
**Evidence:** `dressup.ts:139` — `-thickness` hard-coded. No outward thicken.  
**Impact:** Cannot grow walls outward; only inward shell.

### G14 · Documentation/test hygiene  
- Sweep rebuild comment claims arc path support that does not exist (`rebuild.ts:255`).  
- No unit cleanup test for `extrude` failure path (unlike loft/sweep/dressup in `cleanup.unit.test.ts`).  
- No rebuild test for revolve with non-zero origin.  
- No rebuild test for sweep with non-XY profile plane.

---

## 8. What works (verified intact)

| Capability | Evidence |
|------------|----------|
| Extrude rect/circle/arc/spline profiles | `rebuild.test.ts`, `features.test.ts`, e2e `sketch-to-solid.spec.ts` |
| Two-sided extrude (`back`) | `rebuild.test.ts` FR-29, `features.test.ts` |
| Direction override + directionEdge | `rebuild.ts:201-211`, tests |
| True extrude-to-face (planar + curved trim) | `extrude.ts:210-433`, `extrudeToFace.test.ts` |
| Sweep multi-edge polyline (MakePipeShell, not MakePipe) | `loft.ts:48-56`, rebuild test multi-edge spine |
| Circular pattern full-turn vs partial-arc endpoint convention | `pattern.ts:30-38`, `loftsweep.test.ts` |
| Dress-up fails if any EdgeRef/FaceRef unresolved | `dressup.ts:38-47`, tests |
| Boolean tool as full feature subtree | `rebuild.ts:401-406` |
| Mesh/voxel mode greys B-rep ops (FR-18) | `registry.ts:475-520` |

---

## 9. Open questions (not determined from code alone)

1. Is single-body “replace on extrude” an intentional product decision (Fusion-style new body default), or an incomplete join mode? Spec FR-29 names extrude/cut/revolve but does not specify multi-pad join defaults.
2. Should loft sections migrate to `{ profile, plane: SketchPlaneSpec }` (breaking data shape) or add optional `plane` alongside `z` for back-compat?
3. Priority of interactive loft/sweep UI vs AI/document authoring only.

---

## 10. Findings → remediation plan (ordered)

| ID | Gap | Proposed fix |
|----|-----|--------------|
| G1 | Extrude cleanup | try/finally in `extrude` + `shifted`; unit test in cleanup suite |
| G2 | Revolve origin | Wire `ox/oy/oz` through rebuild, featureUnits, AI schema + tests |
| G3 | Sweep profile plane | Accept `data.plane` / default activeSketch plane; schema + tests |
| G4 | Arc spine | Extend `SpinePath` with arc segments **or** correct comments; prefer real arc kind |
| G5 | Cut options | `direction`/`back` parity with extrude |
| G6 | Loft arbitrary planes | Optional plane per section |
| G7 | Extrude join mode | Optional `data.op: "join" \| "new"` (default preserve current replace for back-compat) |
| G8 | Sweep options | `SweepOptions` transition/mode |
| G9 | Multi-face draft | Loop Add() for faces[] |
| G10 | Ribbon loft/sweep | Selection-driven or status guidance (larger UX) |
| G11 | Linear pattern normalize | Unitize `dir` before scale |
| G12–G13 | Variable fillet / outward shell | Future capability expansions |

---

## Resolution log

| ID | Status | Notes |
|----|--------|-------|
| G1 | ✅ Fixed | `extrude` + `shifted` use try/finally; cleanup unit tests for null Shape / MakePrism throw / zero-height pre-check |
| G2 | ✅ Fixed | rebuild `ox/oy/oz`; featureUnits length params; AI schema; rebuild Pappus volume test |
| G3 | ✅ Fixed | sweep `data.plane` / activeSketch plane / XY fallback; schema + mm convert; rebuild XZ test |
| G4 | ✅ Fixed | `SpinePath` union: `polyline` \| `path` with line/arc segments; `buildSpineWire` + schema convert + unit tests |
| G5 | ✅ Fixed | cut supports `back`, `direction`, `directionEdge`; featureUnits + schema; two-sided pocket rebuild test |
| G6 | ✅ Fixed | loft sections accept optional `plane` (legacy `z` kept); schema + convert; rebuild test |
| G7 | ✅ Fixed | extrude `data.op: "join" \| "new"`; join unions pad with base; rebuild volume test |
| G8 | ✅ Fixed | `SweepOptions` mode/transition on kernel `sweep`; rebuild wires `data.mode` / `data.transition`; schema |
| G9 | ✅ Fixed | draft multi-face via sequential Apply; `draftFeature` stores `faces[]`; schema |
| G10 | ✅ Fixed | ribbon loft/sweep set status guidance for real authoring (demo data still for discoverability) |
| G11 | ✅ Fixed | `linearPattern` unitizes `dir`; non-unit dir test |
| G12 | ⏸ Deferred | Variable-radius fillet / two-distance chamfer remain future capability (documented; constant path solid) |
| G13 | ✅ Fixed | `ShellOptions.direction` inward/outward; rebuild + schema |
| G14 | ✅ Fixed | Misleading arc/spine comments corrected; missing rebuild tests added with G2/G3/G5/G6/G7 |

**Verification (2026-07-09):** `vitest` on action/*, spine, rebuild, featureUnits, registry, schema — **all green** (170+ tests in the targeted suites).
