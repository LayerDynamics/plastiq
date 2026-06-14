// @vitest-environment jsdom
// ProjectsMenu — component test (jsdom + RTL, real projects store). Smoke: renders
// the menu with its new/save/save-as/open controls.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ProjectsMenu } from "./ProjectsMenu.js";

afterEach(cleanup);

describe("ProjectsMenu", () => {
  it("smoke: renders the projects menu with its controls", () => {
    render(<ProjectsMenu />);
    expect(screen.getByTestId("projects-menu")).toBeTruthy();
    expect(screen.getByTestId("project-new")).toBeTruthy();
    expect(screen.getByTestId("project-save")).toBeTruthy();
    expect(screen.getByTestId("project-open")).toBeTruthy();
  });
});
