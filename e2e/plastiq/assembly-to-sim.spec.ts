// SPEC-5 M4.5 — strict E2E (no mocks): mate two parts, then lower the assembly
// to the REAL physics sim. In a real browser: insert two instances of the part,
// mate them with the kernel mate solver, lower the assembly to a SimManifest via
// the worker (real OCCT: mass props + COM-frame poses), then spawn that manifest
// into the REAL @plastiq/sim and step it under gravity. Browser OCCT → assembly
// solver → JSON SimManifest → in-browser physics — end to end.

import { expect, test } from "@playwright/test";
// Resolved by relative path (e2e/ is not a package that can import @plastiq/cad).
import { isSimManifest } from "../../packages/cad/src/lower/manifest.js";

interface StoreApi {
  getState: () => {
    addInstance: () => string;
    setMateMode: (on: boolean) => void;
    addMatePick: (p: {
      instanceId: string;
      faceId: number;
      worldPoint: [number, number, number];
    }) => void;
    applyMate: (kind: string) => void;
    assembly: { instances: unknown[]; mates: unknown[] };
  };
}

interface SimApi {
  start: () => Promise<number>;
  step: (n: number) => void;
  poseOf: (id: string) => { position: [number, number, number] } | null;
}

test("mate two parts → lower the assembly → the real sim spawns + steps it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  // The build populated selectionRefs (the box's 6 faces) — needed for addMatePick.
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqScene?: { builtPart: unknown } }).__plastiqScene?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  // Insert two instances and mate them with the kernel mate solver.
  const firstId = await page.evaluate(() => {
    const store = (globalThis as { __cadStore?: StoreApi }).__cadStore!;
    const st = store.getState();
    const a = st.addInstance();
    const b = st.addInstance();
    st.setMateMode(true);
    st.addMatePick({ instanceId: a, faceId: 1, worldPoint: [0.03, 0.02, 0.03] });
    st.addMatePick({ instanceId: b, faceId: 2, worldPoint: [0.05, 0.02, 0.03] });
    st.applyMate("coincident");
    return a;
  });
  await expect(page.getByTestId("instance-row")).toHaveCount(2);

  // Lower the assembly to a SimManifest via the worker (real OCCT).
  const manifest = await page.evaluate(async () => {
    const lower = (globalThis as { __plastiqLower?: () => Promise<unknown> }).__plastiqLower!;
    const out = (await lower()) as { manifest: unknown };
    return out.manifest;
  });
  expect(isSimManifest(manifest), "lowered assembly must satisfy the manifest contract").toBe(true);
  const m = manifest as { bodies: unknown[] };
  expect(m.bodies).toHaveLength(2); // two instances → two sim bodies

  // Spawn the browser-built manifest into the REAL @plastiq/sim and step it.
  const result = await page.evaluate(async (id) => {
    const sim = (globalThis as { __plastiqSimulate?: SimApi }).__plastiqSimulate!;
    const count = await sim.start();
    const z0 = sim.poseOf(id)?.position[2] ?? null;
    sim.step(180);
    const z1 = sim.poseOf(id)?.position[2] ?? null;
    return { count, z0, z1 };
  }, firstId);

  expect(result.count).toBe(2); // both instances spawned as sim bodies
  expect(result.z0).not.toBeNull();
  expect(result.z1!).toBeLessThan(result.z0! - 1e-3); // the bodies fell under gravity (−Z)
});
