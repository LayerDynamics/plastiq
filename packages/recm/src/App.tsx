// Dev harness / live demo for @plastiq/recm. A self-contained playground: a
// "viewport" surface you right-click to open the ring menu at the cursor, a row
// of selectable objects that changes which options are relevant (the Modify ring
// only appears once something is selected), a theme-preset switcher, and an
// action log. It drives the real engine end-to-end — createRecmManager builds +
// refines context through the modifier pipeline, expands the rings, and runs the
// chosen option — with zero WebGL so it runs anywhere.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachRecmListeners,
  createRecmConfig,
  createRecmManager,
  RECM_THEME_NAMES,
  RecmLayout,
  RecmMenuView,
  withTheme,
} from "./index.js";
import type {
  RecmContext,
  RecmOptionProvider,
  RecmThemeName,
} from "./index.js";

type DemoGroup = "create" | "modify" | "view";
interface DemoApp {
  surface: "viewport";
}

/** The action logger is read at call time via this ref so provider closures /
 *  the manager (created once per config) always reach the latest React setter. */
const actionRef: { current: (id: string) => void } = { current: () => {} };
const log = (id: string): void => actionRef.current(id);

/** Static, pluggable option tree — the "options file" a host would supply. The
 *  Modify ring is gated on there being a selection, exactly the dynamic behavior
 *  the README describes ("expanding as the options that are selected do"). */
const demoProviders: readonly RecmOptionProvider<RecmContext<DemoApp>, DemoGroup>[] = [
  (ctx) => [
    {
      id: "create",
      group: "create",
      label: "Create",
      children: () => [
        { id: "create/box", group: "create", label: "Box", run: () => log("create/box") },
        { id: "create/sphere", group: "create", label: "Sphere", run: () => log("create/sphere") },
        { id: "create/cyl", group: "create", label: "Cylinder", run: () => log("create/cyl") },
        { id: "create/cone", group: "create", label: "Cone", run: () => log("create/cone") },
      ],
    },
    {
      id: "modify",
      group: "modify",
      label: "Modify",
      visible: () => ctx.selection.length > 0,
      children: () => [
        { id: "modify/move", group: "modify", label: "Move", run: () => log("modify/move") },
        { id: "modify/rotate", group: "modify", label: "Rotate", run: () => log("modify/rotate") },
        { id: "modify/scale", group: "modify", label: "Scale", run: () => log("modify/scale") },
        {
          id: "modify/delete",
          group: "modify",
          label: "Delete",
          danger: true,
          run: () => log("modify/delete"),
        },
      ],
    },
    {
      id: "view",
      group: "view",
      label: "View",
      children: () => [
        { id: "view/fit", group: "view", label: "Fit", run: () => log("view/fit") },
        { id: "view/wire", group: "view", label: "Wireframe", run: () => log("view/wire") },
        { id: "view/shaded", group: "view", label: "Shaded", run: () => log("view/shaded") },
        { id: "view/reset", group: "view", label: "Reset", run: () => log("view/reset") },
      ],
    },
  ],
];

const DEMO_OBJECTS = [
  { id: "obj:a", label: "Bracket" },
  { id: "obj:b", label: "Flange" },
  { id: "obj:c", label: "Housing" },
  { id: "obj:d", label: "Shaft" },
] as const;

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  activePath: string[];
}

export function App(): React.JSX.Element {
  const [config, setConfig] = useState(() =>
    createRecmConfig<DemoGroup>({ groupOrder: ["create", "modify", "view"] }),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<MenuState>({ open: false, x: 0, y: 0, activePath: [] });
  const [ctx, setCtx] = useState<RecmContext<DemoApp> | null>(null);
  const [entries, setEntries] = useState<string[]>([]);
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    actionRef.current = (id: string) =>
      setEntries((prev) => [id, ...prev].slice(0, 12));
  }, []);

  const manager = useMemo(
    () =>
      createRecmManager<DemoApp, DemoGroup>({
        config,
        providers: demoProviders,
        runOption: (id) => log(id),
      }),
    [config],
  );

  const closeMenu = useCallback(() => setMenu((m) => ({ ...m, open: false })), []);

  const openMenu = useCallback(
    (x: number, y: number) => {
      const selection = [...selected].map((id) => ({ id, kind: "object", value: id }));
      const context = manager.buildContext({
        origin: { kind: "screen", x, y },
        selection,
        app: { surface: "viewport" },
      });
      setCtx(context);
      setMenu({ open: true, x, y, activePath: [] });
    },
    [manager, selected],
  );

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    return attachRecmListeners(el, {
      onOpen: (_pos, event) => openMenu(event.clientX, event.clientY),
      onClose: closeMenu,
    });
  }, [openMenu, closeMenu]);

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const theme = config.theme;
  const rings = menu.open && ctx ? manager.expand(ctx, menu.activePath).tree.rings : [];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 260px",
        height: "100%",
        background: "#0b0e14",
        color: theme.text,
      }}
    >
      <div style={{ position: "relative", display: "flex", flexDirection: "column" }}>
        <header style={{ padding: "14px 18px", borderBottom: `1px solid ${theme.panelBorder}` }}>
          <strong style={{ fontSize: 15 }}>@plastiq/recm</strong>
          <span style={{ opacity: 0.7, marginLeft: 10, fontSize: 13 }}>
            Ring Expanding Context Menu — right-click the viewport
          </span>
        </header>
        <div
          ref={surfaceRef}
          data-testid="recm-demo-surface"
          style={{
            flex: 1,
            margin: 18,
            borderRadius: 10,
            border: `1px dashed ${theme.panelBorder}`,
            background:
              "repeating-linear-gradient(45deg,#0d1119,#0d1119 14px,#10151f 14px,#10151f 28px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            userSelect: "none",
            cursor: "context-menu",
          }}
        >
          <span style={{ opacity: 0.5, fontSize: 13 }}>
            {selected.size > 0
              ? `${selected.size} selected — right-click for Create · Modify · View`
              : "Nothing selected — right-click for Create · View"}
          </span>
        </div>
      </div>

      <aside
        style={{
          borderLeft: `1px solid ${theme.panelBorder}`,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflow: "auto",
          background: theme.panelBackground,
        }}
      >
        <section>
          <h3 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", opacity: 0.7 }}>
            Objects
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {DEMO_OBJECTS.map((object) => {
              const on = selected.has(object.id);
              return (
                <button
                  key={object.id}
                  type="button"
                  onClick={() => toggle(object.id)}
                  style={{
                    border: `1px solid ${on ? theme.groupBackgroundActive : theme.panelBorder}`,
                    background: on ? theme.groupBackgroundActive : theme.groupBackground,
                    color: theme.text,
                    borderRadius: 6,
                    padding: "5px 9px",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  {object.label}
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <h3 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", opacity: 0.7 }}>
            Theme
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {RECM_THEME_NAMES.map((name: RecmThemeName) => (
              <button
                key={name}
                type="button"
                data-testid={`recm-demo-theme-${name}`}
                onClick={() => setConfig((current) => withTheme(current, name))}
                style={{
                  border: `1px solid ${theme.panelBorder}`,
                  background: theme.groupBackground,
                  color: theme.text,
                  borderRadius: 6,
                  padding: "5px 9px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </section>

        <section style={{ flex: 1 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", opacity: 0.7 }}>
            Action log
          </h3>
          {entries.length === 0 ? (
            <p style={{ opacity: 0.5, fontSize: 12 }}>Run an option to see it here.</p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 12 }}>
              {entries.map((entry, index) => (
                <li key={`${entry}-${index}`} style={{ padding: "3px 0", opacity: 1 - index * 0.06 }}>
                  {entry}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      {menu.open && ctx ? (
        <RecmLayout anchor={{ kind: "screen", x: menu.x, y: menu.y }}>
          <RecmMenuView
            rings={rings}
            activePath={menu.activePath}
            onPathChange={(path) => setMenu((m) => ({ ...m, activePath: [...path] }))}
            onRun={(id) => {
              if (ctx) manager.run(ctx, menu.activePath, id);
              closeMenu();
            }}
            onClose={closeMenu}
            config={config}
            testid="recm-demo-menu"
          />
        </RecmLayout>
      ) : null}
    </div>
  );
}
