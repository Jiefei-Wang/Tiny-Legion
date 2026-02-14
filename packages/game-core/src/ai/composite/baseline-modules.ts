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
      const correctedTargetX = target.attackPoint.x;
      const correctedTargetY = target.attackPoint.y;
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
        const solved = solveBallisticAim(
          weaponInput.firepointX,
          weaponInput.firepointY,
          correctedTargetX,
          correctedTargetY,
          leadVx,
          leadVy,
          effectiveRange,
          weaponInput.projectileSpeed,
          weaponInput.projectileGravity,
        );
        const leadTimeS = solved?.leadTimeS ?? 0;
        const angleRad = solved?.firingAngleRad ?? Math.atan2(correctedTargetY - weaponInput.firepointY, correctedTargetX - weaponInput.firepointX);
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
