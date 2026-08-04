// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useCadStore } from "../store/store.js";
import { CommandConsole, useCommandConsole } from "./TextCommands.js";
import { StatusBar } from "./StatusBar.js";

beforeEach(() => {
  localStorage.clear();
  useCommandConsole.setState({ visible: true });
  useCadStore.setState({
    features: [],
    params: {},
    nextSeq: 1,
    selectedFeatureId: null,
    picks: [],
    selMode: "face",
    status: "ready",
    past: [],
    future: [],
    featureErrors: {},
    featureWarnings: {},
    selectionRefs: { faces: {}, edges: {}, vertices: {} },
  });
});

afterEach(cleanup);

describe("CommandConsole", () => {
  it("runs a real registry action and appends the result to the transcript", async () => {
    render(<CommandConsole />);
    const input = screen.getByTestId("text-commands-input");
    fireEvent.change(input, { target: { value: "cylinder" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("text-commands-log").textContent).toContain("Ran Cylinder"),
    );
    expect(useCadStore.getState().features[0]?.type).toBe("cylinder");
  });

  it("supports completion, persisted Up history, and Escape-to-clear", async () => {
    render(<CommandConsole />);
    const input = screen.getByTestId("text-commands-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "serv" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("services");

    fireEvent.change(input, { target: { value: "status" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe(""));
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("status");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(JSON.parse(localStorage.getItem("plastiq.textCommands.history") ?? "[]")).toEqual([
      "status",
    ]);
  });

  it("streams subsequent geometry status changes into the live log", async () => {
    render(<CommandConsole />);
    act(() => useCadStore.getState().setStatus("building"));
    act(() => useCadStore.getState().setStatus("ready"));
    await waitFor(() => {
      const text = screen.getByTestId("text-commands-log").textContent ?? "";
      expect(text).toContain("building");
      expect(text).toContain("ready");
    });
  });

  it("hides from its close button and reopens through the footer shortcut", () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByLabelText("Hide Text Commands"));
    expect(screen.queryByTestId("text-commands")).toBeNull();
    fireEvent.keyDown(window, { key: "c", ctrlKey: true, altKey: true });
    expect(screen.getByTestId("text-commands")).toBeTruthy();
  });
});
