import "../../game/src/style.css";

import { bootstrap } from "../../game/src/app/bootstrap.ts";
import type { ArenaReplayDecider, ArenaReplaySpec } from "../../game/src/app/bootstrap.ts";
import type { BattleAiController, BattleAiInput, BattleSessionOptions } from "../../game/src/gameplay/battle/battle-session.ts";
import { evaluateCombatDecisionTree } from "../../game/src/ai/decision-tree/combat-decision-tree.ts";
import { structureIntegrity } from "../../game/src/simulation/units/structure-grid.ts";
import { getSpawnFamily } from "../../arena/src/spawn/families.ts";

type MatchArtifact = { spec: ArenaReplaySpec };

declare global {
  interface Window {
    __ARENA_REPLAY__?: (MatchArtifact & { expected?: any }) | null;
  }
}

function b64urlDecodeToString(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const raw = atob(b64 + pad);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function parseArtifactFromHash(): MatchArtifact | null {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const replay = params.get("replay");
  if (!replay) {
    return null;
  }
  const json = b64urlDecodeToString(replay);
  return JSON.parse(json) as MatchArtifact;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function buildMicroController(kind: string, params: Record<string, number | boolean>): BattleAiController {
  if (kind === "baseline") {
    return {
      decide: (input: BattleAiInput) =>
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
    const rangeFactor = typeof params.rangeFactor === "number" ? params.rangeFactor : 0.72;
    return {
      decide: (input: BattleAiInput) =>
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
    const lowIntegrityThreshold = typeof params.lowIntegrityThreshold === "number" ? params.lowIntegrityThreshold : 0.24;
    const evadePush = typeof params.evadePush === "number" ? params.evadePush : 0.9;
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
          const dx = input.unit.x - input.baseTarget.x;
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
    } as any;
  }
  if (kind === "aggressive-rush") {
    const rangeFactor = typeof params.rangeFactor === "number" ? params.rangeFactor : 0.52;
    const forwardBias = typeof params.forwardBias === "number" ? params.forwardBias : 0.7;
    const evadeThreshold = typeof params.evadeThreshold === "number" ? params.evadeThreshold : 0.18;
    const evadePush = typeof params.evadePush === "number" ? params.evadePush : 0.55;
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
          };
        }
        return {
          ...decision,
          movement: {
            ax: decision.movement.ax + rushAx,
            ay: decision.movement.ay + rushAy,
            shouldEvade: decision.movement.shouldEvade,
          },
        };
      },
    } as any;
  }
  if (kind === "adaptive-kite") {
    const healthyRangeFactor = typeof params.healthyRangeFactor === "number" ? params.healthyRangeFactor : 1.08;
    const damagedRangeFactor = typeof params.damagedRangeFactor === "number" ? params.damagedRangeFactor : 1.3;
    const integrityPivot = typeof params.integrityPivot === "number" ? params.integrityPivot : 0.36;
    const retreatPush = typeof params.retreatPush === "number" ? params.retreatPush : 0.95;
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
        };
      },
    } as any;
  }
  if (kind === "neural-linear") {
    const wRange = [
      Number(params.wr0 ?? 0),
      Number(params.wr1 ?? 0),
      Number(params.wr2 ?? 0),
      Number(params.wr3 ?? 0),
      Number(params.wr4 ?? 0),
      Number(params.wr5 ?? 0),
    ];
    const wEvade = [
      Number(params.we0 ?? 0),
      Number(params.we1 ?? 0),
      Number(params.we2 ?? 0),
      Number(params.we3 ?? 0),
      Number(params.we4 ?? 0),
      Number(params.we5 ?? 0),
    ];
    const bRange = Number(params.br ?? 0);
    const bEvade = Number(params.be ?? 0);
    const retreatScale = Number(params.retreatScale ?? 1);
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
        };
      },
    } as any;
  }
  if (kind === "base-rush") {
    const rangeFactor = typeof params.rangeFactor === "number" ? params.rangeFactor : 0.35;
    const basePush = typeof params.basePush === "number" ? params.basePush : 1.1;
    const yBias = typeof params.yBias === "number" ? params.yBias : 0;
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
        };
      },
    } as any;
  }
  return buildMicroController("baseline", {});
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSpawnDecider(familyId: string, params: Record<string, number | boolean>, seed: number): ArenaReplayDecider {
  const family = getSpawnFamily(familyId);
  const rng = mulberry32(seed);
  return (ctx) => family.pick(params as any, ctx.roster, rng, { gas: ctx.gas, capRemaining: ctx.capRemaining });
}

const artifact = window.__ARENA_REPLAY__ ?? parseArtifactFromHash();
if (!artifact) {
  const root = document.getElementById("app");
  if (root) {
    root.textContent = "No replay provided.";
  }
} else {
  const spec = artifact.spec;
  const battleSessionOptions: BattleSessionOptions = {
    aiControllers: {
      player: buildMicroController(spec.aiPlayer.familyId, spec.aiPlayer.params),
      enemy: buildMicroController(spec.aiEnemy.familyId, spec.aiEnemy.params),
    },
    autoEnableAiWeaponAutoFire: true,
    disableAutoEnemySpawns: true,
    disableEnemyMinimumPresence: true,
    disableDefaultStarters: true,
  };

  const deciders: { player?: ArenaReplayDecider; enemy?: ArenaReplayDecider } = {};
  if ((spec.spawnMode ?? "mirrored-random") === "ai") {
    if (spec.spawnPlayer) {
      deciders.player = buildSpawnDecider(spec.spawnPlayer.familyId, spec.spawnPlayer.params, spec.seed ^ 0x13579);
    }
    if (spec.spawnEnemy) {
      deciders.enemy = buildSpawnDecider(spec.spawnEnemy.familyId, spec.spawnEnemy.params, spec.seed ^ 0x2468a);
    }
  }

  bootstrap({
    arenaReplay: { spec: spec as ArenaReplaySpec, deciders, expected: (artifact as any).expected ?? null },
    battleSessionOptions,
  });
}
