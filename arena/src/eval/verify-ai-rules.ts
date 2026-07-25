import assert from "node:assert/strict";
import { loadLeaderboardScenario } from "../config/leaderboard-scenario.ts";
import { compareMirroredSeries } from "../match/mirrored-series.ts";
import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  DEFAULT_GROUND_HEIGHT,
} from "../../../game-core/src/config/balance/battlefield.ts";
import { hasEnemyWithinAwareness } from "../../../game-core/src/ai/composite/level-modules.ts";
import type { MatchResult } from "../match/match-types.ts";

function result(overrides: {
  playerBaseHp?: number;
  enemyBaseHp?: number;
  playerDestroyed?: number;
  enemyDestroyed?: number;
  playerGasWasted?: number;
  enemyGasWasted?: number;
}): MatchResult {
  return {
    final: {
      playerBaseHp: overrides.playerBaseHp ?? 1_000,
      enemyBaseHp: overrides.enemyBaseHp ?? 1_000,
      playerOperationalUnits: 1,
      enemyOperationalUnits: 1,
      playerUnitIntegrity: 1,
      enemyUnitIntegrity: 1,
    },
    losses: {
      player: {
        destroyedObjects: overrides.playerDestroyed ?? 0,
        gasWasted: overrides.playerGasWasted ?? 0,
      },
      enemy: {
        destroyedObjects: overrides.enemyDestroyed ?? 0,
        gasWasted: overrides.enemyGasWasted ?? 0,
      },
    },
    sides: {
      player: { gasWorthDelta: 0 },
      enemy: { gasWorthDelta: 0 },
    },
  } as MatchResult;
}

assert.equal(
  hasEnemyWithinAwareness(0, 0, 600, [{ x: 450, y: 0 }]),
  true,
  "a nearby enemy must suppress base engagement",
);
assert.equal(
  hasEnemyWithinAwareness(0, 0, 600, [{ x: 601, y: 0 }]),
  false,
  "the base may be considered when every enemy is outside awareness",
);

const baseRusherAsPlayer = result({
  playerBaseHp: 1_000,
  enemyBaseHp: 0,
  playerGasWasted: 500,
  enemyGasWasted: 0,
});
const baseRusherAsEnemy = result({
  playerBaseHp: 0,
  enemyBaseHp: 1_000,
  playerGasWasted: 0,
  enemyGasWasted: 500,
});
const craftFirst = compareMirroredSeries(baseRusherAsPlayer, baseRusherAsEnemy);
assert.equal(craftFirst.outcomeA, -1, "base rushing must not outweigh losing more craft value");
assert.equal(craftFirst.decidingMetric, "destroyed-gas");

const craftCountFirst = compareMirroredSeries(
  result({ playerBaseHp: 1_000, enemyBaseHp: 0, playerDestroyed: 2, enemyDestroyed: 1 }),
  result({ playerBaseHp: 0, enemyBaseHp: 1_000, playerDestroyed: 1, enemyDestroyed: 2 }),
);
assert.equal(craftCountFirst.outcomeA, -1, "craft destruction count must precede base HP");
assert.equal(craftCountFirst.decidingMetric, "destroyed-craft");

const scenario = loadLeaderboardScenario();
assert.deepEqual(
  scenario.battlefield,
  {
    width: BATTLEFIELD_WIDTH,
    height: BATTLEFIELD_HEIGHT,
    groundHeight: DEFAULT_GROUND_HEIGHT,
  },
  "leaderboard certification must use the same authored battlefield defaults as Test Arena",
);

console.log("AI rule verification passed.");
