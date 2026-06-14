// @vitest-environment jsdom
// ActionButton — component test (jsdom + RTL). Driven by the REAL action registry +
// the REAL action context (built by useActionContext from the real store), so we
// assert the component's own resolution logic, not stubs.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ActionButton } from "./ActionButton.js";
import { useActionContext } from "./useActionContext.js";

afterEach(cleanup);

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
    const { container } = render(<Unknown />);
    expect(container.firstChild).toBeNull();
  });
});
