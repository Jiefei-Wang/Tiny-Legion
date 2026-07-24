import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import { normalizeRotateQuarter, getPartFootprintCells } from "./part-geometry.ts";
import { validatePartDefinitionDetailed } from "./part-validation.ts";
import type { ComponentId, MaterialId, PartCategory, PartDefinition, PartDirection, PartPropertySet, PartType, UnitType } from "../types.ts";

export { normalizeRotateQuarter, rotateOffsetByQuarter, getPartFootprintCells } from "./part-geometry.ts";
export { validatePartDefinitionDetailed, validatePartDefinition } from "./part-validation.ts";

function resolvePartTypeFromComponent(component: ComponentId): PartType {
  const stats = COMPONENTS[component];
  if (stats.type === "control" || stats.type === "engine" || stats.type === "weapon" || stats.type === "loader") {
    return stats.type;
  }
  return "weapon";
}

function resolvePartCategoryFromComponent(component: ComponentId): PartCategory | undefined {
  if (component === "engineS" || component === "engineM") {
    return "vehicle";
  }
  if (component === "jetEngine") {
    return "jet";
  }
  if (component === "rapidGun" || component === "heavyCannon" || component === "explosiveShell") {
    return "bullet";
  }
  if (component === "trackingMissile") {
    return "missile";
  }
  if (component === "precisionBeam") {
    return "beam";
  }
  return undefined;
}

function mapPartTypeAndCategoryToComponent(partType: PartType, partCategory?: PartCategory, weaponExplosive = false): ComponentId {
  if (partType === "structure" || partType === "control") {
    return "control";
  }
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
  if (partType === "loader") {
    return "cannonLoader";
  }
  return "cannonLoader";
}


function collectPartTags(part: PartDefinition): Set<string> {
  const tags = part.tags ?? [];
  const normalized = tags
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(normalized);
}

export function isPartCompatibleWithUnitType(part: PartDefinition, unitType: UnitType): boolean {
  const tags = collectPartTags(part);
  const hasGroundTag = tags.has("ground");
  const hasAirTag = tags.has("air");
  if (hasGroundTag || hasAirTag) {
    return unitType === "ground" ? hasGroundTag : hasAirTag;
  }

  const isEngine = part.partType === "engine" || part.properties?.isEngine === true || COMPONENTS[part.baseComponent].type === "engine";
  if (!isEngine) {
    return true;
  }
  const supportsGround = part.partProperties?.powerGround ?? ((part.properties?.engineType ?? COMPONENTS[part.baseComponent].propulsion?.platform) === "ground");
  const supportsAir = part.partProperties?.powerAir ?? ((part.properties?.engineType ?? COMPONENTS[part.baseComponent].propulsion?.platform) === "air");
  if (unitType === "ground") {
    return supportsGround;
  }
  return supportsAir;
}

function isComponentId(value: unknown): value is ComponentId {
  return typeof value === "string" && value in COMPONENTS;
}

function readOptionalInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function getDefaultMaterialGasCost(materialId: MaterialId): number {
  if (materialId === "basic") {
    return 4;
  }
  if (materialId === "reinforced") {
    return 5;
  }
  if (materialId === "ceramic") {
    return 6;
  }
  if (materialId === "reactive") {
    return 7;
  }
  return 8;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") {
    return undefined;
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const next = value.trim();
  return next.length > 0 ? next : undefined;
}

function readOptionalWeaponClass(value: unknown): "rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" | undefined {
  if (value === "rapid-fire" || value === "heavy-shot" || value === "explosive" || value === "tracking" || value === "beam-precision") {
    return value;
  }
  return undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string") {
    const items = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function normalizeOffsets(value: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: Array<{ x: number; y: number }> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const x = readOptionalInt(record.x);
    const y = readOptionalInt(record.y);
    if (x === undefined || y === undefined) {
      continue;
    }
    result.push({ x, y });
  }
  return result;
}

const DEFAULT_PART_ID_BY_COMPONENT: Record<ComponentId, number> = {
  cannonLoader: 2,
  control: 3,
  engineM: 5,
  engineS: 6,
  explosiveShell: 7,
  heavyCannon: 8,
  jetEngine: 9,
  missileLoader: 16,
  precisionBeam: 17,
  rapidGun: 19,
  trackingMissile: 20,
};

const DEFAULT_MATERIAL_PART_ID: Record<MaterialId, number> = {
  basic: 11,
  ceramic: 12,
  combined: 13,
  reactive: 14,
  reinforced: 15,
};

function normalizePartId(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return fallback;
}

function readOptionalPartDirection(value: unknown): PartDirection | undefined {
  if (value === "up" || value === "right" || value === "down" || value === "left") {
    return value;
  }
  return undefined;
}

function readOptionalPartType(value: unknown): PartType | undefined {
  if (value === "structure" || value === "control" || value === "engine" || value === "weapon" || value === "loader") {
    return value;
  }
  return undefined;
}

function readOptionalPartCategory(value: unknown): PartCategory | undefined {
  if (
    value === "vehicle"
    || value === "jet"
    || value === "bullet"
    || value === "missile"
    || value === "beam"
  ) {
    return value;
  }
  return undefined;
}

function getDefaultPartDirection(baseComponent: ComponentId): PartDirection {
  void baseComponent;
  return "right";
}

function getLegacyFootprintOffsets(component: ComponentId): Array<{ x: number; y: number }> {
  const stats = COMPONENTS[component];
  const placementOffsets = stats.placement?.footprintOffsets;
  if (placementOffsets && placementOffsets.length > 0) {
    return placementOffsets.map((offset) => ({ x: offset.x, y: offset.y }));
  }
  if (stats.type === "weapon" && stats.weaponClass === "heavy-shot") {
    return [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  }
  return [{ x: 0, y: 0 }];
}

function createImplicitStructurePartDefinition(component: ComponentId): PartDefinition {
  const stats = COMPONENTS[component];
  return {
    id: DEFAULT_PART_ID_BY_COMPONENT[component],
    name: `${component}-structure`,
    layer: "structure",
    partType: "structure",
    baseComponent: component,
    directional: stats.directional === true,
    direction: getDefaultPartDirection(component),
    anchor: { x: 0, y: 0 },
    cells: [{
      x: 0,
      y: 0,
      structureOccupy: true,
      functionalOccupy: false,
      needStructureBehind: false,
      takeDamage: true,
      attachPoint: false,
      anchorPoint: true,
      firePoint: false,
    }],
    boxes: [{
      x: 0,
      y: 0,
      occupiesStructureSpace: true,
      occupiesFunctionalSpace: false,
      needsStructureBehind: false,
      isAttachPoint: false,
      isAnchorPoint: true,
      isShootingPoint: false,
      takesDamage: true,
      takesFunctionalDamage: true,
    }],
    placement: {
      requireStructureOffsets: [],
      requireStructureOnFunctionalOccupiedBoxes: false,
      requireStructureOnStructureOccupiedBoxes: false,
      requireEmptyStructureOffsets: [],
      requireEmptyFunctionalOffsets: [],
    },
    properties: {
      category: "structure",
      subcategory: "armor",
      hp: undefined,
      isEngine: false,
      isWeapon: false,
      isLoader: false,
      isArmor: true,
      engineType: undefined,
      weaponType: undefined,
      loaderServesTags: undefined,
      loaderCooldownMultiplier: undefined,
      hasCoreTuning: false,
    },
    tags: ["implicit", "structure"],
  };
}

function createImplicitStructureMaterialPartDefinition(materialId: MaterialId): PartDefinition {
  const material = MATERIALS[materialId];
  return {
    id: DEFAULT_MATERIAL_PART_ID[materialId],
    name: material.label,
    layer: "structure",
    partType: "structure",
    baseComponent: "control",
    directional: false,
    direction: "up",
    anchor: { x: 0, y: 0 },
    cells: [{
      x: 0,
      y: 0,
      structureOccupy: true,
      functionalOccupy: false,
      needStructureBehind: false,
      takeDamage: true,
      attachPoint: false,
      anchorPoint: true,
      firePoint: false,
    }],
    boxes: [{
      x: 0,
      y: 0,
      occupiesStructureSpace: true,
      occupiesFunctionalSpace: false,
      needsStructureBehind: false,
      isAttachPoint: false,
      isAnchorPoint: true,
      isShootingPoint: false,
      takesDamage: true,
      takesFunctionalDamage: true,
    }],
    placement: {
      requireStructureOffsets: [],
      requireStructureOnFunctionalOccupiedBoxes: false,
      requireStructureOnStructureOccupiedBoxes: false,
      requireEmptyStructureOffsets: [],
      requireEmptyFunctionalOffsets: [],
    },
    stats: {
      mass: material.mass,
      gasCost: getDefaultMaterialGasCost(materialId),
    },
    partProperties: {
      gasCost: getDefaultMaterialGasCost(materialId),
      mass: material.mass,
      hp: material.hp,
      tag: "structure",
      armor: material.armor,
      recover: material.recoverPerSecond,
      color: material.color,
      alpha: 1,
    },
    properties: {
      category: "structure",
      subcategory: "material",
      materialId,
      materialArmor: material.armor,
      materialRecoverPerSecond: material.recoverPerSecond,
      materialColor: material.color,
      materialAlpha: 1,
      hp: material.hp,
      isEngine: false,
      isWeapon: false,
      isLoader: false,
      isArmor: true,
      engineType: undefined,
      weaponType: undefined,
      loaderServesTags: undefined,
      loaderCooldownMultiplier: undefined,
      hasCoreTuning: false,
    },
    tags: ["implicit", "structure", "material"],
  };
}

export function createImplicitPartDefinition(component: ComponentId): PartDefinition {
  const stats = COMPONENTS[component];
  const requireStructureOnFunctional = stats.placement?.requireStructureOnFootprint ?? true;
  const boxes = getLegacyFootprintOffsets(component).map((offset) => ({
    x: offset.x,
    y: offset.y,
    occupiesStructureSpace: false,
    occupiesFunctionalSpace: true,
    needsStructureBehind: requireStructureOnFunctional,
    isAttachPoint: false,
    isAnchorPoint: offset.x === 0 && offset.y === 0,
    isShootingPoint: stats.type === "weapon" && offset.x === 0 && offset.y === 0,
    takesDamage: true,
    takesFunctionalDamage: true,
  }));
  const platformTag = stats.type === "engine" && (stats.propulsion?.platform === "ground" || stats.propulsion?.platform === "air")
    ? [stats.propulsion.platform]
    : [];
  return {
    id: DEFAULT_PART_ID_BY_COMPONENT[component],
    name: component,
    layer: "functional",
    partType: resolvePartTypeFromComponent(component),
    partCategory: resolvePartCategoryFromComponent(component),
    baseComponent: component,
    directional: stats.directional === true,
    direction: getDefaultPartDirection(component),
    anchor: { x: 0, y: 0 },
    cells: boxes.map((box) => ({
      x: box.x,
      y: box.y,
      structureOccupy: box.occupiesStructureSpace,
      functionalOccupy: box.occupiesFunctionalSpace,
      needStructureBehind: box.needsStructureBehind,
      takeDamage: box.takesDamage,
      attachPoint: box.isAttachPoint,
      anchorPoint: box.isAnchorPoint,
      firePoint: box.isShootingPoint,
    })),
    boxes,
    placement: {
      requireStructureOffsets: [],
      requireStructureOnFunctionalOccupiedBoxes: requireStructureOnFunctional,
      requireStructureOnStructureOccupiedBoxes: true,
      requireEmptyStructureOffsets: (stats.placement?.requireEmptyOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
      requireEmptyFunctionalOffsets: [],
    },
    stats: {
      gasCost: stats.gasCost,
    },
    partProperties: {
      gasCost: stats.gasCost ?? 10,
      mass: stats.mass,
      tag: resolvePartTypeFromComponent(component),
      power: stats.power,
      maxSpeed: stats.maxSpeed,
      powerGround: stats.type === "engine" ? stats.propulsion?.platform === "ground" : undefined,
      powerAir: stats.type === "engine" ? stats.propulsion?.platform === "air" : undefined,
      hasAngleLimit: stats.type === "weapon" ? stats.hasAngleLimit === true : undefined,
      cwAngle: stats.type === "weapon" && stats.hasAngleLimit === true ? stats.cwAngle : undefined,
      ccwAngle: stats.type === "weapon" && stats.hasAngleLimit === true ? stats.ccwAngle : undefined,
      bulletType: stats.type === "weapon"
        ? ((stats.weaponClass === "tracking")
            ? "missile"
            : (stats.weaponClass === "beam-precision" ? "laser" : "bullet"))
        : undefined,
      damage: stats.damage,
      range: stats.range,
      cooldown: stats.cooldown,
      fireSoundVolume: stats.type === "weapon" ? 1 : undefined,
      recoil: stats.recoil,
      hitImpulse: stats.hitImpulse,
      penetration: stats.penetration,
      spreadAngleDeg: stats.spreadDeg,
      explodeOnHit: stats.weaponClass === "explosive",
      explodeRadius: stats.explosive?.blastRadius,
      projectileSpeed: stats.projectileSpeed,
      projectileGravity: stats.projectileGravity,
      tracking: stats.weaponClass === "tracking",
      trackingTurnRate: stats.tracking?.turnRateDegPerSec,
      needLoader: stats.weaponClass === "tracking" || stats.weaponClass === "heavy-shot" || stats.weaponClass === "explosive",
      supportedWeaponTags: stats.type === "loader" ? (stats.loader?.supports ?? []).map((entry) => String(entry)) : undefined,
      loadMultiplier: stats.loader?.loadMultiplier,
      minLoadTime: stats.loader?.minLoadTime,
      minBurstInterval: stats.loader?.minBurstInterval,
      maxCapacity: stats.type === "weapon" ? stats.maxLoadedAmmo : undefined,
      computing: stats.type === "control" ? 20 : undefined,
      computingConsumption: stats.type === "weapon" ? 1 : undefined,
    },
    properties: {
      category: stats.type,
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
    },
    tags: ["implicit", ...platformTag],
  };
}

let defaultCatalogCache: PartDefinition[] | null = null;

export function createDefaultPartDefinitions(): PartDefinition[] {
  if (defaultCatalogCache) {
    return defaultCatalogCache.map((part) => clonePartDefinition(part));
  }
  const componentParts = Object.keys(COMPONENTS)
    .map((id) => createImplicitPartDefinition(id as ComponentId))
    .sort((a, b) => a.id - b.id);
  const materialParts = (Object.keys(MATERIALS) as MaterialId[])
    .map((id) => createImplicitStructureMaterialPartDefinition(id))
    .sort((a, b) => a.id - b.id);
  const parts = [...componentParts, ...materialParts].sort((a, b) => a.id - b.id);
  defaultCatalogCache = parts;
  return parts.map((part) => clonePartDefinition(part));
}

export function resolvePartGasCost(part: PartDefinition): number {
  if (typeof part.partProperties?.gasCost === "number" && Number.isFinite(part.partProperties.gasCost)) {
    return Math.max(0, Math.floor(part.partProperties.gasCost));
  }
  if (typeof part.stats?.gasCost === "number" && Number.isFinite(part.stats.gasCost)) {
    return Math.max(0, Math.floor(part.stats.gasCost));
  }
  if (part.layer === "structure") {
    const materialId = part.properties?.materialId;
    if (materialId) {
      return getDefaultMaterialGasCost(materialId);
    }
  }
  return Math.max(0, Math.floor(COMPONENTS[part.baseComponent].gasCost ?? 0));
}

export function resolveStructureMaterialGasCost(
  materialId: MaterialId,
  partCatalog?: ReadonlyArray<PartDefinition>,
): number {
  const defaults = createDefaultPartDefinitions();
  const catalog = partCatalog && partCatalog.length > 0 ? mergePartCatalogs(defaults, partCatalog) : defaults;
  const byMaterial = catalog.find((part) => part.layer === "structure" && part.properties?.materialId === materialId);
  if (byMaterial) {
    return resolvePartGasCost(byMaterial);
  }
  const byId = catalog.find((part) => part.id === DEFAULT_MATERIAL_PART_ID[materialId]);
  if (byId) {
    return resolvePartGasCost(byId);
  }
  return getDefaultMaterialGasCost(materialId);
}

export function buildPartCatalogMap(parts: ReadonlyArray<PartDefinition>): Map<number, PartDefinition> {
  const map = new Map<number, PartDefinition>();
  for (const part of parts) {
    map.set(part.id, part);
  }
  return map;
}

export function mergePartCatalogs(baseParts: ReadonlyArray<PartDefinition>, incomingParts: ReadonlyArray<PartDefinition>): PartDefinition[] {
  const map = new Map<number, PartDefinition>();
  for (const part of baseParts) {
    map.set(part.id, clonePartDefinition(part));
  }
  for (const part of incomingParts) {
    map.set(part.id, clonePartDefinition(part));
  }
  return Array.from(map.values()).sort((a, b) => a.id - b.id);
}

export function resolvePartDefinitionForAttachment(
  attachment: { partId?: number; component?: ComponentId },
  partCatalog?: ReadonlyArray<PartDefinition>,
): PartDefinition | null {
  const defaults = createDefaultPartDefinitions();
  const catalog = partCatalog && partCatalog.length > 0 ? mergePartCatalogs(defaults, partCatalog) : defaults;
  const catalogMap = buildPartCatalogMap(catalog);

  if (attachment.partId && catalogMap.has(attachment.partId)) {
    return clonePartDefinition(catalogMap.get(attachment.partId) as PartDefinition);
  }
  if (attachment.component && isComponentId(attachment.component)) {
    return createImplicitPartDefinition(attachment.component);
  }
  return null;
}

export function clonePartDefinition(part: PartDefinition): PartDefinition {
  return {
    id: part.id,
    name: part.name,
    layer: part.layer,
    partType: part.partType,
    partCategory: part.partCategory,
    baseComponent: part.baseComponent,
    directional: part.directional,
    direction: part.direction,
    anchor: { x: part.anchor.x, y: part.anchor.y },
    cells: part.cells
      ? part.cells.map((cell) => ({
          x: cell.x,
          y: cell.y,
          structureOccupy: cell.structureOccupy,
          functionalOccupy: cell.functionalOccupy,
          needStructureBehind: cell.needStructureBehind,
          takeDamage: cell.takeDamage,
          attachPoint: cell.attachPoint,
          anchorPoint: cell.anchorPoint,
          firePoint: cell.firePoint,
        }))
      : undefined,
    boxes: part.boxes.map((box) => ({
      x: box.x,
      y: box.y,
      occupiesStructureSpace: box.occupiesStructureSpace,
      occupiesFunctionalSpace: box.occupiesFunctionalSpace,
      needsStructureBehind: box.needsStructureBehind,
      isAttachPoint: box.isAttachPoint,
      isAnchorPoint: box.isAnchorPoint,
      isShootingPoint: box.isShootingPoint,
      takesDamage: box.takesDamage,
      takesFunctionalDamage: box.takesFunctionalDamage,
    })),
    placement: part.placement
      ? {
          requireStructureOffsets: (part.placement.requireStructureOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
          requireStructureOnFunctionalOccupiedBoxes: part.placement.requireStructureOnFunctionalOccupiedBoxes,
          requireStructureOnStructureOccupiedBoxes: part.placement.requireStructureOnStructureOccupiedBoxes,
          requireEmptyStructureOffsets: (part.placement.requireEmptyStructureOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
          requireEmptyFunctionalOffsets: (part.placement.requireEmptyFunctionalOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
        }
      : undefined,
    partProperties: part.partProperties
      ? {
          gasCost: part.partProperties.gasCost,
          mass: part.partProperties.mass,
          hp: part.partProperties.hp,
          tag: part.partProperties.tag,
          armor: part.partProperties.armor,
          recover: part.partProperties.recover,
          color: part.partProperties.color,
          alpha: part.partProperties.alpha,
          computing: part.partProperties.computing,
          computingConsumption: part.partProperties.computingConsumption,
          power: part.partProperties.power,
          maxSpeed: part.partProperties.maxSpeed,
          powerGround: part.partProperties.powerGround,
          powerAir: part.partProperties.powerAir,
          hasAngleLimit: part.partProperties.hasAngleLimit,
          cwAngle: part.partProperties.cwAngle,
          ccwAngle: part.partProperties.ccwAngle,
          bulletType: part.partProperties.bulletType,
          damage: part.partProperties.damage,
          range: part.partProperties.range,
          cooldown: part.partProperties.cooldown,
          fireSoundVolume: part.partProperties.fireSoundVolume,
          recoil: part.partProperties.recoil,
          hitImpulse: part.partProperties.hitImpulse,
          penetration: part.partProperties.penetration,
          spreadAngleDeg: part.partProperties.spreadAngleDeg,
          explodeOnHit: part.partProperties.explodeOnHit,
          explodeRadius: part.partProperties.explodeRadius,
          projectileSpeed: part.partProperties.projectileSpeed,
          projectileGravity: part.partProperties.projectileGravity,
          tracking: part.partProperties.tracking,
          trackingTurnRate: part.partProperties.trackingTurnRate,
          needLoader: part.partProperties.needLoader,
          supportedWeaponTags: part.partProperties.supportedWeaponTags ? [...part.partProperties.supportedWeaponTags] : undefined,
          loadMultiplier: part.partProperties.loadMultiplier,
          minLoadTime: part.partProperties.minLoadTime,
          minBurstInterval: part.partProperties.minBurstInterval,
          maxCapacity: part.partProperties.maxCapacity,
          explosionDamage: part.partProperties.explosionDamage,
          explosionRadius: part.partProperties.explosionRadius,
        }
      : undefined,
    stats: part.stats
      ? {
          gasCost: part.stats.gasCost,
          mass: part.stats.mass,
          hpMul: part.stats.hpMul,
          power: part.stats.power,
          maxSpeed: part.stats.maxSpeed,
          recoil: part.stats.recoil,
          hitImpulse: part.stats.hitImpulse,
          damage: part.stats.damage,
          range: part.stats.range,
          cooldown: part.stats.cooldown,
          projectileSpeed: part.stats.projectileSpeed,
          projectileGravity: part.stats.projectileGravity,
          penetration: part.stats.penetration,
          spreadDeg: part.stats.spreadDeg,
          explosiveBlastRadius: part.stats.explosiveBlastRadius,
          explosiveBlastDamage: part.stats.explosiveBlastDamage,
          explosiveFalloffPower: part.stats.explosiveFalloffPower,
          trackingTurnRateDegPerSec: part.stats.trackingTurnRateDegPerSec,
          controlImpairFactor: part.stats.controlImpairFactor,
          controlDuration: part.stats.controlDuration,
          loaderSupports: part.stats.loaderSupports ? [...part.stats.loaderSupports] : undefined,
          loaderLoadMultiplier: part.stats.loaderLoadMultiplier,
          loaderFastOperation: part.stats.loaderFastOperation,
          loaderMinLoadTime: part.stats.loaderMinLoadTime,
          loaderMinBurstInterval: part.stats.loaderMinBurstInterval,
        }
      : undefined,
    properties: part.properties
      ? {
          category: part.properties.category,
          subcategory: part.properties.subcategory,
          materialId: part.properties.materialId,
          materialArmor: part.properties.materialArmor,
          materialRecoverPerSecond: part.properties.materialRecoverPerSecond,
          materialColor: part.properties.materialColor,
          materialAlpha: part.properties.materialAlpha,
          hp: part.properties.hp,
          isEngine: part.properties.isEngine,
          isWeapon: part.properties.isWeapon,
          isLoader: part.properties.isLoader,
          isArmor: part.properties.isArmor,
          engineType: part.properties.engineType,
          weaponType: part.properties.weaponType,
          loaderServesTags: part.properties.loaderServesTags ? [...part.properties.loaderServesTags] : undefined,
          loaderCooldownMultiplier: part.properties.loaderCooldownMultiplier,
          hasCoreTuning: part.properties.hasCoreTuning,
        }
      : undefined,
    tags: part.tags ? [...part.tags] : undefined,
  };
}

export function parsePartDefinition(input: unknown): PartDefinition | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const data = input as Record<string, unknown>;
  const declaredPartType = readOptionalPartType(data.partType ?? data.type);
  const rawDeclaredPartCategory = data.partCategory ?? data.categoryType;
  const legacyExplosiveCategory = rawDeclaredPartCategory === "explosive";
  const declaredPartCategory = readOptionalPartCategory(rawDeclaredPartCategory) ?? (legacyExplosiveCategory ? "bullet" : undefined);
  const partPropertiesRecord = data.partProperties && typeof data.partProperties === "object"
    ? (data.partProperties as Record<string, unknown>)
    : {};
  const declaredExplodeOnHit = readOptionalBoolean(partPropertiesRecord.explodeOnHit);
  const baseComponent = isComponentId(data.baseComponent)
    ? data.baseComponent
    : isComponentId(data.component)
      ? data.component
      : declaredPartType
        ? mapPartTypeAndCategoryToComponent(
            declaredPartType,
            declaredPartCategory,
            declaredPartType === "weapon" ? (declaredExplodeOnHit ?? legacyExplosiveCategory) : false,
          )
        : null;
  if (!baseComponent) {
    return null;
  }

  const id = normalizePartId(data.id, -1);
  if (id < 1) {
    return null;
  }
  const name = typeof data.name === "string" && data.name.trim().length > 0 ? data.name.trim() : `part-${id}`;
  const inferredPartType = declaredPartType ?? (data.layer === "structure" ? "structure" : resolvePartTypeFromComponent(baseComponent));
  const layer = inferredPartType === "structure" || data.layer === "structure" ? "structure" : "functional";

  const anchorRecord = data.anchor && typeof data.anchor === "object" ? (data.anchor as Record<string, unknown>) : {};
  const requestedAnchorX = readOptionalInt(anchorRecord.x) ?? 0;
  const requestedAnchorY = readOptionalInt(anchorRecord.y) ?? 0;

  const boxesRaw = Array.isArray(data.boxes) ? data.boxes : [];
  const cellsRaw = Array.isArray(data.cells) ? data.cells : [];
  const defaultOccupiesStructureSpace = layer === "structure";
  const defaultOccupiesFunctionalSpace = layer !== "structure";
  let anchorFromBox: { x: number; y: number } | null = null;
  const cellsAsBoxes = cellsRaw
    .map((raw) => {
      if (!raw || typeof raw !== "object") {
        return null;
      }
      const record = raw as Record<string, unknown>;
      const x = readOptionalInt(record.x);
      const y = readOptionalInt(record.y);
      if (x === undefined || y === undefined) {
        return null;
      }
      const isAnchorPoint = record.anchorPoint === true || record.isAnchorPoint === true;
      if (isAnchorPoint && anchorFromBox === null) {
        anchorFromBox = { x, y };
      }
      const isAttachPoint = record.attachPoint === true;
      const occupiesStructureSpace = typeof record.structureOccupy === "boolean"
        ? record.structureOccupy
        : defaultOccupiesStructureSpace;
      const occupiesFunctionalSpace = typeof record.functionalOccupy === "boolean"
        ? record.functionalOccupy
        : defaultOccupiesFunctionalSpace;
      return {
        x,
        y,
        occupiesStructureSpace,
        occupiesFunctionalSpace,
        needsStructureBehind: record.needStructureBehind === true,
        isAttachPoint,
        isAnchorPoint,
        isShootingPoint: record.firePoint === true,
        takesDamage: typeof record.takeDamage === "boolean" ? record.takeDamage : undefined,
        takesFunctionalDamage: typeof record.takeDamage === "boolean" ? record.takeDamage : undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const parsedBoxes = boxesRaw
    .map((raw) => {
      if (!raw || typeof raw !== "object") {
        return null;
      }
      const record = raw as Record<string, unknown>;
      const x = readOptionalInt(record.x);
      const y = readOptionalInt(record.y);
      if (x === undefined || y === undefined) {
        return null;
      }
      const isAnchorPoint = record.isAnchorPoint === true || record.anchorPoint === true || record.isAnchor === true;
      if (isAnchorPoint && anchorFromBox === null) {
        anchorFromBox = { x, y };
      }
      const occupiesStructureSpace = typeof record.occupiesStructureSpace === "boolean"
        ? record.occupiesStructureSpace
        : defaultOccupiesStructureSpace;
      const occupiesFunctionalSpace = typeof record.occupiesFunctionalSpace === "boolean"
        ? record.occupiesFunctionalSpace
        : defaultOccupiesFunctionalSpace;
      return {
        x,
        y,
        occupiesStructureSpace,
        occupiesFunctionalSpace,
        needsStructureBehind: record.needsStructureBehind === true || record.needStructureBehind === true || record.requireStructureBehind === true,
        isAttachPoint: record.isAttachPoint === true || record.attachPoint === true,
        isAnchorPoint,
        isShootingPoint: record.isShootingPoint === true
          || record.shootingPoint === true
          || record.firePoint === true
          || record.isFirePoint === true,
        takesDamage: typeof record.takesDamage === "boolean" ? record.takesDamage : undefined,
        takesFunctionalDamage: typeof record.takesFunctionalDamage === "boolean" ? record.takesFunctionalDamage : undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  // `boxes` is the current editor/runtime geometry model. `cells` remains a
  // compatibility mirror for older files, so it must not overwrite newer
  // editor geometry when both representations are present.
  const boxes = parsedBoxes.length > 0 ? parsedBoxes : cellsAsBoxes;

  const fallback = layer === "structure"
    ? createImplicitStructurePartDefinition(baseComponent)
    : createImplicitPartDefinition(baseComponent);
  const resolvedBoxes = boxes.length > 0 ? boxes : fallback.boxes;
  const resolvedAnchor = anchorFromBox ?? { x: requestedAnchorX, y: requestedAnchorY };
  const placementRecord = data.placement && typeof data.placement === "object" ? (data.placement as Record<string, unknown>) : {};

  const runtimeRecord = data.stats && typeof data.stats === "object"
    ? (data.stats as Record<string, unknown>)
    : data.runtimeOverrides && typeof data.runtimeOverrides === "object"
      ? (data.runtimeOverrides as Record<string, unknown>)
      : data.parameters && typeof data.parameters === "object"
        ? (data.parameters as Record<string, unknown>)
      : {};
  const runtimeExplosiveRecord = runtimeRecord.explosive && typeof runtimeRecord.explosive === "object"
    ? (runtimeRecord.explosive as Record<string, unknown>)
    : {};
  const runtimeTrackingRecord = runtimeRecord.tracking && typeof runtimeRecord.tracking === "object"
    ? (runtimeRecord.tracking as Record<string, unknown>)
    : {};
  const runtimeLoaderRecord = runtimeRecord.loader && typeof runtimeRecord.loader === "object"
    ? (runtimeRecord.loader as Record<string, unknown>)
    : {};
  const propertiesRecord = data.properties && typeof data.properties === "object"
    ? (data.properties as Record<string, unknown>)
    : {};
  const normalizedPartType: PartType = inferredPartType;
  const normalizedPartCategory = declaredPartCategory ?? resolvePartCategoryFromComponent(baseComponent);
  const hasAngleLimitRaw = readOptionalBoolean(partPropertiesRecord.hasAngleLimit);
  const cwAngleRaw = readOptionalNumber(partPropertiesRecord.cwAngle);
  const ccwAngleRaw = readOptionalNumber(partPropertiesRecord.ccwAngle);
  const hasAngleLimit = hasAngleLimitRaw ?? (normalizedPartType === "weapon" ? false : undefined);
  const partProperties: PartPropertySet = {
    gasCost: readOptionalNumber(partPropertiesRecord.gasCost),
    mass: readOptionalNumber(partPropertiesRecord.mass),
    hp: readOptionalNumber(partPropertiesRecord.hp),
    tag: readOptionalString(partPropertiesRecord.tag),
    armor: readOptionalNumber(partPropertiesRecord.armor),
    recover: readOptionalNumber(partPropertiesRecord.recover),
    color: readOptionalString(partPropertiesRecord.color),
    alpha: readOptionalNumber(partPropertiesRecord.alpha),
    computing: readOptionalNumber(partPropertiesRecord.computing),
    computingConsumption: readOptionalNumber(partPropertiesRecord.computingConsumption ?? partPropertiesRecord.computingCost),
    power: readOptionalNumber(partPropertiesRecord.power),
    maxSpeed: readOptionalNumber(partPropertiesRecord.maxSpeed),
    powerGround: readOptionalBoolean(partPropertiesRecord.powerGround),
    powerAir: readOptionalBoolean(partPropertiesRecord.powerAir),
    hasAngleLimit,
    cwAngle: cwAngleRaw,
    ccwAngle: ccwAngleRaw,
    bulletType: (partPropertiesRecord.bulletType === "bullet" || partPropertiesRecord.bulletType === "missile" || partPropertiesRecord.bulletType === "laser")
      ? partPropertiesRecord.bulletType
      : undefined,
    damage: readOptionalNumber(partPropertiesRecord.damage),
    range: readOptionalNumber(partPropertiesRecord.range),
    cooldown: readOptionalNumber(partPropertiesRecord.cooldown),
    fireSoundVolume: readOptionalNumber(partPropertiesRecord.fireSoundVolume),
    recoil: readOptionalNumber(partPropertiesRecord.recoil),
    hitImpulse: readOptionalNumber(partPropertiesRecord.hitImpulse),
    penetration: readOptionalNumber(partPropertiesRecord.penetration),
    spreadAngleDeg: readOptionalNumber(partPropertiesRecord.spreadAngleDeg),
    explodeOnHit: readOptionalBoolean(partPropertiesRecord.explodeOnHit),
    explodeRadius: readOptionalNumber(partPropertiesRecord.explodeRadius),
    projectileSpeed: readOptionalNumber(partPropertiesRecord.projectileSpeed),
    projectileGravity: readOptionalNumber(partPropertiesRecord.projectileGravity),
    tracking: readOptionalBoolean(partPropertiesRecord.tracking),
    trackingTurnRate: readOptionalNumber(partPropertiesRecord.trackingTurnRate),
    needLoader: readOptionalBoolean(partPropertiesRecord.needLoader),
    supportedWeaponTags: normalizeStringList(partPropertiesRecord.supportedWeaponTags),
    loadMultiplier: readOptionalNumber(partPropertiesRecord.loadMultiplier),
    minLoadTime: readOptionalNumber(partPropertiesRecord.minLoadTime),
    minBurstInterval: readOptionalNumber(partPropertiesRecord.minBurstInterval),
    maxCapacity: readOptionalNumber(partPropertiesRecord.maxCapacity),
    explosionDamage: readOptionalNumber(partPropertiesRecord.explosionDamage),
    explosionRadius: readOptionalNumber(partPropertiesRecord.explosionRadius),
  };
  if (
    inferredPartType === "weapon"
    && partProperties.explodeOnHit === undefined
    && (legacyExplosiveCategory || baseComponent === "explosiveShell")
  ) {
    partProperties.explodeOnHit = true;
  }
  if (inferredPartType === "control" && partProperties.computing === undefined) {
    partProperties.computing = 1;
  }
  if (inferredPartType === "weapon" && partProperties.computingConsumption === undefined) {
    partProperties.computingConsumption = 1;
  }

  const parsed: PartDefinition = {
    id,
    name,
    layer,
    partType: normalizedPartType,
    partCategory: normalizedPartCategory,
    baseComponent,
    directional: typeof data.directional === "boolean"
      ? data.directional
      : COMPONENTS[baseComponent].directional === true,
    direction: readOptionalPartDirection(data.direction) ?? getDefaultPartDirection(baseComponent),
    anchor: { x: resolvedAnchor.x, y: resolvedAnchor.y },
    cells: resolvedBoxes.map((cell) => ({
      x: cell.x,
      y: cell.y,
      structureOccupy: cell.occupiesStructureSpace,
      functionalOccupy: cell.occupiesFunctionalSpace,
      needStructureBehind: cell.needsStructureBehind,
      takeDamage: cell.takesDamage,
      attachPoint: cell.isAttachPoint,
      anchorPoint: cell.isAnchorPoint,
      firePoint: cell.isShootingPoint,
    })),
    boxes: resolvedBoxes,
    placement: {
      requireStructureOffsets: normalizeOffsets(placementRecord.requireStructureOffsets),
      requireStructureOnFunctionalOccupiedBoxes: placementRecord.requireStructureOnFunctionalOccupiedBoxes === false ? false : true,
      requireStructureOnStructureOccupiedBoxes: placementRecord.requireStructureOnStructureOccupiedBoxes === false ? false : true,
      requireEmptyStructureOffsets: normalizeOffsets(placementRecord.requireEmptyStructureOffsets),
      requireEmptyFunctionalOffsets: normalizeOffsets(placementRecord.requireEmptyFunctionalOffsets),
    },
    stats: {
      gasCost: readOptionalNumber(runtimeRecord.gasCost ?? partProperties.gasCost),
      mass: readOptionalNumber(runtimeRecord.mass ?? partProperties.mass),
      hpMul: readOptionalNumber(runtimeRecord.hpMul),
      power: readOptionalNumber(runtimeRecord.power ?? partProperties.power),
      maxSpeed: readOptionalNumber(runtimeRecord.maxSpeed ?? partProperties.maxSpeed),
      recoil: readOptionalNumber(runtimeRecord.recoil ?? partProperties.recoil),
      hitImpulse: readOptionalNumber(runtimeRecord.hitImpulse ?? partProperties.hitImpulse),
      damage: readOptionalNumber(runtimeRecord.damage ?? partProperties.damage),
      range: readOptionalNumber(runtimeRecord.range ?? partProperties.range),
      cooldown: readOptionalNumber(runtimeRecord.cooldown ?? partProperties.cooldown),
      projectileSpeed: readOptionalNumber(runtimeRecord.projectileSpeed ?? partProperties.projectileSpeed),
      projectileGravity: readOptionalNumber(runtimeRecord.projectileGravity ?? partProperties.projectileGravity),
      penetration: readOptionalNumber(runtimeRecord.penetration ?? partProperties.penetration),
      spreadDeg: readOptionalNumber(runtimeRecord.spreadDeg ?? partProperties.spreadAngleDeg),
      explosiveBlastRadius: readOptionalNumber(runtimeRecord.explosiveBlastRadius ?? runtimeExplosiveRecord.blastRadius ?? partProperties.explodeRadius ?? partProperties.explosionRadius),
      explosiveBlastDamage: readOptionalNumber(runtimeRecord.explosiveBlastDamage ?? runtimeExplosiveRecord.blastDamage ?? partProperties.explosionDamage),
      explosiveFalloffPower: readOptionalNumber(runtimeRecord.explosiveFalloffPower ?? runtimeExplosiveRecord.falloffPower),
      trackingTurnRateDegPerSec: readOptionalNumber(runtimeRecord.trackingTurnRateDegPerSec ?? runtimeTrackingRecord.turnRateDegPerSec ?? partProperties.trackingTurnRate),
      loaderSupports: Array.isArray(runtimeRecord.loaderSupports)
        ? runtimeRecord.loaderSupports
            .map((entry) => readOptionalWeaponClass(entry))
            .filter((entry): entry is "rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" => entry !== undefined)
        : Array.isArray(partProperties.supportedWeaponTags)
          ? partProperties.supportedWeaponTags
              .map((entry) => {
                if (entry === "missile") return "tracking";
                if (entry === "beam" || entry === "laser") return "beam-precision";
                if (entry === "explosive") return "explosive";
                if (entry === "cannon") return "heavy-shot";
                return "rapid-fire";
              })
              .filter((entry): entry is "rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" => entry !== undefined)
        : Array.isArray(runtimeLoaderRecord.supports)
          ? runtimeLoaderRecord.supports
              .map((entry) => readOptionalWeaponClass(entry))
              .filter((entry): entry is "rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" => entry !== undefined)
        : undefined,
      loaderLoadMultiplier: readOptionalNumber(runtimeRecord.loaderLoadMultiplier ?? runtimeLoaderRecord.loadMultiplier ?? partProperties.loadMultiplier),
      loaderFastOperation: readOptionalBoolean(runtimeRecord.loaderFastOperation ?? runtimeLoaderRecord.fastOperation),
      loaderMinLoadTime: readOptionalNumber(runtimeRecord.loaderMinLoadTime ?? runtimeLoaderRecord.minLoadTime ?? partProperties.minLoadTime),
      loaderMinBurstInterval: readOptionalNumber(runtimeRecord.loaderMinBurstInterval ?? runtimeLoaderRecord.minBurstInterval ?? partProperties.minBurstInterval),
    },
    partProperties: Object.values(partProperties).some((value) => value !== undefined)
      ? partProperties
      : undefined,
    properties: {
      category: readOptionalString(propertiesRecord.category ?? data.category),
      subcategory: readOptionalString(propertiesRecord.subcategory ?? data.subcategory),
      materialId: propertiesRecord.materialId === "basic"
        || propertiesRecord.materialId === "reinforced"
        || propertiesRecord.materialId === "ceramic"
        || propertiesRecord.materialId === "reactive"
        || propertiesRecord.materialId === "combined"
        ? propertiesRecord.materialId
        : data.materialId === "basic"
          || data.materialId === "reinforced"
          || data.materialId === "ceramic"
          || data.materialId === "reactive"
          || data.materialId === "combined"
          ? data.materialId
        : undefined,
      materialArmor: readOptionalNumber(propertiesRecord.materialArmor ?? propertiesRecord.material_armor ?? partProperties.armor),
      materialRecoverPerSecond: readOptionalNumber(
        propertiesRecord.materialRecoverPerSecond
          ?? propertiesRecord.material_recover_per_second
          ?? partProperties.recover,
      ),
      materialColor: readOptionalString(propertiesRecord.materialColor ?? propertiesRecord.material_color ?? partProperties.color),
      materialAlpha: readOptionalNumber(propertiesRecord.materialAlpha ?? propertiesRecord.material_alpha ?? partProperties.alpha),
      hp: readOptionalNumber(propertiesRecord.hp ?? data.hp ?? partProperties.hp),
      isEngine: readOptionalBoolean(propertiesRecord.isEngine ?? propertiesRecord.is_engine ?? data.isEngine ?? data.is_engine ?? (normalizedPartType === "engine")),
      isWeapon: readOptionalBoolean(propertiesRecord.isWeapon ?? propertiesRecord.is_weapon ?? data.isWeapon ?? data.is_weapon ?? (normalizedPartType === "weapon")),
      isLoader: readOptionalBoolean(propertiesRecord.isLoader ?? propertiesRecord.is_loader ?? data.isLoader ?? data.is_loader ?? (normalizedPartType === "loader")),
      isArmor: readOptionalBoolean(propertiesRecord.isArmor ?? propertiesRecord.is_armor ?? data.isArmor ?? data.is_armor ?? (normalizedPartType === "structure")),
      engineType: (propertiesRecord.engineType === "ground" || propertiesRecord.engineType === "air")
        ? propertiesRecord.engineType
        : (propertiesRecord.engine_type === "ground" || propertiesRecord.engine_type === "air")
          ? propertiesRecord.engine_type
          : (partProperties.powerAir === true ? "air" : (partProperties.powerGround === true ? "ground" : undefined)),
      loaderServesTags: normalizeStringList(
        propertiesRecord.loaderServesTags
          ?? propertiesRecord.loader_serves_tags
          ?? propertiesRecord.loaderSupports
          ?? propertiesRecord.loader_supports
          ?? partProperties.supportedWeaponTags,
      ),
      loaderCooldownMultiplier: readOptionalNumber(
        propertiesRecord.loaderCooldownMultiplier
          ?? propertiesRecord.loader_cooldown_multiplier
          ?? propertiesRecord.loaderLoadMultiplier
          ?? propertiesRecord.loader_load_multiplier
          ?? partProperties.loadMultiplier,
      ),
      hasCoreTuning: readOptionalBoolean(propertiesRecord.hasCoreTuning ?? propertiesRecord.has_core_tuning),
    },
    tags: Array.isArray(data.tags) ? data.tags.map((item) => String(item)).filter((item) => item.trim().length > 0) : undefined,
  };

  const placement = parsed.placement;
  if (placement && placement.requireStructureOffsets?.length === 0 && placement.requireStructureOnFunctionalOccupiedBoxes === true && placement.requireStructureOnStructureOccupiedBoxes === true && placement.requireEmptyStructureOffsets?.length === 0 && placement.requireEmptyFunctionalOffsets?.length === 0) {
    const legacy = fallback.placement;
    parsed.placement = legacy
      ? {
          requireStructureOffsets: (legacy.requireStructureOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
          requireStructureOnFunctionalOccupiedBoxes: legacy.requireStructureOnFunctionalOccupiedBoxes,
          requireStructureOnStructureOccupiedBoxes: legacy.requireStructureOnStructureOccupiedBoxes,
          requireEmptyStructureOffsets: (legacy.requireEmptyStructureOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
          requireEmptyFunctionalOffsets: (legacy.requireEmptyFunctionalOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
        }
      : undefined;
  }

  if (parsed.stats) {
    const overrideValues = Object.values(parsed.stats).filter((value) => value !== undefined);
    if (overrideValues.length <= 0) {
      parsed.stats = undefined;
    }
  }
  if (parsed.properties) {
    const propertyValues = Object.values(parsed.properties).filter((value) => value !== undefined);
    if (propertyValues.length <= 0) {
      parsed.properties = undefined;
    }
  }

  const validation = validatePartDefinitionDetailed(parsed);
  if (validation.errors.length > 0) {
    return null;
  }

  return parsed;
}

export function getPartFootprintOffsets(part: PartDefinition, rotateQuarterRaw: number): Array<{
  x: number;
  y: number;
  occupiesStructureSpace: boolean;
  occupiesFunctionalSpace: boolean;
  needsStructureBehind: boolean;
  isAttachPoint: boolean;
  isShootingPoint: boolean;
  takesDamage: boolean;
  takesFunctionalDamage: boolean;
}> {
  const rotateQuarter = normalizeRotateQuarter(rotateQuarterRaw);
  return getPartFootprintCells(part, rotateQuarter);
}

export function normalizePartAttachmentRotate(
  _part: PartDefinition,
  rotateQuarterRaw: number,
): 0 | 1 | 2 | 3 {
  return normalizeRotateQuarter(rotateQuarterRaw);
}
