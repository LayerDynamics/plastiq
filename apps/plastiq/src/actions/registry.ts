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
import { useVoxelStore } from "../voxel/voxelStore.js";
import { assemblyToAssy, parseAssy, realizeAssembly } from "../assembly/assy.js";
import type { AssemblyModel } from "../assembly/model.js";
import { voxelDocToMesh } from "../voxel/doc.js";
import { voxelMeshToGlbBase64 } from "../voxel/glb.js";
import { exportMeshGlb } from "../mesh/exportGlb.js";
import type { EdgeRef, FaceRef } from "@plastiq/cad";
import {
  booleanBodyFeature,
  edgeRefsFromPicks,
  faceRefsFromPicks,
  loftFromSketchFeatures,
  sweepFromSketchFeature,
  sweepFromSketchAlongPickedEdges,
} from "../viewport/dressup.js";
import type { Profile } from "../sketch/profile.js";
import type { MeshDoc, SelectionMode } from "../store/types.js";
import { CONTEXT_ACTIONS } from "../three/contextmenu/config.js";
import type { ContextTarget } from "../three/contextmenu/contextSelection.js";
import { useSketchStore } from "../sketch/sketchStore.js";

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
const vox = (): ReturnType<typeof useVoxelStore.getState> => useVoxelStore.getState();
const always = (): boolean => true;

type V3 = [number, number, number];

/** Unit vector, or null if near-zero. */
function unit3(v: readonly [number, number, number]): V3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-12) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Edge tangent from the EdgeRef signature (n0 × n1). Valid for two planar faces
 * meeting at a straight edge — the same signature tessellation stores — so the
 * ribbon can bake direction without an OCCT round-trip (C6).
 */
function edgeDirectionFromRef(edge: EdgeRef): V3 | null {
  const [n0, n1] = edge.faceNormals;
  return unit3([
    n0[1] * n1[2] - n0[2] * n1[1],
    n0[2] * n1[0] - n0[0] * n1[2],
    n0[0] * n1[1] - n0[1] * n1[0],
  ]);
}

function faceOrigin(face: FaceRef, fallback: V3): V3 {
  const c = face.centroid;
  return c ? [c[0], c[1], c[2]] : fallback;
}

function edgeOrigin(edge: EdgeRef, fallback: V3): V3 {
  const m = edge.midpoint;
  return m ? [m[0], m[1], m[2]] : fallback;
}

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

/** Imports at/above this size get a status warning (never a block): the STEP
 * text is the import feature's source of truth, so it rides along in browser
 * storage — crash recovery keeps it as a single content-addressed payload
 * (persistence/recovery.ts, Review #13), and storage pressure can make that
 * payload (and hence the feature) unrecoverable until re-imported. Warn so the
 * user saves the project promptly. */
export const LARGE_IMPORT_WARN_BYTES = 8 * 1024 * 1024;

/** Status-line message for a completed STEP import — size-aware (FR-43). */
export function importStatusMessage(name: string, bytes: number): string {
  if (bytes < LARGE_IMPORT_WARN_BYTES) return `imported ${name}`;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return (
    `imported ${name} (${mb} MB) — large STEP: kept out of quick crash-recovery ` +
    `snapshots and stored once in browser storage; save your project to keep it safe`
  );
}

/** Open a file picker and import the chosen STEP as a base body (FR-43). A
 * large file is imported all the same, with a size warning on the status line
 * (recovery-snapshot implications — see LARGE_IMPORT_WARN_BYTES). */
export function importStepFromDisk(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".step,.stp";
  input.onchange = (): void => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((step) => {
      cad().addFeature({ type: "importStep", name: file.name, data: { step } });
      cad().setStatus(importStatusMessage(file.name, step.length));
    });
  };
  input.click();
}

/** Replace the live interactive assembly (the one AssemblyTree/BomSection read) with a
 * realized `.assy` model — the import path's store entry point (M4.5). Undoable: pushes
 * one history snapshot, mirroring store.ts `pushHistory` (same shape + its HISTORY_LIMIT
 * of 100). Transient assembly state (solve verdict, mate picks, joint drives,
 * interference results) is cleared — it described the replaced assembly. */
function loadAssemblyModel(model: AssemblyModel): void {
  useCadStore.setState((s) => ({
    past: [
      ...s.past,
      structuredClone({
        features: s.features,
        params: s.params,
        assembly: s.assembly,
        nextSeq: s.nextSeq,
        assemblyResult: s.assemblyResult,
      }),
    ].slice(-100),
    future: [],
    assembly: model,
    assemblyResult: null,
    matePicks: [],
    jointDrive: {},
    interferences: null,
  }));
}

/** Parse + realize `.assy` JSON text and load it as the live assembly — the read side
 * of the declarative `.assy` bridge (assembly/assy.ts). Any problem (bad JSON, schema
 * violations, sub-assembly cycles) surfaces on the status line and leaves the store
 * untouched. Exported so tests can drive the flow without the file picker. */
export function importAssyText(name: string, text: string): void {
  try {
    const model = realizeAssembly(parseAssy(JSON.parse(text)));
    loadAssemblyModel(model);
    cad().setStatus(`imported ${name}: ${model.instances.length} instance(s)`);
  } catch (e) {
    cad().setStatus(`import failed: ${(e as Error).message}`);
  }
}

/** Open a file picker and import the chosen `.assy` (JSON) document as the live
 * assembly. Mirrors importStepFromDisk's picker mechanism. */
export function importAssyFromDisk(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".assy,.json";
  input.onchange = (): void => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((text) => importAssyText(file.name, text));
  };
  input.click();
}

/** Download the live interactive assembly as a flat `.assy` JSON document
 * (assemblyToAssy — the write side of the bridge; re-importable via Import .assy). */
export function exportAssyFromStore(): void {
  const doc = assemblyToAssy(cad().assembly);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "assembly.assy";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
  cad().setStatus("exported assembly.assy");
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
    // Opens the sketcher (T13); sample rect remains as a separate discoverability path.
    enabled: always,
    run: () => {
      useSketchStore.getState().enterSketch("XY", 0);
      cad().setStatus("Sketch: draw a closed profile, then Finish");
    },
  },
  {
    id: "sample-rect",
    label: () => "Sample rect sketch",
    icon: "▭",
    enabled: always,
    run: () => {
      cad().addFeature({ type: "sketch", data: { profile: DEFAULT_RECT } });
      cad().setStatus("Sample rect sketch inserted");
    },
  },
  {
    id: "loft",
    label: () => "Loft",
    icon: "⬗",
    // Product path: last ≥2 finished sketches only — no demo frustum injector (C4).
    enabled: (ctx) => {
      void ctx;
      const n = cad().features.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      ).length;
      return n >= 2;
    },
    run: () => {
      const feats = cad().features;
      const sketchIds = feats
        .filter((f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null)
        .map((f) => f.id);
      if (sketchIds.length < 2) {
        cad().setStatus("Loft: finish ≥2 sketches first (no demo loft)");
        return;
      }
      const ids = sketchIds.slice(-2);
      const f = loftFromSketchFeatures(feats, ids);
      if (!f) {
        cad().setStatus("Loft: could not build from the last two sketches");
        return;
      }
      cad().addFeature(f);
      cad().setStatus(`Loft: from sketches ${ids.join(" + ")}`);
    },
  },
  {
    id: "sweep",
    label: () => "Sweep",
    icon: "❧",
    // Product path: last finished sketch as profile + path from selected edge when present (C4).
    // No hardcoded demo pipe.
    enabled: (ctx) => {
      void ctx;
      return cad().features.some(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
    },
    run: (ctx) => {
      const feats = cad().features;
      const sketches = feats.filter(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
      const last = sketches[sketches.length - 1];
      if (!last) {
        cad().setStatus("Sweep: finish a sketch profile first (no demo sweep)");
        return;
      }
      // Sweep along the PICKED edge chain when one is selected: the spine is
      // stored as persistent EdgeRefs and re-resolved every rebuild, so the pipe
      // follows those edges parametrically. With no edges picked, fall back to a
      // straight path along the profile plane's normal — a real, editable spine
      // (Properties → Path), not a canned elbow.
      const fromEdges = sweepFromSketchAlongPickedEdges(feats, last.id, ctx.picks, ctx.refs);
      if (fromEdges) {
        const n = ctx.picks.filter((p) => p.kind === "edge").length;
        cad().addFeature(fromEdges);
        cad().setStatus(
          `Sweep: profile from sketch ${last.id} along ${n} picked edge${n === 1 ? "" : "s"}`,
        );
        return;
      }
      const path = {
        kind: "polyline" as const,
        points: [
          [0, 0, 0],
          [0, 0, 0.04],
        ] as [number, number, number][],
      };
      const f = sweepFromSketchFeature(feats, last.id, path);
      if (!f) {
        cad().setStatus("Sweep: could not build from the last sketch");
        return;
      }
      cad().addFeature(f);
      cad().setStatus(
        `Sweep: profile from sketch ${last.id} along a default 40 mm path — pick edges first, or edit Properties → Path`,
      );
    },
  },
  // COMBINE — selection-driven plane / direction / axis when a face or edge is
  // picked (C6). Defaults stay sensible; status explains how to drive them.
  {
    id: "mirror",
    label: () => "Mirror",
    icon: "◫",
    enabled: always,
    run: (ctx) => {
      const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
      if (face) {
        const n = unit3(face.normal) ?? ([1, 0, 0] as V3);
        const o = faceOrigin(face, ctx.worldPoint);
        cad().addFeature({
          type: "mirror",
          params: {
            nx: n[0],
            ny: n[1],
            nz: n[2],
            ox: o[0],
            oy: o[1],
            oz: o[2],
            merge: 1,
          },
        });
        cad().setStatus("Mirror: plane from selected face normal + origin");
        return;
      }
      cad().addFeature({ type: "mirror", params: { nx: 1, ox: 0, merge: 1 } });
      cad().setStatus(
        "Mirror: default YZ plane at origin — select a face for its plane, then run Mirror again",
      );
    },
  },
  {
    id: "linearPattern",
    label: () => "Linear pattern",
    icon: "▤",
    enabled: always,
    run: (ctx) => {
      const edge = edgeRefsFromPicks(ctx.picks, ctx.refs)[0];
      const dir = edge ? edgeDirectionFromRef(edge) : null;
      if (dir) {
        cad().addFeature({
          type: "linearPattern",
          params: { dx: dir[0], dy: dir[1], dz: dir[2], spacing: 0.08, count: 3 },
        });
        cad().setStatus(
          "Linear pattern: direction from selected edge — edit spacing/count in Properties",
        );
        return;
      }
      cad().addFeature({ type: "linearPattern", params: { dx: 1, spacing: 0.08, count: 3 } });
      cad().setStatus(
        "Linear pattern: default +X — select an edge for direction, then run Linear pattern again",
      );
    },
  },
  {
    id: "circularPattern",
    label: () => "Circular pattern",
    icon: "❋",
    enabled: always,
    run: (ctx) => {
      const edge = edgeRefsFromPicks(ctx.picks, ctx.refs)[0];
      const edgeDir = edge ? edgeDirectionFromRef(edge) : null;
      if (edge && edgeDir) {
        const o = edgeOrigin(edge, ctx.worldPoint);
        cad().addFeature({
          type: "circularPattern",
          params: {
            ax: edgeDir[0],
            ay: edgeDir[1],
            az: edgeDir[2],
            ox: o[0],
            oy: o[1],
            oz: o[2],
            count: 4,
            angle: Math.PI * 2,
          },
        });
        cad().setStatus(
          "Circular pattern: axis from selected edge — edit count/angle in Properties",
        );
        return;
      }
      const face = faceRefsFromPicks(ctx.picks, ctx.refs)[0];
      if (face) {
        const n = unit3(face.normal) ?? ([0, 0, 1] as V3);
        const o = faceOrigin(face, ctx.worldPoint);
        cad().addFeature({
          type: "circularPattern",
          params: {
            ax: n[0],
            ay: n[1],
            az: n[2],
            ox: o[0],
            oy: o[1],
            oz: o[2],
            count: 4,
            angle: Math.PI * 2,
          },
        });
        cad().setStatus(
          "Circular pattern: axis = selected face normal through face point — edit count/angle in Properties",
        );
        return;
      }
      cad().addFeature({
        type: "circularPattern",
        params: { az: 1, count: 4, angle: Math.PI * 2 },
      });
      cad().setStatus(
        "Circular pattern: default Z axis — select an edge (axis) or face (normal), then re-run",
      );
    },
  },
  {
    // Primary boolean authoring: tool = last finished sketch extruded (user geometry), not a
    // fixed demo box. Requires ≥1 sketch + an existing body (C5).
    id: "booleanBody",
    label: () => "Subtract last sketch",
    icon: "⊖",
    enabled: () => {
      const s = cad();
      const hasSketch = s.features.some(
        (f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null,
      );
      const hasBody = s.features.some(
        (f) =>
          !f.suppressed &&
          (f.type === "box" ||
            f.type === "extrude" ||
            f.type === "revolve" ||
            f.type === "loft" ||
            f.type === "sweep" ||
            f.type === "importStep"),
      );
      return hasSketch && hasBody;
    },
    run: () => {
      const feats = cad().features;
      const lastSketch = [...feats]
        .reverse()
        .find((f) => f.type === "sketch" && !f.suppressed && f.data?.["profile"] != null);
      if (!lastSketch) {
        cad().setStatus("Subtract: finish a sketch for the tool profile first");
        return;
      }
      const depth =
        typeof lastSketch.params?.["depth"] === "number" ? (lastSketch.params["depth"] as number) : 0.05;
      cad().addFeature(
        booleanBodyFeature("subtract", [
          { type: "sketch", data: { ...lastSketch.data, profile: lastSketch.data!["profile"] } },
          { type: "extrude", params: { height: depth > 0 ? depth : 0.05 }, data: { op: "new" } },
        ]),
      );
      cad().setStatus(`Subtract: tool from sketch ${lastSketch.id}`);
    },
  },
  {
    id: "transform",
    label: () => "Move body",
    icon: "✥",
    enabled: always,
    // Opens the placement gizmo — not a transform feature (C7).
    run: () => {
      cad().setGizmoMode("translate");
      cad().setStatus("Move: drag the gizmo — placement writes on release");
    },
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
  // EDIT — routed: while a voxel sculpt is open its edit history is the live one
  // (the parametric history still exists underneath but is not what Undo means then).
  {
    id: "undo",
    label: () => "Undo",
    icon: "↶",
    enabled: () => (voxelMode() ? vox().past.length > 0 : cad().past.length > 0),
    run: () => (voxelMode() ? vox().undo() : cad().undo()),
  },
  {
    id: "redo",
    label: () => "Redo",
    icon: "↷",
    enabled: () => (voxelMode() ? vox().future.length > 0 : cad().future.length > 0),
    run: () => (voxelMode() ? vox().redo() : cad().redo()),
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
  // Declarative `.assy` interchange (M4.5): import parses + realizes a JSON document
  // into the live assembly; export downloads the live assembly back out (assy.ts).
  {
    id: "import-assy",
    label: () => "Import .assy",
    icon: "⤒",
    enabled: always,
    run: () => importAssyFromDisk(),
  },
  {
    id: "export-assy",
    label: () => "Export .assy",
    icon: "⤓",
    // Nothing to export until the assembly has at least one instance (matches
    // BomSection's gating on the same store slice).
    enabled: () => cad().assembly.instances.length > 0,
    run: () => exportAssyFromStore(),
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

// --- Voxel-sculpt actions (ADR-0010 wiring) ------------------------------------
// The Sculpt workspace's tool set. All voxel-scoped `enabled` predicates read the
// voxel store directly (like meshMode below); the sidebar/topbar subscribe to it so
// greying/highlighting stay live.

/** Stage the open sculpt's SURFACE mesh as a mesh document — the exact `MeshDoc`
 * shape the AI panel's MeshConvertSection consumes — so "Convert to CAD (STEP)"
 * runs the SAME mesh→B-rep reconstruct path a generated mesh uses (ADR-0010).
 * Mirrors that section's own post-convert behaviour: the staged doc is a fresh
 * UNTITLED document; the original voxel project is left untouched on disk. */
function stageVoxelForConvert(): void {
  const doc = vox().doc;
  if (!doc || doc.cells.length === 0) return;
  const glb = voxelMeshToGlbBase64(voxelDocToMesh(doc));
  const name = doc.name ?? useProjectsStore.getState().currentName;
  const meshDoc: MeshDoc = { kind: "mesh", name, glb, source: { mode: "voxel", providerId: "voxel-sculpt" } };
  vox().close();
  useProjectsStore.setState({
    activeMeshDoc: meshDoc,
    currentId: null,
    currentName: name,
    status: "sculpt surface staged as a mesh — run “Convert to CAD (STEP)” in the AI panel",
  });
  cad().setWorkspace("design"); // the mesh view + convert panel live outside Sculpt
}

const VOXEL_ACTIONS: ActionDef[] = [
  {
    id: "voxel-new",
    label: () => "New Sculpt",
    icon: "⬚",
    // The Sculpt entry point: always available outside mesh mode (the doc-mode gate
    // below disables it there); in voxel mode it starts a fresh untitled sculpt.
    enabled: always,
    run: () => useProjectsStore.getState().newVoxelProject(),
  },
  {
    id: "voxel-add",
    label: () => "Add voxels",
    icon: "⊞",
    enabled: () => voxelMode(),
    active: () => voxelMode() && vox().tool === "add",
    run: () => vox().setTool("add"),
  },
  {
    id: "voxel-erase",
    label: () => "Erase voxels",
    icon: "⊟",
    enabled: () => voxelMode(),
    active: () => voxelMode() && vox().tool === "erase",
    run: () => vox().setTool("erase"),
  },
  {
    id: "voxel-convert-cad",
    label: () => "Convert to CAD",
    icon: "⇄",
    enabled: () => voxelMode() && (vox().doc?.cells.length ?? 0) > 0,
    run: () => stageVoxelForConvert(),
  },
  {
    id: "voxel-export-glb",
    label: () => "Export GLB",
    icon: "⤓",
    enabled: () => voxelMode() && (vox().doc?.cells.length ?? 0) > 0,
    run: () => {
      const doc = vox().doc;
      if (!doc || doc.cells.length === 0) return;
      const file = exportMeshGlb(voxelMeshToGlbBase64(voxelDocToMesh(doc)), doc.name ?? "sculpt");
      cad().setStatus(`exported ${file}`);
    },
  },
];

/** True when a generated MESH document is open. In that mode the live document is a
 * triangle mesh, not a B-rep CadDocument, so B-rep feature operations and the parametric
 * STEP/IGES/glTF export are no-ops — SPEC-6 FR-18 requires the UI to reflect that rather
 * than offer them. (Mesh documents get their own GLB export in the GenerationPanel.) */
export const meshMode = (): boolean => useProjectsStore.getState().activeMeshDoc != null;

/** True when a voxel sculpt is open (ADR-0010). Like mesh mode, the live document is
 * not a B-rep CadDocument, so B-rep ops are disabled-not-hidden (FR-18); the
 * voxel-legal set (sculpt tools, surface-mesh export, Convert-to-CAD) stays live. */
export const voxelMode = (): boolean => useVoxelStore.getState().doc != null;

/** True when a dense point-cloud document is open (SPEC-13). The live document is neither a B-rep nor
 * a mesh, so B-rep/mesh ops are disabled-not-hidden (FR-18); only the editor-state set (and, once
 * added, the cloud→mesh / completion hand-offs) stays live. */
export const pointCloudMode = (): boolean => useProjectsStore.getState().activePointCloudDoc != null;

/** Actions that remain meaningful while a mesh document is open: editor-state (undo/redo,
 * selection mode) AND the mesh→CAD conversions that CONSUME the open mesh (reconstruct to
 * B-rep, fit NURBS surfaces) — those are enabled precisely in mesh mode, so gateForDocMode
 * must not force-disable them there (their own `enabled` already gates on an open MeshDoc).
 * Everything else is a B-rep feature op. An ALLOWLIST (not a blocklist) so any action added
 * later is disabled in mesh mode by default — exactly the FR-18 "no silent no-op" guarantee. */
const MESH_SAFE_IDS: ReadonlySet<string> = new Set([
  "undo",
  "redo",
  "selmode-face",
  "selmode-edge",
  "selmode-vertex",
  "selmode-body",
  "ml-reconstruct-brep",
  "ml-fit-nurbs",
]);

/** Actions that remain meaningful while a voxel sculpt is open: the mesh-safe
 * editor-state set plus the voxel tool set itself. Same allowlist discipline. */
const VOXEL_SAFE_IDS: ReadonlySet<string> = new Set([
  ...MESH_SAFE_IDS,
  "voxel-new",
  "voxel-add",
  "voxel-erase",
  "voxel-convert-cad",
  "voxel-export-glb",
]);

/** Actions that remain meaningful while a dense point cloud is open (SPEC-13): editor-state (undo/redo,
 * selection mode) AND the cloud→mesh / completion hand-offs that CONSUME the open cloud (their own
 * `enabled` gates on an open PointCloudDoc, so gateForDocMode must not force-disable them here).
 * Deliberately NOT the mesh→CAD conversions — those need an open MESH, not a cloud. Same allowlist
 * discipline: anything not listed is disabled in cloud mode (FR-18, no silent no-op). */
const POINTCLOUD_SAFE_IDS: ReadonlySet<string> = new Set([
  "undo",
  "redo",
  "selmode-face",
  "selmode-edge",
  "selmode-vertex",
  "selmode-body",
  "cloud-to-mesh",
  "cloud-complete",
]);

/** Augment an action so it is disabled while a document mode it doesn't apply to is
 * open: B-rep/parametric ops grey out on a mesh document, a voxel sculpt, AND a point
 * cloud; the voxel tools grey out on a mesh/cloud document (their own `enabled` already
 * scopes them). Each mode is an independent allowlist conjunct. */
function gateForDocMode(a: ActionDef): ActionDef {
  const meshSafe = MESH_SAFE_IDS.has(a.id);
  const voxelSafe = VOXEL_SAFE_IDS.has(a.id);
  const cloudSafe = POINTCLOUD_SAFE_IDS.has(a.id);
  if (meshSafe && voxelSafe && cloudSafe) return a;
  const base = a.enabled;
  return {
    ...a,
    enabled: (ctx) =>
      (meshSafe || !meshMode()) &&
      (voxelSafe || !voxelMode()) &&
      (cloudSafe || !pointCloudMode()) &&
      base(ctx),
  };
}

/** Every action by id — context-menu actions + ribbon-only ops + the voxel tool set,
 * each gated so operations that don't apply to the open document KIND are unavailable
 * (disabled, never hidden or silently no-oping — FR-18). */
export const ACTIONS: Record<string, ActionDef> = Object.fromEntries(
  [...Object.values(CONTEXT_DEFS), ...RIBBON_ONLY, ...VOXEL_ACTIONS].map((a) => {
    const gated = gateForDocMode(a);
    return [gated.id, gated];
  }),
);

/** Run an action by id against a resolved target, honouring `enabled`. */
export function runAction(id: string, ctx: ContextTarget): void {
  const a = ACTIONS[id];
  if (a && a.enabled(ctx)) a.run(ctx);
}
