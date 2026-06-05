import { describe, expect, it } from "vitest";
import { defaultLibrary, MaterialLibrary } from "./library.js";
import { MaterialManager } from "./manager.js";
import { MATERIAL_PRESETS, PRESET_NAMES } from "./presets.js";
import { type Material, toMaterialData } from "./properties.js";

describe("material presets (FR-22)", () => {
  it("ships steel / aluminum / ABS with correct SI densities", () => {
    expect(MATERIAL_PRESETS["structural-steel"]!.density).toBe(7850);
    expect(MATERIAL_PRESETS["aluminum-6061"]!.density).toBe(2700);
    expect(MATERIAL_PRESETS["abs"]!.density).toBe(1050);
  });

  it("preset physical properties are finite and in valid SI ranges", () => {
    for (const name of PRESET_NAMES) {
      const m = MATERIAL_PRESETS[name]!;
      expect(Number.isFinite(m.density) && m.density > 0).toBe(true);
      expect(m.friction).toBeGreaterThanOrEqual(0);
      expect(m.restitution).toBeGreaterThanOrEqual(0);
      expect(m.restitution).toBeLessThanOrEqual(1);
      expect(m.youngsModulus).toBeGreaterThan(0); // Pa
      expect(m.poissonRatio).toBeGreaterThan(-1);
      expect(m.poissonRatio).toBeLessThan(0.5);
      expect(m.yieldStrength).toBeGreaterThan(0); // Pa
    }
  });

  it("steel is far stiffer than ABS (E in Pa)", () => {
    expect(MATERIAL_PRESETS["structural-steel"]!.youngsModulus).toBeGreaterThan(
      50 * MATERIAL_PRESETS["abs"]!.youngsModulus,
    );
  });
});

describe("material library (FR-22)", () => {
  it("the default library resolves every preset by name", () => {
    const lib = defaultLibrary();
    for (const name of PRESET_NAMES) {
      expect(lib.get(name)?.name).toBe(name);
    }
  });

  it("a custom material can be added and required", () => {
    const lib = new MaterialLibrary();
    const custom: Material = {
      name: "unobtainium",
      density: 19000,
      friction: 0.5,
      restitution: 0.4,
      youngsModulus: 500e9,
      poissonRatio: 0.3,
      yieldStrength: 2e9,
      appearance: { color: [0.2, 0.8, 0.9], metalness: 1, roughness: 0.2 },
    };
    lib.add(custom);
    expect(lib.require("unobtainium")).toBe(custom);
  });

  it("requiring an unknown material throws a typed error", () => {
    expect(() => defaultLibrary().require("vibranium")).toThrow(/unknown material/);
  });
});

describe("material manager → manifest MaterialData (FR-22 → FR-26)", () => {
  it("resolves an assigned body to the manifest MaterialData", () => {
    const mgr = new MaterialManager();
    mgr.assign("crank", "aluminum-6061");
    const data = mgr.dataFor("crank");
    expect(data).toEqual({
      name: "aluminum-6061",
      density: 2700,
      friction: MATERIAL_PRESETS["aluminum-6061"]!.friction,
      restitution: MATERIAL_PRESETS["aluminum-6061"]!.restitution,
    });
    // The lowered data passes the manifest's own validation surface.
    expect(Number.isFinite(data.density)).toBe(true);
  });

  it("toMaterialData strips a full Material to the seam's four fields", () => {
    const steel = MATERIAL_PRESETS["structural-steel"]!;
    expect(toMaterialData(steel)).toEqual({
      name: "structural-steel",
      density: 7850,
      friction: steel.friction,
      restitution: steel.restitution,
    });
  });

  it("a body with no material assigned throws (no silent default)", () => {
    const mgr = new MaterialManager();
    expect(() => mgr.dataFor("ghost")).toThrow(/no material assigned/);
  });
});
