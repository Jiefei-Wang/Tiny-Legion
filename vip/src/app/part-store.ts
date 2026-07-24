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
  isPartCompatibleWithUnitType,
  normalizePartAttachmentRotate,
} from "../../../game-core/src/parts/part-schema.ts";

import { parsePartDefinition } from "../../../game-core/src/parts/part-schema.ts";

async function fetchPartCollection(path: string): Promise<PartDefinition[]> {
  try {
    const response = await fetch(path, { cache: "no-store" });
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

export async function saveDefaultPartsToStore(parts: ReadonlyArray<PartDefinition>): Promise<PartDefinition[] | null> {
  try {
    const response = await fetch("/__parts/default/batch", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.json().catch(() => null) as { parts?: unknown[] } | null;
    if (!Array.isArray(body?.parts)) {
      return null;
    }
    const parsed = body.parts
      .map((entry) => parsePartDefinition(entry))
      .filter((part): part is PartDefinition => part !== null);
    return parsed.length === parts.length ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveDefaultPartToStore(part: PartDefinition): Promise<PartDefinition | null> {
  try {
    const response = await fetch(`/__parts/default/${part.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(part),
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.json().catch(() => null) as { part?: unknown } | null;
    // Older already-running dev middleware may return only { ok: true }.
    // The submitted snapshot is still the authoritative value for this save.
    return (body?.part ? parsePartDefinition(body.part) : null) ?? part;
  } catch {
    return null;
  }
}

export async function deleteDefaultPartFromStore(partId: number): Promise<boolean> {
  try {
    const response = await fetch(`/__parts/default/${encodeURIComponent(partId)}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch {
    return false;
  }
}
