// App-shell error boundary (Review #17): a render crash anywhere in the editor
// must not leave the user staring at a blank page. The boundary catches it,
// shows the error plus a Reload action, and reminds the user that their work is
// auto-snapshotted: persistence/recovery.ts writes a debounced snapshot of every
// edit to browser storage, and on the next launch projectsStore surfaces a
// dirty snapshot as a "Recover" prompt (App.tsx's RecoveryBanner). The note is
// deliberately hedged — the snapshot is debounced (~0.5 s) and best-effort, so
// the very last edits before a crash may not have landed.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Injectable reload for tests (jsdom cannot navigate); defaults to a real reload. */
  onReload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The boundary swallows the throw (that is its job) — keep the full detail
    // on the console so a crash is still debuggable from devtools.
    console.error("Plastiq crashed while rendering:", error, info.componentStack);
  }

  private readonly reload = (): void => {
    if (this.props.onReload) this.props.onReload();
    else window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        data-testid="error-boundary"
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-4 bg-[#0b0d12] px-6 text-center text-[#cfe]"
      >
        <h1 className="text-lg font-bold">Plastiq hit an unexpected error</h1>
        <pre
          data-testid="error-boundary-message"
          className="max-h-40 max-w-xl overflow-auto whitespace-pre-wrap rounded border border-[#3a2a2a] bg-[#180f12] px-3 py-2 text-left text-xs text-[#ff9a9a]"
        >
          {this.state.error.message || String(this.state.error)}
        </pre>
        <p className="max-w-md text-xs text-[#9ab]">
          Plastiq auto-snapshots your work to browser storage as you edit. After
          reloading, you&apos;ll be offered any unsaved work the last snapshot
          captured (edits from the final moments before the crash may be missing).
        </p>
        <button
          type="button"
          data-testid="error-boundary-reload"
          onClick={this.reload}
          className="rounded border border-[#2a4a6a] bg-[#12233a] px-4 py-1.5 text-sm text-[#9ecbff] hover:bg-[#1a3050]"
        >
          Reload
        </button>
      </div>
    );
  }
}
