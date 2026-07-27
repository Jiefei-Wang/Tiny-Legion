import { availableParallelism } from "node:os";
import { levelCompositeConfig, type CompositeConfig } from "../ai/composite-controller.ts";
import { loadLeaderboardScenario } from "../config/leaderboard-scenario.ts";
import { WorkerPool } from "../lib/worker-pool.ts";
import { compareMirroredSeries } from "../match/mirrored-series.ts";
import { runMatch } from "../match/run-match.ts";
import type { MatchAiSpec, MatchResult, MatchSpec } from "../match/match-types.ts";

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

export type LevelOverallResult = {
  level: number;
  series: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
};

export const AI_LEVEL_CERTIFICATION_SERIES = 128;

/** Held-out suite. Never use these seeds for candidate search or tuning. */
export function aiLevelCertificationSeed(index: number): number {
  return 910_000_000
    + (Math.max(0, Math.floor(index)) % AI_LEVEL_CERTIFICATION_SERIES) * 104_729;
}

/** Development-only suite for candidate search and tuning. */
export function aiLevelDevelopmentSeed(index: number): number {
  return 110_000_000 + Math.max(0, Math.floor(index)) * 13_007;
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
      maintainUnitsPerSide: scenario.maintainUnitsPerSide,
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
  seedCount = AI_LEVEL_CERTIFICATION_SERIES,
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
  return { series, wins, losses, ties, winRate, pass: winRate >= threshold };
}

export async function evaluateAiLevelPair(
  lowerLevel: number,
  higherLevel: number,
  seedCount = AI_LEVEL_CERTIFICATION_SERIES,
  threshold = 0.6,
): Promise<LevelEvaluationResult> {
  const result = await evaluateCompositePair(
    levelCompositeConfig(lowerLevel),
    levelCompositeConfig(higherLevel),
    seedCount,
    threshold,
  );
  return { lowerLevel, higherLevel, ...result };
}

async function evaluateCompositePairWithPool(
  pool: WorkerPool,
  lower: CompositeConfig,
  higher: CompositeConfig,
  seedCount: number,
  threshold: number,
): Promise<Omit<LevelEvaluationResult, "lowerLevel" | "higherLevel">> {
  const outcomes = await Promise.all(Array.from({ length: seedCount }, async (_, index) => {
    const seed = aiLevelCertificationSeed(index);
    const lowerSpec = configAiSpec(lower);
    const higherSpec = configAiSpec(higher);
    const [asPlayer, asEnemy] = await Promise.all([
      pool.run(configMatchSpec(seed, higherSpec, lowerSpec)).then((result) => result as MatchResult),
      pool.run(configMatchSpec(seed, lowerSpec, higherSpec)).then((result) => result as MatchResult),
    ]);
    return compareMirroredSeries(asPlayer, asEnemy).outcomeA;
  }));
  const wins = outcomes.filter((outcome) => outcome > 0).length;
  const losses = outcomes.filter((outcome) => outcome < 0).length;
  const ties = outcomes.length - wins - losses;
  const winRate = wins / seedCount;
  return { series: seedCount, wins, losses, ties, winRate, pass: winRate >= threshold };
}

export async function evaluateAiLevels(
  maxLevel: number,
  seedCount = AI_LEVEL_CERTIFICATION_SERIES,
  threshold = 0.6,
  minHigherLevel = 2,
): Promise<LevelEvaluationResult[]> {
  const normalizedMax = Math.max(2, Math.floor(maxLevel));
  const normalizedMin = Math.max(2, Math.min(normalizedMax, Math.floor(minHigherLevel)));
  const series = Math.max(2, Math.floor(seedCount));
  const pool = new WorkerPool(WorkerPool.matchWorkerUrl(), Math.min(24, availableParallelism()));
  const pairResults = new Map<string, LevelEvaluationResult>();
  try {
    const jobs: Array<Promise<void>> = [];
    for (let lowerLevel = 1; lowerLevel < normalizedMax; lowerLevel += 1) {
      for (let higherLevel = lowerLevel + 1; higherLevel <= normalizedMax; higherLevel += 1) {
        jobs.push((async () => {
          const result = await evaluateCompositePairWithPool(
            pool,
            levelCompositeConfig(lowerLevel),
            levelCompositeConfig(higherLevel),
            series,
            threshold,
          );
          pairResults.set(`${lowerLevel}:${higherLevel}`, { lowerLevel, higherLevel, ...result });
        })());
      }
    }
    await Promise.all(jobs);
  } finally {
    await pool.close();
  }

  const results: LevelEvaluationResult[] = [];
  for (let higherLevel = normalizedMin; higherLevel <= normalizedMax; higherLevel += 1) {
    const result = pairResults.get(`${higherLevel - 1}:${higherLevel}`);
    if (!result) throw new Error(`Missing adjacent result L${higherLevel} vs L${higherLevel - 1}.`);
    results.push(result);
    console.log(
      `L${result.higherLevel} vs L${result.lowerLevel}: ${result.wins}/${result.series} wins, `
      + `${result.losses} losses, ${result.ties} ties, ${(result.winRate * 100).toFixed(1)}% — `
      + `${result.pass ? "PASS" : "FAIL"}`,
    );
  }

  const overall: LevelOverallResult[] = [];
  for (let level = 1; level <= normalizedMax; level += 1) {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (let opponent = 1; opponent <= normalizedMax; opponent += 1) {
      if (opponent === level) continue;
      const lowerLevel = Math.min(level, opponent);
      const higherLevel = Math.max(level, opponent);
      const result = pairResults.get(`${lowerLevel}:${higherLevel}`);
      if (!result) throw new Error(`Missing round-robin result L${higherLevel} vs L${lowerLevel}.`);
      if (level === higherLevel) {
        wins += result.wins;
        losses += result.losses;
      } else {
        wins += result.losses;
        losses += result.wins;
      }
      ties += result.ties;
    }
    const total = wins + losses + ties;
    overall.push({ level, series: total, wins, losses, ties, winRate: total > 0 ? wins / total : 0 });
  }
  for (const entry of overall) {
    console.log(
      `L${entry.level} overall: ${entry.wins}/${entry.series} wins, ${entry.losses} losses, `
      + `${entry.ties} ties, ${(entry.winRate * 100).toFixed(1)}%`,
    );
  }

  const overallOrdered = overall.every((entry, index) => (
    index === 0 || entry.winRate > overall[index - 1]!.winRate
  ));
  if (results.some((result) => !result.pass) || !overallOrdered) {
    throw new Error(
      `AI level evaluation failed: adjacent levels must win at least ${(threshold * 100).toFixed(1)}%, `
      + `and overall round-robin win rates must strictly increase from L1 to L${normalizedMax}.`,
    );
  }
  return results;
}
