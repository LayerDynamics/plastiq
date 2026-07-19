// @vitest-environment jsdom
// ViewCube — component tests (jsdom + RTL). The production DOM view cube: it
// renders face/edge/corner pick targets, highlights the hovered region (parity
// with the retired drei cube's hoverColor), and calls onPick(axes) on click.
// ViewCubeOverlay is the production mount: it drives the camera through the
// viewport's published setView seam (mocked here — no WebGL in jsdom).

import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ViewCube, ViewCubeOverlay } from "./ViewCube.js";

type SetViewGlobal = {
  __plastiqViewport?: { setView?: (dir: readonly [number, number, number]) => void };
};

afterEach(() => {
  cleanup();
  delete (globalThis as SetViewGlobal).__plastiqViewport;
});

describe("ViewCube", () => {
  it("smoke: renders the cube with its face buttons", () => {
    render(<ViewCube onPick={() => {}} />);
    expect(screen.getByTestId("view-cube")).toBeTruthy();
    expect(screen.getByTestId("cube-face-T")).toBeTruthy();
  });

  it("integration: clicking the Top face calls onPick with the +Z axis", () => {
    const onPick = vi.fn();
    render(<ViewCube onPick={onPick} />);
    fireEvent.click(screen.getByTestId("cube-face-T"));
    expect(onPick).toHaveBeenCalledWith([0, 0, 1]);
  });

  it("integration: clicking an edge spot and the near corner picks their axes", () => {
    const onPick = vi.fn();
    render(<ViewCube onPick={onPick} />);
    fireEvent.click(screen.getByTestId("cube-spot-101")); // T–R edge
    expect(onPick).toHaveBeenLastCalledWith([1, 0, 1]);
    fireEvent.click(screen.getByTestId("cube-spot-1-11")); // near corner → iso
    expect(onPick).toHaveBeenLastCalledWith([1, -1, 1]);
  });

  it("hover: the face under the pointer fills orange and restores on leave", () => {
    render(<ViewCube onPick={() => {}} />);
    const face = screen.getByTestId("cube-face-T");
    const base = face.getAttribute("fill");
    fireEvent.mouseOver(face);
    expect(face.getAttribute("fill")).toBe("#ffa23a"); // SELECT_ORANGE
    fireEvent.mouseOut(face);
    expect(face.getAttribute("fill")).toBe(base);
  });

  it("hover: an edge spot highlights too", () => {
    render(<ViewCube onPick={() => {}} />);
    const spot = screen.getByTestId("cube-spot-101"); // T–R edge, plainly visible by default
    fireEvent.mouseOver(spot);
    expect(spot.getAttribute("fill")).toBe("#ffa23a");
  });
});

describe("ViewCubeOverlay (production mount)", () => {
  it("renders the SVG cube and clicking a face orients the camera via setView", () => {
    const setView = vi.fn();
    (globalThis as SetViewGlobal).__plastiqViewport = { setView };
    render(<ViewCubeOverlay />);
    expect(screen.getByTestId("view-cube")).toBeTruthy();

    fireEvent.click(screen.getByTestId("cube-face-T"));
    expect(setView).toHaveBeenCalledWith([0, 0, 1]);

    // The near corner snaps to the unit iso direction (normalized by cubeDirection).
    fireEvent.click(screen.getByTestId("cube-spot-1-11"));
    const dir = setView.mock.calls.at(-1)![0] as [number, number, number];
    const iso = 1 / Math.sqrt(3);
    expect(dir[0]).toBeCloseTo(iso, 9);
    expect(dir[1]).toBeCloseTo(-iso, 9);
    expect(dir[2]).toBeCloseTo(iso, 9);
  });

  it("is safe before the viewport publishes the seam (no setView → no throw)", () => {
    render(<ViewCubeOverlay />);
    expect(() => fireEvent.click(screen.getByTestId("cube-face-R"))).not.toThrow();
  });
});

describe("ViewCube — follows the camera (FR-12)", () => {
  /** Camera quaternion for looking at the origin FROM `dir` (Z-up, as the app). */
  const lookFrom = (dir: [number, number, number]): [number, number, number, number] => {
    const m = new THREE.Matrix4().lookAt(
      new THREE.Vector3(...dir).normalize(),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 1),
    );
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    return [q.x, q.y, q.z, q.w];
  };

  it("shows the faces the camera can actually see, and hides the rest", () => {
    // From the FRONT: the F face is there; the opposite Bk face is not.
    const { unmount } = render(<ViewCube quat={lookFrom([0, -1, 0])} onPick={() => {}} />);
    expect(screen.getByTestId("cube-face-F")).toBeTruthy();
    expect(screen.queryByTestId("cube-face-Bk")).toBeNull();
    unmount();

    // Orbit 180°: they swap. A static cube could never do this.
    render(<ViewCube quat={lookFrom([0, 1, 0])} onPick={() => {}} />);
    expect(screen.getByTestId("cube-face-Bk")).toBeTruthy();
    expect(screen.queryByTestId("cube-face-F")).toBeNull();
  });

  it("re-projects its geometry when the camera moves", () => {
    const { rerender } = render(<ViewCube quat={lookFrom([1, -1, 1])} onPick={() => {}} />);
    const iso = screen.getByTestId("cube-face-T").getAttribute("points");
    rerender(<ViewCube quat={lookFrom([0, 0, 1])} onPick={() => {}} />);
    const top = screen.getByTestId("cube-face-T").getAttribute("points");
    expect(top).not.toEqual(iso); // the drawing followed the camera
    expect(iso).toBeTruthy();
  });

  it("reaches orientations a static cube never could — the BACK face is pickable", () => {
    // The old cube drew only T/F/R, so Bk/L/Bo were unreachable by clicking.
    const picked: number[][] = [];
    render(<ViewCube quat={lookFrom([-1, 1, -1])} onPick={(a) => picked.push([...a])} />);
    fireEvent.click(screen.getByTestId("cube-face-Bk"));
    fireEvent.click(screen.getByTestId("cube-face-L"));
    fireEvent.click(screen.getByTestId("cube-face-Bo"));
    expect(picked).toEqual([
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, -1],
    ]);
  });

  it("keeps every visible face inside the SVG box (no clipping as it spins)", () => {
    for (const dir of [
      [1, -1, 1],
      [0, 0, 1],
      [-1, 1, -1],
      [1, 1, 0],
    ] as [number, number, number][]) {
      const { unmount } = render(<ViewCube quat={lookFrom(dir)} onPick={() => {}} />);
      for (const poly of Array.from(document.querySelectorAll("polygon"))) {
        for (const pair of (poly.getAttribute("points") ?? "").trim().split(/\s+/)) {
          const [x, y] = pair.split(",").map(Number);
          expect(x!).toBeGreaterThanOrEqual(0);
          expect(x!).toBeLessThanOrEqual(72);
          expect(y!).toBeGreaterThanOrEqual(0);
          expect(y!).toBeLessThanOrEqual(72);
        }
      }
      unmount();
    }
  });
});
