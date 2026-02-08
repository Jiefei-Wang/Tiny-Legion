import type { MatchResult } from "../match/match-types.ts";

export type Aggregate = {
  games: number;
  wins: number;
  ties: number;
  losses: number;
  avgGasWorthDelta: number;
  score: number;
};

export function scoreForSide(outcome: "win" | "tie" | "loss", gasWorthDelta: number): number {
  const O = outcome === "win" ? 2 : outcome === "tie" ? 1 : 0;
  return O * 1_000_000 + gasWorthDelta;
}

export function aggregateResults(results: MatchResult[], candidateSideForEach: (r: MatchResult) => "player" | "enemy"): Aggregate {
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let sumGas = 0;
  let sumScore = 0;
  for (const r of results) {
    const side = candidateSideForEach(r);
    const s = r.sides[side];
    const outcome: "win" | "tie" | "loss" = s.tie ? "tie" : s.win ? "win" : "loss";
    if (outcome === "win") {
      wins += 1;
    } else if (outcome === "tie") {
      ties += 1;
    } else {
      losses += 1;
    }
    sumGas += s.gasWorthDelta;
    sumScore += scoreForSide(outcome, s.gasWorthDelta);
  }
  const games = results.length;
  return {
    games,
    wins,
    ties,
    losses,
    avgGasWorthDelta: games > 0 ? sumGas / games : 0,
    score: games > 0 ? sumScore / games : 0,
  };
}

export function wilsonLowerBound(wins: number, games: number, z = 1.96): number {
  if (games <= 0) {
    return 0;
  }
  const phat = wins / games;
  const denom = 1 + (z * z) / games;
  const center = phat + (z * z) / (2 * games);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * games)) / games);
  return (center - margin) / denom;
}
