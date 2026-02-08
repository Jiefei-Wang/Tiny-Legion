import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import type { ComponentId, DisplayAttachmentTemplate, MaterialId, UnitTemplate, UnitType } from "../types.ts";

const AIR_HOLD_GRAVITY = 110;
const AIR_THRUST_ACCEL_SCALE = 70;

export type TemplateValidationResult = {
  errors: string[];
  warnings: string[];
};

function isUnitType(value: unknown): value is UnitType {
  return value === "ground" || value === "air";
}

function isMaterialId(value: unknown): value is MaterialId {
  return typeof value === "string" && value in MATERIALS;
}

function isComponentId(value: unknown): value is ComponentId {
  return typeof value === "string" && value in COMPONENTS;
}

function isDisplayKind(value: unknown): value is DisplayAttachmentTemplate["kind"] {
  return value === "panel" || value === "stripe" || value === "glass";
}

function rotateOffsetByQuarter(offsetX: number, offsetY: number, rotateQuarter: number): { x: number; y: number } {
  const q = ((rotateQuarter % 4) + 4) % 4;
  if (q === 0) {
    return { x: offsetX, y: offsetY };
  }
  if (q === 1) {
    return { x: -offsetY, y: offsetX };
  }
  if (q === 2) {
    return { x: -offsetX, y: -offsetY };
  }
  return { x: offsetY, y: -offsetX };
}

function getPropellerDirection(rotateQuarter: number): { x: number; y: number } {
  const q = ((rotateQuarter % 4) + 4) % 4;
  if (q === 0) {
    return { x: 1, y: 0 };
  }
  if (q === 1) {
    return { x: 0, y: 1 };
  }
  if (q === 2) {
    return { x: -1, y: 0 };
  }
  return { x: 0, y: -1 };
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function computeAirLiftAccel(template: UnitTemplate): number {
  let mass = 0;
  for (const cell of template.structure) {
    if (!isMaterialId(cell.material)) {
      continue;
    }
    mass += MATERIALS[cell.material].mass;
  }
  for (const attachment of template.attachments) {
    if (!isComponentId(attachment.component)) {
      continue;
    }
    mass += COMPONENTS[attachment.component].mass;
  }
  mass = Math.max(16, mass);

  let liftAccel = 0;
  for (const attachment of template.attachments) {
    if (!isComponentId(attachment.component)) {
      continue;
    }
    const stats = COMPONENTS[attachment.component];
    if (stats.type !== "engine" || stats.propulsion?.platform !== "air") {
      continue;
    }
    const power = Math.max(0, stats.power ?? 0);
    const baseAccel = (power / mass) * AIR_THRUST_ACCEL_SCALE;
    if (stats.propulsion.mode === "omni") {
      liftAccel += baseAccel;
      continue;
    }
    const propDir = getPropellerDirection(attachment.rotateQuarter ?? 0);
    const dot = propDir.x * 0 + propDir.y * -1;
    const angleLimitDeg = stats.propulsion.thrustAngleDeg ?? 25;
    const cosLimit = Math.cos((angleLimitDeg * Math.PI) / 180);
    if (dot < cosLimit) {
      continue;
    }
    const inConeScale = Math.max(0, Math.min(1, (dot - cosLimit) / Math.max(1e-6, 1 - cosLimit)));
    const sideBleed = Math.max(0, Math.min(0.18, (1 - Math.abs(dot)) * 0.18));
    liftAccel += baseAccel * Math.max(inConeScale, sideBleed);
  }
  return liftAccel;
}

export function validateTemplateDetailed(template: UnitTemplate): TemplateValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!template.id || !/^[a-z0-9-]+$/.test(template.id)) {
    errors.push("template id must match [a-z0-9-]+");
  }
  if (!template.name || template.name.trim().length < 2) {
    errors.push("template name is too short");
  }
  if (!isUnitType(template.type)) {
    errors.push("invalid unit type");
  }
  if (!Number.isFinite(template.gasCost) || template.gasCost < 0) {
    errors.push("gas cost must be non-negative");
  }
  if (template.structure.length === 0) {
    errors.push("structure must have at least one cell");
  }

  for (const cell of template.structure) {
    if (!isMaterialId(cell.material)) {
      errors.push("invalid structure material");
    }
    if ((cell.x !== undefined && !Number.isInteger(cell.x)) || (cell.y !== undefined && !Number.isInteger(cell.y))) {
      errors.push("structure coordinates must be integers");
    }
  }

  const structureCoords = new Set<string>(
    template.structure
      .filter((cell) => Number.isInteger(cell.x) && Number.isInteger(cell.y))
      .map((cell) => `${cell.x},${cell.y}`),
  );

  let controlCount = 0;
  let totalEngineCount = 0;
  let groundEngineCount = 0;
  let airEngineCount = 0;
  let weaponCount = 0;

  for (const attachment of template.attachments) {
    if (!isComponentId(attachment.component)) {
      errors.push("invalid functional component");
      continue;
    }
    if (attachment.cell < 0 || attachment.cell >= template.structure.length) {
      errors.push("functional cell index out of range");
    }
    if ((attachment.x !== undefined && !Number.isInteger(attachment.x)) || (attachment.y !== undefined && !Number.isInteger(attachment.y))) {
      errors.push("functional coordinates must be integers");
    }
    if (attachment.rotateQuarter !== undefined && (!Number.isInteger(attachment.rotateQuarter) || attachment.rotateQuarter < 0 || attachment.rotateQuarter > 3)) {
      errors.push("rotateQuarter must be integer 0..3");
    }
    if (attachment.rotate90 !== undefined && typeof attachment.rotate90 !== "boolean") {
      errors.push("rotate90 must be boolean");
    }

    const stats = COMPONENTS[attachment.component];
    const componentType = stats.type;
    const placement = stats.placement;
    if (placement && attachment.x !== undefined && attachment.y !== undefined) {
      const rotateQuarter = attachment.rotateQuarter ?? 0;
      if (placement.requireStructureBelowAnchor) {
        const supportKey = `${attachment.x},${attachment.y + 1}`;
        if (!structureCoords.has(supportKey)) {
          errors.push("component requires structure support below anchor");
        }
      }
      const footprintOffsets = (placement.footprintOffsets ?? [{ x: 0, y: 0 }]).map((offset) => {
        return rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter);
      });
      if (placement.requireStructureOnFootprint ?? true) {
        for (const offset of footprintOffsets) {
          const key = `${attachment.x + offset.x},${attachment.y + offset.y}`;
          if (!structureCoords.has(key)) {
            errors.push("component footprint must be attached to structure cells");
            break;
          }
        }
      }
      for (const offset of (placement.requireEmptyOffsets ?? []).map((item) => rotateOffsetByQuarter(item.x, item.y, rotateQuarter))) {
        const key = `${attachment.x + offset.x},${attachment.y + offset.y}`;
        if (structureCoords.has(key)) {
          errors.push("component clearance area must be empty");
          break;
        }
      }
    }

    if (componentType === "control") {
      controlCount += 1;
    } else if (componentType === "engine") {
      totalEngineCount += 1;
      if (stats.propulsion?.platform === "air") {
        airEngineCount += 1;
      } else {
        groundEngineCount += 1;
      }
    } else if (componentType === "weapon") {
      weaponCount += 1;
    }
  }

  if (controlCount !== 1) {
    errors.push("exactly one control component is required");
  }
  if (weaponCount < 1) {
    warnings.push("at least one weapon component is recommended");
  }

  if (template.type === "air") {
    if (airEngineCount < 1) {
      errors.push("air unit requires at least one jet engine or propeller");
    } else {
      const liftAccel = computeAirLiftAccel(template);
      if (liftAccel < AIR_HOLD_GRAVITY) {
        errors.push(`air thrust cannot hold altitude (lift=${liftAccel.toFixed(1)} < gravity=${AIR_HOLD_GRAVITY.toFixed(1)})`);
      }
    }
    if (groundEngineCount > 0) {
      warnings.push("ground engines are ignored on air units");
    }
  } else {
    if (totalEngineCount < 1) {
      warnings.push("at least one engine component is recommended");
    }
    if (groundEngineCount < 1 && airEngineCount > 0) {
      warnings.push("air propulsion components do not move ground units");
    }
  }

  for (const item of template.display ?? []) {
    if (!isDisplayKind(item.kind)) {
      errors.push("invalid display component");
    }
    if (item.cell < 0 || item.cell >= template.structure.length) {
      errors.push("display cell index out of range");
    }
    if ((item.x !== undefined && !Number.isInteger(item.x)) || (item.y !== undefined && !Number.isInteger(item.y))) {
      errors.push("display coordinates must be integers");
    }
  }

  return {
    errors: unique(errors),
    warnings: unique(warnings),
  };
}
