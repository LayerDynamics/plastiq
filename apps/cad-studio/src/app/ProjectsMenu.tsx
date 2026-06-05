// Projects menu (SPEC-5 M5.3, FR-37): the open project's name + New / Save /
// Save As, and an Open dropdown listing saved projects with rename/delete +
// thumbnails. Wired to the projects store (SQLite-backed).

import { useState } from "react";
import { useProjectsStore } from "../persistence/projectsStore.js";

export function ProjectsMenu(): React.JSX.Element {
  const list = useProjectsStore((s) => s.list);
  const currentId = useProjectsStore((s) => s.currentId);
  const currentName = useProjectsStore((s) => s.currentName);
  const newProject = useProjectsStore((s) => s.newProject);
  const open = useProjectsStore((s) => s.open);
  const save = useProjectsStore((s) => s.save);
  const saveAs = useProjectsStore((s) => s.saveAs);
  const rename = useProjectsStore((s) => s.rename);
  const remove = useProjectsStore((s) => s.remove);

  const [openList, setOpenList] = useState(false);

  const onSaveAs = (): void => {
    const name = window.prompt(
      "Save project as:",
      currentName === "Untitled" ? "My Part" : currentName,
    );
    if (name?.trim()) void saveAs(name.trim());
  };
  const onRename = (id: string, current: string): void => {
    const name = window.prompt("Rename project:", current);
    if (name?.trim()) void rename(id, name.trim());
  };

  const btn = "rounded px-1.5 py-0.5 text-xs text-[#9ab] hover:bg-[#1b2230]";
  return (
    <div
      data-testid="projects-menu"
      className="relative flex items-center gap-0.5 rounded border border-[#2a3444] px-1"
    >
      <span className="px-1 text-[10px] uppercase text-[#567]">Project</span>
      <span
        data-testid="project-name"
        className="max-w-32 truncate px-1 text-xs text-[#cfe]"
        title={currentName}
      >
        {currentName}
        {currentId === null && <span className="text-[#a85]"> •</span>}
      </span>
      <button type="button" data-testid="project-new" className={btn} onClick={newProject}>
        New
      </button>
      <button type="button" data-testid="project-save" className={btn} onClick={() => void save()}>
        Save
      </button>
      <button type="button" data-testid="project-save-as" className={btn} onClick={onSaveAs}>
        Save As
      </button>
      <button
        type="button"
        data-testid="project-open"
        className={btn}
        onClick={() => setOpenList((v) => !v)}
      >
        Open ▾
      </button>

      {openList && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-72 overflow-auto rounded border border-[#2a3444] bg-[#0e1219] p-1 shadow-xl">
          {list.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-[#789]">No saved projects.</p>
          ) : (
            list.map((p) => (
              <div
                key={p.id}
                data-testid="project-row"
                data-project-id={p.id}
                className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[#1b2230]"
              >
                {p.thumbnail ? (
                  <img
                    src={p.thumbnail}
                    alt=""
                    className="h-8 w-8 rounded border border-[#2a3444] object-cover"
                  />
                ) : (
                  <div className="h-8 w-8 rounded border border-[#2a3444] bg-[#11161f]" />
                )}
                <button
                  type="button"
                  className="flex-1 truncate text-left text-xs text-[#cfe]"
                  onClick={() => {
                    setOpenList(false);
                    void open(p.id);
                  }}
                  title={p.name}
                >
                  {p.name}
                </button>
                <button
                  type="button"
                  title="Rename"
                  className="invisible rounded px-1 text-xs text-[#789] hover:text-[#cfe] group-hover:visible"
                  onClick={() => onRename(p.id, p.name)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  title="Delete"
                  className="invisible rounded px-1 text-xs text-[#789] hover:text-[#ff6b6b] group-hover:visible"
                  onClick={() => void remove(p.id)}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
