// @vitest-environment jsdom
//
// SPEC-6 R4.3 — LIVE fal integration for create_mesh (opt-in, keyed, MANUAL — NOT CI).
//
// Self-skips unless FAL_KEY is set, so CI (which has no key) never calls the paid API.
// Run it by hand with a real key to verify the whole creative pipeline against live fal:
//   FAL_KEY=... pnpm -C apps/plastiq exec vitest run src/ai/tools/createMesh.integration.test.ts
//
// It drives the REAL fal Tripo text→3D provider through createMesh, downloads the
// produced GLB, validates it with the REAL importGltf (GLTFLoader needs a DOM → jsdom),
// and asserts a mesh document is produced. confirm/recordPaidJob are no-ops here; persist
// captures the doc instead of touching IndexedDB.

import { describe, expect, it } from "vitest";
import { createMesh } from "./createMesh.js";
import { falMeshProviders, meshProviderRegistry } from "../meshgen/fal.js";
import { importGltf } from "../../mesh/importGltf.js";
import type { MeshDoc } from "../../store/types.js";

const FAL_KEY = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.["FAL_KEY"];

describe.skipIf(!FAL_KEY)("createMesh — live fal text→3D (keyed, manual; NOT in CI)", () => {
  it(
    "runs a real text→3D job and ingests the GLB into a mesh document",
    async () => {
      const providers = falMeshProviders({ apiKey: FAL_KEY });
      let persisted: MeshDoc | null = null;

      const res = await createMesh(
        { mode: "text3d", prompt: "a simple low-poly rock", providerId: "fal:tripo" },
        {
          confirm: async () => true,
          resolveMeshProvider: meshProviderRegistry(providers),
          fetchGlb: async (url) => (await fetch(url)).arrayBuffer(),
          validateGlb: async (glb) => {
            await importGltf(glb); // throws on no geometry
          },
          persist: async (doc) => {
            persisted = doc;
            return "live-1";
          },
          recordPaidJob: () => {},
          pollIntervalMs: 3000,
          maxPolls: 100,
        },
      );

      expect(res.status).toBe("ok");
      expect(res.meshDocId).toBe("live-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.kind).toBe("mesh");
      expect(persisted!.source).toMatchObject({ mode: "text3d", providerId: "fal:tripo" });
      expect(persisted!.glb.length).toBeGreaterThan(100); // a real GLB, base64-inlined
    },
    300_000, // a real 3D job can take minutes
  );
});
