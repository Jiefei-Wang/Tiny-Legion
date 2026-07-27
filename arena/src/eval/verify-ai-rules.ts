import assert from "node:assert/strict";
import { loadLeaderboardScenario } from "../config/leaderboard-scenario.ts";
import { compareMatchResult } from "../match/match-comparison.ts";
import { levelCompositeConfig } from "../ai/composite-controller.ts";
import { runMatch } from "../match/run-match.ts";
import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  DEFAULT_GROUND_HEIGHT,
} from "../../../game-core/src/config/balance/battlefield.ts";
import {
  AI_COMPARISON_BASE_WORTH_UNITS,
  AI_COMPARISON_MAX_SIM_SECONDS,
  AI_COMPARISON_SPAWN_COUNT_PER_SIDE,
  AI_COMPARISON_SPAWN_INTERVAL_SECONDS,
  TEST_ARENA_BASE_HP,
  TEST_ARENA_NODE_DEFENSE,
} from "../../../game-core/src/config/ai/arena-comparison.ts";
import {
  hasEnemyWithinAwareness,
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
  destroyedByPlayer?: number;
  destroyedByEnemy?: number;
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
    performance: {
      destroyedByPlayer: overrides.destroyedByPlayer ?? overrides.enemyDestroyed ?? 0,
      destroyedByEnemy: overrides.destroyedByEnemy ?? overrides.playerDestroyed ?? 0,
      playerDestroyedRatio: 0,
      enemyDestroyedRatio: 0,
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

for (let level = 1; level <= 5; level += 1) {
  assert.equal(
    levelCompositeConfig(level).shoot.familyId,
    `unified-level-${level}-shoot`,
    `built-in Level ${level} must use the calibrated unified shooting core`,
  );
}

const destroyedCountResult = compareMatchResult(result({ destroyedByPlayer: 12, destroyedByEnemy: 7 }));
assert.equal(destroyedCountResult.outcomeA, 1, "the AI that destroys more weighted units must win");
assert.equal(destroyedCountResult.decidingMetric, "destroyed-units");
assert.equal(destroyedCountResult.destroyedByA, 12);
assert.equal(destroyedCountResult.destroyedByB, 7);
assert.equal(destroyedCountResult.ratioA, 12 / 7);

const scenario = loadLeaderboardScenario();
assert.equal(scenario.initialUnitsPerSide, 0);
assert.equal(scenario.scheduledMirroredWaves, true);
assert.equal(scenario.spawnBurst, AI_COMPARISON_SPAWN_COUNT_PER_SIDE);
assert.equal(scenario.spawnIntervalSeconds, AI_COMPARISON_SPAWN_INTERVAL_SECONDS);
assert.equal(scenario.maxSimSeconds, AI_COMPARISON_MAX_SIM_SECONDS);
assert.equal(scenario.baseWorthUnits, AI_COMPARISON_BASE_WORTH_UNITS);
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
    scheduledMirroredWaves: scenario.scheduledMirroredWaves,
  },
  templateNames: scenario.templateNames,
  battlefield: scenario.battlefield,
  spawnMode: "mirrored-random",
  spawnBurst: scenario.spawnBurst,
  spawnIntervalSeconds: scenario.spawnIntervalSeconds,
  baseWorthUnits: scenario.baseWorthUnits,
});
assert.equal(paritySmoke.final.playerOperationalUnits, AI_COMPARISON_SPAWN_COUNT_PER_SIDE);
assert.equal(paritySmoke.final.enemyOperationalUnits, AI_COMPARISON_SPAWN_COUNT_PER_SIDE);

console.log("AI rule verification passed.");
