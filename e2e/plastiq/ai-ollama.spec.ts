// SPEC-6 R5.3 — the REAL AI generation E2E (model in the loop, no mocks).
//
// The full stack, end to end: the browser GenerationPanel → a LIVE local Ollama model →
// the agentRunner tool loop → the real build_part handler → mm/deg validation → SI → the
// off-thread OCCT worker → a rendered B-rep part. Nothing is stubbed; the model genuinely
// decides to call build_part and authors the document.
//
// Gated on a reachable Ollama (OLLAMA_URL, default http://localhost:11434) with a
// tool-capable model (OLLAMA_MODEL, default qwen3.6:35b-mlx), so CI without it skips
// cleanly. Run it with Ollama up:
//   OLLAMA_MODEL=qwen3.6:35b-mlx pnpm e2e --grep "real AI"

import { expect, test } from "@playwright/test";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.6:35b-mlx";

declare global {
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

async function ollamaModel(): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: { name?: string }[] };
    const names = (data.models ?? []).map((m) => m.name ?? "");
    if (names.includes(OLLAMA_MODEL)) return OLLAMA_MODEL;
    // Fall back to any installed model if the preferred one isn't present.
    return names[0] ?? null;
  } catch {
    return null;
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

test("a real local model generates a CAD part through the whole stack", async ({ page }) => {
  const model = await ollamaModel();
  test.skip(!model, `Ollama not reachable at ${OLLAMA_URL} (or no models installed)`);
  test.setTimeout(600_000); // a local model's first inference can be slow

  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Point the panel at the live Ollama model (BYO, no key) via the real settings store,
  // AND clear the seeded default box so faceCount() reflects ONLY what the model builds
  // (otherwise the seed's 6 faces would satisfy the render assertion before the AI ran).
  await page.evaluate(
    async ({ url, m }) => {
      const ai = (globalThis as { __aiStore?: { getState: () => { save: (s: unknown) => Promise<void> } } }).__aiStore!;
      await ai.getState().save({
        providerKey: "ollama",
        providerId: "openai-compatible",
        model: m,
        baseURL: `${url}/v1`,
        apiKeys: {},
      });
      const cad = (globalThis as { __cadStore?: { getState: () => { loadDocument: (d: unknown) => void } } }).__cadStore!;
      cad.getState().loadDocument({ features: [], params: {} });
    },
    { url: OLLAMA_URL, m: model },
  );
  await page.waitForFunction(() => faceCount() === 0, undefined, { timeout: 30_000 });

  // Drive the panel exactly as a user would: type a prompt, click Generate.
  await page.getByTestId("generation-prompt").fill("Create a 20 mm cube.");
  await page.getByTestId("generation-send").click();

  // The model decides to call build_part — the visible trace records the real tool call.
  // A local model's inference is slow, so allow several minutes for it to respond.
  await expect(page.getByTestId("generation-transcript")).toContainText("build_part", { timeout: 480_000 });

  // …and that real build flows through OCCT to a rendered solid (faces appear from zero).
  await page.waitForFunction(() => faceCount() > 0, undefined, { timeout: 120_000 });
  expect(await page.evaluate(() => faceCount())).toBeGreaterThan(0);
});
