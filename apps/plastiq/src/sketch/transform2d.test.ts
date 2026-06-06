import { describe, expect, it } from "vitest";
import { centeredView, panBy, toScreen, toWorld, zoomAt, type View2D } from "./transform2d.js";

const view: View2D = { scale: 1000, panX: 400, panY: 300 };

describe("transform2d — sketch ↔ screen affine (M3.1)", () => {
  it("maps the origin to the pan point with V flipped", () => {
    expect(toScreen(view, { u: 0, v: 0 })).toEqual({ x: 400, y: 300 });
    // +V is up the screen (smaller y).
    expect(toScreen(view, { u: 0, v: 0.05 })).toEqual({ x: 400, y: 250 });
    expect(toScreen(view, { u: 0.1, v: 0 })).toEqual({ x: 500, y: 300 });
  });

  it("toWorld inverts toScreen", () => {
    const p = { u: 0.0123, v: -0.0456 };
    const back = toWorld(view, toScreen(view, p));
    expect(back.u).toBeCloseTo(p.u, 9);
    expect(back.v).toBeCloseTo(p.v, 9);
  });

  it("zoomAt keeps the world point under the anchor fixed", () => {
    const anchor = { x: 550, y: 120 };
    const worldBefore = toWorld(view, anchor);
    const zoomed = zoomAt(view, anchor, 1.5);
    const worldAfter = toWorld(zoomed, anchor);
    expect(worldAfter.u).toBeCloseTo(worldBefore.u, 9);
    expect(worldAfter.v).toBeCloseTo(worldBefore.v, 9);
    expect(zoomed.scale).toBeCloseTo(1500, 6);
  });

  it("zoom scale is clamped to a sane range", () => {
    let v = view;
    for (let i = 0; i < 50; i++) v = zoomAt(v, { x: 0, y: 0 }, 2);
    expect(v.scale).toBeLessThanOrEqual(500_000);
    let v2 = view;
    for (let i = 0; i < 50; i++) v2 = zoomAt(v2, { x: 0, y: 0 }, 0.5);
    expect(v2.scale).toBeGreaterThanOrEqual(50);
  });

  it("panBy shifts the origin in screen space", () => {
    expect(panBy(view, 10, -5)).toMatchObject({ panX: 410, panY: 295 });
  });

  it("centeredView puts the origin at the viewport centre", () => {
    expect(centeredView(800, 600)).toMatchObject({ panX: 400, panY: 300 });
  });
});
