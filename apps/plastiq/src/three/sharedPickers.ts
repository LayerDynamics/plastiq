// One shared Picker + GpuPicker pair for the in-canvas pick consumers (the
// Picking layer and the right-click context menu). Both live as siblings inside
// the same r3f <Canvas> (Scene mounts <Picking> and <RightClickDropdownGizmo> →
// useCanvasRightClick) and pick against the same BuiltPart with the same
// renderer/camera, so per-consumer instances only duplicated work: two GPU-id
// render targets, two id-mesh builds writing the same `idColor` attribute onto
// the same geometry, two raycasters.
//
// Seam: a module-level ref-counted pair behind a stable facade, claimed via
// `useSharedPickers()`. A React context/provider seam would need a provider
// mounted in Scene.tsx above both consumers; this hook needs no changes outside
// the two consumer modules and is unit-testable in isolation.
//
// Lifecycle (the part that must stay correct):
//  • GpuPicker owns real GPU resources — a WebGLRenderTarget (created lazily on
//    first pick) and a compiled ShaderMaterial. `dispose()` frees both, after
//    which the instance must NOT be reused.
//  • Each consumer claims the pair for its mount lifetime; the LAST consumer to
//    unmount disposes the GpuPicker and drops the pair (Picker holds no GPU
//    resources and needs no dispose).
//  • Consumers hold the facade, never a captured raw instance: every access goes
//    through the getters, which lazily (re)create a live pair. That makes
//    StrictMode's mount→unmount→mount effect cycle safe — the cycle's unmount
//    leg disposes the pair, and the next access simply builds a fresh one
//    instead of touching disposed GL state.

import { useEffect } from "react";
import { Picker } from "../viewport/pick.js";
import { GpuPicker } from "./gpuPick.js";

export interface SharedPickers {
  readonly picker: Picker;
  readonly gpu: GpuPicker;
}

let shared: { picker: Picker; gpu: GpuPicker } | null = null;
let consumers = 0;

/** The live pair, created on first use (and re-created after a full release). */
function ensure(): { picker: Picker; gpu: GpuPicker } {
  return (shared ??= { picker: new Picker(), gpu: new GpuPicker() });
}

// Stable facade: one object identity for the app's lifetime, delegating to the
// CURRENT pair on every access. Constructing Picker/GpuPicker is render-safe
// (plain THREE objects; no GL work until a pick actually renders).
const facade: SharedPickers = {
  get picker() {
    return ensure().picker;
  },
  get gpu() {
    return ensure().gpu;
  },
};

/**
 * Claim the shared Picker/GpuPicker pair for this component's mount lifetime.
 * Dereference at call time (`pickers.gpu.pick(...)`) — do not destructure and
 * stash the instances, or a StrictMode remount could leave you holding a
 * disposed GpuPicker.
 */
export function useSharedPickers(): SharedPickers {
  useEffect(() => {
    consumers++;
    return () => {
      consumers--;
      if (consumers === 0 && shared) {
        shared.gpu.dispose(); // frees the GPU-id render target + id material
        shared = null; // next claim builds a fresh pair — never reuse disposed GL state
      }
    };
  }, []);
  return facade;
}
