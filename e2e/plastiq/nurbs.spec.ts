// SPEC-12 U9.4 — browser NURBS-fit E2E (no mocks): a generated MESH document is fitted into an
// editable B-rep CAD part through the WHOLE real stack — browser → GenerationPanel
// MeshConvertSection "Fit smooth CAD (NURBS)" → nurbs.ts adapter (fitMeshToCad) → @plastiq/nurbs
// client → HTTP → the running MLX NURBS service (real least-squares surface fitting + in-service
// OCCT → STEP) → kernel stepToImportDocument → importStep (real OCCT in the worker) → a rendered
// B-rep part. This is the smooth/organic sibling of reconstruct.spec.ts (which drives the analytic
// mesh→B-rep path); both land through the SAME STEP → importStep landing, so the assertion is the
// same: the fitted STEP re-imports as a solid with faceCount > 0.
//
// Gated on the nurbs service being reachable (NURBS_URL, default http://localhost:8003 — the
// documented dev port / NURBS_DEFAULT_BASE_URL), so CI without it skips cleanly (the
// reconstruct.spec.ts precedent). Run it with the service up:
//   (svc)  mamba run -n plastiq-nurbs uvicorn app.main:app --port 8003   (or: just services)
//   (e2e)  pnpm e2e --grep nurbs
//
// The fixture is the service's marquee case: blob.glb — a closed, genus-0 organic mesh (the U7
// watertight-blob gate). The panel passes no fit knobs, so the service runs its deterministic
// defaults (mode=auto → closed, degree 3, grid 16, iters 0 — pure LSQ, no gradient refinement),
// which fits in seconds and produces a watertight all-NURBS solid → STEP.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const NURBS_URL = process.env.NURBS_URL ?? "http://localhost:8003";

declare global {
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

async function serviceReachable(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(`${NURBS_URL}/health`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { faceCount?: () => number }).faceCount = () => {
      const vp = (
        globalThis as { __plastiqViewport?: { builtPart: { mesh: { userData: { faceIds?: number[] } } } | null } }
      ).__plastiqViewport;
      return vp?.builtPart?.mesh.userData.faceIds?.length ?? 0;
    };
  });
});

test("fit a generated mesh document into an editable B-rep part via the NURBS service", async ({ page }) => {
  test.skip(!(await serviceReachable()), `nurbs service not reachable at ${NURBS_URL}`);

  const glbBase64 = readFileSync(
    fileURLToPath(new URL("../../services/nurbs/tests/fixtures/blob.glb", import.meta.url)),
  ).toString("base64");

  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Open a generated MESH document and point the nurbs client at the running service (the
  // fitSmooth handler reads settings.nurbsBaseURL for both the /health pre-flight and the fit).
  await page.evaluate(
    async ({ glb, url }) => {
      const ai = (globalThis as { __aiStore?: { getState: () => { save: (s: unknown) => Promise<void> } } }).__aiStore!;
      await ai.getState().save({
        providerKey: "ollama",
        providerId: "openai-compatible",
        model: "qwen2.5",
        apiKeys: {},
        nurbsBaseURL: url,
      });
      const projects = (globalThis as { __projectsStore?: { setState: (s: unknown) => void } }).__projectsStore!;
      projects.setState({
        activeMeshDoc: { kind: "mesh", name: "Gen Blob", glb, source: { mode: "text3d", providerId: "fal:tripo" } },
      });
    },
    { glb: glbBase64, url: NURBS_URL },
  );

  // The panel shows the mesh section for a mesh document; run the smooth/organic NURBS-fit action.
  await page.getByTestId("mesh-nurbs-run").click();

  // NURBS fitting (server) → STEP → importStep document → real OCCT rebuild → a B-rep part.
  await page.waitForFunction(() => faceCount() > 0, undefined, { timeout: 240_000 });
  expect(await page.evaluate(() => faceCount())).toBeGreaterThan(0);
});
