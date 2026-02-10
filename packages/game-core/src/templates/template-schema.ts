import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import {
  createDefaultPartDefinitions,
  getPartFootprintOffsets,
  mergePartCatalogs,
  normalizePartAttachmentRotate,
  rotateOffsetByQuarter,
  resolvePartDefinitionForAttachment,
} from "../parts/part-schema.ts";
import { validateTemplateDetailed } from "./template-validation.ts";
import type { ComponentId, DisplayAttachmentTemplate, MaterialId, PartDefinition, UnitTemplate, UnitType } from "../types.ts";

export { validateTemplateDetailed } from "./template-validation.ts";

const LEGACY_COMPONENT_MAP: Partial<Record<string, ComponentId>> = {
  mg: "rapidGun",
  cannonL: "heavyCannon",
  cannonM: "explosiveShell",
  rocket: "trackingMissile",
  gunLoader: "cannonLoader",
};

type ParseTemplateOptions = {
  injectLoaders?: boolean;
  sanitizePlacement?: boolean;
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

function isMaterialId(value: unknown): value is MaterialId {
  return typeof value === "string" && value in MATERIALS;
}

function isComponentId(value: unknown): value is ComponentId {
  return typeof value === "string" && value in COMPONENTS;
}

function normalizeComponentId(value: unknown): ComponentId | null {
  if (typeof value !== "string") {
    return null;
  }
  const next = (LEGACY_COMPONENT_MAP[value] ?? value) as string;
  return isComponentId(next) ? next : null;
}

function isDisplayKind(value: unknown): value is DisplayAttachmentTemplate["kind"] {
  return value === "panel" || value === "stripe" || value === "glass";
}

function readOptionalInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

export function sanitizeTemplatePlacement(
  template: UnitTemplate,
  partCatalog?: ReadonlyArray<PartDefinition>,
): UnitTemplate {
  const catalog = resolveCatalog(partCatalog);
  const next = cloneTemplate(template);
  const structureCoords = new Set<string>();
  const cellCoords = new Map<number, { x: number; y: number }>();
  for (let i = 0; i < next.structure.length; i += 1) {
    const cell = next.structure[i];
    if (cell?.x === undefined || cell?.y === undefined) {
      continue;
    }
    structureCoords.add(`${cell.x},${cell.y}`);
    cellCoords.set(i, { x: cell.x, y: cell.y });
  }

  const occupiedFunctional = new Set<string>();
  const occupiedStructure = new Set<string>();
  const occupiedSlots = new Set<number>();

  const attachments: UnitTemplate["attachments"] = [];
  for (const attachment of next.attachments) {
    if (!Number.isInteger(attachment.cell) || attachment.cell < 0 || attachment.cell >= next.structure.length) {
      continue;
    }

    const part = resolvePartDefinitionForAttachment(
      { partId: attachment.partId, component: attachment.component },
      catalog,
    );
    if (!part) {
      continue;
    }
    if (part.layer !== "functional") {
      continue;
    }

    const rotateQuarterRaw = attachment.rotateQuarter ?? (attachment.rotate90 ? 1 : 0);
    const normalizedRotate = normalizePartAttachmentRotate(part, rotateQuarterRaw);
    const anchor = attachment.x !== undefined && attachment.y !== undefined
      ? { x: attachment.x, y: attachment.y }
      : cellCoords.get(attachment.cell);

    const footprint = getPartFootprintOffsets(part, normalizedRotate);
    if (footprint.length <= 0) {
      continue;
    }

    const occupancyKeys = footprint.map((item) => {
      if (anchor) {
        const x = anchor.x + item.x;
        const y = anchor.y + item.y;
        return {
          ...item,
          key: `xy:${x},${y}`,
          coordKey: `${x},${y}`,
          x,
          y,
        };
      }
      return {
        ...item,
        key: `cell:${attachment.cell}:${item.x},${item.y}`,
        coordKey: null,
        x: item.x,
        y: item.y,
      };
    });

    const placement = part.placement;
    let blocked = false;
    if (anchor) {
      if (placement?.requireStructureBelowAnchor) {
        const supportKey = `${anchor.x},${anchor.y + 1}`;
        if (!structureCoords.has(supportKey)) {
          blocked = true;
        }
      }

      if (!blocked) {
        for (const offset of placement?.requireStructureOffsets ?? []) {
          const rotated = rotateOffsetByQuarter(offset.x, offset.y, normalizedRotate);
          const x = anchor.x + rotated.x;
          const y = anchor.y + rotated.y;
          if (!structureCoords.has(`${x},${y}`)) {
            blocked = true;
            break;
          }
        }
      }

      if (!blocked) {
        for (const offset of placement?.requireEmptyStructureOffsets ?? []) {
          const rotated = rotateOffsetByQuarter(offset.x, offset.y, normalizedRotate);
          const x = anchor.x + rotated.x;
          const y = anchor.y + rotated.y;
          if (structureCoords.has(`${x},${y}`)) {
            blocked = true;
            break;
          }
        }
      }

      if (!blocked) {
        for (const offset of placement?.requireEmptyFunctionalOffsets ?? []) {
          const rotated = rotateOffsetByQuarter(offset.x, offset.y, normalizedRotate);
          const x = anchor.x + rotated.x;
          const y = anchor.y + rotated.y;
          if (occupiedFunctional.has(`xy:${x},${y}`)) {
            blocked = true;
            break;
          }
        }
      }

      if (!blocked) {
        const requireStructureOnFunctional = placement?.requireStructureOnFunctionalOccupiedBoxes ?? true;
        const requireStructureOnStructure = placement?.requireStructureOnStructureOccupiedBoxes ?? true;
        for (const item of occupancyKeys) {
          if (item.coordKey === null) {
            continue;
          }
          const needsStructureForFunctional = item.needsStructureBehind || (item.occupiesFunctionalSpace && requireStructureOnFunctional);
          const needsStructureForAttachPoint = item.isAttachPoint;
          if ((needsStructureForFunctional || needsStructureForAttachPoint) && !structureCoords.has(item.coordKey)) {
            blocked = true;
            break;
          }
          if (item.occupiesStructureSpace && requireStructureOnStructure && !structureCoords.has(item.coordKey)) {
            blocked = true;
            break;
          }
          if (item.occupiesStructureSpace && structureCoords.has(item.coordKey)) {
            blocked = true;
            break;
          }
        }
      }
    }

    if (blocked) {
      continue;
    }

    if (!anchor && occupiedSlots.has(attachment.cell)) {
      continue;
    }

    if (occupancyKeys.some((item) => item.occupiesFunctionalSpace && occupiedFunctional.has(item.key))) {
      continue;
    }
    if (occupancyKeys.some((item) => item.occupiesStructureSpace && occupiedStructure.has(item.key))) {
      continue;
    }

    occupiedSlots.add(attachment.cell);
    for (const item of occupancyKeys) {
      if (item.occupiesFunctionalSpace) {
        occupiedFunctional.add(item.key);
      }
      if (item.occupiesStructureSpace) {
        occupiedStructure.add(item.key);
      }
    }

    attachments.push({
      ...attachment,
      component: part.baseComponent,
      partId: part.id,
      rotateQuarter: normalizedRotate,
    });
  }

  next.attachments = attachments;
  next.display = (next.display ?? []).filter((item) => Number.isInteger(item.cell) && item.cell >= 0 && item.cell < next.structure.length);
  return next;
}

function ensureLoaderCoverage(
  template: UnitTemplate,
  partCatalog?: ReadonlyArray<PartDefinition>,
): UnitTemplate["attachments"] {
  const catalog = resolveCatalog(partCatalog);
  const next = template.attachments.map((attachment) => ({ ...attachment }));
  const weaponClasses = new Set(
    next
      .map((attachment) => COMPONENTS[attachment.component])
      .filter((stats) => stats.type === "weapon")
      .map((stats) => stats.weaponClass ?? "rapid-fire"),
  );
  const supportedClasses = new Set<string>();
  for (const attachment of next) {
    const stats = COMPONENTS[attachment.component];
    if (stats.type !== "loader" || !stats.loader) {
      continue;
    }
    for (const supported of stats.loader.supports) {
      supportedClasses.add(supported);
    }
  }

  const occupiedKeys = new Set<string>();
  for (const attachment of next) {
    const part = resolvePartDefinitionForAttachment({ partId: attachment.partId, component: attachment.component }, catalog);
    if (!part || part.layer !== "functional") {
      continue;
    }
    const rotateQuarterRaw = attachment.rotateQuarter ?? (attachment.rotate90 ? 1 : 0);
    const rotateQuarter = normalizePartAttachmentRotate(part, rotateQuarterRaw);
    const footprint = getPartFootprintOffsets(part, rotateQuarter);
    const baseX = attachment.x;
    const baseY = attachment.y;
    if (baseX !== undefined && baseY !== undefined) {
      for (const offset of footprint) {
        if (!offset.occupiesFunctionalSpace && !offset.occupiesStructureSpace) {
          continue;
        }
        occupiedKeys.add(`xy:${baseX + offset.x},${baseY + offset.y}`);
      }
      continue;
    }
    for (const offset of footprint) {
      if (!offset.occupiesFunctionalSpace && !offset.occupiesStructureSpace) {
        continue;
      }
      occupiedKeys.add(`cell:${attachment.cell}:${offset.x},${offset.y}`);
    }
  }

  const injectLoader = (component: ComponentId, supportedClass: "tracking" | "heavy-shot" | "explosive"): void => {
    if (!weaponClasses.has(supportedClass) || supportedClasses.has(supportedClass)) {
      return;
    }
    const loaderPart = resolvePartDefinitionForAttachment({ component }, catalog);
    if (!loaderPart) {
      return;
    }

    const anchor = next.find((attachment) => {
      const stats = COMPONENTS[attachment.component];
      return stats.type === "weapon" && (stats.weaponClass ?? "rapid-fire") === supportedClass;
    });
    if (!anchor) {
      return;
    }

    const loaderFootprint = getPartFootprintOffsets(loaderPart, 0);
    let placed:
      | { cell: number; x: number | undefined; y: number | undefined; keys: string[] }
      | null = null;

    for (let cellIndex = 0; cellIndex < template.structure.length; cellIndex += 1) {
      const structureCell = template.structure[cellIndex];
      const baseX = structureCell?.x;
      const baseY = structureCell?.y;
      const candidateKeys = loaderFootprint
        .filter((offset) => offset.occupiesFunctionalSpace || offset.occupiesStructureSpace)
        .map((offset) => {
          if (baseX !== undefined && baseY !== undefined) {
            return `xy:${baseX + offset.x},${baseY + offset.y}`;
          }
          return `cell:${cellIndex}:${offset.x},${offset.y}`;
        });
      if (candidateKeys.some((key) => occupiedKeys.has(key))) {
        continue;
      }
      placed = {
        cell: cellIndex,
        x: baseX,
        y: baseY,
        keys: candidateKeys,
      };
      break;
    }

    const fallbackBaseX = anchor.x;
    const fallbackBaseY = anchor.y;
    const fallbackKeys = loaderFootprint
      .filter((offset) => offset.occupiesFunctionalSpace || offset.occupiesStructureSpace)
      .map((offset) => {
        if (fallbackBaseX !== undefined && fallbackBaseY !== undefined) {
          return `xy:${fallbackBaseX + offset.x},${fallbackBaseY + offset.y}`;
        }
        return `cell:${anchor.cell}:${offset.x},${offset.y}`;
      });

    const target = placed ?? {
      cell: anchor.cell,
      x: anchor.x,
      y: anchor.y,
      keys: fallbackKeys,
    };

    next.push({
      component: loaderPart.baseComponent,
      partId: loaderPart.id,
      cell: target.cell,
      x: target.x,
      y: target.y,
      rotateQuarter: 0,
    });

    for (const key of target.keys) {
      occupiedKeys.add(key);
    }

    const loaderStats = COMPONENTS[loaderPart.baseComponent];
    if (loaderStats.type === "loader" && loaderStats.loader) {
      for (const supported of loaderStats.loader.supports) {
        supportedClasses.add(supported);
      }
    }
  };

  injectLoader("missileLoader", "tracking");
  injectLoader("cannonLoader", "heavy-shot");
  injectLoader("cannonLoader", "explosive");

  return next;
}

export function cloneTemplate(template: UnitTemplate): UnitTemplate {
  return {
    id: template.id,
    name: template.name,
    type: template.type,
    gasCost: template.gasCost,
    structure: template.structure.map((cell) => ({ material: cell.material, x: cell.x, y: cell.y })),
    attachments: template.attachments.map((attachment) => ({
      component: attachment.component,
      partId: attachment.partId,
      cell: attachment.cell,
      x: attachment.x,
      y: attachment.y,
      rotateQuarter: attachment.rotateQuarter,
      rotate90: attachment.rotate90,
    })),
    display: template.display?.map((item) => ({ kind: item.kind, cell: item.cell, x: item.x, y: item.y })) ?? [],
  };
}

export function getTemplateValidationIssues(template: UnitTemplate, partCatalog?: ReadonlyArray<PartDefinition>): string[] {
  const detailed = validateTemplateDetailed(template, { partCatalog });
  return [...detailed.errors, ...detailed.warnings];
}

export function validateTemplate(
  template: UnitTemplate,
  partCatalog?: ReadonlyArray<PartDefinition>,
): { valid: boolean; reason: string | null } {
  const detailed = validateTemplateDetailed(template, { partCatalog });
  if (detailed.errors.length > 0) {
    return { valid: false, reason: detailed.errors[0] ?? "invalid template" };
  }
  return { valid: true, reason: null };
}

export function parseTemplate(input: unknown, options: ParseTemplateOptions = {}): UnitTemplate | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const data = input as Record<string, unknown>;
  if (!isUnitType(data.type) || typeof data.id !== "string" || typeof data.name !== "string") {
    return null;
  }
  if (!Array.isArray(data.structure) || !Array.isArray(data.attachments)) {
    return null;
  }

  const partCatalog = resolveCatalog(options.partCatalog);

  const structure: UnitTemplate["structure"] = [];
  for (const rawCell of data.structure) {
    if (!rawCell || typeof rawCell !== "object") {
      continue;
    }
    const record = rawCell as Record<string, unknown>;
    const material = record.material;
    if (!isMaterialId(material)) {
      continue;
    }
    structure.push({
      material,
      x: readOptionalInt(record.x),
      y: readOptionalInt(record.y),
    });
  }

  const coordToCell = new Map<string, number>();
  for (let i = 0; i < structure.length; i += 1) {
    const cell = structure[i];
    if (cell?.x === undefined || cell?.y === undefined) {
      continue;
    }
    coordToCell.set(`${cell.x},${cell.y}`, i);
  }

  const attachments: UnitTemplate["attachments"] = [];
  for (const rawAttachment of data.attachments) {
    if (!rawAttachment || typeof rawAttachment !== "object") {
      continue;
    }
    const record = rawAttachment as Record<string, unknown>;
    const partId = typeof record.partId === "string" && record.partId.trim().length > 0
      ? record.partId.trim()
      : undefined;

    const partFromId = partId
      ? resolvePartDefinitionForAttachment({ partId }, partCatalog)
      : null;
    const functionalPartFromId = partFromId?.layer === "functional" ? partFromId : null;

    const component = normalizeComponentId(record.component) ?? functionalPartFromId?.baseComponent ?? null;
    if (!component) {
      continue;
    }

    const x = readOptionalInt(record.x);
    const y = readOptionalInt(record.y);
    const byCoord = x !== undefined && y !== undefined ? coordToCell.get(`${x},${y}`) : undefined;
    const byCell = typeof record.cell === "number" ? Math.floor(record.cell) : undefined;
    const cell = byCoord ?? byCell;
    if (cell === undefined) {
      continue;
    }

    attachments.push({
      component,
      partId,
      cell,
      x,
      y,
      rotateQuarter: typeof record.rotateQuarter === "number" ? ((Math.floor(record.rotateQuarter) % 4 + 4) % 4) : undefined,
      rotate90: typeof record.rotate90 === "boolean" ? record.rotate90 : undefined,
    });
  }

  const display: UnitTemplate["display"] = [];
  if (Array.isArray(data.display)) {
    for (const rawItem of data.display) {
      if (!rawItem || typeof rawItem !== "object") {
        continue;
      }
      const record = rawItem as Record<string, unknown>;
      if (!isDisplayKind(record.kind)) {
        continue;
      }
      const x = readOptionalInt(record.x);
      const y = readOptionalInt(record.y);
      const byCoord = x !== undefined && y !== undefined ? coordToCell.get(`${x},${y}`) : undefined;
      const byCell = typeof record.cell === "number" ? Math.floor(record.cell) : undefined;
      const cell = byCoord ?? byCell;
      if (cell === undefined) {
        continue;
      }
      display.push({ kind: record.kind, cell, x, y });
    }
  }

  const injectLoaders = options.injectLoaders ?? true;
  const sanitizePlacement = options.sanitizePlacement ?? true;

  const template: UnitTemplate = {
    id: data.id.trim(),
    name: data.name.trim(),
    type: data.type,
    gasCost: typeof data.gasCost === "number" ? Math.max(0, Math.floor(data.gasCost)) : 0,
    structure,
    attachments,
    display,
  };
  if (template.structure.length <= 0) {
    return null;
  }

  const placementNormalized = sanitizePlacement ? sanitizeTemplatePlacement(template, partCatalog) : template;
  const loaderNormalized = injectLoaders
    ? { ...placementNormalized, attachments: ensureLoaderCoverage(placementNormalized, partCatalog) }
    : placementNormalized;
  return loaderNormalized;
}

export function mergeTemplates(baseTemplates: UnitTemplate[], incomingTemplates: UnitTemplate[]): UnitTemplate[] {
  const map = new Map<string, UnitTemplate>();
  for (const template of baseTemplates) {
    map.set(template.id, cloneTemplate(template));
  }
  for (const template of incomingTemplates) {
    map.set(template.id, cloneTemplate(template));
  }
  return Array.from(map.values());
}
