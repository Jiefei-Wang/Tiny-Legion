import { baselineCompositeConfig, skillTierCompositeConfig, type CompositeConfig } from "../ai/composite-controller.ts";
import { loadLeaderboardScenario } from "../config/leaderboard-scenario.ts";
import { runMatch } from "../match/run-match.ts";
import { compareMatchResult } from "../match/match-comparison.ts";
import type { MatchAiSpec, MatchSpec } from "../match/match-types.ts";

type TierName = "baseline" | "low" | "medium" | "high";

const tierConfig = (tier: TierName): CompositeConfig => tier === "baseline" ? baselineCompositeConfig() : skillTierCompositeConfig(tier);
const aiSpec = (tier: TierName): MatchAiSpec => ({ familyId: "composite", params: {}, composite: tierConfig(tier) });

function matchSpec(seed: number, player: TierName, enemy: TierName): MatchSpec {
  const scenario = loadLeaderboardScenario();
  return {
    seed,
    maxSimSeconds: scenario.maxSimSeconds,
    nodeDefense: scenario.nodeDefense,
    baseHp: scenario.baseHp,
    playerGas: scenario.playerGas,
    enemyGas: scenario.enemyGas,
    aiPlayer: aiSpec(player),
    aiEnemy: aiSpec(enemy),
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

export async function evaluateAiTiers(seedCount = 10): Promise<void> {
  const pairs: Array<{ lower: TierName; higher: TierName }> = [
    { lower: "baseline", higher: "low" },
    { lower: "low", higher: "medium" },
    { lower: "medium", higher: "high" },
  ];
  let failed = false;
  for (const pair of pairs) {
    let wins = 0;
    let ties = 0;
    const games = Math.max(2, Math.floor(seedCount));
    for (let index = 0; index < games; index += 1) {
      const seed = 40_000 + index * 977;
      const result = await runMatch(matchSpec(seed, pair.higher, pair.lower));
      const comparison = compareMatchResult(result);
      wins += Number(comparison.outcomeA > 0);
      ties += Number(comparison.outcomeA === 0);
    }
    const winRate = wins / games;
    const pass = winRate > 0.8;
    failed ||= !pass;
    console.log(`${pair.higher} vs ${pair.lower}: ${wins}/${games} wins, ${ties} ties, ${(winRate * 100).toFixed(1)}% — ${pass ? "PASS" : "FAIL"}`);
  }
  if (failed) throw new Error("AI tier evaluation failed: every higher tier must win more than 80% of leaderboard games against the adjacent tier.");
}
