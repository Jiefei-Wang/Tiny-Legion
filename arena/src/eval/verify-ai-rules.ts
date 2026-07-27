import assert from "node:assert/strict";
import { loadLeaderboardScenario } from "../config/leaderboard-scenario.ts";
import { compareMatchResult } from "../match/match-comparison.ts";
import { levelCompositeConfig } from "../ai/composite-controller.ts";
import { runMatch } from "../match/run-match.ts";
import {
  AI_COMPARISON_BATTLEFIELD_HEIGHT,
  AI_COMPARISON_BATTLEFIELD_WIDTH,
  AI_COMPARISON_BASE_WORTH_UNITS,
  AI_COMPARISON_GROUND_HEIGHT,
  AI_COMPARISON_MAX_SIM_SECONDS,
  AI_COMPARISON_UNITS_PER_SIDE,
  TEST_ARENA_BASE_HP,
  TEST_ARENA_NODE_DEFENSE,
} from "../../../game-core/src/config/ai/arena-comparison.ts";
import {
  adjacentLevelDestroyRatio,
  AI_LEVEL_MIN_DESTROY_RATIO,
  AI_LEVEL_CERTIFICATION_SERIES,
} from "./evaluate-ai-levels.ts";
import {
  hasEnemyWithinAwareness,
} from "../../../game-core/src/ai/composite/level-modules.ts";
import {
  borderRecoveryVector,
  createCertifiedLevelMovementAi,
  createCertifiedLevelTargetAi,
} from "../../../game-core/src/ai/composite/certified-level-modules.ts";
import { createCompositeAiController } from "../../../game-core/src/ai/composite/composite-ai.ts";
import type { MatchResult } from "../match/match-types.ts";
import type { MatchAiSpec } from "../match/match-types.ts";
import type { BattleAiInput, TargetDecision } from "../../../game-core/src/ai/composite/composite-ai.ts";
import type { Projectile, UnitInstance } from "../../../game-core/src/types.ts";

function result(overrides: {
  playerBaseHp?: number;
  enemyBaseHp?: number;
  playerDestroyed?: number;
  enemyDestroyed?: number;
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
      },
      enemy: {
        destroyedObjects: overrides.enemyDestroyed ?? 0,
      },
    },
    performance: {
      destroyedByPlayer: overrides.destroyedByPlayer ?? overrides.enemyDestroyed ?? 0,
      destroyedByEnemy: overrides.destroyedByEnemy ?? overrides.playerDestroyed ?? 0,
      playerDestroyedRatio: 0,
      enemyDestroyedRatio: 0,
    },
    sides: {
      player: { win: false, tie: true },
      enemy: { win: false, tie: true },
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
    levelCompositeConfig(level).target.familyId,
    `certified-level-${level}-target`,
    `built-in Level ${level} must use the explicit certified target module`,
  );
  assert.equal(
    levelCompositeConfig(level).movement.familyId,
    `certified-level-${level}-movement`,
    `built-in Level ${level} must use the explicit certified movement module`,
  );
  assert.equal(
    levelCompositeConfig(level).shoot.familyId,
    `unified-level-${level}-shoot`,
    `built-in Level ${level} must use the calibrated unified shooting core`,
  );
}

function testUnit(id: string, side: "player" | "enemy", type: "ground" | "air", x: number, y: number): UnitInstance {
  return {
    id, templateId: 1, side, type, name: id, facing: 1, x, y, fixedX: null, fixedY: null,
    vx: 0, vy: 0, accel: 100, maxSpeed: 100, turnDrag: 0.9, radius: 24,
    structure: [{ id: 1, x: 0, y: 0, mass: 1, armor: 0, breakThreshold: 100, recoverPerSecond: 0, strain: 0, destroyed: false }],
    attachments: [{ id: 1, component: "control", x: 0, y: 0, alive: true, attachedStructureCellIds: [1] }],
    controlAttachmentId: 1, weaponAttachmentIds: [2], selectedWeaponIndex: 0,
    weaponManualControl: [false], weaponAutoFire: [true], weaponFireTimers: [0], weaponAimAngles: [0],
    weaponReadyCharges: [1], weaponLoadTimers: [0], loaderStates: [], deploymentGasCost: 0,
    returnedToBase: false, escapeActive: false, escapeFacingDelayS: 0, targetHistory: [], targetHistorySampleTimerS: 0,
    aiTimer: 0, aiState: "engage", aiStateTimer: 0, aiDodgeCooldown: 0, aiLastThreatDirX: 0, aiLastThreatDirY: 0,
    aiDebugTargetId: null, aiDebugShouldEvade: false, aiDebugLastAngleRad: 0, aiDebugLastRange: 0,
    aiDebugDecisionPath: "", aiDebugFireBlockReason: null, aiDebugPreferredWeaponSlot: -1, aiDebugLeadTimeS: 0,
    aiWeaponCycleIndex: 0, controlImpairTimer: 0, controlImpairFactor: 1, airDropActive: false, airDropTargetY: y,
    groundWreckTimerS: null, groundWreckInitialCellHp: [], alive: true, vibrate: 0, mass: 10,
  } as unknown as UnitInstance;
}

function testInput(unit: UnitInstance, enemies: UnitInstance[], projectiles: Projectile[] = []): BattleAiInput {
  return {
    unit,
    state: { units: [unit, ...enemies], projectiles } as BattleAiInput["state"],
    dt: 0.1,
    desiredRange: 400,
    baseTarget: { x: 1400, y: 600 },
    battlefield: {
      width: 1500,
      height: 1500,
      laneBounds: { airMinZ: 120, airMaxZ: 850, groundMinY: 900, groundMaxY: 1492 },
    },
    canShootAtAngle: () => true,
    getEffectiveWeaponRange: (range) => range,
    getWeaponFireInput: () => ({
      componentId: "rapidGun", projectileClass: "bullet", damage: 10, penetration: 10, spreadDeg: 0,
      explosiveBlastRadius: 0, trackingTurnRateDegPerSec: 0, effectiveRange: 500, projectileSpeed: 900,
      projectileGravity: 0, firepointX: unit.x, firepointY: unit.y, projectileOriginBaseX: unit.x,
      projectileOriginBaseY: unit.y, projectileOriginForwardOffset: 0, cooldownS: 1, minimumFireIntervalS: 0,
      maximumAmmo: 1, loadedAmmo: 1, requiresLoader: false,
    }),
  };
}

function testProjectile(x: number, y: number, vx: number, vy: number): Projectile {
  return {
    x, y, prevX: x, prevY: y, vx, vy, traveledDistance: 0, maxDistance: 2_000, hitPartKeys: [],
    intendedTargetX: 0, intendedTargetY: 0, axisY: 0, allowAirPierce: false, gravity: 0,
    projectileClass: "bullet", projectileShape: "round", projectileSizeRatio: 1, visualHeight: 4,
    capsuleCenterX: 0, capsuleCenterY: 0, capsuleHalfLength: 1, capsuleRadius: 2,
    explosiveBlastRadius: 0, explosiveBlastDamage: 0, explosiveFalloffPower: 1,
    controlImpairFactor: 1, controlImpairDuration: 0, homingTargetId: null, homingAimX: 0, homingAimY: 0,
    homingTurnRateDegPerSec: 0, ttl: 5, sourceId: "enemy-shot", side: "enemy", sourceUnitType: "ground",
    fireOriginY: y, initialVy: vy, sourceWeaponAttachmentId: null, damage: 20, currentDamage: 20,
    hitImpulse: 0, initialPenetration: 1, remainingPenetration: 1, r: 3,
  } as unknown as Projectile;
}

const edgeUnit = testUnit("edge", "player", "ground", 20, 1100);
const edgeInput = testInput(edgeUnit, [testUnit("edge-enemy", "enemy", "ground", 1200, 1100)]);
assert.equal(borderRecoveryVector(edgeInput, 2.9).strength, 0, "border transit must remain unrestricted during the grace period");
assert.ok(borderRecoveryVector(edgeInput, 6).x > 0, "sustained left-edge exposure must prefer the interior");

const farEnemy = testUnit("far", "enemy", "ground", 1250, 1100);
const nearEnemy = testUnit("near", "enemy", "ground", 650, 1100);
const targetUnit = testUnit("targeter", "player", "ground", 500, 1100);
const targetAi = createCertifiedLevelTargetAi(5);
const firstTarget = targetAi.decideTarget(testInput(targetUnit, [farEnemy]));
assert.equal(firstTarget.rankedTargets[0]?.targetId, "far");
targetUnit.aiStateTimer = 0.2;
const splitTarget = targetAi.decideTarget(testInput(targetUnit, [farEnemy, nearEnemy]));
assert.equal(splitTarget.rankedTargets[0]?.targetId, "near", "nearby engageable enemies must lead the fire list");
assert.equal(splitTarget.attackPoint.x, farEnemy.x, "the committed movement target must survive an ordinary local fire opportunity");

const groundDodger = testUnit("ground-dodger", "player", "ground", 500, 1100);
const groundMovement = createCertifiedLevelMovementAi(3).decideMovement(
  testInput(groundDodger, [farEnemy], [testProjectile(400, 1100, 100, 0)]),
  { rankedTargets: [{ targetId: farEnemy.id, score: 0, x: farEnemy.x, y: farEnemy.y, vx: 0, vy: 0, type: farEnemy.type }], attackPoint: { x: farEnemy.x, y: farEnemy.y }, debugTag: "test" },
);
assert.ok(Math.abs(groundMovement.ay) > Math.abs(groundMovement.ax), "ground craft must prefer vertical projectile evasion");

const airDodger = testUnit("air-dodger", "player", "air", 500, 500);
const airMovement = createCertifiedLevelMovementAi(3).decideMovement(
  testInput(airDodger, [farEnemy], [testProjectile(500, 400, 0, 100)]),
  { rankedTargets: [{ targetId: farEnemy.id, score: 0, x: farEnemy.x, y: farEnemy.y, vx: 0, vy: 0, type: farEnemy.type }], attackPoint: { x: farEnemy.x, y: farEnemy.y }, debugTag: "test" },
);
assert.ok(Math.abs(airMovement.ax) > 0.5, "aircraft must be able to evade horizontally against a vertical projectile");

let faceLeft = false;
const facingUnit = testUnit("facing", "player", "ground", 500, 1100);
const facingController = createCompositeAiController({
  target: { decideTarget: () => ({ rankedTargets: [], attackPoint: { x: faceLeft ? 0 : 1000, y: 1100 }, debugTag: "facing-test" }) },
  movement: { decideMovement: () => ({ ax: 0, ay: 0, shouldEvade: false, state: "engage", debugTag: "facing-test" }) },
  shoot: { decideShoot: () => ({ firePlan: null, fireBlockedReason: "test", debugTag: "facing-test" }) },
});
assert.equal(facingController.decide(testInput(facingUnit, [])).facing, 1);
faceLeft = true;
facingUnit.aiStateTimer = 0.1;
assert.equal(facingController.decide(testInput(facingUnit, [])).facing, 1, "facing must not flip inside the hold interval");
facingUnit.aiStateTimer = 0.6;
assert.equal(facingController.decide(testInput(facingUnit, [])).facing, -1, "facing may change after the hold interval");

const destroyedCountResult = compareMatchResult(result({ destroyedByPlayer: 12, destroyedByEnemy: 7 }));
assert.equal(destroyedCountResult.outcomeA, 1, "the AI that destroys more weighted units must win");
assert.equal(destroyedCountResult.decidingMetric, "destroyed-units");
assert.equal(destroyedCountResult.destroyedByA, 12);
assert.equal(destroyedCountResult.destroyedByB, 7);
assert.equal(destroyedCountResult.ratioA, 12 / 7);
assert.equal(adjacentLevelDestroyRatio(11, 10), AI_LEVEL_MIN_DESTROY_RATIO);
assert.equal(adjacentLevelDestroyRatio(10, 10), 1);
assert.equal(AI_LEVEL_CERTIFICATION_SERIES, 16, "manual leaderboard rounds retain sixteen deterministic seeds");

const scenario = loadLeaderboardScenario();
assert.equal(scenario.initialUnitsPerSide, 0);
assert.equal(scenario.unitsPerSide, AI_COMPARISON_UNITS_PER_SIDE);
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
    width: AI_COMPARISON_BATTLEFIELD_WIDTH,
    height: AI_COMPARISON_BATTLEFIELD_HEIGHT,
    groundHeight: AI_COMPARISON_GROUND_HEIGHT,
  },
  "leaderboard certification must use the authored AI-comparison battlefield dimensions",
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
    maintainUnitsPerSide: scenario.unitsPerSide,
  },
  templateNames: scenario.templateNames,
  battlefield: scenario.battlefield,
  spawnMode: "mirrored-random",
  baseWorthUnits: scenario.baseWorthUnits,
});
assert.equal(paritySmoke.final.playerOperationalUnits, AI_COMPARISON_UNITS_PER_SIDE);
assert.equal(paritySmoke.final.enemyOperationalUnits, AI_COMPARISON_UNITS_PER_SIDE);

console.log("AI rule verification passed.");
