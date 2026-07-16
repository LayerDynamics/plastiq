// RecmLayout — the shared anchor/positioning primitive. It places the menu at a
// RecmAnchor, choosing the right mechanism per anchor kind:
//   - "world": a drei <Html> billboard at a 3D point (must render inside an r3f
//     <Canvas>); this is how the menu pins to a spot in the viewport.
//   - "screen": a fixed, viewport-space div at a client pixel (works anywhere in
//     the DOM, e.g. a 2D sketch overlay).
// Both center their child on the anchor so the menu's hub sits under the cursor.

import { Html } from "@react-three/drei";
import type { ReactNode } from "react";
import type { RecmAnchor } from "../types.js";

export function RecmLayout({
  anchor,
  children,
  zIndex = 1000,
  className,
  wrapperClass = "recm-wrap",
  htmlZIndexRange = [1000, 0],
}: {
  anchor: RecmAnchor;
  children: ReactNode;
  /** z-index for the screen-anchored div. */
  zIndex?: number;
  /** className for the screen-anchored div. */
  className?: string;
  /** wrapperClass forwarded to drei <Html> (world anchor). */
  wrapperClass?: string;
  /** zIndexRange forwarded to drei <Html> (world anchor). */
  htmlZIndexRange?: [number, number];
}): React.JSX.Element {
  if (anchor.kind === "screen") {
    return (
      <div
        className={className}
        style={{
          position: "fixed",
          left: anchor.x,
          top: anchor.y,
          transform: "translate(-50%, -50%)",
          zIndex,
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <Html
      position={anchor.point}
      zIndexRange={htmlZIndexRange}
      pointerEvents="auto"
      wrapperClass={wrapperClass}
    >
      <div style={{ transform: "translate(-50%, -50%)" }}>{children}</div>
    </Html>
  );
}
