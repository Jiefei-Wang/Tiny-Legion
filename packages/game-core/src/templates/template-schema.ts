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

function ensureLoaderCoverage(attachments: UnitTemplate["attachments"]): UnitTemplate["attachments"] {
  const next = attachments.map((attachment) => ({ ...attachment }));
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
    next.push({
      component,
      cell: anchor.cell,
      x: anchor.x,
      y: anchor.y,
      rotateQuarter: 0,
    });
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

export function parseTemplate(input: unknown): UnitTemplate | null {
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

  const template: UnitTemplate = {
    id: data.id.trim(),
    name: data.name.trim(),
    type: data.type,
    gasCost: typeof data.gasCost === "number" ? Math.max(0, Math.floor(data.gasCost)) : 0,
    structure,
    attachments: ensureLoaderCoverage(attachments),
    display,
  };
  if (template.structure.length <= 0) {
    return null;
  }
  return template;
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
