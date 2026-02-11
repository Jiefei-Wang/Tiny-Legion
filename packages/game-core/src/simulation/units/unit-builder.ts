import { MATERIALS } from "../../config/balance/materials.ts";
import { COMPONENTS } from "../../config/balance/weapons.ts";
import { nextUid } from "../../core/ids/uid.ts";
import {
  createDefaultPartDefinitions,
  mergePartCatalogs,
  getPartFootprintOffsets,
  normalizePartAttachmentRotate,
  resolvePartDefinitionForAttachment,
} from "../../parts/part-schema.ts";
import { recalcMass } from "../physics/mass-cache.ts";
import { getControlUnit, validateSingleControlUnit } from "./control-unit-rules.ts";
import type { LoaderState, PartDefinition, Side, UnitInstance, UnitTemplate, WeaponClass } from "../../types.ts";

function resolveCatalog(partCatalog?: ReadonlyArray<PartDefinition>): PartDefinition[] {
  const defaults = createDefaultPartDefinitions();
  if (!partCatalog || partCatalog.length <= 0) {
    return defaults;
  }
  return mergePartCatalogs(defaults, partCatalog);
}

export function createInitialTemplates(): UnitTemplate[] {
  return [
    {
      id: "scout-ground",
      name: "Scout Buggy",
      type: "ground",
      gasCost: 22,
      gasCostOverride: 22,
      structure: [{ material: "basic" }, { material: "basic" }, { material: "basic" }],
      attachments: [
        { component: "control", cell: 1 },
        { component: "engineS", cell: 0 },
        { component: "rapidGun", cell: 2 },
      ],
    },
    {
      id: "tank-ground",
      name: "Line Tank",
      type: "ground",
      gasCost: 38,
      gasCostOverride: 38,
      structure: [
        { material: "basic" },
        { material: "basic" },
        { material: "basic" },
        { material: "basic" },
        { material: "basic" },
      ],
      attachments: [
        { component: "control", cell: 2 },
        { component: "engineM", cell: 1 },
        { component: "heavyCannon", cell: 3 },
        { component: "cannonLoader", cell: 2 },
        { component: "ammo", cell: 2 },
      ],
    },
    {
      id: "air-jet",
      name: "Skylance Jet",
      type: "air",
      gasCost: 48,
      gasCostOverride: 48,
      structure: [
        { material: "basic", x: -1, y: 0 },
        { material: "basic", x: 0, y: 0 },
        { material: "basic", x: 1, y: 0 },
        { material: "basic", x: 0, y: 1 },
      ],
      attachments: [
        { component: "control", cell: 1, x: 0, y: 0 },
        { component: "jetEngine", cell: 3, x: 0, y: 1 },
        { component: "trackingMissile", cell: 2, x: 1, y: 0, rotateQuarter: 0 },
        { component: "missileLoader", cell: 1 },
      ],
    },
    {
      id: "air-propeller",
      name: "Rotor Pike",
      type: "air",
      gasCost: 54,
      gasCostOverride: 54,
      structure: [
        { material: "basic", x: -1, y: 0 },
        { material: "basic", x: 0, y: 0 },
        { material: "basic", x: 1, y: 0 },
        { material: "basic", x: -1, y: 1 },
        { material: "basic", x: 0, y: 1 },
        { material: "basic", x: 1, y: 1 },
      ],
      attachments: [
        { component: "control", cell: 4, x: 0, y: 1 },
        { component: "propeller", cell: 1, x: 0, y: 0, rotateQuarter: 3 },
        { component: "trackingMissile", cell: 2, x: 1, y: 0, rotateQuarter: 0 },
        { component: "missileLoader", cell: 4, x: 0, y: 1 },
      ],
    },
  ];
}

export function instantiateUnit(
  templates: UnitTemplate[],
  templateId: string,
  side: Side,
  x: number,
  y: number,
  options: { deploymentGasCost?: number; partCatalog?: ReadonlyArray<PartDefinition> } = {},
): UnitInstance | null {
  const template = templates.find((entry) => entry.id === templateId);
  if (!template) {
    return null;
  }

  const structure = template.structure.map((cell, index) => {
    const material = MATERIALS[cell.material];
    return {
      id: index,
      material: cell.material,
      x: cell.x ?? index,
      y: cell.y ?? 0,
      strain: 0,
      breakThreshold: material.hp,
      recoverPerSecond: material.recoverPerSecond,
      destroyed: false,
    };
  });

  const partCatalog = resolveCatalog(options.partCatalog);
  const attachments = template.attachments.map((attachment, index) => {
    const part = resolvePartDefinitionForAttachment(
      { partId: attachment.partId, component: attachment.component },
      partCatalog,
    );
    const component = part?.baseComponent ?? attachment.component;
    const host = structure[attachment.cell];
    const rotateQuarterRaw = typeof attachment.rotateQuarter === "number"
      ? attachment.rotateQuarter
      : (attachment.rotate90 ? 1 : 0);
    const rotateQuarter = normalizePartAttachmentRotate(
      part ?? {
        id: component,
        name: component,
        layer: "functional",
        baseComponent: component,
        anchor: { x: 0, y: 0 },
        boxes: [{ x: 0, y: 0 }],
        directional: COMPONENTS[component].directional === true,
      },
      rotateQuarterRaw,
    );
    const anchorX = attachment.x ?? host?.x ?? attachment.cell;
    const anchorY = attachment.y ?? host?.y ?? 0;
    const hpMulFromAbsoluteHp = ((): number | undefined => {
      if (!part?.properties?.hp || !host) {
        return undefined;
      }
      return Math.max(0.05, part.properties.hp / Math.max(1, host.breakThreshold));
    })();
    const partOffsets = part
      ? getPartFootprintOffsets(part, rotateQuarter)
      : null;
    const occupiedOffsets = partOffsets
      ? partOffsets.map((offset) => ({
          x: offset.x,
          y: offset.y,
          occupiesStructureSpace: offset.occupiesStructureSpace,
          occupiesFunctionalSpace: offset.occupiesFunctionalSpace,
          needsStructureBehind: offset.needsStructureBehind,
          isAttachPoint: offset.isAttachPoint,
          isShootingPoint: offset.isShootingPoint,
          takesDamage: offset.takesDamage,
          takesFunctionalDamage: offset.takesFunctionalDamage,
        }))
      : [{
          x: 0,
          y: 0,
          occupiesStructureSpace: false,
          occupiesFunctionalSpace: true,
          needsStructureBehind: true,
          isAttachPoint: false,
          isShootingPoint: COMPONENTS[component].type === "weapon",
          takesDamage: true,
          takesFunctionalDamage: true,
        }];
    const shootingOffset = partOffsets?.find((offset) => offset.isShootingPoint);
    return {
      id: index,
      component,
      partId: part?.id,
      cell: attachment.cell,
      x: anchorX,
      y: anchorY,
      rotateQuarter,
      alive: true,
      occupiedOffsets,
      shootingOffset: shootingOffset ? { x: shootingOffset.x, y: shootingOffset.y } : undefined,
      stats: part?.stats
        ? {
            mass: part.stats.mass,
            hpMul: part.stats.hpMul ?? hpMulFromAbsoluteHp,
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
        : hpMulFromAbsoluteHp !== undefined
          ? { hpMul: hpMulFromAbsoluteHp }
          : undefined,
    };
  });

  if (!validateSingleControlUnit(attachments)) {
    return null;
  }

  const control = getControlUnit(attachments);
  if (!control) {
    return null;
  }
  if (template.type === "air") {
    const hasAirPropulsion = attachments.some((attachment) => {
      const stats = COMPONENTS[attachment.component];
      return stats.type === "engine" && stats.propulsion?.platform === "air";
    });
    if (!hasAirPropulsion) {
      return null;
    }
  }

  const weaponAttachmentIds = attachments
    .filter((attachment) => COMPONENTS[attachment.component].type === "weapon")
    .map((attachment) => attachment.id);
  const loaderStates: LoaderState[] = attachments
    .filter((attachment) => COMPONENTS[attachment.component].type === "loader")
    .map((attachment) => ({
      attachmentId: attachment.id,
      targetWeaponSlot: null,
      remaining: 0,
    }));
  const normalizeLoaderSupports = (values: ReadonlyArray<string> | undefined): WeaponClass[] => {
    if (!values || values.length <= 0) {
      return [];
    }
    const supports: WeaponClass[] = [];
    for (const value of values) {
      if (
        value === "rapid-fire"
        || value === "heavy-shot"
        || value === "explosive"
        || value === "tracking"
        || value === "beam-precision"
        || value === "control-utility"
      ) {
        supports.push(value);
      }
    }
    return supports;
  };
  const getLoaderSupports = (attachment: UnitInstance["attachments"][number]): WeaponClass[] => {
    if (attachment.stats?.loaderSupports && attachment.stats.loaderSupports.length > 0) {
      return attachment.stats.loaderSupports;
    }
    if (attachment.partId) {
      const part = partCatalog.find((entry) => entry.id === attachment.partId);
      const legacy = normalizeLoaderSupports(part?.properties?.loaderServesTags);
      if (legacy.length > 0) {
        return legacy;
      }
    }
    const base = COMPONENTS[attachment.component];
    if (base.type !== "loader") {
      return [];
    }
    return [...(base.loader?.supports ?? [])];
  };

  const unit: UnitInstance = {
    id: nextUid(`${side}-${template.type}`),
    templateId: template.id,
    side,
    type: template.type,
    name: template.name,
    facing: side === "player" ? 1 : -1,
    x,
    y,
    vx: 0,
    vy: 0,
    accel: template.type === "ground" ? 105 : 120,
    maxSpeed: template.type === "ground" ? 100 : 135,
    turnDrag: template.type === "ground" ? 0.9 : 0.93,
    radius: (() => {
      const xs = structure.map((cell) => cell.x);
      const ys = structure.map((cell) => cell.y);
      const spanX = (Math.max(...xs) - Math.min(...xs) + 1);
      const spanY = (Math.max(...ys) - Math.min(...ys) + 1);
      return 16 + Math.max(spanX, spanY) * 3.8;
    })(),
    structure,
    attachments,
    controlAttachmentId: control.id,
    weaponAttachmentIds,
    selectedWeaponIndex: 0,
    weaponManualControl: weaponAttachmentIds.map(() => true),
    weaponAutoFire: weaponAttachmentIds.map(() => true),
    weaponFireTimers: weaponAttachmentIds.map(() => 0),
    weaponReadyCharges: weaponAttachmentIds.map((_, slot) => {
      const weaponAttachmentId = weaponAttachmentIds[slot];
      const weaponAttachment = attachments.find((entry) => entry.id === weaponAttachmentId);
      if (!weaponAttachment) {
        return 0;
      }
      const weaponStats = COMPONENTS[weaponAttachment.component];
      if (weaponStats.type !== "weapon") {
        return 0;
      }
      const requiresLoader = weaponStats.weaponClass === "heavy-shot" || weaponStats.weaponClass === "explosive" || weaponStats.weaponClass === "tracking";
      if (!requiresLoader) {
        return 1;
      }
      const hasCompatibleLoader = loaderStates.some((loaderState) => {
        const loaderAttachment = attachments.find((entry) => entry.id === loaderState.attachmentId && entry.alive);
        if (!loaderAttachment) {
          return false;
        }
        const loaderStats = COMPONENTS[loaderAttachment.component];
        const supports = getLoaderSupports(loaderAttachment);
        return loaderStats.type === "loader" && supports.includes(weaponStats.weaponClass ?? "rapid-fire");
      });
      return hasCompatibleLoader ? 1 : 0;
    }),
    weaponLoadTimers: weaponAttachmentIds.map(() => 0),
    loaderStates,
    deploymentGasCost: options.deploymentGasCost ?? template.gasCost,
    returnedToBase: false,
    aiTimer: 0,
    aiAimCorrectionY: 0,
    aiState: "engage",
    aiStateTimer: 0,
    aiDodgeCooldown: 0,
    aiLastThreatDirX: 0,
    aiLastThreatDirY: 0,
    aiDebugTargetId: null,
    aiDebugShouldEvade: false,
    aiDebugLastAngleRad: 0,
    aiDebugLastRange: 0,
    aiDebugDecisionPath: "",
    aiDebugFireBlockReason: null,
    aiDebugPreferredWeaponSlot: -1,
    aiDebugLeadTimeS: 0,
    aiWeaponCycleIndex: 0,
    controlImpairTimer: 0,
    controlImpairFactor: 1,
    airDropActive: false,
    airDropTargetY: y,
    alive: true,
    vibrate: 0,
    mass: 0,
  };

  recalcMass(unit);
  return unit;
}
