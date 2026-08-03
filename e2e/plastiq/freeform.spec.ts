// Phase 3 strict E2E: user creates a freeform surface, selects and drags a
// rendered control-net pole, commits it, exports the real worker/OCCT body to
// STEP, and re-imports that download through the real file chooser. No component
// or geometry service is mocked. Numeric fitting-tolerance preservation is
// measured against the re-imported face in packages/cad/src/freeform/commit.test.ts.

import { expect, test } from "@playwright/test";

type FreeformFeature = {
  id: string;
  type: string;
  data?: Record<string, unknown>;
};

type CadState = {
  features: FreeformFeature[];
  featureErrors: Record<string, string>;
  status: string;
};

type TestGlobal = typeof globalThis & {
  __cadStore: { getState(): CadState };
  __plastiqViewport?: {
    builtPart?: unknown;
    fitToView?: () => void;
    freeformControlPointPx?: (i: number, j: number) => { x: number; y: number } | null;
    gizmos?: Record<string, boolean>;
  };
};

async function waitReady(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  const errors = await page.evaluate(
    () => (globalThis as TestGlobal).__cadStore.getState().featureErrors,
  );
  expect(errors).toEqual({});
}

test("control-point drag → commit → STEP export → re-import preserves editable freeform", async ({
  page,
}) => {
  await page.goto("/");
  await waitReady(page);

  // Visible product action creates the NURBS plane and selects its feature row.
  await page.getByTestId("act-freeform-plane").click();
  await waitReady(page);
  await expect(page.getByTestId("freeform-control-net-help")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as TestGlobal).__plastiqViewport?.gizmos?.freeformControlNet === true,
      ),
    )
    .toBe(true);

  // The read-only projection seam locates the rendered pole; the click itself is
  // a real canvas pointer event handled by the r3f sphere.
  const pole = await page.evaluate(() =>
    (globalThis as TestGlobal).__plastiqViewport?.freeformControlPointPx?.(1, 1),
  );
  expect(pole).not.toBeNull();
  await page.mouse.click(pole!.x, pole!.y);
  await expect(page.getByTestId("freeform-control-point-editor")).toBeVisible();

  // Drag the rendered pole's Z scrub 60 px upward = +6 mm. The preview is pure
  // TypeScript during motion; pointer-up performs the single document commit.
  const drag = page.getByTestId("freeform-control-point-drag");
  const dragBox = await drag.boundingBox();
  expect(dragBox).not.toBeNull();
  const x = dragBox!.x + dragBox!.width / 2;
  const y = dragBox!.y + dragBox!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 12 });
  await page.mouse.up();
  await waitReady(page);

  const committed = await page.evaluate(() => {
    const state = (globalThis as TestGlobal).__cadStore.getState();
    const feature = state.features.find((candidate) => candidate.type === "freeform")!;
    const surface = feature.data?.["surface"] as { controlNet: number[][][] };
    return {
      count: state.features.length,
      kind: feature.data?.["kind"],
      z: surface.controlNet[1]![1]![2],
      errors: state.featureErrors,
    };
  });
  expect(committed.errors).toEqual({});
  expect(committed.kind).toBe("custom");
  expect(committed.z).toBeCloseTo(0.006, 6);

  // Real browser download and file chooser drive worker → OCCT STEP writer →
  // OCCT reader. The imported feature must build without losing the edited one.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("act-export-step").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const step = Buffer.concat(chunks);
  expect(step.byteLength).toBeGreaterThan(1_000);

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("act-import-step").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "edited-freeform.step",
    mimeType: "application/step",
    buffer: step,
  });
  await waitReady(page);

  const roundTrip = await page.evaluate(() => {
    const state = (globalThis as TestGlobal).__cadStore.getState();
    return {
      types: state.features.map((feature) => feature.type),
      errors: state.featureErrors,
      rendered: (globalThis as TestGlobal).__plastiqViewport?.builtPart != null,
    };
  });
  expect(roundTrip.errors).toEqual({});
  expect(roundTrip.types).toContain("freeform");
  expect(roundTrip.types.at(-1)).toBe("importStep");
  expect(roundTrip.rendered).toBe(true);
});
