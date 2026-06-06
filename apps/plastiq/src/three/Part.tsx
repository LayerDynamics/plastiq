// The built part, rendered in r3f via <primitive>. The BuiltPart (buildMesh's
// group with its exact face/edge/vertex materials — light-grey face, blue hover,
// orange selection) is owned by Scene so picking + highlight share the same
// object; this component only mounts it.

import type { BuiltPart } from "../viewport/buildMesh.js";

export function Part({ part }: { part: BuiltPart | null }): React.JSX.Element | null {
  if (!part) return null;
  return <primitive object={part.group} />;
}
