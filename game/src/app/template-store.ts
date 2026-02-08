import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import type { ComponentId, DisplayAttachmentTemplate, MaterialId, UnitTemplate, UnitType } from "../types.ts";

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
  const issues: string[] = [];
  if (!template.id || !/^[a-z0-9-]+$/.test(template.id)) {
    issues.push("template id must match [a-z0-9-]+");
  }
  if (!template.name || template.name.trim().length < 2) {
    issues.push("template name is too short");
  }
  if (!isUnitType(template.type)) {
    issues.push("invalid unit type");
  }
  if (!Number.isFinite(template.gasCost) || template.gasCost < 0) {
    issues.push("gas cost must be non-negative");
  }
  if (template.structure.length === 0) {
    issues.push("structure must have at least one cell");
  }
  for (const cell of template.structure) {
    if (!isMaterialId(cell.material)) {
      issues.push("invalid structure material");
    }
    if ((cell.x !== undefined && !Number.isInteger(cell.x)) || (cell.y !== undefined && !Number.isInteger(cell.y))) {
      issues.push("structure coordinates must be integers");
    }
  }
  let controlCount = 0;
  let engineCount = 0;
  let weaponCount = 0;
  for (const attachment of template.attachments) {
    if (!isComponentId(attachment.component)) {
      issues.push("invalid functional component");
      continue;
    }
    if (attachment.cell < 0 || attachment.cell >= template.structure.length) {
      issues.push("functional cell index out of range");
    }
    if ((attachment.x !== undefined && !Number.isInteger(attachment.x)) || (attachment.y !== undefined && !Number.isInteger(attachment.y))) {
      issues.push("functional coordinates must be integers");
    }
    if (attachment.rotateQuarter !== undefined && (!Number.isInteger(attachment.rotateQuarter) || attachment.rotateQuarter < 0 || attachment.rotateQuarter > 3)) {
      issues.push("rotateQuarter must be integer 0..3");
    }
    if (attachment.rotate90 !== undefined && typeof attachment.rotate90 !== "boolean") {
      issues.push("rotate90 must be boolean");
    }
    const componentType = COMPONENTS[attachment.component].type;
    if (componentType === "control") {
      controlCount += 1;
    } else if (componentType === "engine") {
      engineCount += 1;
    } else if (componentType === "weapon") {
      weaponCount += 1;
    }
  }
  if (controlCount !== 1) {
    issues.push("exactly one control component is required");
  }
  if (engineCount < 1) {
    issues.push("at least one engine component is required");
  }
  if (weaponCount < 1) {
    issues.push("at least one weapon component is required");
  }
  for (const item of template.display ?? []) {
    if (!isDisplayKind(item.kind)) {
      issues.push("invalid display component");
    }
    if (item.cell < 0 || item.cell >= template.structure.length) {
      issues.push("display cell index out of range");
    }
    if ((item.x !== undefined && !Number.isInteger(item.x)) || (item.y !== undefined && !Number.isInteger(item.y))) {
      issues.push("display coordinates must be integers");
    }
  }
  return Array.from(new Set(issues));
}

export function validateTemplate(template: UnitTemplate): { valid: boolean; reason: string | null } {
  const issues = getTemplateValidationIssues(template);
  if (issues.length > 0) {
    return { valid: false, reason: issues[0] ?? "invalid template" };
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

async function fetchTemplateCollection(path: string): Promise<UnitTemplate[]> {
  try {
    const response = await fetch(path);
    if (!response.ok) {
      return [];
    }
    const body = await response.json() as { templates?: unknown[] };
    if (!Array.isArray(body.templates)) {
      return [];
    }
    return body.templates
      .map((entry) => parseTemplate(entry))
      .filter((template): template is UnitTemplate => template !== null);
  } catch {
    return [];
  }
}

export async function fetchDefaultTemplatesFromStore(): Promise<UnitTemplate[]> {
  return fetchTemplateCollection("/__templates/default");
}

export async function fetchUserTemplatesFromStore(): Promise<UnitTemplate[]> {
  return fetchTemplateCollection("/__templates/user");
}

export async function saveUserTemplateToStore(template: UnitTemplate): Promise<boolean> {
  try {
    const response = await fetch(`/__templates/user/${template.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(template),
    });
    return response.ok;
  } catch {
    return false;
  }
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
