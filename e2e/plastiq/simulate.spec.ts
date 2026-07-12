// SPEC-5 M6.1 — strict E2E (no mocks): in-editor Simulate (FR-41). The seeded
// part is lowered to a SimManifest and dropped/run in the REAL in-browser
// @plastiq/sim; the live body pose drives the render. start() takes no backend,
// so this exercises the DEFAULT backend (MuJoCo) end-to-end in the browser;
// simulate-backends.spec proves the other three. We start the sim, step a fixed
// number of ticks, assert the body fell under gravity, then Stop and assert the
// render returns cleanly to the edit pose (simulate is transient view-state — it
// never mutates the document). Browser OCCT lowering → @plastiq/sim spawn/step →
// render-back, end to end.

import { expect, test } from "@playwright/test";
import type { Vec3, Quat } from "../../apps/plastiq/src/assembly/model.js";

interface SimApi {
  start: () => Promise<number>;
  step: (n: number) => void;
  rewind: () => void;
  poseOf: (id: string) => { position: Vec3; orientation: Quat } | null;
  stop: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { faceCount?: () => number }).faceCount = () => {
      const scene = (
        globalThis as {
          __plastiqViewport?: { builtPart: { mesh: { userData: { faceIds?: number[] } } } | null };
        }
      ).__plastiqViewport;
      return scene?.builtPart?.mesh.userData.faceIds?.length ?? 0;
    };
  });
});

test("simulate the part: it drops under gravity, then returns to edit cleanly", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  // Spawn the bare part into the sim under the default experiment recipe
  // (drop-test: part + static ground). Record initial height. CAD frame is Z-up;
  // gravity pulls along −Z (the body's vertical axis is position[2]).
  const start = await page.evaluate(async () => {
    const sim = (globalThis as { __plastiqSimulate?: SimApi }).__plastiqSimulate!;
    const count = await sim.start();
    return { count, z0: sim.poseOf("body0")?.position[2] ?? null };
  });
  // Default drop-test experiment: CAD body + injected __experiment_ground.
  expect(start.count).toBeGreaterThanOrEqual(1);
  expect(start.z0).not.toBeNull();

  // Step a fixed number of ticks under gravity (deterministic).
  const z1 = await page.evaluate(() => {
    const sim = (globalThis as { __plastiqSimulate?: SimApi }).__plastiqSimulate!;
    sim.step(240);
    return sim.poseOf("body0")?.position[2] ?? null;
  });
  expect(z1).not.toBeNull();
  expect(z1!).toBeLessThan(start.z0! - 1e-3); // the body fell along −Z

  // Stop → the render returns to the edit pose; the document is untouched.
  await page.evaluate(() => {
    (globalThis as { __plastiqSimulate?: SimApi }).__plastiqSimulate!.stop();
  });
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  const editY = await page.evaluate(() => {
    const scene = (
      globalThis as {
        __plastiqViewport?: { builtPart: { group: { position: { y: number } } } | null };
      }
    ).__plastiqViewport;
    return scene?.builtPart?.group.position.y ?? null;
  });
  expect(editY).not.toBeNull();
  expect(Math.abs(editY!)).toBeLessThan(1e-6); // back at the edit pose, not fallen
});

// snapshot + restore through the REAL in-browser default backend (MuJoCo). Simulator
// captures a snapshot at start(); rewind() restores it via PredictionSim.restore() →
// the backend's restore (MuJoCo's WeakMap-keyed native qpos/qvel path). We drop the
// part, confirm it fell, rewind, and assert it returns to the EXACT spawned height —
// proving snapshot/restore round-trips end-to-end in the browser, not just in unit
// tests. (Restore is exact, so the body returns to its captured pose precisely.)
test("rewind restores the spawned pose (snapshot/restore round-trip, MuJoCo default)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  const r = await page.evaluate(async () => {
    const sim = (globalThis as { __plastiqSimulate?: SimApi }).__plastiqSimulate!;
    await sim.start(); // captures the spawn snapshot
    const z0 = sim.poseOf("body0")?.position[2] ?? null;
    sim.step(240); // fall under gravity
    const zFell = sim.poseOf("body0")?.position[2] ?? null;
    sim.rewind(); // restore the captured snapshot
    const zBack = sim.poseOf("body0")?.position[2] ?? null;
    sim.stop();
    return { z0, zFell, zBack };
  });

  expect(r.z0).not.toBeNull();
  expect(r.zFell).not.toBeNull();
  expect(r.zBack).not.toBeNull();
  expect(r.zFell!).toBeLessThan(r.z0! - 1e-3); // it genuinely fell while stepping
  expect(r.zBack!).toBeCloseTo(r.z0!, 6); // rewind restored the exact spawned height
});
