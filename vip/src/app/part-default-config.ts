import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import type { ComponentId, MaterialId, PartCategory, PartDefinition, PartDirection, PartPropertySet, PartType, ProjectileClass } from "../types.ts";

export function getPartDirectionDefault(baseComponent: ComponentId): PartDirection {
  void baseComponent;
  return "right";
}

export function getPartTypeFromComponent(baseComponent: ComponentId): PartType {
  const type = COMPONENTS[baseComponent].type;
  return type === "control" || type === "engine" || type === "weapon" || type === "loader"
    ? type
    : "weapon";
}

export function getPartCategoryFromComponent(baseComponent: ComponentId): PartCategory | undefined {
  if (baseComponent === "engineS" || baseComponent === "engineM") return "vehicle";
  if (baseComponent === "jetEngine") return "jet";
  if (baseComponent === "rapidGun" || baseComponent === "heavyCannon" || baseComponent === "explosiveShell") return "bullet";
  if (baseComponent === "trackingMissile") return "missile";
  if (baseComponent === "precisionBeam") return "beam";
  return undefined;
}

export function getComponentFromPartTypeAndCategory(partType: PartType, partCategory?: PartCategory, weaponExplosive = false): ComponentId {
  if (partType === "structure" || partType === "control") return "control";
  if (partType === "engine") {
    if (partCategory === "jet") return "jetEngine";
    return "engineS";
  }
  if (partType === "weapon") {
    if (partCategory === "missile") return "trackingMissile";
    if (partCategory === "beam") return "precisionBeam";
    if (weaponExplosive) return "explosiveShell";
    return "rapidGun";
  }
  if (partType === "loader") return "cannonLoader";
  return "cannonLoader";
}

export function getComponentFromProjectileClass(projectileClass: ProjectileClass, explosive = false): ComponentId {
  if (projectileClass === "laser") return "precisionBeam";
  if (projectileClass === "missile") return "trackingMissile";
  if (explosive) return "explosiveShell";
  return "rapidGun";
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
      ? (stats.projectileClass ?? "weapon")
      : stats.type === "engine"
        ? (stats.propulsion?.platform ?? "engine")
        : stats.type,
    hp: undefined,
    isEngine: stats.type === "engine",
    isWeapon: stats.type === "weapon",
    isLoader: stats.type === "loader",
    isArmor: false,
    engineType: stats.type === "engine" ? stats.propulsion?.platform : undefined,
    projectileClass: stats.type === "weapon" ? stats.projectileClass : undefined,
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
    return {
      gasCost: 10,
      mass: 10,
      tag: "engine",
      power: 200,
      maxSpeed: 100,
      powerGround: partCategory !== "jet",
      powerAir: partCategory === "jet",
    };
  }
  if (partType === "weapon") {
    const projectileClass = partCategory === "missile" ? "missile" : (partCategory === "beam" ? "laser" : "bullet");
    return {
      gasCost: 10,
      mass: 8,
      tag: "weapon",
      projectileClass,
      projectileShape: projectileClass === "laser"
        ? "laser-thin"
        : projectileClass === "missile"
          ? "missile-missile"
          : "bullet-round",
      projectileSizeRatio: 1,
      damage: 20,
      range: 300,
      cooldown: 1,
      fireSoundVolume: 1,
      fireSoundPool: projectileClass === "laser"
        ? "beam-precision"
        : (partCategory === "missile" ? "tracking" : "rapid-fire"),
      recoil: 10,
      hitImpulse: 10,
      penetration: 0,
      spreadAngleDeg: 0,
      explodeOnHit: false,
      explodeRadius: 50,
      projectileSpeed: projectileClass === "laser" ? undefined : 400,
      projectileGravity: projectileClass === "laser" ? undefined : 100,
      tracking: projectileClass === "missile",
      trackingTurnRate: partCategory === "missile" ? 50 : undefined,
      hasAngleLimit: true,
      cwAngle: 15,
      ccwAngle: 15,
      needLoader: false,
      maxCapacity: 2,
      minFireInterval: 0.2,
      computingConsumption: 1,
    };
  }
  if (partType === "loader") {
    return { gasCost: 10, mass: 5, tag: "loader", supportedWeaponTags: ["cannon"], loadMultiplier: 1, minLoadTime: 0.5, minBurstInterval: 0.2 };
  }
  return { gasCost: 10, mass: 5, tag: "loader", supportedWeaponTags: ["cannon"], loadMultiplier: 1, minLoadTime: 0.5, minBurstInterval: 0.2 };
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
