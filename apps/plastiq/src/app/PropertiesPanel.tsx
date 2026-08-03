// Right-hand properties panel (SPEC-5 FR-4/FR-23). Shows the selected feature's
// editable numeric parameters and the body-placement pose (FR-11). Editing a
// value commits it to the store (one undo step, one rebuild) on blur/Enter — not
// per keystroke — and downstream features rebuild deterministically.

import { useEffect, useState } from "react";
import { useCadStore } from "../store/store.js";
import { PLACEMENT_TYPE, type EditorFeature } from "../store/types.js";
import { findPlacement, placementFromFeature } from "../viewport/placement.js";
import { toDisplayValue, fromDisplayValue, unitSuffix } from "../store/featureUnits.js";
import { evalExpr } from "../store/paramExpr.js";

const M_PER_MM = 0.001;
const DEG_PER_RAD = 180 / Math.PI;

/** A numeric input that holds a local draft and commits on blur / Enter. */
function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value));
  // Re-sync when the store value changes from elsewhere (gizmo, undo).
  useEffect(() => setDraft(formatNum(value)), [value]);

  const commit = (): void => {
    const v = Number(draft);
    if (Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(formatNum(value));
  };
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
      <span className="w-6 text-[#789]">{label}</span>
      <input
        type="number"
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setDraft(formatNum(value));
        }}
        className="w-full rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-right text-[#cfe] outline-none focus:border-[#4ea1ff]"
      />
    </label>
  );
}

/** One numeric feature parameter plus its optional global expression binding. */
function FeatureParamField({
  feature,
  paramKey,
  literal,
}: {
  feature: EditorFeature;
  paramKey: string;
  literal: number;
}): React.JSX.Element {
  const params = useCadStore((s) => s.params);
  const updateParams = useCadStore((s) => s.updateParams);
  const setFeatureExpr = useCadStore((s) => s.setFeatureExpr);
  const expression = feature.exprs?.[paramKey] ?? "";
  const [draft, setDraft] = useState(expression);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(expression);
    setError(null);
  }, [expression]);

  let effective = literal;
  let standingError: string | null = null;
  if (expression) {
    try {
      effective = evalExpr(expression, params);
      if (!Number.isFinite(effective)) standingError = "expression is not finite";
    } catch (ex) {
      standingError = ex instanceof Error ? ex.message : "invalid expression";
    }
  }

  const commitExpression = (): void => {
    const next = draft.trim();
    try {
      if (next) {
        const value = evalExpr(next, params);
        if (!Number.isFinite(value)) throw new Error("expression is not finite");
      }
      setFeatureExpr(feature.id, paramKey, next || undefined);
      setDraft(next);
      setError(null);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : "invalid expression");
    }
  };

  const suffix = unitSuffix(feature.type, paramKey);
  return (
    <div className="space-y-0.5" data-testid={`feature-param-${paramKey}`}>
      <NumberField
        label={suffix ? `${paramKey} (${suffix})` : paramKey}
        value={toDisplayValue(feature.type, paramKey, effective)}
        onCommit={(value) =>
          updateParams(feature.id, {
            [paramKey]: fromDisplayValue(feature.type, paramKey, value),
          })
        }
      />
      <label className="flex items-center justify-between gap-2 text-[10px] text-[#789]">
        <span className="w-6">fx</span>
        <input
          data-testid={`feature-expr-${paramKey}`}
          aria-label={`${paramKey} expression`}
          value={draft}
          placeholder="literal"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commitExpression}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            else if (event.key === "Escape") {
              setDraft(expression);
              setError(null);
            }
          }}
          className="w-full rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-right font-mono text-[10px] text-[#9fc] outline-none focus:border-[#4ea1ff]"
        />
      </label>
      {(error ?? standingError) && (
        <p
          data-testid={`feature-expr-error-${paramKey}`}
          className="text-right text-[10px] text-[#fc9]"
        >
          {error ?? standingError}
        </p>
      )}
    </div>
  );
}

function formatNum(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toFixed(6))) : "0";
}

function PlacementEditor(): React.JSX.Element {
  const features = useCadStore((s) => s.features);
  const upsertPlacement = useCadStore((s) => s.upsertPlacement);
  const p = placementFromFeature(findPlacement(features));

  const setT = (axis: "tx" | "ty" | "tz", mm: number): void =>
    upsertPlacement({ [axis]: mm * M_PER_MM });
  const setR = (axis: "rx" | "ry" | "rz", deg: number): void =>
    upsertPlacement({ [axis]: deg / DEG_PER_RAD });

  return (
    <section data-testid="placement-editor">
      <h3 className="mb-1 text-[11px] font-bold tracking-wide text-[#789]">PLACEMENT</h3>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[#567]">Translate (mm)</div>
      <div className="space-y-1">
        <NumberField label="X" value={p.tx / M_PER_MM} onCommit={(v) => setT("tx", v)} />
        <NumberField label="Y" value={p.ty / M_PER_MM} onCommit={(v) => setT("ty", v)} />
        <NumberField label="Z" value={p.tz / M_PER_MM} onCommit={(v) => setT("tz", v)} />
      </div>
      <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-[#567]">Rotate (°)</div>
      <div className="space-y-1">
        <NumberField label="X" value={p.rx * DEG_PER_RAD} onCommit={(v) => setR("rx", v)} />
        <NumberField label="Y" value={p.ry * DEG_PER_RAD} onCommit={(v) => setR("ry", v)} />
        <NumberField label="Z" value={p.rz * DEG_PER_RAD} onCommit={(v) => setR("rz", v)} />
      </div>
    </section>
  );
}

// --- Sweep path editor (R13 / C1) ------------------------------------------------
// Makes the registry status "edit Properties → Path" true: a typed spine of
// polyline points (or mixed line/arc segments) in mm, plus attach-from-selection
// for parametric pathEdges. Rebuild reads data.path / data.pathEdges.

type Point3 = [number, number, number];
type SpineSegment = { kind: "line"; to: Point3 } | { kind: "arc"; through: Point3; to: Point3 };
type SpinePath =
  | { kind: "polyline"; points: Point3[] }
  | { kind: "path"; start: Point3; segments: SpineSegment[] };

function isPoint3(v: unknown): v is Point3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    typeof v[2] === "number"
  );
}

function parseSpinePath(raw: unknown): SpinePath | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["kind"] === "polyline" && Array.isArray(o["points"])) {
    const points = (o["points"] as unknown[]).filter(isPoint3) as Point3[];
    if (points.length >= 2)
      return { kind: "polyline", points: points.map((p) => [...p] as Point3) };
  }
  if (o["kind"] === "path" && isPoint3(o["start"]) && Array.isArray(o["segments"])) {
    const segments: SpineSegment[] = [];
    for (const s of o["segments"] as unknown[]) {
      if (!s || typeof s !== "object") continue;
      const seg = s as Record<string, unknown>;
      if (seg["kind"] === "line" && isPoint3(seg["to"])) {
        segments.push({ kind: "line", to: [...seg["to"]] as Point3 });
      } else if (seg["kind"] === "arc" && isPoint3(seg["through"]) && isPoint3(seg["to"])) {
        segments.push({
          kind: "arc",
          through: [...seg["through"]] as Point3,
          to: [...seg["to"]] as Point3,
        });
      }
    }
    return { kind: "path", start: [...o["start"]] as Point3, segments };
  }
  return null;
}

function defaultPolylinePath(): SpinePath {
  return {
    kind: "polyline",
    points: [
      [0, 0, 0],
      [0, 0, 0.04],
    ],
  };
}

/** Editable world-space sweep spine (polyline or line/arc segments), SI→mm UI. */
function SweepPathEditor({
  featureId,
  data,
  setFeatureData,
  picks,
  selectionRefs,
}: {
  featureId: string;
  data: Record<string, unknown>;
  setFeatureData: (id: string, data: Record<string, unknown>) => void;
  picks: readonly { kind: string; id: number }[];
  selectionRefs: { edges: Record<number, unknown> };
}): React.JSX.Element {
  const pathEdges = Array.isArray(data["pathEdges"]) ? (data["pathEdges"] as unknown[]) : [];
  const path = parseSpinePath(data["path"]);
  const edgePickCount = picks.filter((p) => p.kind === "edge").length;

  const writePath = (next: SpinePath): void => {
    // Typed path and picked-edge spine are mutually exclusive: writing a typed
    // path clears pathEdges so rebuild uses data.path (rebuild prefers pathEdges).
    setFeatureData(featureId, { path: next, pathEdges: undefined });
  };

  const attachPathEdges = (): void => {
    const refs = picks
      .filter((p) => p.kind === "edge")
      .map((p) => selectionRefs.edges[p.id])
      .filter(Boolean);
    if (refs.length === 0) return;
    setFeatureData(featureId, { pathEdges: refs, path: undefined });
  };

  const ensurePolyline = (): SpinePath & { kind: "polyline" } => {
    if (path?.kind === "polyline") return path;
    return defaultPolylinePath() as SpinePath & { kind: "polyline" };
  };

  const setPoint = (index: number, axis: 0 | 1 | 2, mm: number): void => {
    const poly = ensurePolyline();
    const points = poly.points.map((p) => [...p] as Point3);
    const cur = points[index] ?? ([0, 0, 0] as Point3);
    cur[axis] = mm * M_PER_MM;
    points[index] = cur;
    writePath({ kind: "polyline", points });
  };

  const addPoint = (): void => {
    const poly = ensurePolyline();
    const last = poly.points[poly.points.length - 1] ?? ([0, 0, 0] as Point3);
    writePath({
      kind: "polyline",
      points: [...poly.points, [last[0], last[1], last[2] + 0.01] as Point3],
    });
  };

  const removePoint = (index: number): void => {
    const poly = ensurePolyline();
    if (poly.points.length <= 2) return; // spine needs ≥2 points
    writePath({ kind: "polyline", points: poly.points.filter((_, i) => i !== index) });
  };

  const setSegmentPoint = (
    segIndex: number,
    field: "to" | "through",
    axis: 0 | 1 | 2,
    mm: number,
  ): void => {
    if (!path || path.kind !== "path") return;
    const segments = path.segments.map((s) => {
      if (s.kind === "line") return { kind: "line" as const, to: [...s.to] as Point3 };
      return { kind: "arc" as const, through: [...s.through] as Point3, to: [...s.to] as Point3 };
    });
    const seg = segments[segIndex];
    if (!seg) return;
    if (field === "through" && seg.kind === "arc") {
      seg.through[axis] = mm * M_PER_MM;
    } else if (field === "to") {
      seg.to[axis] = mm * M_PER_MM;
    }
    writePath({ kind: "path", start: [...path.start] as Point3, segments });
  };

  const setStartAxis = (axis: 0 | 1 | 2, mm: number): void => {
    if (!path || path.kind !== "path") return;
    const start = [...path.start] as Point3;
    start[axis] = mm * M_PER_MM;
    writePath({ kind: "path", start, segments: path.segments });
  };

  const polyPoints: Point3[] =
    path?.kind === "polyline"
      ? path.points
      : pathEdges.length === 0
        ? (defaultPolylinePath() as { kind: "polyline"; points: Point3[] }).points
        : [];

  return (
    <div className="space-y-1 border-t border-[#1a2230] pt-2" data-testid="feature-path-editor">
      <div className="text-[10px] uppercase tracking-wide text-[#567]">Path</div>
      {pathEdges.length > 0 && (
        <p className="text-[10px] text-[#9ab]" data-testid="feature-path-edges">
          {pathEdges.length} picked edge(s) — re-resolved each rebuild
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          data-testid="feature-attach-path-edges"
          disabled={edgePickCount === 0}
          onClick={attachPathEdges}
          className="rounded border border-[#3a5a7a] bg-[#14253a] px-1.5 py-0.5 text-[10px] text-[#bfe] disabled:opacity-40"
        >
          Attach selected edges{edgePickCount > 0 ? ` (${edgePickCount})` : ""}
        </button>
        {pathEdges.length > 0 && (
          <button
            type="button"
            data-testid="feature-clear-path-edges"
            onClick={() => writePath(defaultPolylinePath())}
            className="rounded border border-[#3a5a7a] bg-[#14253a] px-1.5 py-0.5 text-[10px] text-[#bfe]"
          >
            Switch to typed path
          </button>
        )}
      </div>
      {pathEdges.length === 0 && path?.kind === "path" && (
        <div className="space-y-1" data-testid="feature-path-segments">
          <div className="text-[10px] text-[#789]">Start (mm)</div>
          <div className="grid grid-cols-3 gap-1">
            {([0, 1, 2] as const).map((axis) => (
              <NumberField
                key={`start-${axis}`}
                label={["X", "Y", "Z"][axis]!}
                value={path.start[axis]! / M_PER_MM}
                onCommit={(v) => setStartAxis(axis, v)}
              />
            ))}
          </div>
          {path.segments.map((seg, i) => (
            <div
              key={i}
              className="space-y-0.5 rounded border border-[#1a2230] p-1"
              data-testid={`feature-path-seg-${i}`}
            >
              <div className="text-[10px] text-[#789]">
                {seg.kind === "line" ? "Line →" : "Arc →"} (mm)
              </div>
              {seg.kind === "arc" && (
                <div className="grid grid-cols-3 gap-1">
                  {([0, 1, 2] as const).map((axis) => (
                    <NumberField
                      key={`through-${i}-${axis}`}
                      label={["X", "Y", "Z"][axis]!}
                      value={seg.through[axis]! / M_PER_MM}
                      onCommit={(v) => setSegmentPoint(i, "through", axis, v)}
                    />
                  ))}
                </div>
              )}
              <div className="grid grid-cols-3 gap-1">
                {([0, 1, 2] as const).map((axis) => (
                  <NumberField
                    key={`to-${i}-${axis}`}
                    label={["X", "Y", "Z"][axis]!}
                    value={seg.to[axis]! / M_PER_MM}
                    onCommit={(v) => setSegmentPoint(i, "to", axis, v)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {pathEdges.length === 0 && path?.kind !== "path" && (
        <div className="space-y-1" data-testid="feature-path-points">
          {polyPoints.map((pt, i) => (
            <div
              key={i}
              className="flex items-center gap-1"
              data-testid={`feature-path-point-${i}`}
            >
              <span className="w-4 shrink-0 text-[10px] text-[#567]">{i + 1}</span>
              <div className="grid flex-1 grid-cols-3 gap-1">
                {([0, 1, 2] as const).map((axis) => (
                  <NumberField
                    key={`${i}-${axis}`}
                    label={["X", "Y", "Z"][axis]!}
                    value={pt[axis]! / M_PER_MM}
                    onCommit={(v) => setPoint(i, axis, v)}
                  />
                ))}
              </div>
              <button
                type="button"
                data-testid={`feature-path-remove-${i}`}
                disabled={polyPoints.length <= 2}
                onClick={() => removePoint(i)}
                className="rounded border border-[#3a2a2a] px-1 text-[10px] text-[#c99] disabled:opacity-30"
                title="Remove point"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            data-testid="feature-path-add-point"
            onClick={addPoint}
            className="rounded border border-[#3a5a7a] bg-[#14253a] px-1.5 py-0.5 text-[10px] text-[#bfe]"
          >
            + Point
          </button>
          <p className="text-[10px] text-[#567]">spine points in mm (world)</p>
        </div>
      )}
    </div>
  );
}

/** Editable helical spine on a sweep feature (data.helix → helix() + sweepAlongWire). */
function SweepHelixEditor({
  featureId,
  data,
  setFeatureData,
}: {
  featureId: string;
  data: Record<string, unknown>;
  setFeatureData: (id: string, data: Record<string, unknown>) => void;
}): React.JSX.Element {
  const raw = (data["helix"] ?? {}) as Record<string, unknown>;
  const radiusMm = (Number(raw["radius"]) || 0) / M_PER_MM;
  const pitchMm = (Number(raw["pitch"]) || 0) / M_PER_MM;
  const turns = Number(raw["turns"]) || 0;
  const handedness = raw["handedness"] === "left" ? "left" : "right";
  const taperDeg =
    typeof raw["taperAngle"] === "number" ? (raw["taperAngle"] as number) * DEG_PER_RAD : 0;

  const write = (patch: Record<string, unknown>): void => {
    setFeatureData(featureId, {
      helix: { ...raw, ...patch },
      // Helix and path/pathEdges are mutually exclusive spines.
      path: undefined,
      pathEdges: undefined,
    });
  };

  return (
    <div className="space-y-1 border-t border-[#1a2230] pt-2" data-testid="feature-helix-editor">
      <div className="text-[10px] uppercase tracking-wide text-[#567]">Helix</div>
      <NumberField label="r" value={radiusMm} onCommit={(v) => write({ radius: v * M_PER_MM })} />
      <NumberField label="p" value={pitchMm} onCommit={(v) => write({ pitch: v * M_PER_MM })} />
      <NumberField label="n" value={turns} onCommit={(v) => write({ turns: v })} />
      <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
        <span className="text-[#789]">hand</span>
        <select
          data-testid="feature-helix-handedness"
          value={handedness}
          onChange={(e) =>
            write({ handedness: e.currentTarget.value === "left" ? "left" : "right" })
          }
          className="rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-[#cfe] outline-none focus:border-[#4ea1ff]"
        >
          <option value="right">right</option>
          <option value="left">left</option>
        </select>
      </label>
      <NumberField
        label="α"
        value={taperDeg}
        onCommit={(v) => write({ taperAngle: v / DEG_PER_RAD })}
      />
      <p className="text-[10px] text-[#567]">radius/pitch mm · turns · taper °</p>
    </div>
  );
}

/** Feature `data` editors: op, shell dir, sweep opts, boolean op, loft ruled, deps, refs (C10). */
function FeatureDataFields({
  featureId,
  type,
  data,
  params,
}: {
  featureId: string;
  type: string;
  data: Record<string, unknown> | undefined;
  params?: Record<string, number>;
}): React.JSX.Element | null {
  const setFeatureData = useCadStore((s) => s.setFeatureData);
  const setFeatureDeps = useCadStore((s) => s.setFeatureDeps);
  const features = useCadStore((s) => s.features);
  const picks = useCadStore((s) => s.picks);
  const selectionRefs = useCadStore((s) => s.selectionRefs);
  const d = data ?? {};
  const edges = Array.isArray(d["edges"]) ? (d["edges"] as unknown[]).length : 0;
  const faces = Array.isArray(d["faces"])
    ? (d["faces"] as unknown[]).length
    : d["face"] != null
      ? 1
      : 0;
  /** Round primitives (§4.11) — they carry a data.op like extrude, plus cut/intersect. */
  const isPrimitive =
    type === "cylinder" || type === "sphere" || type === "cone" || type === "torus";
  const showOp =
    type === "extrude" ||
    type === "rib" ||
    type === "revolve" ||
    type === "loft" ||
    type === "sweep" ||
    isPrimitive;
  /** The ops a data.op feature supports.
   *
   * Since R9 the profile features (extrude/revolve/loft/sweep) execute `cut` and
   * `intersect` too — the evaluator routes them all through the same
   * `combinePrimitive` op contract as the round primitives — so every op-carrying
   * feature offers the full set (previously profiles offered only join/new, which
   * silently reinterpreted a `cut` as a join, P3). */
  const opChoices = ["join", "cut", "intersect", "new"] as const;
  const showShellDir = type === "shell";
  const showBooleanOp = type === "boolean";
  const showLoftRuled = type === "loft";
  const showDeps =
    type === "extrude" ||
    type === "rib" ||
    type === "cut" ||
    type === "revolve" ||
    type === "sweep" ||
    type === "boolean";
  const showCounts =
    edges > 0 ||
    faces > 0 ||
    type === "fillet" ||
    type === "chamfer" ||
    type === "shell" ||
    type === "draft";
  const showSweepOpts = type === "sweep";
  // Helical spine (data.helix) uses its own editor; polyline/pathEdges use Path.
  const hasHelix = type === "sweep" && d["helix"] != null && typeof d["helix"] === "object";
  const showSweepPath = type === "sweep" && !hasHelix;
  const showSweepHelix = hasHelix;
  const showChamferFace = type === "chamfer";
  if (
    !showOp &&
    !showShellDir &&
    !showCounts &&
    !showSweepOpts &&
    !showSweepPath &&
    !showSweepHelix &&
    !showBooleanOp &&
    !showLoftRuled &&
    !showDeps &&
    !showChamferFace
  ) {
    return null;
  }

  // Must accept every op this TYPE supports, not just join/new: a primitive with
  // data.op === "cut" would otherwise display as "join" — the same lie §9 records
  // for `boolean` (panel shows one op while the rebuild does another). The
  // fallback is "join", matching the evaluator's join-by-default.
  const op = (opChoices as readonly string[]).includes(d["op"] as string)
    ? (d["op"] as string)
    : "join";
  const boolOp =
    d["op"] === "union" || d["op"] === "intersect" || d["op"] === "subtract"
      ? (d["op"] as string)
      : "subtract";
  const shellDir = d["direction"] === "outward" ? "outward" : "inward";
  const transition =
    d["transition"] === "round" || d["transition"] === "transformed" || d["transition"] === "right"
      ? (d["transition"] as string)
      : "right";
  const mode =
    d["mode"] === "frenet" || d["mode"] === "correctedFrenet"
      ? (d["mode"] as string)
      : "correctedFrenet";
  const ruled = Boolean(d["ruled"]);
  const feature = features.find((f) => f.id === featureId);
  const boundDeps = feature?.deps ?? [];
  const sketchCandidates = features.filter(
    (f) => f.id !== featureId && f.type === "sketch" && !f.suppressed,
  );
  const hasChamferFace = d["face"] != null;
  const d2 = params?.["distance2"];
  const d1 = params?.["distance"];
  // Two-distance chamfer only when distance2 is set and differs from distance (or face is expected).
  const needsChamferFace =
    type === "chamfer" &&
    typeof d2 === "number" &&
    Number.isFinite(d2) &&
    (typeof d1 !== "number" || Math.abs(d2 - d1) > 1e-12 || d2 > 0);

  const attachFaceFromSelection = (): void => {
    const facePick = picks.find((p) => p.kind === "face");
    if (!facePick) return;
    const ref = selectionRefs.faces[facePick.id];
    if (!ref) return;
    setFeatureData(featureId, { face: ref });
  };

  /** Replace data.edges with currently selected edges that resolve in selectionRefs (C10). */
  const attachEdgesFromSelection = (): void => {
    const edgeRefs = picks
      .filter((p) => p.kind === "edge")
      .map((p) => selectionRefs.edges[p.id])
      .filter(Boolean);
    if (edgeRefs.length === 0) return;
    setFeatureData(featureId, { edges: edgeRefs });
  };

  /** Replace data.faces with currently selected faces (shell/draft multi-face) (C10). */
  const attachFacesFromSelection = (): void => {
    const faceRefs = picks
      .filter((p) => p.kind === "face")
      .map((p) => selectionRefs.faces[p.id])
      .filter(Boolean);
    if (faceRefs.length === 0) return;
    // Draft also accepts singular face for back-compat; write faces[] as primary.
    setFeatureData(featureId, { faces: faceRefs, face: faceRefs[0] });
  };

  const showAttachEdges = type === "fillet" || type === "chamfer";
  const showAttachFaces = type === "shell" || type === "draft";
  const edgePickCount = picks.filter((p) => p.kind === "edge").length;
  const facePickCount = picks.filter((p) => p.kind === "face").length;

  return (
    <div data-testid="feature-data" className="mt-2 space-y-1 border-t border-[#1a2230] pt-2">
      <div className="text-[10px] uppercase tracking-wide text-[#567]">Data</div>
      {showOp && (
        <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
          <span className="text-[#789]">op</span>
          <select
            data-testid="feature-op"
            value={op}
            onChange={(e) => setFeatureData(featureId, { op: e.currentTarget.value })}
            className="rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-[#cfe] outline-none focus:border-[#4ea1ff]"
          >
            {opChoices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
      )}
      {showBooleanOp && (
        <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
          <span className="text-[#789]">boolean op</span>
          <select
            data-testid="feature-boolean-op"
            value={boolOp}
            onChange={(e) => setFeatureData(featureId, { op: e.currentTarget.value })}
            className="rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-[#cfe] outline-none focus:border-[#4ea1ff]"
          >
            <option value="subtract">subtract</option>
            <option value="union">union</option>
            <option value="intersect">intersect</option>
          </select>
        </label>
      )}
      {showLoftRuled && (
        <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
          <span className="text-[#789]">ruled</span>
          <input
            data-testid="feature-loft-ruled"
            type="checkbox"
            checked={ruled}
            onChange={(e) =>
              setFeatureData(featureId, { ruled: e.currentTarget.checked || undefined })
            }
          />
        </label>
      )}
      {showDeps && sketchCandidates.length > 0 && (
        <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
          <span className="text-[#789]">sketch dep</span>
          <select
            data-testid="feature-deps"
            value={boundDeps[0] ?? ""}
            onChange={(e) => {
              const id = e.currentTarget.value;
              setFeatureDeps(featureId, id ? [id] : undefined);
            }}
            className="rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-[#cfe] outline-none focus:border-[#4ea1ff]"
          >
            <option value="">(none / last sketch)</option>
            {sketchCandidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? s.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {showShellDir && (
        <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
          <span className="text-[#789]">direction</span>
          <select
            data-testid="feature-shell-dir"
            value={shellDir}
            onChange={(e) =>
              setFeatureData(featureId, {
                direction: e.currentTarget.value === "outward" ? "outward" : undefined,
              })
            }
            className="rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-[#cfe] outline-none focus:border-[#4ea1ff]"
          >
            <option value="inward">inward</option>
            <option value="outward">outward</option>
          </select>
        </label>
      )}
      {showSweepOpts && (
        <>
          <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
            <span className="text-[#789]">mode</span>
            <select
              data-testid="feature-sweep-mode"
              value={mode}
              onChange={(e) => setFeatureData(featureId, { mode: e.currentTarget.value })}
              className="rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-[#cfe] outline-none focus:border-[#4ea1ff]"
            >
              <option value="correctedFrenet">correctedFrenet</option>
              <option value="frenet">frenet</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2 text-xs text-[#9ab]">
            <span className="text-[#789]">transition</span>
            <select
              data-testid="feature-sweep-transition"
              value={transition}
              onChange={(e) => setFeatureData(featureId, { transition: e.currentTarget.value })}
              className="rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-[#cfe] outline-none focus:border-[#4ea1ff]"
            >
              <option value="right">right</option>
              <option value="round">round</option>
              <option value="transformed">transformed</option>
            </select>
          </label>
        </>
      )}
      {showSweepPath && (
        <SweepPathEditor
          featureId={featureId}
          data={d}
          setFeatureData={setFeatureData}
          picks={picks}
          selectionRefs={selectionRefs}
        />
      )}
      {showSweepHelix && (
        <SweepHelixEditor featureId={featureId} data={d} setFeatureData={setFeatureData} />
      )}
      {showCounts && (
        <div className="space-y-1" data-testid="feature-refs-editor">
          <p className="text-[10px] text-[#567]" data-testid="feature-ref-counts">
            {edges > 0 ? `${edges} edge ref(s)` : null}
            {edges > 0 && faces > 0 ? " · " : null}
            {faces > 0 ? `${faces} face ref(s)` : null}
            {edges === 0 && faces === 0 ? "no edge/face refs" : null}
          </p>
          {showAttachEdges && (
            <button
              type="button"
              data-testid="feature-attach-edges"
              disabled={edgePickCount === 0}
              onClick={attachEdgesFromSelection}
              className="rounded border border-[#3a5a7a] bg-[#14253a] px-1.5 py-0.5 text-[10px] text-[#bfe] disabled:opacity-40"
            >
              Attach selected edges{edgePickCount > 0 ? ` (${edgePickCount})` : ""}
            </button>
          )}
          {showAttachFaces && (
            <button
              type="button"
              data-testid="feature-attach-faces"
              disabled={facePickCount === 0}
              onClick={attachFacesFromSelection}
              className="rounded border border-[#3a5a7a] bg-[#14253a] px-1.5 py-0.5 text-[10px] text-[#bfe] disabled:opacity-40"
            >
              Attach selected faces{facePickCount > 0 ? ` (${facePickCount})` : ""}
            </button>
          )}
        </div>
      )}
      {showChamferFace && (
        <div className="space-y-1" data-testid="feature-chamfer-face">
          <p className="text-[10px] text-[#789]">
            two-distance face:{" "}
            {hasChamferFace ? (
              <span className="text-[#9fc]">set</span>
            ) : (
              <span className="text-[#fc9]">required when distance2 ≠ distance</span>
            )}
          </p>
          <button
            type="button"
            data-testid="feature-attach-face"
            disabled={!picks.some((p) => p.kind === "face")}
            onClick={attachFaceFromSelection}
            className="rounded border border-[#3a5a7a] bg-[#14253a] px-1.5 py-0.5 text-[10px] text-[#bfe] disabled:opacity-40"
          >
            Attach selected face
          </button>
          {needsChamferFace && !hasChamferFace && (
            <p className="text-[10px] text-[#fc9]" data-testid="feature-chamfer-face-warn">
              distance2 is set but no data.face — rebuild uses symmetric chamfer until a face is
              attached
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FeatureEditor(): React.JSX.Element | null {
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const features = useCadStore((s) => s.features);

  const feature = features.find((f) => f.id === selectedFeatureId);
  if (!feature || feature.type === PLACEMENT_TYPE) return null;
  const params = { ...(feature.params ?? {}) };
  // Surface optional params that may be absent until edited (T15/C8).
  if ((feature.type === "extrude" || feature.type === "cut") && params["back"] == null) {
    params["back"] = 0;
  }
  // C8: surface optional second distance so the user can author variable fillet /
  // two-distance chamfer without re-creating the feature. Editing only commits
  // when the user changes a field (updateParams), so equal radius/radius2 stays constant.
  if (feature.type === "fillet" && params["radius"] != null && !("radius2" in params)) {
    params["radius2"] = params["radius"];
  }
  if (feature.type === "chamfer" && params["distance"] != null && !("distance2" in params)) {
    params["distance2"] = params["distance"];
  }
  const entries = Object.entries(params);

  return (
    <section data-testid="feature-editor">
      <h3 className="mb-1 text-[11px] font-bold tracking-wide text-[#789]">
        {(feature.name ?? feature.id).toUpperCase()}
        <span className="ml-1 font-normal text-[#567]">({feature.type})</span>
      </h3>
      {entries.length === 0 ? (
        <p className="text-[11px] opacity-60">No editable parameters.</p>
      ) : (
        <div className="space-y-1">
          {entries.map(([key, val]) => {
            return <FeatureParamField key={key} feature={feature} paramKey={key} literal={val} />;
          })}
          <p className="pt-1 text-[10px] text-[#567]">lengths in mm, angles in °</p>
        </div>
      )}
      <FeatureDataFields
        featureId={feature.id}
        type={feature.type}
        data={feature.data}
        params={params as Record<string, number>}
      />
    </section>
  );
}

/** Mass properties of the current build (FR readout): volume + centroid. Shown
 * only once the part has geometry; density-free (mass needs a material). */
function MassPropertiesSection(): React.JSX.Element | null {
  const massProps = useCadStore((s) => s.massProps);
  if (!massProps) return null;
  const toMm = (v: number): string => (v / M_PER_MM).toFixed(2); // m → mm
  const [cx, cy, cz] = massProps.com;
  return (
    <section data-testid="mass-properties">
      <h3 className="mb-1 text-[11px] font-bold tracking-wide text-[#789]">MASS PROPERTIES</h3>
      <dl className="space-y-0.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-[#789]">Volume</dt>
          <dd data-testid="mp-volume" className="tabular-nums text-[#cfe]">
            {(massProps.volume * 1e6).toFixed(2)} cm³
          </dd>
        </div>
        {massProps.bodyVolumes.length > 1 && (
          // A multi-body document (§2.4 `op:"new"`) is otherwise indistinguishable
          // from a single body here — the volume above is the SUM. List the count
          // and each body's own volume so "new body" has visible confirmation.
          <div className="flex items-start justify-between gap-2">
            <dt className="text-[#789]">Bodies</dt>
            <dd data-testid="mp-bodies" className="text-right tabular-nums text-[#cfe]">
              {massProps.bodyVolumes.length}
              <div className="text-[10px] text-[#789]">
                {massProps.bodyVolumes.map((v) => (v * 1e6).toFixed(2)).join(" · ")} cm³
              </div>
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-[#789]">Centroid</dt>
          <dd data-testid="mp-centroid" className="tabular-nums text-[#cfe]">
            {toMm(cx)}, {toMm(cy)}, {toMm(cz)} mm
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function PropertiesPanel(): React.JSX.Element {
  return (
    <div data-testid="properties" className="space-y-4 text-sm text-[#9ab]">
      <FeatureEditor />
      <PlacementEditor />
      <MassPropertiesSection />
    </div>
  );
}
