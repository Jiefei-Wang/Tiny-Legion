import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import { normalizeRotateQuarter, getPartFootprintCells } from "./part-geometry.ts";
import { validatePartDefinitionDetailed } from "./part-validation.ts";
import type { ComponentId, MaterialId, PartDefinition } from "../types.ts";

export { normalizeRotateQuarter, rotateOffsetByQuarter, getPartFootprintCells } from "./part-geometry.ts";
export { validatePartDefinitionDetailed, validatePartDefinition } from "./part-validation.ts";

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

function readOptionalWeaponClass(value: unknown): "rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" | "control-utility" | undefined {
  if (value === "rapid-fire" || value === "heavy-shot" || value === "explosive" || value === "tracking" || value === "beam-precision" || value === "control-utility") {
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

function normalizePartId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "part";
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
    id: `${component}-structure`,
    name: `${component}-structure`,
    layer: "structure",
    baseComponent: component,
    directional: stats.directional === true,
    anchor: { x: 0, y: 0 },
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
      requireStructureBelowAnchor: false,
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
    id: `material-${materialId}`,
    name: material.label,
    layer: "structure",
    baseComponent: "control",
    directional: false,
    anchor: { x: 0, y: 0 },
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
      requireStructureBelowAnchor: false,
      requireStructureOnFunctionalOccupiedBoxes: false,
      requireStructureOnStructureOccupiedBoxes: false,
      requireEmptyStructureOffsets: [],
      requireEmptyFunctionalOffsets: [],
    },
    stats: {
      mass: material.mass,
    },
    properties: {
      category: "structure",
      subcategory: "material",
      materialId,
      materialArmor: material.armor,
      materialRecoverPerSecond: material.recoverPerSecond,
      materialColor: material.color,
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
  return {
    id: component,
    name: component,
    layer: "functional",
    baseComponent: component,
    directional: stats.directional === true,
    anchor: { x: 0, y: 0 },
    boxes,
    placement: {
      requireStructureOffsets: stats.placement?.requireStructureBelowAnchor ? [{ x: 0, y: 1 }] : [],
      requireStructureBelowAnchor: stats.placement?.requireStructureBelowAnchor ?? false,
      requireStructureOnFunctionalOccupiedBoxes: requireStructureOnFunctional,
      requireStructureOnStructureOccupiedBoxes: true,
      requireEmptyStructureOffsets: (stats.placement?.requireEmptyOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
      requireEmptyFunctionalOffsets: [],
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
    tags: ["implicit"],
  };
}

let defaultCatalogCache: PartDefinition[] | null = null;

export function createDefaultPartDefinitions(): PartDefinition[] {
  if (defaultCatalogCache) {
    return defaultCatalogCache.map((part) => clonePartDefinition(part));
  }
  const componentParts = Object.keys(COMPONENTS)
    .map((id) => createImplicitPartDefinition(id as ComponentId))
    .sort((a, b) => a.id.localeCompare(b.id));
  const materialParts = (Object.keys(MATERIALS) as MaterialId[])
    .map((id) => createImplicitStructureMaterialPartDefinition(id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const parts = [...componentParts, ...materialParts].sort((a, b) => a.id.localeCompare(b.id));
  defaultCatalogCache = parts;
  return parts.map((part) => clonePartDefinition(part));
}

export function buildPartCatalogMap(parts: ReadonlyArray<PartDefinition>): Map<string, PartDefinition> {
  const map = new Map<string, PartDefinition>();
  for (const part of parts) {
    map.set(part.id, part);
  }
  return map;
}

export function mergePartCatalogs(baseParts: ReadonlyArray<PartDefinition>, incomingParts: ReadonlyArray<PartDefinition>): PartDefinition[] {
  const map = new Map<string, PartDefinition>();
  for (const part of baseParts) {
    map.set(part.id, clonePartDefinition(part));
  }
  for (const part of incomingParts) {
    map.set(part.id, clonePartDefinition(part));
  }
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function resolvePartDefinitionForAttachment(
  attachment: { partId?: string; component?: ComponentId },
  partCatalog?: ReadonlyArray<PartDefinition>,
): PartDefinition | null {
  const defaults = createDefaultPartDefinitions();
  const catalog = partCatalog && partCatalog.length > 0 ? mergePartCatalogs(defaults, partCatalog) : defaults;
  const catalogMap = buildPartCatalogMap(catalog);

  if (attachment.partId && catalogMap.has(attachment.partId)) {
    return clonePartDefinition(catalogMap.get(attachment.partId) as PartDefinition);
  }
  if (attachment.component && catalogMap.has(attachment.component)) {
    return clonePartDefinition(catalogMap.get(attachment.component) as PartDefinition);
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
    baseComponent: part.baseComponent,
    directional: part.directional,
    anchor: { x: part.anchor.x, y: part.anchor.y },
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
          requireStructureBelowAnchor: part.placement.requireStructureBelowAnchor,
          requireStructureOnFunctionalOccupiedBoxes: part.placement.requireStructureOnFunctionalOccupiedBoxes,
          requireStructureOnStructureOccupiedBoxes: part.placement.requireStructureOnStructureOccupiedBoxes,
          requireEmptyStructureOffsets: (part.placement.requireEmptyStructureOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
          requireEmptyFunctionalOffsets: (part.placement.requireEmptyFunctionalOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
        }
      : undefined,
    stats: part.stats
      ? {
          mass: part.stats.mass,
          hpMul: part.stats.hpMul,
          power: part.stats.power,
          maxSpeed: part.stats.maxSpeed,
          recoil: part.stats.recoil,
          hitImpulse: part.stats.hitImpulse,
          damage: part.stats.damage,
          range: part.stats.range,
          cooldown: part.stats.cooldown,
          shootAngleDeg: part.stats.shootAngleDeg,
          projectileSpeed: part.stats.projectileSpeed,
          projectileGravity: part.stats.projectileGravity,
          spreadDeg: part.stats.spreadDeg,
          explosiveDeliveryMode: part.stats.explosiveDeliveryMode,
          explosiveBlastRadius: part.stats.explosiveBlastRadius,
          explosiveBlastDamage: part.stats.explosiveBlastDamage,
          explosiveFalloffPower: part.stats.explosiveFalloffPower,
          explosiveFuse: part.stats.explosiveFuse,
          explosiveFuseTime: part.stats.explosiveFuseTime,
          trackingTurnRateDegPerSec: part.stats.trackingTurnRateDegPerSec,
          controlImpairFactor: part.stats.controlImpairFactor,
          controlDuration: part.stats.controlDuration,
          loaderSupports: part.stats.loaderSupports ? [...part.stats.loaderSupports] : undefined,
          loaderLoadMultiplier: part.stats.loaderLoadMultiplier,
          loaderFastOperation: part.stats.loaderFastOperation,
          loaderMinLoadTime: part.stats.loaderMinLoadTime,
          loaderStoreCapacity: part.stats.loaderStoreCapacity,
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
  const baseComponent = isComponentId(data.baseComponent)
    ? data.baseComponent
    : isComponentId(data.component)
      ? data.component
      : null;
  if (!baseComponent) {
    return null;
  }

  const idRaw = typeof data.id === "string" ? data.id : String(data.id ?? "");
  const id = normalizePartId(idRaw || baseComponent);
  const name = typeof data.name === "string" && data.name.trim().length > 0 ? data.name.trim() : id;
  const layer = data.layer === "structure" ? "structure" : "functional";

  const anchorRecord = data.anchor && typeof data.anchor === "object" ? (data.anchor as Record<string, unknown>) : {};
  const requestedAnchorX = readOptionalInt(anchorRecord.x) ?? 0;
  const requestedAnchorY = readOptionalInt(anchorRecord.y) ?? 0;

  const boxesRaw = Array.isArray(data.boxes) ? data.boxes : [];
  const defaultOccupiesStructureSpace = layer === "structure";
  const defaultOccupiesFunctionalSpace = layer !== "structure";
  let anchorFromBox: { x: number; y: number } | null = null;
  const boxes = boxesRaw
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
        isShootingPoint: record.isShootingPoint === true || record.shootingPoint === true,
        takesDamage: typeof record.takesDamage === "boolean" ? record.takesDamage : undefined,
        takesFunctionalDamage: typeof record.takesFunctionalDamage === "boolean" ? record.takesFunctionalDamage : undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

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
  const runtimeControlRecord = runtimeRecord.control && typeof runtimeRecord.control === "object"
    ? (runtimeRecord.control as Record<string, unknown>)
    : {};
  const runtimeLoaderRecord = runtimeRecord.loader && typeof runtimeRecord.loader === "object"
    ? (runtimeRecord.loader as Record<string, unknown>)
    : {};
  const propertiesRecord = data.properties && typeof data.properties === "object"
    ? (data.properties as Record<string, unknown>)
    : {};

  const parsed: PartDefinition = {
    id,
    name,
    layer,
    baseComponent,
    directional: typeof data.directional === "boolean" ? data.directional : COMPONENTS[baseComponent].directional === true,
    anchor: { x: resolvedAnchor.x, y: resolvedAnchor.y },
    boxes: resolvedBoxes,
    placement: {
      requireStructureOffsets: normalizeOffsets(placementRecord.requireStructureOffsets),
      requireStructureBelowAnchor: placementRecord.requireStructureBelowAnchor === true,
      requireStructureOnFunctionalOccupiedBoxes: placementRecord.requireStructureOnFunctionalOccupiedBoxes === false ? false : true,
      requireStructureOnStructureOccupiedBoxes: placementRecord.requireStructureOnStructureOccupiedBoxes === false ? false : true,
      requireEmptyStructureOffsets: normalizeOffsets(placementRecord.requireEmptyStructureOffsets),
      requireEmptyFunctionalOffsets: normalizeOffsets(placementRecord.requireEmptyFunctionalOffsets),
    },
    stats: {
      mass: readOptionalNumber(runtimeRecord.mass),
      hpMul: readOptionalNumber(runtimeRecord.hpMul),
      power: readOptionalNumber(runtimeRecord.power),
      maxSpeed: readOptionalNumber(runtimeRecord.maxSpeed),
      recoil: readOptionalNumber(runtimeRecord.recoil),
      hitImpulse: readOptionalNumber(runtimeRecord.hitImpulse),
      damage: readOptionalNumber(runtimeRecord.damage),
      range: readOptionalNumber(runtimeRecord.range),
      cooldown: readOptionalNumber(runtimeRecord.cooldown),
      shootAngleDeg: readOptionalNumber(runtimeRecord.shootAngleDeg),
      projectileSpeed: readOptionalNumber(runtimeRecord.projectileSpeed),
      projectileGravity: readOptionalNumber(runtimeRecord.projectileGravity),
      spreadDeg: readOptionalNumber(runtimeRecord.spreadDeg),
      explosiveDeliveryMode: runtimeRecord.explosiveDeliveryMode === "shell" || runtimeRecord.explosiveDeliveryMode === "bomb"
        ? runtimeRecord.explosiveDeliveryMode
        : runtimeExplosiveRecord.deliveryMode === "shell" || runtimeExplosiveRecord.deliveryMode === "bomb"
          ? runtimeExplosiveRecord.deliveryMode
        : undefined,
      explosiveBlastRadius: readOptionalNumber(runtimeRecord.explosiveBlastRadius ?? runtimeExplosiveRecord.blastRadius),
      explosiveBlastDamage: readOptionalNumber(runtimeRecord.explosiveBlastDamage ?? runtimeExplosiveRecord.blastDamage),
      explosiveFalloffPower: readOptionalNumber(runtimeRecord.explosiveFalloffPower ?? runtimeExplosiveRecord.falloffPower),
      explosiveFuse: runtimeRecord.explosiveFuse === "impact" || runtimeRecord.explosiveFuse === "timed"
        ? runtimeRecord.explosiveFuse
        : runtimeExplosiveRecord.fuse === "impact" || runtimeExplosiveRecord.fuse === "timed"
          ? runtimeExplosiveRecord.fuse
        : undefined,
      explosiveFuseTime: readOptionalNumber(runtimeRecord.explosiveFuseTime ?? runtimeExplosiveRecord.fuseTime),
      trackingTurnRateDegPerSec: readOptionalNumber(runtimeRecord.trackingTurnRateDegPerSec ?? runtimeTrackingRecord.turnRateDegPerSec),
      controlImpairFactor: readOptionalNumber(runtimeRecord.controlImpairFactor ?? runtimeControlRecord.impairFactor),
      controlDuration: readOptionalNumber(runtimeRecord.controlDuration ?? runtimeControlRecord.duration),
      loaderSupports: Array.isArray(runtimeRecord.loaderSupports)
        ? runtimeRecord.loaderSupports
            .map((entry) => readOptionalWeaponClass(entry))
            .filter((entry): entry is "rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" | "control-utility" => entry !== undefined)
        : Array.isArray(runtimeLoaderRecord.supports)
          ? runtimeLoaderRecord.supports
              .map((entry) => readOptionalWeaponClass(entry))
              .filter((entry): entry is "rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" | "control-utility" => entry !== undefined)
        : undefined,
      loaderLoadMultiplier: readOptionalNumber(runtimeRecord.loaderLoadMultiplier ?? runtimeLoaderRecord.loadMultiplier),
      loaderFastOperation: readOptionalBoolean(runtimeRecord.loaderFastOperation ?? runtimeLoaderRecord.fastOperation),
      loaderMinLoadTime: readOptionalNumber(runtimeRecord.loaderMinLoadTime ?? runtimeLoaderRecord.minLoadTime),
      loaderStoreCapacity: readOptionalNumber(runtimeRecord.loaderStoreCapacity ?? runtimeLoaderRecord.storeCapacity),
      loaderMinBurstInterval: readOptionalNumber(runtimeRecord.loaderMinBurstInterval ?? runtimeLoaderRecord.minBurstInterval),
    },
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
      materialArmor: readOptionalNumber(propertiesRecord.materialArmor ?? propertiesRecord.material_armor),
      materialRecoverPerSecond: readOptionalNumber(
        propertiesRecord.materialRecoverPerSecond
          ?? propertiesRecord.material_recover_per_second,
      ),
      materialColor: readOptionalString(propertiesRecord.materialColor ?? propertiesRecord.material_color),
      hp: readOptionalNumber(propertiesRecord.hp ?? data.hp),
      isEngine: readOptionalBoolean(propertiesRecord.isEngine ?? propertiesRecord.is_engine ?? data.isEngine ?? data.is_engine),
      isWeapon: readOptionalBoolean(propertiesRecord.isWeapon ?? propertiesRecord.is_weapon ?? data.isWeapon ?? data.is_weapon),
      isLoader: readOptionalBoolean(propertiesRecord.isLoader ?? propertiesRecord.is_loader ?? data.isLoader ?? data.is_loader),
      isArmor: readOptionalBoolean(propertiesRecord.isArmor ?? propertiesRecord.is_armor ?? data.isArmor ?? data.is_armor),
      engineType: (propertiesRecord.engineType === "ground" || propertiesRecord.engineType === "air")
        ? propertiesRecord.engineType
        : (propertiesRecord.engine_type === "ground" || propertiesRecord.engine_type === "air")
          ? propertiesRecord.engine_type
          : undefined,
      weaponType: readOptionalWeaponClass(propertiesRecord.weaponType ?? propertiesRecord.weapon_type),
      loaderServesTags: normalizeStringList(
        propertiesRecord.loaderServesTags
          ?? propertiesRecord.loader_serves_tags
          ?? propertiesRecord.loaderSupports
          ?? propertiesRecord.loader_supports,
      ),
      loaderCooldownMultiplier: readOptionalNumber(
        propertiesRecord.loaderCooldownMultiplier
          ?? propertiesRecord.loader_cooldown_multiplier
          ?? propertiesRecord.loaderLoadMultiplier
          ?? propertiesRecord.loader_load_multiplier,
      ),
      hasCoreTuning: readOptionalBoolean(propertiesRecord.hasCoreTuning ?? propertiesRecord.has_core_tuning),
    },
    tags: Array.isArray(data.tags) ? data.tags.map((item) => String(item)).filter((item) => item.trim().length > 0) : undefined,
  };

  const placement = parsed.placement;
  if (placement && placement.requireStructureOffsets?.length === 0 && !placement.requireStructureBelowAnchor && placement.requireStructureOnFunctionalOccupiedBoxes === true && placement.requireStructureOnStructureOccupiedBoxes === true && placement.requireEmptyStructureOffsets?.length === 0 && placement.requireEmptyFunctionalOffsets?.length === 0) {
    const legacy = fallback.placement;
    parsed.placement = legacy
      ? {
          requireStructureOffsets: (legacy.requireStructureOffsets ?? []).map((offset) => ({ x: offset.x, y: offset.y })),
          requireStructureBelowAnchor: legacy.requireStructureBelowAnchor,
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
  part: PartDefinition,
  rotateQuarterRaw: number,
): 0 | 1 | 2 | 3 {
  const rotateQuarter = normalizeRotateQuarter(rotateQuarterRaw);
  if (!part.directional) {
    return 0;
  }
  return rotateQuarter;
}
