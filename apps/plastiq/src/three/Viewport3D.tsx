// The r3f <Canvas> host — the WebGL surface + camera the legacy SceneController
// owned imperatively. Same perspective camera (45°, Z-up, near/far), same dark
// clear colour. preserveDrawingBuffer so thumbnails (M5.3) and the E2E canvas
// screenshots can read it back.

import { Canvas } from "@react-three/fiber";
import { Scene } from "./Scene.js";
import { VIEWPORT_BG } from "./colors.js";
import type { InstanceBody } from "./Assembly.js";
import type { DatumPlane } from "@plastiq/cad";
import type { TransferMesh } from "../worker/protocol.js";
import type { MeshBody } from "../mesh/meshBody.js";
import type { PointCloudDoc } from "../store/types.js";

export function Viewport3D({
  mesh,
  meshBodies,
  pointCloud,
  sketchFrame,
  instances,
  onMeshBodiesChange,
}: {
  mesh: TransferMesh | null;
  meshBodies: MeshBody[] | null;
  pointCloud: PointCloudDoc | null;
  sketchFrame: DatumPlane | null;
  instances: InstanceBody[] | null;
  onMeshBodiesChange: (bodies: MeshBody[], persist?: boolean) => void;
}): React.JSX.Element {
  return (
    <Canvas
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      dpr={typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1}
      camera={{ fov: 45, near: 0.001, far: 100, position: [0.12, 0.1, 0.16] }}
      onCreated={({ camera, gl }) => {
        camera.up.set(0, 0, 1); // Z-up, matching the CAD/sim convention.
        camera.lookAt(0, 0, 0.02);
        gl.setClearColor(VIEWPORT_BG, 1);
        // Required for section analysis (global + material clippingPlanes).
        gl.localClippingEnabled = true;
      }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={[VIEWPORT_BG]} />
      <Scene
        mesh={mesh}
        meshBodies={meshBodies}
        pointCloud={pointCloud}
        sketchFrame={sketchFrame}
        instances={instances}
        onMeshBodiesChange={onMeshBodiesChange}
      />
    </Canvas>
  );
}
