// SPEC-5 M5.5 — strict E2E (no mocks): save a project to the in-browser SQLite
// store, RELOAD the page (the SQLite image survives in IndexedDB), reopen the
// project, rebuild with real OCCT, and assert the document round-trips
// byte-identically AND the rebuilt geometry matches (FR-37/FR-39 / NFR-2).

import { expect, test } from "@playwright/test";

declare global {
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

interface ProjectsApi {
  getState: () => {
    init: () => Promise<void>;
    saveAs: (name: string) => Promise<void>;
    open: (id: string) => Promise<void>;
    list: { id: string; name: string }[];
    currentName: string;
  };
}
interface DocApi {
  getState: () => {
    toDocument: () => unknown;
    updateParams: (id: string, p: Record<string, number>) => void;
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { faceCount?: () => number }).faceCount = () => {
      const scene = (
        globalThis as {
          __plastiqScene?: { builtPart: { mesh: { userData: { faceIds?: number[] } } } | null };
        }
      ).__plastiqScene;
      return scene?.builtPart?.mesh.userData.faceIds?.length ?? 0;
    };
  });
});

test("save a project → reload the page → reopen → byte-identical doc + geometry", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Make the document distinctive (resize the seeded box) and save it.
  const savedDoc = await page.evaluate(async () => {
    const projects = (globalThis as { __projectsStore?: ProjectsApi }).__projectsStore!;
    const doc = (globalThis as { __cadStore?: DocApi }).__cadStore!;
    await projects.getState().init();
    doc.getState().updateParams("f1", { dx: 0.075 }); // distinctive width
    await projects.getState().saveAs("RoundTrip");
    return JSON.stringify(doc.getState().toDocument());
  });
  expect(savedDoc).toContain("0.075");

  // Reload — IndexedDB (and thus the SQLite image) persists across the reload.
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Reopen the saved project and rebuild.
  const reloadedDoc = await page.evaluate(async () => {
    const projects = (globalThis as { __projectsStore?: ProjectsApi }).__projectsStore!;
    const doc = (globalThis as { __cadStore?: DocApi }).__cadStore!;
    await projects.getState().init();
    const found = projects.getState().list.find((p) => p.name === "RoundTrip");
    if (!found) throw new Error("saved project not found after reload");
    await projects.getState().open(found.id);
    return JSON.stringify(doc.getState().toDocument());
  });

  // Byte-identical document (FR-39).
  expect(reloadedDoc).toBe(savedDoc);

  // And the rebuilt geometry matches (still a 6-faced box).
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
});
