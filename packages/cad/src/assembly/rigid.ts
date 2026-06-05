// Rigid groups (SPEC-4 FR-29). A `RigidGroup` welds a set of components so they
// move as a single rigid body and lower to ONE mechx_sim body (their geometry is
// fused / treated as one mass). Groups are assumed disjoint.

export interface RigidGroup {
  readonly name: string;
  /** Component indices welded together (≥ 1). */
  readonly members: readonly number[];
}

export function makeRigidGroup(name: string, members: readonly number[]): RigidGroup {
  if (members.length === 0) throw new Error(`rigid group "${name}" needs ≥ 1 member`);
  return { name, members };
}

/** The group containing `component`, or `undefined` if it is loose. */
export function groupOf(groups: readonly RigidGroup[], component: number): RigidGroup | undefined {
  return groups.find((g) => g.members.includes(component));
}

/**
 * The number of rigid bodies after welding: each disjoint group collapses to one
 * body, and every component not in a group is its own body. Throws if groups
 * overlap (a component cannot belong to two welds).
 */
export function rigidBodyCount(totalComponents: number, groups: readonly RigidGroup[]): number {
  const seen = new Set<number>();
  for (const g of groups) {
    for (const m of g.members) {
      if (seen.has(m)) throw new Error(`component ${m} is in more than one rigid group`);
      seen.add(m);
    }
  }
  const loose = totalComponents - seen.size;
  return loose + groups.length;
}
