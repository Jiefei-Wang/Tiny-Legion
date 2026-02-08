import type { UnitTemplate } from "../types.ts";

export {
  cloneTemplate,
  getTemplateValidationIssues,
  mergeTemplates,
  parseTemplate,
  validateTemplateDetailed,
  validateTemplate,
} from "../../../packages/game-core/src/templates/template-schema.ts";

import { parseTemplate } from "../../../packages/game-core/src/templates/template-schema.ts";

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

export async function saveDefaultTemplateToStore(template: UnitTemplate): Promise<boolean> {
  try {
    const response = await fetch(`/__templates/default/${template.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(template),
    });
    return response.ok;
  } catch {
    return false;
  }
}
