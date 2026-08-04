// Fusion-style Text Commands runtime. This is an APPLICATION command shell, not
// an operating-system shell: every mutation crosses the same public stores and
// action registry as the visible editor controls, preserving context gates,
// document history, and worker/service status reporting.

import { ACTIONS, runAction } from "../actions/registry.js";
import { useAiStore } from "../ai/aiStore.js";
import {
  CAPTURE_DEFAULT_BASE_URL,
  NERF_DEFAULT_BASE_URL,
  PHOTOGRAMMETRY_DEFAULT_BASE_URL,
  RECONSTRUCT_DEFAULT_BASE_URL,
  checkServiceHealth,
} from "../ai/errorHints.js";
import { NURBS_DEFAULT_BASE_URL } from "../ai/nurbs.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import { useCadStore } from "../store/store.js";
import type { Workspace } from "../store/types.js";
import type { ContextTarget } from "../three/contextmenu/contextSelection.js";

export type ConsoleMessageKind = "command" | "output" | "status" | "error";

export interface ConsoleMessage {
  kind: ConsoleMessageKind;
  text: string;
}

export interface ConsoleExecution {
  clear: boolean;
  messages: ConsoleMessage[];
}

export interface ConsoleRuntimeOptions {
  history?: readonly string[];
  checkHealth?: (baseURL: string) => Promise<boolean>;
}

interface Builtin {
  usage: string;
  description: string;
  run: (
    args: string[],
    ctx: ContextTarget,
    opts: ConsoleRuntimeOptions,
  ) => Promise<ConsoleExecution> | ConsoleExecution;
}

const output = (...text: string[]): ConsoleExecution => ({
  clear: false,
  messages: text.map((line) => ({ kind: "output", text: line })),
});

const failure = (text: string): ConsoleExecution => ({
  clear: false,
  messages: [{ kind: "error", text }],
});

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : Number(value.toPrecision(8)).toString();
}

/** Parse a scalar in SI, accepting the units users commonly type in a CAD command line. */
export function parseConsoleNumber(source: string): number {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(mm|cm|m|in|deg|rad)?$/i.exec(
    source.trim(),
  );
  if (!match) throw new Error(`invalid number "${source}" (examples: 0.02, 20mm, 45deg)`);
  const raw = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const scale = unit === "mm" ? 1e-3 : unit === "cm" ? 1e-2 : unit === "in" ? 0.0254 : 1;
  if (unit === "deg") return (raw * Math.PI) / 180;
  return raw * scale;
}

/** Tokenize one statement, preserving whitespace inside single/double quotes. */
export function tokenizeConsoleStatement(source: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = (): void => {
    if (token.length > 0) tokens.push(token);
    token = "";
  };
  for (const ch of source.trim()) {
    if (escaped) {
      token += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      token += ch;
    }
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("unterminated quoted string");
  push();
  return tokens;
}

/** Split a Fusion-style command sequence on semicolons outside quoted strings. */
export function splitConsoleStatements(source: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of source) {
    if (escaped) {
      statement += ch;
      escaped = false;
    } else if (ch === "\\") {
      statement += ch;
      escaped = true;
    } else if (quote) {
      statement += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      statement += ch;
      quote = ch;
    } else if (ch === ";") {
      if (statement.trim()) statements.push(statement.trim());
      statement = "";
    } else {
      statement += ch;
    }
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

function requireFeature(id: string): ReturnType<typeof useCadStore.getState>["features"][number] {
  const feature = useCadStore
    .getState()
    .features.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
  if (!feature) throw new Error(`feature "${id}" does not exist`);
  return feature;
}

function describeFeature(id: string): string {
  const feature = requireFeature(id);
  const state = useCadStore.getState();
  const params = Object.entries(feature.params ?? {})
    .map(([key, value]) => `${key}=${number(value)}`)
    .join(", ");
  const flags = [
    feature.suppressed ? "suppressed" : "active",
    state.selectedFeatureId === feature.id ? "selected" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `${feature.id}  ${feature.name ?? feature.type}  [${feature.type}; ${flags}]${params ? `  ${params}` : ""}`;
}

const SERVICE_NAMES = ["reconstruct", "capture", "nerf", "nurbs", "photogrammetry"] as const;
type ServiceName = (typeof SERVICE_NAMES)[number];

function serviceUrls(): Record<ServiceName, string> {
  const settings = useAiStore.getState().settings;
  return {
    reconstruct: settings?.reconstructBaseURL ?? RECONSTRUCT_DEFAULT_BASE_URL,
    capture: settings?.captureBaseURL ?? CAPTURE_DEFAULT_BASE_URL,
    nerf: settings?.nerfBaseURL ?? NERF_DEFAULT_BASE_URL,
    nurbs: settings?.nurbsBaseURL ?? NURBS_DEFAULT_BASE_URL,
    photogrammetry: settings?.photogrammetryBaseURL ?? PHOTOGRAMMETRY_DEFAULT_BASE_URL,
  };
}

const BUILTINS: Record<string, Builtin> = {
  help: {
    usage: "help [command]",
    description: "Show commands or detailed help for one command.",
    run: (args) => {
      if (args[0]) {
        const resolved = resolveBuiltin(args[0]);
        if (!resolved.ok) return failure(resolved.error);
        const command = BUILTINS[resolved.name]!;
        return output(`${command.usage} — ${command.description}`);
      }
      return output(
        "Plastiq Text Commands — application commands are case-insensitive; unique abbreviations are accepted.",
        ...Object.values(BUILTINS).map(
          (command) => `${command.usage.padEnd(34)} ${command.description}`,
        ),
        "Any enabled action id can also run directly (example: cylinder). Use `actions` to inspect them.",
        "Separate multiple commands with `;`. Up/Down recalls history; Esc clears the entry; Tab completes.",
      );
    },
  },
  clear: {
    usage: "clear",
    description: "Clear the transcript.",
    run: () => ({ clear: true, messages: [] }),
  },
  history: {
    usage: "history [count]",
    description: "Show recent entered commands.",
    run: (args, _ctx, opts) => {
      const count = args[0] ? Number(args[0]) : 20;
      if (!Number.isInteger(count) || count < 1)
        return failure("history count must be a positive integer");
      const history = (opts.history ?? []).slice(-count);
      return history.length
        ? output(...history.map((line, index) => `${index + 1}  ${line}`))
        : output("No command history.");
    },
  },
  actions: {
    usage: "actions [query] [--all]",
    description: "List application actions and whether they are available now.",
    run: (args, ctx) => {
      const all = args.includes("--all");
      const query = args
        .filter((arg) => arg !== "--all")
        .join(" ")
        .toLowerCase();
      const rows = Object.values(ACTIONS)
        .map((action) => ({
          action,
          label: action.label(ctx),
          enabled: action.enabled(ctx),
          visible: action.visible?.(ctx) ?? true,
        }))
        .filter(
          ({ action, label, visible }) =>
            (all || visible) && (!query || `${action.id} ${label}`.toLowerCase().includes(query)),
        )
        .sort((a, b) => a.action.id.localeCompare(b.action.id))
        .map(
          ({ action, label, enabled }) =>
            `${enabled ? "●" : "○"} ${action.id.padEnd(24)} ${label}${enabled ? "" : "  (unavailable)"}`,
        );
      return rows.length ? output(...rows) : output("No matching actions.");
    },
  },
  run: {
    usage: "run <action-id>",
    description: "Execute a live editor action through the shared action registry.",
    run: (args, ctx) => executeAction(args.join(" "), ctx),
  },
  document: {
    usage: "document",
    description: "Show the open project and document summary.",
    run: () => {
      const cad = useCadStore.getState();
      const projects = useProjectsStore.getState();
      const kind = projects.activeMeshDoc
        ? "mesh"
        : projects.activePointCloudDoc
          ? "point cloud"
          : "parametric CAD";
      return output(
        `${projects.currentName} — ${kind}`,
        `workspace=${cad.workspace}  features=${cad.features.length}  parameters=${Object.keys(cad.params).length}  bodies=${cad.massProps?.bodyVolumes.length ?? 0}`,
        `history=${cad.past.length} undo / ${cad.future.length} redo  status=${cad.status}`,
      );
    },
  },
  features: {
    usage: "features [feature-id]",
    description: "List the feature timeline or inspect one feature.",
    run: (args) => {
      if (args[0]) {
        try {
          return output(describeFeature(args[0]));
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      }
      const features = useCadStore.getState().features;
      return features.length
        ? output(...features.map((feature) => describeFeature(feature.id)))
        : output("The feature timeline is empty.");
    },
  },
  feature: {
    usage: "feature <select|rename|suppress> <feature-id> [name]",
    description: "Select, rename, or toggle suppression for a real timeline feature.",
    run: (args) => {
      const [operation, id, ...rest] = args;
      if (!operation || !id) return failure(BUILTINS.feature!.usage);
      try {
        const feature = requireFeature(id);
        const cad = useCadStore.getState();
        if (operation.toLowerCase() === "select") cad.selectFeature(feature.id);
        else if (operation.toLowerCase() === "rename") {
          const name = rest.join(" ").trim();
          if (!name) return failure("feature rename requires a non-empty name");
          cad.renameFeature(feature.id, name);
        } else if (operation.toLowerCase() === "suppress") cad.toggleSuppress(feature.id);
        else return failure(`unknown feature operation "${operation}"`);
        return output(describeFeature(feature.id));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  },
  parameters: {
    usage: "parameters",
    description: "List global document parameters in SI units.",
    run: () => {
      const entries = Object.entries(useCadStore.getState().params).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      return entries.length
        ? output(...entries.map(([name, value]) => `${name} = ${number(value)}`))
        : output("No global parameters.");
    },
  },
  parameter: {
    usage: "parameter <get|set|rename|delete> <name> [value|new-name]",
    description: "Read or mutate global parameters through document history.",
    run: (args) => {
      const [operation, name, value] = args;
      if (!operation || !name) return failure(BUILTINS.parameter!.usage);
      const cad = useCadStore.getState();
      try {
        if (operation.toLowerCase() === "get") {
          if (!(name in cad.params)) throw new Error(`parameter "${name}" does not exist`);
          return output(`${name} = ${number(cad.params[name]!)}`);
        }
        if (operation.toLowerCase() === "set") {
          if (!value) throw new Error("parameter set requires a value");
          cad.setParam(name, parseConsoleNumber(value));
        } else if (operation.toLowerCase() === "rename") {
          if (!value) throw new Error("parameter rename requires a new name");
          cad.renameParam(name, value);
          return output(
            `${name} renamed to ${value} = ${number(useCadStore.getState().params[value]!)}`,
          );
        } else if (operation.toLowerCase() === "delete") {
          cad.removeParam(name);
          return output(`Deleted parameter ${name}.`);
        } else return failure(`unknown parameter operation "${operation}"`);
        return output(`${name} = ${number(useCadStore.getState().params[name]!)}`);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  },
  workspace: {
    usage: "workspace [design|assemble|simulate|sculpt]",
    description: "Show or switch the active workspace.",
    run: (args) => {
      const cad = useCadStore.getState();
      if (!args[0]) return output(cad.workspace);
      const workspace = args[0].toLowerCase();
      if (!["design", "assemble", "simulate", "sculpt"].includes(workspace))
        return failure(`unknown workspace "${args[0]}"`);
      if (useSketchStore.getState().active) useSketchStore.getState().exitSketch();
      cad.setWorkspace(workspace as Workspace);
      return output(`Workspace: ${workspace}`);
    },
  },
  selection: {
    usage: "selection [clear]",
    description: "Inspect or clear the current 3D selection.",
    run: (args) => {
      const cad = useCadStore.getState();
      if (args[0]?.toLowerCase() === "clear") {
        cad.clearPicks();
        cad.selectFeature(null);
        return output("Selection cleared.");
      }
      if (args[0]) return failure(`unknown selection operation "${args[0]}"`);
      const picks = cad.picks.map((pick) => `${pick.kind}:${pick.id}`).join(", ");
      return output(
        `mode=${cad.selMode ?? "any"}  feature=${cad.selectedFeatureId ?? "none"}  picks=${picks || "none"}`,
      );
    },
  },
  "select-mode": {
    usage: "select-mode [face|edge|vertex|body|any]",
    description: "Show or change the 3D entity filter.",
    run: (args) => {
      const cad = useCadStore.getState();
      if (!args[0]) return output(cad.selMode ?? "any");
      const mode = args[0].toLowerCase();
      if (!["face", "edge", "vertex", "body", "any"].includes(mode))
        return failure(`unknown selection mode "${args[0]}"`);
      cad.setSelMode(mode === "any" ? null : (mode as "face" | "edge" | "vertex" | "body"));
      return output(`Selection mode: ${mode}`);
    },
  },
  status: {
    usage: "status",
    description: "Show rebuild state, warnings, and feature errors.",
    run: () => {
      const cad = useCadStore.getState();
      const details = [
        ...Object.entries(cad.featureErrors).map(([id, message]) => `ERROR ${id}: ${message}`),
        ...Object.entries(cad.featureWarnings).map(([id, message]) => `WARNING ${id}: ${message}`),
      ];
      return output(cad.status, ...(details.length ? details : ["No feature errors or warnings."]));
    },
  },
  services: {
    usage: "services [reconstruct|capture|nerf|nurbs|photogrammetry]",
    description: "Probe configured backend /health endpoints.",
    run: async (args, _ctx, opts) => {
      const requested = args[0]?.toLowerCase();
      if (requested && !SERVICE_NAMES.includes(requested as ServiceName))
        return failure(`unknown service "${args[0]}"`);
      const names = requested ? [requested as ServiceName] : [...SERVICE_NAMES];
      const urls = serviceUrls();
      const probe = opts.checkHealth ?? checkServiceHealth;
      const results = await Promise.all(
        names.map(async (name) => ({ name, url: urls[name], healthy: await probe(urls[name]) })),
      );
      return output(
        ...results.map(
          ({ name, url, healthy }) =>
            `${healthy ? "● online " : "○ offline"}  ${name.padEnd(15)} ${url}`,
        ),
      );
    },
  },
};

const ALIASES: Record<string, string> = {
  cls: "clear",
  doc: "document",
  feat: "feature",
  feats: "features",
  hist: "history",
  param: "parameter",
  params: "parameters",
  sel: "selection",
  selmode: "select-mode",
  svc: "services",
  ws: "workspace",
};

type Resolution = { ok: true; name: string } | { ok: false; error: string };

function resolveFromNames(source: string, names: readonly string[], kind: string): Resolution {
  const query = source.toLowerCase();
  const alias = ALIASES[query];
  if (alias && names.includes(alias)) return { ok: true, name: alias };
  const exact = names.find((name) => name.toLowerCase() === query);
  if (exact) return { ok: true, name: exact };
  const matches = names.filter((name) => name.toLowerCase().startsWith(query));
  if (matches.length === 1) return { ok: true, name: matches[0]! };
  if (matches.length > 1)
    return { ok: false, error: `ambiguous ${kind} "${source}": ${matches.join(", ")}` };
  return { ok: false, error: `unknown ${kind} "${source}"` };
}

function resolveBuiltin(source: string): Resolution {
  return resolveFromNames(source, Object.keys(BUILTINS), "command");
}

function resolveAction(source: string): Resolution {
  return resolveFromNames(source, Object.keys(ACTIONS), "action");
}

function executeAction(source: string, ctx: ContextTarget): ConsoleExecution {
  if (!source.trim()) return failure("run requires an action id");
  const resolution = resolveAction(source.trim());
  if (!resolution.ok) return failure(resolution.error);
  const action = ACTIONS[resolution.name]!;
  if (!(action.visible?.(ctx) ?? true))
    return failure(`action "${action.id}" is not available in this context`);
  if (!action.enabled(ctx)) return failure(`action "${action.id}" is currently disabled`);
  try {
    runAction(action.id, ctx);
    return output(`Ran ${action.label(ctx)} (${action.id}).`);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** Execute one or more statements against a snapshot of the live editor context. */
export async function executeConsoleInput(
  source: string,
  ctx: ContextTarget,
  opts: ConsoleRuntimeOptions = {},
): Promise<ConsoleExecution> {
  const result: ConsoleExecution = { clear: false, messages: [] };
  const statements = splitConsoleStatements(source);
  for (const statement of statements) {
    result.messages.push({ kind: "command", text: statement });
    let tokens: string[];
    try {
      tokens = tokenizeConsoleStatement(statement);
    } catch (error) {
      result.messages.push({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const [head, ...args] = tokens;
    if (!head) continue;
    const builtin = resolveBuiltin(head);
    let execution: ConsoleExecution;
    if (builtin.ok) execution = await BUILTINS[builtin.name]!.run(args, ctx, opts);
    else {
      const action = resolveAction(head);
      execution =
        action.ok && args.length === 0 ? executeAction(action.name, ctx) : failure(builtin.error);
    }
    if (execution.clear) {
      result.clear = true;
      result.messages = [];
    }
    result.messages.push(...execution.messages);
  }
  return result;
}

/** Candidate command/action ids for the input completion popup and Tab completion. */
export function completeConsoleInput(source: string, ctx: ContextTarget, limit = 8): string[] {
  const statement = splitConsoleStatements(source).at(-1) ?? "";
  const query = statement.trim().toLowerCase();
  if (!query || /\s/.test(query)) return [];
  const builtins = Object.keys(BUILTINS).filter((name) => name.startsWith(query));
  const actions = Object.values(ACTIONS)
    .filter(
      (action) => (action.visible?.(ctx) ?? true) && action.id.toLowerCase().startsWith(query),
    )
    .map((action) => action.id);
  return [...new Set([...builtins, ...actions])].sort().slice(0, limit);
}
