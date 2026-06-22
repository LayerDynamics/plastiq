// @vitest-environment jsdom
//
// M4 — BomPanel renders the rolled-up bill of materials from a `.assy` document.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { BomPanel } from "./BomPanel.js";
import type { AssyDoc } from "./assy.js";

afterEach(cleanup);

describe("BomPanel", () => {
  it("lists rolled-up part counts and a total", () => {
    const doc: AssyDoc = {
      links: [{ part: "plate" }, { part: "sub" }, { part: "sub" }],
      subAssemblies: { sub: { links: [{ part: "bolt" }, { part: "bolt" }, { part: "bolt" }] } },
    };
    render(<BomPanel doc={doc} />);
    expect(screen.getByTestId("bom-row-bolt").textContent).toContain("×6");
    expect(screen.getByTestId("bom-row-plate").textContent).toContain("×1");
    expect(screen.getByTestId("bom-total").textContent).toContain("7 parts total");
  });

  it("shows an empty state for an empty assembly", () => {
    render(<BomPanel doc={{ links: [] }} />);
    expect(screen.queryByTestId("bom-empty")).not.toBeNull();
    expect(screen.getByTestId("bom-total").textContent).toContain("0 parts total");
  });
});
