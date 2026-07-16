// @vitest-environment jsdom
// ProjectsMenu two-step delete (Review #17): the row's ✕ only ARMS the confirm
// (nothing deleted); "Delete?" performs the removal; the cancel ✕ disarms it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ProjectsMenu } from "./ProjectsMenu.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import type { ProjectMeta } from "../persistence/types.js";

const meta: ProjectMeta = {
  id: "p1",
  name: "Part 1",
  units: "mm",
  created: 0,
  updated: 0,
  thumbnail: null,
};

const remove = vi.fn(async (_id: string) => undefined);
const originalRemove = useProjectsStore.getState().remove;

beforeEach(() => {
  remove.mockClear();
  useProjectsStore.setState({ list: [meta], remove });
});
afterEach(() => {
  cleanup();
  useProjectsStore.setState({ list: [], remove: originalRemove });
});

function openList(): void {
  render(<ProjectsMenu />);
  fireEvent.click(screen.getByTestId("project-open"));
}

describe("ProjectsMenu delete confirm", () => {
  it("the first activation arms the confirm and does NOT delete", () => {
    openList();
    fireEvent.click(screen.getByTestId("project-delete"));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByTestId("project-delete-confirm")).toBeTruthy();
    expect(screen.getByTestId("project-delete-cancel")).toBeTruthy();
    expect(screen.queryByTestId("project-delete")).toBeNull(); // arm button swapped out
  });

  it("confirming deletes the project", () => {
    openList();
    fireEvent.click(screen.getByTestId("project-delete"));
    fireEvent.click(screen.getByTestId("project-delete-confirm"));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("p1");
  });

  it("cancelling disarms without deleting and restores the delete affordance", () => {
    openList();
    fireEvent.click(screen.getByTestId("project-delete"));
    fireEvent.click(screen.getByTestId("project-delete-cancel"));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByTestId("project-delete-confirm")).toBeNull();
    expect(screen.getByTestId("project-delete")).toBeTruthy();
  });

  it("toggling the list closed disarms a pending confirm", () => {
    openList();
    fireEvent.click(screen.getByTestId("project-delete"));
    fireEvent.click(screen.getByTestId("project-open")); // close
    fireEvent.click(screen.getByTestId("project-open")); // reopen
    expect(screen.queryByTestId("project-delete-confirm")).toBeNull();
    expect(screen.getByTestId("project-delete")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
  });
});
