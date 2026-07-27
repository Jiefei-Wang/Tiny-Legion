import type { MatchResult } from "./match-types.ts";

export type MatchComparison = {
  outcomeA: -1 | 0 | 1;
  decidingMetric: "destroyed-units" | "tie";
  margin: number;
  destroyedByA: number;
  destroyedByB: number;
  ratioA: number;
  ratioB: number;
};

/** Compare model A (Player) with model B (Enemy) in one symmetric match. */
export function compareMatchResult(result: MatchResult): MatchComparison {
  const destroyedByA = result.performance.destroyedByPlayer;
  const destroyedByB = result.performance.destroyedByEnemy;
  const margin = destroyedByA - destroyedByB;
  return {
    outcomeA: margin > 0 ? 1 : margin < 0 ? -1 : 0,
    decidingMetric: margin === 0 ? "tie" : "destroyed-units",
    margin,
    destroyedByA,
    destroyedByB,
    ratioA: destroyedByA / Math.max(1, destroyedByB),
    ratioB: destroyedByB / Math.max(1, destroyedByA),
  };
}
