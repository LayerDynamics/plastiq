import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { planeXY, planeXZ, planeYZ, offsetPlane, planeYAxis } from "@plastiq/cad";
import { centeredView, toScreen, type View2D, type Vec2 } from "../sketch/transform2d.js";
import { sketchOrthoFrame, type SketchOrthoFrame } from "./sketchCamera.js";

const W = 800;
const H = 600;

/** Build the three.js ortho camera the frame describes, ready to project(). */
function camera(frame: SketchOrthoFrame): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(
    frame.left,
    frame.right,
    frame.top,
    frame.bottom,
    frame.near,
    frame.far,
  );
  cam.position.set(...frame.position);
  cam.up.set(...frame.up);
  cam.lookAt(new THREE.Vector3(...frame.target));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** Where the camera puts a 3D point on screen (px), exactly as three.js renders. */
function projectPx(cam: THREE.OrthographicCamera, p: [number, number, number]) {
  const ndc = new THREE.Vector3(...p).project(cam);
  return { x: (ndc.x * 0.5 + 0.5) * W, y: (1 - (ndc.y * 0.5 + 0.5)) * H };
}

/** A plane (u,v) coordinate as a 3D world point: origin + u·xAxis + v·yAxis. */
function world(plane: ReturnType<typeof planeXY>, uv: Vec2): [number, number, number] {
  const x = plane.xAxis;
  const y = planeYAxis(plane);
  const o = plane.origin;
  return [
    o[0] + x[0] * uv.u + y[0] * uv.v,
    o[1] + x[1] * uv.u + y[1] * uv.v,
    o[2] + x[2] * uv.u + y[2] * uv.v,
  ];
}

describe("sketchOrthoFrame — the 3D ortho camera coincides with the 2D overlay", () => {
  const view: View2D = centeredView(W, H, 4000); // 4000 px/m, origin centred
  const samples: Vec2[] = [
    { u: 0, v: 0 },
    { u: 0.05, v: 0.03 },
    { u: -0.04, v: 0.06 },
  ];

  for (const plane of [planeXY(), planeXZ(), planeYZ()]) {
    it(`projects the plane (${plane.normal.join(",")}) exactly like toScreen`, () => {
      const cam = camera(sketchOrthoFrame(plane, view, W, H));
      for (const uv of samples) {
        const got = projectPx(cam, world(plane, uv));
        const want = toScreen(view, uv);
        expect(got.x).toBeCloseTo(want.x, 3);
        expect(got.y).toBeCloseTo(want.y, 3);
      }
    });
  }

  it("respects a panned + zoomed view (the overlay drives the camera)", () => {
    const panned: View2D = { scale: 8000, panX: 250, panY: 400 };
    const cam = camera(sketchOrthoFrame(planeXY(), panned, W, H));
    for (const uv of samples) {
      const got = projectPx(cam, world(planeXY(), uv));
      const want = toScreen(panned, uv);
      expect(got.x).toBeCloseTo(want.x, 3);
      expect(got.y).toBeCloseTo(want.y, 3);
    }
  });

  it("an offset plane sketches at the offset (origin sits along the normal)", () => {
    const plane = offsetPlane(planeXY(), 0.05);
    const cam = camera(sketchOrthoFrame(plane, view, W, H));
    // The plane origin (now at world z=0.05) still lands at the overlay's origin px.
    const got = projectPx(cam, [0, 0, 0.05]);
    expect(got.x).toBeCloseTo(view.panX, 3);
    expect(got.y).toBeCloseTo(view.panY, 3);
  });
});
