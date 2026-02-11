import type { PartDefinition, UnitTemplate } from "../types.ts";

export {
  cloneTemplate,
  computeTemplateGasCost,
  getTemplateValidationIssues,
  mergeTemplates,
  parseTemplate,
  validateTemplateDetailed,
  validateTemplate,
} from "../../../packages/game-core/src/templates/template-schema.ts";

import { parseTemplate } from "../../../packages/game-core/src/templates/template-schema.ts";

function serializeTemplateForStore(template: UnitTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    type: template.type,
    ...(typeof template.gasCostOverride === "number" ? { gasCost: Math.max(0, Math.floor(template.gasCostOverride)) } : {}),
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

async function fetchTemplateCollection(path: string, partCatalog?: ReadonlyArray<PartDefinition>): Promise<UnitTemplate[]> {
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
      .map((entry) => parseTemplate(entry, { partCatalog }))
      .filter((template): template is UnitTemplate => template !== null);
  } catch {
    return [];
  }
}

export async function fetchDefaultTemplatesFromStore(partCatalog?: ReadonlyArray<PartDefinition>): Promise<UnitTemplate[]> {
  return fetchTemplateCollection("/__templates/default", partCatalog);
}

export async function fetchUserTemplatesFromStore(partCatalog?: ReadonlyArray<PartDefinition>): Promise<UnitTemplate[]> {
  return fetchTemplateCollection("/__templates/user", partCatalog);
}

export async function saveUserTemplateToStore(template: UnitTemplate): Promise<boolean> {
  try {
    const response = await fetch(`/__templates/user/${template.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(serializeTemplateForStore(template)),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function saveDefaultTemplateToStore(template: UnitTemplate): Promise<boolean> {
  try {
    const response = await fetch(`/__templates/default/${template.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(serializeTemplateForStore(template)),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function deleteUserTemplateFromStore(templateId: string): Promise<boolean> {
  try {
    const response = await fetch(`/__templates/user/${encodeURIComponent(templateId)}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function deleteDefaultTemplateFromStore(templateId: string): Promise<boolean> {
  try {
    const response = await fetch(`/__templates/default/${encodeURIComponent(templateId)}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch {
    return false;
  }
}
