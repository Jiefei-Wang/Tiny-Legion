import {
  AI_TARGET_HISTORY_SAMPLE_INTERVAL_S,
  GROUND_FIRE_Y_TOLERANCE,
} from "../../config/balance/range.ts";
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

function maybeApplyAimDamping(
  angleRad: number,
  prevAngle: number | undefined,
  dt: number,
  enabled: boolean,
): number {
  if (!enabled || prevAngle === undefined) {
    return angleRad;
  }
  const delta = wrapAngleDelta(angleRad, prevAngle);
  if (Math.abs(delta) <= AIM_DEADBAND_RAD) {
    return prevAngle;
  }
  const maxDelta = AIM_SLEW_RAD_PER_S * Math.max(1e-3, dt);
  return prevAngle + clamp(delta, -maxDelta, maxDelta);
}

function estimateWeightedVelocityFromHistory(
  history: ReadonlyArray<{ x: number; y: number }>,
  sampleIntervalS: number,
  recencyPower = 1,
): { vx: number; vy: number } {
  const n = history.length;
  if (n < 2) {
    return { vx: 0, vy: 0 };
  }
  const dt = Math.max(1e-3, sampleIntervalS);
  const safeRecencyPower = Number.isFinite(recencyPower) ? Math.max(0.05, recencyPower) : 1;
  let weightSum = 0;
  let weightedT = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let i = 0; i < n; i += 1) {
    const w = (i + 1) ** safeRecencyPower;
    const t = (i - (n - 1)) * dt;
    weightSum += w;
    weightedT += w * t;
    weightedX += w * history[i].x;
    weightedY += w * history[i].y;
  }
  if (weightSum <= 0) {
    return { vx: 0, vy: 0 };
  }
  const meanT = weightedT / weightSum;
  const meanX = weightedX / weightSum;
  const meanY = weightedY / weightSum;
  let covTX = 0;
  let covTY = 0;
  let varT = 0;
  for (let i = 0; i < n; i += 1) {
    const w = (i + 1) ** safeRecencyPower;
    const t = (i - (n - 1)) * dt - meanT;
    const x = history[i].x - meanX;
    const y = history[i].y - meanY;
    covTX += w * t * x;
    covTY += w * t * y;
    varT += w * t * t;
  }
  if (Math.abs(varT) < 1e-9) {
    return { vx: 0, vy: 0 };
  }
  return { vx: covTX / varT, vy: covTY / varT };
}

function normalizeNonNegativeWeights(raw: ReadonlyArray<number>, fallback: ReadonlyArray<number>): number[] {
  const clamped = raw.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  const sum = clamped.reduce((acc, value) => acc + value, 0);
  if (sum > 1e-9) {
    return clamped.map((value) => value / sum);
  }
  const fallbackClamped = fallback.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  const fallbackSum = fallbackClamped.reduce((acc, value) => acc + value, 0);
  if (fallbackSum <= 1e-9) {
    return new Array(Math.max(1, raw.length)).fill(1 / Math.max(1, raw.length));
  }
  return fallbackClamped.map((value) => value / fallbackSum);
}

function estimateLagVelocitiesFromHistory(
  currentVx: number,
  currentVy: number,
  history: ReadonlyArray<{ x: number; y: number }> | null | undefined,
  sampleIntervalS: number,
  count: number,
): Array<{ vx: number; vy: number }> {
  const desired = Math.max(1, Math.floor(count));
  const dt = Math.max(1e-3, sampleIntervalS);
  const out: Array<{ vx: number; vy: number }> = [{ vx: currentVx, vy: currentVy }];
  if (!history || history.length < 2) {
    while (out.length < desired) {
      out.push({ vx: currentVx, vy: currentVy });
    }
    return out;
  }
  const segmentVelocities: Array<{ vx: number; vy: number }> = [];
  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1]!;
    const next = history[i]!;
    segmentVelocities.push({
      vx: (next.x - prev.x) / dt,
      vy: (next.y - prev.y) / dt,
    });
  }
  for (let lagIndex = 1; lagIndex < desired; lagIndex += 1) {
    const segIdxFromEnd = Math.max(0, Math.min(segmentVelocities.length - 1, segmentVelocities.length - lagIndex));
    const seg = segmentVelocities[segIdxFromEnd] ?? segmentVelocities[0] ?? { vx: currentVx, vy: currentVy };
    out.push({ vx: seg.vx, vy: seg.vy });
  }
  return out;
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
        angleRad = maybeApplyAimDamping(angleRad, prevAngle, input.dt, true);
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

export function createHistoryWeightedShootAi(recencyPowerRaw = 1): ShootAiModule {
  const recencyPower = Number.isFinite(recencyPowerRaw) ? Math.max(0.05, recencyPowerRaw) : 1;
  const lastAngleByWeaponKey = new Map<string, number>();
  return {
    decideShoot: (input, target) => {
      const unit = input.unit;
      const primary = target.rankedTargets[0] ?? null;
      if (!canHitByAxis(unit, primary)) {
        return {
          firePlan: null,
          fireBlockedReason: "axis-mismatch",
          debugTag: "shoot.history.blocked-axis",
        };
      }
      const correctedTargetX = target.attackPoint.x;
      const correctedTargetY = target.attackPoint.y;
      let best: FirePlan | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      let blockedReason: string | null = "no-ready-weapon";

      let historyVx = 0;
      let historyVy = 0;
      if (primary) {
        const targetUnit = input.state.units.find((entry) => entry.id === primary.targetId) ?? null;
        if (targetUnit?.targetHistory && targetUnit.targetHistory.length > 1) {
          const estimated = estimateWeightedVelocityFromHistory(
            targetUnit.targetHistory,
            AI_TARGET_HISTORY_SAMPLE_INTERVAL_S,
            recencyPower,
          );
          historyVx = estimated.vx;
          historyVy = estimated.vy;
        } else {
          historyVx = primary.vx;
          historyVy = primary.vy;
        }
      }

      for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
        if (!unit.weaponAutoFire[slot]) continue;
        if ((unit.weaponFireTimers[slot] ?? 0) > 0) continue;
        const weaponInput = input.getWeaponFireInput(slot);
        if (!weaponInput) continue;
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
          historyVx,
          historyVy,
          effectiveRange,
          weaponInput.projectileSpeed,
          weaponInput.projectileGravity,
        );
        const leadTimeS = solved?.leadTimeS ?? 0;
        let angleRad = solved?.firingAngleRad ?? Math.atan2(correctedTargetY - weaponInput.firepointY, correctedTargetX - weaponInput.firepointX);
        const angleKey = `hist:${unit.id}:${slot}`;
        const prevAngle = lastAngleByWeaponKey.get(angleKey);
        angleRad = maybeApplyAimDamping(angleRad, prevAngle, input.dt, false);
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
        const leadBonus = solved ? 1.18 : 0.62;
        const score = weaponInput.damage * 1.2 + rangeAlignment * 25 + leadBonus * 18;
        if (score > bestScore) {
          bestScore = score;
          best = {
            preferredSlot: slot,
            intendedTargetId: primary?.targetId ?? null,
            intendedTargetY: solved?.y ?? (primary ? target.attackPoint.y : null),
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
          debugTag: blockedReason === "out-of-range" ? "shoot.history.reposition-range" : "shoot.history.no-plan",
        };
      }
      return {
        firePlan: best,
        fireBlockedReason: null,
        debugTag: `shoot.history.p${recencyPower.toFixed(2)}`,
      };
    },
  };
}

export function createHistoryWeightedCompositeAiController(): BattleAiController {
  return createCompositeAiController({
    target: createBaselineTargetAi(),
    movement: createBaselineMovementAi(),
    shoot: createHistoryWeightedShootAi(),
  });
}

export function createAutoregShootAi(alphaRaw: number): ShootAiModule {
  const alpha = clamp(alphaRaw, 0, 1);
  const vHatByTargetId = new Map<string, { vx: number; vy: number }>();
  const lastAngleByWeaponKey = new Map<string, number>();
  return {
    decideShoot: (input, target) => {
      const unit = input.unit;
      const primary = target.rankedTargets[0] ?? null;
      if (!canHitByAxis(unit, primary)) {
        return {
          firePlan: null,
          fireBlockedReason: "axis-mismatch",
          debugTag: "shoot.autoreg.blocked-axis",
        };
      }
      const correctedTargetX = target.attackPoint.x;
      const correctedTargetY = target.attackPoint.y;
      let best: FirePlan | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      let blockedReason: string | null = "no-ready-weapon";

      let leadVx = 0;
      let leadVy = 0;
      if (primary) {
        const prev = vHatByTargetId.get(primary.targetId) ?? { vx: primary.vx, vy: primary.vy };
        const next = {
          vx: (1 - alpha) * prev.vx + alpha * primary.vx,
          vy: (1 - alpha) * prev.vy + alpha * primary.vy,
        };
        vHatByTargetId.set(primary.targetId, next);
        leadVx = next.vx;
        leadVy = next.vy;
      }

      for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
        if (!unit.weaponAutoFire[slot]) continue;
        if ((unit.weaponFireTimers[slot] ?? 0) > 0) continue;
        const weaponInput = input.getWeaponFireInput(slot);
        if (!weaponInput) continue;
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
        let angleRad = solved?.firingAngleRad ?? Math.atan2(correctedTargetY - weaponInput.firepointY, correctedTargetX - weaponInput.firepointX);
        const angleKey = `ar:${unit.id}:${slot}`;
        const prevAngle = lastAngleByWeaponKey.get(angleKey);
        angleRad = maybeApplyAimDamping(angleRad, prevAngle, input.dt, false);
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
        const leadBonus = solved ? 1.18 : 0.62;
        const score = weaponInput.damage * 1.2 + rangeAlignment * 25 + leadBonus * 18;
        if (score > bestScore) {
          bestScore = score;
          best = {
            preferredSlot: slot,
            intendedTargetId: primary?.targetId ?? null,
            intendedTargetY: solved?.y ?? (primary ? target.attackPoint.y : null),
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
          debugTag: blockedReason === "out-of-range" ? "shoot.autoreg.reposition-range" : "shoot.autoreg.no-plan",
        };
      }
      return {
        firePlan: best,
        fireBlockedReason: null,
        debugTag: `shoot.autoreg.a${alpha.toFixed(2)}`,
      };
    },
  };
}

export function createWeightedLagShootAi(alphaRaw: ReadonlyArray<number>): ShootAiModule {
  const fallbackWeights = new Array(11).fill(0).map((_, index) => 11 - index);
  const baseWeights = normalizeNonNegativeWeights(alphaRaw, fallbackWeights);
  const lastAngleByWeaponKey = new Map<string, number>();
  return {
    decideShoot: (input, target) => {
      const unit = input.unit;
      const primary = target.rankedTargets[0] ?? null;
      if (!canHitByAxis(unit, primary)) {
        return {
          firePlan: null,
          fireBlockedReason: "axis-mismatch",
          debugTag: "shoot.w11.blocked-axis",
        };
      }
      const correctedTargetX = target.attackPoint.x;
      const correctedTargetY = target.attackPoint.y;
      let best: FirePlan | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      let blockedReason: string | null = "no-ready-weapon";

      let leadVx = 0;
      let leadVy = 0;
      if (primary) {
        const targetUnit = input.state.units.find((entry) => entry.id === primary.targetId) ?? null;
        const lagVelocities = estimateLagVelocitiesFromHistory(
          primary.vx,
          primary.vy,
          targetUnit?.targetHistory,
          AI_TARGET_HISTORY_SAMPLE_INTERVAL_S,
          baseWeights.length,
        );
        for (let i = 0; i < baseWeights.length; i += 1) {
          const lag = lagVelocities[i] ?? lagVelocities[lagVelocities.length - 1] ?? { vx: primary.vx, vy: primary.vy };
          const w = baseWeights[i] ?? 0;
          leadVx += lag.vx * w;
          leadVy += lag.vy * w;
        }
      }

      for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
        if (!unit.weaponAutoFire[slot]) continue;
        if ((unit.weaponFireTimers[slot] ?? 0) > 0) continue;
        const weaponInput = input.getWeaponFireInput(slot);
        if (!weaponInput) continue;
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
        let angleRad = solved?.firingAngleRad ?? Math.atan2(correctedTargetY - weaponInput.firepointY, correctedTargetX - weaponInput.firepointX);
        const angleKey = `w11:${unit.id}:${slot}`;
        const prevAngle = lastAngleByWeaponKey.get(angleKey);
        angleRad = maybeApplyAimDamping(angleRad, prevAngle, input.dt, false);
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
        const leadBonus = solved ? 1.18 : 0.62;
        const score = weaponInput.damage * 1.2 + rangeAlignment * 25 + leadBonus * 18;
        if (score > bestScore) {
          bestScore = score;
          best = {
            preferredSlot: slot,
            intendedTargetId: primary?.targetId ?? null,
            intendedTargetY: solved?.y ?? (primary ? target.attackPoint.y : null),
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
          debugTag: blockedReason === "out-of-range" ? "shoot.w11.reposition-range" : "shoot.w11.no-plan",
        };
      }
      return {
        firePlan: best,
        fireBlockedReason: null,
        debugTag: "shoot.w11.plan",
      };
    },
  };
}

export function pickBaselineTarget(unit: BattleAiInput["unit"], state: BattleAiInput["state"]): BattleAiInput["state"]["units"][number] | null {
  return selectBestTarget(unit, state);
}
