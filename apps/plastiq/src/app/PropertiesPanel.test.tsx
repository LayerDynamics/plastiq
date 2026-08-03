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

describe("PropertiesPanel — multi-body readout (§2.4)", () => {
  it("lists the body count and each body's volume once a document has more than one", () => {
    useCadStore.setState({
      massProps: { volume: 0.000022, com: [0, 0, 0], bodyVolumes: [0.000016, 0.000006] },
    });
    render(<PropertiesPanel />);
    const bodies = screen.getByTestId("mp-bodies");
    expect(bodies.textContent).toContain("2");
    // Each body's own volume, in cm³ — the summed total alone cannot show this.
    expect(bodies.textContent).toContain("16.00");
    expect(bodies.textContent).toContain("6.00");
    // The total stays the sum.
    expect(screen.getByTestId("mp-volume").textContent).toContain("22.00");
  });

  it("stays hidden for a single-body document (no noise)", () => {
    useCadStore.setState({
      massProps: { volume: 0.000016, com: [0, 0, 0], bodyVolumes: [0.000016] },
    });
    render(<PropertiesPanel />);
    expect(screen.queryByTestId("mp-bodies")).toBeNull();
    expect(screen.getByTestId("mp-volume")).toBeTruthy();
  });
});

describe("PropertiesPanel", () => {
  it("smoke: renders the feature editor for the selected feature", () => {
    render(<PropertiesPanel />);
    expect(screen.getByTestId("feature-editor")).toBeTruthy();
  });

  it("authors a global expression binding and displays its evaluated dimension", () => {
    useCadStore.getState().setParam("size", 0.03);
    render(<PropertiesPanel />);

    const expression = screen.getByTestId("feature-expr-dx");
    fireEvent.change(expression, { target: { value: "size / 2" } });
    fireEvent.blur(expression);

    expect(useCadStore.getState().features[0]!.exprs).toEqual({ dx: "size / 2" });
    const numeric = screen
      .getByTestId("feature-param-dx")
      .querySelector('input[type="number"]') as HTMLInputElement;
    expect(numeric.value).toBe("15");
  });

  it("rejects an invalid expression without changing the feature", () => {
    render(<PropertiesPanel />);
    const expression = screen.getByTestId("feature-expr-dx");
    fireEvent.change(expression, { target: { value: "missing * 2" } });
    fireEvent.blur(expression);

    expect(screen.getByTestId("feature-expr-error-dx").textContent).toMatch(/Unknown parameter/);
    expect(useCadStore.getState().features[0]!.exprs).toBeUndefined();
  });

  it("turns a numeric edit into an explicit expression unbind", () => {
    useCadStore.getState().setParam("size", 0.03);
    useCadStore.getState().setFeatureExpr("f1", "dx", "size");
    render(<PropertiesPanel />);

    const numeric = screen
      .getByTestId("feature-param-dx")
      .querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.change(numeric, { target: { value: "40" } });
    fireEvent.blur(numeric);

    expect(useCadStore.getState().features[0]!.params?.dx).toBe(0.04);
    expect(useCadStore.getState().features[0]!.exprs).toBeUndefined();
  });

  it("edits extrude data.op join/new via the data panel (T15)", () => {
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "s1",
          type: "sketch",
          data: { profile: { kind: "circle", center: [0, 0], radius: 0.01 } },
        },
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
        {
          id: "s1",
          type: "sketch",
          data: { profile: { kind: "circle", center: [0, 0], radius: 0.01 } },
        },
        {
          id: "s2",
          type: "sketch",
          data: { profile: { kind: "circle", center: [0, 0], radius: 0.005 } },
        },
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
          data: {
            edges: [
              {
                midpoint: [0, 0, 0],
                faceNormals: [
                  [0, 0, 1],
                  [1, 0, 0],
                ],
              },
            ],
          },
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
          data: {
            edges: [
              {
                midpoint: [0, 0, 0],
                faceNormals: [
                  [0, 0, 1],
                  [1, 0, 0],
                ],
              },
            ],
          },
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

// --- Round primitives are EDITABLE (§4.11 / §9) ------------------------------
//
// §9's core mechanism: FeatureEditor iterates only Object.entries(feature.params),
// so a param creation omits can never be added later. The ribbon therefore bakes
// every placement key — these assert the panel actually surfaces them, and that
// the op select offers the subtractive ops a primitive supports.

describe("round primitive properties", () => {
  const cylinder = (data: Record<string, unknown> = { op: "join" }) => {
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "c1",
          type: "cylinder",
          params: {
            radius: 0.01,
            height: 0.03,
            ox: 0,
            oy: 0,
            oz: 0,
            ax: 0,
            ay: 0,
            az: 1,
            angle: 2 * Math.PI,
          },
          data,
        },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "c1" });
  };

  it("surfaces every baked param — including the placement, so it is editable", () => {
    cylinder();
    render(<PropertiesPanel />);
    const text = screen.getByTestId("feature-editor").textContent ?? "";
    // Placement keys must be present: an omitted param is an uneditable one (§9).
    for (const key of ["radius", "height", "ox", "oy", "oz", "ax", "ay", "az", "angle"]) {
      expect(text, `param '${key}' is not editable in the panel`).toContain(key);
    }
  });

  it("offers cut/intersect in the op select — a primitive is also a boolean tool", () => {
    cylinder();
    render(<PropertiesPanel />);
    const sel = screen.getByTestId("feature-op") as HTMLSelectElement;
    const values = [...sel.options].map((o) => o.value);
    expect(values).toEqual(["join", "cut", "intersect", "new"]);

    fireEvent.change(sel, { target: { value: "cut" } });
    expect(useCadStore.getState().features.find((f) => f.id === "c1")?.data?.["op"]).toBe("cut");
  });

  it("DISPLAYS cut rather than silently showing join (the §9 boolean-op lie)", () => {
    cylinder({ op: "cut" });
    render(<PropertiesPanel />);
    expect((screen.getByTestId("feature-op") as HTMLSelectElement).value).toBe("cut");
  });

  it("extrude offers the full op set since R9 (cut/intersect no longer silently join)", () => {
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "s1",
          type: "sketch",
          data: { profile: { kind: "circle", center: [0, 0], radius: 0.01 } },
        },
        { id: "e1", type: "extrude", params: { height: 0.02 }, data: { op: "join" }, deps: ["s1"] },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "e1" });
    render(<PropertiesPanel />);
    const values = [...(screen.getByTestId("feature-op") as HTMLSelectElement).options].map(
      (o) => o.value,
    );
    expect(values).toEqual(["join", "cut", "intersect", "new"]);
  });

  it("edits a sweep typed path via Properties → Path (R13/C1)", () => {
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "sw1",
          type: "sweep",
          data: {
            profile: { kind: "circle", center: [0, 0], radius: 0.005 },
            path: {
              kind: "polyline",
              points: [
                [0, 0, 0],
                [0, 0, 0.04],
              ],
            },
          },
        },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "sw1" });
    render(<PropertiesPanel />);
    expect(screen.getByTestId("feature-path-editor")).toBeTruthy();
    expect(screen.getByTestId("feature-path-point-0")).toBeTruthy();
    expect(screen.getByTestId("feature-path-point-1")).toBeTruthy();
    // Commit Z of the second point to 50 mm.
    const zInputs = screen.getByTestId("feature-path-point-1").querySelectorAll("input");
    expect(zInputs.length).toBe(3);
    fireEvent.change(zInputs[2]!, { target: { value: "50" } });
    fireEvent.blur(zInputs[2]!);
    const path = useCadStore.getState().features.find((f) => f.id === "sw1")?.data?.["path"] as {
      kind: string;
      points: number[][];
    };
    expect(path.kind).toBe("polyline");
    expect(path.points[1]![2]).toBeCloseTo(0.05, 6);
  });

  it("exposes and commits the trim keep side (§14 regression)", () => {
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "tr1",
          type: "trim",
          data: {
            plane: { origin: [0, 0, 0], normal: [1, 0, 0] },
            keep: "positive",
          },
        },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "tr1" });
    render(<PropertiesPanel />);
    const keep = screen.getByTestId("feature-trim-keep") as HTMLSelectElement;
    expect(keep.value).toBe("positive");
    fireEvent.change(keep, { target: { value: "negative" } });
    expect(useCadStore.getState().features[0]!.data?.["keep"]).toBe("negative");
  });

  it("edits extension continuity and reattaches its selected boundary (§14)", () => {
    const original = {
      faceNormals: [
        [0, 0, 1],
        [1, 0, 0],
      ] as [[number, number, number], [number, number, number]],
    };
    const replacement = {
      faceNormals: [
        [0, 0, 1],
        [0, 1, 0],
      ] as [[number, number, number], [number, number, number]],
    };
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "ex1",
          type: "extendSurface",
          params: { length: 0.01 },
          data: { edge: original, continuity: 1 },
        },
      ],
      params: {},
    });
    useCadStore.setState({
      selectedFeatureId: "ex1",
      picks: [{ kind: "edge", id: 12 }],
      selectionRefs: { faces: {}, edges: { 12: replacement } },
    });
    render(<PropertiesPanel />);
    fireEvent.change(screen.getByTestId("feature-extend-continuity"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByTestId("feature-attach-boundary"));
    const data = useCadStore.getState().features[0]!.data;
    expect(data?.["continuity"]).toBe(3);
    expect(data?.["edge"]).toEqual(replacement);
  });

  it("makes surface loft/sweep and thicken data genuinely editable", () => {
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "sl1",
          type: "surfaceLoft",
          data: { sections: [{}, {}], ruled: false },
        },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "sl1" });
    const view = render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId("feature-loft-ruled"));
    expect(useCadStore.getState().features[0]!.data?.["ruled"]).toBe(true);

    view.unmount();
    useCadStore.getState().loadDocument({
      features: [
        {
          id: "ss1",
          type: "surfaceSweep",
          data: {
            profile: { kind: "circle", center: [0, 0], radius: 0.005 },
            path: {
              kind: "polyline",
              points: [
                [0, 0, 0],
                [0, 0, 0.04],
              ],
            },
          },
        },
      ],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "ss1" });
    const sweepView = render(<PropertiesPanel />);
    expect(screen.getByTestId("feature-sweep-mode")).toBeTruthy();
    expect(screen.getByTestId("feature-path-editor")).toBeTruthy();

    sweepView.unmount();
    useCadStore.getState().loadDocument({
      features: [{ id: "th1", type: "thicken", params: { thickness: 0.002 }, data: {} }],
      params: {},
    });
    useCadStore.setState({ selectedFeatureId: "th1" });
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId("feature-thicken-both-sides"));
    expect(useCadStore.getState().features[0]!.data?.["bothSides"]).toBe(true);
  });
});
