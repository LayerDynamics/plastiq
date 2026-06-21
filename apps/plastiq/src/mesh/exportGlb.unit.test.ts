// SPEC-6 FR-18 — unit tests for the mesh-document GLB export (decode + filename + download).

import { describe, expect, it } from "vitest";
import { base64ToBytes, exportMeshGlb, glbFileName, type DownloadAnchor } from "./exportGlb.js";

describe("base64ToBytes", () => {
  it("round-trips a known GLB magic header", () => {
    // "glTF" little-endian magic = bytes [0x67,0x6c,0x54,0x46]; base64 "Z2xURg=="
    const bytes = base64ToBytes("Z2xURg==");
    expect([...bytes]).toEqual([0x67, 0x6c, 0x54, 0x46]);
  });
});

describe("glbFileName", () => {
  it("appends .glb when missing", () => {
    expect(glbFileName("Knight")).toBe("Knight.glb");
  });
  it("keeps an existing .glb (case-insensitive)", () => {
    expect(glbFileName("model.GLB")).toBe("model.GLB");
  });
  it("falls back to mesh.glb for empty/undefined", () => {
    expect(glbFileName(undefined)).toBe("mesh.glb");
    expect(glbFileName("   ")).toBe("mesh.glb");
  });
});

describe("exportMeshGlb", () => {
  it("decodes the GLB, builds a binary blob, and triggers a named download", () => {
    let blobBytes = -1;
    let blobType = "";
    let clicked = false;
    let revoked = false;
    const anchor: DownloadAnchor = {
      href: "",
      download: "",
      click() {
        clicked = true;
      },
    };
    const name = exportMeshGlb("Z2xURg==", "Reconstructed mesh", {
      createObjectURL: (b) => {
        blobBytes = b.size;
        blobType = b.type;
        return "blob:fake";
      },
      revokeObjectURL: () => {
        revoked = true;
      },
      createAnchor: () => anchor,
      schedule: (fn) => fn(), // run revoke synchronously
    });

    expect(name).toBe("Reconstructed mesh.glb");
    expect(anchor.href).toBe("blob:fake");
    expect(anchor.download).toBe("Reconstructed mesh.glb");
    expect(clicked).toBe(true);
    expect(revoked).toBe(true);
    expect(blobBytes).toBe(4); // the 4 decoded bytes
    expect(blobType).toBe("model/gltf-binary");
  });
});
