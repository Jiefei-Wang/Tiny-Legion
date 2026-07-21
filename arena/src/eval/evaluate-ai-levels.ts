import { levelCompositeConfig, type CompositeConfig } from "../ai/composite-controller.ts";
import { loadLeaderboardScenario } from "../config/leaderboard-scenario.ts";
import { runMatch } from "../match/run-match.ts";
import { compareMirroredSeries } from "../match/mirrored-series.ts";
import type { MatchAiSpec, MatchSpec } from "../match/match-types.ts";

export type LevelEvaluationResult = {
  lowerLevel: number;
  higherLevel: number;
  series: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  pass: boolean;
};

export const AI_LEVEL_CERTIFICATION_SERIES = 16;

export function aiLevelCertificationSeed(index: number): number {
  return 70_000 + (Math.max(0, Math.floor(index)) % AI_LEVEL_CERTIFICATION_SERIES) * 977;
}

const configAiSpec = (composite: CompositeConfig): MatchAiSpec => ({ familyId: "composite", params: {}, composite });

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
    },
    templateNames: scenario.templateNames,
    battlefield: scenario.battlefield,
    spawnMode: "mirrored-random",
    spawnBurst: scenario.spawnBurst,
    spawnMaxActive: scenario.spawnMaxActive,
  };
}

export async function evaluateCompositePair(
  lower: CompositeConfig,
  higher: CompositeConfig,
  seedCount = 16,
  threshold = 0.6,
): Promise<Omit<LevelEvaluationResult, "lowerLevel" | "higherLevel">> {
  const series = Math.max(2, Math.floor(seedCount));
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (let index = 0; index < series; index += 1) {
    const seed = aiLevelCertificationSeed(index);
    const asPlayer = await runMatch(configMatchSpec(seed, configAiSpec(higher), configAiSpec(lower)));
    const asEnemy = await runMatch(configMatchSpec(seed, configAiSpec(lower), configAiSpec(higher)));
    const comparison = compareMirroredSeries(asPlayer, asEnemy);
    wins += Number(comparison.outcomeA > 0);
    losses += Number(comparison.outcomeA < 0);
    ties += Number(comparison.outcomeA === 0);
  }
  const winRate = wins / series;
  return { series, wins, losses, ties, winRate, pass: winRate > threshold };
}

export async function evaluateAiLevelPair(
  lowerLevel: number,
  higherLevel: number,
  seedCount = 16,
  threshold = 0.6,
): Promise<LevelEvaluationResult> {
  const result = await evaluateCompositePair(levelCompositeConfig(lowerLevel), levelCompositeConfig(higherLevel), seedCount, threshold);
  return {
    lowerLevel,
    higherLevel,
    ...result,
  };
}

export async function evaluateAiLevels(maxLevel: number, seedCount = 16, threshold = 0.6, minHigherLevel = 2): Promise<LevelEvaluationResult[]> {
  const normalizedMax = Math.max(2, Math.floor(maxLevel));
  const normalizedMin = Math.max(2, Math.min(normalizedMax, Math.floor(minHigherLevel)));
  const results: LevelEvaluationResult[] = [];
  for (let higherLevel = normalizedMin; higherLevel <= normalizedMax; higherLevel += 1) {
    const result = await evaluateAiLevelPair(higherLevel - 1, higherLevel, seedCount, threshold);
    results.push(result);
    console.log(
      `L${result.higherLevel} vs L${result.lowerLevel}: ${result.wins}/${result.series} wins, ${result.losses} losses, ${result.ties} ties, ${(result.winRate * 100).toFixed(1)}% — ${result.pass ? "PASS" : "FAIL"}`,
    );
  }
  if (results.some((result) => !result.pass)) {
    throw new Error(`AI level evaluation failed: every higher level must win more than ${(threshold * 100).toFixed(1)}% of mirrored leaderboard series against the previous level.`);
  }
  return results;
}
