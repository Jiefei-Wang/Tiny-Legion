import { structureIntegrity } from "../../../game-core/src/simulation/units/structure-grid.ts";
import {
  createAutoregShootAi,
  createHistoryWeightedShootAi,
  createWeightedLagShootAi,
  createBaselineMovementAi,
  createBaselineShootAi,
  createBaselineTargetAi,
} from "../../../game-core/src/ai/composite/baseline-modules.ts";
import { createUnifiedTargetShootAi } from "../../../game-core/src/ai/shooting/unified-target-shoot.ts";
import { createUnifiedLevelShootAi } from "../../../game-core/src/ai/shooting/unified-level-shoot.ts";
import {
  createSkillTierMovementAi,
  createSkillTierShootAi,
  createSkillTierTargetAi,
  type AiSkillTier,
} from "../../../game-core/src/ai/composite/skill-tier-modules.ts";
import {
  createLevelMovementAi,
  createLevelShootAi,
  createLevelTargetAi,
  MAX_CERTIFIED_AI_LEVEL,
} from "../../../game-core/src/ai/composite/level-modules.ts";
import {
  createCertifiedLevelMovementAi,
  createCertifiedLevelTargetAi,
} from "../../../game-core/src/ai/composite/certified-level-modules.ts";
import {
  createCompositeAiController,
  type BattleAiController,
  type MovementAiModule,
  type ShootAiModule,
  type TargetAiModule,
} from "../../../game-core/src/ai/composite/composite-ai.ts";
import { clamp } from "../../../game-core/src/simulation/physics/impulse-model.ts";
import { canOperate } from "../../../game-core/src/simulation/units/control-unit-rules.ts";
import type { Params, ParamSchema } from "./ai-schema.ts";
import type { MatchAiSpec } from "../match/match-types.ts";

export type CompositeModuleSpec = {
  familyId: string;
  params: Params;
};

export type CompositeConfig = {
  target: CompositeModuleSpec;
  movement: CompositeModuleSpec;
  shoot: CompositeModuleSpec;
};

type ModuleKind = "target" | "movement" | "shoot";
type ShootFamilyId = "dt-shoot" | "dt-shoot-atan" | "w11-shoot" | "autoreg-shoot" | "history-shoot";

function pickNumber(params: Params, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pickInt(params: Params, key: string, fallback: number): number {
  return Math.floor(pickNumber(params, key, fallback));
}

export const DT_TARGET_SCHEMA: ParamSchema = {
  "target.strategy": { kind: "int", min: 0, max: 3, def: 0, step: 1, mutateRate: 0.25 },
  "target.distanceWeight": { kind: "number", min: 0.3, max: 2.0, def: 1.0, sigma: 0.2 },
  "target.weakHpWeight": { kind: "number", min: 0.0, max: 3.0, def: 1.2, sigma: 0.25 },
  "target.threatWeight": { kind: "number", min: 0.0, max: 3.0, def: 1.1, sigma: 0.25 },
  "target.basePressureWeight": { kind: "number", min: 0.0, max: 3.0, def: 1.0, sigma: 0.25 },
};

export const DT_MOVEMENT_SCHEMA: ParamSchema = {
  "movement.strategy": { kind: "int", min: 0, max: 3, def: 0, step: 1, mutateRate: 0.25 },
  "movement.desiredRangeFactor": { kind: "number", min: 0.4, max: 1.6, def: 1.0, sigma: 0.15 },
  "movement.evadeThreshold": { kind: "number", min: 0.08, max: 0.6, def: 0.24, sigma: 0.08 },
  "movement.retreatBoost": { kind: "number", min: 0.0, max: 1.8, def: 0.75, sigma: 0.2 },
  "movement.pushBoost": { kind: "number", min: 0.0, max: 1.8, def: 0.55, sigma: 0.2 },
};

export const DT_SHOOT_SCHEMA: ParamSchema = {
  "shoot.strategy": { kind: "int", min: 0, max: 2, def: 0, step: 1, mutateRate: 0.25 },
  "shoot.maxRangeRatio": { kind: "number", min: 0.25, max: 1.2, def: 1.0, sigma: 0.12 },
  "shoot.minIntegrityToFire": { kind: "number", min: 0.0, max: 1.0, def: 0.15, sigma: 0.08 },
  "shoot.weaponSpeed": { kind: "number", min: 80, max: 2400, def: 900, sigma: 120 },
  "shoot.angleWeightStdX": { kind: "number", min: -1.8, max: 1.8, def: 0.0, sigma: 0.2 },
  "shoot.angleWeightStdY": { kind: "number", min: -1.8, max: 1.8, def: 0.0, sigma: 0.2 },
  "shoot.angleWeightYOverX": { kind: "number", min: -1.8, max: 1.8, def: 0.0, sigma: 0.2 },
  "shoot.angleWeightYOverX2": { kind: "number", min: -1.8, max: 1.8, def: 0.0, sigma: 0.2 },
};

export const DT_SHOOT_ATAN_SCHEMA: ParamSchema = {
  "shoot.strategy": { kind: "int", min: 0, max: 2, def: 0, step: 1, mutateRate: 0.25 },
  "shoot.maxRangeRatio": { kind: "number", min: 0.25, max: 1.2, def: 1.0, sigma: 0.12 },
  "shoot.minIntegrityToFire": { kind: "number", min: 0.0, max: 1.0, def: 0.15, sigma: 0.08 },
  "shoot.weaponSpeed": { kind: "number", min: 80, max: 2400, def: 900, sigma: 120 },
  "shoot.angleWeightStdX": { kind: "number", min: -1.8, max: 1.8, def: 0.0, sigma: 0.2 },
  "shoot.angleWeightStdY": { kind: "number", min: -1.8, max: 1.8, def: 0.0, sigma: 0.2 },
  "shoot.angleWeightYOverX": { kind: "number", min: -1.8, max: 1.8, def: 0.0, sigma: 0.2 },
  "shoot.angleWeightYOverX2": { kind: "number", min: -1.8, max: 1.8, def: 0.0, sigma: 0.2 },
};

void DT_TARGET_SCHEMA;
void DT_MOVEMENT_SCHEMA;
void DT_SHOOT_SCHEMA;
void DT_SHOOT_ATAN_SCHEMA;

const W11_SHOOT_SCHEMA: ParamSchema = {
  "shoot.alpha1": { kind: "number", min: 0, max: 1, def: 11 / 66, sigma: 0.08 },
  "shoot.alpha2": { kind: "number", min: 0, max: 1, def: 10 / 66, sigma: 0.08 },
  "shoot.alpha3": { kind: "number", min: 0, max: 1, def: 9 / 66, sigma: 0.08 },
  "shoot.alpha4": { kind: "number", min: 0, max: 1, def: 8 / 66, sigma: 0.08 },
  "shoot.alpha5": { kind: "number", min: 0, max: 1, def: 7 / 66, sigma: 0.08 },
  "shoot.alpha6": { kind: "number", min: 0, max: 1, def: 6 / 66, sigma: 0.08 },
  "shoot.alpha7": { kind: "number", min: 0, max: 1, def: 5 / 66, sigma: 0.08 },
  "shoot.alpha8": { kind: "number", min: 0, max: 1, def: 4 / 66, sigma: 0.08 },
  "shoot.alpha9": { kind: "number", min: 0, max: 1, def: 3 / 66, sigma: 0.08 },
  "shoot.alpha10": { kind: "number", min: 0, max: 1, def: 2 / 66, sigma: 0.08 },
  "shoot.alpha11": { kind: "number", min: 0, max: 1, def: 1 / 66, sigma: 0.08 },
};

const AUTOREG_SHOOT_SCHEMA: ParamSchema = {
  alpha: { kind: "number", min: 0, max: 1, def: 0.5, sigma: 0.1 },
};

const HISTORY_SHOOT_SCHEMA: ParamSchema = {
  "history.recencyPower": { kind: "number", min: 0.2, max: 4, def: 1.0, sigma: 0.25 },
};

export function getModuleSchema(kind: ModuleKind, shootFamily: ShootFamilyId = "dt-shoot"): ParamSchema {
  if (kind === "shoot" && shootFamily === "w11-shoot") {
    return W11_SHOOT_SCHEMA;
  }
  if (kind === "shoot" && shootFamily === "autoreg-shoot") {
    return AUTOREG_SHOOT_SCHEMA;
  }
  if (kind === "shoot" && shootFamily === "history-shoot") {
    return HISTORY_SHOOT_SCHEMA;
  }
  return {};
}

function createDecisionTreeTargetAi(params: Params): TargetAiModule {
  return {
    decideTarget: (input) => {
      const strategy = Math.max(0, Math.min(3, pickInt(params, "target.strategy", 0)));
      const distanceWeight = pickNumber(params, "target.distanceWeight", 1.0);
      const weakHpWeight = pickNumber(params, "target.weakHpWeight", 1.2);
      const threatWeight = pickNumber(params, "target.threatWeight", 1.1);
      const basePressureWeight = pickNumber(params, "target.basePressureWeight", 1.0);

      const base = input.unit.side === "player" ? input.state.playerBase : input.state.enemyBase;
      const baseCenterX = base.x + base.w * 0.5;
      const baseCenterY = base.y + base.h * 0.5;

      const rankedTargets = input.state.units
        .filter((u) => u.alive && canOperate(u) && u.side !== input.unit.side)
        .map((enemy) => {
          const dx = enemy.x - input.unit.x;
          const dy = enemy.y - input.unit.y;
          const distance = Math.hypot(dx, dy);
          const hp = structureIntegrity(enemy);
          const threat = enemy.weaponAttachmentIds.length;
          const baseDist = Math.hypot(enemy.x - baseCenterX, enemy.y - baseCenterY);

          let score = distance * distanceWeight;
          if (strategy === 1) {
            score += hp * 280 * weakHpWeight;
            score += distance * 0.2;
          } else if (strategy === 2) {
            score += distance * 0.7;
            score -= threat * 36 * threatWeight;
          } else if (strategy === 3) {
            score += distance * 0.4;
            score += (baseDist / 6.0) * basePressureWeight;
          }

          return {
            targetId: enemy.id,
            score,
            x: enemy.x,
            y: enemy.y,
            vx: enemy.vx,
            vy: enemy.vy,
            type: enemy.type,
          };
        })
        .sort((a, b) => a.score - b.score);

      const top = rankedTargets[0];
      return {
        rankedTargets,
        attackPoint: top ? { x: top.x, y: top.y } : { x: input.baseTarget.x, y: input.baseTarget.y },
        debugTag: `target.dt.s${strategy}`,
      };
    },
  };
}

function createDecisionTreeMovementAi(params: Params): MovementAiModule {
  const baseline = createBaselineMovementAi();
  return {
    decideMovement: (input, target) => {
      const strategy = Math.max(0, Math.min(3, pickInt(params, "movement.strategy", 0)));
      const desiredRangeFactor = pickNumber(params, "movement.desiredRangeFactor", 1.0);
      const evadeThreshold = pickNumber(params, "movement.evadeThreshold", 0.24);
      const retreatBoost = pickNumber(params, "movement.retreatBoost", 0.75);
      const pushBoost = pickNumber(params, "movement.pushBoost", 0.55);

      const adjustedInput = {
        ...input,
        desiredRange: Math.max(40, input.desiredRange * desiredRangeFactor),
      };
      const baseDecision = baseline.decideMovement(adjustedInput, target);
      let ax = baseDecision.ax;
      let ay = baseDecision.ay;
      let shouldEvade = baseDecision.shouldEvade;

      const dx = target.attackPoint.x - input.unit.x;
      const dy = target.attackPoint.y - input.unit.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = dx / len;
      const ny = dy / len;
      const integrity = structureIntegrity(input.unit);

      if (strategy === 1) {
        if (integrity <= evadeThreshold) {
          ax -= nx * retreatBoost;
          ay -= ny * retreatBoost * 0.7;
          shouldEvade = true;
        }
      } else if (strategy === 2) {
        ax += nx * pushBoost;
        ay += ny * pushBoost * 0.7;
        shouldEvade = false;
      } else if (strategy === 3) {
        if (integrity <= 0.7) {
          ax -= nx * (retreatBoost + 0.2);
          ay -= ny * (retreatBoost + 0.2) * 0.7;
          shouldEvade = true;
        }
      }

      return {
        ax: clamp(ax, -1.4, 1.4),
        ay: clamp(ay, -1.4, 1.4),
        shouldEvade,
        state: shouldEvade ? "evade" : "engage",
        debugTag: `movement.dt.s${strategy}`,
      };
    },
  };
}

function createDecisionTreeShootAi(params: Params): ShootAiModule {
  const baseline = createBaselineShootAi();
  const safeDivStd = (numerator: number, denominator: number): number => {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
      return 0;
    }
    if (Math.abs(denominator) < 1e-6) {
      return 10000;
    }
    return numerator / denominator;
  };
  return {
    decideShoot: (input, target, movement) => {
      const strategy = Math.max(0, Math.min(2, pickInt(params, "shoot.strategy", 0)));
      const maxRangeRatio = pickNumber(params, "shoot.maxRangeRatio", 1.0);
      const minIntegrityToFire = pickNumber(params, "shoot.minIntegrityToFire", 0.15);
      const weaponSpeed = Math.max(1, pickNumber(params, "shoot.weaponSpeed", 900));
      const angleWeightStdX = pickNumber(params, "shoot.angleWeightStdX", 0.0);
      const angleWeightStdY = pickNumber(params, "shoot.angleWeightStdY", 0.0);
      const angleWeightYOverX = pickNumber(params, "shoot.angleWeightYOverX", 0.0);
      const angleWeightYOverX2 = pickNumber(params, "shoot.angleWeightYOverX2", 0.0);

      const decision = baseline.decideShoot(input, target, movement);
      if (!decision.firePlan) {
        return decision;
      }

      const stdX = (target.attackPoint.x - input.unit.x) / weaponSpeed;
      const stdY = (target.attackPoint.y - input.unit.y) / weaponSpeed;
      const yOverX = safeDivStd(stdY, stdX);
      const yOverX2 = safeDivStd(stdY, stdX * stdX);
      const angleDelta = (
        stdX * angleWeightStdX
        + stdY * angleWeightStdY
        + yOverX * angleWeightYOverX
        + yOverX2 * angleWeightYOverX2
      );
      const adjustedAngleRaw = decision.firePlan.angleRad + angleDelta;
      const adjustedAngle = Number.isFinite(adjustedAngleRaw) ? adjustedAngleRaw : decision.firePlan.angleRad;
      const adjustedDecision = {
        ...decision,
        firePlan: {
          ...decision.firePlan,
          angleRad: adjustedAngle,
        },
      };

      if (strategy === 0) {
        return { ...adjustedDecision, debugTag: "shoot.dt.s0" };
      }

      const integrity = structureIntegrity(input.unit);
      const distance = Math.hypot(target.attackPoint.x - input.unit.x, target.attackPoint.y - input.unit.y);
      if (strategy === 1) {
        if (integrity < minIntegrityToFire) {
          return {
            firePlan: null,
            fireBlockedReason: "low-integrity",
            debugTag: "shoot.dt.s1.blocked-integrity",
          };
        }
        if (distance > decision.firePlan.effectiveRange * maxRangeRatio) {
          return {
            firePlan: null,
            fireBlockedReason: "range-hold",
            debugTag: "shoot.dt.s1.blocked-range",
          };
        }
        return {
          ...adjustedDecision,
          debugTag: "shoot.dt.s1",
        };
      }

      if (adjustedDecision.firePlan.leadTimeS > 0.9 && !movement.shouldEvade) {
        return {
          firePlan: null,
          fireBlockedReason: "lead-too-long",
          debugTag: "shoot.dt.s2.blocked-lead",
        };
      }
      return {
        ...adjustedDecision,
        debugTag: "shoot.dt.s2",
      };
    },
  };
}

function createDecisionTreeShootAtanAi(params: Params): ShootAiModule {
  const baseline = createBaselineShootAi();
  return {
    decideShoot: (input, target, movement) => {
      const strategy = Math.max(0, Math.min(2, pickInt(params, "shoot.strategy", 0)));
      const maxRangeRatio = pickNumber(params, "shoot.maxRangeRatio", 1.0);
      const minIntegrityToFire = pickNumber(params, "shoot.minIntegrityToFire", 0.15);
      const weaponSpeed = Math.max(1, pickNumber(params, "shoot.weaponSpeed", 900));
      const angleWeightStdX = pickNumber(params, "shoot.angleWeightStdX", 0.0);
      const angleWeightStdY = pickNumber(params, "shoot.angleWeightStdY", 0.0);
      const angleWeightYOverX = pickNumber(params, "shoot.angleWeightYOverX", 0.0);
      const angleWeightYOverX2 = pickNumber(params, "shoot.angleWeightYOverX2", 0.0);

      const decision = baseline.decideShoot(input, target, movement);
      if (!decision.firePlan) {
        return decision;
      }

      const stdX = (target.attackPoint.x - input.unit.x) / weaponSpeed;
      const stdY = (target.attackPoint.y - input.unit.y) / weaponSpeed;
      const angleStd = Math.atan2(stdY, stdX);
      const absStdX = Math.max(1e-6, Math.abs(stdX));
      const angleCurve = Math.atan2(stdY, absStdX * absStdX);
      const angleDelta = (
        stdX * angleWeightStdX
        + stdY * angleWeightStdY
        + angleStd * angleWeightYOverX
        + angleCurve * angleWeightYOverX2
      );
      const adjustedAngleRaw = decision.firePlan.angleRad + angleDelta;
      const adjustedAngle = Number.isFinite(adjustedAngleRaw) ? adjustedAngleRaw : decision.firePlan.angleRad;
      const adjustedDecision = {
        ...decision,
        firePlan: {
          ...decision.firePlan,
          angleRad: adjustedAngle,
        },
      };

      if (strategy === 0) {
        return { ...adjustedDecision, debugTag: "shoot.dt-atan.s0" };
      }

      const integrity = structureIntegrity(input.unit);
      const distance = Math.hypot(target.attackPoint.x - input.unit.x, target.attackPoint.y - input.unit.y);
      if (strategy === 1) {
        if (integrity < minIntegrityToFire) {
          return {
            firePlan: null,
            fireBlockedReason: "low-integrity",
            debugTag: "shoot.dt-atan.s1.blocked-integrity",
          };
        }
        if (distance > decision.firePlan.effectiveRange * maxRangeRatio) {
          return {
            firePlan: null,
            fireBlockedReason: "range-hold",
            debugTag: "shoot.dt-atan.s1.blocked-range",
          };
        }
        return {
          ...adjustedDecision,
          debugTag: "shoot.dt-atan.s1",
        };
      }

      if (adjustedDecision.firePlan.leadTimeS > 0.9 && !movement.shouldEvade) {
        return {
          firePlan: null,
          fireBlockedReason: "lead-too-long",
          debugTag: "shoot.dt-atan.s2.blocked-lead",
        };
      }
      return {
        ...adjustedDecision,
        debugTag: "shoot.dt-atan.s2",
      };
    },
  };
}

void createDecisionTreeTargetAi;
void createDecisionTreeMovementAi;
void createDecisionTreeShootAi;
void createDecisionTreeShootAtanAi;

function createTargetModule(spec: CompositeModuleSpec): TargetAiModule {
  const familyId = spec.familyId.trim().toLowerCase();
  const certified = /^certified-level-(\d+)-target$/.exec(familyId);
  if (certified) return createCertifiedLevelTargetAi(Number.parseInt(certified[1] ?? "1", 10));
  const level = parseLevel(familyId, "target");
  if (level) return createLevelTargetAi(level);
  const tier = parseSkillTier(familyId, "target");
  if (tier) return createSkillTierTargetAi(tier);
  if (familyId === "dt-target") return createDecisionTreeTargetAi(spec.params);
  return createBaselineTargetAi();
}

function createMovementModule(spec: CompositeModuleSpec): MovementAiModule {
  const familyId = spec.familyId.trim().toLowerCase();
  const certified = /^certified-level-(\d+)-movement$/.exec(familyId);
  if (certified) return createCertifiedLevelMovementAi(Number.parseInt(certified[1] ?? "1", 10));
  const level = parseLevel(familyId, "movement");
  if (level) return createLevelMovementAi(level);
  const tier = parseSkillTier(familyId, "movement");
  if (tier) return createSkillTierMovementAi(tier);
  if (familyId === "dt-movement") return createDecisionTreeMovementAi(spec.params);
  return createBaselineMovementAi();
}

function createShootModule(spec: CompositeModuleSpec): ShootAiModule {
  const familyId = spec.familyId.trim().toLowerCase();
  const unifiedLevelMatch = /^unified-level-(\d+)-shoot$/.exec(familyId);
  if (unifiedLevelMatch) return createUnifiedLevelShootAi(Number.parseInt(unifiedLevelMatch[1] ?? "1", 10));
  const level = parseLevel(familyId, "shoot");
  if (level) return createLevelShootAi(level);
  const tier = parseSkillTier(familyId, "shoot");
  if (tier) return createSkillTierShootAi(tier);
  if (familyId === "dt-shoot") return createDecisionTreeShootAi(spec.params);
  if (familyId === "dt-shoot-atan") return createDecisionTreeShootAtanAi(spec.params);
  if (familyId === "history-shoot" || familyId === "history-weighted-shoot") {
    const recencyPower = pickNumber(spec.params, "history.recencyPower", 1.0);
    return createHistoryWeightedShootAi(recencyPower);
  }
  if (familyId === "autoreg-shoot") {
    const alpha = pickNumber(spec.params, "alpha", 0.5);
    return createAutoregShootAi(alpha);
  }
  if (familyId === "w11-shoot") {
    const alphas = new Array(11).fill(0).map((_, index) => pickNumber(spec.params, `shoot.alpha${index + 1}`, (11 - index) / 66));
    return createWeightedLagShootAi(alphas);
  }
  if (familyId === "unified-shoot") return createUnifiedTargetShootAi();
  return createBaselineShootAi();
}

function parseSkillTier(familyId: string, kind: ModuleKind): AiSkillTier | null {
  for (const tier of ["baseline", "low", "medium", "high"] as const) {
    if (familyId === `skill-${tier}-${kind}` || familyId === `${tier}-${kind}`) return tier;
  }
  return null;
}

function parseLevel(familyId: string, kind: ModuleKind): number | null {
  const match = new RegExp(`^(?:ai-)?l(?:evel-)?(\\d+)-${kind}$`).exec(familyId);
  if (!match) return null;
  const level = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(level) && level >= 1 ? level : null;
}

export function baselineCompositeConfig(): CompositeConfig {
  return {
    target: { familyId: "skill-baseline-target", params: {} },
    movement: { familyId: "skill-baseline-movement", params: {} },
    shoot: { familyId: "skill-baseline-shoot", params: {} },
  };
}

export function skillTierCompositeConfig(tier: AiSkillTier): CompositeConfig {
  return {
    target: { familyId: `skill-${tier}-target`, params: {} },
    movement: { familyId: `skill-${tier}-movement`, params: {} },
    shoot: { familyId: `skill-${tier}-shoot`, params: {} },
  };
}

export function levelCompositeConfig(level: number): CompositeConfig {
  const normalized = Math.max(1, Math.min(MAX_CERTIFIED_AI_LEVEL, Math.floor(level)));
  return {
    target: { familyId: `certified-level-${normalized}-target`, params: {} },
    movement: { familyId: `certified-level-${normalized}-movement`, params: {} },
    shoot: { familyId: `unified-level-${normalized}-shoot`, params: {} },
  };
}

export function makeCompositeAiController(spec: MatchAiSpec): BattleAiController | null {
  if (spec.familyId !== "composite" || !spec.composite) {
    return null;
  }
  const modules = spec.composite;
  return createCompositeAiController({
    target: createTargetModule(modules.target),
    movement: createMovementModule(modules.movement),
    shoot: createShootModule(modules.shoot),
  });
}
