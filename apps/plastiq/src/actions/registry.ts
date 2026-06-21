// The shared action registry: one ActionDef per user action (id, label, enabled,
// run, optional icon/active). It is the single source of run/enabled/label logic
// for BOTH surfaces that present actions — the right-click context menu and the
// workspace ribbon. The context-menu's catalog (three/contextmenu/config.ts) is
// the home of the selection-driven actions; this registry re-exposes them as
// ActionDefs (dropping the menu-only `visible`/`group`) and ADDS the ribbon/toolbar
// ops that the context menu never had (loft, sweep, combine, I/O, undo/redo,
// selection mode, insert instance). The ribbon lists a panel's full tool set and
// greys via `enabled` — it never uses the context menu's `visible`.

import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { booleanBodyFeature, loftFeature, sweepFeature } from "../viewport/dressup.js";
import type { Profile } from "../sketch/profile.js";
import type { SelectionMode } from "../store/types.js";
import { CONTEXT_ACTIONS } from "../three/contextmenu/config.js";
import type { ContextTarget } from "../three/contextmenu/contextSelection.js";

/** A user action, surface-agnostic. `enabled`/`label` are evaluated against the
 * resolved ContextTarget; `run` performs the real side effect. */
export interface ActionDef {
  id: string;
  label: (ctx: ContextTarget) => string;
  /** Optional glyph for the ribbon button. */
  icon?: string;
  enabled: (ctx: ContextTarget) => boolean;
  run: (ctx: ContextTarget) => void;
  /** Optional toggle-active predicate (e.g. selection mode / section on) for the ribbon. */
  active?: (ctx: ContextTarget) => boolean;
}

const cad = (): ReturnType<typeof useCadStore.getState> => useCadStore.getState();
const always = (): boolean => true;

/** A rectangle inside the seeded box footprint, so an appended Extrude/Cut has a
 * profile to consume without opening the sketcher (the toolbar's demo "Sketch"). */
const DEFAULT_RECT: Profile = {
  kind: "loop",
  start: [0.015, 0.01],
  segments: [
    { kind: "line", to: [0.045, 0.01] },
    { kind: "line", to: [0.045, 0.03] },
    { kind: "line", to: [0.015, 0.03] },
  ],
};

/** A centred rectangle Profile (w × h) — the demo sections for loft/sweep, matching
 * Toolbar.tsx's existing defaults so behaviour is unchanged. */
function rectProfile(w: number, h: number): Profile {
  const hw = w / 2;
  const hh = h / 2;
  return {
    kind: "loop",
    start: [-hw, -hh],
    segments: [
      { kind: "line", to: [hw, -hh] },
      { kind: "line", to: [hw, hh] },
      { kind: "line", to: [-hw, hh] },
    ],
  };
}

/** Download a string export via the viewport's __plastiqExport seam (FR-42/43). */
async function exportFile(
  format: "gltf" | "step" | "iges",
  ext: string,
  mime: string,
  label: string,
): Promise<void> {
  const exporter = (
    globalThis as { __plastiqExport?: (f: "gltf" | "step" | "iges") => Promise<string> }
  ).__plastiqExport;
  if (!exporter) return;
  try {
    const content = await exporter(format);
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `part.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
    cad().setStatus(`exported ${label}`);
  } catch (e) {
    cad().setStatus(`export failed: ${(e as Error).message}`);
  }
}

/** Open a file picker and import the chosen STEP as a base body (FR-43). */
export function importStepFromDisk(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".step,.stp";
  input.onchange = (): void => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((step) => {
      cad().addFeature({ type: "importStep", name: file.name, data: { step } });
      cad().setStatus(`imported ${file.name}`);
    });
  };
  input.click();
}

const hasExporter = (): boolean =>
  typeof (globalThis as { __plastiqExport?: unknown }).__plastiqExport === "function";

// --- ribbon/toolbar-only actions (absent from the context-menu catalog) ---
// Each `run` is the exact call the current Toolbar/AssemblyTree make, so behaviour
// is preserved when the scrolling toolbar is replaced.
const RIBBON_ONLY: ActionDef[] = [
  // CREATE
  {
    id: "sketch-rect",
    label: () => "Sketch",
    icon: "✎",
    enabled: always,
    run: () => cad().addFeature({ type: "sketch", data: { profile: DEFAULT_RECT } }),
  },
  {
    id: "loft",
    label: () => "Loft",
    icon: "⬗",
    enabled: always,
    run: () =>
      cad().addFeature(
        loftFeature([
          { profile: rectProfile(0.04, 0.03), z: 0 },
          { profile: rectProfile(0.02, 0.015), z: 0.06 },
        ])!,
      ),
  },
  {
    id: "sweep",
    label: () => "Sweep",
    icon: "❧",
    enabled: always,
    run: () =>
      cad().addFeature(
        sweepFeature(rectProfile(0.01, 0.01), {
          kind: "polyline",
          points: [
            [0, 0, 0],
            [0, 0, 0.04],
            [0.03, 0, 0.07],
          ],
        }),
      ),
  },
  // COMBINE
  {
    id: "mirror",
    label: () => "Mirror",
    icon: "◫",
    enabled: always,
    run: () => cad().addFeature({ type: "mirror", params: { nx: 1, ox: 0, merge: 1 } }),
  },
  {
    id: "linearPattern",
    label: () => "Linear pattern",
    icon: "▤",
    enabled: always,
    run: () =>
      cad().addFeature({ type: "linearPattern", params: { dx: 1, spacing: 0.08, count: 3 } }),
  },
  {
    id: "circularPattern",
    label: () => "Circular pattern",
    icon: "❋",
    enabled: always,
    run: () =>
      cad().addFeature({ type: "circularPattern", params: { az: 1, count: 4, angle: Math.PI * 2 } }),
  },
  {
    id: "boolean",
    label: () => "Boolean (box)",
    icon: "⊕",
    enabled: always,
    run: () =>
      cad().addFeature({
        type: "boolean",
        params: { dx: 0.02, dy: 0.02, dz: 0.05, tx: 0.02, ty: 0.01, tz: 0 },
        data: { op: "subtract" },
      }),
  },
  {
    id: "booleanBody",
    label: () => "Subtract body",
    icon: "⊖",
    enabled: always,
    run: () =>
      cad().addFeature(
        booleanBodyFeature("subtract", [
          { type: "sketch", data: { profile: DEFAULT_RECT } },
          { type: "extrude", params: { height: 0.05 } },
        ]),
      ),
  },
  {
    id: "transform",
    label: () => "Move body",
    icon: "✥",
    enabled: always,
    run: () => cad().addFeature({ type: "transform", params: { tx: 0.02 } }),
  },
  // I/O
  {
    id: "import-step",
    label: () => "Import STEP",
    icon: "⤒",
    enabled: always,
    run: () => importStepFromDisk(),
  },
  {
    id: "export-gltf",
    label: () => "Export glTF",
    icon: "⤓",
    enabled: hasExporter,
    run: () => void exportFile("gltf", "gltf", "model/gltf+json", "glTF"),
  },
  {
    id: "export-step",
    label: () => "Export STEP",
    icon: "⤓",
    enabled: hasExporter,
    run: () => void exportFile("step", "step", "application/step", "STEP"),
  },
  {
    id: "export-iges",
    label: () => "Export IGES",
    icon: "⤓",
    enabled: hasExporter,
    run: () => void exportFile("iges", "iges", "application/iges", "IGES"),
  },
  // EDIT
  {
    id: "undo",
    label: () => "Undo",
    icon: "↶",
    enabled: () => cad().past.length > 0,
    run: () => cad().undo(),
  },
  {
    id: "redo",
    label: () => "Redo",
    icon: "↷",
    enabled: () => cad().future.length > 0,
    run: () => cad().redo(),
  },
  // SELECTION MODE
  ...(["face", "edge", "vertex", "body"] as const).map(
    (mode): ActionDef => ({
      id: `selmode-${mode}`,
      label: () => mode.charAt(0).toUpperCase() + mode.slice(1),
      enabled: always,
      active: (ctx) => ctx.selMode === (mode as SelectionMode),
      run: () => cad().setSelMode(mode),
    }),
  ),
  // ASSEMBLY (global)
  {
    id: "insert-instance",
    label: () => "Insert instance",
    icon: "⧉",
    enabled: always,
    run: () => cad().addInstance(),
  },
  {
    id: "mate-mode",
    label: (ctx) => (ctx.mateMode ? "Exit mate" : "Mate"),
    icon: "⚯",
    enabled: always,
    active: (ctx) => ctx.mateMode,
    // Enter/leave mate authoring; the two-pick + apply flow lives in AssemblyTree.
    run: (ctx) => cad().setMateMode(!ctx.mateMode),
  },
];

/** Re-expose each context-menu action as an ActionDef (drop menu-only fields,
 * keep the optional toggle-active predicate for ribbon highlighting). */
const CONTEXT_DEFS: Record<string, ActionDef> = Object.fromEntries(
  CONTEXT_ACTIONS.map((a) => [
    a.id,
    { id: a.id, label: a.label, enabled: a.enabled, run: a.run, active: a.active },
  ]),
);

/** True when a generated MESH document is open. In that mode the live document is a
 * triangle mesh, not a B-rep CadDocument, so B-rep feature operations and the parametric
 * STEP/IGES/glTF export are no-ops — SPEC-6 FR-18 requires the UI to reflect that rather
 * than offer them. (Mesh documents get their own GLB export in the GenerationPanel.) */
export const meshMode = (): boolean => useProjectsStore.getState().activeMeshDoc != null;

/** Actions that remain meaningful while a mesh document is open: editor-state only, not
 * B-rep feature operations. An ALLOWLIST (not a blocklist) so any action added later is
 * disabled in mesh mode by default — exactly the FR-18 "no silent no-op" guarantee. */
const MESH_SAFE_IDS: ReadonlySet<string> = new Set([
  "undo",
  "redo",
  "selmode-face",
  "selmode-edge",
  "selmode-vertex",
  "selmode-body",
]);

/** Augment a parametric/B-rep action so it is disabled while a mesh document is open. */
function gateForMeshMode(a: ActionDef): ActionDef {
  if (MESH_SAFE_IDS.has(a.id)) return a;
  const base = a.enabled;
  return { ...a, enabled: (ctx) => !meshMode() && base(ctx) };
}

/** Every action by id — context-menu actions + ribbon-only actions, each gated so B-rep
 * operations + parametric export are unavailable on a mesh document (FR-18). */
export const ACTIONS: Record<string, ActionDef> = Object.fromEntries(
  [...Object.values(CONTEXT_DEFS), ...RIBBON_ONLY].map((a) => {
    const gated = gateForMeshMode(a);
    return [gated.id, gated];
  }),
);

/** Run an action by id against a resolved target, honouring `enabled`. */
export function runAction(id: string, ctx: ContextTarget): void {
  const a = ACTIONS[id];
  if (a && a.enabled(ctx)) a.run(ctx);
}
