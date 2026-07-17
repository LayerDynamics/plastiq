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
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  // Insert two instances and mate them with the kernel mate solver. The first
  // instance is grounded (addInstance sets `fixed` on instance 0 — the assembly's
  // ground), the second is free.
  const { groundedId, freeId } = await page.evaluate(() => {
    const store = (globalThis as { __cadStore?: StoreApi }).__cadStore!;
    const st = store.getState();
    const a = st.addInstance();
    const b = st.addInstance();
    st.setMateMode(true);
    st.addMatePick({ instanceId: a, faceId: 1, worldPoint: [0.03, 0.02, 0.03] });
    st.addMatePick({ instanceId: b, faceId: 2, worldPoint: [0.05, 0.02, 0.03] });
    st.applyMate("coincident");
    return { groundedId: a, freeId: b };
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
  // Track both bodies: the grounded one must stay put, the free one must fall.
  const result = await page.evaluate(
    async (ids) => {
      const sim = (globalThis as { __plastiqSimulate?: SimApi }).__plastiqSimulate!;
      const count = await sim.start();
      const groundedZ0 = sim.poseOf(ids.groundedId)?.position[2] ?? null;
      const freeZ0 = sim.poseOf(ids.freeId)?.position[2] ?? null;
      sim.step(180);
      const groundedZ1 = sim.poseOf(ids.groundedId)?.position[2] ?? null;
      const freeZ1 = sim.poseOf(ids.freeId)?.position[2] ?? null;
      return { count, groundedZ0, freeZ0, groundedZ1, freeZ1 };
    },
    { groundedId, freeId },
  );

  // Three sim bodies: the two instances PLUS the static ground slab that the
  // DEFAULT experiment (kind "drop-test", ground: true — see
  // sim/experiments.ts DEFAULT_SIM_EXPERIMENT) injects under the lowest body via
  // applyExperiment(). __plastiqLower returns the RAW 2-body manifest (asserted
  // above); the simulate path runs it through applyExperiment first, which is why
  // the spawned count is one greater. Both instances are individually confirmed
  // present by their non-null poses below.
  expect(result.count).toBe(3);
  expect(result.freeZ0).not.toBeNull();
  expect(result.groundedZ0).not.toBeNull();
  // The free body fell under gravity (−Z); the grounded body (instance 0, `fixed`)
  // held its pose — proving ground/fixed lowering reaches the real sim.
  expect(result.freeZ1!).toBeLessThan(result.freeZ0! - 1e-3);
  expect(Math.abs(result.groundedZ1! - result.groundedZ0!)).toBeLessThan(1e-6);
});
