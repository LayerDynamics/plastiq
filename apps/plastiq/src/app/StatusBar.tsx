// Bottom application dock (SPEC-5 FR-4): Fusion-style Text Commands above the
// rebuild/project/selection status strip, wired live to the Zustand stores.
// `status` reflects the latest geometry rebuild ("ready" once the worker has
// produced a mesh), which the M0 E2E observes to confirm a rendered solid.

import { useEffect } from "react";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { CommandConsole, useCommandConsole } from "./TextCommands.js";

export function StatusBar(): React.JSX.Element {
  const status = useCadStore((s) => s.status);
  const selMode = useCadStore((s) => s.selMode);
  const pickCount = useCadStore((s) => s.picks.length);
  const projectName = useProjectsStore((s) => s.currentName);
  const projectStatus = useProjectsStore((s) => s.status);
  const textCommandsVisible = useCommandConsole((s) => s.visible);
  const toggleTextCommands = useCommandConsole((s) => s.toggle);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        useCommandConsole.getState().toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const strip = (
    <footer className="flex items-center gap-3 border-t border-[#222a36] bg-black/50 px-3 py-1 text-xs text-[#789]">
      <button
        type="button"
        data-testid="text-commands-toggle"
        aria-expanded={textCommandsVisible}
        aria-controls="text-commands-panel"
        title="Show / Hide Text Commands (Ctrl+Alt+C)"
        onClick={toggleTextCommands}
        className={`rounded border px-1.5 py-0 text-[10px] font-bold leading-4 tracking-wide ${
          textCommandsVisible
            ? "border-[#426078] bg-[#182837] text-[#a9d9ee]"
            : "border-[#2b3644] text-[#718396] hover:bg-[#17202b] hover:text-[#b6cadb]"
        }`}
      >
        &gt;_ TEXT COMMANDS
      </button>
      <span data-testid="status" className="min-w-0 flex-1 truncate">
        {status}
      </span>
      <span data-testid="project-status" className="max-w-[28%] truncate text-center">
        {projectName}
        {projectStatus ? ` · ${projectStatus}` : ""}
      </span>
      <span className="ml-auto whitespace-nowrap">
        {selMode}
        {pickCount > 0 ? ` · ${pickCount} selected` : ""} · mm · SI
      </span>
    </footer>
  );

  // Keep the closed state structurally identical to the original app grid: the
  // footer itself is the third direct grid child. Only an explicitly open
  // palette introduces a wrapper that stacks transcript + strip in that row.
  return textCommandsVisible ? (
    <div className="min-w-0">
      <CommandConsole />
      {strip}
    </div>
  ) : (
    strip
  );
}
