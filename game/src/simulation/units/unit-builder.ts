import { MATERIALS } from "../../config/balance/materials.ts";
import { COMPONENTS } from "../../config/balance/weapons.ts";
import { nextUid } from "../../core/ids/uid.ts";
import { recalcMass } from "../physics/mass-cache.ts";
import { getControlUnit, validateSingleControlUnit } from "./control-unit-rules.ts";
import type { LoaderState, Side, UnitInstance, UnitTemplate } from "../../types.ts";

export function createInitialTemplates(): UnitTemplate[] {
  return [
    {
      id: "scout-ground",
      name: "Scout Buggy",
      type: "ground",
      gasCost: 22,
      structure: [{ material: "basic" }, { material: "basic" }, { material: "basic" }],
      attachments: [
        { component: "control", cell: 1 },
        { component: "engineS", cell: 0 },
        { component: "rapidGun", cell: 2 },
        { component: "fuel", cell: 0 },
      ],
    },
    {
      id: "tank-ground",
      name: "Line Tank",
      type: "ground",
      gasCost: 38,
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
      id: "air-light",
      name: "Skylance",
      type: "air",
      gasCost: 44,
      structure: [{ material: "basic" }, { material: "basic" }, { material: "basic" }, { material: "basic" }],
      attachments: [
        { component: "control", cell: 1 },
        { component: "engineS", cell: 0 },
        { component: "trackingMissile", cell: 2 },
        { component: "missileLoader", cell: 1 },
        { component: "fuel", cell: 3 },
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
  options: { deploymentGasCost?: number } = {},
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

  const attachments = template.attachments.map((attachment, index) => {
    const host = structure[attachment.cell];
    return {
      id: index,
      component: attachment.component,
      cell: attachment.cell,
      x: attachment.x ?? host?.x ?? attachment.cell,
      y: attachment.y ?? host?.y ?? 0,
      rotateQuarter: typeof attachment.rotateQuarter === "number"
        ? ((attachment.rotateQuarter % 4 + 4) % 4)
        : (attachment.rotate90 ? 1 : 0),
      alive: true,
    };
  });

  if (!validateSingleControlUnit(attachments)) {
    return null;
  }

  const control = getControlUnit(attachments);
  if (!control) {
    return null;
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
        return loaderStats.type === "loader" && (loaderStats.loader?.supports ?? []).includes(weaponStats.weaponClass ?? "rapid-fire");
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
