// @vitest-environment jsdom
// PropertiesPanel — component test (jsdom + RTL, real store). Smoke: with a feature
// selected it renders the feature editor for that feature's params.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PropertiesPanel } from "./PropertiesPanel.js";
import { useCadStore } from "../store/store.js";
import { defaultDocument } from "../store/seed.js";

beforeEach(() => {
  useCadStore.getState().loadDocument(defaultDocument());
  useCadStore.setState({ selectedFeatureId: "f1" });
});
afterEach(cleanup);

describe("PropertiesPanel", () => {
  it("smoke: renders the feature editor for the selected feature", () => {
    render(<PropertiesPanel />);
    expect(screen.getByTestId("feature-editor")).toBeTruthy();
  });

  it("edits extrude data.op join/new via the data panel (T15)", () => {
    useCadStore.getState().loadDocument({
      features: [
        { id: "s1", type: "sketch", data: { profile: { kind: "circle", center: [0, 0], radius: 0.01 } } },
        { id: "e1", type: "extrude", params: { height: 0.02 }, data: { op: "join" }, deps: ["s1"] },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "e1" });
    render(<PropertiesPanel />);
    expect(screen.getByTestId("feature-data")).toBeTruthy();
    const sel = screen.getByTestId("feature-op") as HTMLSelectElement;
    expect(sel.value).toBe("join");
    fireEvent.change(sel, { target: { value: "new" } });
    const f = useCadStore.getState().features.find((x) => x.id === "e1");
    expect(f?.data?.["op"]).toBe("new");
  });

  it("edits shell direction outward (T15)", () => {
    useCadStore.getState().loadDocument({
      features: [
        { id: "b1", type: "box", params: { dx: 0.04, dy: 0.04, dz: 0.03 } },
        {
          id: "sh1",
          type: "shell",
          params: { thickness: 0.002 },
          data: { faces: [{ normal: [0, 0, 1] }] },
        },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "sh1" });
    render(<PropertiesPanel />);
    const sel = screen.getByTestId("feature-shell-dir") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "outward" } });
    const f = useCadStore.getState().features.find((x) => x.id === "sh1");
    expect(f?.data?.["direction"]).toBe("outward");
    expect(screen.getByTestId("feature-ref-counts").textContent).toMatch(/face/);
  });

  it("rebinds extrude sketch deps via the data panel (C10)", () => {
    useCadStore.getState().loadDocument({
      features: [
        { id: "s1", type: "sketch", data: { profile: { kind: "circle", center: [0, 0], radius: 0.01 } } },
        { id: "s2", type: "sketch", data: { profile: { kind: "circle", center: [0, 0], radius: 0.005 } } },
        { id: "e1", type: "extrude", params: { height: 0.02 }, deps: ["s1"] },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "e1" });
    render(<PropertiesPanel />);
    const sel = screen.getByTestId("feature-deps") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "s2" } });
    expect(useCadStore.getState().features.find((x) => x.id === "e1")?.deps).toEqual(["s2"]);
  });

  it("edits boolean op and loft ruled (C10)", () => {
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "bo1",
          type: "boolean",
          params: { dx: 0.01, dy: 0.01, dz: 0.01 },
          data: { op: "subtract" },
        },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "bo1" });
    render(<PropertiesPanel />);
    fireEvent.change(screen.getByTestId("feature-boolean-op"), { target: { value: "union" } });
    expect(useCadStore.getState().features.find((x) => x.id === "bo1")?.data?.["op"]).toBe("union");
  });

  it("attaches chamfer face from selection for two-distance (C8)", () => {
    const faceRef = {
      normal: [0, 0, 1] as [number, number, number],
      centroid: [0, 0, 0.02] as [number, number, number],
    };
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "ch1",
          type: "chamfer",
          params: { distance: 0.001, distance2: 0.002 },
          data: { edges: [{ midpoint: [0, 0, 0], faceNormals: [[0, 0, 1], [1, 0, 0]] }] },
        },
      ],
      params: {},
    });
    useCadStore.setState({
      selectedFeatureId: "ch1",
      picks: [{ kind: "face", id: 7 }],
      selectionRefs: { faces: { 7: faceRef }, edges: {} },
    });
    render(<PropertiesPanel />);
    expect(screen.getByTestId("feature-chamfer-face-warn")).toBeTruthy();
    fireEvent.click(screen.getByTestId("feature-attach-face"));
    const f = useCadStore.getState().features.find((x) => x.id === "ch1");
    expect(f?.data?.["face"]).toEqual(faceRef);
  });

  it("displays radius2 in mm not as unitless SI (C8 LENGTH_PARAMS)", () => {
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "fil1",
          type: "fillet",
          params: { radius: 0.002, radius2: 0.003 },
          data: { edges: [{ midpoint: [0, 0, 0], faceNormals: [[0, 0, 1], [1, 0, 0]] }] },
        },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "fil1" });
    render(<PropertiesPanel />);
    // NumberField labels include unit suffix for lengths — radius2 (mm).
    expect(screen.getByText(/radius2 \(mm\)/i)).toBeTruthy();
  });

  it("attaches fillet edges from selection (C10 refs editor, not read-only counts)", () => {
    const edgeA = {
      midpoint: [0, 0, 0] as [number, number, number],
      faceNormals: [
        [0, 0, 1],
        [1, 0, 0],
      ] as [[number, number, number], [number, number, number]],
    };
    const edgeB = {
      midpoint: [0.01, 0, 0] as [number, number, number],
      faceNormals: [
        [0, 0, 1],
        [0, 1, 0],
      ] as [[number, number, number], [number, number, number]],
    };
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "fil1",
          type: "fillet",
          params: { radius: 0.001 },
          data: { edges: [edgeA] },
        },
      ],
      params: {},
    });
    useCadStore.setState({
      selectedFeatureId: "fil1",
      picks: [
        { kind: "edge", id: 1 },
        { kind: "edge", id: 2 },
      ],
      selectionRefs: { faces: {}, edges: { 1: edgeA, 2: edgeB } },
    });
    render(<PropertiesPanel />);
    expect(screen.getByTestId("feature-refs-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("feature-attach-edges"));
    const f = useCadStore.getState().features.find((x) => x.id === "fil1");
    expect(f?.data?.["edges"]).toEqual([edgeA, edgeB]);
    expect(screen.getByTestId("feature-ref-counts").textContent).toMatch(/2 edge/);
  });

  it("attaches shell faces from selection (C10)", () => {
    const faceA = {
      normal: [0, 0, 1] as [number, number, number],
      centroid: [0, 0, 0.02] as [number, number, number],
    };
    const faceB = {
      normal: [0, 0, -1] as [number, number, number],
      centroid: [0, 0, 0] as [number, number, number],
    };
    useCadStore.getState().loadDocument({
      features: [
        { id: "b1", type: "box", params: { dx: 0.04, dy: 0.04, dz: 0.03 } },
        {
          id: "sh1",
          type: "shell",
          params: { thickness: 0.002 },
          data: { faces: [faceA] },
        },
      ],
      params: {},
    });
    useCadStore.setState({
      selectedFeatureId: "sh1",
      picks: [
        { kind: "face", id: 3 },
        { kind: "face", id: 4 },
      ],
      selectionRefs: { faces: { 3: faceA, 4: faceB }, edges: {} },
    });
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId("feature-attach-faces"));
    const f = useCadStore.getState().features.find((x) => x.id === "sh1");
    expect(f?.data?.["faces"]).toEqual([faceA, faceB]);
  });
});
