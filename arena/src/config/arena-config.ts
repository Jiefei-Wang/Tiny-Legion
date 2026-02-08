import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ArenaDefaults = {
  playerGas?: number;
  enemyGas?: number;
  maxSimSeconds?: number;
  nodeDefense?: number;
  baseHp?: number;
  maxModels?: number;
  parallel?: number;
  seeds?: number;
  generations?: number;
  population?: number;
  spawnBurst?: number;
  spawnMaxActive?: number;
};

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function loadArenaDefaults(): ArenaDefaults {
  // Intentionally simple and local: config lives under arena/.
  const configPath = resolve(process.cwd(), "arena.config.json");
  const cfg = existsSync(configPath) ? asRecord(readJsonFile(configPath)) : {};

  const env = process.env;

  const pick = (key: keyof ArenaDefaults, envName: string): number | undefined => {
    return asNumber(env[envName]) ?? asNumber(cfg[String(key)]);
  };

  return {
    playerGas: pick("playerGas", "ARENA_PLAYER_GAS"),
    enemyGas: pick("enemyGas", "ARENA_ENEMY_GAS"),
    maxSimSeconds: pick("maxSimSeconds", "ARENA_MAX_SIM_SECONDS"),
    nodeDefense: pick("nodeDefense", "ARENA_NODE_DEFENSE"),
    baseHp: pick("baseHp", "ARENA_BASE_HP"),
    maxModels: pick("maxModels", "ARENA_MAX_MODELS"),
    parallel: pick("parallel", "ARENA_PARALLEL"),
    seeds: pick("seeds", "ARENA_SEEDS"),
    generations: pick("generations", "ARENA_GENERATIONS"),
    population: pick("population", "ARENA_POPULATION"),
    spawnBurst: pick("spawnBurst", "ARENA_SPAWN_BURST"),
    spawnMaxActive: pick("spawnMaxActive", "ARENA_SPAWN_MAX_ACTIVE"),
  };
}
