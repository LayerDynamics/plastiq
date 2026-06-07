# Plan — In-Canvas Right-Click Context Menu (Plastiq r3f viewport)

**Date:** 2026-06-07
**Branch:** `feat/canvas-context-menu` (off `main`, staged commits, single PR at the end)
**Status:** Planned — awaiting execution

---

## 1. What this IS (product thesis)

A **right-click context menu inside the 3D viewport** that turns the canvas into the
primary command surface. Right-click anything — empty space, a face, an edge, a
vertex, a whole body, a feature, an assembly instance, or while a simulation is
running — and the menu surfaces **exactly the CAD actions applicable to that thing**
(context-filtered, not an undifferentiated dump), anchored at the 3D point you
clicked and tracking the camera as you orbit. It is the spatial twin of the existing
feature-tree right-click menu (`FeatureTree.tsx:215` `FeatureContextMenu`, FR-27),
and it must **reuse the same real store/dressup actions** the toolbar already calls —
never reimplement geometry.

The directory layout is the user's own (pre-created empty skeleton, 2026-06-07):

```text
apps/plastiq/src/three/contextmenu/
  config.ts                 # the action catalog — every possible option, each wired to its real fn
  contextSelection.ts       # pure: resolve "what was right-clicked" → ContextTarget
  contextOptions.ts         # pure: ContextTarget + catalog → ordered, filtered MenuSection[]
  contextMenuProvider.ts    # Zustand store: open/anchor/target/sections + openAt()/close()
  useCanvasRightClick.ts    # hook: contextmenu event → pick → select → resolve → open
apps/plastiq/src/three/gizmos/
  rightClickDropdown.gizmo.tsx  # renders the menu via drei <Html> at the world anchor
```

---

## 2. Locked decisions (from the user)

| Decision | Choice | Consequence |
|---|---|---|
| **Anchoring / render** | **World-anchored to the click point** | `<Html position={worldPoint}>` from `@react-three/drei` (confirmed installed: drei `10.7.7`, `Html` exported from `web/index.d.ts`). Default `transform={false}` → projects the world point to screen, renders a flat readable DOM menu that tracks orbit/zoom. |
| **Click ↔ selection** | **Select-then-menu (CAD-standard)** | Right-click an *unselected* entity → select it, then open its menu. Right-click *within* an existing multi-selection → preserve the whole selection (multi-edge Fillet / multi-face Shell still work). Right-click empty space → clear selection + show the global menu. |
| **Option semantics** | **Context-filtered** (committed, not asked) | Menu shows only actions valid for the target. "All possible options" = the *catalog* is exhaustive across all contexts; the *displayed* set is filtered to the selection. |
| **Scope** | **All contexts are in scope** (committed, not asked) | empty / face / edge / vertex / body / feature / sketch-entity / assembly-instance / simulation. We stage the *build*, never cut the *deliverable*. |

---

## 3. Two landmines locked into the design (advisor-flagged)

1. **`contextMenuProvider` is a Zustand store, NOT React Context.** React Context does
   not reliably cross the r3f `<Canvas>` reconciler boundary — a provider mounted
   above the Canvas would not reach a gizmo mounted inside `<Scene>`. A subscribable
   Zustand store (the codebase convention, cf. `store.ts`) is read by both
   `useCanvasRightClick` (on the canvas element) and the gizmo (inside the Canvas).

2. **A gizmo cannot return `<div>` JSX** — the r3f reconciler expects three.js
   objects. DOM-from-inside-Canvas must go through drei `<Html>` (chosen) — which
   internally portals to a DOM wrapper over the canvas. (The fallback,
   `createPortal(menu, document.body)`, is *not* used here since the user chose
   world-anchored tracking, which `<Html position>` gives for free.)

---

## 4. Module contract (the 6 files)

### 4.1 `contextSelection.ts` — pure resolver
```ts
export type ContextKind =
  | "empty" | "face" | "edge" | "vertex" | "body"
  | "feature" | "sketchEntity" | "assemblyInstance";

export interface ContextTarget {
  kind: ContextKind;
  picks: Pick[];                 // the effective selection the menu acts on
  selMode: SelectionMode;
  refs: SelectionRefs;           // for dressup builders (faces/edges)
  features: EditorFeature[];
  selectedFeatureId: FeatureId | null;
  inSketch: boolean;
  sketchSelection: string[];
  mateMode: boolean;
  simulating: boolean;
  hasProfile: boolean;           // gate extrude/cut/revolve (reuse the existing PR#20 predicate)
  instanceId: string | null;     // set when an assembly instance was clicked
  worldPoint: [number, number, number]; // drei <Html> anchor
}

/** Pure: reads store snapshots + the right-click pick result, returns the target. */
export function resolveContextTarget(input: {
  cad: CadStoreSnapshot;
  sketch: SketchStoreSnapshot;
  hit: { kind: SelectionMode | null; id: number | null; instanceId?: string } | null;
  worldPoint: [number, number, number];
}): ContextTarget;
```
- `kind` precedence: `inSketch` → `sketchEntity`/sketch context; else `instanceId` →
  `assemblyInstance`; else by `picks`/`selMode`; else `feature` if `selectedFeatureId`
  and no 3D picks; else `empty`.
- `hasProfile` reuses the exact gating logic that PR #20 added for Extrude/Cut/Revolve
  (find it in `Toolbar.tsx` ~217–237 / its helper) — **import it, don't re-derive**.

### 4.2 `config.ts` — the action catalog (exhaustive)
```ts
export type ActionGroup =
  | "create" | "modify" | "dressup" | "sketch"
  | "selection" | "view" | "assembly" | "sim" | "feature" | "danger";

export interface ContextAction {
  id: string;                              // stable, e.g. "extrude", "fillet"
  group: ActionGroup;
  label: (ctx: ContextTarget) => string;   // dynamic ("Suppress"/"Unsuppress")
  danger?: boolean;
  visible: (ctx: ContextTarget) => boolean; // belongs in this context at all
  enabled: (ctx: ContextTarget) => boolean; // precondition met
  run: (ctx: ContextTarget) => void;        // calls the REAL fn (see §5)
}

export const CONTEXT_ACTIONS: ContextAction[]; // every option, all contexts
```
Each `run` calls an existing function:
`useCadStore.getState().addFeature(...)`, `filletFeature(picks, refs, r)`,
`shellFeature(...)`, `draftFeature(...)`, `extrudeToFaceFeature(...)`,
`extrudeAlongEdgeFeature(...)`, `enterSketch(...)`, `removeFeature/toggleSuppress/
renameFeature`, `setSection/toggleMeasure`, `addInstance/removeInstance/
toggleInstanceFixed/setExplodeFactor/checkInterference`, `applyMate(...)`,
`setSimPaused/requestSimStep/requestSimRewind`, `clearPicks`, `__plastiqViewport.fitToView`.

### 4.3 `contextOptions.ts` — pure menu builder
```ts
export interface MenuItem { id: string; label: string; danger: boolean; enabled: boolean; }
export interface MenuSection { group: ActionGroup; items: MenuItem[]; }

/** Pure: filter by visible(ctx), group + order, resolve label + enabled. */
export function buildMenuSections(ctx: ContextTarget, catalog = CONTEXT_ACTIONS): MenuSection[];
```
Group order: `create → modify → dressup → sketch → assembly → sim → view →
selection → feature → danger`, dividers between non-empty groups.

### 4.4 `contextMenuProvider.ts` — Zustand store
```ts
interface ContextMenuStore {
  open: boolean;
  anchor: [number, number, number] | null;
  target: ContextTarget | null;
  sections: MenuSection[];
  openAt(target: ContextTarget, sections: MenuSection[]): void; // anchor = target.worldPoint
  close(): void;
  runAction(id: string): void; // looks up CONTEXT_ACTIONS, runs with target, then close()
}
export const useContextMenu = create<ContextMenuStore>(...);
```

### 4.5 `useCanvasRightClick.ts` — input wiring (inside Canvas)
- `useThree` → `gl`, `camera`, `controls`, `raycaster`, `invalidate`. **Must be mounted
  inside `<Scene>`** (the gizmo calls it).
- On `contextmenu` (gl.domElement): `e.preventDefault()`; NDC via the `ndcFrom` math
  copied from `Picking.tsx:139`; pick under cursor reusing `Picker` raycast +
  `GpuPicker` fallback for face/body (same as `Picking.tsx:220`); compute `worldPoint`
  = ray∩part (intersection) or ray∩(Z=0 grid plane), fallback `controls.target`.
- **Select-then-menu:** if hit and hit ∉ current picks → `store.pick(hit)` (replace);
  if hit ∈ existing multi-selection → keep selection; if empty → `store.clearPicks()`.
- Build `ContextTarget` (resolveContextTarget) → `buildMenuSections` → `openAt`.
- **Close triggers:** `Escape` (keydown), canvas `pointerdown` outside the menu,
  OrbitControls `"start"` event (orbit begins), and after any action runs.
- Returns nothing; side-effecting. Cleans up all listeners on unmount.

### 4.6 `rightClickDropdown.gizmo.tsx` — renderer
- Calls `useCanvasRightClick()` (input) and reads `useContextMenu` (state).
- `useGizmoPresence("rightClickDropdown", open)` → `__plastiqViewport.gizmos.rightClickDropdown`.
- When `open`, renders:
  ```tsx
  <Html position={anchor!} zIndexRange={[1000, 0]} wrapperClass="ctx-menu-wrap" pointerEvents="auto">
    <div data-testid="canvas-context-menu" role="menu"
         className="min-w-36 rounded border border-[#2a3444] bg-[#0e1219] py-1 shadow-lg">
      {sections.map(sec => <>
        {dividerIfNotFirst}
        {sec.items.map(it =>
          <button data-testid={`ctx-${it.id}`} disabled={!it.enabled}
            className={it.danger ? DANGER_ITEM : ITEM}
            onClick={() => useContextMenu.getState().runAction(it.id)}>
            {it.label}
          </button>)}
      </>)}
    </div>
  </Html>
  ```
- Style tokens mirror `FeatureContextMenu` exactly: `ITEM = "block w-full px-3 py-1
  text-left text-xs text-[#cfe] hover:bg-[#1f2a3a] disabled:opacity-40"`,
  `DANGER_ITEM = "... text-[#ff8a8a] hover:bg-[#2a1717]"`, divider
  `"my-1 border-t border-[#2a3444]"`. Selected/accent uses `SELECT_ORANGE #ffa23a`.

### 4.7 Integration points
- `Scene.tsx`: add `<RightClickDropdownGizmo />` after `<ViewCubeGizmo />` (line ~151),
  before `<SketchCamera />`. Export from `gizmos/index.ts` barrel.
- **Unify with FR-27:** the body/feature actions (rename, suppress, roll back, delete)
  come from the *same* `CONTEXT_ACTIONS` catalog; as a follow-up within this work,
  refactor `FeatureTree.tsx`'s `FeatureContextMenu` to consume the shared catalog so
  the two menus can't drift. (If refactor risks the FR-27 E2Es, keep FeatureTree as-is
  and only share the action `run` helpers — decide at C3.)

---

## 5. The full action catalog by context (the deliverable surface)

Every row reuses an existing function (file:line from exploration). Context-filtered.

| Context | Menu items (id) → real fn |
|---|---|
| **empty** | new-sketch-xy/xz/yz → `enterSketch`; section-toggle → `setSection`; measure → `toggleMeasure`; import-step → `addFeature({type:"importStep"})`; fit-view → `__plastiqViewport.fitToView`; (if picks) clear-selection → `clearPicks` |
| **face** (≥1) | sketch-on-face (1 face) → `enterSketch(...,model)`; shell → `shellFeature(picks,refs,t)`; draft → `draftFeature(picks,refs,a)`; extrude-to-face → `extrudeToFaceFeature(picks,refs)`; clear-selection |
| **edge** (≥1) | fillet → `filletFeature(picks,refs,r)`; chamfer → `chamferFeature(picks,refs,d)`; extrude-along-edge → `extrudeAlongEdgeFeature(picks,refs,h)`; clear-selection |
| **vertex** (≥1) | clear-selection (no vertex-specific ops exist today; catalog ready for future) |
| **body** | gizmo-mode-translate/rotate → `setGizmoMode`; set-placement → (open PropertiesPanel placement / `upsertPlacement`); suppress/delete owning feature → `toggleSuppress`/`removeFeature`; clear-selection |
| **profile present** | extrude → `addFeature({type:"extrude"})`; cut → `addFeature({type:"cut"})`; revolve → `addFeature({type:"revolve"})` (gated by `hasProfile`) |
| **feature** (tree sel) | edit-sketch → `editSketch`; rename → `renameFeature`; suppress/unsuppress → `toggleSuppress`; roll-back → `setRollback`; **delete** (danger) → `removeFeature` |
| **assemblyInstance** | toggle-fixed → `toggleInstanceFixed`; explode → `setExplodeFactor`; interference → `checkInterference`; **remove-instance** (danger) → `removeInstance` |
| **mateMode** | apply coincident/concentric/parallel/perpendicular/distance/angle → `applyMate(kind,...)`; cancel-mate-mode → `setMateMode(false)` |
| **simulating** | pause/resume → `setSimPaused`; step → `requestSimStep`; rewind → `requestSimRewind` |
| **sketchEntity** (in sketcher overlay) | constraints/dimensions/fix/delete → Sketcher store actions (see C4 note) |

---

## 6. Staged build (all contexts ship; only the build is staged)

- **C0 — Scaffold + open/close loop.** Zustand provider; `useCanvasRightClick`
  (preventDefault + pick + select-then-menu + worldPoint + openAt); gizmo renders a
  minimal menu via `<Html>`; registered in Scene + barrel. **Prove:** real right-click
  opens a menu at the 3D point; Escape / outside-click / orbit-start close it. 1 smoke E2E.
- **C1 — Pure core + unit tests.** `contextSelection.resolveContextTarget`,
  `contextOptions.buildMenuSections`, `config` catalog skeleton. Vitest unit tests:
  each `ContextKind` → expected item ids + enabled/disabled. (`*.test.ts` colocated.)
- **C2 — Geometry contexts wired.** empty / face / edge / vertex / body / profile-gated,
  reusing `dressup.ts` builders + `addFeature`. No-mock E2E per context: real
  right-click → click item → poll `__cadStore` feature count / new feature type.
- **C3 — Feature context + FR-27 unification.** rename/suppress/roll-back/delete via
  shared catalog; decide unify-vs-share-helpers for `FeatureTree`.
- **C4 — Sketch + assembly + sim contexts.** Sketch-entity menu: the Sketcher is an
  `absolute inset-0 z-10` overlay, so its right-click lands on the overlay, **not** the
  canvas — wire a sibling right-click handler in `Sketcher.tsx` that reuses the **same**
  `config`/`provider`/`contextOptions` modules (unified, not duplicated). Assembly +
  mate + simulation contexts on the canvas.
- **C5 — Polish + gate + PR.** Keyboard nav (↑/↓/Enter/Esc), `data-testid` coverage,
  vitest coverage exclude for the `<Html>`-render gizmo if WebGL-bound (mirror the
  `gpuPick.ts`/`colors.ts` excludes in `vitest.config.ts`), full sweep:
  typecheck + lint + build + unit + E2E green. Open PR.

---

## 7. Test strategy (repo rules: no-mock E2E + unit on pure logic)

- **Unit (vitest):** `contextSelection.test.ts`, `contextOptions.test.ts`,
  `config.test.ts` (spy that each `run` invokes the right store action). Pure — fast,
  deterministic, the bulk of coverage. Keeps the coverage gate (80/68/80/83) green.
- **E2E (Playwright, no-mock):** `e2e/plastiq/context-menu.spec.ts` — load app, wait
  `status=ready`, real `contextmenu` `PointerEvent` (`button: 2`) on `#viewport-root
  canvas` (after a real face pick), assert `getByTestId("canvas-context-menu")`
  visible, assert item testids match the context, click `ctx-<id>`, **poll
  `__cadStore.getState().features`** for the real added feature. Follows
  `pick-face.spec.ts` / `gizmos-store.spec.ts` conventions.
- **Seam:** `__plastiqViewport.gizmos.rightClickDropdown` (presence). Optional
  read-only `__plastiqContextMenu = { sectionsFor(): string[] }` for robust assertion
  of resolved items without depending on DOM layout.

---

## 8. Risks / watch-items

- **Empty-space anchor:** ray may miss all geometry and the grid — fall back to
  `controls.target` so `<Html position>` is always valid.
- **`<Html>` + `preserveDrawingBuffer`/screenshots:** Html portals to DOM, not the GL
  buffer, so it won't appear in canvas pixel screenshots — E2E must assert via DOM
  testids, not viewport screenshots. (Good; that's the no-mock convention anyway.)
- **Sketcher overlay** intercepts right-clicks (C4) — handle on the overlay, reuse modules.
- **FR-27 drift** — unify catalogs (C3) or the two menus diverge.
- **Coverage gate** — the gizmo's `<Html>` render path is WebGL/DOM-bound; exclude it
  like `gpuPick.ts` and keep all logic in the pure (tested) modules.

---

## 9. Definition of done

- Right-click in the viewport opens a world-anchored menu showing exactly the actions
  valid for the clicked target, across **all** contexts in §5.
- Every action runs the **real** existing function (no reimplementation, no stubs).
- Select-then-menu behavior matches §2; close on Esc/outside/orbit/action.
- `typecheck + lint + build + unit + E2E` all green; coverage gate holds; one PR off
  `main`.
