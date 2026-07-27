import { levelCompositeConfig, type CompositeConfig } from "../ai/composite-controller.ts";
import { loadLeaderboardScenario } from "../config/leaderboard-scenario.ts";
import { compareMatchResult } from "../match/match-comparison.ts";
import { runMatch } from "../match/run-match.ts";
import type { MatchAiSpec, MatchSpec } from "../match/match-types.ts";

export type LevelEvaluationResult = {
  lowerLevel: number;
  higherLevel: number;
  seed: number;
  destroyedByHigher: number;
  destroyedByLower: number;
  destroyRatio: number;
  matches: number;
  pass: boolean;
};

export const AI_LEVEL_MIN_DESTROY_RATIO = 1.1;
export const AI_LEVEL_CERTIFICATION_SERIES = 16;

/** Deterministic seeds shared by level checks and manual leaderboard rounds. */
export function aiLevelCertificationSeed(index: number): number {
  return 910_000_000
    + (Math.max(0, Math.floor(index)) % AI_LEVEL_CERTIFICATION_SERIES) * 104_729;
}

export function adjacentLevelDestroyRatio(destroyedByHigher: number, destroyedByLower: number): number {
  return Math.max(0, destroyedByHigher) / Math.max(1, destroyedByLower);
}

const configAiSpec = (composite: CompositeConfig): MatchAiSpec => ({
  familyId: "composite",
  params: {},
  composite,
});

function configMatchSpec(seed: number, aiPlayer: MatchAiSpec, aiEnemy: MatchAiSpec): MatchSpec {
  const scenario = loadLeaderboardScenario();
  return {
    seed,
    maxSimSeconds: scenario.maxSimSeconds,
    nodeDefense: scenario.nodeDefense,
    baseHp: scenario.baseHp,
    playerGas: scenario.playerGas,
    enemyGas: scenario.enemyGas,
    aiPlayer,
    aiEnemy,
    scenario: {
      withBase: scenario.withBase,
      initialUnitsPerSide: scenario.initialUnitsPerSide,
      maintainUnitsPerSide: scenario.unitsPerSide,
    },
    templateNames: scenario.templateNames,
    battlefield: scenario.battlefield,
    spawnMode: "mirrored-random",
    baseWorthUnits: scenario.baseWorthUnits,
  };
}

/** Run one fixed-orientation symmetric leaderboard match: higher level vs previous level. */
export async function evaluateCompositePair(
  lower: CompositeConfig,
  higher: CompositeConfig,
  seed = aiLevelCertificationSeed(0),
  minimumDestroyRatio = AI_LEVEL_MIN_DESTROY_RATIO,
): Promise<Omit<LevelEvaluationResult, "lowerLevel" | "higherLevel">> {
  const result = await runMatch(configMatchSpec(seed, configAiSpec(higher), configAiSpec(lower)));
  const comparison = compareMatchResult(result);
  const destroyRatio = adjacentLevelDestroyRatio(comparison.destroyedByA, comparison.destroyedByB);
  return {
    seed,
    destroyedByHigher: comparison.destroyedByA,
    destroyedByLower: comparison.destroyedByB,
    destroyRatio,
    matches: 1,
    pass: destroyRatio >= minimumDestroyRatio,
  };
}

export async function evaluateAiLevelPair(
  lowerLevel: number,
  higherLevel: number,
  minimumDestroyRatio = AI_LEVEL_MIN_DESTROY_RATIO,
): Promise<LevelEvaluationResult> {
  const lower = configAiSpec(levelCompositeConfig(lowerLevel));
  const higher = configAiSpec(levelCompositeConfig(higherLevel));
  let destroyedByHigher = 0;
  let destroyedByLower = 0;
  for (let index = 0; index < AI_LEVEL_CERTIFICATION_SERIES; index += 1) {
    const higherOnPlayer = index % 2 === 0;
    const result = await runMatch(configMatchSpec(
      aiLevelCertificationSeed(index),
      higherOnPlayer ? higher : lower,
      higherOnPlayer ? lower : higher,
    ));
    const comparison = compareMatchResult(result);
    destroyedByHigher += higherOnPlayer ? comparison.destroyedByA : comparison.destroyedByB;
    destroyedByLower += higherOnPlayer ? comparison.destroyedByB : comparison.destroyedByA;
  }
  const destroyRatio = adjacentLevelDestroyRatio(destroyedByHigher, destroyedByLower);
  return {
    lowerLevel,
    higherLevel,
    seed: aiLevelCertificationSeed(0),
    destroyedByHigher,
    destroyedByLower,
    destroyRatio,
    matches: AI_LEVEL_CERTIFICATION_SERIES,
    pass: destroyRatio >= minimumDestroyRatio,
  };
}

export async function evaluateAiLevels(
  maxLevel = 5,
  minHigherLevel = 2,
): Promise<LevelEvaluationResult[]> {
  const normalizedMax = Math.max(2, Math.floor(maxLevel));
  const normalizedMin = Math.max(2, Math.min(normalizedMax, Math.floor(minHigherLevel)));
  const results: LevelEvaluationResult[] = [];

  for (let higherLevel = normalizedMin; higherLevel <= normalizedMax; higherLevel += 1) {
    const result = await evaluateAiLevelPair(higherLevel - 1, higherLevel);
    results.push(result);
    console.log(
      `L${result.higherLevel} vs L${result.lowerLevel}: destroyed `
      + `${result.destroyedByHigher}/${result.destroyedByLower}, `
      + `ratio ${result.destroyRatio.toFixed(2)} - ${result.pass ? "PASS" : "FAIL"}`,
    );
  }

  if (results.some((result) => !result.pass)) {
    throw new Error(
      `AI level evaluation failed: every higher level must achieve at least a `
      + `${AI_LEVEL_MIN_DESTROY_RATIO.toFixed(2)} destroy ratio against its previous level.`,
    );
  }
  return results;
}
