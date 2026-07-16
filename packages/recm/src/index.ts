// Public API for @plastiq/recm. The flat engine (config/options/layout/store)
// stays the stable core; the subsystem exports below expose the granular,
// separation-of-concerns modules (theme, config, context pipeline, stores,
// hooks) for hosts that want to compose the menu themselves.

// --- Flat engine (stable core) -------------------------------------------
export { defaultRecmTheme, DEFAULT_GROUP_ORDER, createRecmConfig } from "./config.js";
export {
  buildRecmSections,
  optionProviderFromList,
  recmItemIds,
  resolveRecmOptions,
  resolveRecmSections,
  resolveRecmTree,
} from "./options.js";
export { layoutRecmRing, layoutRecmRings } from "./layout.js";
export { createRecmStore, type RecmStoreState, type RecmStore } from "./store.js";
export { RecmMenuView } from "./components/RecmMenuView.js";
export { RECM } from "./components/RECM.js";
export { RecmLayout } from "./components/Layout.js";

// --- Theme subsystem (theme/) --------------------------------------------
export { baseRecmTheme, RECM_COLOR_TOKENS, type RecmColorToken } from "./theme/base.js";
export {
  RECM_THEME_PRESETS,
  RECM_THEME_NAMES,
  isRecmThemeName,
} from "./theme/options.js";
export { createRecmTheme, mergeRecmTheme, resolveRecmTheme } from "./theme/theme.js";
export { withTheme } from "./theme/config.js";

// --- Config subsystem (config/) ------------------------------------------
export { clampMaxDepth, clampDepth, isDepthVisible, DEFAULT_MAX_DEPTH, MAX_SUPPORTED_DEPTH } from "./config/depth.js";
export {
  ringCenterRadius,
  ringStep,
  ringInnerRadius,
  ringOuterRadius,
  menuRadius,
  menuDiameter,
} from "./config/rings.js";
export { orderGroups } from "./config/options.js";
export { mergeRecmConfig, loadRecmConfig, type RecmConfigFile } from "./config/config.js";

// --- Context subsystem (context/) ----------------------------------------
export { createRecmContext, extendRecmContext, withActivePath } from "./context/context.js";
export {
  normalizeSelection,
  hasSelection,
  selectionCount,
  isMultiSelect,
  primarySelection,
  selectionKinds,
  selectionByKind,
  isHomogeneousSelection,
} from "./context/selection.js";
export { selectedObjectModifier } from "./context/selectionModifiers/selectedObject.js";
export { selectedMenuModifier } from "./context/selectionModifiers/selectedMenu.js";
export {
  renderedObjectsModifier,
  dedupeRenderedObjects,
} from "./context/rendererModifiers/renderedObjects.js";
export {
  renderedMenusModifier,
  dedupeRenderedMenus,
  deepestRenderedMenu,
} from "./context/rendererModifiers/renderedMenus.js";
export { expandRings, expandPath, collapsePath, isPathActive } from "./context/rings/expansion.js";
export { ringOptions, activeOption, findOption, terminalOption } from "./context/rings/options.js";
export { resolvedDepth, canExpand } from "./context/rings/depth.js";
export { ringAtDepth, rootRing, ringsToSections } from "./context/rings/rings.js";
export { defaultRecmModifiers, runModifiers, deriveRenderContext } from "./context/renderer.js";
export {
  createRecmManager,
  type CreateRecmManagerInput,
} from "./context/manager.js";
export { attachRecmListeners } from "./context/listener.js";

// --- Store slices (stores/) ----------------------------------------------
export { createConfigSlice, type RecmConfigSlice } from "./stores/configStore.js";
export { createSelectionSlice, type RecmSelectionSlice } from "./stores/selectionStore.js";
export { createObjectSlice, type RecmObjectSlice } from "./stores/objectStore.js";
export { createMenuSlice, type RecmMenuSlice } from "./stores/menuStore.js";
export { createOptionSlice, optionIds, type RecmOptionSlice } from "./stores/optionStore.js";
export { createRingSlice, type RecmRingSlice } from "./stores/ringStore.js";
export {
  createContextSlice,
  type RecmContextSlice,
  type RecmContextSliceDeps,
} from "./stores/contextStore.js";

// --- Hooks (hooks/) ------------------------------------------------------
export { useRecmConfig } from "./hooks/useConfig.js";
export { useRecmDepth, type RecmDepthState } from "./hooks/useDepth.js";
export { useRecmOptions, type RecmOptionsState } from "./hooks/useOptions.js";
export { useRecmSelection, type RecmSelectionState } from "./hooks/useSelection.js";
export {
  useRecmRenderedObjects,
  useRegisterRecmObject,
  type RecmRenderedObjectsState,
} from "./hooks/useRenderedObject.js";
export {
  useRecmRenderedMenus,
  useRegisterRecmMenu,
  type RecmRenderedMenusState,
} from "./hooks/useRenderedMenu.js";

// --- Types ---------------------------------------------------------------
export type {
  RecmAnchor,
  RecmConfig,
  RecmContext,
  RecmContextInput,
  RecmContextModifier,
  RecmExpansion,
  RecmLayoutItem,
  RecmListenerHandlers,
  RecmListenerOptions,
  RecmManager,
  RecmMenuItem,
  RecmMenuSection,
  RecmOption,
  RecmOptionProvider,
  RecmResolvedOption,
  RecmRingLevel,
  RecmTree,
  RecmRenderedMenu,
  RecmRenderedObject,
  RecmSelection,
  RecmTheme,
  RecmThemeInput,
  RecmThemeName,
} from "./types.js";
