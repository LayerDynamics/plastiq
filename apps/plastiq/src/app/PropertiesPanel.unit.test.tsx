// @vitest-environment jsdom
// SPEC-6 R2.5 (FR-9a): the generic feature editor displays length params in mm and
// angle params in degrees, and commits edits back to SI — closing the verified gap
// where a 0.04 m dimension showed as "0.04".

import { afterEach, describe, it, expect } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { useCadStore } from "../store/store.js";

afterEach(() => {
  cleanup();
  useCadStore.getState().reset();
});

describe("R2.5 PropertiesPanel mm/deg display", () => {
  it("shows a length param in mm (0.04 m → 40) and commits back to SI", () => {
    useCadStore.setState({
      features: [{ id: "f1", type: "box", name: "Box", params: { dx: 0.04, dy: 0.02, dz: 0.01 } }],
      selectedFeatureId: "f1",
    });
    const { getByLabelText } = render(<PropertiesPanel />);
    const dx = getByLabelText("dx (mm)") as HTMLInputElement;
    expect(dx.value).toBe("40");

    fireEvent.change(dx, { target: { value: "50" } });
    fireEvent.blur(dx);
    expect(useCadStore.getState().features[0]!.params!.dx).toBeCloseTo(0.05, 12);
  });

  it("shows an angle param in degrees (π/2 → 90)", () => {
    useCadStore.setState({
      features: [{ id: "f1", type: "revolve", params: { angle: Math.PI / 2 } }],
      selectedFeatureId: "f1",
    });
    const { getByLabelText } = render(<PropertiesPanel />);
    const angle = getByLabelText("angle (°)") as HTMLInputElement;
    expect(Number(angle.value)).toBeCloseTo(90, 6);
  });

  it("leaves a unitless scalar (count) unconverted and unsuffixed", () => {
    useCadStore.setState({
      features: [{ id: "f1", type: "linearPattern", params: { spacing: 0.015, count: 3 } }],
      selectedFeatureId: "f1",
    });
    const { getByLabelText } = render(<PropertiesPanel />);
    expect((getByLabelText("count") as HTMLInputElement).value).toBe("3");
    expect((getByLabelText("spacing (mm)") as HTMLInputElement).value).toBe("15");
  });
});
