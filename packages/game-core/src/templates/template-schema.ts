import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import { validateTemplateDetailed } from "./template-validation.ts";
import type { ComponentId, DisplayAttachmentTemplate, MaterialId, UnitTemplate, UnitType } from "../types.ts";

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

function rotateOffsetByQuarter(offsetX: number, offsetY: number, rotateQuarter: 0 | 1 | 2 | 3): { x: number; y: number } {
  if (rotateQuarter === 0) {
    return { x: offsetX, y: offsetY };
  }
  if (rotateQuarter === 1) {
    return { x: -offsetY, y: offsetX };
  }
  if (rotateQuarter === 2) {
    return { x: -offsetX, y: -offsetY };
  }
  return { x: offsetY, y: -offsetX };
}

function getComponentFootprintOffsets(component: ComponentId, rotateQuarter: 0 | 1 | 2 | 3): Array<{ x: number; y: number }> {
  const stats = COMPONENTS[component];
  const placementOffsets = stats.placement?.footprintOffsets;
  if (placementOffsets && placementOffsets.length > 0) {
    return placementOffsets.map((offset) => rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter));
  }
  if (stats.type === "weapon" && stats.weaponClass === "heavy-shot") {
    return [{ x: 0, y: 0 }, { x: 1, y: 0 }].map((offset) => rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter));
  }
  return [{ x: 0, y: 0 }];
}

export function sanitizeTemplatePlacement(template: UnitTemplate): UnitTemplate {
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

  const occupiedSlots = new Set<number>();
  const occupiedFootprint = new Set<string>();
  const attachments: UnitTemplate["attachments"] = [];
  for (const attachment of next.attachments) {
    if (!Number.isInteger(attachment.cell) || attachment.cell < 0 || attachment.cell >= next.structure.length) {
      continue;
    }
    const rotateQuarterRaw = attachment.rotateQuarter ?? (attachment.rotate90 ? 1 : 0);
    const rotateQuarter = ((rotateQuarterRaw % 4 + 4) % 4) as 0 | 1 | 2 | 3;

    const stats = COMPONENTS[attachment.component];
    const normalizedRotate = stats.directional ? rotateQuarter : 0;
    const anchor = attachment.x !== undefined && attachment.y !== undefined
      ? { x: attachment.x, y: attachment.y }
      : cellCoords.get(attachment.cell);

    const footprintOffsets = getComponentFootprintOffsets(attachment.component, normalizedRotate);
    const footprintKeys = anchor
      ? footprintOffsets.map((offset) => `${anchor.x + offset.x},${anchor.y + offset.y}`)
      : [];

    const placement = stats.placement;
    if (placement && anchor) {
      if (placement.requireStructureBelowAnchor) {
        const supportKey = `${anchor.x},${anchor.y + 1}`;
        if (!structureCoords.has(supportKey)) {
          continue;
        }
      }
      const requireStructureOnFootprint = placement.requireStructureOnFootprint ?? true;
      if (requireStructureOnFootprint && footprintKeys.some((key) => !structureCoords.has(key))) {
        continue;
      }
      const requiredEmptyOffsets = placement.requireEmptyOffsets ?? [];
      const blocked = requiredEmptyOffsets
        .map((offset) => rotateOffsetByQuarter(offset.x, offset.y, normalizedRotate))
        .map((offset) => `${anchor.x + offset.x},${anchor.y + offset.y}`)
        .some((key) => structureCoords.has(key));
      if (blocked) {
        continue;
      }
    }

    if (anchor) {
      if (footprintKeys.some((key) => occupiedFootprint.has(key))) {
        continue;
      }
    } else if (occupiedSlots.has(attachment.cell)) {
      continue;
    }

    occupiedSlots.add(attachment.cell);
    for (const key of footprintKeys) {
      occupiedFootprint.add(key);
    }
    attachments.push({
      ...attachment,
      rotateQuarter: normalizedRotate,
    });
  }

  next.attachments = attachments;
  next.display = (next.display ?? []).filter((item) => Number.isInteger(item.cell) && item.cell >= 0 && item.cell < next.structure.length);
  return next;
}

function ensureLoaderCoverage(template: UnitTemplate): UnitTemplate["attachments"] {
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
    const rotateQuarterRaw = attachment.rotateQuarter ?? (attachment.rotate90 ? 1 : 0);
    const rotateQuarter = ((rotateQuarterRaw % 4 + 4) % 4) as 0 | 1 | 2 | 3;
    const footprintOffsets = getComponentFootprintOffsets(attachment.component, rotateQuarter);
    const baseX = attachment.x;
    const baseY = attachment.y;
    if (baseX !== undefined && baseY !== undefined) {
      for (const offset of footprintOffsets) {
        occupiedKeys.add(`xy:${baseX + offset.x},${baseY + offset.y}`);
      }
      continue;
    }
    for (const offset of footprintOffsets) {
      occupiedKeys.add(`cell:${attachment.cell}:${offset.x},${offset.y}`);
    }
  }

  const injectLoader = (component: ComponentId, supportedClass: "tracking" | "heavy-shot" | "explosive"): void => {
    if (!weaponClasses.has(supportedClass) || supportedClasses.has(supportedClass)) {
      return;
    }
    const anchor = next.find((attachment) => {
      const stats = COMPONENTS[attachment.component];
      return stats.type === "weapon" && (stats.weaponClass ?? "rapid-fire") === supportedClass;
    });
    if (!anchor) {
      return;
    }
    const loaderFootprint = getComponentFootprintOffsets(component, 0);
    let placed:
      | { cell: number; x: number | undefined; y: number | undefined; keys: string[] }
      | null = null;
    for (let cellIndex = 0; cellIndex < template.structure.length; cellIndex += 1) {
      const structureCell = template.structure[cellIndex];
      const baseX = structureCell?.x;
      const baseY = structureCell?.y;
      const candidateKeys = loaderFootprint.map((offset) => {
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
    const fallbackKeys = loaderFootprint.map((offset) => {
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
      component,
      cell: target.cell,
      x: target.x,
      y: target.y,
      rotateQuarter: 0,
    });
    for (const key of target.keys) {
      occupiedKeys.add(key);
    }
    const loaderStats = COMPONENTS[component];
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
      cell: attachment.cell,
      x: attachment.x,
      y: attachment.y,
      rotateQuarter: attachment.rotateQuarter,
      rotate90: attachment.rotate90,
    })),
    display: template.display?.map((item) => ({ kind: item.kind, cell: item.cell, x: item.x, y: item.y })) ?? [],
  };
}

export function getTemplateValidationIssues(template: UnitTemplate): string[] {
  const detailed = validateTemplateDetailed(template);
  return [...detailed.errors, ...detailed.warnings];
}

export function validateTemplate(template: UnitTemplate): { valid: boolean; reason: string | null } {
  const detailed = validateTemplateDetailed(template);
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
    const component = normalizeComponentId(record.component);
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

  const placementNormalized = sanitizePlacement ? sanitizeTemplatePlacement(template) : template;
  const loaderNormalized = injectLoaders
    ? { ...placementNormalized, attachments: ensureLoaderCoverage(placementNormalized) }
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
