// @vitest-environment jsdom
// R6 (§12.R6) — ParametersPanel component test (jsdom + RTL, real store). Proves
// add / rename / delete round-trip through the live store, the used-by scan reads
// the feature tree, and invalid names / bad expressions are guarded inline.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ParametersPanel } from "./ParametersPanel.js";
import { useCadStore } from "../store/store.js";
import type { EditorFeature } from "../store/types.js";

beforeEach(() => {
  useCadStore.getState().loadDocument({ features: [], params: {} });
});
afterEach(cleanup);

/** Load a fresh document (features + params) into the real store. */
function load(params: Record<string, number>, features: EditorFeature[] = []): void {
  useCadStore.getState().loadDocument({ features, params });
}

describe("ParametersPanel — empty + add", () => {
  it("shows the empty state when the document has no params", () => {
    render(<ParametersPanel />);
    expect(screen.getByTestId("params-empty")).toBeTruthy();
  });

  it("adds a numeric param through the store", () => {
    render(<ParametersPanel />);
    fireEvent.change(screen.getByTestId("param-add-name"), { target: { value: "wall" } });
    fireEvent.change(screen.getByTestId("param-add-value"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("param-add-btn"));
    expect(useCadStore.getState().params).toEqual({ wall: 2 });
    // Add inputs clear on success.
    expect((screen.getByTestId("param-add-name") as HTMLInputElement).value).toBe("");
  });

  it("adds a param whose value is an EXPRESSION over the existing params", () => {
    load({ w: 10 });
    render(<ParametersPanel />);
    fireEvent.change(screen.getByTestId("param-add-name"), { target: { value: "total" } });
    fireEvent.change(screen.getByTestId("param-add-value"), { target: { value: "w * 2 + 1" } });
    fireEvent.click(screen.getByTestId("param-add-btn"));
    expect(useCadStore.getState().params).toEqual({ w: 10, total: 21 });
  });

  it("defaults an empty value to 0", () => {
    render(<ParametersPanel />);
    fireEvent.change(screen.getByTestId("param-add-name"), { target: { value: "gap" } });
    fireEvent.click(screen.getByTestId("param-add-btn"));
    expect(useCadStore.getState().params).toEqual({ gap: 0 });
  });
});

describe("ParametersPanel — invalid-input guards", () => {
  it("rejects a reserved name (function/constant) and adds nothing", () => {
    render(<ParametersPanel />);
    fireEvent.change(screen.getByTestId("param-add-name"), { target: { value: "sin" } });
    fireEvent.change(screen.getByTestId("param-add-value"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("param-add-btn"));
    expect(screen.getByTestId("param-add-error").textContent).toMatch(/reserved/);
    expect(useCadStore.getState().params).toEqual({});
  });

  it("rejects a syntactically invalid name", () => {
    render(<ParametersPanel />);
    fireEvent.change(screen.getByTestId("param-add-name"), { target: { value: "1bad" } });
    fireEvent.click(screen.getByTestId("param-add-btn"));
    expect(screen.getByTestId("param-add-error")).toBeTruthy();
    expect(useCadStore.getState().params).toEqual({});
  });

  it("rejects a duplicate name", () => {
    load({ wall: 2 });
    render(<ParametersPanel />);
    fireEvent.change(screen.getByTestId("param-add-name"), { target: { value: "wall" } });
    fireEvent.click(screen.getByTestId("param-add-btn"));
    expect(screen.getByTestId("param-add-error").textContent).toMatch(/already exists/);
    expect(useCadStore.getState().params).toEqual({ wall: 2 });
  });

  it("rejects a bad expression (unknown reference) and adds nothing", () => {
    render(<ParametersPanel />);
    fireEvent.change(screen.getByTestId("param-add-name"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("param-add-value"), { target: { value: "ghost * 2" } });
    fireEvent.click(screen.getByTestId("param-add-btn"));
    expect(screen.getByTestId("param-add-error").textContent).toMatch(/Unknown parameter/);
    expect(useCadStore.getState().params).toEqual({});
  });
});

describe("ParametersPanel — edit / rename / delete", () => {
  it("edits an existing param's value via an expression", () => {
    load({ wall: 2 });
    render(<ParametersPanel />);
    const input = screen.getByTestId("param-value-wall");
    fireEvent.change(input, { target: { value: "3 * 4" } });
    fireEvent.blur(input);
    expect(useCadStore.getState().params.wall).toBe(12);
  });

  it("reverts and reports when a value edit is a bad expression", () => {
    load({ wall: 2 });
    render(<ParametersPanel />);
    const input = screen.getByTestId("param-value-wall");
    fireEvent.change(input, { target: { value: "wall * 2" } }); // self-reference → excluded → unknown
    fireEvent.blur(input);
    expect(useCadStore.getState().params.wall).toBe(2); // unchanged
    expect(screen.getByTestId("param-error-wall").textContent).toMatch(/Unknown parameter/);
  });

  it("renames a param, preserving its value and rewriting dependent feature expressions", () => {
    load({ wall: 2 }, [
      {
        id: "e1",
        type: "extrude",
        name: "Base",
        params: { height: 0.01 },
        exprs: { height: "wall * 2" },
      },
    ]);
    render(<ParametersPanel />);
    const nameInput = screen.getByTestId("param-name-wall");
    fireEvent.change(nameInput, { target: { value: "thick" } });
    fireEvent.blur(nameInput);
    expect(useCadStore.getState().params).toEqual({ thick: 2 });
    expect(useCadStore.getState().features[0]!.exprs).toEqual({ height: "thick * 2" });
  });

  it("rejects a rename that collides with another param", () => {
    load({ wall: 2, gap: 5 });
    render(<ParametersPanel />);
    const nameInput = screen.getByTestId("param-name-wall");
    fireEvent.change(nameInput, { target: { value: "gap" } });
    fireEvent.blur(nameInput);
    // Both survive; no clobber.
    expect(useCadStore.getState().params).toEqual({ wall: 2, gap: 5 });
    expect(screen.getByTestId("param-error-wall")).toBeTruthy();
  });

  it("deletes a param", () => {
    load({ wall: 2, gap: 5 });
    render(<ParametersPanel />);
    fireEvent.click(screen.getByTestId("param-delete-wall"));
    expect(useCadStore.getState().params).toEqual({ gap: 5 });
  });
});

describe("ParametersPanel — used-by scan", () => {
  it("lists the features whose expressions reference a param", () => {
    // Two features reference `wall` through the authoritative `feature.exprs`
    // map consumed by rebuild; a third does not.
    const features: EditorFeature[] = [
      {
        id: "e1",
        type: "extrude",
        name: "Base",
        params: { height: 0.01 },
        exprs: { height: "wall * 2" },
      },
      {
        id: "sh1",
        type: "shell",
        name: "Wall",
        params: { thickness: 0.001 },
        exprs: { thickness: "wall" },
      },
      { id: "b1", type: "box", name: "Block", params: { dx: 0.01, dy: 0.01, dz: 0.01 } },
    ];
    load({ wall: 0.002 }, features);
    render(<ParametersPanel />);
    const usedby = screen.getByTestId("param-usedby-wall");
    expect(usedby.textContent).toMatch(/used by 2/);
    expect(usedby.textContent).toContain("Base");
    expect(usedby.textContent).toContain("Wall");
    expect(usedby.textContent).not.toContain("Block");
    expect((screen.getByTestId("param-delete-wall") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("param-delete-wall"));
    expect(useCadStore.getState().params.wall).toBe(0.002);
  });

  it("reports zero users for an unreferenced param", () => {
    load({ orphan: 1 });
    render(<ParametersPanel />);
    expect(screen.getByTestId("param-usedby-orphan").textContent).toMatch(/used by 0/);
  });
});
