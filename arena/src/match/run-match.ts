import type { MatchResult, MatchSpec } from "./match-types.ts";
import { setMathRandomSeed } from "../lib/seeded-rng.ts";
import { loadRuntimeMergedTemplates } from "./templates.ts";
import { mulberry32 } from "../lib/seeded-rng.ts";
import { getSpawnFamily } from "../spawn/families.ts";
import {
  BATTLE_SALVAGE_REFUND_FACTOR,
  BattleSession,
} from "../../../packages/game-core/src/gameplay/battle/battle-session.ts";
import { BATTLEFIELD_HEIGHT, BATTLEFIELD_WIDTH } from "../../../packages/game-core/src/config/balance/battlefield.ts";
import { evaluateCombatDecisionTree } from "../../../packages/game-core/src/ai/decision-tree/combat-decision-tree.ts";
import { structureIntegrity } from "../../../packages/game-core/src/simulation/units/structure-grid.ts";

type GameBattleHooks = {
  addLog: (text: string, tone?: any) => void;
  getCommanderSkill: () => number;
  getPlayerGas: () => number;
  spendPlayerGas: (amount: number) => boolean;
  addPlayerGas: (amount: number) => void;
  onBattleOver: (victory: boolean, nodeId: string, reason: string) => void;
};

function createMockCanvas(width: number, height: number): any {
  const contextStub = {};
  return {
    width,
    height,
    getContext: (type: string) => (type === "2d" ? contextStub : null),
  };
}

function computeOnFieldGasValue(units: any[], side: "player" | "enemy", refundFactor: number): number {
  let sum = 0;
  for (const unit of units) {
    if (!unit || !unit.alive || unit.side !== side) {
      continue;
    }
    const cost = typeof unit.deploymentGasCost === "number" ? unit.deploymentGasCost : 0;
    const refundable = Math.floor(cost * refundFactor);
    if (refundable > 0) {
      sum += refundable;
    }
  }
  return sum;
}

function scoreFor(outcome: "win" | "tie" | "loss", gasWorthDelta: number): number {
  const O = outcome === "win" ? 2 : outcome === "tie" ? 1 : 0;
  return O * 1_000_000 + gasWorthDelta;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export async function runMatch(spec: MatchSpec): Promise<MatchResult> {
  setMathRandomSeed(spec.seed);
  const templates = await loadRuntimeMergedTemplates();
  const templateById = new Map<string, any>(templates.map((t: any) => [String(t.id), t] as const));
  const refundFactor = BATTLE_SALVAGE_REFUND_FACTOR;

  let playerGas = spec.playerGas;
  const logs: string[] = [];
  const hooks: GameBattleHooks = {
    addLog: (text: string) => {
      logs.push(text);
    },
    getCommanderSkill: () => 10,
    getPlayerGas: () => playerGas,
    spendPlayerGas: (amount) => {
      if (playerGas < amount) {
        return false;
      }
      playerGas -= amount;
      return true;
    },
    addPlayerGas: (amount) => {
      playerGas += amount;
    },
    onBattleOver: () => {
      return;
    },
  };

  const aiForSide = (side: "player" | "enemy"): any => {
    const aiSpec = side === "player" ? spec.aiPlayer : spec.aiEnemy;
    const kind = aiSpec.familyId;

    if (kind === "baseline") {
      return {
        decide: (input: any) =>
          evaluateCombatDecisionTree(
            input.unit,
            input.state,
            input.dt,
            input.desiredRange,
            input.baseTarget,
            input.canShootAtAngle,
            input.getEffectiveWeaponRange,
          ),
      };
    }

    if (kind === "range-bias") {
      const rangeFactor = typeof aiSpec.params.rangeFactor === "number" ? aiSpec.params.rangeFactor : 0.72;
      return {
        decide: (input: any) =>
          evaluateCombatDecisionTree(
            input.unit,
            input.state,
            input.dt,
            Math.max(40, input.desiredRange * rangeFactor),
            input.baseTarget,
            input.canShootAtAngle,
            input.getEffectiveWeaponRange,
          ),
      };
    }

    if (kind === "evade-bias") {
      const lowIntegrityThreshold = typeof aiSpec.params.lowIntegrityThreshold === "number" ? aiSpec.params.lowIntegrityThreshold : 0.24;
      const evadePush = typeof aiSpec.params.evadePush === "number" ? aiSpec.params.evadePush : 0.9;
      return {
        decide: (input: any) => {
          const decision = evaluateCombatDecisionTree(
            input.unit,
            input.state,
            input.dt,
            input.desiredRange,
            input.baseTarget,
            input.canShootAtAngle,
            input.getEffectiveWeaponRange,
          );
          const integrity = structureIntegrity(input.unit);
          if (integrity < lowIntegrityThreshold) {
            const dx = input.unit.side === "player" ? input.unit.x - input.baseTarget.x : input.unit.x - input.baseTarget.x;
            const dy = input.unit.y - input.baseTarget.y;
            const len = Math.hypot(dx, dy) || 1;
            const ax = (dx / len) * evadePush;
            const ay = (dy / len) * evadePush * 0.7;
            return {
              ...decision,
              state: "evade",
              movement: { ax, ay, shouldEvade: true },
              firePlan: null,
              debug: {
                ...decision.debug,
                decisionPath: `${decision.debug.decisionPath} > arena.evasion`,
              },
            };
          }
          return decision;
        },
      };
    }

    if (kind === "aggressive-rush") {
      const rangeFactor = typeof aiSpec.params.rangeFactor === "number" ? aiSpec.params.rangeFactor : 0.52;
      const forwardBias = typeof aiSpec.params.forwardBias === "number" ? aiSpec.params.forwardBias : 0.7;
      const evadeThreshold = typeof aiSpec.params.evadeThreshold === "number" ? aiSpec.params.evadeThreshold : 0.18;
      const evadePush = typeof aiSpec.params.evadePush === "number" ? aiSpec.params.evadePush : 0.55;
      return {
        decide: (input: any) => {
          const decision = evaluateCombatDecisionTree(
            input.unit,
            input.state,
            input.dt,
            Math.max(30, input.desiredRange * rangeFactor),
            input.baseTarget,
            input.canShootAtAngle,
            input.getEffectiveWeaponRange,
          );
          const integrity = structureIntegrity(input.unit);
          const toBaseX = input.baseTarget.x - input.unit.x;
          const toBaseY = input.baseTarget.y - input.unit.y;
          const len = Math.hypot(toBaseX, toBaseY) || 1;
          const rushAx = (toBaseX / len) * forwardBias;
          const rushAy = (toBaseY / len) * forwardBias * 0.7;
          if (integrity < evadeThreshold) {
            return {
              ...decision,
              state: "evade",
              movement: { ax: -rushAx * evadePush, ay: -rushAy * evadePush, shouldEvade: true },
              firePlan: null,
              debug: {
                ...decision.debug,
                decisionPath: `${decision.debug.decisionPath} > arena.aggressive-rush.evade`,
              },
            };
          }
          return {
            ...decision,
            movement: {
              ax: decision.movement.ax + rushAx,
              ay: decision.movement.ay + rushAy,
              shouldEvade: decision.movement.shouldEvade,
            },
            debug: {
              ...decision.debug,
              decisionPath: `${decision.debug.decisionPath} > arena.aggressive-rush.push`,
            },
          };
        },
      };
    }

    if (kind === "adaptive-kite") {
      const healthyRangeFactor = typeof aiSpec.params.healthyRangeFactor === "number" ? aiSpec.params.healthyRangeFactor : 1.08;
      const damagedRangeFactor = typeof aiSpec.params.damagedRangeFactor === "number" ? aiSpec.params.damagedRangeFactor : 1.3;
      const integrityPivot = typeof aiSpec.params.integrityPivot === "number" ? aiSpec.params.integrityPivot : 0.36;
      const retreatPush = typeof aiSpec.params.retreatPush === "number" ? aiSpec.params.retreatPush : 0.95;
      return {
        decide: (input: any) => {
          const integrity = structureIntegrity(input.unit);
          const t = clamp((integrityPivot - integrity) / 0.3, 0, 1);
          const rangeFactor = healthyRangeFactor * (1 - t) + damagedRangeFactor * t;
          const decision = evaluateCombatDecisionTree(
            input.unit,
            input.state,
            input.dt,
            Math.max(40, input.desiredRange * rangeFactor),
            input.baseTarget,
            input.canShootAtAngle,
            input.getEffectiveWeaponRange,
          );
          if (integrity >= integrityPivot) {
            return decision;
          }
          const toBaseX = input.baseTarget.x - input.unit.x;
          const toBaseY = input.baseTarget.y - input.unit.y;
          const len = Math.hypot(toBaseX, toBaseY) || 1;
          return {
            ...decision,
            state: "evade",
            movement: {
              ax: decision.movement.ax - (toBaseX / len) * retreatPush,
              ay: decision.movement.ay - (toBaseY / len) * retreatPush * 0.7,
              shouldEvade: true,
            },
            firePlan: decision.firePlan,
            debug: {
              ...decision.debug,
              decisionPath: `${decision.debug.decisionPath} > arena.adaptive-kite.retreat`,
            },
          };
        },
      };
    }

    if (kind === "neural-linear") {
      const wRange = [
        Number(aiSpec.params.wr0 ?? 0),
        Number(aiSpec.params.wr1 ?? 0),
        Number(aiSpec.params.wr2 ?? 0),
        Number(aiSpec.params.wr3 ?? 0),
        Number(aiSpec.params.wr4 ?? 0),
        Number(aiSpec.params.wr5 ?? 0),
      ];
      const wEvade = [
        Number(aiSpec.params.we0 ?? 0),
        Number(aiSpec.params.we1 ?? 0),
        Number(aiSpec.params.we2 ?? 0),
        Number(aiSpec.params.we3 ?? 0),
        Number(aiSpec.params.we4 ?? 0),
        Number(aiSpec.params.we5 ?? 0),
      ];
      const bRange = Number(aiSpec.params.br ?? 0);
      const bEvade = Number(aiSpec.params.be ?? 0);
      const retreatScale = Number(aiSpec.params.retreatScale ?? 1);
      return {
        decide: (input: any) => {
          const integrity = clamp(structureIntegrity(input.unit), 0, 1);
          const distToBase = Math.hypot(input.baseTarget.x - input.unit.x, input.baseTarget.y - input.unit.y);
          const maxRangeNorm = clamp(distToBase / 900, 0, 1);
          const speedNorm = clamp(Math.hypot(input.unit.vx, input.unit.vy) / Math.max(1, input.unit.maxSpeed), 0, 1);
          const canFire = input.unit.weaponAutoFire?.some((x: boolean) => x) ? 1 : 0;
          const isAir = input.unit.type === "air" ? 1 : 0;
          const f = [1, integrity, maxRangeNorm, speedNorm, canFire, isAir];
          let zRange = bRange;
          let zEvade = bEvade;
          for (let i = 0; i < f.length; i += 1) {
            zRange += f[i] * wRange[i];
            zEvade += f[i] * wEvade[i];
          }
          const rangeFactor = 0.35 + sigmoid(zRange) * 1.25;
          const evadeProb = sigmoid(zEvade);
          const decision = evaluateCombatDecisionTree(
            input.unit,
            input.state,
            input.dt,
            Math.max(35, input.desiredRange * rangeFactor),
            input.baseTarget,
            input.canShootAtAngle,
            input.getEffectiveWeaponRange,
          );
          if (evadeProb < 0.5) {
            return decision;
          }
          const dx = input.unit.x - input.baseTarget.x;
          const dy = input.unit.y - input.baseTarget.y;
          const len = Math.hypot(dx, dy) || 1;
          const push = clamp((evadeProb - 0.5) * 2, 0, 1) * clamp(retreatScale, 0.1, 2.6);
          return {
            ...decision,
            state: "evade",
            movement: {
              ax: decision.movement.ax + (dx / len) * push,
              ay: decision.movement.ay + (dy / len) * push * 0.7,
              shouldEvade: true,
            },
            debug: {
              ...decision.debug,
              decisionPath: `${decision.debug.decisionPath} > arena.neural-linear.evade`,
            },
          };
        },
      };
    }

    if (kind === "base-rush") {
      const rangeFactor = typeof aiSpec.params.rangeFactor === "number" ? aiSpec.params.rangeFactor : 0.35;
      const basePush = typeof aiSpec.params.basePush === "number" ? aiSpec.params.basePush : 1.1;
      const yBias = typeof aiSpec.params.yBias === "number" ? aiSpec.params.yBias : 0;
      return {
        decide: (input: any) => {
          const decision = evaluateCombatDecisionTree(
            input.unit,
            input.state,
            input.dt,
            Math.max(20, input.desiredRange * rangeFactor),
            input.baseTarget,
            input.canShootAtAngle,
            input.getEffectiveWeaponRange,
          );
          const dx = input.baseTarget.x - input.unit.x;
          const dy = input.baseTarget.y - input.unit.y;
          const len = Math.hypot(dx, dy) || 1;
          return {
            ...decision,
            state: "engage",
            movement: {
              ax: decision.movement.ax + (dx / len) * basePush,
              ay: decision.movement.ay + (dy / len) * basePush * 0.7 + yBias,
              shouldEvade: false,
            },
            debug: {
              ...decision.debug,
              decisionPath: `${decision.debug.decisionPath} > arena.base-rush`,
            },
          };
        },
      };
    }

    throw new Error(`Unsupported AI family in runner: ${kind}`);
  };

  const canvas = createMockCanvas(BATTLEFIELD_WIDTH, BATTLEFIELD_HEIGHT);
  const battle = new BattleSession(canvas, hooks, templates, {
    aiControllers: {
      player: aiForSide("player"),
      enemy: aiForSide("enemy"),
    },
    autoEnableAiWeaponAutoFire: true,
    disableAutoEnemySpawns: true,
    disableEnemyMinimumPresence: true,
    disableDefaultStarters: true,
  });

  const node: Parameters<BattleSession["start"]>[0] = {
    id: "arena",
    name: "Arena",
    owner: "neutral",
    garrison: false,
    reward: 0,
    defense: spec.nodeDefense,
    ...(typeof spec.baseHp === "number" && Number.isFinite(spec.baseHp) && spec.baseHp > 0
      ? { testBaseHpOverride: spec.baseHp }
      : {}),
  };
  battle.start(node);
  battle.clearControlSelection();

  const rosterPreference = ["scout-ground", "tank-ground", "air-jet", "air-propeller", "air-light"];
  const availableTemplateIds = new Set<string>(templates.map((t: any) => String(t.id)));
  const roster = rosterPreference.filter((id) => availableTemplateIds.has(id));
  if (roster.length === 0) {
    for (const t of templates.slice(0, 6)) {
      roster.push(String(t.id));
    }
  }

  // Symmetric starters (free and non-refundable, like headless smoke test semantics).
  const starterTemplates = rosterPreference.filter((id) => availableTemplateIds.has(id)).slice(0, 2);
  for (const templateId of starterTemplates) {
    battle.arenaDeploy("player", templateId, { chargeGas: false, deploymentGasCost: 0, y: 300 });
    battle.arenaDeploy("enemy", templateId, { chargeGas: false, deploymentGasCost: 0, y: 300 });
  }

  // Override enemy gas if requested.
  const state0 = battle.getState();
  state0.enemyGas = spec.enemyGas;

  const playerGasStart = playerGas;
  const enemyGasStart = state0.enemyGas;
  const onFieldPlayerStart = computeOnFieldGasValue(state0.units, "player", refundFactor);
  const onFieldEnemyStart = computeOnFieldGasValue(state0.units, "enemy", refundFactor);

  const dt = 1 / 60;
  const noKeys = { a: false, d: false, w: false, s: false, space: false };
  let t = 0;

  const spawnMode = spec.spawnMode ?? "mirrored-random";
  const spawnBurst = Math.max(1, Math.floor(spec.spawnBurst ?? 1));
  const spawnMaxActive = Math.max(1, Math.floor(spec.spawnMaxActive ?? 5));
  const spawnRng = mulberry32((spec.seed ^ 0x2f7a1d) >>> 0);
  let spawnTimer = 0;
  let spawnIntervalS = 1.8;

  const spawnFamilyPlayer = spawnMode === "ai" && spec.spawnPlayer ? getSpawnFamily(spec.spawnPlayer.familyId) : null;
  const spawnFamilyEnemy = spawnMode === "ai" && spec.spawnEnemy ? getSpawnFamily(spec.spawnEnemy.familyId) : null;

  const pickMirrored = (): { templateId: string | null; y: number } => {
    if (roster.length === 0) {
      return { templateId: null, y: 0 };
    }
    const idx = Math.floor(spawnRng() * roster.length);
    const templateId = roster[Math.max(0, Math.min(roster.length - 1, idx))] ?? null;
    const y = 220 + spawnRng() * 260;
    return { templateId, y };
  };

  const stepSpawn = (): void => {
    if (roster.length === 0) {
      return;
    }
    const s = battle.getState();
    const alivePlayer = s.units.filter((u: any) => u.alive && u.side === "player").length;
    const aliveEnemy = s.units.filter((u: any) => u.alive && u.side === "enemy").length;
    let playerCapRemaining = Math.max(0, spawnMaxActive - alivePlayer);
    let enemyCapRemaining = Math.max(0, Math.min(s.enemyCap, spawnMaxActive) - aliveEnemy);

    if (spawnMode === "mirrored-random") {
      for (let i = 0; i < spawnBurst; i += 1) {
        const { templateId, y } = pickMirrored();
        if (!templateId) {
          continue;
        }
        const template = templateById.get(templateId) ?? null;
        const cost = template ? Number(template.gasCost ?? 0) : 0;
        if (playerCapRemaining <= 0 || enemyCapRemaining <= 0) {
          continue;
        }
        // Keep mirrored spawn truly mirrored: if either side can't pay, skip for both.
        if (playerGas < cost || s.enemyGas < cost) {
          continue;
        }
        const a = battle.arenaDeploy("player", templateId, { chargeGas: true, y, ignoreCap: true });
        const b = battle.arenaDeploy("enemy", templateId, { chargeGas: true, y, ignoreCap: true, ignoreLowGasThreshold: true });
        if (a && b) {
          playerCapRemaining -= 1;
          enemyCapRemaining -= 1;
        }
      }
      return;
    }

    let minInterval = spawnIntervalS;
    for (let i = 0; i < spawnBurst; i += 1) {
      const playerDecision = spawnFamilyPlayer
        ? spawnFamilyPlayer.pick(spec.spawnPlayer?.params ?? {}, roster, spawnRng, { gas: playerGas, capRemaining: playerCapRemaining })
        : { templateId: null, intervalS: spawnIntervalS };
      const enemyDecision = spawnFamilyEnemy
        ? spawnFamilyEnemy.pick(spec.spawnEnemy?.params ?? {}, roster, spawnRng, { gas: s.enemyGas, capRemaining: enemyCapRemaining })
        : { templateId: null, intervalS: spawnIntervalS };

      minInterval = Math.min(minInterval, playerDecision.intervalS, enemyDecision.intervalS);

      if (playerDecision.templateId && playerCapRemaining > 0) {
        const ok = battle.arenaDeploy("player", playerDecision.templateId, { chargeGas: true, ignoreCap: true });
        if (ok) {
          playerCapRemaining -= 1;
        }
      }
      if (enemyDecision.templateId && enemyCapRemaining > 0) {
        const ok = battle.arenaDeploy("enemy", enemyDecision.templateId, { chargeGas: true, ignoreCap: true, ignoreLowGasThreshold: true });
        if (ok) {
          enemyCapRemaining -= 1;
        }
      }
    }
    spawnIntervalS = Math.max(0.5, Math.min(6.0, minInterval));
  };

  while (battle.getState().active && !battle.getState().outcome && t < spec.maxSimSeconds) {
    spawnTimer += dt;
    if (spawnTimer >= spawnIntervalS) {
      spawnTimer = 0;
      stepSpawn();
    }
    battle.update(dt, noKeys);
    t += dt;
  }

  const state1 = battle.getState();
  if (state1.active && !state1.outcome) {
    const victory = state1.enemyBase.hp <= state1.playerBase.hp;
    battle.forceEnd(victory, "Arena deadline reached");
  }

  const finalState = battle.getState();
  const outcome = finalState.outcome ?? { victory: false, reason: "unknown" };
  const playerGasEnd = playerGas;
  const enemyGasEnd = finalState.enemyGas;
  const onFieldPlayerEnd = computeOnFieldGasValue(finalState.units, "player", refundFactor);
  const onFieldEnemyEnd = computeOnFieldGasValue(finalState.units, "enemy", refundFactor);

  const worth0Player = playerGasStart + onFieldPlayerStart;
  const worth1Player = playerGasEnd + onFieldPlayerEnd;
  const worth0Enemy = enemyGasStart + onFieldEnemyStart;
  const worth1Enemy = enemyGasEnd + onFieldEnemyEnd;

  const tie = outcome.reason.toLowerCase().includes("deadline") || outcome.reason.toLowerCase().includes("round deadline");

  const playerOutcome: "win" | "tie" | "loss" = tie ? "tie" : Boolean(outcome.victory) ? "win" : "loss";
  const enemyOutcome: "win" | "tie" | "loss" = tie ? "tie" : Boolean(outcome.victory) ? "loss" : "win";

  return {
    spec,
    simSecondsElapsed: t,
    outcome: { playerVictory: Boolean(outcome.victory), reason: String(outcome.reason) },
    sides: {
      player: {
        win: Boolean(outcome.victory),
        tie,
        gasStart: playerGasStart,
        gasEnd: playerGasEnd,
        onFieldGasValueStart: onFieldPlayerStart,
        onFieldGasValueEnd: onFieldPlayerEnd,
        gasWorthDelta: worth1Player - worth0Player,
        score: scoreFor(playerOutcome, worth1Player - worth0Player),
      },
      enemy: {
        win: !Boolean(outcome.victory) && !tie,
        tie,
        gasStart: enemyGasStart,
        gasEnd: enemyGasEnd,
        onFieldGasValueStart: onFieldEnemyStart,
        onFieldGasValueEnd: onFieldEnemyEnd,
        gasWorthDelta: worth1Enemy - worth0Enemy,
        score: scoreFor(enemyOutcome, worth1Enemy - worth0Enemy),
      },
    },
    replay: {
      seed: spec.seed,
      maxSimSeconds: spec.maxSimSeconds,
      nodeDefense: spec.nodeDefense,
      playerGas: spec.playerGas,
      enemyGas: spec.enemyGas,
      aiPlayer: spec.aiPlayer,
      aiEnemy: spec.aiEnemy,
    },
  };
}
