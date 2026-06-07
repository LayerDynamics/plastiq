// The slim top strip: only global/document controls — Plastiq, the workspace
// switcher, projects, selection mode, gizmo mode, clear, undo/redo. The actual
// modelling/assembly/sim TOOLS live in the left sidebar (WorkspacePanel), not here,
// so this stays a single compact row instead of the old multi-row toolbar.

import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { ActionButton } from "./ActionButton.js";
import { ProjectsMenu } from "../app/ProjectsMenu.js";
import { useActionContext } from "./useActionContext.js";

const SELMODES = ["selmode-face", "selmode-edge", "selmode-vertex", "selmode-body"];
const GIZMO_MODES = ["gizmo-translate", "gizmo-rotate"];

export function TopBar(): React.JSX.Element {
  const ctx = useActionContext();
  return (
    <div
      data-testid="topbar"
      role="toolbar"
      aria-label="Editor toolbar"
      className="flex flex-wrap items-center gap-2 border-b border-[#222a36] bg-black/40 px-3 py-1.5"
    >
      <span className="text-sm font-bold text-[#dfe]">Plastiq</span>
      <WorkspaceSwitcher />
      <ProjectsMenu />
      <div className="mx-1 h-4 w-px bg-[#2a3444]" />
      <div
        role="group"
        aria-label="Selection mode"
        data-testid="selmode"
        className="flex items-center gap-0.5 overflow-hidden rounded border border-[#2a3444]"
      >
        {SELMODES.map((id) => (
          <ActionButton key={id} id={id} ctx={ctx} variant="chip" />
        ))}
      </div>
      <div
        role="group"
        aria-label="Transform mode"
        data-testid="gizmomode"
        className="flex items-center gap-0.5 overflow-hidden rounded border border-[#2a3444]"
      >
        {GIZMO_MODES.map((id) => (
          <ActionButton key={id} id={id} ctx={ctx} variant="chip" />
        ))}
      </div>
      <ActionButton id="clear-selection" ctx={ctx} variant="chip" />
      <div className="mx-1 h-4 w-px bg-[#2a3444]" />
      <ActionButton id="undo" ctx={ctx} variant="chip" />
      <ActionButton id="redo" ctx={ctx} variant="chip" />
    </div>
  );
}
