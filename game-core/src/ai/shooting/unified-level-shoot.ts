import type { ShootAiModule, TargetDecision } from "../composite/composite-ai.ts";
import { createUnifiedTargetShootAi } from "./unified-target-shoot.ts";

export const UNIFIED_LEVEL_ACCURACY: Readonly<Record<number, number>> = Object.freeze({
  1: 0.5,
  2: 0.6,
  3: 0.7,
  4: 0.8,
  5: 0.9,
  6: 1,
});

const VELOCITY_RESPONSE_WEIGHT: Readonly<Record<number, number>> = Object.freeze({
  1: 0.2,
  2: 0.35,
  3: 0.5,
  4: 0.7,
  5: 0.88,
  6: 1,
});

type ObservedVelocity = { vx: number; vy: number };
type MissProfile = { direction: -1 | 1; clearanceScale: number };

const MAX_REALISTIC_MISS_ANGLE_RAD = 10 * Math.PI / 180;
const MIN_MISS_ANGLE_RAD = 0.15 * Math.PI / 180;

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function createMissProfile(key: string): MissProfile {
  const hash = hashString(key);
  return {
    direction: (hash & 1) === 0 ? -1 : 1,
    clearanceScale: 1.15 + ((hash >>> 1) % 21) / 100,
  };
}

export function createUnifiedLevelShootAi(levelRaw: number): ShootAiModule {
  const level = Math.max(1, Math.min(6, Math.floor(levelRaw)));
  const accuracy = UNIFIED_LEVEL_ACCURACY[level] ?? 1;
  const responseWeight = VELOCITY_RESPONSE_WEIGHT[level] ?? 1;
  const observedVelocityByTarget = new Map<string, ObservedVelocity>();
  const missProfileByTarget = new Map<string, MissProfile>();
  const core = createUnifiedTargetShootAi();

  return {
    decideShoot: (input, target, movement) => {
      const primary = target.rankedTargets[0] ?? null;
      let observedTarget: TargetDecision = target;
      if (primary) {
        const observationKey = `${input.unit.id}:${primary.targetId}`;
        const prior = observedVelocityByTarget.get(observationKey);
        const observed = prior
          ? {
              vx: prior.vx * (1 - responseWeight) + primary.vx * responseWeight,
              vy: prior.vy * (1 - responseWeight) + primary.vy * responseWeight,
            }
          : { vx: primary.vx, vy: primary.vy };
        observedVelocityByTarget.set(observationKey, observed);
        observedTarget = {
          ...target,
          rankedTargets: target.rankedTargets.map((candidate, index) => index === 0
            ? { ...candidate, vx: observed.vx, vy: observed.vy }
            : candidate),
        };
      }

      const exact = core.decideShoot(input, observedTarget, movement);
      const plans = exact.firePlans ?? (exact.firePlan ? [exact.firePlan] : []);
      if (plans.length === 0 || Math.random() < accuracy) {
        return {
          ...exact,
          debugTag: `${exact.debugTag}.level-${level}.accurate`,
        };
      }

      const targetUnit = primary
        ? input.state.units.find((unit) => unit.id === primary.targetId) ?? null
        : null;
      const missProfileKey = primary ? `${input.unit.id}:${primary.targetId}` : "missing-target";
      const missProfile = missProfileByTarget.get(missProfileKey) ?? createMissProfile(missProfileKey);
      missProfileByTarget.set(missProfileKey, missProfile);
      const biasedPlans = plans.flatMap((plan) => {
        const weapon = input.getWeaponFireInput(plan.preferredSlot);
        if (!weapon || !primary) return [];
        const muzzleX = weapon.projectileOriginBaseX + Math.cos(plan.angleRad) * weapon.projectileOriginForwardOffset;
        const muzzleY = weapon.projectileOriginBaseY + Math.sin(plan.angleRad) * weapon.projectileOriginForwardOffset;
        const predictedTargetX = primary.x + primary.vx * plan.leadTimeS;
        const predictedTargetY = primary.y + primary.vy * plan.leadTimeS;
        const distance = Math.hypot(predictedTargetX - muzzleX, predictedTargetY - muzzleY);
        const targetRadius = Math.max(4, targetUnit?.radius ?? 0);
        const projectileRadius = Math.max(2, Math.sqrt(Math.max(0, weapon.damage)) * 0.35);
        const missClearance = targetRadius + projectileRadius + 3;
        // At overlapping range, any release can begin inside the target. Model
        // the low-skill response as hesitation so the trial remains a miss. The
        // same rule avoids a visibly wild snap when clearing the target would
        // require more angular error than a human-like near miss.
        if (distance <= missClearance) return [];
        const hitConeRad = Math.asin(Math.min(0.999, missClearance / distance));
        const missAngleRad = hitConeRad * missProfile.clearanceScale + MIN_MISS_ANGLE_RAD;
        if (missAngleRad > MAX_REALISTIC_MISS_ANGLE_RAD) return [];
        return [{
          ...plan,
          angleRad: plan.angleRad + missProfile.direction * missAngleRad,
          intendedTargetId: null,
          intendedTargetY: null,
          disableTracking: true,
        }];
      });
      return {
        firePlan: biasedPlans[0] ?? null,
        firePlans: biasedPlans,
        fireBlockedReason: biasedPlans.length > 0 ? null : "intentional-miss",
        debugTag: `shoot.unified.level-${level}.stable-near-miss`,
        preserveFacing: true,
      };
    },
  };
}
