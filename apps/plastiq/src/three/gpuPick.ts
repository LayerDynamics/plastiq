// GPU colour-id face picking (NFR-4): render the part's faces id-coloured to an
// offscreen target with the shared renderer, read back the pixel under the cursor,
// decode the faceId. Robust where a triangle raycast is ambiguous (dense/edge-on
// meshes). Ported verbatim from SceneController's id path; the only change is it
// borrows the r3f renderer instead of owning one.

import * as THREE from "three";
import { decodeId, encodeIdFloat } from "../viewport/colorId.js";
import type { BuiltPart } from "../viewport/buildMesh.js";

/** Outputs the per-vertex `idColor` attribute raw (no lights/tone-map/sRGB), so
 * the readback bytes equal the encoded id. */
function idMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: `
      attribute vec3 idColor;
      varying vec3 vId;
      void main() { vId = idColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      varying vec3 vId;
      void main() { gl_FragColor = vec4(vId, 1.0); }
    `,
  });
}

export class GpuPicker {
  private readonly idScene = new THREE.Scene();
  private readonly material = idMaterial();
  private readonly ray = new THREE.Raycaster();
  private idMesh: THREE.Mesh | null = null;
  private idMeshPart: BuiltPart | null = null;
  private target: THREE.WebGLRenderTarget | null = null;

  /** Build (once per part) a mesh of the part geometry carrying a per-face
   * `idColor` attribute (each face's vertices coloured by its faceId). */
  private ensureIdMesh(part: BuiltPart): THREE.Mesh | null {
    if (this.idMeshPart === part && this.idMesh) return this.idMesh;
    if (this.idMesh) this.idScene.remove(this.idMesh);
    const geom = part.mesh.geometry;
    const faceIds = part.mesh.userData["faceIds"] as number[] | undefined;
    const index = geom.getIndex();
    const pos = geom.getAttribute("position");
    if (!faceIds || !index) return null;
    const colors = new Float32Array(pos.count * 3);
    geom.groups.forEach((g, gi) => {
      const id = faceIds[gi];
      if (id == null) return;
      const [r, gg, b] = encodeIdFloat(id);
      for (let k = g.start; k < g.start + g.count; k++) {
        const vi = index.getX(k);
        colors[vi * 3] = r;
        colors[vi * 3 + 1] = gg;
        colors[vi * 3 + 2] = b;
      }
    });
    geom.setAttribute("idColor", new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geom, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    this.idScene.add(mesh);
    this.idMesh = mesh;
    this.idMeshPart = part;
    return mesh;
  }

  /** Does the cursor ray pass near the part's world bounds? (gates the GPU pick) */
  rayHitsPart(part: BuiltPart, camera: THREE.Camera, ndc: { x: number; y: number }): boolean {
    const box = new THREE.Box3().setFromObject(part.group);
    if (box.isEmpty()) return false;
    this.ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    return this.ray.ray.intersectsBox(box);
  }

  /** faceId under `ndc`, or null on a miss (the cleared buffer). */
  pick(
    gl: THREE.WebGLRenderer,
    camera: THREE.Camera,
    part: BuiltPart,
    ndc: { x: number; y: number },
  ): number | null {
    const mesh = this.ensureIdMesh(part);
    if (!mesh) return null;
    part.mesh.updateWorldMatrix(true, false);
    mesh.matrix.copy(part.mesh.matrixWorld);
    mesh.matrixWorld.copy(part.mesh.matrixWorld);

    const w = Math.max(1, Math.floor(gl.domElement.width));
    const h = Math.max(1, Math.floor(gl.domElement.height));
    if (!this.target) this.target = new THREE.WebGLRenderTarget(w, h);
    else if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    const prevTarget = this.target ? gl.getRenderTarget() : null;
    const prevColor = gl.getClearColor(new THREE.Color());
    const prevAlpha = gl.getClearAlpha();
    gl.setRenderTarget(this.target);
    gl.setClearColor(0x000000, 1);
    gl.clear();
    gl.render(this.idScene, camera);

    // NDC (−1..1, y up) → buffer pixel (origin bottom-left for readback).
    const px = Math.min(w - 1, Math.max(0, Math.round((ndc.x * 0.5 + 0.5) * w)));
    const py = Math.min(h - 1, Math.max(0, Math.round((ndc.y * 0.5 + 0.5) * h)));
    const buf = new Uint8Array(4);
    gl.readRenderTargetPixels(this.target, px, py, 1, 1, buf);
    gl.setRenderTarget(prevTarget);
    gl.setClearColor(prevColor, prevAlpha);
    return decodeId(buf[0]!, buf[1]!, buf[2]!);
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
  }
}
