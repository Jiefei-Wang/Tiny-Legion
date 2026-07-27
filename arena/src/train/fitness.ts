import type { MatchResult } from "../match/match-types.ts";

export type Aggregate = {
  games: number;
  wins: number;
  ties: number;
  losses: number;
  destroyedBySide: number;
  destroyedByOpponent: number;
  avgDestroyedMargin: number;
};

export function aggregateResults(results: MatchResult[]): Aggregate {
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let destroyedBySide = 0;
  let destroyedByOpponent = 0;
  for (let index = 0; index < results.length; index += 1) {
    const r = results[index];
    const s = r.sides.player;
    const outcome: "win" | "tie" | "loss" = s.tie ? "tie" : s.win ? "win" : "loss";
    if (outcome === "win") {
      wins += 1;
    } else if (outcome === "tie") {
      ties += 1;
    } else {
      losses += 1;
    }
    destroyedBySide += r.performance.destroyedByPlayer;
    destroyedByOpponent += r.performance.destroyedByEnemy;
  }
  const games = results.length;
  return {
    games,
    wins,
    ties,
    losses,
    destroyedBySide,
    destroyedByOpponent,
    avgDestroyedMargin: games > 0 ? (destroyedBySide - destroyedByOpponent) / games : 0,
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
