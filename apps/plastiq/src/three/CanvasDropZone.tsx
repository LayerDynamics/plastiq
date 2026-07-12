// The canvas drop target (SPEC-13, Task #13): wraps the 3D viewport and routes files dropped on it —
// a folder of photos → photogrammetry → dense point cloud; a .ply/.xyz/.json → a point cloud. The
// classify + route logic is the pure, tested canvasDrop.ts; this component is the thin DOM glue that
// binds it to the live stores/services and shows a drag-over affordance. Non-file drags (text, etc.)
// pass straight through so nothing else on the canvas is disturbed.

import { useRef, useState } from "react";
import { routeDroppedFiles, type DropRouteDeps } from "./canvasDrop.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { useAiStore } from "../ai/aiStore.js";
import { fileToBase64 } from "../ai/fileRead.js";
import { parseCloudFileToDoc } from "../ai/pointcloudFile.js";
import { denseCloudToPointCloudDoc, solvePhotogrammetry } from "../ai/photogrammetry.js";
import {
  PHOTOGRAMMETRY_DEFAULT_BASE_URL,
  checkServiceHealth,
  serviceUnreachableMessage,
} from "../ai/errorHints.js";

/** Wire the pure router to the live stores/services. Photos go through a health-checked
 * photogrammetry solve (dense on) whose dense cloud becomes the PointCloudDoc; cloud files parse
 * directly. Both persist as a new cloud project and open it, so the result shows on the canvas. */
function liveDropDeps(): DropRouteDeps<File> {
  return {
    readText: (f) => f.text(),
    readBase64: fileToBase64,
    parseCloudFile: parseCloudFileToDoc,
    solvePhotos: async (images) => {
      const baseURL = useAiStore.getState().settings?.photogrammetryBaseURL;
      const healthBase = (baseURL ?? PHOTOGRAMMETRY_DEFAULT_BASE_URL).replace(/\/+$/, "");
      if (!(await checkServiceHealth(healthBase))) {
        throw new Error(serviceUnreachableMessage("photogrammetry", healthBase));
      }
      const res = await solvePhotogrammetry(
        { images: images.map((i) => i.data), names: images.map((i) => i.name), dense: true },
        baseURL ? { baseURL } : {},
      );
      if (!res.densePly) {
        throw new Error("photogrammetry produced no dense cloud — try more overlapping views");
      }
      return denseCloudToPointCloudDoc(res.densePly, "Photogrammetry cloud");
    },
    persistCloud: (doc) => useProjectsStore.getState().createPointCloudProject(doc),
    open: (id) => useProjectsStore.getState().open(id),
    setStatus: (s) => useProjectsStore.setState({ status: s }),
  };
}

/** True when a drag carries files (so we ignore text/element drags). */
function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

export function CanvasDropZone({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child crossed; a depth counter avoids flicker.
  const depth = useRef(0);

  return (
    <div
      className="relative h-full w-full"
      onDragEnter={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (dragHasFiles(e)) e.preventDefault(); // allow the drop
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) void routeDroppedFiles(files, liveDropDeps());
      }}
    >
      {children}
      {dragging && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-[#4ea1ff] bg-[#0b0d12]/70 text-center text-sm text-[#cfe]"
        >
          Drop photos (≥3) to reconstruct, or a .ply / .xyz / .json point cloud
        </div>
      )}
    </div>
  );
}
