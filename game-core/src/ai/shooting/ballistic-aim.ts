import { PROJECTILE_GRAVITY, PROJECTILE_SPEED } from "../../config/balance/range.ts";
import { AI_SHOOTING_CONFIG } from "../../config/ai/shooting.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";

export interface AimSolution {
  x: number;
  y: number;
  firingAngleRad: number;
  leadTimeS: number;
}

export function solveBallisticAim(
  shooterX: number,
  shooterY: number,
  targetX: number,
  targetY: number,
  targetVx: number,
  targetVy: number,
  maxRange: number,
  projectileSpeed: number = PROJECTILE_SPEED,
  projectileGravity: number = PROJECTILE_GRAVITY,
  simulationStepS: number = 1 / 60,
): AimSolution | null {
  const solverConfig = AI_SHOOTING_CONFIG.ballisticSolver;
  const MIN_T: number = solverConfig.minTimeSeconds;
  const safeProjectileSpeed = Math.max(1, projectileSpeed);
  // Allow longer intercept horizons for long-range shots; hard-capping at 2s
  // underestimates gravity lead and causes far-shot misses.
  const MAX_T = clamp(
    (maxRange / safeProjectileSpeed) * solverConfig.horizonRangeScale,
    solverConfig.minHorizonSeconds,
    solverConfig.maxHorizonSeconds,
  );
  if (MAX_T <= MIN_T) {
    return null;
  }

  const speedErrorAtTime = (t: number): number => {
    const px = targetX + targetVx * t;
    const py = targetY + targetVy * t;
    const dx = px - shooterX;
    const dy = py - shooterY;
    const vx = dx / t;
    // Runtime projectile integration is semi-implicit Euler:
    // vy += g*dt; y += vy*dt.
    // Match this in solve to avoid systematic edge-angle miss at long range.
    const vy = (dy - 0.5 * projectileGravity * (t * t + t * simulationStepS)) / t;
    return vx * vx + vy * vy - safeProjectileSpeed * safeProjectileSpeed;
  };

  // Find the earliest feasible intercept time within TTL/range.
  let t0 = MIN_T;
  let f0 = speedErrorAtTime(t0);
  const steps = solverConfig.bracketSteps;
  let bracket: { a: number; b: number; fa: number } | null = null;
  for (let i = 1; i <= steps; i += 1) {
    const t1 = MIN_T + ((MAX_T - MIN_T) * i) / steps;
    const f1 = speedErrorAtTime(t1);
    if ((f0 > 0 && f1 <= 0) || (f0 <= 0 && f1 > 0)) {
      bracket = { a: t0, b: t1, fa: f0 };
      break;
    }
    t0 = t1;
    f0 = f1;
  }
  if (!bracket) {
    return null;
  }

  let a = bracket.a;
  let b = bracket.b;
  let fa = bracket.fa;
  for (let i = 0; i < solverConfig.bisectionSteps; i += 1) {
    const m = (a + b) * 0.5;
    const fm = speedErrorAtTime(m);
    if (Math.abs(fm) < solverConfig.speedErrorTolerance) {
      a = m;
      b = m;
      fa = fm;
      break;
    }
    if ((fa > 0 && fm <= 0) || (fa <= 0 && fm > 0)) {
      b = m;
    } else {
      a = m;
      fa = fm;
    }
  }
  const t = (a + b) * 0.5;

  const aimX = targetX + targetVx * t;
  const aimY = targetY + targetVy * t;

  // Coarse range gating: if even the straight-line distance is beyond range, we can't hit.
  const directDistance = Math.hypot(aimX - shooterX, aimY - shooterY);
  if (directDistance > maxRange * solverConfig.directRangeTolerance) {
    return null;
  }
  if (safeProjectileSpeed * t > maxRange * solverConfig.travelRangeTolerance) {
    return null;
  }

  const vx = (aimX - shooterX) / Math.max(solverConfig.minimumDivisor, t);
  const vy = (aimY - shooterY - 0.5 * projectileGravity * (t * t + t * simulationStepS)) / Math.max(solverConfig.minimumDivisor, t);
  const firingAngleRad = Math.atan2(vy, vx);
  return { x: aimX, y: aimY, firingAngleRad, leadTimeS: t };
}
