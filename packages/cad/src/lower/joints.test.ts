import { beforeAll, describe, expect, it } from "vitest";
import { makeJoint } from "../assembly/joint.js";
import { Component } from "../hierarchy/component.js";
import { makeBody } from "../hierarchy/body.js";
import { defaultLibrary } from "../material/library.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { exportForSim } from "./export.js";
import { lowerJoint, lowerJoints } from "./joints.js";
import { isSimManifest } from "./manifest.js";

describe("assembly→sim joint lowering (FR-30 / Q8)", () => {
  it("revolute → hinge with world anchor + unit axis", () => {
    const j = makeJoint("revolute", 0, 1, { origin: [0.1, 0.2, 0.3], axis: [0, 0, 2] });
    const c = lowerJoint({ joint: j, bodyA: "ground", bodyB: "crank" });
    expect(c.kind).toBe("hinge");
    if (c.kind === "hinge") {
      expect(c.bodyA).toBe("ground");
      expect(c.bodyB).toBe("crank");
      expect(c.anchor).toEqual([0.1, 0.2, 0.3]);
      expect(c.axis).toEqual([0, 0, 1]); // normalized
    }
  });

  it("fixed → fixed (weld)", () => {
    const c = lowerJoint({
      joint: makeJoint("fixed", 0, 1, { origin: [0, 0, 0], axis: [0, 0, 1] }),
      bodyA: "a",
      bodyB: "b",
    });
    expect(c.kind).toBe("fixed");
  });

  it("ball / prismatic / cylindrical / planar throw (Q8: no sim equivalent in V1)", () => {
    // ball is unsupported too: the sim's `distance` locks only the radial DOF,
    // so it cannot express a spherical joint (3 anchor DOF coincident).
    for (const kind of ["ball", "prismatic", "cylindrical", "planar"] as const) {
      expect(() =>
        lowerJoint({
          joint: makeJoint(kind, 0, 1, { origin: [0, 0, 0], axis: [1, 0, 0] }),
          bodyA: "a",
          bodyB: "b",
        }),
      ).toThrow(/no mechx_sim equivalent/);
    }
  });

  it("lowerJoints lowers a batch", () => {
    const cs = lowerJoints([
      {
        joint: makeJoint("revolute", 0, 1, { origin: [0, 0, 0], axis: [0, 0, 1] }),
        bodyA: "g",
        bodyB: "c",
      },
      {
        joint: makeJoint("fixed", 1, 2, { origin: [0, 0, 0], axis: [0, 0, 1] }),
        bodyA: "c",
        bodyB: "r",
      },
    ]);
    expect(cs.map((c) => c.kind)).toEqual(["hinge", "fixed"]);
  });
});

describe("export embeds lowered constraints (FR-30)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, 120_000);

  it("a two-body model + a revolute joint exports a valid manifest with a hinge", () => {
    const root = new Component("link2");
    const a = makeBody("ground", "structural-steel");
    a.geometry = makeBox(oc, mm(20), mm(20), mm(20));
    const b = makeBody("crank", "aluminum-6061");
    b.geometry = makeBox(oc, mm(20), mm(20), mm(20));
    root.addBody(a);
    root.addBody(b);
    try {
      const constraints = lowerJoints([
        {
          joint: makeJoint("revolute", 0, 1, { origin: [0, 0, 0], axis: [0, 0, 1] }),
          bodyA: "ground",
          bodyB: "crank",
        },
      ]);
      const manifest = exportForSim(oc, root, defaultLibrary(), "test:link2", { constraints });
      expect(isSimManifest(manifest)).toBe(true);
      expect(manifest.constraints).toHaveLength(1);
      expect(manifest.constraints[0]!.kind).toBe("hinge");
    } finally {
      a.geometry?.delete();
      b.geometry?.delete();
    }
  });

  it("a constraint referencing a missing body fails the manifest contract", () => {
    const root = new Component("solo");
    const a = makeBody("only", "abs");
    a.geometry = makeBox(oc, mm(10), mm(10), mm(10));
    root.addBody(a);
    try {
      const constraints = lowerJoints([
        {
          joint: makeJoint("revolute", 0, 1, { origin: [0, 0, 0], axis: [0, 0, 1] }),
          bodyA: "only",
          bodyB: "ghost",
        },
      ]);
      const manifest = exportForSim(oc, root, defaultLibrary(), "test:solo", { constraints });
      // "ghost" is not an exported body → the manifest is invalid (dangling ref).
      expect(isSimManifest(manifest)).toBe(false);
    } finally {
      a.geometry?.delete();
    }
  });
});
