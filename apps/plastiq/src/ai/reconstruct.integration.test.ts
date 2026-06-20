// SPEC-7 R6.7 — LIVE client↔server integration for the reconstruction backend (opt-in,
// keyed, NOT CI). Self-skips unless RECONSTRUCT_URL points at a running services/reconstruct
// instance, so CI stays deterministic. Run it against the live service:
//   (terminal 1) cd services/reconstruct && \
//      /path/to/env/bin/python -m uvicorn app.main:app --port 8000
//   (terminal 2) RECONSTRUCT_URL=http://127.0.0.1:8000 \
//      pnpm -C apps/plastiq exec vitest run src/ai/reconstruct.integration.test.ts
//
// It drives the REAL browser client (reconstructMesh) over real HTTP against the real
// pythonOCC service with real GLB fixtures, asserting a valid STEP solid comes back and the
// STEP wraps into an editable CadDocument (stepToImportDocument).

import { describe, expect, it } from "vitest";
import { reconstructMesh, stepToImportDocument } from "./reconstruct.js";
import { CYLINDER_GLB_BASE64, STEPPED_SHAFT_GLB_BASE64 } from "./reconstruct.fixtures.js";

const RECONSTRUCT_URL = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.["RECONSTRUCT_URL"];

describe.skipIf(!RECONSTRUCT_URL)("reconstructMesh — live service (keyed, NOT in CI)", () => {
  it(
    "reconstructs a cylinder GLB into an analytic STEP solid",
    async () => {
      const res = await reconstructMesh(CYLINDER_GLB_BASE64, {
        baseURL: RECONSTRUCT_URL,
        pollIntervalMs: 300,
        maxPolls: 200,
      });
      expect(res.report.is_solid).toBe(true);
      expect(res.report.method).toBe("cylinder");
      expect(res.step.startsWith("ISO-10303-21")).toBe(true);

      // the STEP wraps into an importStep CadDocument the kernel can rebuild
      const doc = stepToImportDocument(res.step, "Reconstructed cylinder");
      expect(doc.features[0]!.type).toBe("importStep");
      expect(doc.features[0]!.data!["step"]).toBe(res.step);
    },
    120_000,
  );

  it(
    "reconstructs a stepped-shaft GLB into a revolution solid",
    async () => {
      const res = await reconstructMesh(STEPPED_SHAFT_GLB_BASE64, {
        baseURL: RECONSTRUCT_URL,
        pollIntervalMs: 300,
        maxPolls: 200,
      });
      expect(res.report.is_solid).toBe(true);
      expect(res.report.method).toBe("revolution");
      expect(res.step.startsWith("ISO-10303-21")).toBe(true);
    },
    120_000,
  );
});
