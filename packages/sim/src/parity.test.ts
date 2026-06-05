// Native↔wasm cross-target parity — a BONUS check, no longer a requirement.
//
// SPEC-3 (ADR-0011) moved the sim to f64 and made the client render-only (D-5),
// so cross-target bit-identity is not required — same-binary reproducibility is
// (see crates/sim/tests/determinism.rs). But disciplined f64 (IEEE +−×÷, libm
// transcendentals, no FMA contraction) is in fact bit-identical native↔wasm, so
// this gate still passes and we keep it as a free signal. If it ever diverges,
// demote it (tolerance) rather than block — only same-binary repro is binding.
// Both sides are checked against the one shared golden fixture.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { initSim, PredictionSim, type InputSample } from "./index.js";

// Vitest runs with the repo root as cwd (root vitest.config.ts).
const WASM_PATH = resolve(process.cwd(), "packages/sim/src/pkg/mechx_sim_bg.wasm");
const GOLDEN_PATH = resolve(process.cwd(), "crates/sim/tests/fixtures/golden_snapshot.bin");

// Must match `crates/sim/tests/golden.rs` exactly.
const TICKS = 300;
const SEED = 0x004d_4543_4858n;

function intentAt(handle: number, t: number): InputSample {
  return {
    handle,
    forward: ((t * 17) % 2001) - 1000,
    strafe: ((t * 31) % 2001) - 1000,
    turn: ((t * 7) % 2001) - 1000,
  };
}

beforeAll(async () => {
  await initSim(readFileSync(WASM_PATH));
});

describe("wasm/native determinism parity", () => {
  it("reproduces the native golden snapshot byte-for-byte", () => {
    const sim = new PredictionSim(60, SEED);
    // Mirror crates/sim/tests/golden.rs exactly: two entities spawned at the
    // origin overlap, so each early tick exercises the collision pipeline (the
    // path native≡wasm parity must cover). Only entity 0 is driven.
    const driven = sim.spawnTestEntity();
    sim.spawnTestEntity();
    for (let t = 0; t < TICKS; t++) {
      sim.applyInput(intentAt(driven, t));
      sim.step();
    }
    const got = sim.snapshot();
    const golden = new Uint8Array(readFileSync(GOLDEN_PATH));
    expect(Buffer.from(got)).toEqual(Buffer.from(golden));
    sim.dispose();
  });

  it("reconcile rewinds and replays to the predicted state", () => {
    const sim = new PredictionSim(60, SEED);
    const handle = sim.spawnTestEntity();

    for (let t = 0; t < 10; t++) {
      sim.applyInput(intentAt(handle, t));
      sim.step();
    }
    const authoritative = sim.snapshot();

    const replay: InputSample[] = [];
    for (let t = 10; t < 15; t++) {
      const sample = intentAt(handle, t);
      sim.applyInput(sample);
      sim.step();
      replay.push(sample);
    }
    const predicted = sim.snapshot();

    sim.reconcile(authoritative, replay);
    expect(Buffer.from(sim.snapshot())).toEqual(Buffer.from(predicted));
    sim.dispose();
  });
});
