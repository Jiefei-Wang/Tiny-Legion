import { COMPONENTS } from "../config/balance/weapons.ts";
import { AIR_HOLD_GRAVITY, AIR_THRUST_ACCEL_SCALE } from "../config/balance/battlefield.ts";
import {
  createDefaultPartDefinitions,
  getPartFootprintOffsets,
  mergePartCatalogs,
  normalizePartAttachmentRotate,
  rotateOffsetByQuarter,
  resolvePartDefinitionForAttachment,
} from "../parts/part-schema.ts";
import type { DisplayAttachmentTemplate, PartDefinition, UnitTemplate, UnitType } from "../types.ts";

export type TemplateValidationResult = {
  errors: string[];
  warnings: string[];
};

export type TemplateValidationOptions = {
  partCatalog?: ReadonlyArray<PartDefinition>;
};

function resolveCatalog(partCatalog?: ReadonlyArray<PartDefinition>): PartDefinition[] {
  const defaults = createDefaultPartDefinitions();
  if (!partCatalog || partCatalog.length <= 0) {
    return defaults;
  }
  return mergePartCatalogs(defaults, partCatalog);
}

function isUnitType(value: unknown): value is UnitType {
  return value === "ground" || value === "air";
}

function isDisplayKind(value: unknown): value is DisplayAttachmentTemplate["kind"] {
  return value === "panel" || value === "stripe" || value === "glass";
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function engineSupportsAir(part: PartDefinition | null, component: keyof typeof COMPONENTS): boolean {
  if (part?.partType === "engine") {
    if (part.partProperties?.powerAir !== undefined) {
      return part.partProperties.powerAir === true;
    }
    if (part.properties?.engineType) {
      return part.properties.engineType === "air";
    }
  }
  return COMPONENTS[component].propulsion?.platform === "air";
}

function engineSupportsGround(part: PartDefinition | null, component: keyof typeof COMPONENTS): boolean {
  if (part?.partType === "engine") {
    if (part.partProperties?.powerGround !== undefined) {
      return part.partProperties.powerGround === true;
    }
    if (part.properties?.engineType) {
      return part.properties.engineType === "ground";
    }
  }
  return COMPONENTS[component].propulsion?.platform === "ground";
}

function computeAirThrustSpeed(template: UnitTemplate, partCatalog: ReadonlyArray<PartDefinition>): number {
  let mass = 0;
  for (const cell of template.structure) {
    const part = resolvePartDefinitionForAttachment({ partId: cell.partId }, partCatalog);
    if (!part || part.layer !== "structure") {
      continue;
    }
    mass += Math.max(0, part.stats?.mass ?? 0);
  }
  for (const attachment of template.attachments) {
    const part = resolvePartDefinitionForAttachment({ partId: attachment.partId, component: attachment.component }, partCatalog);
    const component = part?.baseComponent ?? attachment.component;
    if (!(component in COMPONENTS)) {
      continue;
    }
    const runtimeMass = part?.stats?.mass;
    mass += runtimeMass !== undefined ? runtimeMass : COMPONENTS[component].mass;
  }
  mass = Math.max(16, mass);

  let thrustSpeed = 0;
  for (const attachment of template.attachments) {
    const part = resolvePartDefinitionForAttachment({ partId: attachment.partId, component: attachment.component }, partCatalog);
    const component = part?.baseComponent ?? attachment.component;
    if (!(component in COMPONENTS)) {
      continue;
    }
    const stats = COMPONENTS[component];
    if (stats.type !== "engine" || !engineSupportsAir(part, component)) {
      continue;
    }
    const power = Math.max(0, part?.stats?.power ?? stats.power ?? 0);
    thrustSpeed += (power / mass) * AIR_THRUST_ACCEL_SCALE;
  }
  return thrustSpeed;
}

export function validateTemplateDetailed(
  template: UnitTemplate,
  options: TemplateValidationOptions = {},
): TemplateValidationResult {
  const partCatalog = resolveCatalog(options.partCatalog);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isInteger(template.id) || template.id < 1) {
    errors.push("template id must be a positive integer");
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
    const part = resolvePartDefinitionForAttachment({ partId: cell.partId }, partCatalog);
    if (!part || part.layer !== "structure") {
      errors.push("invalid structure partId");
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
  let controlCapacity = 0;
  let totalEngineCount = 0;
  let groundEngineCount = 0;
  let airEngineCount = 0;
  let weaponCount = 0;

  const occupiedFunctional = new Set<string>();
  const controlledFunctional = new Set<string>();
  const occupiedStructure = new Set<string>();

  for (const attachment of template.attachments) {
    const part = resolvePartDefinitionForAttachment(
      { partId: attachment.partId, component: attachment.component },
      partCatalog,
    );
    if (!part) {
      errors.push("invalid functional component");
      continue;
    }
    if (part.layer !== "functional") {
      errors.push("attachment part must use functional layer");
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

    const component = part.baseComponent;
    if (!(component in COMPONENTS)) {
      errors.push("invalid functional component");
      continue;
    }
    const stats = COMPONENTS[component];
    const componentType = stats.type;

    const rotateQuarter = normalizePartAttachmentRotate(part, attachment.rotateQuarter ?? 0);
    const anchor = attachment.x !== undefined && attachment.y !== undefined
      ? { x: attachment.x, y: attachment.y }
      : (Number.isInteger(template.structure[attachment.cell]?.x) && Number.isInteger(template.structure[attachment.cell]?.y)
          ? { x: template.structure[attachment.cell]?.x ?? 0, y: template.structure[attachment.cell]?.y ?? 0 }
          : null);

    if (anchor) {
      const placement = part.placement;
      const footprint = getPartFootprintOffsets(part, rotateQuarter);

      for (const offset of placement?.requireStructureOffsets ?? []) {
        const rotated = rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter);
        const key = `${anchor.x + rotated.x},${anchor.y + rotated.y}`;
        if (!structureCoords.has(key)) {
          errors.push("component requires structure support at required offsets");
          break;
        }
      }

      for (const offset of placement?.requireEmptyStructureOffsets ?? []) {
        const rotated = rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter);
        const key = `${anchor.x + rotated.x},${anchor.y + rotated.y}`;
        if (structureCoords.has(key)) {
          errors.push("component clearance area must be empty of structure");
          break;
        }
      }

      for (const offset of placement?.requireEmptyFunctionalOffsets ?? []) {
        const rotated = rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter);
        const key = `xy:${anchor.x + rotated.x},${anchor.y + rotated.y}`;
        if (occupiedFunctional.has(key)) {
          errors.push("component clearance area must be empty of functional occupancy");
          break;
        }
      }

      const requireStructureOnFunctional = placement?.requireStructureOnFunctionalOccupiedBoxes ?? true;
      const requireStructureOnStructure = placement?.requireStructureOnStructureOccupiedBoxes ?? true;

      for (const cell of footprint) {
        const key = `xy:${anchor.x + cell.x},${anchor.y + cell.y}`;
        const coordKey = `${anchor.x + cell.x},${anchor.y + cell.y}`;
        const needsStructureForFunctional = cell.needsStructureBehind || (cell.occupiesFunctionalSpace && requireStructureOnFunctional);
        const needsStructureForAttachPoint = cell.isAttachPoint;

        if ((needsStructureForFunctional || needsStructureForAttachPoint) && !structureCoords.has(coordKey)) {
          errors.push(needsStructureForAttachPoint ? "attach point requires structure support" : "functional occupied boxes must sit on structure");
          break;
        }
        if (cell.occupiesStructureSpace && requireStructureOnStructure && !structureCoords.has(coordKey)) {
          errors.push("structure occupied boxes must map to structure support");
          break;
        }
        if (cell.occupiesStructureSpace && structureCoords.has(coordKey)) {
          errors.push("structure occupied boxes require empty structure space");
          break;
        }

        if (cell.occupiesFunctionalSpace && occupiedFunctional.has(key)) {
          errors.push("functional occupancy overlap");
          break;
        }
        if (cell.occupiesStructureSpace && occupiedStructure.has(key)) {
          errors.push("structure occupancy overlap");
          break;
        }
      }

      for (const cell of footprint) {
        const key = `xy:${anchor.x + cell.x},${anchor.y + cell.y}`;
        if (cell.occupiesFunctionalSpace) {
          occupiedFunctional.add(key);
          if (componentType !== "control") {
            controlledFunctional.add(key);
          }
        }
        if (cell.occupiesStructureSpace) {
          occupiedStructure.add(key);
        }
      }
    }

    if (componentType === "control") {
      controlCount += 1;
      controlCapacity += Math.max(0, part.partProperties?.computing ?? 1);
    } else if (componentType === "engine") {
      totalEngineCount += 1;
      if (engineSupportsAir(part, component)) {
        airEngineCount += 1;
      }
      if (engineSupportsGround(part, component)) {
        groundEngineCount += 1;
      }
    } else if (componentType === "weapon") {
      weaponCount += 1;
    }
  }

  if (controlCount !== 1) {
    errors.push("exactly one control unit is required");
  } else if (controlledFunctional.size > controlCapacity) {
    errors.push(`control unit capacity exceeded (${controlledFunctional.size} functional blocks used, ${controlCapacity} supported)`);
  }
  if (weaponCount < 1) {
    warnings.push("at least one weapon component is recommended");
  }

  if (template.type === "air") {
    if (airEngineCount < 1) {
      errors.push("air unit requires at least one jet engine");
    } else {
      const thrustSpeed = computeAirThrustSpeed(template, partCatalog);
      if (thrustSpeed <= AIR_HOLD_GRAVITY) {
        errors.push(`air thrust cannot overcome gravity (thrust=${thrustSpeed.toFixed(1)} <= gravity=${AIR_HOLD_GRAVITY.toFixed(1)})`);
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
