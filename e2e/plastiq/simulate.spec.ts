// SPEC-5 M6.1 — strict E2E (no mocks): in-editor Simulate (FR-41). The seeded
// part is lowered to a SimManifest and dropped/run in the REAL in-browser
// @plastiq/sim; the live body pose drives the render. We start the sim, step a
// fixed number of ticks, assert the body fell under gravity, then Stop and
// assert the render returns cleanly to the edit pose (simulate is transient
// view-state — it never mutates the document). Browser OCCT lowering →
// @plastiq/sim spawn/step → render-back, end to end.

import { expect, test } from "@playwright/test";
import type { Vec3, Quat } from "../../apps/plastiq/src/assembly/model.js";

interface SimApi {
  start: () => Promise<number>;
  step: (n: number) => void;
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
          __cadStudioScene?: { builtPart: { mesh: { userData: { faceIds?: number[] } } } | null };
        }
      ).__cadStudioScene;
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
      (globalThis as { __cadStudioScene?: { builtPart: unknown } }).__cadStudioScene?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  // Spawn the bare part into the sim; record its initial height. The CAD frame is
  // Z-up, so gravity pulls along −Z (the body's vertical axis is position[2]).
  const start = await page.evaluate(async () => {
    const sim = (globalThis as { __cadStudioSimulate?: SimApi }).__cadStudioSimulate!;
    const count = await sim.start();
    return { count, z0: sim.poseOf("body0")?.position[2] ?? null };
  });
  expect(start.count).toBe(1); // bare part → one body
  expect(start.z0).not.toBeNull();

  // Step a fixed number of ticks under gravity (deterministic).
  const z1 = await page.evaluate(() => {
    const sim = (globalThis as { __cadStudioSimulate?: SimApi }).__cadStudioSimulate!;
    sim.step(240);
    return sim.poseOf("body0")?.position[2] ?? null;
  });
  expect(z1).not.toBeNull();
  expect(z1!).toBeLessThan(start.z0! - 1e-3); // the body fell along −Z

  // Stop → the render returns to the edit pose; the document is untouched.
  await page.evaluate(() => {
    (globalThis as { __cadStudioSimulate?: SimApi }).__cadStudioSimulate!.stop();
  });
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  const editY = await page.evaluate(() => {
    const scene = (
      globalThis as {
        __cadStudioScene?: { builtPart: { group: { position: { y: number } } } | null };
      }
    ).__cadStudioScene;
    return scene?.builtPart?.group.position.y ?? null;
  });
  expect(editY).not.toBeNull();
  expect(Math.abs(editY!)).toBeLessThan(1e-6); // back at the edit pose, not fallen
});
