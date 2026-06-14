// @vitest-environment jsdom
// ContextMenuView — component test (jsdom + RTL). Pure presentational menu: render
// real sections, assert a button per item, and that clicking runs / Escape closes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ContextMenuView } from "./ContextMenuView.js";
import type { MenuSection } from "./contextOptions.js";

afterEach(cleanup);

const sections: MenuSection[] = [
  {
    group: "modify",
    items: [
      { id: "delete", label: "Delete", danger: true, enabled: true },
      { id: "suppress", label: "Suppress", danger: false, enabled: true },
    ],
  },
];

describe("ContextMenuView", () => {
  it("smoke/unit: renders a button per item with its label", () => {
    render(<ContextMenuView sections={sections} onRun={() => {}} />);
    expect(screen.getByTestId("canvas-context-menu")).toBeTruthy();
    expect(screen.getByTestId("ctx-delete").textContent).toContain("Delete");
    expect(screen.getByTestId("ctx-suppress").textContent).toContain("Suppress");
  });

  it("integration: clicking an item calls onRun with its id", () => {
    const onRun = vi.fn();
    render(<ContextMenuView sections={sections} onRun={onRun} />);
    fireEvent.click(screen.getByTestId("ctx-delete"));
    expect(onRun).toHaveBeenCalledWith("delete");
  });

  it("integration: Escape calls onClose", () => {
    const onClose = vi.fn();
    render(<ContextMenuView sections={sections} onRun={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("canvas-context-menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
