import { PROJECTILE_GRAVITY, PROJECTILE_SPEED } from "../../config/balance/range.ts";
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
): AimSolution | null {
  const MIN_T = 0.08;
  const MAX_T = Math.min(2.0, clamp((maxRange / PROJECTILE_SPEED) * 1.12, 0.14, 2.0));
  if (MAX_T <= MIN_T) {
    return null;
  }

  const speedErrorAtTime = (t: number): number => {
    const px = targetX + targetVx * t;
    const py = targetY + targetVy * t;
    const dx = px - shooterX;
    const dy = py - shooterY;
    const vx = dx / t;
    const vy = (dy - 0.5 * PROJECTILE_GRAVITY * t * t) / t;
    return vx * vx + vy * vy - PROJECTILE_SPEED * PROJECTILE_SPEED;
  };

  // Find the earliest feasible intercept time within TTL/range.
  let t0 = MIN_T;
  let f0 = speedErrorAtTime(t0);
  const steps = 28;
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
  for (let i = 0; i < 26; i += 1) {
    const m = (a + b) * 0.5;
    const fm = speedErrorAtTime(m);
    if (Math.abs(fm) < 1e-3) {
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
  if (directDistance > maxRange * 1.05) {
    return null;
  }
  if (PROJECTILE_SPEED * t > maxRange * 1.08) {
    return null;
  }

  const vx = (aimX - shooterX) / Math.max(0.001, t);
  const vy = (aimY - shooterY - 0.5 * PROJECTILE_GRAVITY * t * t) / Math.max(0.001, t);
  const firingAngleRad = Math.atan2(vy, vx);
  return { x: aimX, y: aimY, firingAngleRad, leadTimeS: t };
}
