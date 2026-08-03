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
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
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
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
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
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
  const shot = (): Promise<string> =>
    page.evaluate(() =>
      (document.querySelector("#viewport-root canvas") as HTMLCanvasElement).toDataURL(),
    );

  await settle();
  const assembled = await shot();

  await setRange(page, "1.5"); // spread the instances apart
  await settle();
  const exploded = await shot();
  expect(exploded).not.toBe(assembled);

  // R7/S4: mate authoring is visibly unavailable while picks would hit the
  // rendered exploded pose instead of the document pose.
  await page.getByTestId("workspace-switcher").selectOption("assemble");
  await expect(page.getByTestId("act-mate-mode")).toBeDisabled();

  await setRange(page, "0"); // reassemble — back to the original render
  await settle();
  const reassembled = await shot();
  expect(reassembled).toBe(assembled);

  await expect(page.getByTestId("act-mate-mode")).toBeEnabled();
  await page.getByTestId("act-mate-mode").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as { __cadStore: { getState: () => { mateMode: boolean } } }
          ).__cadStore.getState().mateMode,
      ),
    )
    .toBe(true);

  // Exploding an already-active mate session exits it and clears the unsafe state.
  await setRange(page, "1.5");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as { __cadStore: { getState: () => { mateMode: boolean } } }
          ).__cadStore.getState().mateMode,
      ),
    )
    .toBe(false);
  await expect(page.getByTestId("status")).toContainText(/mate mode exited/i);
});
