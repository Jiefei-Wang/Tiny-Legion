import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import type { ComponentId, MaterialId, PartDefinition } from "../types.ts";

export function getPartPropertyDefaults(baseComponent: ComponentId): NonNullable<PartDefinition["properties"]> {
  const stats = COMPONENTS[baseComponent];
  return {
    category: stats.type === "weapon"
      ? "weapon"
      : stats.type === "engine"
        ? "mobility"
        : stats.type === "loader"
          ? "support"
          : "functional",
    subcategory: stats.type === "weapon"
      ? (stats.weaponClass ?? "weapon")
      : stats.type === "engine"
        ? (stats.propulsion?.platform ?? "engine")
        : stats.type,
    hp: undefined,
    isEngine: stats.type === "engine",
    isWeapon: stats.type === "weapon",
    isLoader: stats.type === "loader",
    isArmor: false,
    engineType: stats.type === "engine" ? stats.propulsion?.platform : undefined,
    weaponType: stats.type === "weapon" ? stats.weaponClass : undefined,
    loaderServesTags: stats.type === "loader" ? stats.loader?.supports.map((entry) => String(entry)) : undefined,
    loaderCooldownMultiplier: stats.type === "loader" ? stats.loader?.loadMultiplier : undefined,
    hasCoreTuning: false,
  };
}

export function getPartMetadataDefaultsForLayer(
  layer: PartDefinition["layer"],
  baseComponent: ComponentId,
): Pick<NonNullable<PartDefinition["properties"]>, "category" | "subcategory"> {
  if (layer === "structure") {
    return {
      category: "structure",
      subcategory: "armor",
    };
  }
  const defaults = getPartPropertyDefaults(baseComponent);
  return {
    category: defaults.category,
    subcategory: defaults.subcategory,
  };
}

export function getStructureMaterialDefaults(materialId: MaterialId): {
  materialId: MaterialId;
  materialArmor: number;
  materialRecoverPerSecond: number;
  materialColor: string;
  hp: number;
  mass: number;
} {
  const material = MATERIALS[materialId];
  return {
    materialId,
    materialArmor: material.armor,
    materialRecoverPerSecond: material.recoverPerSecond,
    materialColor: material.color,
    hp: material.hp,
    mass: material.mass,
  };
}

export function createDefaultPartDraft(partId: string, partName: string): PartDefinition {
  const defaults = getPartPropertyDefaults("control");
  return {
    id: partId,
    name: partName,
    layer: "functional",
    baseComponent: "control",
    directional: false,
    anchor: { x: 0, y: 0 },
    boxes: [{
      x: 0,
      y: 0,
      occupiesFunctionalSpace: true,
      occupiesStructureSpace: false,
      needsStructureBehind: true,
      isAttachPoint: false,
      isAnchorPoint: true,
      isShootingPoint: false,
      takesDamage: true,
      takesFunctionalDamage: true,
    }],
    properties: defaults,
  };
}
