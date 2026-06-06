// Top toolbar (SPEC-5 FR-4/FR-9). Hosts the selection-mode toggle (which entity
// kind the viewport picks) and the live selection count. Feature/sketch/export
// tools are wired in later milestones.

import { useState } from "react";
import { useCadStore } from "../store/store.js";
import type { NewFeature } from "../store/store.js";
import type { SelectionMode } from "../store/types.js";
import { SIM_TICK_RATE_HZ } from "../sim/simulator.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import { emptySketch, type DatumPlaneId, type SketchModel } from "../sketch/model.js";
import type { Profile } from "../sketch/profile.js";
import {
  booleanBodyFeature,
  chamferFeature,
  draftFeature,
  extrudeAlongEdgeFeature,
  extrudeToFaceFeature,
  extrudeTwoSidedFeature,
  filletFeature,
  loftFeature,
  shellFeature,
  sweepFeature,
} from "../viewport/dressup.js";
import { ProjectsMenu } from "./ProjectsMenu.js";

const MODES: { mode: SelectionMode; label: string; key: string }[] = [
  { mode: "face", label: "Face", key: "1" },
  { mode: "edge", label: "Edge", key: "2" },
  { mode: "vertex", label: "Vertex", key: "3" },
  { mode: "body", label: "Body", key: "4" },
];

function SelectionModeToggle(): React.JSX.Element {
  const selMode = useCadStore((s) => s.selMode);
  const setSelMode = useCadStore((s) => s.setSelMode);
  return (
    <div
      role="group"
      aria-label="Selection mode"
      data-testid="selmode"
      className="flex overflow-hidden rounded border border-[#2a3444]"
    >
      {MODES.map(({ mode, label, key }) => {
        const active = selMode === mode;
        return (
          <button
            key={mode}
            type="button"
            title={`${label} select (${key})`}
            data-mode={mode}
            aria-pressed={active}
            onClick={() => setSelMode(mode)}
            className={`px-2.5 py-1 text-xs transition-colors ${
              active ? "bg-[#4ea1ff] text-black" : "bg-transparent text-[#9ab] hover:bg-[#1b2230]"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const GIZMO_MODES: { mode: "translate" | "rotate"; label: string }[] = [
  { mode: "translate", label: "Move" },
  { mode: "rotate", label: "Rotate" },
];

function GizmoModeToggle(): React.JSX.Element {
  const gizmoMode = useCadStore((s) => s.gizmoMode);
  const setGizmoMode = useCadStore((s) => s.setGizmoMode);
  return (
    <div
      role="group"
      aria-label="Transform mode"
      data-testid="gizmomode"
      className="flex overflow-hidden rounded border border-[#2a3444]"
    >
      {GIZMO_MODES.map(({ mode, label }) => {
        const active = gizmoMode === mode;
        return (
          <button
            key={mode}
            type="button"
            data-mode={mode}
            aria-pressed={active}
            onClick={() => setGizmoMode(mode)}
            className={`px-2.5 py-1 text-xs transition-colors ${
              active ? "bg-[#ffa23a] text-black" : "bg-transparent text-[#9ab] hover:bg-[#1b2230]"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// A default rectangle profile inside the seeded box footprint, so an appended
// Extrude/Cut has something to consume without opening the sketcher.
const DEFAULT_RECT: Profile = {
  kind: "loop",
  start: [0.015, 0.01],
  segments: [
    { kind: "line", to: [0.045, 0.01] },
    { kind: "line", to: [0.045, 0.03] },
    { kind: "line", to: [0.015, 0.03] },
  ],
};

function FeatureMenu(): React.JSX.Element {
  const addFeature = useCadStore((s) => s.addFeature);
  const enterSketch = useSketchStore((s) => s.enterSketch);
  const solverReady = useSketchStore((s) => s.solverReady);
  // The plane + offset (mm) the next New Sketch opens on — no longer always XY.
  const [plane, setPlane] = useState<DatumPlaneId>("XY");
  const [offsetMm, setOffsetMm] = useState("0");
  // "Sketch on face": enabled when exactly one face is selected (its FaceRef known).
  const picks = useCadStore((s) => s.picks);
  const selectionRefs = useCadStore((s) => s.selectionRefs);
  const faceRef =
    picks.length === 1 && picks[0]?.kind === "face"
      ? selectionRefs.faces[picks[0].id]
      : undefined;
  const sketchOnFace = (): void => {
    if (!faceRef) return;
    const offset = (Number(offsetMm) || 0) / 1000;
    // Seed the empty sketch with the picked face; the plane id is then a placeholder.
    const model: SketchModel = { ...emptySketch("XY", offset), face: faceRef };
    enterSketch("XY", offset, undefined, model);
  };
  // Extrude/Cut/Revolve consume an upstream sketch profile. Gate them on one
  // existing, else clicking them appends a feature that hard-fails the whole
  // rebuild ("no sketch profile upstream") and poisons every later rebuild.
  const features = useCadStore((s) => s.features);
  const hasProfile = features.some(
    (f) =>
      f.type === "sketch" &&
      !f.suppressed &&
      (f.data?.["profile"] != null || f.data?.["model"] != null),
  );
  const btn = "rounded px-1.5 py-0.5 text-xs text-[#9ab] hover:bg-[#1b2230]";
  const btnDisabled = "rounded px-1.5 py-0.5 text-xs text-[#445] cursor-not-allowed";
  return (
    <div
      data-testid="feature-menu"
      className="flex items-center gap-0.5 rounded border border-[#2a3444] px-1"
    >
      <span className="px-1 text-[10px] uppercase text-[#567]">Add</span>
      <select
        data-testid="sketch-plane"
        value={plane}
        onChange={(e) => setPlane(e.currentTarget.value as DatumPlaneId)}
        title="Plane the new sketch is drawn on"
        className="rounded border border-[#2a3444] bg-[#0e1219] px-1 py-0.5 text-[11px] text-[#cfe]"
      >
        <option value="XY">XY</option>
        <option value="XZ">XZ</option>
        <option value="YZ">YZ</option>
      </select>
      <input
        type="number"
        step="any"
        data-testid="sketch-offset"
        value={offsetMm}
        onChange={(e) => setOffsetMm(e.currentTarget.value)}
        title="Offset along the plane normal (mm)"
        className="w-14 rounded border border-[#2a3444] bg-[#0e1219] px-1 py-0.5 text-right text-[11px] text-[#cfe]"
      />
      <span className="text-[10px] text-[#567]">mm</span>
      <button
        type="button"
        className={solverReady ? btn : btnDisabled}
        data-testid="enter-sketch"
        disabled={!solverReady}
        title={
          solverReady
            ? `Open the 2D sketch editor on the ${plane} plane`
            : "Loading sketch solver…"
        }
        onClick={() => enterSketch(plane, (Number(offsetMm) || 0) / 1000)}
      >
        New Sketch
      </button>
      <button
        type="button"
        className={solverReady && faceRef ? btn : btnDisabled}
        data-testid="sketch-on-face"
        disabled={!solverReady || !faceRef}
        title={
          !solverReady
            ? "Loading sketch solver…"
            : faceRef
              ? "Sketch on the selected face (offset along its normal)"
              : "Select a single face first"
        }
        onClick={sketchOnFace}
      >
        On Face
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => addFeature({ type: "sketch", data: { profile: DEFAULT_RECT } })}
      >
        Sketch
      </button>
      <button
        type="button"
        className={hasProfile ? btn : btnDisabled}
        data-testid="add-extrude"
        disabled={!hasProfile}
        title={hasProfile ? "Extrude the active sketch profile" : "Draw & Finish a sketch first"}
        onClick={() => addFeature({ type: "extrude", params: { height: 0.02 } })}
      >
        Extrude
      </button>
      <button
        type="button"
        className={hasProfile ? btn : btnDisabled}
        data-testid="add-cut"
        disabled={!hasProfile}
        title={hasProfile ? "Cut with the active sketch profile" : "Draw & Finish a sketch first"}
        onClick={() => addFeature({ type: "cut", params: { depth: 0.05 } })}
      >
        Cut
      </button>
      <button
        type="button"
        className={hasProfile ? btn : btnDisabled}
        data-testid="add-revolve"
        disabled={!hasProfile}
        title={hasProfile ? "Revolve the active sketch profile" : "Draw & Finish a sketch first"}
        onClick={() => addFeature({ type: "revolve", params: { angle: Math.PI * 2, ay: 1 } })}
      >
        Revolve
      </button>
      <button
        type="button"
        className={btn}
        title="Loft between two stacked rectangular sections"
        onClick={() =>
          addFeature(
            loftFeature([
              { profile: rectProfile(0.04, 0.03), z: 0 },
              { profile: rectProfile(0.02, 0.015), z: 0.06 },
            ])!,
          )
        }
      >
        Loft
      </button>
      <button
        type="button"
        className={btn}
        title="Sweep a small square profile along an L-shaped path"
        onClick={() =>
          addFeature(
            sweepFeature(rectProfile(0.01, 0.01), {
              kind: "polyline",
              points: [
                [0, 0, 0],
                [0, 0, 0.04],
                [0.03, 0, 0.07],
              ],
            }),
          )
        }
      >
        Sweep
      </button>
    </div>
  );
}

/** A centred rectangle Profile (w × h), for default loft/sweep sections. */
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

// Default dress-up sizes (SI metres / radians).
const FILLET_R = 0.003;
const CHAMFER_D = 0.003;
const SHELL_T = 0.002;
const DRAFT_A = (5 * Math.PI) / 180;

function DressUpMenu(): React.JSX.Element {
  const picks = useCadStore((s) => s.picks);
  const refs = useCadStore((s) => s.selectionRefs);
  const addFeature = useCadStore((s) => s.addFeature);
  const setStatus = useCadStore((s) => s.setStatus);

  const edgeCount = picks.filter((p) => p.kind === "edge").length;
  const faceCount = picks.filter((p) => p.kind === "face").length;
  // A builder returns null when the current selection can't be turned into the
  // feature (e.g. picked edges/faces didn't resolve). Surface that instead of
  // silently doing nothing (CADStudio.md §5.5).
  const apply = (f: NewFeature | null, what: string): void => {
    if (f) addFeature(f);
    else setStatus(`${what}: select the edges/faces it needs first`);
  };
  const btn =
    "rounded px-1.5 py-0.5 text-xs text-[#9ab] enabled:hover:bg-[#1b2230] disabled:opacity-40";

  return (
    <div
      data-testid="dressup-menu"
      className="flex items-center gap-0.5 rounded border border-[#2a3444] px-1"
    >
      <span className="px-1 text-[10px] uppercase text-[#567]">Modify</span>
      <button
        type="button"
        className={btn}
        disabled={edgeCount === 0}
        title="Fillet selected edges"
        onClick={() => apply(filletFeature(picks, refs, FILLET_R), "Fillet")}
      >
        Fillet
      </button>
      <button
        type="button"
        className={btn}
        disabled={edgeCount === 0}
        title="Chamfer selected edges"
        onClick={() => apply(chamferFeature(picks, refs, CHAMFER_D), "Chamfer")}
      >
        Chamfer
      </button>
      <button
        type="button"
        className={btn}
        disabled={faceCount === 0}
        title="Shell, opening selected faces"
        onClick={() => apply(shellFeature(picks, refs, SHELL_T), "Shell")}
      >
        Shell
      </button>
      <button
        type="button"
        className={btn}
        disabled={faceCount === 0}
        title="Draft the selected face"
        onClick={() => apply(draftFeature(picks, refs, DRAFT_A), "Draft")}
      >
        Draft
      </button>
      <button
        type="button"
        className={btn}
        title="Two-sided pad of the active profile"
        onClick={() => apply(extrudeTwoSidedFeature(0.02, 0.02), "Pad")}
      >
        Pad±
      </button>
      <button
        type="button"
        className={btn}
        disabled={faceCount === 0}
        title="Extrude the active profile up to the selected face"
        onClick={() => apply(extrudeToFaceFeature(picks, refs), "Extrude to face")}
      >
        Ext→Face
      </button>
      <button
        type="button"
        className={btn}
        disabled={edgeCount === 0}
        title="Extrude the active profile along the selected edge"
        onClick={() => apply(extrudeAlongEdgeFeature(picks, refs, 0.02), "Extrude along edge")}
      >
        Ext∥Edge
      </button>
    </div>
  );
}

function CombineMenu(): React.JSX.Element {
  const addFeature = useCadStore((s) => s.addFeature);
  const btn = "rounded px-1.5 py-0.5 text-xs text-[#9ab] hover:bg-[#1b2230]";
  return (
    <div
      data-testid="combine-menu"
      className="flex items-center gap-0.5 rounded border border-[#2a3444] px-1"
    >
      <span className="px-1 text-[10px] uppercase text-[#567]">Combine</span>
      <button
        type="button"
        className={btn}
        title="Mirror across the YZ plane and merge"
        onClick={() => addFeature({ type: "mirror", params: { nx: 1, ox: 0, merge: 1 } })}
      >
        Mirror
      </button>
      <button
        type="button"
        className={btn}
        title="Linear pattern along X"
        onClick={() =>
          addFeature({ type: "linearPattern", params: { dx: 1, spacing: 0.08, count: 3 } })
        }
      >
        Pattern
      </button>
      <button
        type="button"
        className={btn}
        title="Circular pattern about Z (full turn)"
        onClick={() =>
          addFeature({
            type: "circularPattern",
            params: { az: 1, count: 4, angle: Math.PI * 2 },
          })
        }
      >
        Circular
      </button>
      <button
        type="button"
        className={btn}
        title="Subtract a box tool"
        onClick={() =>
          addFeature({
            type: "boolean",
            params: { dx: 0.02, dy: 0.02, dz: 0.05, tx: 0.02, ty: 0.01, tz: 0 },
            data: { op: "subtract" },
          })
        }
      >
        Boolean
      </button>
      <button
        type="button"
        className={btn}
        title="Subtract a second modelled body (a pad) from the base"
        onClick={() =>
          addFeature(
            booleanBodyFeature("subtract", [
              { type: "sketch", data: { profile: DEFAULT_RECT } },
              { type: "extrude", params: { height: 0.05 } },
            ]),
          )
        }
      >
        Body⊖
      </button>
      <button
        type="button"
        className={btn}
        title="Translate the body 20 mm in X (baked)"
        onClick={() => addFeature({ type: "transform", params: { tx: 0.02 } })}
      >
        Move
      </button>
    </div>
  );
}

function UndoRedo(): React.JSX.Element {
  const canUndo = useCadStore((s) => s.past.length > 0);
  const canRedo = useCadStore((s) => s.future.length > 0);
  const undo = useCadStore((s) => s.undo);
  const redo = useCadStore((s) => s.redo);
  const btn =
    "rounded border border-[#2a3444] px-2 py-1 text-xs text-[#9ab] enabled:hover:bg-[#1b2230] disabled:opacity-40";
  return (
    <div className="flex gap-1">
      <button
        type="button"
        data-testid="undo"
        onClick={undo}
        disabled={!canUndo}
        className={btn}
        title="Undo (⌘Z)"
      >
        ↶
      </button>
      <button
        type="button"
        data-testid="redo"
        onClick={redo}
        disabled={!canRedo}
        className={btn}
        title="Redo (⇧⌘Z)"
      >
        ↷
      </button>
    </div>
  );
}

const EXPORTS: { format: "gltf" | "step" | "iges"; label: string; ext: string; mime: string }[] = [
  { format: "gltf", label: "glTF", ext: "gltf", mime: "model/gltf+json" },
  { format: "step", label: "STEP", ext: "step", mime: "application/step" },
  { format: "iges", label: "IGES", ext: "iges", mime: "application/iges" },
];

/** Interchange export (M6.2/M6.3, FR-42/FR-43) + STEP import as a base body. */
function InterchangeMenu(): React.JSX.Element {
  const addFeature = useCadStore((s) => s.addFeature);
  const setStatus = useCadStore((s) => s.setStatus);
  const btn = "rounded px-1.5 py-0.5 text-xs text-[#9ab] hover:bg-[#1b2230]";

  const onExport = async (fmt: (typeof EXPORTS)[number]): Promise<void> => {
    const exporter = (
      globalThis as { __plastiqExport?: (f: "gltf" | "step" | "iges") => Promise<string> }
    ).__plastiqExport;
    if (!exporter) return;
    try {
      const content = await exporter(fmt.format);
      const blob = new Blob([content], { type: fmt.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `part.${fmt.ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);
      setStatus(`exported ${fmt.label}`);
    } catch (e) {
      setStatus(`export failed: ${(e as Error).message}`);
    }
  };

  const onImport = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    void file.text().then((step) => {
      addFeature({ type: "importStep", name: file.name, data: { step } });
      setStatus(`imported ${file.name}`);
    });
  };

  return (
    <div
      data-testid="interchange-menu"
      className="flex items-center gap-0.5 rounded border border-[#2a3444] px-1"
    >
      <span className="px-1 text-[10px] uppercase text-[#567]">I/O</span>
      {EXPORTS.map((f) => (
        <button
          key={f.format}
          type="button"
          data-testid={`export-${f.format}`}
          className={btn}
          onClick={() => void onExport(f)}
        >
          {f.label}
        </button>
      ))}
      <label className={`${btn} cursor-pointer`} title="Import a STEP file as a base body">
        Import
        <input
          type="file"
          accept=".step,.stp"
          data-testid="import-step"
          className="hidden"
          onChange={onImport}
        />
      </label>
    </div>
  );
}

function SimulateToggle(): React.JSX.Element {
  const simulating = useCadStore((s) => s.simulating);
  const setSimulating = useCadStore((s) => s.setSimulating);
  return (
    <button
      type="button"
      data-testid="simulate-toggle"
      aria-pressed={simulating}
      onClick={() => setSimulating(!simulating)}
      className={`rounded border px-2 py-1 text-xs ${
        simulating
          ? "border-[#7a2b2b] bg-[#3a1414] text-[#ffb3b3]"
          : "border-[#3a6b3a] bg-[#1c2a14] text-[#cfe6a0] hover:bg-[#24341a]"
      }`}
      title={simulating ? "Stop the simulation and return to edit" : "Drop/run the part in the sim"}
    >
      {simulating ? "■ Stop" : "▶ Simulate"}
    </button>
  );
}

/** Playback controls (FR-41), shown only while simulating: pause/resume, step one
 * frame (while paused), rewind to the start, and the elapsed sim-time readout. */
function SimPlayback(): React.JSX.Element | null {
  const simulating = useCadStore((s) => s.simulating);
  const paused = useCadStore((s) => s.simPaused);
  const simTicks = useCadStore((s) => s.simTicks);
  const setSimPaused = useCadStore((s) => s.setSimPaused);
  const requestSimStep = useCadStore((s) => s.requestSimStep);
  const requestSimRewind = useCadStore((s) => s.requestSimRewind);
  if (!simulating) return null;
  const btn =
    "rounded border border-[#2a3444] px-1.5 py-1 text-xs text-[#cfe] enabled:hover:bg-[#1b2230] disabled:opacity-30";
  return (
    <div data-testid="sim-playback" className="flex items-center gap-1">
      <button
        type="button"
        data-testid="sim-pause"
        aria-pressed={paused}
        onClick={() => setSimPaused(!paused)}
        className={btn}
        title={paused ? "Resume" : "Pause"}
      >
        {paused ? "▶" : "❚❚"}
      </button>
      <button
        type="button"
        data-testid="sim-step"
        disabled={!paused}
        onClick={requestSimStep}
        className={btn}
        title="Step one frame forward (while paused)"
      >
        ⏭
      </button>
      <button
        type="button"
        data-testid="sim-rewind"
        onClick={requestSimRewind}
        className={btn}
        title="Rewind to the start"
      >
        ⏮
      </button>
      <span data-testid="sim-time" className="tabular-nums text-[11px] text-[#9ab]">
        {(simTicks / SIM_TICK_RATE_HZ).toFixed(2)}s
      </span>
    </div>
  );
}

/** Section view (FR-14): toggle a clip plane that cuts the model so the user can
 * see inside; when on, choose the axis and slide the cut position (0..1 of the
 * model's extent along that axis). */
function SectionControl(): React.JSX.Element {
  const section = useCadStore((s) => s.section);
  const setSection = useCadStore((s) => s.setSection);
  const on = section != null;
  const axis = section?.axis ?? "x";
  const t = section?.t ?? 0.5;
  return (
    <div data-testid="section-control" className="flex items-center gap-1">
      <button
        type="button"
        data-testid="section-toggle"
        aria-pressed={on}
        onClick={() => setSection(on ? null : { axis: "x", t: 0.5 })}
        className={`rounded border px-2 py-1 text-xs ${
          on
            ? "border-[#4ea1ff] bg-[#13243a] text-[#bfe0ff]"
            : "border-[#2a3444] text-[#9ab] hover:bg-[#1b2230]"
        }`}
        title="Section view: clip the model with a plane to see inside"
      >
        ⌗ Section
      </button>
      {on && (
        <>
          <select
            data-testid="section-axis"
            value={axis}
            onChange={(e) => setSection({ axis: e.currentTarget.value as "x" | "y" | "z", t })}
            className="rounded border border-[#2a3444] bg-[#0e1219] px-1 py-0.5 text-[11px] text-[#cfe]"
            title="Cut axis"
          >
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </select>
          <input
            type="range"
            data-testid="section-offset"
            min={0}
            max={1}
            step={0.01}
            value={t}
            onChange={(e) => setSection({ axis, t: Number(e.currentTarget.value) })}
            className="w-20"
            title="Cut position"
          />
        </>
      )}
    </div>
  );
}

export function Toolbar(): React.JSX.Element {
  const pickCount = useCadStore((s) => s.picks.length);
  const clearPicks = useCadStore((s) => s.clearPicks);
  const measuring = useCadStore((s) => s.measuring);
  const toggleMeasure = useCadStore((s) => s.toggleMeasure);
  return (
    <header
      role="toolbar"
      aria-label="Editor toolbar"
      className="flex items-center gap-3 border-b border-[#222a36] bg-black/40 px-3 py-2"
    >
      <span className="text-sm font-bold text-[#dfe]">Plastiq</span>
      <div className="mx-1 h-4 w-px bg-[#2a3444]" />
      <ProjectsMenu />
      <div className="mx-1 h-4 w-px bg-[#2a3444]" />
      <UndoRedo />
      <FeatureMenu />
      <DressUpMenu />
      <CombineMenu />
      <InterchangeMenu />
      <SimulateToggle />
      <SimPlayback />
      <SelectionModeToggle />
      <GizmoModeToggle />
      <button
        type="button"
        data-testid="measure-toggle"
        aria-pressed={measuring}
        onClick={toggleMeasure}
        className={`rounded border border-[#2a3444] px-2 py-1 text-xs ${
          measuring ? "bg-[#ffd34a] text-black" : "text-[#9ab] hover:bg-[#1b2230]"
        }`}
        title="Measure: click two points"
      >
        Measure
      </button>
      <SectionControl />
      <button
        type="button"
        onClick={clearPicks}
        disabled={pickCount === 0}
        className="rounded border border-[#2a3444] px-2 py-1 text-xs text-[#9ab] enabled:hover:bg-[#1b2230] disabled:opacity-40"
        title="Clear selection (Esc)"
      >
        Clear
      </button>
    </header>
  );
}
