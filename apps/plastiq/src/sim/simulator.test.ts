import { describe, expect, it } from "vitest";
import { axisAngleQuat, quatRotate, type Quat, type Vec3 } from "../assembly/model.js";
import { bodyPoseToGroup } from "./simulator.js";

// The render-back must invert the lowering's COM composition. Lowering does:
//   worldCom = instancePos + R(instanceOri) · localCom
// so at t=0 (sim hasn't moved the body), bodyPoseToGroup(worldCom, ori, localCom)
// must return the instance's original origin pose — exactly (M6.1 invariant).
function worldCom(pos: Vec3, ori: Quat, localCom: Vec3): Vec3 {
  const r = quatRotate(ori, localCom);
  return [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]];
}

describe("bodyPoseToGroup — COM-frame render-back (M6.1)", () => {
  const localCom: Vec3 = [0.03, 0.02, 0.015];

  it("t=0 round-trips an identity-oriented instance origin exactly", () => {
    const pos: Vec3 = [0.1, 0.05, 0];
    const ori: Quat = [0, 0, 0, 1];
    const com = worldCom(pos, ori, localCom);
    const back = bodyPoseToGroup(com, ori, localCom);
    expect(back.position[0]).toBeCloseTo(pos[0], 9);
    expect(back.position[1]).toBeCloseTo(pos[1], 9);
    expect(back.position[2]).toBeCloseTo(pos[2], 9);
    expect(back.orientation).toEqual(ori);
  });

  it("t=0 round-trips a rotated instance origin exactly", () => {
    const pos: Vec3 = [-0.02, 0.08, 0.04];
    const ori = axisAngleQuat([0, 0, 1], Math.PI / 3); // 60° about Z
    const com = worldCom(pos, ori, localCom);
    const back = bodyPoseToGroup(com, ori, localCom);
    expect(back.position[0]).toBeCloseTo(pos[0], 9);
    expect(back.position[1]).toBeCloseTo(pos[1], 9);
    expect(back.position[2]).toBeCloseTo(pos[2], 9);
  });

  it("a body that fell Δy renders its group fallen by the same Δy", () => {
    const pos: Vec3 = [0, 0.1, 0];
    const ori: Quat = [0, 0, 0, 1];
    const com0 = worldCom(pos, ori, localCom);
    const com1: Vec3 = [com0[0], com0[1] - 0.05, com0[2]]; // dropped 50mm
    const back = bodyPoseToGroup(com1, ori, localCom);
    expect(back.position[1]).toBeCloseTo(pos[1] - 0.05, 9);
  });
});
