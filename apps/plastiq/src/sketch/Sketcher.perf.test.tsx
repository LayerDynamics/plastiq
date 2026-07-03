// @vitest-environment jsdom
// Sketcher — drag-performance + conflicts-filter component tests (jsdom + RTL).
//
// Perf (Review.md #14): dragging a sketch point must NOT run a wasm solve per
// pointermove. The overlay rAF-coalesces the drag: pointermove only records the
// latest pointer, at most one movePoint+solve runs per animation frame, and
// pointerup flushes the latest position synchronously so the end state is
// identical to the unthrottled path. Hover snap/inference is coalesced the same
// way. These tests drive the real <Sketcher> with a deterministic rAF queue and
// spy on the store's solve.
//
// Conflicts (Review.md #15): driven (reference) dimensions add no solver
// equation (toSolverInput skips them), so the over-constrained conflicts panel
// must not offer them for removal — mirroring the constraint glyphs/list.
//
// The planegcs kernel needs an async wasm load a jsdom unit test can't perform,
// so only `solveSketch` is stubbed with an identity solver (returns the input
// positions/radii unchanged); the store's real solve() write-back still runs.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PlastiqCad from "@plastiq/cad";

import { Sketcher } from "./Sketcher.js";
import { useSketchStore } from "./sketchStore.js";
import { toScreen, toWorld, type Px } from "./transform2d.js";

vi.mock("@plastiq/cad", async (importOriginal) => {
  const actual = await importOriginal<typeof PlastiqCad>();
  return {
    ...actual,
    solveSketch: (
      points: { x: number; y: number; fixed?: boolean }[],
      circles: { center: number; radius: number }[],
    ) => ({
      points: points.map((p) => ({ ...p })),
      radii: circles.map((c) => c.radius),
      verdict: "under-constrained" as const,
      freedom: points.length * 2,
    }),
  };
});

// --- Deterministic rAF: the component schedules frames into this queue; a test
// flushes them explicitly, so "one solve per frame" is directly observable. ---
let rafSeq = 0;
const rafQueue = new Map<number, FrameRequestCallback>();
function flushRaf(): void {
  const cbs = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of cbs) cb(0);
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const store = () => useSketchStore.getState();
const originalSolve = useSketchStore.getState().solve;

beforeEach(() => {
  rafQueue.clear();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafSeq += 1;
    rafQueue.set(rafSeq, cb);
    return rafSeq;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    rafQueue.delete(id);
  });
  store().setSolverReady(true);
});

afterEach(() => {
  cleanup();
  useSketchStore.setState({ solve: originalSolve });
  store().exitSketch();
  vi.unstubAllGlobals();
});

/** Render the overlay and return its <svg> with pointer capture stubbed
 * (jsdom's setPointerCapture is not reliable across versions). */
function renderSketcher(): SVGSVGElement {
  render(<Sketcher />);
  const svg = screen.getByTestId("sketch-svg") as unknown as SVGSVGElement;
  (svg as unknown as { setPointerCapture: (pointerId: number) => void }).setPointerCapture =
    () => {};
  return svg;
}

/** Enter a fresh XY sketch containing one free point at (0.01, -0.01) m and
 * select the Select tool. */
function seedDraggablePoint(): void {
  act(() => {
    store().enterSketch("XY");
    store().setTool("point");
    store().clickAt(0.01, -0.01);
    store().setTool("select");
  });
}

/** The seeded point's CURRENT screen position. Must be read after render — the
 * overlay re-centres the view on mount (jsdom hosts measure 0×0 → pan 0,0). */
function seededPointPx(): Px {
  const s = store();
  const pt = s.model.points[0]!;
  return toScreen(s.view, { u: pt.u, v: pt.v });
}

const pointerOpts = (px: Px) => ({
  button: 0,
  pointerId: 1,
  clientX: px.x,
  clientY: px.y,
});

describe("Sketcher drag performance (rAF-coalesced solves)", () => {
  it("coalesces a pointermove burst to one solve per flushed frame + a final flush on pointerup", () => {
    seedDraggablePoint();
    // Spy on the store's solve BEFORE render so the component captures the spy.
    const solveSpy = vi.fn(originalSolve);
    useSketchStore.setState({ solve: solveSpy });
    const svg = renderSketcher();
    const start = seededPointPx();

    fireEvent.pointerDown(svg, pointerOpts(start));
    solveSpy.mockClear(); // count only the drag's solves

    // Burst 1: ten moves, no frame fired yet → zero solves, one pending frame.
    let last: Px = start;
    for (let i = 1; i <= 10; i++) {
      last = { x: start.x + i * 3, y: start.y + i * 2 };
      fireEvent.pointerMove(svg, pointerOpts(last));
    }
    expect(solveSpy).toHaveBeenCalledTimes(0);
    expect(rafQueue.size).toBe(1);

    // The frame fires: exactly ONE solve, at the LATEST burst position.
    act(() => flushRaf());
    expect(solveSpy).toHaveBeenCalledTimes(1);
    const expectedMid = toWorld(store().view, last);
    expect(store().model.points[0]!.u).toBeCloseTo(expectedMid.u, 12);
    expect(store().model.points[0]!.v).toBeCloseTo(expectedMid.v, 12);

    // Burst 2: ten more moves without a frame → still one solve total.
    for (let i = 11; i <= 20; i++) {
      last = { x: start.x + i * 3, y: start.y + i * 2 };
      fireEvent.pointerMove(svg, pointerOpts(last));
    }
    expect(solveSpy).toHaveBeenCalledTimes(1);

    // pointerup cancels the pending frame and solves the latest position
    // synchronously (the final, authoritative solve).
    fireEvent.pointerUp(svg, pointerOpts(last));
    expect(solveSpy).toHaveBeenCalledTimes(2);
    expect(rafQueue.size).toBe(0);
    const expectedEnd = toWorld(store().view, last);
    expect(store().model.points[0]!.u).toBeCloseTo(expectedEnd.u, 12);
    expect(store().model.points[0]!.v).toBeCloseTo(expectedEnd.v, 12);
  });

  it("a coalesced drag ends at exactly the same geometry as an unthrottled drag", () => {
    seedDraggablePoint(); // the overlay renders only while a sketch is active
    const svg = renderSketcher();
    const path = (start: Px): Px[] =>
      Array.from({ length: 15 }, (_, i) => ({ x: start.x + (i + 1) * 4, y: start.y - (i + 1) }));

    /** Drag the seeded point along `path`; flush frames per `mode`. */
    const runDrag = (mode: "coalesced" | "every-move"): { u: number; v: number } => {
      seedDraggablePoint();
      const start = seededPointPx();
      fireEvent.pointerDown(svg, pointerOpts(start));
      const steps = path(start);
      steps.forEach((px, i) => {
        fireEvent.pointerMove(svg, pointerOpts(px));
        // Unthrottled reference: a frame after EVERY move. Coalesced run: frames
        // only land mid-burst (after moves 5 and 10) — the rest ride on pointerup.
        if (mode === "every-move" || i === 4 || i === 9) act(() => flushRaf());
      });
      fireEvent.pointerUp(svg, pointerOpts(steps[steps.length - 1]!));
      const p = store().model.points[0]!;
      return { u: p.u, v: p.v };
    };

    const solveSpy = vi.fn(originalSolve);
    act(() => useSketchStore.setState({ solve: solveSpy }));

    const coalesced = runDrag("coalesced");
    const coalescedSolves = solveSpy.mock.calls.length;
    solveSpy.mockClear();
    const unthrottled = runDrag("every-move");
    const unthrottledSolves = solveSpy.mock.calls.length;

    // Identical end geometry...
    expect(coalesced.u).toBeCloseTo(unthrottled.u, 12);
    expect(coalesced.v).toBeCloseTo(unthrottled.v, 12);
    // ...from far fewer solves (2 mid-drag frames + the pointerup flush vs one per move).
    expect(coalescedSolves).toBe(3);
    expect(unthrottledSolves).toBe(15);
  });

  it("coalesces hover snap/inference to one frame per burst (drawing tool)", () => {
    act(() => {
      store().enterSketch("XY");
      store().setTool("line");
    });
    const svg = renderSketcher();

    // Ten hover moves → the inference/value box has NOT updated yet (no frame),
    // and only ONE frame is pending for the whole burst.
    let last: Px = { x: 0, y: 0 };
    for (let i = 1; i <= 10; i++) {
      last = { x: 20 + i * 5, y: 30 + i * 2 };
      fireEvent.pointerMove(svg, { pointerId: 1, clientX: last.x, clientY: last.y });
    }
    expect(screen.queryByTestId("draw-input")).toBeNull();
    expect(rafQueue.size).toBe(1);

    // The frame fires: hover (and the inline value box) reflects the LATEST move.
    act(() => flushRaf());
    const box = screen.getByTestId("draw-input") as HTMLElement;
    expect(box.style.left).toBe(`${last.x + 16}px`);
    expect(box.style.top).toBe(`${last.y + 16}px`);

    // pointerleave clears the hover AND the pending frame — a stale frame must
    // not resurrect the preview. (React derives onPointerLeave from a native
    // pointerout whose relatedTarget is outside the element.)
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 500, clientY: 500 });
    expect(rafQueue.size).toBe(1);
    fireEvent.pointerOut(svg, { pointerId: 1, relatedTarget: document.body });
    expect(rafQueue.size).toBe(0);
    expect(screen.queryByTestId("draw-input")).toBeNull();
  });
});

describe("Sketcher conflicts panel (driven-dimension filter)", () => {
  it("lists only driving constraints — driven (reference) dimensions are filtered out", () => {
    act(() => {
      store().enterSketch("XY");
      store().setTool("line");
      store().clickAt(0, 0);
      store().clickAt(0.05, 0);
    });
    const m = store().model;
    const lid = m.entities[0]!.id;
    const pa = m.points[0]!.id;
    const pb = m.points[1]!.id;
    act(() => {
      useSketchStore.setState({
        model: {
          ...m,
          constraints: [
            { id: "c-h", kind: "horizontal", line: lid },
            // Driven: reports a value, adds no solver equation — never a conflict.
            { id: "c-drv", kind: "vDistance", a: pa, b: pb, value: 0.02, driven: true },
            { id: "c-dim", kind: "distance", a: pa, b: pb, value: 0.05 },
          ],
        },
        result: { points: [], radii: [], verdict: "over-constrained", freedom: 0 },
      });
    });
    renderSketcher();

    // The panel is open (over-constrained) but offers only the 2 driving
    // constraints of the 3 in the model.
    expect(store().model.constraints).toHaveLength(3);
    const items = screen.getAllByTestId("conflict-item");
    expect(items).toHaveLength(2);
    const labels = items.map((el) => el.textContent);
    expect(labels).toContain("horizontal");
    expect(labels).toContain("distance");
    expect(labels).not.toContain("vDistance");
  });
});
