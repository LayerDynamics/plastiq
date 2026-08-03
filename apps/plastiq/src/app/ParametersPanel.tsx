// R6 (§12.R6) — the Parameters panel: the UI that finally gives `doc.params` and
// the store's `setParam` a home. It lists the document's global parameters and
// lets the user ADD (name + value, where the value may be an expression over the
// OTHER params), RENAME, and DELETE them, with inline validation for invalid /
// duplicate names and bad expressions. A "used by" readout per param scans the
// live feature tree for expressions that reference it.
//
// Global params persist as resolved NUMBERS (the store's `Record<string,number>`
// contract); the value field accepts an expression only as an authoring
// convenience — it is evaluated against the other params on commit and the
// resulting number is stored via `setParam`. Feature parameter bindings live in
// the authoritative `feature.exprs` map consumed by rebuild; that same map drives
// dependency-safe rename/delete and the used-by scan here.

import { useEffect, useState } from "react";
import { useCadStore } from "../store/store.js";
import type { EditorFeature } from "../store/types.js";
import { dependencies, evalExpr, parameterNameError } from "../store/paramExpr.js";

/** Evaluate a value string (number or expression) against the other params, or
 * throw with a readable message. `self` is excluded so a param can't reference
 * itself (a one-node cycle). */
function evalValue(raw: string, params: Record<string, number>, self?: string): number {
  const scope: Record<string, number> = { ...params };
  if (self) delete scope[self];
  const v = evalExpr(raw, scope);
  if (!Number.isFinite(v)) throw new Error("expression did not evaluate to a finite number");
  return v;
}

function formatNum(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toFixed(6))) : "0";
}

/** Every authoritative per-parameter expression a feature carries. */
function featureExprStrings(f: EditorFeature): string[] {
  return Object.values(f.exprs ?? {});
}

/** Features whose expressions reference `name`, as display labels. */
function usedBy(features: EditorFeature[], name: string): string[] {
  const labels: string[] = [];
  for (const f of features) {
    const refs = featureExprStrings(f).some((e) => {
      try {
        return dependencies(e).includes(name);
      } catch {
        return false; // an unparseable expression references nothing resolvable
      }
    });
    if (refs) labels.push(f.name ?? f.id);
  }
  return labels;
}

/** One existing parameter: rename (name input), edit value/expr, used-by, delete. */
function ParamRow({ name, value }: { name: string; value: number }): React.JSX.Element {
  const params = useCadStore((s) => s.params);
  const features = useCadStore((s) => s.features);
  const setParam = useCadStore((s) => s.setParam);
  const renameParam = useCadStore((s) => s.renameParam);
  const removeParam = useCadStore((s) => s.removeParam);

  const [nameDraft, setNameDraft] = useState(name);
  const [valueDraft, setValueDraft] = useState(formatNum(value));
  const [err, setErr] = useState<string | null>(null);

  // Re-sync drafts when the store changes from elsewhere (add/delete/undo).
  useEffect(() => setNameDraft(name), [name]);
  useEffect(() => setValueDraft(formatNum(value)), [value]);

  const otherNames = Object.keys(params).filter((n) => n !== name);
  const users = usedBy(features, name);

  const commitName = (): void => {
    const next = nameDraft.trim();
    if (next === name) {
      setErr(null);
      return;
    }
    const e = parameterNameError(next, otherNames, name);
    if (e) {
      setErr(e);
      setNameDraft(name);
      return;
    }
    try {
      renameParam(name, next);
      setErr(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "rename failed");
      setNameDraft(name);
    }
  };

  const commitValue = (): void => {
    const raw = valueDraft.trim();
    try {
      const v = evalValue(raw, params, name);
      setParam(name, v);
      setValueDraft(formatNum(v));
      setErr(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "invalid expression");
      setValueDraft(formatNum(value));
    }
  };

  const remove = (): void => {
    try {
      removeParam(name);
      setErr(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "delete failed");
    }
  };

  return (
    <div data-testid={`param-row-${name}`} className="space-y-1 border-t border-[#1a2230] pt-1">
      <div className="flex items-center gap-1.5">
        <input
          data-testid={`param-name-${name}`}
          value={nameDraft}
          onChange={(e) => setNameDraft(e.currentTarget.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") setNameDraft(name);
          }}
          className="w-24 rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-xs text-[#cfe] outline-none focus:border-[#4ea1ff]"
        />
        <input
          data-testid={`param-value-${name}`}
          value={valueDraft}
          onChange={(e) => setValueDraft(e.currentTarget.value)}
          onBlur={commitValue}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") setValueDraft(formatNum(value));
          }}
          className="w-full rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-right text-xs text-[#cfe] outline-none focus:border-[#4ea1ff]"
        />
        <button
          type="button"
          data-testid={`param-delete-${name}`}
          disabled={users.length > 0}
          onClick={remove}
          title={
            users.length > 0 ? `Unbind ${users.join(", ")} before deleting` : "Delete parameter"
          }
          className="rounded border border-[#5a3a3a] bg-[#3a1414] px-1.5 py-0.5 text-[10px] text-[#fbb] hover:border-[#ff6a6a] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ✕
        </button>
      </div>
      <p data-testid={`param-usedby-${name}`} className="text-[10px] text-[#567]">
        {users.length === 0 ? "used by 0 features" : `used by ${users.length}: ${users.join(", ")}`}
      </p>
      {err && (
        <p data-testid={`param-error-${name}`} className="text-[10px] text-[#fc9]">
          {err}
        </p>
      )}
    </div>
  );
}

/** The add-a-parameter row at the foot of the panel. */
function AddParamRow(): React.JSX.Element {
  const params = useCadStore((s) => s.params);
  const setParam = useCadStore((s) => s.setParam);
  const [nameDraft, setNameDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const add = (): void => {
    const name = nameDraft.trim();
    const nameErr = parameterNameError(name, Object.keys(params));
    if (nameErr) {
      setErr(nameErr);
      return;
    }
    try {
      const v = evalValue(valueDraft.trim() || "0", params);
      setParam(name, v);
      setNameDraft("");
      setValueDraft("");
      setErr(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "invalid expression");
    }
  };

  return (
    <div data-testid="param-add" className="space-y-1 border-t border-[#1a2230] pt-2">
      <div className="flex items-center gap-1.5">
        <input
          data-testid="param-add-name"
          placeholder="name"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.currentTarget.value)}
          className="w-24 rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-xs text-[#cfe] outline-none focus:border-[#4ea1ff]"
        />
        <input
          data-testid="param-add-value"
          placeholder="value or expr"
          value={valueDraft}
          onChange={(e) => setValueDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          className="w-full rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 text-right text-xs text-[#cfe] outline-none focus:border-[#4ea1ff]"
        />
        <button
          type="button"
          data-testid="param-add-btn"
          onClick={add}
          className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-0.5 text-[10px] text-[#bfe] hover:border-[#4ea1ff]"
        >
          Add
        </button>
      </div>
      {err && (
        <p data-testid="param-add-error" className="text-[10px] text-[#fc9]">
          {err}
        </p>
      )}
    </div>
  );
}

/** The Parameters panel (SPEC-5 R6). Global-parameter CRUD + used-by readout. */
export function ParametersPanel(): React.JSX.Element {
  const params = useCadStore((s) => s.params);
  const names = Object.keys(params);

  return (
    <section data-testid="parameters-panel" className="space-y-1 text-sm text-[#9ab]">
      <h3 className="mb-1 text-[11px] font-bold tracking-wide text-[#789]">PARAMETERS</h3>
      {names.length === 0 ? (
        <p data-testid="params-empty" className="text-[11px] opacity-60">
          No parameters. Add one below; reference it from feature expressions.
        </p>
      ) : (
        names.map((name) => <ParamRow key={name} name={name} value={params[name]!} />)
      )}
      <AddParamRow />
    </section>
  );
}
