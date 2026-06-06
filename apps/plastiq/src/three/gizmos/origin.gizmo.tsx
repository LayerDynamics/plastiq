// Origin gizmo: the world axis triad at (0,0,0) — X red, Y green, Z blue — a
// constant spatial reference. 30 mm to read against centimetre-scale parts.

import { useGizmoPresence } from "./presence.js";

export function OriginGizmo(): React.JSX.Element {
  useGizmoPresence("origin");
  return <axesHelper args={[0.03]} />;
}
