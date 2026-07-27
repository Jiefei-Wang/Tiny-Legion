import assert from "node:assert/strict";
import { loadLeaderboardScenario } from "../config/leaderboard-scenario.ts";
import { compareMirroredSeries } from "../match/mirrored-series.ts";
import { levelCompositeConfig } from "../ai/composite-controller.ts";
import { runMatch } from "../match/run-match.ts";
import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  DEFAULT_GROUND_HEIGHT,
} from "../../../game-core/src/config/balance/battlefield.ts";
import {
  AI_COMPARISON_ACTIVE_UNITS_PER_SIDE,
  AI_COMPARISON_MAX_SIM_SECONDS,
  TEST_ARENA_BASE_HP,
  TEST_ARENA_NODE_DEFENSE,
} from "../../../game-core/src/config/ai/arena-comparison.ts";
import {
  hasEnemyWithinAwareness,
  isImmediateLoadedKillOpportunity,
  shouldPreferImmediateKillTarget,
} from "../../../game-core/src/ai/composite/level-modules.ts";
import type { MatchResult } from "../match/match-types.ts";
import type { MatchAiSpec } from "../match/match-types.ts";

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

assert.equal(
  isImmediateLoadedKillOpportunity(180, 400, 2, 3),
  true,
  "L5 should recognize a nearby target disableable by the loaded magazine",
);
assert.equal(
  isImmediateLoadedKillOpportunity(180, 400, 4, 3),
  false,
  "L5 should not classify a target as an immediate loaded kill when reload is required",
);
assert.equal(
  shouldPreferImmediateKillTarget(true, 900, 180),
  true,
  "L5 should fire at a much closer kill opportunity even when the remote target is reachable",
);
assert.equal(
  shouldPreferImmediateKillTarget(true, 220, 180),
  false,
  "L5 should preserve a similarly close strategic target",
);

assert.equal(
  levelCompositeConfig(5).shoot.familyId,
  "level-93-shoot",
  "built-in Level 5 must use per-weapon strategic-target intercept fallback",
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
assert.equal(scenario.initialUnitsPerSide, AI_COMPARISON_ACTIVE_UNITS_PER_SIDE);
assert.equal(scenario.maintainUnitsPerSide, AI_COMPARISON_ACTIVE_UNITS_PER_SIDE);
assert.equal(scenario.spawnMaxActive, AI_COMPARISON_ACTIVE_UNITS_PER_SIDE);
assert.equal(scenario.maxSimSeconds, AI_COMPARISON_MAX_SIM_SECONDS);
assert.equal(scenario.nodeDefense, TEST_ARENA_NODE_DEFENSE);
assert.equal(scenario.baseHp, TEST_ARENA_BASE_HP);
assert.equal(scenario.playerGas, 0);
assert.equal(scenario.enemyGas, 0);
assert.deepEqual(scenario.templateNames, ["*"], "AI comparison must admit every valid runtime template");
assert.deepEqual(
  scenario.battlefield,
  {
    width: BATTLEFIELD_WIDTH,
    height: BATTLEFIELD_HEIGHT,
    groundHeight: DEFAULT_GROUND_HEIGHT,
  },
  "leaderboard certification must use the same authored battlefield defaults as Test Arena",
);

const parityAi: MatchAiSpec = {
  familyId: "composite",
  params: {},
  composite: levelCompositeConfig(1),
};
const paritySmoke = await runMatch({
  seed: 42,
  maxSimSeconds: 0.05,
  nodeDefense: scenario.nodeDefense,
  baseHp: scenario.baseHp,
  playerGas: scenario.playerGas,
  enemyGas: scenario.enemyGas,
  aiPlayer: parityAi,
  aiEnemy: parityAi,
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
});
assert.equal(paritySmoke.final.playerOperationalUnits, AI_COMPARISON_ACTIVE_UNITS_PER_SIDE);
assert.equal(paritySmoke.final.enemyOperationalUnits, AI_COMPARISON_ACTIVE_UNITS_PER_SIDE);

console.log("AI rule verification passed.");
