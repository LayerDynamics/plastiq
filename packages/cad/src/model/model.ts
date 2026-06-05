// The parametric feature-history engine (SPEC-4 FR-24). Holds named parameters
// and an ordered feature history; a rebuild evaluates features in dependency
// order. Editing a parameter (or feature) re-evaluates; a feature that fails is
// isolated — it and its downstream are marked errored without corrupting the
// upstream results. Rebuild order is deterministic (NFR-2): a stable topological
// sort with history order as the tiebreak.

import type { Feature, FeatureStatus } from "./feature.js";

export class Model {
  private readonly params = new Map<string, number>();
  private readonly history: Feature[] = [];
  private readonly results = new Map<string, unknown>();
  private readonly statuses = new Map<string, FeatureStatus>();

  /** Set a parameter and re-evaluate the history. */
  setParam(name: string, value: number): void {
    this.params.set(name, value);
    this.rebuild();
  }

  getParam(name: string): number | undefined {
    return this.params.get(name);
  }

  /** Append a feature to the history and re-evaluate. */
  addFeature(feature: Feature): Feature {
    if (this.history.some((f) => f.id === feature.id)) {
      throw new Error(`duplicate feature id: ${feature.id}`);
    }
    this.history.push(feature);
    this.rebuild();
    return feature;
  }

  /** The result of feature `id` from the last rebuild (undefined if errored/absent). */
  result(id: string): unknown {
    return this.results.get(id);
  }

  status(id: string): FeatureStatus | undefined {
    return this.statuses.get(id);
  }

  /** All feature statuses in evaluation order — the rebuild report (FR-24). */
  report(): FeatureStatus[] {
    return this.order().map(
      (f) => this.statuses.get(f.id) ?? { id: f.id, ok: false, error: "not evaluated" },
    );
  }

  /** Re-evaluate every feature in dependency order. */
  rebuild(): void {
    this.results.clear();
    this.statuses.clear();
    for (const f of this.order()) {
      // A feature whose upstream failed is itself marked errored — never fed
      // missing inputs (no silent corruption, FR-24).
      const failedDep = f.deps.find((d) => this.statuses.get(d)?.ok === false);
      if (failedDep !== undefined) {
        this.statuses.set(f.id, {
          id: f.id,
          ok: false,
          error: `upstream feature '${failedDep}' failed`,
        });
        continue;
      }
      try {
        this.results.set(f.id, f.evaluate({ params: this.params, results: this.results }));
        this.statuses.set(f.id, { id: f.id, ok: true });
      } catch (err) {
        this.statuses.set(f.id, {
          id: f.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Stable topological order: features sorted so deps precede dependents, with
  // history (insertion) order as the deterministic tiebreak.
  private order(): Feature[] {
    const byId = new Map(this.history.map((f) => [f.id, f]));
    const visited = new Set<string>();
    const inProgress = new Set<string>();
    const ordered: Feature[] = [];

    const visit = (f: Feature): void => {
      if (visited.has(f.id)) return;
      if (inProgress.has(f.id)) throw new Error(`cyclic feature dependency at '${f.id}'`);
      inProgress.add(f.id);
      // Visit deps in history order for determinism.
      for (const dep of this.history.filter((h) => f.deps.includes(h.id))) {
        visit(dep);
      }
      inProgress.delete(f.id);
      visited.add(f.id);
      ordered.push(f);
    };

    for (const f of this.history) {
      // A dep referencing an unknown id is a hard error surfaced at evaluation.
      for (const d of f.deps) {
        if (!byId.has(d)) throw new Error(`feature '${f.id}' depends on unknown feature '${d}'`);
      }
      visit(f);
    }
    return ordered;
  }
}
