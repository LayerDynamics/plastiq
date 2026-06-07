# Plan — Fusion 360-style Workspaces for Plastiq

**Date:** 2026-06-07
**Branch:** `feat/workspaces` (off `main`, staged commits, PR at the end)
**Status:** Planned — awaiting execution

---

## 1. What this IS (product thesis)

Replace Plastiq's single horizontally-scrolling top toolbar with a **Fusion 360-style
workspace system**: a top-left **workspace switcher** that flips the editor between
**Design**, **Assemble**, and **Simulate** modes, and a **tabbed ribbon** that, for the
active workspace, shows only that mode's tools — split across **tabs** (e.g. Design →
SOLID · SKETCH · UTILITIES) and grouped into labelled **panels**. Because each
workspace + tab shows a small, relevant subset, the ribbon **fits the width without
horizontal scrolling** — which is the actual fix for the user's complaint ("the top
scrolling bar is not effective"). The current `Toolbar` (App.tsx:150–153, the
`overflow-x-auto` strip) is **dismantled and replaced**, not kept alongside.

This is faithful to Fusion's model (a switcher + per-workspace tabbed ribbon +
contextual tabs), scoped honestly to Plastiq's **real** capabilities.

---

## 2. Research — how Fusion 360 workspaces actually work

(Sources: Autodesk Fusion Help "Workspaces" GS-WORKSPACES / "Tab names" LP-TAB-LIST;
Symetri "Exploring the Workspaces"; Product Design Online UI overview.)

- **Workspaces** = top-level modes in a **top-left dropdown switcher** ("switch like
  browser tabs"; also reachable from the right-click radial). Full set: **Design,
  Generative Design, Render, Animation, Simulation, Manufacture, Drawing
  (from Design / from Animation), Electronics.**
- Each workspace **swaps the ribbon** to its own **tabs**; the **Design** workspace's
  tabs are **SOLID, SURFACE, MESH, SHEET METAL, PLASTIC, FORM, UTILITIES**. Each tab
  is a row of **panels** (CREATE / MODIFY / ASSEMBLE / INSPECT / …) of grouped tools.
- **Assembly is folded into Design** (not its own workspace) — components/joints live
  on Design's ASSEMBLE panel.
- **Contextual tabs/environments**: appear only when a command/mode is active — Create
  Sketch → a **SKETCH** contextual tab (sketch tools + constraints), with a
  **Finish Sketch** to leave; FORM (sculpt) is an enter/finish environment.

### What Plastiq adopts vs diverges
- **Adopt:** the switcher + per-workspace **tabbed ribbon with grouped panels** +
  **contextual SKETCH tab**.
- **Diverge (deliberate, stated):** Plastiq promotes **Assemble** to a *peer
  workspace* (its instance/mate/joint/explode/interference tools are a distinct flow)
  — Fusion folds it into Design; we do not. **Simulate** is a workspace (Fusion's
  Simulation is FEA; ours is the in-browser physics run — same "switch into an
  analysis mode" idea).
- **Excluded (no stubs):** Generative / Render / Manufacture / Drawing / Electronics —
  Plastiq has no such capability; building empty shells is forbidden by the project's
  no-stub rule. The switcher lists **only the three working workspaces.**

---

## 3. Locked decisions

| Decision | Choice | Source |
|---|---|---|
| **Tool surface** | **Fusion-style tabbed top ribbon** (switcher + per-workspace tabs + grouped panels). Fits without scroll because content is workspace+tab scoped. | user |
| **Workspace set** | **Design · Assemble · Simulate** — three real-capability workspaces, no inert/"coming soon" entries. | user |
| **Action registry** | One shared registry of action defs (`id, label, icon, enabled, run`); the context menu and the ribbon both consume it. **`visible` (context-menu membership) is split from ribbon placement** — the ribbon lists a panel's full toolset always and greys via `enabled`. | advisor |
| **Mode relationship** | A single `workspace` store field is the authority. `workspace==="simulate"` ⇔ `simulating` (switching drives `setSimulating`); **no third orthogonal mode**. Sketch stays a *contextual tab within Design* (sketch-`active` selects the SKETCH tab; workspace stays `design`). | advisor |
| **Toolbar** | The scrolling `Toolbar` is **replaced**. Every relocated control **keeps its existing `data-testid`** so the E2E suite stays green. | advisor + E2E audit |

---

## 4. Architecture

### 4.1 Workspace state (`store.ts`)
```ts
export type Workspace = "design" | "assemble" | "simulate";
// in CadStore:
workspace: Workspace;                 // default "design"
setWorkspace: (w: Workspace) => void; // sets simulating = (w === "simulate")
```
- `setWorkspace` is the **single authority** over sim mode: entering `simulate` calls
  the existing `setSimulating(true)` semantics; leaving calls `setSimulating(false)`.
  The standalone Simulate toggle button is removed (the workspace replaces it).
- Switching **out of a sketch** (the contextual env) finishes/cancels it first
  (guard: if `sketchStore.active`, the switcher calls `exitSketch()` or blocks with a
  hint — decided in C2).
- Persistence: `workspace` is **transient UI** (not part of `CadDocument`), like
  `selMode`/`section` — it is NOT serialized.

### 4.2 Shared action registry (the refactor the advisor flagged)
New `apps/plastiq/src/actions/registry.ts`:
```ts
export interface ActionDef {
  id: string;
  label: (ctx: ContextTarget) => string;   // dynamic (toggles)
  icon?: string;                            // glyph (FeatureTree ICONS style)
  enabled: (ctx: ContextTarget) => boolean;
  run: (ctx: ContextTarget) => void;        // calls the REAL store/dressup fn
}
export const ACTIONS: Record<string, ActionDef>;       // one def per action id
export function runAction(id, ctx): void;              // enabled-guarded (was config.runContextAction)
```
- Migrate the run/enabled/label logic currently in `three/contextmenu/config.ts` into
  `ACTIONS`. `contextmenu/config.ts` becomes **context-menu placement only**:
  `{ id, group, danger?, visible(ctx) }` referencing `ACTIONS[id]`.
- **Add the ribbon/toolbar-only ops missing from the catalog** (advisor #1): `loft`,
  `sweep`, `mirror`, `linearPattern`, `circularPattern`, `boolean`, `booleanBody`,
  `transform/move`, `pad`, `import-step`, `export-gltf/step/iges`, `undo`, `redo`,
  `selmode-{face,edge,vertex,body}`, `gizmo-{translate,rotate}`, `measure`,
  `section`, sim playback (`sim-pause/step/rewind`), `insert-instance`, mate/joint
  ops, `explode`, `check-interference`. Each wired to the real fn (mirroring
  `Toolbar.tsx`/`AssemblyTree.tsx` today).
- This keeps the context menu + ribbon from drifting (single `run`/`enabled`).

### 4.3 Ribbon config (`apps/plastiq/src/ribbon/ribbonConfig.ts`)
Declarative placement: workspace → tabs → panels → action ids.
```ts
interface Panel { title: string; actionIds: string[]; }
interface Tab { id: string; title: string; panels: Panel[]; contextual?: "sketch"; }
export const RIBBON: Record<Workspace, Tab[]>;
```
The ribbon renders `RIBBON[workspace]`; the active tab's panels show their actions;
each button is `disabled = !ACTIONS[id].enabled(ctx)` and `onClick = runAction(id, ctx)`.
Contextual tabs (`contextual:"sketch"`) are only present + auto-selected when
`sketchStore.active`.

### 4.4 Components (`apps/plastiq/src/ribbon/`)
- `WorkspaceSwitcher.tsx` — top-left dropdown (`data-testid="workspace-switcher"`,
  options `data-testid="ws-design|ws-assemble|ws-simulate"`), reads/sets `workspace`.
- `Ribbon.tsx` — renders switcher + tab strip + the active tab's panels; builds `ctx`
  via the existing `snapshotCad`/`snapshotSketch` + `resolveContextTarget` (no hit) so
  `enabled` matches the context menu exactly. **No `overflow-x-auto`** — panels wrap or
  the tab set is sized to fit; horizontal scroll is the failure mode we're removing.
- `RibbonButton.tsx` — icon+label button; carries the migrated `data-testid`.

### 4.5 App shell (`App.tsx`)
- Replace the `overflow-x-auto` `<Toolbar/>` row (150–153) with `<Ribbon/>` (+ keep
  `RecoveryBanner`). `ProjectsMenu` + status move into the ribbon's left cluster /
  stay in StatusBar.
- Side panels per workspace: Design → FeatureTree (+ properties); **Assemble** →
  AssemblyTree gets primary placement; Simulate → a sim-status/playback panel. The
  left/right `aside`s stay; their *contents* switch on `workspace`.

---

## 5. Workspace → tab → panel → tool map (all wired to real fns)

### Design (`workspace==="design"`)
| Tab | Panel → tools (action ids) |
|---|---|
| **SOLID** | CREATE: new-sketch, sketch-on-face, extrude, cut, revolve, loft, sweep · MODIFY: fillet, chamfer, shell, draft, extrude-to-face, extrude-along-edge, pad · COMBINE: mirror, linearPattern, circularPattern, boolean, booleanBody, transform · INSPECT: measure, section |
| **SKETCH** *(contextual — only while `sketchStore.active`)* | DRAW: line, rectangle, circle, arc, polygon, slot, spline, point · CONSTRAIN: (the `canApply` set) · DIMENSION: (the `canDimension` set) · EXIT: finish-sketch |
| **UTILITIES** | I/O: import-step, export-gltf, export-step, export-iges · EDIT: undo, redo |

### Assemble (`workspace==="assemble"`)
| Tab | Panel → tools |
|---|---|
| **ASSEMBLE** | COMPONENTS: insert-instance, toggle-fixed, remove-instance · RELATIONSHIPS: mate (coincident/concentric/parallel/perpendicular/distance/angle), joint kinds · POSITION: explode · INSPECT: check-interference, measure, section |

### Simulate (`workspace==="simulate"` ⇔ `simulating`)
| Tab | Panel → tools |
|---|---|
| **SIMULATE** | PLAYBACK: sim-pause, sim-step, sim-rewind · (entering the workspace starts the sim; leaving stops it) · INSPECT: measure |

Global cluster (always, near the switcher): selection-mode toggle (Face/Edge/Vertex/Body),
gizmo-mode (Move/Rotate), Projects menu — these are mode-independent.

---

## 6. Staging (Design first — it fixes the discoverability pain)

- **W0 — Action registry refactor.** Extract `ACTIONS` + `runAction`; repoint
  `contextmenu/config.ts` to reference it (context-menu still green). Add the missing
  ribbon-only action defs. Unit tests for the new defs' enabled/run. *No UI change yet.*
- **W1 — Workspace state + switcher + Ribbon shell.** `workspace` field + `setWorkspace`
  (sim sync); `WorkspaceSwitcher` + `Ribbon` rendering `RIBBON[workspace]`; mount in
  `App.tsx` **replacing** `Toolbar`. Carry **every** migrated `data-testid` forward
  (`enter-sketch`, `add-extrude/cut/revolve`, `sketch-on-face`, `sketch-plane`,
  `section-toggle/axis`, `measure-toggle`, `selmode`, `gizmomode`, `undo`, `redo`,
  `export-*`, `import-step`, `simulate`-playback, …). **Design workspace fully wired.**
- **W2 — SKETCH contextual tab.** Auto-present + auto-select while sketching; surface
  the sketch tools/constraints/dimensions (reuse `sketchStore`); `finish-sketch`.
  Decide: move the Sketcher overlay's own palette into the ribbon tab vs keep both
  (avoid duplicate palettes).
- **W3 — Assemble workspace.** AssembleTab tools (reuse `AssemblyTree`/store actions);
  promote AssemblyTree panel; switching guards (finish sketch first).
- **W4 — Simulate workspace.** Switcher drives `simulating`; SIMULATE tab playback;
  remove the old standalone Simulate toggle; sim panel.
- **W5 — Cleanup + gate + PR.** Delete `Toolbar.tsx` (and its now-dead helpers) once
  every control is migrated; ensure no `overflow-x-auto` on the ribbon; full gate +
  PR.

Delete `Toolbar.tsx` only at W5, after confirming each of its controls has a
testid-preserving home — never leave both surfaces mounted.

---

## 7. Testing

- **Unit (vitest):** `actions/registry` enabled/run per action (real store, like the
  existing `config.test`); `ribbonConfig` integrity (every referenced action id exists
  in `ACTIONS`; no dupes; contextual tabs flagged); `setWorkspace` ↔ `simulating` sync
  + sketch-exit guard. Coverage gate held (ribbon `.tsx` excluded; registry `.ts`
  measured + tested).
- **E2E (no-mock):**
  - **Existing suite stays green** via carried-forward testids (the bar: 0 regressions
    across the ~18 specs that click `enter-sketch`/`add-extrude`/`section-toggle`/…).
  - New `e2e/plastiq/workspaces.spec.ts`: switch Design→Assemble→Simulate via the
    switcher → assert the ribbon tabs/panels change (testids) and a tool from each
    runs (real feature added / sim starts); assert **the ribbon does not horizontally
    scroll** (`scrollWidth <= clientWidth` on the ribbon root) — the regression guard
    for the original complaint; assert the SKETCH contextual tab appears only while
    sketching.

---

## 8. Risks / watch-items

- **Two-mode boundary** (advisor #2): `workspace` vs `simulating`/sketch-active. Mitigation:
  `workspace` is the authority; `simulate`⇔`simulating`; sketch is a contextual tab,
  not a workspace. One source of truth; covered by a transition unit test.
- **Breaking the E2E suite** by moving controls. Mitigation: carry every `data-testid`
  forward; W5 deletes `Toolbar` only after parity. This is the "don't claim done while
  breaking 12 E2Es" guard.
- **Ribbon must actually fit** (the whole point). Mitigation: no `overflow-x-auto`;
  panels wrap; an E2E asserts no horizontal scroll.
- **Registry refactor destabilizing the just-merged context menu.** Mitigation: W0 is
  refactor-only with the context-menu unit + E2E suite as the safety net before any UI
  change.
- **Sketch palette duplication** (ribbon SKETCH tab vs Sketcher overlay palette).
  Mitigation: W2 explicitly decides move-vs-keep; don't ship two palettes.
- **`Fusion "Assemble" divergence`** — stated openly in §2 so the "like Fusion" premise
  isn't mis-cited.

---

## 9. Definition of done

- A top-left switcher flips Design / Assemble / Simulate; each shows a tabbed ribbon of
  grouped, context-aware tools that **fits without horizontal scrolling**.
- Every tool runs the **real** store/dress-up fn (shared registry; no reimplementation,
  no stubs); no empty/"coming soon" workspaces.
- SKETCH is a contextual tab; `simulate` is the sim mode; one authoritative `workspace`.
- The scrolling `Toolbar` is deleted; **existing E2E suite green** (carried testids) +
  new workspace E2E; typecheck/lint/build/coverage all green; one PR off `main`.

---

## Sources
- Autodesk Fusion Help — Workspaces (GS-WORKSPACES), Tab names (LP-TAB-LIST), Design tool list (LP-TOOL-LIST-DESIGN)
- Symetri — "Fusion 360 for Design & Manufacturing: Exploring the Workspaces"
- Product Design Online — "Fusion 360 New UI vs Old UI"
- ARKANCE Community — "Fusion 360 — Changing Workspaces"
