// SPEC-5 M6.1 — strict E2E (no mocks): the pluggable physics layer has THREE
// interchangeable backends (Rapier, ammo.js/Bullet, cannon-es). simulate.spec
// already proves the default (Rapier) end-to-end in the browser; this proves the
// OTHER two actually run in-browser: switch the backend, lower the seeded part to
// a SimManifest via the real OCCT worker, spawn/step it in the REAL @plastiq/sim
// (ammo's wasm / cannon's pure JS), and assert the body falls under gravity.

import { expect, test } from "@playwright/test";
import type { Vec3, Quat } from "../../apps/cad-studio/src/assembly/model.js";

type BackendName = "rapier" | "ammo" | "cannon";

interface SimApi {
  start: () => Promise<number>;
  step: (n: number) => void;
  poseOf: (id: string) => { position: Vec3; orientation: Quat } | null;
  stop: () => void;
  setBackend: (name: BackendName) => void;
  backend: () => BackendName | null;
}

for (const backend of ["ammo", "cannon"] as const) {
  test(`simulate on the ${backend} backend: the part drops under gravity in-browser`, async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
    await page.waitForFunction(
      () =>
        (globalThis as { __cadStudioScene?: { builtPart: unknown } }).__cadStudioScene
          ?.builtPart != null,
      undefined,
      { timeout: 240_000 },
    );

    // Select the backend, spawn the bare part, record its start height. The CAD
    // frame is Z-up, so gravity pulls along −Z (vertical axis = position[2]).
    const start = await page.evaluate(async (name) => {
      const sim = (globalThis as { __cadStudioSimulate?: SimApi }).__cadStudioSimulate!;
      sim.setBackend(name);
      const count = await sim.start();
      return { count, active: sim.backend(), z0: sim.poseOf("body0")?.position[2] ?? null };
    }, backend);

    // The REAL selected backend is active (not silently the Rapier default).
    expect(start.active).toBe(backend);
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

    // Stop cleanly (simulate is transient view state; the document is untouched).
    await page.evaluate(() => {
      (globalThis as { __cadStudioSimulate?: SimApi }).__cadStudioSimulate!.stop();
    });
  });
}
