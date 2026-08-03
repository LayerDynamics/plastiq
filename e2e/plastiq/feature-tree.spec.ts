// SPEC-5 M2.6 — strict E2E (no mocks): the feature-tree + parametric-feature
// flow. CAD Studio loads in a real browser; the worker builds the seeded box
// with real OCCT; then real toolbar clicks add a Sketch + a Cut, and the tree +
// the rebuilt three.js solid update. We then exercise rollback (suppress
// everything below a point) and suppress on a single feature, asserting the
// kernel re-evaluates each time. Face counts come from the live tagged mesh.

import { expect, test } from "@playwright/test";

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

async function waitReady(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
}

async function addPocket(page: import("@playwright/test").Page): Promise<void> {
  const featureMenu = page.getByTestId("feature-menu");
  await featureMenu.getByTestId("act-sample-rect").click();
  await featureMenu.getByText("Cut", { exact: true }).click();
  await expect(page.getByTestId("feature-row")).toHaveCount(3);
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
}

test("add sketch+cut → pocket; rollback and suppress re-evaluate the kernel", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  // The seeded box: 6 faces, one feature row.
  await expect(page.getByTestId("feature-row")).toHaveCount(1);
  expect(await page.evaluate(() => faceCount())).toBe(6);

  // Add a Sketch then a Cut via the real toolbar menu.
  const fm = page.getByTestId("feature-menu");
  // "Rectangle" (sample-rect) injects a profile WITHOUT opening the sketcher, so
  // the following Cut has a profile to pocket. "Sketch" now opens the sketcher.
  await fm.getByTestId("act-sample-rect").click();
  await fm.getByText("Cut", { exact: true }).click();

  // Three features now; the cut pockets the box → more than 6 faces.
  await expect(page.getByTestId("feature-row")).toHaveCount(3);
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
  const pocketFaces = await page.evaluate(() => faceCount());
  expect(pocketFaces).toBeGreaterThan(6);

  // Roll back to before the cut (index 2): the pocket disappears, box is back.
  const cutRow = page.getByTestId("feature-row").nth(2);
  await cutRow.hover();
  await cutRow.getByTitle("Roll back to before this feature").click();
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  await expect(page.getByTestId("rollback-resume")).toBeVisible();

  // Resume: the cut re-applies.
  await page.getByTestId("rollback-resume").click();
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });

  // Suppress the cut: the pocket disappears again, tree keeps the (off) feature.
  await cutRow.hover();
  await cutRow.getByTitle("Suppress").click();
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  await expect(page.getByTestId("feature-row")).toHaveCount(3);
});

test("right-click context menu: unsuppress then delete a feature (FR-27)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  // Build box → sketch → cut as before.
  const fm = page.getByTestId("feature-menu");
  // "Rectangle" (sample-rect) injects a profile WITHOUT opening the sketcher, so
  // the following Cut has a profile to pocket. "Sketch" now opens the sketcher.
  await fm.getByTestId("act-sample-rect").click();
  await fm.getByText("Cut", { exact: true }).click();
  await expect(page.getByTestId("feature-row")).toHaveCount(3);
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });

  const cutRow = page.getByTestId("feature-row").nth(2);
  // Right-click → Suppress via the context menu: pocket disappears.
  await cutRow.click({ button: "right" });
  await expect(page.getByTestId("feature-context-menu")).toBeVisible();
  await page.getByTestId("ctx-suppress").click();
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  await expect(page.getByTestId("feature-context-menu")).toHaveCount(0);

  // Right-click → Unsuppress: pocket returns.
  await cutRow.click({ button: "right" });
  await page.getByTestId("ctx-suppress").click(); // label is now "Unsuppress"
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });

  // Right-click → Delete: the cut row is gone, box is back to 6 faces.
  await cutRow.click({ button: "right" });
  await page.getByTestId("ctx-delete").click();
  await waitReady(page);
  await expect(page.getByTestId("feature-row")).toHaveCount(2);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
});

test("rollback governs STEP export and the real Simulate workspace", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  await addPocket(page);

  const fullMass = await page.evaluate(async () => {
    const lower = (globalThis as { __plastiqLower?: () => Promise<unknown> }).__plastiqLower!;
    const result = (await lower()) as { manifest: { bodies: { mass: number }[] } };
    return result.manifest.bodies[0]!.mass;
  });

  // Roll back before the cut. The rendered body and lower/export input are now
  // the original six-face box, while the pocket feature remains in history.
  const cutRow = page.getByTestId("feature-row").nth(2);
  await cutRow.hover();
  await cutRow.getByTitle("Roll back to before this feature").click();
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  const rolledMass = await page.evaluate(async () => {
    const lower = (globalThis as { __plastiqLower?: () => Promise<unknown> }).__plastiqLower!;
    const result = (await lower()) as { manifest: { bodies: { mass: number }[] } };
    return result.manifest.bodies[0]!.mass;
  });
  expect(rolledMass).toBeGreaterThan(fullMass);

  // Export through the user-facing action while rollback is active.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("act-export-step").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const rolledStep = Buffer.concat(chunks);
  expect(rolledStep.byteLength).toBeGreaterThan(1_000);
  await expect(page.getByTestId("status")).toHaveText("exported STEP", { timeout: 240_000 });

  // Entering the real Simulate workspace must start a world from that same
  // rolled-back document, not from the hidden pocket feature.
  await page.getByTestId("workspace-switcher").selectOption("simulate");
  await expect(page.getByTestId("workspace-switcher")).toHaveValue("simulate");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              globalThis as {
                __plastiqSimulate?: { poseOf: (id: string) => unknown | null };
              }
            ).__plastiqSimulate?.poseOf("body0") ?? null,
        ),
      { timeout: 240_000 },
    )
    .not.toBeNull();
  await page.getByTestId("workspace-switcher").selectOption("design");
  await expect(page.getByTestId("workspace-switcher")).toHaveValue("design");

  // Resume the history, then import the downloaded file through the real file
  // chooser. Import replaces the accumulated solid, so six faces proves that
  // the exported STEP contained the visible rollback body, not the hidden cut.
  await page.getByTestId("rollback-resume").click();
  await waitReady(page);
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("act-import-step").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "rollback.step",
    mimeType: "application/step",
    buffer: rolledStep,
  });
  await expect(page.getByTestId("feature-row")).toHaveCount(4);
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
});

test("IGES export → file chooser import round-trips the real OCCT body", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  await expect(page.getByTestId("feature-row")).toHaveCount(1);
  const baseVolume = await page.evaluate(
    () =>
      (
        globalThis as {
          __cadStore?: { getState: () => { massProps: { volume: number } | null } };
        }
      ).__cadStore!.getState().massProps!.volume,
  );

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("act-export-iges").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const iges = Buffer.concat(chunks);
  expect(iges.byteLength).toBeGreaterThan(1_000);
  await expect(page.getByTestId("status")).toHaveText("exported IGES", { timeout: 240_000 });

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("act-import-iges").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "roundtrip.iges",
    mimeType: "application/iges",
    buffer: iges,
  });
  await expect(page.getByTestId("feature-row")).toHaveCount(2);
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });

  const imported = await page.evaluate(() => {
    const state = (
      globalThis as {
        __cadStore?: {
          getState: () => {
            features: { type: string; name?: string; data?: Record<string, unknown> }[];
            massProps: { volume: number } | null;
            featureErrors: Record<string, string>;
          };
        };
      }
    ).__cadStore!.getState();
    const feature = state.features.at(-1)!;
    return {
      type: feature.type,
      name: feature.name,
      sourceLength: typeof feature.data?.iges === "string" ? feature.data.iges.length : 0,
      volume: state.massProps!.volume,
      errors: state.featureErrors,
    };
  });
  expect(imported.type).toBe("importIges");
  expect(imported.name).toBe("roundtrip.iges");
  expect(imported.sourceLength).toBeGreaterThan(1_000);
  expect(imported.volume).toBeCloseTo(baseVolume, 10);
  expect(imported.errors).toEqual({});
});
