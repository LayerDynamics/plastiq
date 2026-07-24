import { expect, test } from "@playwright/test";
test("probe glyphs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  const info = await page.evaluate(() => {
    const st = () => (globalThis as any).__sketchStore.getState();
    st().setTool("line"); st().clickAt(0,0); st().clickAt(0.03,0); st().cancelGesture();
    const line = st().model.entities.find((e:any)=>e.kind==="line");
    st().setSelection([line.id]);
    st().addDimension("hDistance");
    return { cons: st().model.constraints.map((c:any)=>c.kind), frame: st().resolvedFrame,
             glyphs: document.querySelectorAll('[data-testid="dimension-glyph"]').length,
             cglyphs: document.querySelectorAll('[data-testid="constraint-glyph"]').length };
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    glyphs: document.querySelectorAll('[data-testid="dimension-glyph"]').length,
    cglyphs: document.querySelectorAll('[data-testid="constraint-glyph"]').length }));
  console.log("P2 " + JSON.stringify({ ...info, after }));
});
