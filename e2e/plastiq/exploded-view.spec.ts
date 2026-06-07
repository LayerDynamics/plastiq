// E2E (no mock): the exploded view spreads the real assembly instances apart and
// reassembles them at factor 0. Drives the full path: insert instances → explode
// slider → store → viewport renderInstances → SceneController instance layer.

import { expect, test } from "@playwright/test";

/** Set a React-controlled range input's value and fire the input event. */
async function setRange(page: import("@playwright/test").Page, value: string): Promise<void> {
  await page.$eval(
    '[data-testid="explode-slider"]',
    (el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
        .set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
}

test("exploded view spreads the assembly and reassembles at factor 0", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart != null,
    undefined,
    { timeout: 240_000 },
  );

  // Build a 2-instance assembly so there is something to explode.
  await page.getByTestId("insert-instance").click();
  await page.getByTestId("insert-instance").click();
  await expect(page.getByTestId("instance-row")).toHaveCount(2);
  await expect(page.getByTestId("explode-control")).toBeVisible();

  const settle = (): Promise<void> =>
    page.evaluate(
      () =>
        new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
  const shot = (): Promise<string> =>
    page.evaluate(
      () => (document.querySelector("#viewport-root canvas") as HTMLCanvasElement).toDataURL(),
    );

  await settle();
  const assembled = await shot();

  await setRange(page, "1.5"); // spread the instances apart
  await settle();
  const exploded = await shot();
  expect(exploded).not.toBe(assembled);

  await setRange(page, "0"); // reassemble — back to the original render
  await settle();
  const reassembled = await shot();
  expect(reassembled).toBe(assembled);
});
