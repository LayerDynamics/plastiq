// @vitest-environment jsdom
// ActionButton — component test (jsdom + RTL). Driven by the REAL action registry +
// the REAL action context (built by useActionContext from the real store), so we
// assert the component's own resolution logic, not stubs.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ActionButton } from "./ActionButton.js";
import { useActionContext } from "./useActionContext.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Wrappers that feed ActionButton a real ContextTarget from the real hook.
function Known(): React.JSX.Element | null {
  return <ActionButton id="undo" ctx={useActionContext()} variant="chip" />;
}
function Unknown(): React.JSX.Element | null {
  return <ActionButton id="no-such-action" ctx={useActionContext()} variant="chip" />;
}

describe("ActionButton", () => {
  it("smoke/unit: renders a button for a registered action (undo)", () => {
    render(<Known />);
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("unit: renders nothing for an unregistered action id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {}); // silence the dev warning
    const { container } = render(<Unknown />);
    expect(container.firstChild).toBeNull();
  });

  it("unit: an unregistered action id warns in dev (and still renders nothing)", () => {
    // Vitest runs with import.meta.env.DEV === true, so the dev-only branch fires.
    expect(import.meta.env.DEV).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<Unknown />);
    expect(container.firstChild).toBeNull();
    expect(warn).toHaveBeenCalledWith('[ribbon] unknown action id: "no-such-action"');
  });

  it("unit: a registered action id does NOT warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<Known />);
    expect(warn).not.toHaveBeenCalled();
  });
});
