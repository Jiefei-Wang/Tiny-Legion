import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import type { ComponentId, MaterialId, PartCategory, PartDefinition, PartDirection, PartPropertySet, PartType } from "../types.ts";

export function getPartDirectionDefault(baseComponent: ComponentId): PartDirection {
  if (baseComponent === "propeller") {
    return "down";
  }
  return "right";
}

export function getPartTypeFromComponent(baseComponent: ComponentId): PartType {
  const type = COMPONENTS[baseComponent].type;
  return type === "control" || type === "engine" || type === "weapon" || type === "loader" || type === "ammo"
    ? type
    : "weapon";
}

export function getPartCategoryFromComponent(baseComponent: ComponentId): PartCategory | undefined {
  if (baseComponent === "engineS" || baseComponent === "engineM") return "vehicle";
  if (baseComponent === "jetEngine") return "jet";
  if (baseComponent === "propeller") return "propeller";
  if (baseComponent === "rapidGun" || baseComponent === "heavyCannon") return "bullet";
  if (baseComponent === "explosiveShell") return "explosive";
  if (baseComponent === "trackingMissile") return "missile";
  if (baseComponent === "precisionBeam") return "beam";
  if (baseComponent === "empEmitter") return "emp";
  return undefined;
}

export function getComponentFromPartTypeAndCategory(partType: PartType, partCategory?: PartCategory): ComponentId {
  if (partType === "structure" || partType === "control") return "control";
  if (partType === "engine") {
    if (partCategory === "jet") return "jetEngine";
    if (partCategory === "propeller") return "propeller";
    return "engineS";
  }
  if (partType === "weapon") {
    if (partCategory === "explosive") return "explosiveShell";
    if (partCategory === "missile") return "trackingMissile";
    if (partCategory === "beam") return "precisionBeam";
    if (partCategory === "emp") return "empEmitter";
    return "rapidGun";
  }
  if (partType === "loader") return "cannonLoader";
  return "ammo";
}

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

export function getPartPropertiesDefaultsByType(partType: PartType, partCategory?: PartCategory): PartPropertySet {
  if (partType === "structure") {
    return { gasCost: 10, mass: 5, hp: 25, tag: "structure", armor: 0, recover: 0, color: "#95a4b8" };
  }
  if (partType === "control") {
    return { gasCost: 10, mass: 2, tag: "control", computing: 1 };
  }
  if (partType === "engine") {
    const directional = partCategory === "propeller";
    return {
      gasCost: 10,
      mass: 10,
      tag: "engine",
      power: 200,
      maxSpeed: 100,
      powerGround: partCategory !== "jet" && partCategory !== "propeller",
      powerAir: partCategory === "jet" || partCategory === "propeller",
      directional,
      defaultDirection: "down",
      thrustAngleDeg: directional ? 30 : undefined,
    };
  }
  if (partType === "weapon") {
    const bulletType = partCategory === "missile" ? "missile" : (partCategory === "beam" ? "laser" : "bullet");
    return {
      gasCost: 10,
      mass: 8,
      tag: "weapon",
      bulletType,
      damage: 20,
      range: 300,
      cooldown: 1,
      recoil: 10,
      hitImpulse: 10,
      penetration: 0,
      spreadAngleDeg: 0,
      explodeOnHit: partCategory === "explosive",
      explodeRadius: 50,
      projectileSpeed: bulletType === "laser" ? undefined : 400,
      projectileGravity: bulletType === "laser" ? undefined : 100,
      tracking: bulletType !== "laser" ? partCategory === "missile" : false,
      trackingTurnRate: partCategory === "missile" ? 50 : undefined,
      directional: true,
      shootAngleDeg: 30,
      needLoader: false,
      defaultDirection: "right",
      computingConsumption: 1,
    };
  }
  if (partType === "loader") {
    return { gasCost: 10, mass: 5, tag: "loader", supportedWeaponTags: ["cannon"], loadMultiplier: 1, minLoadTime: 0.5, minBurstInterval: 0.2 };
  }
  return { gasCost: 10, tag: "ammo", supportedWeaponTags: ["cannon"], maxCapacity: 1, explosionDamage: 100, explosionRadius: 100 };
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

export function createDefaultPartDraft(partId: number, partName: string): PartDefinition {
  const baseComponent: ComponentId = "control";
  const partType: PartType = "control";
  return {
    id: partId,
    name: partName,
    layer: "functional",
    partType,
    partCategory: undefined,
    baseComponent,
    directional: false,
    direction: getPartDirectionDefault(baseComponent),
    anchor: { x: 0, y: 0 },
    cells: [{
      x: 0,
      y: 0,
      structureOccupy: false,
      functionalOccupy: true,
      needStructureBehind: true,
      takeDamage: true,
      attachPoint: false,
      anchorPoint: true,
      firePoint: false,
    }],
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
    partProperties: getPartPropertiesDefaultsByType(partType),
    properties: getPartPropertyDefaults(baseComponent),
  };
}
