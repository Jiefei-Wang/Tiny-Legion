import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_COMPARISON_BATTLEFIELD_HEIGHT,
  AI_COMPARISON_BATTLEFIELD_WIDTH,
  AI_COMPARISON_BASE_WORTH_UNITS,
  AI_COMPARISON_GROUND_HEIGHT,
  AI_COMPARISON_MAX_SIM_SECONDS,
  AI_COMPARISON_UNITS_PER_SIDE,
  TEST_ARENA_BASE_HP,
  TEST_ARENA_NODE_DEFENSE,
} from "../../../game-core/src/config/ai/arena-comparison.ts";

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
  unitsPerSide: number;
  baseWorthUnits: number;
};

const fallback: LeaderboardScenario = {
  withBase: true,
  initialUnitsPerSide: 0,
  templateNames: ["*"],
  battlefield: {
    width: AI_COMPARISON_BATTLEFIELD_WIDTH,
    height: AI_COMPARISON_BATTLEFIELD_HEIGHT,
    groundHeight: AI_COMPARISON_GROUND_HEIGHT,
  },
  maxSimSeconds: AI_COMPARISON_MAX_SIM_SECONDS,
  nodeDefense: TEST_ARENA_NODE_DEFENSE,
  baseHp: TEST_ARENA_BASE_HP,
  playerGas: 0,
  enemyGas: 0,
  unitsPerSide: AI_COMPARISON_UNITS_PER_SIDE,
  baseWorthUnits: AI_COMPARISON_BASE_WORTH_UNITS,
};

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
    const templateNames = Array.isArray(phase.templateNames)
      ? phase.templateNames.map(String).filter((name) => name.trim().length > 0)
      : fallback.templateNames;
    return {
      withBase: phase.withBase !== false,
      // Comparison rules are authored in Global Settings (AI), not duplicated in phase JSON.
      initialUnitsPerSide: 0,
      templateNames: templateNames.length > 0 ? templateNames : fallback.templateNames,
      battlefield: { ...fallback.battlefield },
      maxSimSeconds: AI_COMPARISON_MAX_SIM_SECONDS,
      nodeDefense: TEST_ARENA_NODE_DEFENSE,
      baseHp: TEST_ARENA_BASE_HP,
      playerGas: 0,
      enemyGas: 0,
      unitsPerSide: AI_COMPARISON_UNITS_PER_SIDE,
      baseWorthUnits: AI_COMPARISON_BASE_WORTH_UNITS,
    };
  } catch {
    return { ...fallback, battlefield: { ...fallback.battlefield } };
  }
}
