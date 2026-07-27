import type { FirePlan, ShootAiModule } from "../composite/composite-ai.ts";
import { solveBallisticAim } from "./ballistic-aim.ts";

/**
 * Property-driven shooting for one already-selected target. Target selection,
 * movement tactics, identities, and learned corrections intentionally stay out
 * of this module.
 */
export function createUnifiedTargetShootAi(): ShootAiModule {
  return {
    decideShoot: (input, target) => {
      const selectedTarget = target.rankedTargets[0] ?? null;
      if (!selectedTarget) {
        return { firePlan: null, firePlans: [], fireBlockedReason: "no-target", debugTag: "shoot.unified.no-target", preserveFacing: true };
      }

      const plans: FirePlan[] = [];
      let blockedReason: string | null = "no-ready-weapon";
      const targetUnit = input.state.units.find((unit) => unit.id === selectedTarget.targetId) ?? null;
      for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
        if (!input.unit.weaponAutoFire[slot] || (input.unit.weaponFireTimers[slot] ?? 0) > 0) continue;
        const weapon = input.getWeaponFireInput(slot);
        if (!weapon || weapon.loadedAmmo <= 0) continue;
        const distance = Math.hypot(selectedTarget.x - weapon.firepointX, selectedTarget.y - weapon.firepointY);
        if (distance > weapon.effectiveRange * 1.05) {
          blockedReason = "out-of-range";
          continue;
        }

        const directAngle = Math.atan2(
          selectedTarget.y - weapon.projectileOriginBaseY,
          selectedTarget.x - weapon.projectileOriginBaseX,
        );
        let originX = weapon.projectileOriginBaseX + Math.cos(directAngle) * weapon.projectileOriginForwardOffset;
        let originY = weapon.projectileOriginBaseY + Math.sin(directAngle) * weapon.projectileOriginForwardOffset;
        const muzzleOverlap = distance <= (targetUnit?.radius ?? 0) + weapon.projectileOriginForwardOffset;
        let solution = weapon.projectileClass === "laser" || muzzleOverlap
          ? {
              x: selectedTarget.x,
              y: selectedTarget.y,
              firingAngleRad: directAngle,
              leadTimeS: 0,
            }
          : solveBallisticAim(
              originX,
              originY,
              selectedTarget.x,
              selectedTarget.y,
              selectedTarget.vx,
              selectedTarget.vy,
              weapon.effectiveRange,
              weapon.projectileSpeed,
              weapon.projectileGravity,
            );
        // The runtime muzzle advances along the chosen firing angle. Iterate
        // the source point and intercept together so long/multi-cell weapons
        // use the same launch origin as projectile creation.
        if (weapon.projectileClass !== "laser" && !muzzleOverlap) {
          for (let iteration = 0; solution && iteration < 4; iteration += 1) {
            originX = weapon.projectileOriginBaseX + Math.cos(solution.firingAngleRad) * weapon.projectileOriginForwardOffset;
            originY = weapon.projectileOriginBaseY + Math.sin(solution.firingAngleRad) * weapon.projectileOriginForwardOffset;
            solution = solveBallisticAim(
              originX,
              originY,
              selectedTarget.x,
              selectedTarget.y,
              selectedTarget.vx,
              selectedTarget.vy,
              weapon.effectiveRange,
              weapon.projectileSpeed,
              weapon.projectileGravity,
            );
          }
        }
        if (!solution) {
          blockedReason = "no-intercept";
          continue;
        }
        if (!input.canShootAtAngle(
          weapon.componentId,
          Math.cos(solution.firingAngleRad),
          Math.sin(solution.firingAngleRad),
          weapon.angleLimit,
        )) {
          blockedReason = "angle-locked";
          continue;
        }
        plans.push({
          preferredSlot: slot,
          intendedTargetId: selectedTarget.targetId,
          intendedTargetY: solution.y,
          angleRad: solution.firingAngleRad,
          leadTimeS: solution.leadTimeS,
          effectiveRange: weapon.effectiveRange,
        });
      }

      return {
        firePlan: plans[0] ?? null,
        firePlans: plans,
        fireBlockedReason: plans.length > 0 ? null : blockedReason,
        debugTag: plans.length > 0 ? "shoot.unified.plan" : "shoot.unified.blocked",
        preserveFacing: true,
      };
    },
  };
}
