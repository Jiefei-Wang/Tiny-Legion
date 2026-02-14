import { GROUND_FIRE_Y_TOLERANCE } from "../../config/balance/range.ts";
import { structureIntegrity } from "../../simulation/units/structure-grid.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";
import { computeMovementDecision } from "../movement/threat-movement.ts";
import { solveBallisticAim } from "../shooting/ballistic-aim.ts";
import { adjustAimForWeaponPolicy } from "../shooting/weapon-ai-policy.ts";
import { selectBestTarget } from "../targeting/target-selector.ts";
import {
  createCompositeAiController,
  type BattleAiController,
  type BattleAiInput,
  type FirePlan,
  type MovementAiModule,
  type ShootAiModule,
  type TargetAiModule,
} from "./composite-ai.ts";

const LEAD_VELOCITY_FILTER_RATE_PER_S = 6.0;
const LEAD_GAIN_NEAR = 0.32;
const LEAD_GAIN_FAR = 0.82;
const LEAD_ACCEL_SOFT_CAP = 180;
const LEAD_ACCEL_HARD_CAP = 520;
const LEAD_ACCEL_MIN_GAIN = 0.35;
const AIM_SLEW_DEG_PER_S = 92;
const AIM_DEADBAND_DEG = 0.5;
const AIM_SLEW_RAD_PER_S = (AIM_SLEW_DEG_PER_S * Math.PI) / 180;
const AIM_DEADBAND_RAD = (AIM_DEADBAND_DEG * Math.PI) / 180;

type TargetMotionState = {
  rawVx: number;
  rawVy: number;
  filteredVx: number;
  filteredVy: number;
};

function wrapAngleDelta(next: number, prev: number): number {
  return Math.atan2(Math.sin(next - prev), Math.cos(next - prev));
}

function canHitByAxis(unit: BattleAiInput["unit"], target: { y: number; type: BattleAiInput["unit"]["type"] } | null): boolean {
  if (!target) {
    return true;
  }
  if (unit.type === "air" || target.type === "air") {
    return true;
  }
  return Math.abs(target.y - unit.y) <= GROUND_FIRE_Y_TOLERANCE;
}

export function createBaselineTargetAi(): TargetAiModule {
  return {
    decideTarget: (input) => {
      const enemies = input.state.units
        .filter((unit) => unit.alive && unit.side !== input.unit.side)
        .map((other) => {
          const dx = other.x - input.unit.x;
          const dy = other.y - input.unit.y;
          const distance = Math.hypot(dx, dy);
          const closingPenalty = Math.max(0, 40 - Math.hypot(other.vx, other.vy)) * 0.2;
          const score = distance + Math.abs(dy) * 0.7 + closingPenalty;
          return {
            targetId: other.id,
            score,
            x: other.x,
            y: other.y,
            vx: other.vx,
            vy: other.vy,
            type: other.type,
          };
        })
        .sort((a, b) => a.score - b.score);
      const top = enemies[0];
      if (top) {
        return {
          rankedTargets: enemies,
          attackPoint: { x: top.x, y: top.y },
          debugTag: "target.baseline-ranked",
        };
      }
      return {
        rankedTargets: [],
        attackPoint: { x: input.baseTarget.x, y: input.baseTarget.y },
        debugTag: "target.base-fallback",
      };
    },
  };
}

export function createBaselineMovementAi(): MovementAiModule {
  return {
    decideMovement: (input, target) => {
      const decision = computeMovementDecision(
        input.unit,
        input.state,
        target.attackPoint.x,
        target.attackPoint.y,
        input.desiredRange,
        input.dt,
      );
      const integrity = structureIntegrity(input.unit);
      let ax = decision.ax;
      let ay = decision.ay;
      let shouldEvade = decision.shouldEvade;
      let debugTag = "movement.baseline";
      if (integrity < 0.24) {
        ax -= Math.sign(target.attackPoint.x - input.unit.x) * 1.0;
        ay -= Math.sign(target.attackPoint.y - input.unit.y) * 0.6;
        shouldEvade = true;
        debugTag = "movement.baseline-retreat";
      }
      return {
        ax: clamp(ax, -1.4, 1.4),
        ay: clamp(ay, -1.4, 1.4),
        shouldEvade,
        state: shouldEvade ? "evade" : "engage",
        debugTag,
      };
    },
  };
}

export function createBaselineShootAi(): ShootAiModule {
  const targetMotionById = new Map<string, TargetMotionState>();
  const lastAngleByWeaponKey = new Map<string, number>();

  return {
    decideShoot: (input, target) => {
      const unit = input.unit;
      if (!canHitByAxis(unit, target.rankedTargets[0] ?? null)) {
        return {
          firePlan: null,
          fireBlockedReason: "axis-mismatch",
          debugTag: "shoot.axis-blocked",
        };
      }
      const correctedTargetX = target.attackPoint.x;
      const correctedTargetY = target.attackPoint.y;
      let best: FirePlan | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      let blockedReason: string | null = "no-ready-weapon";
      const primaryTarget = target.rankedTargets[0] ?? null;
      let filteredLeadVx = 0;
      let filteredLeadVy = 0;
      let targetAccel = 0;
      if (primaryTarget) {
        const prior = targetMotionById.get(primaryTarget.targetId);
        if (!prior) {
          targetMotionById.set(primaryTarget.targetId, {
            rawVx: primaryTarget.vx,
            rawVy: primaryTarget.vy,
            filteredVx: primaryTarget.vx,
            filteredVy: primaryTarget.vy,
          });
          filteredLeadVx = primaryTarget.vx;
          filteredLeadVy = primaryTarget.vy;
        } else {
          const alpha = clamp(input.dt * LEAD_VELOCITY_FILTER_RATE_PER_S, 0, 1);
          const nextFilteredVx = prior.filteredVx + (primaryTarget.vx - prior.filteredVx) * alpha;
          const nextFilteredVy = prior.filteredVy + (primaryTarget.vy - prior.filteredVy) * alpha;
          const dtSafe = Math.max(1e-3, input.dt);
          const dvx = primaryTarget.vx - prior.rawVx;
          const dvy = primaryTarget.vy - prior.rawVy;
          targetAccel = Math.hypot(dvx, dvy) / dtSafe;
          prior.rawVx = primaryTarget.vx;
          prior.rawVy = primaryTarget.vy;
          prior.filteredVx = nextFilteredVx;
          prior.filteredVy = nextFilteredVy;
          filteredLeadVx = nextFilteredVx;
          filteredLeadVy = nextFilteredVy;
        }
      }
      for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
        if (!unit.weaponAutoFire[slot]) {
          continue;
        }
        if ((unit.weaponFireTimers[slot] ?? 0) > 0) {
          continue;
        }
        const weaponInput = input.getWeaponFireInput(slot);
        if (!weaponInput) {
          continue;
        }
        const distanceToTarget = Math.hypot(
          correctedTargetX - weaponInput.firepointX,
          correctedTargetY - weaponInput.firepointY,
        );
        const effectiveRange = weaponInput.effectiveRange;
        if (distanceToTarget > effectiveRange * 1.05) {
          blockedReason = "out-of-range";
          continue;
        }
        const rangeNorm = clamp(distanceToTarget / Math.max(1, effectiveRange), 0, 1);
        const baseLeadGain = LEAD_GAIN_NEAR + (LEAD_GAIN_FAR - LEAD_GAIN_NEAR) * rangeNorm;
        const accelGain = targetAccel <= LEAD_ACCEL_SOFT_CAP
          ? 1
          : targetAccel >= LEAD_ACCEL_HARD_CAP
          ? LEAD_ACCEL_MIN_GAIN
          : 1 - ((targetAccel - LEAD_ACCEL_SOFT_CAP) / Math.max(1, LEAD_ACCEL_HARD_CAP - LEAD_ACCEL_SOFT_CAP)) * (1 - LEAD_ACCEL_MIN_GAIN);
        const leadGain = baseLeadGain * accelGain;
        const solved = solveBallisticAim(
          weaponInput.firepointX,
          weaponInput.firepointY,
          correctedTargetX,
          correctedTargetY,
          filteredLeadVx * leadGain,
          filteredLeadVy * leadGain,
          effectiveRange,
          weaponInput.projectileSpeed,
          weaponInput.projectileGravity,
        );
        const leadTimeS = solved?.leadTimeS ?? 0;
        let angleRad = solved?.firingAngleRad ?? Math.atan2(correctedTargetY - weaponInput.firepointY, correctedTargetX - weaponInput.firepointX);
        const angleKey = `${unit.id}:${slot}`;
        const prevAngle = lastAngleByWeaponKey.get(angleKey);
        if (prevAngle !== undefined) {
          const delta = wrapAngleDelta(angleRad, prevAngle);
          if (Math.abs(delta) <= AIM_DEADBAND_RAD) {
            angleRad = prevAngle;
          } else {
            const maxDelta = AIM_SLEW_RAD_PER_S * Math.max(1e-3, input.dt);
            angleRad = prevAngle + clamp(delta, -maxDelta, maxDelta);
          }
        }
        lastAngleByWeaponKey.set(angleKey, angleRad);
        const aimDistance = solved
          ? Math.max(90, Math.min(effectiveRange, weaponInput.projectileSpeed * solved.leadTimeS))
          : Math.min(effectiveRange, Math.max(90, distanceToTarget));
        const baseAim = {
          x: weaponInput.firepointX + Math.cos(angleRad) * aimDistance,
          y: weaponInput.firepointY + Math.sin(angleRad) * aimDistance,
        };
        const aim = adjustAimForWeaponPolicy(weaponInput.componentId, baseAim);
        const angleAllowed = input.canShootAtAngle(
          weaponInput.componentId,
          aim.x - weaponInput.firepointX,
          aim.y - weaponInput.firepointY,
          weaponInput.shootAngleDeg,
        );
        if (!angleAllowed) {
          blockedReason = "angle-locked";
          continue;
        }
        const rangeAlignment = 1 - Math.min(1, Math.abs(distanceToTarget - effectiveRange * 0.72) / Math.max(1, effectiveRange));
        const leadBonus = solved ? 1.15 : 0.62;
        const score = weaponInput.damage * 1.2 + rangeAlignment * 25 + leadBonus * 18;
        if (score > bestScore) {
          bestScore = score;
          best = {
            preferredSlot: slot,
            intendedTargetId: target.rankedTargets[0]?.targetId ?? null,
            intendedTargetY: solved?.y ?? (target.rankedTargets[0] ? target.attackPoint.y : null),
            angleRad,
            leadTimeS,
            effectiveRange,
          };
        }
      }
      if (!best) {
        return {
          firePlan: null,
          fireBlockedReason: blockedReason,
          debugTag: blockedReason === "out-of-range" ? "shoot.reposition-range" : "shoot.no-plan",
        };
      }
      return {
        firePlan: best,
        fireBlockedReason: null,
        debugTag: "shoot.baseline-plan",
      };
    },
  };
}

export function createBaselineCompositeAiController(): BattleAiController {
  return createCompositeAiController({
    target: createBaselineTargetAi(),
    movement: createBaselineMovementAi(),
    shoot: createBaselineShootAi(),
  });
}

export function pickBaselineTarget(unit: BattleAiInput["unit"], state: BattleAiInput["state"]): BattleAiInput["state"]["units"][number] | null {
  return selectBestTarget(unit, state);
}
