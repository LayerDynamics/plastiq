// Object-center gizmo: a small orange marker at the build's centre of mass
// (store.massProps.com, from B-3). Present whenever the document has geometry.

import { useCadStore } from "../../store/store.js";
import { SELECT_ORANGE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";

export function ObjectCenterGizmo(): React.JSX.Element | null {
  const com = useCadStore((s) => s.massProps?.com);
  useGizmoPresence("objectCenter", com != null);
  if (!com) return null;
  return (
    <mesh position={com} renderOrder={2}>
      <sphereGeometry args={[0.0016, 16, 16]} />
      {/* depthTest off so the centroid reads even when inside the solid. */}
      <meshBasicMaterial color={SELECT_ORANGE} depthTest={false} transparent opacity={0.9} />
    </mesh>
  );
}
