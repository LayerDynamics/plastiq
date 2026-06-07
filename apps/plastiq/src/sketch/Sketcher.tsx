// The 2D sketch overlay (SPEC-5 M3.1/M3.2). An SVG surface over the 3D viewport,
// shown while a sketch is active: plane grid, origin, X/Y axes, the drawn
// entities, with wheel-zoom (at cursor) and drag-pan. Drawing tools place
// line/rectangle/circle geometry; inference (M3.3), constraints (M3.4) and
// dimensions (M3.5) render into this same SVG. SVG (not three.js) gives crisp
// text and trivial hit-testing for selectable glyphs.

import { useEffect, useRef, useState } from "react";
import { useSketchStore, type SketchTool } from "./sketchStore.js";
import { circumcircle, type SketchModel } from "./model.js";
import { catmullRomPoints } from "./spline2d.js";
import { nearestSnap, segmentHint, type SegHint, type Snap } from "./infer.js";
import { canApply, hitTest, type ConstraintKind } from "./hit.js";
import { canDimension, type DimensionKind } from "./dim.js";
import { extractProfile } from "./profile.js";
import { useCadStore } from "../store/store.js";
import { resolveContextTarget, type ContextTarget } from "../three/contextmenu/contextSelection.js";
import { buildMenuSections, type MenuSection } from "../three/contextmenu/contextOptions.js";
import { runContextAction } from "../three/contextmenu/config.js";
import { snapshotCad, snapshotSketch } from "../three/contextmenu/snapshot.js";
import { ContextMenuView } from "../three/contextmenu/ContextMenuView.js";
import {
  centeredView,
  gridStep,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
  type Px,
  type View2D,
} from "./transform2d.js";

function GridAndAxes({ view, w, h }: { view: View2D; w: number; h: number }): React.JSX.Element {
  const step = gridStep(view.scale);
  const lines: React.JSX.Element[] = [];
  // World bounds of the viewport corners.
  const left = (0 - view.panX) / view.scale;
  const right = (w - view.panX) / view.scale;
  const top = -(0 - view.panY) / view.scale;
  const bottom = -(h - view.panY) / view.scale;
  const u0 = Math.floor(Math.min(left, right) / step) * step;
  const u1 = Math.ceil(Math.max(left, right) / step) * step;
  const v0 = Math.floor(Math.min(top, bottom) / step) * step;
  const v1 = Math.ceil(Math.max(top, bottom) / step) * step;

  for (let u = u0; u <= u1 + step / 2; u += step) {
    const x = u * view.scale + view.panX;
    lines.push(
      <line
        key={`gx${u.toFixed(6)}`}
        x1={x}
        y1={0}
        x2={x}
        y2={h}
        stroke="#1b2230"
        strokeWidth={1}
      />,
    );
  }
  for (let v = v0; v <= v1 + step / 2; v += step) {
    const y = -v * view.scale + view.panY;
    lines.push(
      <line
        key={`gy${v.toFixed(6)}`}
        x1={0}
        y1={y}
        x2={w}
        y2={y}
        stroke="#1b2230"
        strokeWidth={1}
      />,
    );
  }

  const o = toScreen(view, { u: 0, v: 0 });
  return (
    <g>
      {lines}
      {/* X axis (red) + Y axis (green) through the origin. */}
      <line x1={0} y1={o.y} x2={w} y2={o.y} stroke="#7a2b2b" strokeWidth={1.5} />
      <line x1={o.x} y1={0} x2={o.x} y2={h} stroke="#2b6b3a" strokeWidth={1.5} />
      <circle cx={o.x} cy={o.y} r={4} fill="#ffd34a" />
    </g>
  );
}

/** Three-state solver colour (FR-20): under = blue, well = green, over = red. */
export function verdictColor(verdict: string | undefined): string {
  if (verdict === "well-constrained") return "#6be675";
  if (verdict === "over-constrained") return "#ff6b6b";
  return "#4ea1ff"; // under-constrained (or not yet solved) → draggable blue
}

type Pt = { x: number; y: number };

/**
 * Tessellate the arc through three screen-space points (a → through → b) into an
 * SVG polyline points string. Falls back to the straight chord when the points
 * are collinear. Purely for display — the kernel builds the true arc edge.
 */
function arcPolyline(a: Pt, through: Pt, b: Pt): string {
  const cc = circumcircle([a.x, a.y], [b.x, b.y], [through.x, through.y]);
  if (!cc) return `${a.x},${a.y} ${b.x},${b.y}`;
  const { u: cx, v: cy, r } = cc;
  const ang = (p: Pt): number => Math.atan2(p.y - cy, p.x - cx);
  const norm = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = ang(a);
  const dAB = norm(ang(b) - a0);
  const dAT = norm(ang(through) - a0);
  const ccw = dAT < dAB; // does `through` lie on the CCW arc from a to b?
  const span = ccw ? dAB : dAB - 2 * Math.PI;
  const N = 40;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = a0 + (span * i) / N;
    pts.push(`${(cx + r * Math.cos(t)).toFixed(2)},${(cy + r * Math.sin(t)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** The drawn sketch entities (lines, arcs, circles, points) in screen space. */
function SketchGeometry({
  model,
  view,
  selection,
  baseColor,
}: {
  model: SketchModel;
  view: View2D;
  selection: readonly string[];
  baseColor: string;
}): React.JSX.Element {
  const sel = new Set(selection);
  const pt = (id: string): { x: number; y: number } | null => {
    const p = model.points.find((q) => q.id === id);
    return p ? toScreen(view, { u: p.u, v: p.v }) : null;
  };
  const strokeOf = (e: { construction?: boolean; id: string }): string =>
    sel.has(e.id) ? "#ffd34a" : e.construction ? "#5a6b86" : baseColor;
  return (
    <g>
      {model.entities.map((e) => {
        const dash = e.construction ? "4 3" : undefined;
        const stroke = strokeOf(e);
        const width = sel.has(e.id) ? 2.5 : 1.75;
        if (e.kind === "line") {
          const a = pt(e.a);
          const b = pt(e.b);
          if (!a || !b) return null;
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={stroke}
              strokeWidth={width}
              strokeDasharray={dash}
            />
          );
        }
        if (e.kind === "arc") {
          const a = pt(e.a);
          const b = pt(e.b);
          const t = pt(e.through);
          if (!a || !b || !t) return null;
          return (
            <polyline
              key={e.id}
              points={arcPolyline(a, t, b)}
              fill="none"
              stroke={stroke}
              strokeWidth={width}
              strokeDasharray={dash}
            />
          );
        }
        if (e.kind === "spline") {
          const pts = e.points.map(pt);
          if (!pts.every((p): p is { x: number; y: number } => p !== null) || pts.length < 2) {
            return null;
          }
          return (
            <polyline
              key={e.id}
              points={catmullRomPoints(pts)
                .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
                .join(" ")}
              fill="none"
              stroke={stroke}
              strokeWidth={width}
              strokeDasharray={dash}
            />
          );
        }
        const c = pt(e.center);
        if (!c) return null;
        return (
          <circle
            key={e.id}
            cx={c.x}
            cy={c.y}
            r={e.radius * view.scale}
            fill="none"
            stroke={stroke}
            strokeWidth={width}
            strokeDasharray={dash}
          />
        );
      })}
      {model.points.map((p) => {
        const s = toScreen(view, { u: p.u, v: p.v });
        const r = sel.has(p.id) ? 4 : 2.5;
        return (
          <circle
            key={p.id}
            cx={s.x}
            cy={s.y}
            r={r}
            fill={sel.has(p.id) ? "#ffd34a" : p.fixed ? "#ff8a3a" : baseColor}
          />
        );
      })}
    </g>
  );
}

const MM = 1000;
const DEG = 180 / Math.PI;

/** Inline editor for a dimension's value (mm for length, ° for angle). FR-19. */
function DimensionEditor({
  id,
  model,
  onSet,
  onClose,
}: {
  id: string;
  model: SketchModel;
  onSet: (id: string, value: number) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const c = model.constraints.find((x) => x.id === id);
  if (!c || !("value" in c)) return null;
  const isAngle = c.kind === "angle";
  const factor = isAngle ? DEG : MM;
  const unitLabel: Record<string, string> = {
    angle: "angle (°)",
    radius: "radius (mm)",
    diameter: "diameter (mm)",
    hDistance: "Δx (mm)",
    vDistance: "Δy (mm)",
    distance: "length (mm)",
  };
  return (
    <div className="absolute left-2 top-[5.5rem] z-30 flex items-center gap-1 rounded border border-[#4ea1ff] bg-black/80 px-2 py-1 text-xs text-[#cfe]">
      <span className="text-[#789]">{unitLabel[c.kind] ?? "length (mm)"}</span>
      <input
        data-testid="dim-input"
        type="number"
        step="any"
        autoFocus
        defaultValue={Number((c.value * factor).toFixed(4))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = Number(e.currentTarget.value);
            if (Number.isFinite(v)) onSet(id, v / factor);
            onClose();
          } else if (e.key === "Escape") onClose();
        }}
        onBlur={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v)) onSet(id, v / factor);
          onClose();
        }}
        className="w-24 rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-right text-[#cfe] outline-none"
      />
    </div>
  );
}

/** Selectable, deletable constraint glyphs (FR-18/FR-19). Click removes; a valued
 * (dimension) glyph shows its value and double-click edits it. */
function ConstraintGlyphs({
  model,
  view,
  onDelete,
  onEdit,
}: {
  model: SketchModel;
  view: View2D;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
}): React.JSX.Element {
  const screen = (id: string): { x: number; y: number } | null => {
    const p = model.points.find((q) => q.id === id);
    return p ? toScreen(view, { u: p.u, v: p.v }) : null;
  };
  const lineMid = (lineId: string): { x: number; y: number } | null => {
    const l = model.entities.find((e) => e.id === lineId && e.kind === "line");
    if (!l || l.kind !== "line") return null;
    const a = screen(l.a);
    const b = screen(l.b);
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  };
  const circleCenter = (circleId: string): { x: number; y: number } | null => {
    const e = model.entities.find((x) => x.id === circleId && x.kind === "circle");
    return e && e.kind === "circle" ? screen(e.center) : null;
  };
  const GLYPH: Record<string, string> = {
    horizontal: "H",
    vertical: "V",
    coincident: "•",
    parallel: "∥",
    perpendicular: "⟂",
    equalLength: "=",
    concentric: "◎",
    tangent: "T",
    midpoint: "M",
    pointOnObject: "○",
    symmetric: "S",
  };
  /** Label for a valued (dimension) constraint, in display units. Driven
   * (reference) dimensions are parenthesised. */
  const dimLabel = (c: SketchModel["constraints"][number]): string | null => {
    const mm = (v: number): string => (Math.abs(v) * MM).toFixed(1);
    let base: string | null = null;
    if (c.kind === "distance") base = mm(c.value);
    else if (c.kind === "hDistance") base = `↔${mm(c.value)}`;
    else if (c.kind === "vDistance") base = `↕${mm(c.value)}`;
    else if (c.kind === "radius") base = `R${mm(c.value)}`;
    else if (c.kind === "diameter") base = `⌀${mm(c.value)}`;
    else if (c.kind === "angle") base = `${(c.value * DEG).toFixed(1)}°`;
    if (base === null) return null;
    return "driven" in c && c.driven ? `(${base})` : base;
  };
  return (
    <g>
      {model.constraints.map((c) => {
        const at =
          "line" in c
            ? lineMid(c.line)
            : "line1" in c
              ? lineMid(c.line1)
              : "circle1" in c
                ? circleCenter(c.circle1)
                : "circle" in c
                  ? circleCenter(c.circle)
                  : "point" in c
                    ? screen(c.point)
                    : "a" in c
                      ? screen(c.a)
                      : null;
        if (!at) return null;
        const label = dimLabel(c);
        const isDim = label !== null;
        // Driven (reference) dimensions are read-only — their value is computed
        // by other constraints, so a click can only delete, never edit.
        const driven = "driven" in c && c.driven === true;
        const w = isDim ? Math.max(28, label.length * 7 + 8) : 14;
        return (
          <g
            key={c.id}
            data-testid={isDim ? "dimension-glyph" : "constraint-glyph"}
            transform={`translate(${at.x + 8 + w / 2}, ${at.y - 8})`}
            style={{ cursor: "pointer" }}
            onPointerDown={(e) => {
              e.stopPropagation();
              // Dimension: click edits (unless driven), Shift-click deletes.
              // Constraint: click deletes.
              if (isDim && !e.shiftKey && !driven) onEdit(c.id);
              else onDelete(c.id);
            }}
          >
            <rect
              x={-w / 2}
              y={-9}
              width={w}
              height={14}
              rx={2}
              fill={isDim ? "#1c2a14" : "#11202e"}
              stroke={isDim ? "#7a9a3a" : "#3a6ea5"}
            />
            <text
              x={0}
              y={2}
              fill={isDim ? "#cfe6a0" : "#9fd0ff"}
              fontSize={10}
              fontFamily="monospace"
              textAnchor="middle"
            >
              {label ?? GLYPH[c.kind] ?? "?"}
            </text>
          </g>
        );
      })}
    </g>
  );
}

const TOOLS: { tool: SketchTool; label: string }[] = [
  { tool: "select", label: "Select" },
  { tool: "line", label: "Line" },
  { tool: "rectangle", label: "Rect" },
  { tool: "rectCenter", label: "Rect◉" },
  { tool: "circle", label: "Circle" },
  { tool: "circle3", label: "Circle3" },
  { tool: "arc3", label: "Arc3" },
  { tool: "arcCenter", label: "Arc◉" },
  { tool: "polygon", label: "Poly" },
  { tool: "slot", label: "Slot" },
  { tool: "spline", label: "Spline" },
  { tool: "point", label: "Point" },
];

export function Sketcher(): React.JSX.Element | null {
  const active = useSketchStore((s) => s.active);
  const view = useSketchStore((s) => s.view);
  const setView = useSketchStore((s) => s.setView);
  const exitSketch = useSketchStore((s) => s.exitSketch);
  const plane = useSketchStore((s) => s.model.plane);
  const model = useSketchStore((s) => s.model);
  const tool = useSketchStore((s) => s.tool);
  const setTool = useSketchStore((s) => s.setTool);
  const construction = useSketchStore((s) => s.construction);
  const setConstruction = useSketchStore((s) => s.setConstruction);
  const polygonSides = useSketchStore((s) => s.polygonSides);
  const setPolygonSides = useSketchStore((s) => s.setPolygonSides);
  const clickAt = useSketchStore((s) => s.clickAt);
  const cancelGesture = useSketchStore((s) => s.cancelGesture);
  const finishGesture = useSketchStore((s) => s.finishGesture);
  const pending = useSketchStore((s) => s.pending);
  const selection = useSketchStore((s) => s.selection);
  const setSelection = useSketchStore((s) => s.setSelection);
  const toggleSelect = useSketchStore((s) => s.toggleSelect);
  const applyConstraint = useSketchStore((s) => s.applyConstraint);
  const removeConstraint = useSketchStore((s) => s.removeConstraint);
  const addDimension = useSketchStore((s) => s.addDimension);
  const editingDim = useSketchStore((s) => s.editingDim);
  const setConstraintValue = useSketchStore((s) => s.setConstraintValue);
  const setEditingDim = useSketchStore((s) => s.setEditingDim);
  const result = useSketchStore((s) => s.result);
  const movePoint = useSketchStore((s) => s.movePoint);
  const solve = useSketchStore((s) => s.solve);
  const editingFeatureId = useSketchStore((s) => s.editingFeatureId);

  // Finish (FR-21): solve, derive the closed profile, persist the constrained
  // model + derived points into the sketch feature, and leave sketch mode.
  const finishSketch = (): void => {
    solve();
    const m = useSketchStore.getState().model;
    const profile = extractProfile(m);
    if (!profile) return; // no buildable profile yet — Finish stays disabled
    // The compiled plane spec rebuild consumes (alongside `profile`), so the
    // feature builds on the sketch's plane — a base datum + offset, or a model
    // face + offset — rather than always world-XY.
    const plane = m.face
      ? { kind: "face" as const, face: m.face, offset: m.offset ?? 0 }
      : { base: m.plane, offset: m.offset ?? 0 };
    const data = {
      model: structuredClone(m),
      profile,
      plane,
    };
    const cad = useCadStore.getState();
    if (editingFeatureId) cad.setFeatureData(editingFeatureId, data);
    else cad.addFeature({ type: "sketch", data });
    exitSketch();
  };
  const profileReady = extractProfile(model) !== null;

  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<{ px: Px; snap: Snap; hint: SegHint | null } | null>(null);
  // Right-click context menu (sketch-entity context): screen-anchored DOM menu
  // over the overlay, reusing the shared catalog (constraints/dimensions/fix/finish).
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    sections: MenuSection[];
    target: ContextTarget;
  } | null>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  /** The point being dragged in the Select tool (live re-solve), if any. */
  const dragPoint = useRef<string | null>(null);
  const baseColor = verdictColor(result?.verdict);

  // The world point the in-progress gesture started from (rubber-band anchor).
  const anchorId = pending[0];
  const anchor = anchorId ? model.points.find((p) => p.id === anchorId) : undefined;

  const inferAt = (p: Px): { snap: Snap; hint: SegHint | null } => {
    const snap = nearestSnap(model, view, p);
    const hint =
      tool === "line" && anchor
        ? segmentHint(model, { u: anchor.u, v: anchor.v }, { u: snap.u, v: snap.v })
        : null;
    return { snap, hint };
  };

  // Track the host size; centre the view the first time the sketch opens.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: host.clientWidth, h: host.clientHeight });
    });
    ro.observe(host);
    setSize({ w: host.clientWidth, h: host.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Re-centre the view on entering the sketch (not on every view change).
  useEffect(() => {
    if (active) setView(centeredView(size.w, size.h, view.scale));
  }, [active, setView, size.w, size.h, view.scale]);

  // Esc aborts the in-progress drawing gesture.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") cancelGesture();
      else if (e.key === "Enter") finishGesture();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, cancelGesture, finishGesture]);

  if (!active) return null;

  const rectPx = (e: React.PointerEvent): { x: number; y: number } => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const toolBtn = (t: SketchTool, label: string): React.JSX.Element => (
    <button
      key={t}
      type="button"
      data-testid={`tool-${t}`}
      aria-pressed={tool === t}
      onClick={() => setTool(t)}
      className={`rounded px-2 py-0.5 ${tool === t ? "bg-[#4ea1ff] text-black" : "hover:bg-[#1b2230]"}`}
    >
      {label}
    </button>
  );

  return (
    <div ref={hostRef} data-testid="sketcher" className="absolute inset-0 z-10">
      <div className="absolute left-2 top-2 z-20 flex items-center gap-2 rounded border border-[#2a3444] bg-black/60 px-2 py-1 text-xs text-[#cfe]">
        <span className="font-bold">Sketch</span>
        <span className="text-[#789]">{plane}</span>
        <div className="mx-1 h-3 w-px bg-[#2a3444]" />
        {TOOLS.map((t) => toolBtn(t.tool, t.label))}
        {tool === "polygon" && (
          <label className="ml-1 flex items-center gap-1 text-[#9ab]">
            sides
            <input
              type="number"
              min={3}
              max={64}
              data-testid="polygon-sides"
              value={polygonSides}
              onChange={(e) => setPolygonSides(Number(e.currentTarget.value))}
              className="w-12 rounded border border-[#2a3444] bg-[#0e1219] px-1 py-0.5 text-[#cfe] outline-none"
            />
          </label>
        )}
        {tool === "spline" && pending.length >= 2 && (
          <button
            type="button"
            data-testid="spline-done"
            onClick={finishGesture}
            className="rounded border border-[#3a6ea5] px-2 py-0.5 text-[#9fd0ff] hover:bg-[#11202e]"
            title="Finish the spline (Enter)"
          >
            Done
          </button>
        )}
        <label className="ml-1 flex items-center gap-1 text-[#9ab]">
          <input
            type="checkbox"
            data-testid="construction-toggle"
            checked={construction}
            onChange={(e) => setConstruction(e.currentTarget.checked)}
          />
          constr
        </label>
        <button
          type="button"
          data-testid="sketch-finish"
          disabled={!profileReady}
          onClick={finishSketch}
          className="rounded border border-[#3a6b3a] bg-[#1c2a14] px-2 py-0.5 text-[#cfe6a0] enabled:hover:bg-[#24341a] disabled:opacity-40"
          title={
            profileReady ? "Finish: use this profile in a feature" : "Draw a closed profile first"
          }
        >
          Finish
        </button>
        <button
          type="button"
          data-testid="sketch-close"
          onClick={exitSketch}
          className="rounded border border-[#2a3444] px-2 py-0.5 hover:bg-[#1b2230]"
        >
          Cancel
        </button>
      </div>

      {/* Select-then-constrain palette (FR-18): each button enables only when the
          current selection fits the constraint. */}
      <div
        data-testid="constraint-palette"
        className="absolute left-2 top-12 z-20 flex items-center gap-1 rounded border border-[#2a3444] bg-black/60 px-2 py-1 text-xs text-[#cfe]"
      >
        <span className="text-[10px] uppercase text-[#567]">Constrain</span>
        {(
          [
            ["horizontal", "H"],
            ["vertical", "V"],
            ["coincident", "Coin"],
            ["parallel", "∥"],
            ["perpendicular", "⟂"],
            ["equalLength", "="],
            ["concentric", "◎"],
            ["tangent", "T"],
            ["midpoint", "Mid"],
            ["pointOnObject", "On"],
            ["symmetric", "Sym"],
          ] as [ConstraintKind, string][]
        ).map(([kind, label]) => {
          const enabled = canApply(kind, model, selection);
          return (
            <button
              key={kind}
              type="button"
              data-testid={`constrain-${kind}`}
              disabled={!enabled}
              onClick={() => applyConstraint(kind)}
              className="rounded px-1.5 py-0.5 enabled:hover:bg-[#1b2230] disabled:opacity-30"
            >
              {label}
            </button>
          );
        })}
        <span className="ml-1 text-[10px] text-[#678]">{selection.length} sel</span>
        <div className="mx-1 h-3 w-px bg-[#2a3444]" />
        <span className="text-[10px] uppercase text-[#567]">Dim</span>
        {(
          [
            ["distance", "Dist"],
            ["hDistance", "↔"],
            ["vDistance", "↕"],
            ["radius", "Radius"],
            ["diameter", "⌀"],
            ["angle", "Angle"],
          ] as [DimensionKind, string][]
        ).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            data-testid={`dim-${kind}`}
            disabled={!canDimension(kind, model, selection)}
            onClick={() => addDimension(kind)}
            className="rounded px-1.5 py-0.5 enabled:hover:bg-[#1b2230] disabled:opacity-30"
          >
            {label}
          </button>
        ))}
      </div>

      {/* Solver feedback (FR-20): DOF counter, three-state verdict, conflict list. */}
      <div
        data-testid="solver-feedback"
        className="absolute right-2 top-2 z-20 w-48 rounded border border-[#2a3444] bg-black/70 px-2 py-1 text-xs"
      >
        <div className="flex items-center justify-between">
          <span data-testid="verdict" style={{ color: baseColor }} className="font-bold capitalize">
            {result ? result.verdict.replace("-", " ") : "—"}
          </span>
          <span data-testid="dof" className="text-[#9ab]">
            DOF {result?.freedom ?? "—"}
          </span>
        </div>
        {result && result.verdict === "over-constrained" && (
          <div className="mt-1 border-t border-[#3a2a2a] pt-1">
            <div className="mb-0.5 text-[10px] uppercase text-[#a55]">
              Conflicts — click to remove
            </div>
            <ul className="max-h-32 space-y-0.5 overflow-auto">
              {model.constraints.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    data-testid="conflict-item"
                    onClick={() => removeConstraint(c.id)}
                    className="w-full rounded px-1 text-left text-[#ff9b9b] hover:bg-[#2a1717]"
                  >
                    {c.kind}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {editingDim && (
        <DimensionEditor
          id={editingDim}
          onClose={() => setEditingDim(null)}
          onSet={setConstraintValue}
          model={model}
        />
      )}
      <svg
        data-testid="sketch-svg"
        width={size.w}
        height={size.h}
        className={`block touch-none ${tool === "select" ? "cursor-grab" : "cursor-crosshair"}`}
        onContextMenu={(e) => {
          e.preventDefault();
          const target = resolveContextTarget({
            cad: snapshotCad(),
            sketch: snapshotSketch(),
            hit: null,
            worldPoint: [0, 0, 0],
          });
          setCtxMenu({ x: e.clientX, y: e.clientY, sections: buildMenuSections(target), target });
        }}
        onWheel={(e) => {
          const r = (e.currentTarget as SVGElement).getBoundingClientRect();
          const anchorPx = { x: e.clientX - r.left, y: e.clientY - r.top };
          setView(zoomAt(view, anchorPx, e.deltaY < 0 ? 1.1 : 1 / 1.1));
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return; // left button only — right-click opens the menu
          (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
          const p = rectPx(e);
          pan.current = p;
          moved.current = false;
          // In Select, pressing on a point starts a live drag (FR-20 re-solve).
          if (tool === "select") {
            const hit = hitTest(model, view, p);
            dragPoint.current = hit?.kind === "point" ? hit.id : null;
          }
        }}
        onPointerMove={(e) => {
          const p = rectPx(e);
          // Dragging a point: move it and re-solve live (under-constrained DOF).
          if (dragPoint.current) {
            moved.current = true;
            const w = toWorld(view, p);
            movePoint(dragPoint.current, w.u, w.v);
            solve();
            return;
          }
          const start = pan.current;
          if (start && (moved.current || Math.hypot(p.x - start.x, p.y - start.y) >= 3)) {
            moved.current = true; // a drag → pan (in any tool)
            setView(panBy(view, p.x - start.x, p.y - start.y));
            pan.current = p;
            return;
          }
          // Hovering in a drawing tool: live snap + inference preview (FR-17).
          if (tool !== "select") setHover({ px: p, ...inferAt(p) });
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => {
          if (e.button !== 0) return; // left button only — right-click opens the menu
          const wasMove = moved.current;
          const wasDrag = dragPoint.current !== null;
          const p = rectPx(e);
          pan.current = null;
          moved.current = false;
          dragPoint.current = null;
          if (wasMove || wasDrag) return;
          if (tool === "select") {
            // Select-then-constrain: pick the entity under the cursor (Shift adds).
            const hit = hitTest(model, view, p);
            if (!hit) setSelection([]);
            else if (e.shiftKey) toggleSelect(hit.id);
            else setSelection([hit.id]);
            return;
          }
          // Place at the snapped point; persist the inferred constraint unless Shift.
          const { snap, hint } = inferAt(p);
          clickAt(snap.u, snap.v, {
            reusePointId: snap.pointId,
            constraint: !e.shiftKey && hint ? hint.constraint : undefined,
          });
          setHover({ px: p, ...inferAt(p) });
        }}
      >
        <GridAndAxes view={view} w={size.w} h={size.h} />
        <SketchGeometry model={model} view={view} selection={selection} baseColor={baseColor} />
        <ConstraintGlyphs
          model={model}
          view={view}
          onDelete={removeConstraint}
          onEdit={setEditingDim}
        />
        {hover && (
          <InferenceOverlay
            hover={hover}
            tip={toScreen(view, { u: hover.snap.u, v: hover.snap.v })}
            anchor={anchor ? toScreen(view, { u: anchor.u, v: anchor.v }) : null}
          />
        )}
      </svg>
      {ctxMenu && (
        <>
          {/* Backdrop dismisses on the next click (matches the feature-tree menu). */}
          <div
            data-testid="sketch-ctx-backdrop"
            className="fixed inset-0 z-40"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div className="fixed z-50" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <ContextMenuView
              testid="sketch-context-menu"
              sections={ctxMenu.sections}
              onClose={() => setCtxMenu(null)}
              onRun={(id) => {
                runContextAction(id, ctxMenu.target);
                setCtxMenu(null);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Snap marker (per kind) + rubber-band + inferred-constraint glyph (FR-17). */
function InferenceOverlay({
  hover,
  tip,
  anchor,
}: {
  hover: { px: Px; snap: Snap; hint: SegHint | null };
  tip: Px;
  anchor: Px | null;
}): React.JSX.Element {
  const color = hover.snap.kind === "grid" ? "#4ea1ff" : "#ffd34a";
  const kind = hover.snap.kind;
  return (
    <g pointerEvents="none">
      {anchor && (
        <line
          x1={anchor.x}
          y1={anchor.y}
          x2={tip.x}
          y2={tip.y}
          stroke="#4ea1ff"
          strokeWidth={1}
          strokeDasharray="5 4"
        />
      )}
      {kind === "origin" && (
        <rect
          x={tip.x - 5}
          y={tip.y - 5}
          width={10}
          height={10}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
        />
      )}
      {kind === "midpoint" && (
        <polygon
          points={`${tip.x},${tip.y - 6} ${tip.x + 6},${tip.y + 4} ${tip.x - 6},${tip.y + 4}`}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
        />
      )}
      {kind === "center" && (
        <g stroke={color} strokeWidth={1.5}>
          <line x1={tip.x - 6} y1={tip.y} x2={tip.x + 6} y2={tip.y} />
          <line x1={tip.x} y1={tip.y - 6} x2={tip.x} y2={tip.y + 6} />
        </g>
      )}
      {(kind === "point" || kind === "grid") && (
        <circle cx={tip.x} cy={tip.y} r={5} fill="none" stroke={color} strokeWidth={1.5} />
      )}
      {hover.hint && (
        <text
          data-testid="infer-glyph"
          x={hover.px.x + 12}
          y={hover.px.y - 10}
          fill="#ffd34a"
          fontSize={12}
          fontFamily="monospace"
        >
          {hover.hint.glyph}
        </text>
      )}
    </g>
  );
}
