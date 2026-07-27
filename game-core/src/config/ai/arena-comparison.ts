import { GAME_CONFIG } from "../generated/game-config.generated.ts";

const config = GAME_CONFIG.ai.arenaComparison;

/** Browser Test Arena defaults shared with headless AI comparisons. */
export const TEST_ARENA_NODE_DEFENSE: number = config.testArena.nodeDefense;
export const TEST_ARENA_BASE_HP: number = config.testArena.baseHp;

/** Headless comparison-only wave, duration, and scoring rules. */
export const AI_COMPARISON_UNITS_PER_SIDE: number = config.comparison.unitsPerSide;
export const AI_COMPARISON_BATTLEFIELD_WIDTH: number = config.comparison.battlefieldWidth;
export const AI_COMPARISON_BATTLEFIELD_HEIGHT: number = config.comparison.battlefieldHeight;
export const AI_COMPARISON_GROUND_HEIGHT: number = config.comparison.groundHeight;
export const AI_COMPARISON_MAX_SIM_SECONDS: number = config.comparison.maxSimSeconds;
export const AI_COMPARISON_BASE_WORTH_UNITS: number = config.comparison.baseWorthUnits;
