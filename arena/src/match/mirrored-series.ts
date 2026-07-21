import type { MatchResult } from "./match-types.ts";

export type MirroredSeriesComparison = {
  outcomeA: -1 | 0 | 1;
  decidingMetric: "base-hp" | "unit-integrity" | "operational-units" | "gas-worth" | "tie";
  margin: number;
};

/**
 * Compare model A over two games: A as player, then A as enemy. Side-swapping
 * removes battlefield-side bias while the ordered tie-breaks preserve combat
 * margin information that a pair of opposite binary wins would discard.
 */
export function compareMirroredSeries(aAsPlayer: MatchResult, aAsEnemy: MatchResult): MirroredSeriesComparison {
  const comparisons: Array<{ metric: MirroredSeriesComparison["decidingMetric"]; margin: number }> = [
    {
      metric: "base-hp",
      margin: (aAsPlayer.final.playerBaseHp - aAsPlayer.final.enemyBaseHp)
        + (aAsEnemy.final.enemyBaseHp - aAsEnemy.final.playerBaseHp),
    },
    {
      metric: "unit-integrity",
      margin: (aAsPlayer.final.playerUnitIntegrity - aAsPlayer.final.enemyUnitIntegrity)
        + (aAsEnemy.final.enemyUnitIntegrity - aAsEnemy.final.playerUnitIntegrity),
    },
    {
      metric: "operational-units",
      margin: (aAsPlayer.final.playerOperationalUnits - aAsPlayer.final.enemyOperationalUnits)
        + (aAsEnemy.final.enemyOperationalUnits - aAsEnemy.final.playerOperationalUnits),
    },
    {
      metric: "gas-worth",
      margin: (aAsPlayer.sides.player.gasWorthDelta - aAsPlayer.sides.enemy.gasWorthDelta)
        + (aAsEnemy.sides.enemy.gasWorthDelta - aAsEnemy.sides.player.gasWorthDelta),
    },
  ];
  for (const comparison of comparisons) {
    if (Math.abs(comparison.margin) > 1e-6) {
      return {
        outcomeA: comparison.margin > 0 ? 1 : -1,
        decidingMetric: comparison.metric,
        margin: comparison.margin,
      };
    }
  }
  return { outcomeA: 0, decidingMetric: "tie", margin: 0 };
}
