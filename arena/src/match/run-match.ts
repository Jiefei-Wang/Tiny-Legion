import type { MatchResult, MatchSpec } from "./match-types.ts";
import { setMathRandomSeed } from "../lib/seeded-rng.ts";
import { loadBattleSessionModule, loadDecisionTreeModule, loadStructureGridModule } from "../game/game-loader.ts";
import { loadRuntimeMergedTemplates } from "./templates.ts";

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

export async function runMatch(spec: MatchSpec): Promise<MatchResult> {
  setMathRandomSeed(spec.seed);
  const templates = await loadRuntimeMergedTemplates();
  const battleMod = await loadBattleSessionModule();
  const { evaluateCombatDecisionTree } = await loadDecisionTreeModule();
  const { structureIntegrity } = await loadStructureGridModule();

  const BattleSession = battleMod.BattleSession as any;
  const refundFactor = typeof battleMod.BATTLE_SALVAGE_REFUND_FACTOR === "number" ? battleMod.BATTLE_SALVAGE_REFUND_FACTOR : 0.6;

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

  const aiForSide = (side: "player" | "enemy") => {
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

    throw new Error(`Unsupported AI family in runner: ${kind}`);
  };

  const canvas = createMockCanvas(1280, 720);
  const battle = new BattleSession(canvas, hooks, templates, {
    aiControllers: {
      player: aiForSide("player"),
      enemy: aiForSide("enemy"),
    },
    autoEnableAiWeaponAutoFire: true,
  });

  const node = {
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

  const rosterPreference = ["scout-ground", "tank-ground", "air-light"];
  const availableTemplateIds = new Set<string>(templates.map((t: any) => String(t.id)));
  const roster = rosterPreference.filter((id) => availableTemplateIds.has(id));
  if (roster.length === 0) {
    for (const t of templates.slice(0, 3)) {
      roster.push(String(t.id));
    }
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
  let deployTimer = 0;
  let rosterIndex = 0;
  while (battle.getState().active && !battle.getState().outcome && t < spec.maxSimSeconds) {
    deployTimer += dt;
    if (deployTimer >= 1.8 && roster.length > 0) {
      deployTimer = 0;
      const nextTemplateId = roster[rosterIndex % roster.length];
      rosterIndex += 1;
      battle.deployUnit(nextTemplateId);
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
      },
      enemy: {
        win: !Boolean(outcome.victory) && !tie,
        tie,
        gasStart: enemyGasStart,
        gasEnd: enemyGasEnd,
        onFieldGasValueStart: onFieldEnemyStart,
        onFieldGasValueEnd: onFieldEnemyEnd,
        gasWorthDelta: worth1Enemy - worth0Enemy,
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
