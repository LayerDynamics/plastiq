# @Plastiq/recm -  Ring Expanding Context Menu

A Opinionated Fully Featured Context Menu Replacement that Dynamically and algorithmically changes as the options that selected do, expanding outward with new rings and options as needed to fit any and all possible tasks and their selections/menu items/options.

 Initial Ring that offers core categories that are configurable and pluginable and integratable context menu that expands as options are selected and changing depth of rings and options as needed.

 Fully Configurable, Depth, Options, Context origin, selection, ect, all exported and designed to be used in threejs/@react-three/fiber canvas based applications to provide context and selections within the viewport from the menu.

 Completely Compatible and usable specifically within the @react-three/fiber canvas/viewports specifically to pass context down within the the viewport/canvas

 The Menus use the configuration and logic you provide/plug into the component where you import and call it.

```tsx
<Canvas>
 <RECM options{depth(none), configuration('configFile.json'), options('optionsFile.json') context(selection, context( renderedObjects, renderedMenus))} />
 </Canvas>
 
 ```

 It provides render/actions/selection based context and options to dynamically apply the most relevant settings and context menu items to the user possible.

## Usage

The menu is a radial **ring** of pill options around a central hub. Selecting a
category grows a new, larger concentric ring of its children — expanding outward
as the context and selection demand.

World-anchored inside an `@react-three/fiber` `<Canvas>` (pins to a 3D point):

```tsx
import { RECM, createRecmManager, type RecmContext } from "@plastiq/recm";

const providers = [
  (ctx: RecmContext) => [
    { id: "create", group: "create", label: "Create", children: () => [
      { id: "box", group: "create", label: "Box", run: () => addBox() },
    ] },
    { id: "modify", group: "modify", label: "Modify",
      visible: () => ctx.selection.length > 0,
      children: () => [{ id: "delete", group: "modify", label: "Delete", danger: true, run: () => del() }] },
  ],
];

<Canvas>
  <RECM
    open={open}
    anchor={[x, y, z]}
    context={context}          // RecmContext: origin, selection, renderedObjects, renderedMenus
    providers={providers}
    onRun={(id) => dispatch(id)}
    onClose={() => setOpen(false)}
    config={{ theme: "blueprint", maxDepth: 3 }}
  />
</Canvas>
```

Screen-anchored (2D overlay) — compose `RecmLayout` + `RecmMenuView`, or drive the
framework-agnostic `createRecmManager` yourself:

```tsx
import { RecmLayout, RecmMenuView, createRecmManager, createRecmConfig } from "@plastiq/recm";

const manager = createRecmManager({ config: createRecmConfig(), providers, runOption });
const ctx = manager.buildContext({ origin: { kind: "screen", x, y }, selection });
const { tree } = manager.expand(ctx, activePath);

<RecmLayout anchor={{ kind: "screen", x, y }}>
  <RecmMenuView rings={tree.rings} activePath={activePath}
    onPathChange={setActivePath} onRun={(id) => manager.run(ctx, activePath, id)} onClose={close} />
</RecmLayout>
```

A runnable playground lives in `src/App.tsx` — `pnpm --filter @plastiq/recm dev`.

## What's exported

- **Engine:** `createRecmConfig`, `resolveRecmOptions`, `resolveRecmSections`,
  `resolveRecmTree`, `layoutRecmRing(s)`, `recmItemIds`, `createRecmStore`.
- **Components:** `RECM`, `RecmMenuView`, `RecmLayout` (world/screen anchoring).
- **Theme:** `resolveRecmTheme`, `createRecmTheme`, `withTheme`, presets
  (`dark`, `light`, `highContrast`, `blueprint`).
- **Config:** `mergeRecmConfig`, `loadRecmConfig` (from a JSON config file),
  ring-geometry + depth helpers.
- **Context pipeline:** `createRecmContext`, `createRecmManager`,
  `attachRecmListeners`, the selection/renderer modifiers, and ring expansion
  (`expandRings`, `expandPath`, `collapsePath`).
- **Stores & hooks:** per-concern zustand slices under `stores/`, and React hooks
  (`useRecmConfig`, `useRecmSelection`, `useRecmOptions`, `useRecmDepth`,
  `useRegisterRecmObject`, `useRegisterRecmMenu`).

