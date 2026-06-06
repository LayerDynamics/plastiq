// Bottom status bar (SPEC-5 FR-4): rebuild state, selection mode, and units,
// wired live to the Zustand store. `status` reflects the latest geometry
// rebuild ("ready" once the worker has produced a mesh), which the M0 E2E
// observes to confirm the viewport rendered a solid.

import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";

export function StatusBar(): React.JSX.Element {
  const status = useCadStore((s) => s.status);
  const selMode = useCadStore((s) => s.selMode);
  const pickCount = useCadStore((s) => s.picks.length);
  const projectName = useProjectsStore((s) => s.currentName);
  const projectStatus = useProjectsStore((s) => s.status);

  return (
    <footer className="flex items-center justify-between border-t border-[#222a36] bg-black/40 px-3 py-1 text-xs text-[#789]">
      <span data-testid="status">{status}</span>
      <span data-testid="project-status">
        {projectName}
        {projectStatus ? ` · ${projectStatus}` : ""}
      </span>
      <span>
        {selMode}
        {pickCount > 0 ? ` · ${pickCount} selected` : ""} · mm · SI
      </span>
    </footer>
  );
}
