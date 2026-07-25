import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  DEFAULT_GROUND_HEIGHT,
} from "../../../game-core/src/config/balance/battlefield.ts";

export type LeaderboardScenario = {
  withBase: boolean;
  initialUnitsPerSide: number;
  templateNames: string[];
  battlefield: { width: number; height: number; groundHeight?: number };
  maxSimSeconds: number;
  nodeDefense: number;
  baseHp: number;
  playerGas: number;
  enemyGas: number;
  spawnBurst: number;
  spawnMaxActive: number;
};

const fallback: LeaderboardScenario = {
  withBase: true,
  initialUnitsPerSide: 4,
  templateNames: ["*"],
  battlefield: { width: BATTLEFIELD_WIDTH, height: BATTLEFIELD_HEIGHT, groundHeight: DEFAULT_GROUND_HEIGHT },
  maxSimSeconds: 120,
  nodeDefense: 1,
  baseHp: 1200,
  playerGas: 3000,
  enemyGas: 3000,
  spawnBurst: 1,
  spawnMaxActive: 4,
};

const finite = (value: unknown, defaultValue: number): number => typeof value === "number" && Number.isFinite(value) ? value : defaultValue;

function defaultConfigPath(): string {
  const direct = resolve(process.cwd(), "composite-training.phases.json");
  if (existsSync(direct)) return direct;
  return resolve(process.cwd(), "arena", "composite-training.phases.json");
}

export function loadLeaderboardScenario(configPath = defaultConfigPath()): LeaderboardScenario {
  if (!existsSync(configPath)) return { ...fallback, battlefield: { ...fallback.battlefield } };
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { phases?: Array<Record<string, unknown>> };
    const phase = parsed.phases?.find((entry) => entry?.id === "p4-leaderboard");
    if (!phase) return { ...fallback, battlefield: { ...fallback.battlefield } };
    const useGlobalBattlefield = phase.useGlobalBattlefield === true;
    const battlefieldRaw = phase.battlefield && typeof phase.battlefield === "object"
      ? phase.battlefield as Record<string, unknown>
      : {};
    const templateNames = Array.isArray(phase.templateNames)
      ? phase.templateNames.map(String).filter((name) => name.trim().length > 0)
      : fallback.templateNames;
    return {
      withBase: phase.withBase !== false,
      initialUnitsPerSide: Math.max(1, Math.floor(finite(phase.initialUnitsPerSide, fallback.initialUnitsPerSide))),
      templateNames: templateNames.length > 0 ? templateNames : fallback.templateNames,
      battlefield: {
        width: useGlobalBattlefield
          ? BATTLEFIELD_WIDTH
          : Math.max(640, Math.floor(finite(battlefieldRaw.width, fallback.battlefield.width))),
        height: useGlobalBattlefield
          ? BATTLEFIELD_HEIGHT
          : Math.max(360, Math.floor(finite(battlefieldRaw.height, fallback.battlefield.height))),
        groundHeight: useGlobalBattlefield
          ? DEFAULT_GROUND_HEIGHT
          : Math.max(80, Math.floor(finite(battlefieldRaw.groundHeight, fallback.battlefield.groundHeight ?? DEFAULT_GROUND_HEIGHT))),
      },
      maxSimSeconds: Math.max(10, Math.floor(finite(phase.maxSimSeconds, fallback.maxSimSeconds))),
      nodeDefense: Math.max(0, Math.floor(finite(phase.nodeDefense, fallback.nodeDefense))),
      baseHp: Math.max(100, Math.floor(finite(phase.baseHp, fallback.baseHp))),
      playerGas: Math.max(0, Math.floor(finite(phase.playerGas, fallback.playerGas))),
      enemyGas: Math.max(0, Math.floor(finite(phase.enemyGas, fallback.enemyGas))),
      spawnBurst: Math.max(1, Math.floor(finite(phase.spawnBurst, fallback.spawnBurst))),
      spawnMaxActive: Math.max(1, Math.floor(finite(phase.spawnMaxActive, fallback.spawnMaxActive))),
    };
  } catch {
    return { ...fallback, battlefield: { ...fallback.battlefield } };
  }
}
