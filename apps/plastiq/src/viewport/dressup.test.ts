import { describe, expect, it } from "vitest";
import type { SelectionRefs } from "../store/store.js";
import type { Pick } from "../store/types.js";
import type { Profile } from "../sketch/profile.js";
import {
  booleanBodyFeature,
  chamferFeature,
  draftFeature,
  edgeRefsFromPicks,
  extrudeAlongEdgeFeature,
  extrudeToFaceFeature,
  extrudeTwoSidedFeature,
  faceRefsFromPicks,
  filletFeature,
  loftFeature,
  shellFeature,
  sweepFeature,
} from "./dressup.js";

const refs: SelectionRefs = {
  faces: { 1: { normal: [0, 0, 1] }, 2: { normal: [1, 0, 0] } },
  edges: {
    5: {
      faceNormals: [
        [0, 0, 1],
        [1, 0, 0],
      ],
    },
    6: {
      faceNormals: [
        [0, 0, 1],
        [0, 1, 0],
      ],
    },
  },
};

describe("dressup — picks + refs → persistent feature data (FR-30/FR-16)", () => {
  it("resolves picked edges/faces to their persistent refs", () => {
    const picks: Pick[] = [
      { kind: "edge", id: 5 },
      { kind: "edge", id: 6 },
      { kind: "face", id: 1 },
    ];
    expect(edgeRefsFromPicks(picks, refs)).toEqual([
      {
        faceNormals: [
          [0, 0, 1],
          [1, 0, 0],
        ],
      },
      {
        faceNormals: [
          [0, 0, 1],
          [0, 1, 0],
        ],
      },
    ]);
    expect(faceRefsFromPicks(picks, refs)).toEqual([{ normal: [0, 0, 1] }]);
  });

  it("filletFeature stores the EdgeRefs + radius; null with no edges", () => {
    const f = filletFeature([{ kind: "edge", id: 5 }], refs, 0.003);
    expect(f).toMatchObject({ type: "fillet", params: { radius: 0.003 } });
    expect((f!.data!["edges"] as unknown[]).length).toBe(1);
    expect(filletFeature([{ kind: "face", id: 1 }], refs, 0.003)).toBeNull();
  });

  it("chamferFeature stores EdgeRefs + distance", () => {
    const f = chamferFeature([{ kind: "edge", id: 6 }], refs, 0.002);
    expect(f).toMatchObject({ type: "chamfer", params: { distance: 0.002 } });
  });

  it("shellFeature stores the open FaceRefs + thickness; null with no faces", () => {
    const f = shellFeature([{ kind: "face", id: 1 }], refs, 0.001);
    expect(f).toMatchObject({ type: "shell", params: { thickness: 0.001 } });
    expect((f!.data!["faces"] as unknown[]).length).toBe(1);
    expect(shellFeature([{ kind: "edge", id: 5 }], refs, 0.001)).toBeNull();
  });

  it("draftFeature tapers the first picked face about the base plane", () => {
    const f = draftFeature([{ kind: "face", id: 2 }], refs, 0.1);
    expect(f).toMatchObject({ type: "draft", params: { angle: 0.1 } });
    expect(f!.data!["face"]).toEqual({ normal: [1, 0, 0] });
    expect(f!.data!["neutralNormal"]).toEqual([0, 0, 1]);
    expect(draftFeature([], refs, 0.1)).toBeNull();
  });

  it("draftFeature stores all picked faces for multi-face draft (G9)", () => {
    const f = draftFeature(
      [
        { kind: "face", id: 1 },
        { kind: "face", id: 2 },
      ],
      refs,
      0.05,
    );
    expect(f).not.toBeNull();
    expect(f!.data!["face"]).toEqual({ normal: [0, 0, 1] }); // first face back-compat
    expect(f!.data!["faces"]).toEqual([{ normal: [0, 0, 1] }, { normal: [1, 0, 0] }]);
  });

  it("ignores picks whose id has no ref (stale selection)", () => {
    expect(edgeRefsFromPicks([{ kind: "edge", id: 99 }], refs)).toEqual([]);
  });

  it("extrudeTwoSidedFeature carries the up + back distances (FR-29)", () => {
    expect(extrudeTwoSidedFeature(0.02, 0.01)).toEqual({
      type: "extrude",
      params: { height: 0.02, back: 0.01 },
    });
  });

  it("extrudeToFaceFeature stores the target FaceRef; null with no face", () => {
    const f = extrudeToFaceFeature([{ kind: "face", id: 1 }], refs);
    expect(f).toMatchObject({ type: "extrude" });
    expect(f!.data!["toFace"]).toEqual({ normal: [0, 0, 1] });
    expect(extrudeToFaceFeature([{ kind: "edge", id: 5 }], refs)).toBeNull();
  });

  it("extrudeAlongEdgeFeature stores the direction EdgeRef + height; null with no edge", () => {
    const f = extrudeAlongEdgeFeature([{ kind: "edge", id: 5 }], refs, 0.02);
    expect(f).toMatchObject({ type: "extrude", params: { height: 0.02 } });
    expect(f!.data!["directionEdge"]).toEqual({
      faceNormals: [
        [0, 0, 1],
        [1, 0, 0],
      ],
    });
    expect(extrudeAlongEdgeFeature([{ kind: "face", id: 1 }], refs, 0.02)).toBeNull();
  });

  it("loftFeature needs ≥2 sections; sweepFeature carries profile + path (FR-32)", () => {
    const rect: Profile = {
      kind: "loop",
      start: [0, 0],
      segments: [
        { kind: "line", to: [1, 0] },
        { kind: "line", to: [1, 1] },
        { kind: "line", to: [0, 1] },
      ],
    };
    expect(loftFeature([{ profile: rect, z: 0 }])).toBeNull();
    const lf = loftFeature(
      [
        { profile: rect, z: 0 },
        { profile: rect, z: 0.05 },
      ],
      true,
    );
    expect(lf).toMatchObject({ type: "loft" });
    expect((lf!.data!["sections"] as unknown[]).length).toBe(2);
    expect(lf!.data!["ruled"]).toBe(true);

    const sf = sweepFeature(rect, {
      kind: "polyline",
      points: [
        [0, 0, 0],
        [0, 0, 1],
      ],
    });
    expect(sf).toMatchObject({ type: "sweep" });
    expect(sf.data!["path"]).toEqual({
      kind: "polyline",
      points: [
        [0, 0, 0],
        [0, 0, 1],
      ],
    });

    // Optional profile plane (G3).
    const sfPlane = sweepFeature(
      rect,
      {
        kind: "polyline",
        points: [
          [0, 0, 0],
          [0, 1, 0],
        ],
      },
      { base: "XZ", offset: 0.01 },
    );
    expect(sfPlane.data!["plane"]).toEqual({ base: "XZ", offset: 0.01 });
  });

  it("booleanBodyFeature stores the op + an id'd tool subtree (FR-31)", () => {
    const f = booleanBodyFeature("subtract", [
      { type: "box", params: { dx: 0.01, dy: 0.01, dz: 0.01 } },
    ]);
    expect(f.type).toBe("boolean");
    expect(f.data!["op"]).toBe("subtract");
    const tools = f.data!["toolFeatures"] as { id: string; type: string }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: "tool0", type: "box" });
  });
});
