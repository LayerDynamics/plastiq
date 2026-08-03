// §13.2 helical sweep — sweep feature with data.helix rebuilds via
// helix() + sweepAlongWire (not a SpinePath kind, not a separate feature type).

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, mm, type Occt, type Solid } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import { rebuildDocument } from "./rebuild.js";

const INIT_TIMEOUT_MS = 120_000;

function solidVolume(oc: Occt, solid: Solid): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.VolumeProperties_1(solid.shape, props, false, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

/** Analytic arc length of a constant-radius cylindrical helix. */
function cylHelixLength(radius: number, pitch: number, turns: number): number {
  const circ = 2 * Math.PI * radius;
  return turns * Math.hypot(circ, pitch);
}

describe("§13.2 helix sweep feature — helix() + sweepAlongWire via rebuild", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("sweep with data.helix builds a valid helical pipe", () => {
    const m = (x: number): number => mm(x);
    const radius = m(10);
    const pitch = m(5);
    const turns = 2;
    const profileR = m(1);
    // Helix about +Z starts at (radius,0,0) with tangent ≈ +Y. Profile on XZ
    // (normal +Y) is perpendicular to that start tangent; center at (radius, 0)
    // in XZ UV lands on the spine start so MakePipeShell locates the section.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sweep",
          data: {
            profile: { kind: "circle", center: [radius, 0], radius: profileR },
            plane: { base: "XZ", offset: 0 },
            helix: {
              radius,
              pitch,
              turns,
              handedness: "right",
            },
          },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solid).not.toBeNull();
      expect(solid!.isValid()).toBe(true);
      // Volume ≈ profile area × helix length (orientation may flip the sign).
      const expectedLen = cylHelixLength(radius, pitch, turns);
      const profileArea = Math.PI * profileR * profileR;
      const v = Math.abs(solidVolume(oc, solid!));
      expect(v).toBeGreaterThan(profileArea * expectedLen * 0.7);
      expect(v).toBeLessThan(profileArea * expectedLen * 1.4);
    } finally {
      solid?.delete();
    }
  });

  it("left-handed helix sweep also builds a valid solid", () => {
    const m = (x: number): number => mm(x);
    const radius = m(8);
    const profileR = m(1.5);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sweep",
          data: {
            profile: { kind: "circle", center: [radius, 0], radius: profileR },
            plane: { base: "XZ", offset: 0 },
            helix: {
              radius,
              pitch: m(4),
              turns: 1.5,
              handedness: "left",
            },
          },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solid).not.toBeNull();
      expect(solid!.isValid()).toBe(true);
      const v = Math.abs(solidVolume(oc, solid!));
      expect(v).toBeGreaterThan(Math.PI * profileR * profileR * m(4) * 1.5 * 0.5);
    } finally {
      solid?.delete();
    }
  });

  it("malformed data.helix fails loudly", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sweep",
          data: {
            profile: { kind: "circle", center: [0, 0], radius: 0.001 },
            helix: { radius: 0.01 }, // missing pitch/turns/handedness
          },
        },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/helix.*radius.*pitch.*turns.*handedness/i);
  });

  it("sweep without path, helix, or pathEdges fails with no path", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sweep",
          data: {
            profile: { kind: "circle", center: [0, 0], radius: 0.001 },
          },
        },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/sweep.*no path/i);
  });
});
