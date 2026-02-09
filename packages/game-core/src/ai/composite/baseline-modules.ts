import { GROUND_FIRE_Y_TOLERANCE, PROJECTILE_SPEED } from "../../config/balance/range.ts";
import { COMPONENTS } from "../../config/balance/weapons.ts";
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
      const distanceToTarget = Math.hypot(target.attackPoint.x - unit.x, target.attackPoint.y - unit.y);
      let best: FirePlan | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      let blockedReason: string | null = "no-ready-weapon";
      const leadVx = target.rankedTargets[0]?.vx ?? 0;
      const leadVy = target.rankedTargets[0]?.vy ?? 0;
      for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
        if (!unit.weaponAutoFire[slot]) {
          continue;
        }
        if ((unit.weaponFireTimers[slot] ?? 0) > 0) {
          continue;
        }
        const attachmentId = unit.weaponAttachmentIds[slot];
        const attachment = unit.attachments.find((entry) => entry.id === attachmentId && entry.alive) ?? null;
        if (!attachment) {
          continue;
        }
        const stats = COMPONENTS[attachment.component];
        if (stats.type !== "weapon" || stats.range === undefined || stats.damage === undefined) {
          continue;
        }
        const effectiveRange = input.getEffectiveWeaponRange(attachment.stats?.range ?? stats.range);
        if (distanceToTarget > effectiveRange * 1.05) {
          blockedReason = "out-of-range";
          continue;
        }
        const solved = solveBallisticAim(
          unit.x,
          unit.y,
          target.attackPoint.x,
          target.attackPoint.y,
          leadVx,
          leadVy,
          effectiveRange,
        );
        const leadTimeS = solved?.leadTimeS ?? 0;
        const angleRad = solved?.firingAngleRad ?? Math.atan2(target.attackPoint.y - unit.y, target.attackPoint.x - unit.x);
        const aimDistance = solved
          ? Math.max(90, Math.min(effectiveRange, PROJECTILE_SPEED * solved.leadTimeS))
          : Math.min(effectiveRange, Math.max(90, distanceToTarget));
        const baseAim = {
          x: unit.x + Math.cos(angleRad) * aimDistance,
          y: unit.y + Math.sin(angleRad) * aimDistance + unit.aiAimCorrectionY,
        };
        const aim = adjustAimForWeaponPolicy(attachment.component, baseAim);
        const angleAllowed = input.canShootAtAngle(attachment.component, aim.x - unit.x, aim.y - unit.y, attachment.stats?.shootAngleDeg);
        if (!angleAllowed) {
          blockedReason = "angle-locked";
          continue;
        }
        const rangeAlignment = 1 - Math.min(1, Math.abs(distanceToTarget - effectiveRange * 0.72) / Math.max(1, effectiveRange));
        const leadBonus = solved ? 1.15 : 0.62;
        const score = stats.damage * 1.2 + rangeAlignment * 25 + leadBonus * 18;
        if (score > bestScore) {
          bestScore = score;
          best = {
            preferredSlot: slot,
            aim,
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
