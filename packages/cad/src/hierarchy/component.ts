// Component (SPEC-4 FR-21): the organizational/assembly node — a placement plus
// bodies and sub-components. Composing placements down the tree gives every body
// its world pose (the input the assembly→sim lowering needs).

import type { Body } from "./body.js";
import { composePlacement, IDENTITY_PLACEMENT, type Placement } from "./placement.js";

/** A body together with its resolved world placement. */
export interface PlacedBody {
  readonly body: Body;
  readonly world: Placement;
}

export class Component {
  placement: Placement = IDENTITY_PLACEMENT;
  readonly bodies: Body[] = [];
  readonly children: Component[] = [];

  constructor(readonly name: string) {}

  addBody(body: Body): Body {
    this.bodies.push(body);
    return body;
  }

  addChild(child: Component): Component {
    this.children.push(child);
    return child;
  }

  /** Total number of bodies in this subtree (each → one rigid body). */
  bodyCount(): number {
    return this.bodies.length + this.children.reduce((n, c) => n + c.bodyCount(), 0);
  }

  /** Every body in the subtree with its world placement (transforms composed). */
  placedBodies(parentWorld: Placement = IDENTITY_PLACEMENT): PlacedBody[] {
    const here = composePlacement(parentWorld, this.placement);
    const placed: PlacedBody[] = this.bodies.map((body) => ({ body, world: here }));
    for (const child of this.children) {
      placed.push(...child.placedBodies(here));
    }
    return placed;
  }
}
