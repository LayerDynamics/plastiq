import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "docs/assets/readme");
const baseUrl = process.env.PLASTIQ_SCREENSHOT_URL ?? "http://localhost:4177";

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});
const page = await context.newPage();

page.on("pageerror", (error) => {
  process.stderr.write(`page error: ${error.message}\n`);
});

await page.addInitScript(() => {
  localStorage.setItem("plastiq.welcomeHidden", "1");
});

async function waitForEditor() {
  await page.getByTestId("status").waitFor({ state: "visible", timeout: 240_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="status"]')?.textContent?.trim() === "ready",
    undefined,
    { timeout: 240_000 },
  );
  await page.waitForFunction(
    () =>
      (globalThis).__plastiqViewport?.builtPart != null &&
      document.querySelector("canvas") != null,
    undefined,
    { timeout: 240_000 },
  );
  await page.evaluate(() => (globalThis).__plastiqViewport?.fitToView?.());
  await page.waitForTimeout(800);
}

async function capture(name) {
  await page.screenshot({
    path: resolve(outputDir, name),
    fullPage: false,
    animations: "disabled",
  });
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await waitForEditor();
  await capture("plastiq-design.png");

  await page.getByTestId("enter-sketch").click();
  await page.getByTestId("sketcher").waitFor({ state: "visible" });
  await page.evaluate(() => {
    const sketch = () => (globalThis).__sketchStore.getState();
    sketch().setTool("line");
    sketch().clickAt(-0.025, -0.018);
    const firstPointId = sketch().model.points[0].id;
    sketch().clickAt(0.025, -0.018);
    sketch().clickAt(0.025, 0.018);
    sketch().clickAt(-0.025, 0.018);
    sketch().clickAt(-0.025, -0.018, { reusePointId: firstPointId });
  });
  await page.waitForTimeout(500);
  await capture("plastiq-sketch.png");

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("workspace-switcher").selectOption("sculpt");
  await page.getByTestId("act-voxel-new").click();
  await page.getByTestId("sculpt-status").waitFor({ state: "visible" });
  await page.evaluate(() => (globalThis).__plastiqViewport?.fitToView?.());
  await page.waitForTimeout(800);
  await capture("plastiq-sculpt.png");
} finally {
  await browser.close();
}

process.stdout.write(`Captured README screenshots in ${outputDir}\n`);
