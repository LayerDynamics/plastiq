// Phase 4 strict E2E: a visible sculpt session edits an SDF through real canvas
// input, stages its marching-cubes surface, reconstructs that mesh through the
// live pythonOCC HTTP service, imports the returned STEP through the real OCCT
// worker, and applies a parametric Scale feature to the reconstructed body.
// No browser, geometry, network, or persistence component is mocked.

import { expect, test } from "@playwright/test";

const RECONSTRUCT_URL = process.env.RECONSTRUCT_URL ?? "http://127.0.0.1:8000";

type SculptState = {
  doc: { version?: number; cells: number[]; sdf?: { field: number[] } } | null;
  past: unknown[];
};

type CadState = {
  features: { type: string }[];
  featureErrors: Record<string, string>;
};

type TestGlobal = typeof globalThis & {
  __voxelStore: { getState(): SculptState };
  __cadStore: { getState(): CadState };
  __aiStore: { getState(): { save(settings: unknown): Promise<void> } };
  __plastiqViewport?: { builtPart?: unknown };
};

async function serviceReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const response = await fetch(`${RECONSTRUCT_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

test("sculpt → marching-cubes mesh → real CAD reconstruction → parametric feature", async ({
  page,
}) => {
  test.skip(!(await serviceReachable()), `reconstruct service not reachable at ${RECONSTRUCT_URL}`);

  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.evaluate(async (url) => {
    await (globalThis as TestGlobal).__aiStore.getState().save({
      providerKey: "ollama",
      providerId: "openai-compatible",
      model: "qwen2.5",
      apiKeys: {},
      reconstructBaseURL: url,
    });
  }, RECONSTRUCT_URL);

  // Enter through visible product controls and select a real SDF brush.
  await page.getByTestId("workspace-switcher").selectOption("sculpt");
  await page.getByTestId("act-voxel-new").click();
  await expect(page.getByTestId("voxel-mode-indicator")).toBeVisible();
  await page.getByTestId("act-voxel-brush-draw").click();
  await page.getByTestId("sculpt-mirror-x").check();

  const before = await page.evaluate(
    () => (globalThis as TestGlobal).__voxelStore.getState().doc?.cells.length ?? 0,
  );
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 18, y - 12, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (globalThis as TestGlobal).__voxelStore.getState();
        return {
          version: state.doc?.version,
          cells: state.doc?.cells.length ?? 0,
          field: state.doc?.sdf?.field.length ?? 0,
          history: state.past.length,
        };
      }),
    )
    .toMatchObject({ version: 2, history: 1 });
  const sculpted = await page.evaluate(() => {
    const state = (globalThis as TestGlobal).__voxelStore.getState();
    return {
      cells: state.doc?.cells.length ?? 0,
      field: state.doc?.sdf?.field.length ?? 0,
    };
  });
  expect(sculpted.cells).not.toBe(before);
  expect(sculpted.field).toBeGreaterThan(0);

  // The visible handoff stages the exact marching-cubes mesh shown in the canvas.
  await page.getByTestId("act-voxel-convert-cad").click();
  await expect(page.getByTestId("mesh-convert-run")).toBeVisible();
  await expect(page.getByTestId("act-mesh-smooth")).toBeEnabled();
  await page.getByTestId("act-mesh-smooth").click();

  // Browser → HTTP → pythonOCC → STEP → worker OCCT. Wait for the returned B-rep.
  await page.getByTestId("mesh-convert-run").click();
  await expect
    .poll(
      () => page.evaluate(() => (globalThis as TestGlobal).__plastiqViewport?.builtPart != null),
      { timeout: 240_000 },
    )
    .toBe(true);
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Apply a normal timeline feature to prove the reconstructed body has rejoined
  // the parametric editor rather than ending as an opaque display-only artifact.
  await page.getByTestId("act-scale").click();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  const result = await page.evaluate(() => {
    const state = (globalThis as TestGlobal).__cadStore.getState();
    return {
      types: state.features.map((feature) => feature.type),
      errors: state.featureErrors,
      rendered: (globalThis as TestGlobal).__plastiqViewport?.builtPart != null,
    };
  });
  expect(result.types).toContain("importStep");
  expect(result.types.at(-1)).toBe("scale");
  expect(result.errors).toEqual({});
  expect(result.rendered).toBe(true);
});
