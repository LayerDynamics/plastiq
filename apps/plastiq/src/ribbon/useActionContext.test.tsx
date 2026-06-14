// @vitest-environment jsdom
// useActionContext — hook test (renderHook). Builds a ContextTarget that reflects
// the live cad store (selection mode, picks).

import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import { useActionContext } from "./useActionContext.js";
import { useCadStore } from "../store/store.js";

afterEach(() => useCadStore.setState({ selMode: "face", picks: [] }));

describe("useActionContext", () => {
  it("reflects the cad store's selection mode + picks", () => {
    useCadStore.setState({ selMode: "edge", picks: [] });
    const { result } = renderHook(() => useActionContext());
    expect(result.current.selMode).toBe("edge");
    expect(Array.isArray(result.current.picks)).toBe(true);
  });
});
