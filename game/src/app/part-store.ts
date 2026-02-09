import type { PartDefinition } from "../types.ts";

export {
  clonePartDefinition,
  createDefaultPartDefinitions,
  mergePartCatalogs,
  parsePartDefinition,
  resolvePartDefinitionForAttachment,
  validatePartDefinition,
  validatePartDefinitionDetailed,
  getPartFootprintOffsets,
  normalizePartAttachmentRotate,
} from "../../../packages/game-core/src/parts/part-schema.ts";

import { parsePartDefinition } from "../../../packages/game-core/src/parts/part-schema.ts";

async function fetchPartCollection(path: string): Promise<PartDefinition[]> {
  try {
    const response = await fetch(path);
    if (!response.ok) {
      return [];
    }
    const body = await response.json() as { parts?: unknown[] };
    if (!Array.isArray(body.parts)) {
      return [];
    }
    return body.parts
      .map((entry) => parsePartDefinition(entry))
      .filter((part): part is PartDefinition => part !== null);
  } catch {
    return [];
  }
}

export async function fetchDefaultPartsFromStore(): Promise<PartDefinition[]> {
  return fetchPartCollection("/__parts/default");
}

export async function fetchUserPartsFromStore(): Promise<PartDefinition[]> {
  return fetchPartCollection("/__parts/user");
}

export async function saveUserPartToStore(part: PartDefinition): Promise<boolean> {
  try {
    const response = await fetch(`/__parts/user/${part.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(part),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function saveDefaultPartToStore(part: PartDefinition): Promise<boolean> {
  try {
    const response = await fetch(`/__parts/default/${part.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(part),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function deleteUserPartFromStore(partId: string): Promise<boolean> {
  try {
    const response = await fetch(`/__parts/user/${encodeURIComponent(partId)}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch {
    return false;
  }
}
