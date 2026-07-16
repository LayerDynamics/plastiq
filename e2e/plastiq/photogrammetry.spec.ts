// SPEC-13 P12.1 — browser photogrammetry E2E (no mocks): unposed photos become an editable mesh
// document through the WHOLE real stack — browser → GenerationPanel PhotoSolveSection →
// @plastiq/photogrammetry client → HTTP → the running SfM+MVS service (real feature/matching/BA +
// MLX plane-sweep MVS) → dense oriented cloud → @plastiq/capture → the running capture service
// (real MLX SDF fit) → GLB → MeshDoc → the project opens → the mesh renders in the viewport.
// Mirrors the nerf.spec.ts precedent: reachability probes gate the test, so CI without the services
// skips cleanly; when they ARE up it drives the real UI end to end with no mocks.
//
// LIVE-GATED (cannot run in headless CI). It requires THREE things present, and skips cleanly
// otherwise — matching the P7 real-photo gate's honesty (the texture-poor committed synthetic scene
// cannot be reconstructed by the full real-feature SfM pipeline, so a *successful* solve needs real
// photos; see services/photogrammetry/tests/test_api.py for the headless degradation-path coverage):
//   1. the photogrammetry service reachable (PHOTOGRAMMETRY_URL, default http://localhost:8004),
//   2. the capture service reachable (CAPTURE_URL, default http://localhost:8001) — the dense
//      hand-off's reconstruction backend, and
//   3. a real photo dataset on disk (ref/Photogrammetry-examples/**, gitignored/local-only).
// Run it on the M4 Max with the services up:
//   (svc)  just services                       # brings up :8004 + :8001 (+ the others)
//   (e2e)  pnpm e2e --grep photogrammetry
//
// The nerf-prefill leg (hand-off a) is exercised in the unit tests (GenerationPanel.photo.test.tsx);
// this live E2E drives the dense-cloud → capture → CAD leg (hand-off b), the fuller real-stack path.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const PHOTOGRAMMETRY_URL = process.env.PHOTOGRAMMETRY_URL ?? "http://localhost:8004";
const CAPTURE_URL = process.env.CAPTURE_URL ?? "http://localhost:8001";

declare global {
  // eslint-disable-next-line no-var
  var meshBodyCount: () => number;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(`${url}/health`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Locate a real photo dataset (`ref/Photogrammetry-examples/<set>/images`, local-only) and return up
 * to `max` JPEG buffers, or null when none is present (→ the test skips). Stone_Mask (14) is the
 * smallest gate set; Gorsedd_Stone / Pear are fuller fallbacks. */
function loadPhotos(max: number): { name: string; buffer: Buffer }[] | null {
  const root = path.resolve(process.cwd(), "ref/Photogrammetry-examples");
  for (const set of ["Stone_Mask", "Gorsedd_Stone", "Pear"]) {
    const dir = path.join(root, set, "images");
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir)
      .filter((n) => /\.(jpe?g)$/i.test(n))
      .sort()
      .slice(0, max);
    if (names.length >= 3) {
      return names.map((name) => ({ name, buffer: readFileSync(path.join(dir, name)) }));
    }
  }
  return null;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { meshBodyCount?: () => number }).meshBodyCount = () => {
      const vp = (globalThis as { __plastiqViewport?: { meshBodyCount?: number } }).__plastiqViewport;
      return vp?.meshBodyCount ?? 0;
    };
  });
});

test("solve unposed photos into poses + a dense cloud, then reconstruct it to an editable mesh document", async ({
  page,
}) => {
  // Skip FIRST — before any work — so a missing service/dataset is a clean green skip, never an error.
  test.skip(!(await reachable(PHOTOGRAMMETRY_URL)), `photogrammetry service not reachable at ${PHOTOGRAMMETRY_URL}`);
  test.skip(!(await reachable(CAPTURE_URL)), `capture service not reachable at ${CAPTURE_URL}`);
  const photos = loadPhotos(16);
  test.skip(photos === null, "no ref/Photogrammetry-examples dataset on disk (local-only P7 gate photos)");

  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Seed AI settings so the panel is past first-run (shows the generation view + PhotoSolveSection)
  // and point the photogrammetry + capture clients at the running services.
  await page.evaluate(
    async ({ pgUrl, capUrl }) => {
      const ai = (globalThis as { __aiStore?: { getState: () => { save: (s: unknown) => Promise<void> } } })
        .__aiStore!;
      await ai.getState().save({
        providerKey: "ollama",
        providerId: "openai-compatible",
        model: "qwen2.5",
        apiKeys: {},
        photogrammetryBaseURL: pgUrl,
        captureBaseURL: capUrl,
      });
    },
    { pgUrl: PHOTOGRAMMETRY_URL, capUrl: CAPTURE_URL },
  );

  // Supply the real photos through the section's real multi-file input.
  await page.getByTestId("photo-images-input").setInputFiles(
    photos!.map(({ name, buffer }) => ({ name, mimeType: "image/jpeg", buffer })),
  );

  await expect(page.getByTestId("photo-solve")).toBeVisible();
  await expect(page.getByTestId("photo-solve-btn")).toBeEnabled();

  // Submit → the real service runs SfM + dense MVS (minutes) → poses + a dense oriented cloud.
  await page.getByTestId("photo-solve-btn").click();

  // On success the two hand-off buttons appear; the dense route requires a non-null dense cloud.
  await expect(page.getByTestId("photo-to-mesh-btn")).toBeEnabled({ timeout: 1_200_000 });
  await expect(page.getByTestId("photo-status")).toContainText("registered");

  // Hand-off (b): dense cloud → the capture service reconstructs a watertight mesh → project opens.
  await page.getByTestId("photo-to-mesh-btn").click();

  // The opened MeshDoc renders its bodies in the viewport (Scene publishes meshBodyCount); then the
  // panel switches to Convert-to-CAD — the photos → editable B-rep terminus.
  await page.waitForFunction(() => meshBodyCount() > 0, undefined, { timeout: 1_200_000 });
  await expect(page.getByTestId("mesh-convert")).toBeVisible();
  expect(await page.evaluate(() => meshBodyCount())).toBeGreaterThan(0);
});
