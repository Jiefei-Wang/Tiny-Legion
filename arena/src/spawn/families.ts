import type { SpawnFamily } from "./spawn-schema.ts";
import { spawnBaseline } from "./families/spawn-baseline.ts";
import { spawnWeighted } from "./families/spawn-weighted.ts";

export const SPAWN_FAMILIES: SpawnFamily[] = [spawnBaseline, spawnWeighted];

export function getSpawnFamily(id: string): SpawnFamily {
  const found = SPAWN_FAMILIES.find((f) => f.id === id);
  if (!found) {
    throw new Error(`Unknown spawn family: ${id}`);
  }
  return found;
}
