// The top-left workspace switcher (Fusion-style): flip Design / Assemble / Simulate.
// A sketch is a contextual environment, so leaving the workspace finishes it first.

import { useCadStore } from "../store/store.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import type { Workspace } from "../store/types.js";

const WORKSPACES: { id: Workspace; label: string }[] = [
  { id: "design", label: "Design" },
  { id: "assemble", label: "Assemble" },
  { id: "simulate", label: "Simulate" },
];

export function WorkspaceSwitcher(): React.JSX.Element {
  const workspace = useCadStore((s) => s.workspace);
  const setWorkspace = useCadStore((s) => s.setWorkspace);
  const switchTo = (w: Workspace): void => {
    if (useSketchStore.getState().active) useSketchStore.getState().exitSketch();
    setWorkspace(w);
  };
  return (
    <select
      data-testid="workspace-switcher"
      aria-label="Workspace"
      value={workspace}
      onChange={(e) => switchTo(e.currentTarget.value as Workspace)}
      className="rounded border border-[#2a3444] bg-[#0e1219] px-2 py-1 text-xs font-bold text-[#cfe]"
      title="Switch workspace"
    >
      {WORKSPACES.map((w) => (
        <option key={w.id} value={w.id}>
          {w.label}
        </option>
      ))}
    </select>
  );
}
