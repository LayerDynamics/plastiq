import { useEffect, useMemo, useRef, useState } from "react";
import { createRecmConfig } from "../config.js";
import type { RecmConfig, RecmRingLevel } from "../types.js";

interface RecmMenuViewProps<TContext, TGroup extends string = string> {
  rings: readonly RecmRingLevel<TContext, TGroup>[];
  activePath: readonly string[];
  onPathChange: (path: readonly string[]) => void;
  onRun: (id: string) => void;
  onClose?: () => void;
  config?: Partial<RecmConfig<TGroup>>;
  onConfigChange?: (config: RecmConfig<TGroup>) => void;
  testid?: string;
  /** Per-node data-testid formatter. Defaults to `recm-ring-{depth}-{id}`. A host
   *  can override to match its own convention (e.g. `(id) => \`ctx-${id}\``). */
  itemTestId?: (id: string, depth: number) => string;
}

/** A single option rendered as a pill node sitting ON its ring. Positions are in
 *  centered SVG space (origin = the hub center); labels stay upright. */
interface RecmNode {
  id: string;
  label: string;
  danger: boolean;
  enabled: boolean;
  hasChildren: boolean;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const UI_SCALE = 1.15;

/** A point on a circle of `radius` at `angle` (0 = +x, clockwise in SVG y-down). */
function point(radius: number, angle: number): { x: number; y: number } {
  return { x: Math.cos(radius === 0 ? 0 : angle) * radius, y: Math.sin(angle) * radius };
}

interface RingGeometry {
  nodes: RecmNode[];
  radii: number[];
  outerRadius: number;
  size: number;
  hubRadius: number;
  font: number;
}

/**
 * Lay every ring's options out as pill nodes evenly spaced around concentric
 * rings that grow OUTWARD. Each ring's radius is the max of (a) a step beyond the
 * previous ring and (b) the circumference needed so its nodes never overlap — so
 * the menu literally "expands outward as needed to fit" whatever options appear.
 */
function buildRingGeometry<TContext, TGroup extends string>(
  rings: readonly RecmRingLevel<TContext, TGroup>[],
  config: RecmConfig<TGroup>,
): RingGeometry {
  const hubRadius = Math.max(12, config.centerSize / 2) * UI_SCALE;
  const ring0 = hubRadius + Math.max(0, config.innerRadius) * UI_SCALE + 16 * UI_SCALE;
  const gapBetween = Math.max(8, config.ringGap) * UI_SCALE;
  const pillH = Math.max(22, config.itemHeight) * UI_SCALE;
  const font = Math.max(10, Math.min(13.5, config.itemHeight * 0.42)) * UI_SCALE;
  const charW = font * 0.62;
  const minPill = Math.max(46 * UI_SCALE, config.itemWidth * 0.5 * UI_SCALE);
  const pillWidth = (label: string): number =>
    Math.max(minPill, label.length * charW + 20 * UI_SCALE);
  // Extra radial step contributed by the "thickness" control, kept meaningful in
  // the node layout as additional ring separation.
  const thicknessStep = Math.max(0, config.ringThickness) * 0.25 * UI_SCALE;

  const nodes: RecmNode[] = [];
  const radii: number[] = [];
  let prevRadius = 0;

  rings.forEach((ring, index) => {
    const count = ring.options.length;
    const widths = ring.options.map((option) => pillWidth(option.label));
    const maxWidth = Math.max(...widths, minPill);
    // Radius needed so `count` pills of `maxWidth` (+ gap) fit around the circle.
    const fitRadius = count > 1 ? (count * (maxWidth + 12 * UI_SCALE)) / (2 * Math.PI) : ring0;
    const stepRadius =
      index === 0 ? ring0 : prevRadius + pillH + gapBetween + thicknessStep;
    const radius = Math.max(stepRadius, fitRadius);
    radii[index] = radius;
    prevRadius = radius;

    const step = (Math.PI * 2) / Math.max(1, count);
    const start = -Math.PI / 2;
    ring.options.forEach((option, i) => {
      const angle = count === 1 ? start : start + step * i;
      const position = point(radius, angle);
      nodes.push({
        id: option.id,
        label: option.label,
        danger: option.danger,
        enabled: option.enabled,
        hasChildren: option.hasChildren,
        depth: ring.depth,
        x: position.x,
        y: position.y,
        w: widths[i] ?? maxWidth,
        h: pillH,
      });
    });
  });

  const lastRadius = radii[radii.length - 1] ?? ring0;
  const maxHalfExtent = Math.max(...nodes.map((n) => Math.hypot(n.w / 2, n.h / 2)), pillH);
  const outerRadius = lastRadius + maxHalfExtent + 10 * UI_SCALE;
  return { nodes, radii, outerRadius, size: outerRadius * 2, hubRadius, font };
}

export function RecmMenuView<TContext, TGroup extends string = string>({
  rings,
  activePath,
  onPathChange,
  onRun,
  onClose,
  config: configOverrides,
  onConfigChange,
  testid = "recm-context-menu",
  itemTestId = (id, depth) => `recm-ring-${depth}-${id}`,
}: RecmMenuViewProps<TContext, TGroup>): React.JSX.Element {
  const [config, setConfig] = useState(() => createRecmConfig<TGroup>(configOverrides));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [rings]);

  const updateConfig = <K extends keyof RecmConfig<TGroup>>(
    key: K,
    value: RecmConfig<TGroup>[K],
  ): void => {
    setConfig((current) => {
      const next = { ...current, [key]: value };
      onConfigChange?.(next);
      return next;
    });
  };

  const resetConfig = (): void => {
    const next = createRecmConfig<TGroup>(configOverrides);
    setConfig(next);
    onConfigChange?.(next);
  };

  const { nodes, radii, outerRadius, size, hubRadius, font } = useMemo(
    () => buildRingGeometry(rings, config),
    [rings, config],
  );

  // The center of each active-path step, hub-first, so we can draw a connector
  // that visibly traces the expansion branch from the hub outward.
  const branch = useMemo(() => {
    const centers: { x: number; y: number }[] = [{ x: 0, y: 0 }];
    for (const ring of rings) {
      const activeId = activePath[ring.depth] ?? ring.activeId;
      const node = nodes.find((n) => n.depth === ring.depth && n.id === activeId);
      if (!node) break;
      centers.push({ x: node.x, y: node.y });
    }
    return centers;
  }, [rings, nodes, activePath]);

  const pathFor = (depth: number, id: string): string[] => [...activePath.slice(0, depth), id];

  const activate = (node: RecmNode): void => {
    const nextPath = pathFor(node.depth, node.id);
    onPathChange(nextPath);
    if (!node.hasChildren && node.enabled) onRun(node.id);
  };

  const enabledItems = (): HTMLElement[] =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape" && settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (e.key === "Escape") {
      onClose?.();
      return;
    }
    if (e.key === "Enter") {
      const el = document.activeElement as HTMLElement | null;
      const optionId = el?.dataset["optionId"];
      const depth = Number(el?.dataset["depth"] ?? 0);
      const hasChildren = el?.dataset["hasChildren"] === "true";
      if (!optionId) return;
      const nextPath = pathFor(depth, optionId);
      onPathChange(nextPath);
      if (!hasChildren) onRun(optionId);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowLeft" && e.key !== "ArrowRight")
      return;
    e.preventDefault();
    const items = enabledItems();
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    items[(idx + delta + items.length) % items.length]?.focus();
  };

  return (
    <div
      ref={ref}
      data-testid={testid}
      role="menu"
      tabIndex={-1}
      style={{
        position: "relative",
        width: size,
        height: size,
        pointerEvents: "auto",
        userSelect: "none",
      }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerLeave={() => setHovered(null)}
    >
      <svg
        width={size}
        height={size}
        viewBox={`${-outerRadius} ${-outerRadius} ${size} ${size}`}
        style={{ display: "block", filter: `drop-shadow(${config.theme.shadow})` }}
      >
        {/* The rings themselves: faint concentric guide circles the nodes sit on. */}
        {radii.map((radius, index) => (
          <circle
            key={`ring-${index}`}
            cx={0}
            cy={0}
            r={radius}
            fill="none"
            stroke={config.theme.panelBorder}
            strokeWidth={1 * UI_SCALE}
            opacity={0.5}
          />
        ))}
        {/* Connector tracing the active branch from the hub outward. */}
        {branch.slice(1).map((center, index) => {
          const from = branch[index]!;
          return (
            <line
              key={`branch-${index}`}
              x1={from.x}
              y1={from.y}
              x2={center.x}
              y2={center.y}
              stroke={config.theme.groupBackgroundActive}
              strokeWidth={2 * UI_SCALE}
              opacity={0.75}
            />
          );
        })}
        {/* Option nodes: pill buttons with upright labels. */}
        {nodes.map((node) => {
          const active = activePath[node.depth] === node.id;
          const highlighted = active || hovered === `${node.depth}:${node.id}`;
          return (
            <g
              key={`${node.depth}:${node.id}`}
              role="menuitem"
              tabIndex={node.enabled ? 0 : -1}
              data-testid={itemTestId(node.id, node.depth)}
              data-option-id={node.id}
              data-depth={node.depth}
              data-has-children={node.hasChildren ? "true" : "false"}
              aria-disabled={node.enabled ? "false" : "true"}
              onClick={() => {
                if (node.enabled) activate(node);
              }}
              onPointerEnter={() => {
                if (node.enabled) {
                  setHovered(`${node.depth}:${node.id}`);
                  onPathChange(pathFor(node.depth, node.id));
                }
              }}
              style={{
                cursor: node.enabled ? "pointer" : "not-allowed",
                opacity: node.enabled ? 1 : config.theme.disabledOpacity,
                outline: "none",
              }}
            >
              <rect
                x={node.x - node.w / 2}
                y={node.y - node.h / 2}
                width={node.w}
                height={node.h}
                rx={node.h / 2}
                ry={node.h / 2}
                fill={highlighted ? config.theme.itemBackgroundHover : config.theme.itemBackground}
                stroke={active ? config.theme.groupBackgroundActive : config.theme.panelBorder}
                strokeWidth={(active ? 2 : 1.2) * UI_SCALE}
              />
              <text
                x={node.x}
                y={node.y}
                textAnchor="middle"
                dominantBaseline="central"
                fill={node.danger ? config.theme.dangerText : config.theme.text}
                fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
                fontSize={font}
                fontWeight={500}
                pointerEvents="none"
              >
                {node.label}
              </text>
            </g>
          );
        })}
        {/* Center hub — doubles as the live-settings toggle. Drawn last (on top). */}
        <circle
          cx={0}
          cy={0}
          r={hubRadius}
          fill={config.theme.panelBackground}
          stroke={config.theme.panelBorder}
          strokeWidth={1.2 * UI_SCALE}
        />
        <g
          role="button"
          tabIndex={0}
          aria-expanded={settingsOpen ? "true" : "false"}
          data-testid={`${testid}-settings-toggle`}
          style={{ cursor: "pointer" }}
          onClick={() => setSettingsOpen((current) => !current)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setSettingsOpen((current) => !current);
            }
          }}
        >
          <circle
            cx={0}
            cy={0}
            r={hubRadius - 2 * UI_SCALE}
            fill={settingsOpen ? config.theme.groupBackgroundActive : config.theme.groupBackground}
            stroke={config.theme.panelBorder}
            strokeWidth={1 * UI_SCALE}
          />
          <text
            x={0}
            y={0}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={config.theme.text}
            fontSize={(settingsOpen ? 12 : 11) * UI_SCALE}
            fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
            pointerEvents="none"
          >
            {settingsOpen ? "⚙" : "RECM"}
          </text>
        </g>
      </svg>
      {settingsOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          data-testid={`${testid}-settings-panel`}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              width: Math.min(322, size - 24 * UI_SCALE),
              maxHeight: size - 24 * UI_SCALE,
              display: "flex",
              flexDirection: "column",
              gap: 10 * UI_SCALE,
              padding: 12 * UI_SCALE,
              borderRadius: 8,
              background: config.theme.panelBackground,
              border: `1px solid ${config.theme.panelBorder}`,
              boxShadow: config.theme.shadow,
              color: config.theme.text,
              pointerEvents: "auto",
              overflow: "auto",
              boxSizing: "border-box",
              fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong style={{ fontSize: 12 * UI_SCALE, fontWeight: 600 }}>Settings</strong>
              <button
                type="button"
                data-testid={`${testid}-settings-close`}
                onClick={() => setSettingsOpen(false)}
                style={{
                  border: 0,
                  background: config.theme.groupBackground,
                  color: config.theme.text,
                  width: 24 * UI_SCALE,
                  height: 24 * UI_SCALE,
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
            {(
              [
                ["innerRadius", "Center gap", 0, 72, 1],
                ["ringGap", "Ring gap", 0, 56, 1],
                ["ringThickness", "Ring spacing", 20, 72, 1],
                ["itemHeight", "Node size", 22, 48, 1],
                ["maxDepth", "Max depth", 1, 8, 1],
              ] as const
            ).map(([key, label, min, max, step]) => (
              <label
                key={key}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 66px",
                    gap: 8,
                    alignItems: "center",
                    fontSize: 11 * UI_SCALE,
                    lineHeight: 1.1,
                  }}
                >
                <span>{label}</span>
                <input
                  type="number"
                  data-testid={`${testid}-setting-${key}-number`}
                  min={min}
                  max={max}
                  step={step}
                  value={config[key]}
                  onChange={(e) => updateConfig(key, Number(e.currentTarget.value))}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      borderRadius: 6,
                      border: `1px solid ${config.theme.panelBorder}`,
                      background: config.theme.groupBackground,
                      color: config.theme.text,
                      padding: "4px 6px",
                      fontSize: 11 * UI_SCALE,
                    }}
                  />
                <input
                  type="range"
                  data-testid={`${testid}-setting-${key}-range`}
                  min={min}
                  max={max}
                  step={step}
                  value={config[key]}
                  onChange={(e) => updateConfig(key, Number(e.currentTarget.value))}
                  style={{ gridColumn: "1 / -1", width: "100%" }}
                />
              </label>
            ))}
            <button
              type="button"
              data-testid={`${testid}-settings-reset`}
              onClick={resetConfig}
              style={{
                border: `1px solid ${config.theme.panelBorder}`,
                background: config.theme.groupBackground,
                color: config.theme.text,
                borderRadius: 6,
                padding: `${6 * UI_SCALE}px ${8 * UI_SCALE}px`,
                fontSize: 11 * UI_SCALE,
                cursor: "pointer",
                alignSelf: "flex-start",
              }}
            >
              Reset
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
