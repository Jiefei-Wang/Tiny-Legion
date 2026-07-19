import { baselineCompositeConfig, skillTierCompositeConfig, type CompositeConfig } from "../ai/composite-controller.ts";
import { runMatch } from "../match/run-match.ts";
import type { MatchAiSpec, MatchSpec } from "../match/match-types.ts";

type TierName = "baseline" | "low" | "medium" | "high";

const tierConfig = (tier: TierName): CompositeConfig => tier === "baseline" ? baselineCompositeConfig() : skillTierCompositeConfig(tier);
const aiSpec = (tier: TierName): MatchAiSpec => ({ familyId: "composite", params: {}, composite: tierConfig(tier) });

function matchSpec(seed: number, player: TierName, enemy: TierName): MatchSpec {
  return {
    seed,
    maxSimSeconds: 120,
    nodeDefense: 1,
    baseHp: 1200,
    playerGas: 3000,
    enemyGas: 3000,
    aiPlayer: aiSpec(player),
    aiEnemy: aiSpec(enemy),
    scenario: { withBase: true, initialUnitsPerSide: 2 },
    battlefield: { width: 2000, height: 1000, groundHeight: 760 },
    spawnMode: "mirrored-random",
    spawnBurst: 1,
    spawnMaxActive: 4,
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
      const asPlayer = await runMatch(matchSpec(seed, pair.higher, pair.lower));
      const asEnemy = await runMatch(matchSpec(seed, pair.lower, pair.higher));
      const higherScore = asPlayer.sides.player.score + asEnemy.sides.enemy.score;
      const lowerScore = asPlayer.sides.enemy.score + asEnemy.sides.player.score;
      if (higherScore > lowerScore) wins += 1;
      else if (higherScore === lowerScore) ties += 1;
    }
    const winRate = wins / games;
    const pass = winRate >= 0.8;
    failed ||= !pass;
    console.log(`${pair.higher} vs ${pair.lower}: ${wins}/${games} mirrored-series wins, ${ties} ties, ${(winRate * 100).toFixed(1)}% — ${pass ? "PASS" : "FAIL"}`);
  }
  if (failed) throw new Error("AI tier evaluation failed: every higher tier must win at least 80% of games against the adjacent tier.");
}
