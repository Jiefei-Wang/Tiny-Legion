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
      id: 1,
      name: "Scout Buggy",
      type: "ground",
      gasCost: 22,
      structure: [{ partId: 11 }, { partId: 11 }, { partId: 11 }],
      attachments: [
        { component: "control", cell: 1 },
        { component: "engineS", cell: 0 },
        { component: "rapidGun", cell: 2 },
      ],
    },
    {
      id: 2,
      name: "Line Tank",
      type: "ground",
      gasCost: 38,
      structure: [
        { partId: 11 },
        { partId: 11 },
        { partId: 11 },
        { partId: 11 },
        { partId: 11 },
      ],
      attachments: [
        { component: "control", cell: 2 },
        { component: "engineM", cell: 1 },
        { component: "heavyCannon", cell: 3 },
        { component: "cannonLoader", cell: 2 },
      ],
    },
    {
      id: 3,
      name: "Skylance Jet",
      type: "air",
      gasCost: 48,
      structure: [
        { partId: 11, x: -1, y: 0 },
        { partId: 11, x: 0, y: 0 },
        { partId: 11, x: 1, y: 0 },
        { partId: 11, x: 0, y: 1 },
      ],
      attachments: [
        { component: "control", cell: 1, x: 0, y: 0 },
        { component: "jetEngine", cell: 3, x: 0, y: 1 },
        { component: "trackingMissile", cell: 2, x: 1, y: 0, rotateQuarter: 0 },
        { component: "missileLoader", cell: 1 },
      ],
    },
    {
      id: 4,
      name: "Rotor Pike",
      type: "air",
      gasCost: 54,
      structure: [
        { partId: 11, x: -1, y: 0 },
        { partId: 11, x: 0, y: 0 },
        { partId: 11, x: 1, y: 0 },
        { partId: 11, x: -1, y: 1 },
        { partId: 11, x: 0, y: 1 },
        { partId: 11, x: 1, y: 1 },
      ],
      attachments: [
        { component: "control", cell: 4, x: 0, y: 1 },
        { component: "jetEngine", cell: 1, x: 0, y: 0, rotateQuarter: 0 },
        { component: "trackingMissile", cell: 2, x: 1, y: 0, rotateQuarter: 0 },
        { component: "missileLoader", cell: 4, x: 0, y: 1 },
      ],
    },
  ];
}

export function instantiateUnit(
  templates: UnitTemplate[],
  templateId: number,
  side: Side,
  x: number,
  y: number,
  options: { deploymentGasCost?: number; partCatalog?: ReadonlyArray<PartDefinition> } = {},
): UnitInstance | null {
  const template = templates.find((entry) => entry.id === templateId);
  if (!template) {
    return null;
  }

  const partCatalog = resolveCatalog(options.partCatalog);
  const structure = template.structure.map((cell, index) => {
    const part = resolvePartDefinitionForAttachment({ partId: cell.partId }, partCatalog);
    if (!part || part.layer !== "structure") {
      return null;
    }
    const breakThreshold = Math.max(1, part.properties?.hp ?? 100);
    const recoverPerSecond = Math.max(0, part.properties?.materialRecoverPerSecond ?? 0);
    const armor = Math.max(0, part.properties?.materialArmor ?? 0);
    const mass = Math.max(0, part.stats?.mass ?? 0);
    const defaultColor = (typeof part.properties?.materialColor === "string" && /^#[0-9a-fA-F]{6}$/.test(part.properties.materialColor))
      ? part.properties.materialColor
      : "#95a4b8";
    const color = typeof cell.color === "string" && /^#[0-9a-fA-F]{6}$/.test(cell.color)
      ? cell.color
      : defaultColor;
    const alpha = Math.max(0, Math.min(1, part.properties?.materialAlpha ?? part.partProperties?.alpha ?? 1));
    return {
      id: index,
      partId: cell.partId,
      x: cell.x ?? index,
      y: cell.y ?? 0,
      armor,
      mass,
      color,
      alpha,
      strain: 0,
      breakThreshold,
      recoverPerSecond,
      destroyed: false,
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (structure.length !== template.structure.length) {
    return null;
  }

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
        id: -1,
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
    const attachedStructureCellIds = Array.from(new Set([
      ...(host ? [host.id] : []),
      ...occupiedOffsets.flatMap((offset) => structure
        .filter((cell) => cell.x === anchorX + offset.x && cell.y === anchorY + offset.y)
        .map((cell) => cell.id)),
    ]));
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
      attachedStructureCellIds,
      occupiedOffsets,
      shootingOffset: shootingOffset ? { x: shootingOffset.x, y: shootingOffset.y } : undefined,
      stats: part?.stats
        ? {
            mass: part.stats.mass,
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
      if (stats.type !== "engine") {
        return false;
      }
      const part = attachment.partId ? partCatalog.find((entry) => entry.id === attachment.partId) : null;
      if (part?.partType === "engine" && part.partProperties?.powerAir !== undefined) {
        return part.partProperties.powerAir === true;
      }
      if (part?.properties?.engineType) {
        return part.properties.engineType === "air";
      }
      return stats.propulsion?.platform === "air";
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
    weaponAimAngles: weaponAttachmentIds.map(() => side === "player" ? 0 : Math.PI),
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
    escapeActive: false,
    escapeFacingDelayS: 0,
    targetHistory: [{ x, y }],
    targetHistorySampleTimerS: 0,
    aiTimer: 0,
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
