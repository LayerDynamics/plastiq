// ⌘/Ctrl+S (Review #17): save the open project from the keyboard. Named
// projects save in place; an untitled document goes through the SAME save-as
// prompt affordance as ProjectsMenu's "Save As" button (window.prompt → the
// projects store's saveAs). preventDefault is unconditional for the chord so
// the browser's own "Save page" dialog can never open. Kept in its own module
// so App.tsx's keydown handler stays a thin dispatcher and this path is unit-
// testable without mounting the whole editor (App pulls in the WebGL viewport).

import { useProjectsStore } from "../persistence/projectsStore.js";

/**
 * Handle a keydown if it is the save chord. Returns true when the event was
 * the chord (and was consumed), false otherwise — the caller falls through to
 * its other shortcuts on false. Like ⌘K, the chord is universal: it also fires
 * while typing in a field (the browser would otherwise open its save dialog
 * from there too), and saving mid-edit is harmless.
 */
export function handleSaveShortcut(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return false;
  e.preventDefault(); // the browser's "Save page as…" dialog must never open
  const projects = useProjectsStore.getState();
  if (projects.currentId) {
    void projects.save();
  } else {
    // Untitled → prompt for a name first (mirrors ProjectsMenu.onSaveAs).
    const name = window.prompt(
      "Save project as:",
      projects.currentName === "Untitled" ? "My Part" : projects.currentName,
    );
    if (name?.trim()) void projects.saveAs(name.trim());
  }
  return true;
}
