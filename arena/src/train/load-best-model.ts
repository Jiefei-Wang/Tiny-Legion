import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Params } from "../ai/ai-schema.ts";

type StoredModel = { params: Params; score: number };

export function loadBestParamsFromStore(aiFamilyId: string): Params {
  const indexPath = resolve(process.cwd(), ".arena-data", "models", aiFamilyId, "index.json");
  if (!existsSync(indexPath)) {
    throw new Error(`No model store found for ${aiFamilyId} at ${indexPath}. Train micro first.`);
  }
  const raw = readFileSync(indexPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`No models in store for ${aiFamilyId}. Train micro first.`);
  }
  const top = parsed[0] as StoredModel;
  if (!top || typeof top !== "object" || !top.params) {
    throw new Error(`Invalid model store for ${aiFamilyId}`);
  }
  return top.params;
}
