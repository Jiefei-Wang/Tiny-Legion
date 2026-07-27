import { GAME_CONFIG } from "../generated/game-config.generated.ts";

const config = GAME_CONFIG.ai.arenaComparison;

/** Browser Test Arena defaults shared with headless AI comparisons. */
export const TEST_ARENA_NODE_DEFENSE: number = config.testArena.nodeDefense;
export const TEST_ARENA_BASE_HP: number = config.testArena.baseHp;

/** Headless comparison-only wave, duration, and scoring rules. */
export const AI_COMPARISON_SPAWN_COUNT_PER_SIDE: number = config.comparison.spawnCountPerSide;
export const AI_COMPARISON_SPAWN_INTERVAL_SECONDS: number = config.comparison.spawnIntervalSeconds;
export const AI_COMPARISON_MAX_SIM_SECONDS: number = config.comparison.maxSimSeconds;
export const AI_COMPARISON_BASE_WORTH_UNITS: number = config.comparison.baseWorthUnits;
