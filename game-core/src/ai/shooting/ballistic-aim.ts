import { PROJECTILE_GRAVITY, PROJECTILE_SPEED } from "../../config/balance/range.ts";
import { AI_SHOOTING_CONFIG } from "../../config/ai/shooting.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";

export interface AimSolution {
  x: number;
  y: number;
  firingAngleRad: number;
  leadTimeS: number;
}

const ROOT_EPSILON = 1e-9;

function evaluatePolynomial(coefficients: ReadonlyArray<number>, t: number): number {
  let value = 0;
  for (let index = coefficients.length - 1; index >= 0; index -= 1) {
    value = value * t + (coefficients[index] ?? 0);
  }
  return value;
}

function trimPolynomial(coefficients: ReadonlyArray<number>): number[] {
  const result = [...coefficients];
  while (result.length > 1 && Math.abs(result[result.length - 1] ?? 0) <= ROOT_EPSILON) {
    result.pop();
  }
  return result;
}

/**
 * Isolates every real polynomial root in a bounded interval. Derivative roots
 * partition the polynomial into monotonic spans, so tangential/double roots
 * are retained instead of being missed by sign-change-only sampling.
 */
function rootsInInterval(
  rawCoefficients: ReadonlyArray<number>,
  min: number,
  max: number,
  valueTolerance: number,
  iterations = 64,
): number[] {
  const coefficients = trimPolynomial(rawCoefficients);
  const degree = coefficients.length - 1;
  if (degree <= 0 || max < min) return [];
  if (degree === 1) {
    const denominator = coefficients[1] ?? 0;
    if (Math.abs(denominator) <= ROOT_EPSILON) return [];
    const root = -(coefficients[0] ?? 0) / denominator;
    return root >= min - ROOT_EPSILON && root <= max + ROOT_EPSILON
      ? [clamp(root, min, max)]
      : [];
  }

  const derivative = coefficients.slice(1).map((value, index) => value * (index + 1));
  const criticalPoints = rootsInInterval(derivative, min, max, valueTolerance, iterations)
    .filter((value, index, values) => index === 0 || Math.abs(value - (values[index - 1] ?? value)) > 1e-7)
    .sort((a, b) => a - b);
  const boundaries = [min, ...criticalPoints.filter((value) => value > min && value < max), max];
  const roots: number[] = [];
  const appendRoot = (root: number): void => {
    if (!roots.some((value) => Math.abs(value - root) <= 1e-6)) roots.push(root);
  };

  for (const point of criticalPoints) {
    if (Math.abs(evaluatePolynomial(coefficients, point)) <= valueTolerance) appendRoot(point);
  }
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    let a = boundaries[index] ?? min;
    let b = boundaries[index + 1] ?? max;
    let fa = evaluatePolynomial(coefficients, a);
    let fb = evaluatePolynomial(coefficients, b);
    if (Math.abs(fa) <= valueTolerance) appendRoot(a);
    if (Math.abs(fb) <= valueTolerance) appendRoot(b);
    if (fa === 0 || fb === 0 || Math.sign(fa) === Math.sign(fb)) continue;
    for (let step = 0; step < iterations; step += 1) {
      const middle = (a + b) * 0.5;
      const fm = evaluatePolynomial(coefficients, middle);
      if (Math.abs(fm) <= valueTolerance) {
        a = middle;
        b = middle;
        break;
      }
      if (Math.sign(fa) !== Math.sign(fm)) {
        b = middle;
        fb = fm;
      } else {
        a = middle;
        fa = fm;
      }
    }
    appendRoot((a + b) * 0.5);
  }
  return roots.sort((a, b) => a - b);
}

function solveZeroGravityInterceptTimes(
  dx: number,
  dy: number,
  targetVx: number,
  targetVy: number,
  projectileSpeed: number,
  minTime: number,
  maxTime: number,
): number[] {
  const a = targetVx * targetVx + targetVy * targetVy - projectileSpeed * projectileSpeed;
  const b = 2 * (dx * targetVx + dy * targetVy);
  const c = dx * dx + dy * dy;
  const candidates: number[] = [];
  if (Math.abs(a) <= ROOT_EPSILON) {
    if (Math.abs(b) > ROOT_EPSILON) candidates.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      candidates.push((-b - root) / (2 * a), (-b + root) / (2 * a));
    }
  }
  return candidates
    .filter((time) => Number.isFinite(time) && time >= minTime && time <= maxTime)
    .sort((left, right) => left - right);
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
  const safeProjectileSpeed = Math.max(1, projectileSpeed);
  const initialDistance = Math.hypot(targetX - shooterX, targetY - shooterY);
  const minTime = Math.max(
    1e-6,
    Math.min(solverConfig.minTimeSeconds, (initialDistance / safeProjectileSpeed) * 0.25),
  );
  const finiteRange = Number.isFinite(maxRange) ? Math.max(0, maxRange) : Number.POSITIVE_INFINITY;
  const rangeHorizon = Number.isFinite(finiteRange)
    ? (finiteRange / safeProjectileSpeed) * solverConfig.horizonRangeScale
    : solverConfig.maxHorizonSeconds;
  const maxTime = clamp(rangeHorizon, solverConfig.minHorizonSeconds, solverConfig.maxHorizonSeconds);
  if (maxTime <= minTime) return null;

  const dx = targetX - shooterX;
  const dy = targetY - shooterY;
  // Semi-implicit runtime integration: vy += g*dt; y += vy*dt.
  const adjustedTargetVy = targetVy - 0.5 * projectileGravity * simulationStepS;
  const gravityTerm = -0.5 * projectileGravity;
  const coefficients = [
    dx * dx + dy * dy,
    2 * (dx * targetVx + dy * adjustedTargetVy),
    targetVx * targetVx + adjustedTargetVy * adjustedTargetVy + 2 * dy * gravityTerm - safeProjectileSpeed * safeProjectileSpeed,
    2 * adjustedTargetVy * gravityTerm,
    gravityTerm * gravityTerm,
  ];
  const coefficientScale = Math.max(1, ...coefficients.map((value) => Math.abs(value)));
  const roots = Math.abs(projectileGravity) <= ROOT_EPSILON
    ? solveZeroGravityInterceptTimes(dx, dy, targetVx, targetVy, safeProjectileSpeed, minTime, maxTime)
    : rootsInInterval(
        coefficients,
        minTime,
        maxTime,
        coefficientScale * Math.max(1e-12, solverConfig.speedErrorTolerance * 1e-8),
        Math.max(solverConfig.bisectionSteps, solverConfig.bracketSteps * 2),
      );

  for (const t of roots) {
    const aimX = targetX + targetVx * t;
    const aimY = targetY + targetVy * t;
    const directDistance = Math.hypot(aimX - shooterX, aimY - shooterY);
    if (Number.isFinite(finiteRange) && directDistance > finiteRange * solverConfig.directRangeTolerance) continue;
    if (Number.isFinite(finiteRange) && safeProjectileSpeed * t > finiteRange * solverConfig.travelRangeTolerance) continue;
    const divisor = Math.max(solverConfig.minimumDivisor, t);
    const launchVx = (aimX - shooterX) / divisor;
    const launchVy = (aimY - shooterY - 0.5 * projectileGravity * (t * t + t * simulationStepS)) / divisor;
    const speedError = Math.abs(Math.hypot(launchVx, launchVy) - safeProjectileSpeed);
    if (speedError > Math.max(0.01, solverConfig.speedErrorTolerance * 10)) continue;
    return {
      x: aimX,
      y: aimY,
      firingAngleRad: Math.atan2(launchVy, launchVx),
      leadTimeS: t,
    };
  }
  return null;
}
