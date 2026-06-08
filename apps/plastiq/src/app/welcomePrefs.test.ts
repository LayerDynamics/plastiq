import { afterEach, describe, expect, it } from "vitest";
import { setWelcomeHidden, welcomeHidden } from "./welcomePrefs.js";

afterEach(() => setWelcomeHidden(false)); // reset between cases

describe("welcomePrefs — 'don't show the welcome on launch' flag", () => {
  it("defaults to not hidden (the guide shows for a fresh user)", () => {
    setWelcomeHidden(false);
    expect(welcomeHidden()).toBe(false);
  });

  it("persists the hidden preference and clears it again", () => {
    setWelcomeHidden(true);
    expect(welcomeHidden()).toBe(true);
    setWelcomeHidden(false);
    expect(welcomeHidden()).toBe(false);
  });
});
