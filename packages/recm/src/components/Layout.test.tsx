// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RecmLayout } from "./Layout.js";

afterEach(cleanup);

describe("RecmLayout", () => {
  it("positions a screen-anchored menu at the client point, centered on it", () => {
    render(
      <RecmLayout anchor={{ kind: "screen", x: 120, y: 80 }} className="recm-screen">
        <button type="button">Item</button>
      </RecmLayout>,
    );
    const item = screen.getByText("Item");
    const wrapper = item.parentElement as HTMLElement;
    expect(wrapper.className).toBe("recm-screen");
    expect(wrapper.style.position).toBe("fixed");
    expect(wrapper.style.left).toBe("120px");
    expect(wrapper.style.top).toBe("80px");
    expect(wrapper.style.transform).toBe("translate(-50%, -50%)");
  });

  it("honors a custom z-index", () => {
    render(
      <RecmLayout anchor={{ kind: "screen", x: 0, y: 0 }} zIndex={5000}>
        <span>Z</span>
      </RecmLayout>,
    );
    const wrapper = screen.getByText("Z").parentElement as HTMLElement;
    expect(wrapper.style.zIndex).toBe("5000");
  });
});
