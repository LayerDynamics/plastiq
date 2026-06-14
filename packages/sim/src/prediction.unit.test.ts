// prediction — UNIT tests for the backend-selection logic in isolation: initSim()
// picks the right backend (the MuJoCo default with no argument, or the one named in
// opts), and activeBackend() reports it. These are the pure wrapper decisions; the
// PredictionSim physics delegation is exercised end-to-end in prediction.integration.test.ts
// (integration) and swept in prediction.smoke.test.ts.

import { describe, expect, it } from "vitest";

import { activeBackend, initSim } from "./prediction.js";
import type { BackendName } from "./engine.js";

describe("initSim / activeBackend — backend selection", () => {
  it("defaults to the MuJoCo backend when no backend is given", async () => {
    await initSim();
    expect(activeBackend()).toBe("mujoco");
  });

  it.each(["rapier", "ammo", "cannon", "mujoco"] as BackendName[])(
    "loads and reports the explicitly requested backend: %s",
    async (backend) => {
      await initSim({ backend });
      expect(activeBackend()).toBe(backend);
    },
  );
});
