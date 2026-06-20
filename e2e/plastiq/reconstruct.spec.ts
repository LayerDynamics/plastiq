// SPEC-7 R6.7b — browser reconstruction E2E (no mocks): a generated MESH document is
// converted to an editable B-rep CAD part through the WHOLE real stack — browser →
// GenerationPanel "Convert to CAD" → reconstruct.ts client → HTTP → the running pythonOCC
// service → STEP → kernel importStep (real OCCT in the worker) → rendered B-rep part.
//
// Gated on the reconstruction service being reachable (RECONSTRUCT_URL, default
// http://127.0.0.1:8000), so CI without it skips cleanly. This is the model-free
// reconstruction E2E — NOT the AI generation E2E. Run it with the service up:
//   (svc)  cd services/reconstruct && <env>/bin/python -m uvicorn app.main:app --port 8000
//   (e2e)  pnpm e2e --grep reconstruct

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const RECONSTRUCT_URL = process.env.RECONSTRUCT_URL ?? "http://127.0.0.1:8000";

declare global {
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

async function serviceReachable(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(`${RECONSTRUCT_URL}/health`, { signal: ctl.signal });
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

test("convert a generated mesh document into an editable B-rep part via the service", async ({ page }) => {
  test.skip(!(await serviceReachable()), `reconstruct service not reachable at ${RECONSTRUCT_URL}`);

  const glbBase64 = readFileSync(
    fileURLToPath(new URL("../../services/reconstruct/tests/fixtures/cylinder.glb", import.meta.url)),
  ).toString("base64");

  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Open a generated MESH document and point the client at the running service.
  await page.evaluate(
    async ({ glb, url }) => {
      const ai = (globalThis as { __aiStore?: { getState: () => { save: (s: unknown) => Promise<void> } } }).__aiStore!;
      await ai.getState().save({
        providerKey: "ollama",
        providerId: "openai-compatible",
        model: "qwen2.5",
        apiKeys: {},
        reconstructBaseURL: url,
      });
      const projects = (globalThis as { __projectsStore?: { setState: (s: unknown) => void } }).__projectsStore!;
      projects.setState({
        activeMeshDoc: { kind: "mesh", name: "Gen Cylinder", glb, source: { mode: "text3d", providerId: "fal:tripo" } },
      });
    },
    { glb: glbBase64, url: RECONSTRUCT_URL },
  );

  // The panel shows the mesh-convert action for a mesh document; run it.
  await page.getByTestId("mesh-convert-run").click();

  // Reconstruction (server) → STEP → importStep document → real OCCT rebuild → a B-rep part.
  await page.waitForFunction(() => faceCount() > 0, undefined, { timeout: 240_000 });
  expect(await page.evaluate(() => faceCount())).toBeGreaterThan(0);
});
