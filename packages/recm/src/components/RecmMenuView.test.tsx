// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecmMenuView } from "./RecmMenuView.js";
import type { RecmRingLevel } from "../types.js";

afterEach(cleanup);

const rings: RecmRingLevel<unknown, "create" | "modify">[] = [
  {
    depth: 0,
    activeId: "create",
    options: [
      {
        id: "create",
        label: "Create",
        danger: false,
        enabled: true,
        group: "create",
        hasChildren: true,
        option: { id: "create", group: "create", label: "Create" },
      },
      {
        id: "modify",
        label: "Modify",
        danger: false,
        enabled: true,
        group: "modify",
        hasChildren: true,
        option: { id: "modify", group: "modify", label: "Modify" },
      },
    ],
  },
  {
    depth: 1,
    activeId: "box",
    options: [
      {
        id: "box",
        label: "Box",
        danger: false,
        enabled: true,
        group: "create",
        hasChildren: false,
        option: { id: "box", group: "create", label: "Box" },
      },
      {
        id: "delete",
        label: "Delete",
        danger: true,
        enabled: true,
        group: "create",
        hasChildren: false,
        option: { id: "delete", group: "create", label: "Delete" },
      },
      {
        id: "locked",
        label: "Locked",
        danger: false,
        enabled: false,
        group: "create",
        hasChildren: false,
        option: { id: "locked", group: "create", label: "Locked" },
      },
    ],
  },
];

describe("RecmMenuView", () => {
  it("renders slices for each ring and updates the active path on hover", () => {
    const onPathChange = vi.fn();
    render(
      <RecmMenuView
        rings={rings}
        activePath={["create"]}
        onPathChange={onPathChange}
        onRun={() => {}}
      />,
    );

    expect(screen.getByTestId("recm-ring-0-create")).toBeTruthy();
    expect(screen.getByTestId("recm-ring-1-box").textContent).toContain("Box");

    fireEvent.pointerEnter(screen.getByTestId("recm-ring-0-modify"));
    expect(onPathChange).toHaveBeenCalledWith(["modify"]);
    expect(screen.getByTestId("recm-ring-1-locked").getAttribute("aria-disabled")).toBe("true");
  });

  it("renders each option as an upright pill node carrying its full label", () => {
    render(
      <RecmMenuView
        rings={[
          {
            depth: 0,
            activeId: "create",
            options: [
              {
                id: "create",
                label: "Create something with a very long label",
                danger: false,
                enabled: true,
                group: "create",
                hasChildren: false,
                option: { id: "create", group: "create", label: "Create something with a very long label" },
              },
            ],
          },
        ]}
        activePath={["create"]}
        onPathChange={() => {}}
        onRun={() => {}}
      />,
    );

    const node = screen.getByTestId("recm-ring-0-create");
    // Pill button, upright text — NOT a curved textPath on an arc.
    expect(node.querySelector("rect")).toBeTruthy();
    expect(node.querySelector("textPath")).toBeNull();
    const text = node.querySelector("text");
    expect(text?.textContent).toContain("Create something with a very long label");
  });

  it("applies a custom itemTestId formatter to each node (host testid convention)", () => {
    render(
      <RecmMenuView
        rings={rings}
        activePath={["create"]}
        onPathChange={() => {}}
        onRun={() => {}}
        itemTestId={(id) => `ctx-${id}`}
      />,
    );
    expect(screen.getByTestId("ctx-create")).toBeTruthy();
    expect(screen.getByTestId("ctx-box").textContent).toContain("Box");
    expect(screen.queryByTestId("recm-ring-0-create")).toBeNull();
  });

  it("draws one concentric guide ring per level (so it reads as rings, not a pie)", () => {
    const { container } = render(
      <RecmMenuView rings={rings} activePath={["create"]} onPathChange={() => {}} onRun={() => {}} />,
    );
    // Guide-ring circles are centered at the origin (cx=cy=0). Two ring levels →
    // at least two such circles (plus the hub, which is also centered).
    const centered = Array.from(container.querySelectorAll("circle")).filter(
      (c) => c.getAttribute("cx") === "0" && c.getAttribute("cy") === "0",
    );
    expect(centered.length).toBeGreaterThanOrEqual(2);
  });

  it("runs enabled terminal options and closes on Escape", () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(
      <RecmMenuView
        rings={rings}
        activePath={["create"]}
        onPathChange={() => {}}
        onRun={onRun}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("recm-ring-1-box"));
    expect(onRun).toHaveBeenCalledWith("box");

    fireEvent.keyDown(screen.getByTestId("recm-context-menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("opens the center settings panel and resizes the menu from live controls", () => {
    const onConfigChange = vi.fn();
    const { container } = render(
      <RecmMenuView
        rings={rings}
        activePath={["create"]}
        onPathChange={() => {}}
        onRun={() => {}}
        onConfigChange={onConfigChange}
      />,
    );

    const before = Number(container.querySelector("svg")?.getAttribute("width"));
    fireEvent.click(screen.getByTestId("recm-context-menu-settings-toggle"));
    expect(screen.getByTestId("recm-context-menu-settings-panel")).toBeTruthy();

    fireEvent.change(screen.getByTestId("recm-context-menu-setting-ringGap-range"), {
      target: { value: "30" },
    });

    const after = Number(container.querySelector("svg")?.getAttribute("width"));
    expect(after).toBeGreaterThan(before);
    expect(onConfigChange).toHaveBeenCalled();
    expect(onConfigChange.mock.calls[onConfigChange.mock.calls.length - 1]?.[0].ringGap).toBe(30);
  });
});
