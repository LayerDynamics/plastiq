/* tslint:disable */
/* eslint-disable */

/**
 * A predictable simulation instance exposed to JavaScript/TypeScript.
 */
export class WasmSim {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Buffer a movement intent (milliunit axes) for the entity at slot `index`,
     * resolved against the *current* world, applied on the next [`WasmSim::step`].
     */
    apply_input(index: number, forward: number, strafe: number, turn: number): void;
    /**
     * World orientation quaternion `[x, y, z, w]` of the body at slot `index`
     * (empty if absent).
     */
    body_orientation(index: number): Float64Array;
    /**
     * World position `[x, y, z]` of the body at slot `index` (empty if absent).
     */
    body_position(index: number): Float64Array;
    /**
     * Create a simulation at `tick_rate_hz` seeded with `seed`.
     */
    constructor(tick_rate_hz: number, seed: bigint);
    /**
     * Restore the world from snapshot bytes (the rewind primitive used by
     * reconciliation).
     *
     * # Errors
     * Returns a JS error if the bytes are not a valid snapshot.
     */
    restore_from_bytes(bytes: Uint8Array): void;
    /**
     * Serialize the current world to canonical snapshot bytes.
     */
    snapshot_bytes(): Uint8Array;
    /**
     * Spawn a CAD-authored [`SimManifest`] (JSON) into this world, returning the
     * number of bodies spawned. Lets the in-browser editor simulate a modelled
     * part in the *same* authoritative sim (FR-32) — the bridge reuses
     * `mechx_cad::spawn_into` (shape + pose + mass + lowered joints).
     *
     * # Errors
     * A JS error if the JSON is not a valid manifest or a body cannot spawn.
     */
    spawn_manifest(json: string): number;
    /**
     * Spawn the test entity, returning its **slot index** — the same index the
     * server reports for that entity. Input is addressed by this index (not a
     * private handle) so it stays valid after a reconcile `restore`, which
     * rebuilds the full authoritative world (and may place the client's entity
     * at a non-zero index when other entities exist).
     */
    spawn_test_entity(): number;
    /**
     * Apply all buffered inputs and advance exactly one fixed tick.
     */
    step(): void;
    /**
     * Advance one fixed tick under Earth gravity (+ the ground-plane contact and
     * any lowered joints) — the drop/run step for an authored part. Distinct
     * from [`WasmSim::step`], which is the input-driven prediction step.
     */
    step_dynamics(): void;
    /**
     * Number of live bodies in the world.
     */
    readonly body_count: number;
    /**
     * The current simulation tick.
     */
    readonly tick: bigint;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmsim_free: (a: number, b: number) => void;
    readonly wasmsim_apply_input: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmsim_body_count: (a: number) => number;
    readonly wasmsim_body_orientation: (a: number, b: number) => [number, number];
    readonly wasmsim_body_position: (a: number, b: number) => [number, number];
    readonly wasmsim_new: (a: number, b: bigint) => number;
    readonly wasmsim_restore_from_bytes: (a: number, b: number, c: number) => [number, number];
    readonly wasmsim_snapshot_bytes: (a: number) => [number, number];
    readonly wasmsim_spawn_manifest: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmsim_spawn_test_entity: (a: number) => number;
    readonly wasmsim_step: (a: number) => void;
    readonly wasmsim_step_dynamics: (a: number) => void;
    readonly wasmsim_tick: (a: number) => bigint;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
