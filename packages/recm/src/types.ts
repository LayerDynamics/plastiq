import type { ReactNode } from "react";

export type RecmAnchor =
  | { kind: "world"; point: [number, number, number] }
  | { kind: "screen"; x: number; y: number };

export interface RecmSelection<TValue = unknown> {
  id: string;
  kind: string;
  value?: TValue;
}

export interface RecmRenderedObject<TValue = unknown> {
  id: string;
  kind: string;
  label?: string;
  value?: TValue;
}

export interface RecmRenderedMenu<TValue = unknown> {
  id: string;
  kind: string;
  depth: number;
  value?: TValue;
}

export interface RecmContext<TApp = unknown> {
  origin: RecmAnchor;
  selection: readonly RecmSelection[];
  renderedObjects: readonly RecmRenderedObject[];
  renderedMenus: readonly RecmRenderedMenu[];
  activePath: readonly string[];
  depth: number;
  app?: TApp;
}

export interface RecmOption<TContext, TGroup extends string = string> {
  id: string;
  group: TGroup;
  label: string | ((context: TContext) => string);
  visible?: (context: TContext) => boolean;
  enabled?: (context: TContext) => boolean;
  run?: (context: TContext) => void;
  children?: RecmOptionProvider<TContext, TGroup> | readonly RecmOption<TContext, TGroup>[];
  danger?: boolean;
  icon?: ReactNode;
  priority?: number;
}

export type RecmOptionProvider<TContext, TGroup extends string = string> = (
  context: TContext,
) => readonly RecmOption<TContext, TGroup>[];

export interface RecmMenuItem {
  id: string;
  label: string;
  danger: boolean;
  enabled: boolean;
  icon?: ReactNode;
}

export interface RecmResolvedOption<TContext, TGroup extends string = string> extends RecmMenuItem {
  group: TGroup;
  hasChildren: boolean;
  option: RecmOption<TContext, TGroup>;
}

export interface RecmMenuSection<TGroup extends string = string> {
  group: TGroup;
  items: RecmMenuItem[];
}

export interface RecmRingLevel<TContext, TGroup extends string = string> {
  depth: number;
  options: readonly RecmResolvedOption<TContext, TGroup>[];
  activeId: string | null;
}

export interface RecmTree<TContext, TGroup extends string = string> {
  rings: readonly RecmRingLevel<TContext, TGroup>[];
  activePath: readonly string[];
}

export interface RecmTheme {
  panelBackground: string;
  panelBorder: string;
  groupBackground: string;
  groupBackgroundActive: string;
  itemBackground: string;
  itemBackgroundHover: string;
  text: string;
  dangerText: string;
  disabledOpacity: number;
  shadow: string;
}

export interface RecmConfig<TGroup extends string = string> {
  maxDepth: number;
  groupOrder: readonly TGroup[];
  innerRadius: number;
  ringGap: number;
  ringThickness: number;
  itemWidth: number;
  itemHeight: number;
  centerSize: number;
  testIdPrefix: string;
  theme: RecmTheme;
}

export interface RecmLayoutItem {
  id: string;
  x: number;
  y: number;
  angle: number;
  ring: number;
}

// ---------------------------------------------------------------------------
// Theme subsystem (theme/) — named presets layered over the base RecmTheme.
// ---------------------------------------------------------------------------

/** Built-in preset identifiers shipped in `theme/options.ts`. */
export type RecmThemeName = "dark" | "light" | "highContrast" | "blueprint";

/** A theme reference accepted anywhere a theme can be supplied: a preset name,
 *  a full theme, or a partial override merged onto the resolved base. */
export type RecmThemeInput = RecmThemeName | RecmTheme | Partial<RecmTheme>;

// ---------------------------------------------------------------------------
// Context subsystem (context/) — building + refining a RecmContext through a
// pipeline of pure modifiers before the rings are expanded.
// ---------------------------------------------------------------------------

/** The raw inputs a caller hands the context builder. Everything the menu needs
 *  to know about "what was right-clicked" and "what is on screen". */
export interface RecmContextInput<TApp = unknown> {
  origin: RecmAnchor;
  selection?: readonly RecmSelection[];
  renderedObjects?: readonly RecmRenderedObject[];
  renderedMenus?: readonly RecmRenderedMenu[];
  activePath?: readonly string[];
  depth?: number;
  app?: TApp;
}

/** A pure context transform. Modifiers compose left-to-right; each returns a new
 *  context (never mutates) so the pipeline stays replayable and testable. */
export type RecmContextModifier<TApp = unknown> = (
  context: RecmContext<TApp>,
) => RecmContext<TApp>;

// ---------------------------------------------------------------------------
// Ring expansion (context/rings/) — the state that drives which rings are shown
// and how the active path grows/shrinks as the user reaches outward.
// ---------------------------------------------------------------------------

/** The outward-expansion state of the menu: the active path plus the derived
 *  ring tree for the current context. */
export interface RecmExpansion<TApp = unknown, TGroup extends string = string> {
  tree: RecmTree<RecmContext<TApp>, TGroup>;
  activePath: readonly string[];
  depth: number;
}

// ---------------------------------------------------------------------------
// Manager (context/manager.ts) — the framework-agnostic orchestrator that ties
// the modifier pipeline, ring expansion, and option execution together.
// ---------------------------------------------------------------------------

/** The orchestrator returned by `createRecmManager`. Owns no React state — a
 *  pure state machine the store/hooks/listener drive. */
export interface RecmManager<TApp = unknown, TGroup extends string = string> {
  /** Build a fully-refined context from raw inputs (runs the modifier pipeline). */
  buildContext: (input: RecmContextInput<TApp>) => RecmContext<TApp>;
  /** Expand the rings for a context + active path into a ring tree. */
  expand: (context: RecmContext<TApp>, activePath: readonly string[]) => RecmExpansion<TApp, TGroup>;
  /** Flatten the first ring into ordered sections (for non-radial fallbacks). */
  sections: (context: RecmContext<TApp>) => RecmMenuSection<TGroup>[];
  /** Resolve the terminal option for an id at a depth and, if runnable, run it.
   *  Returns true when an option actually executed. */
  run: (context: RecmContext<TApp>, activePath: readonly string[], id: string) => boolean;
  readonly config: RecmConfig<TGroup>;
  readonly providers: readonly RecmOptionProvider<RecmContext<TApp>, TGroup>[];
}

// ---------------------------------------------------------------------------
// Listener (context/listener.ts) — framework-agnostic DOM wiring.
// ---------------------------------------------------------------------------

/** Callbacks the DOM listener drives. Coordinates are client pixels. */
export interface RecmListenerHandlers {
  /** A right-click (contextmenu) landed on the target; open the menu here. */
  onOpen: (position: { x: number; y: number }, event: MouseEvent) => void;
  /** A dismiss gesture fired (left/middle press elsewhere, Escape). */
  onClose?: () => void;
}

/** Tunables for `attachRecmListeners`. */
export interface RecmListenerOptions {
  /** Suppress the browser's native menu on contextmenu (default true). */
  preventDefault?: boolean;
  /** Also close on window blur (default true). */
  closeOnBlur?: boolean;
}
