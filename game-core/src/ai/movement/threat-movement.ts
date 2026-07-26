import { clamp } from "../../simulation/physics/impulse-model.ts";
import type { BattleState, UnitInstance } from "../../types.ts";

export interface MovementDecision {
  ax: number;
  ay: number;
  shouldEvade: boolean;
}

export interface ProjectileThreatAssessment {
  projectileIndex: number;
  timeToClosestS: number;
  missDistance: number;
  clearance: number;
  score: number;
  evadeX: number;
  evadeY: number;
}

export interface ModelPredictiveEvasion {
  evadeX: number;
  evadeY: number;
  baselineRisk: number;
  selectedRisk: number;
}

function stableUnitPhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff * Math.PI * 2;
}

/** Predict closest approaches so movement reacts to bullets that will hit, not merely nearby bullets. */
export function assessProjectileThreats(unit: UnitInstance, state: BattleState): ProjectileThreatAssessment[] {
  const assessments: ProjectileThreatAssessment[] = [];
  for (let projectileIndex = 0; projectileIndex < state.projectiles.length; projectileIndex += 1) {
    const projectile = state.projectiles[projectileIndex];
    if (projectile.side === unit.side) continue;
    const relativeX = unit.x - projectile.x;
    const relativeY = unit.y - projectile.y;
    const speedSq = projectile.vx * projectile.vx + projectile.vy * projectile.vy;
    if (speedSq < 1) continue;
    const rawTime = (relativeX * projectile.vx + relativeY * projectile.vy) / speedSq;
    if (rawTime < 0 || rawTime > 1.15) continue;
    const closestX = projectile.x + projectile.vx * rawTime;
    const closestY = projectile.y + projectile.vy * rawTime + 0.5 * projectile.gravity * rawTime * rawTime;
    const missX = unit.x - closestX;
    const missY = unit.y - closestY;
    const missDistance = Math.hypot(missX, missY);
    const clearance = missDistance - unit.radius - projectile.r;
    const urgency = 1 - rawTime / 1.15;
    const proximity = clamp(1 - clearance / Math.max(18, unit.radius * 1.7), 0, 1);
    const perpendicularX = -projectile.vy;
    const perpendicularY = projectile.vx;
    const norm = Math.hypot(perpendicularX, perpendicularY) || 1;
    const sign = (missX * perpendicularX + missY * perpendicularY) >= 0 ? 1 : -1;
    assessments.push({
      projectileIndex,
      timeToClosestS: rawTime,
      missDistance,
      clearance,
      score: proximity * (0.35 + urgency * 0.65),
      evadeX: perpendicularX / norm * sign,
      evadeY: perpendicularY / norm * sign,
    });
  }
  return assessments.sort((a, b) => b.score - a.score);
}

/**
 * Higher-skill threat prediction uses relative craft/projectile motion and the
 * projectile's remaining lifetime. The original solver remains unchanged for
 * lower levels so existing AI behavior is stable.
 */
export function assessProjectileThreatsAdvanced(
  unit: UnitInstance,
  state: BattleState,
  horizonS = 3,
): ProjectileThreatAssessment[] {
  const assessments: ProjectileThreatAssessment[] = [];
  const aliveStructureHp = unit.structure
    .filter((cell) => !cell.destroyed)
    .reduce((sum, cell) => sum + Math.max(0, cell.breakThreshold - cell.strain), 0);
  for (let projectileIndex = 0; projectileIndex < state.projectiles.length; projectileIndex += 1) {
    const projectile = state.projectiles[projectileIndex];
    if (projectile.side === unit.side) continue;
    const relativeX = projectile.x - unit.x;
    const relativeY = projectile.y - unit.y;
    const relativeVx = projectile.vx - unit.vx;
    const relativeVy = projectile.vy - unit.vy;
    const relativeSpeedSq = relativeVx * relativeVx + relativeVy * relativeVy;
    if (relativeSpeedSq < 1) continue;
    const projectileSpeed = Math.hypot(projectile.vx, projectile.vy);
    const remainingRangeS = projectileSpeed > 1
      ? Math.max(0, projectile.maxDistance - projectile.traveledDistance) / projectileSpeed
      : 0;
    const availableTime = Math.min(
      Math.max(0, horizonS),
      Math.max(0, projectile.ttl),
      remainingRangeS,
    );
    if (availableTime <= 0) continue;
    let closestTime = clamp(
      -(relativeX * relativeVx + relativeY * relativeVy) / relativeSpeedSq,
      0,
      availableTime,
    );
    // One refinement captures the vertical shift caused by gravity without a
    // costly iterative trajectory simulation.
    const gravityShift = 0.5 * projectile.gravity * closestTime * closestTime;
    closestTime = clamp(
      -(relativeX * relativeVx + (relativeY + gravityShift) * relativeVy) / relativeSpeedSq,
      0,
      availableTime,
    );
    const missX = relativeX + relativeVx * closestTime;
    const missY = relativeY + relativeVy * closestTime
      + 0.5 * projectile.gravity * closestTime * closestTime;
    const missDistance = Math.hypot(missX, missY);
    const clearance = missDistance - unit.radius - projectile.r;
    const collisionBand = Math.max(20, unit.radius * 1.9 + projectile.r);
    const proximity = clamp(1 - clearance / collisionBand, 0, 1);
    if (proximity <= 0) continue;
    const urgency = 1 - closestTime / Math.max(0.01, availableTime);
    const damagePressure = clamp(
      Math.max(projectile.currentDamage, projectile.damage)
        / Math.max(1, aliveStructureHp * 0.18),
      0.35,
      2.2,
    );
    const homingPressure = projectile.homingTargetId === unit.id ? 1.3 : 1;
    const perpendicularX = -relativeVy;
    const perpendicularY = relativeVx;
    const perpendicularLength = Math.hypot(perpendicularX, perpendicularY) || 1;
    const sideDot = missX * perpendicularX + missY * perpendicularY;
    const fallbackSign = Math.sin(stableUnitPhase(unit.id) + projectileIndex * 1.7) >= 0 ? 1 : -1;
    const sign = Math.abs(sideDot) > 1e-6 ? (sideDot >= 0 ? -1 : 1) : fallbackSign;
    assessments.push({
      projectileIndex,
      timeToClosestS: closestTime,
      missDistance,
      clearance,
      score: proximity * (0.3 + urgency * 0.7) * damagePressure * homingPressure,
      evadeX: perpendicularX / perpendicularLength * sign,
      evadeY: perpendicularY / perpendicularLength * sign,
    });
  }
  return assessments.sort(
    (a, b) => b.score - a.score || a.timeToClosestS - b.timeToClosestS,
  );
}

/**
 * Compares property-derived movement commands by rolling the live craft and
 * hostile projectile trajectories forward. This does not identify authored
 * craft or weapons; it uses only current kinematics, projectile damage/radius,
 * gravity, homing turn rate, and the craft's physical movement limits.
 */
export function chooseModelPredictiveEvasion(
  unit: UnitInstance,
  state: BattleState,
  preferredX: number,
  preferredY: number,
  horizonS = 1.8,
  directionCount = 12,
  alignmentWeight = 0.035,
): ModelPredictiveEvasion | null {
  const nearbyProjectiles = state.projectiles.filter((projectile) => {
    if (projectile.side === unit.side || projectile.projectileClass === "laser") return false;
    const speed = Math.hypot(projectile.vx, projectile.vy);
    const availableTime = Math.min(
      horizonS,
      Math.max(0, projectile.ttl),
      Math.max(0, projectile.maxDistance - projectile.traveledDistance) / Math.max(1, speed),
    );
    if (availableTime <= 0) return false;
    const reach = speed * availableTime + unit.maxSpeed * availableTime + unit.radius * 3;
    return Math.hypot(projectile.x - unit.x, projectile.y - unit.y) <= reach;
  });
  if (nearbyProjectiles.length === 0) return null;

  const preferredLength = Math.hypot(preferredX, preferredY);
  const preferred = preferredLength > 1e-6
    ? { x: preferredX / preferredLength, y: preferredY / preferredLength }
    : { x: 0, y: 0 };
  const directions = [
    preferred,
    ...Array.from({ length: Math.max(8, directionCount) }, (_, index) => {
      const angle = index * Math.PI * 2 / Math.max(8, directionCount);
      return { x: Math.cos(angle), y: Math.sin(angle) };
    }),
  ];
  const remainingHp = unit.structure
    .filter((cell) => !cell.destroyed)
    .reduce((sum, cell) => sum + Math.max(0, cell.breakThreshold - cell.strain), 0);
  const stepS = 0.05;

  const scoreDirection = (direction: { x: number; y: number }): number => {
    let risk = 0;
    for (const source of nearbyProjectiles) {
      let unitX = unit.x;
      let unitY = unit.y;
      let unitVx = unit.vx;
      let unitVy = unit.vy;
      let projectileX = source.x;
      let projectileY = source.y;
      let projectileVx = source.vx;
      let projectileVy = source.vy;
      let traveled = source.traveledDistance;
      let ttl = source.ttl;
      let elapsed = 0;
      let closestClearance = Number.POSITIVE_INFINITY;
      let closestTime = horizonS;
      while (elapsed < horizonS && ttl > 0 && traveled < source.maxDistance) {
        const dt = Math.min(stepS, horizonS - elapsed, ttl);
        if (unit.type === "air") {
          const targetVx = direction.x * Math.max(0, unit.maxSpeed);
          const targetVy = direction.y * Math.max(0, unit.maxSpeed);
          const deltaVx = targetVx - unitVx;
          const deltaVy = targetVy - unitVy;
          const deltaSpeed = Math.hypot(deltaVx, deltaVy);
          const accelerationStep = Math.max(0, unit.accel) * dt;
          if (deltaSpeed <= accelerationStep) {
            unitVx = targetVx;
            unitVy = targetVy;
          } else if (deltaSpeed > 1e-6 && accelerationStep > 0) {
            unitVx += deltaVx / deltaSpeed * accelerationStep;
            unitVy += deltaVy / deltaSpeed * accelerationStep;
          }
        } else {
          unitVx += direction.x * Math.max(0, unit.accel) * dt;
          unitVy += direction.y * Math.max(0, unit.accel) * dt;
          const frameScale = dt * 60;
          unitVx *= Math.pow(Math.max(0, unit.turnDrag), frameScale);
          unitVy *= Math.pow(0.83, frameScale);
        }
        const speedCap = Math.max(0, unit.maxSpeed);
        unitVx = clamp(unitVx, -speedCap, speedCap);
        unitVy = clamp(unitVy, -speedCap * (unit.type === "air" ? 1 : 0.75), speedCap * (unit.type === "air" ? 1 : 0.75));
        unitX += unitVx * dt;
        unitY += unitVy * dt;

        if (source.projectileClass === "missile" && source.homingTurnRateDegPerSec > 0) {
          const currentAngle = Math.atan2(projectileVy, projectileVx);
          const desiredAngle = Math.atan2(unitY - projectileY, unitX - projectileX);
          const maxTurn = source.homingTurnRateDegPerSec * Math.PI / 180 * dt;
          const delta = Math.atan2(
            Math.sin(desiredAngle - currentAngle),
            Math.cos(desiredAngle - currentAngle),
          );
          const nextAngle = currentAngle + clamp(delta, -maxTurn, maxTurn);
          const projectileSpeed = Math.hypot(projectileVx, projectileVy);
          projectileVx = Math.cos(nextAngle) * projectileSpeed;
          projectileVy = Math.sin(nextAngle) * projectileSpeed;
        }
        projectileVy += source.gravity * dt;
        const stepX = projectileVx * dt;
        const stepY = projectileVy * dt;
        projectileX += stepX;
        projectileY += stepY;
        traveled += Math.hypot(stepX, stepY);
        ttl -= dt;
        elapsed += dt;

        const clearance = Math.hypot(unitX - projectileX, unitY - projectileY)
          - unit.radius
          - source.r;
        if (clearance < closestClearance) {
          closestClearance = clearance;
          closestTime = elapsed;
        }
      }
      const dangerBand = Math.max(20, unit.radius * 1.2 + source.r);
      const proximity = clamp(1 - closestClearance / dangerBand, 0, 2);
      const damagePressure = clamp(
        Math.max(source.currentDamage, source.damage) / Math.max(1, remainingHp * 0.16),
        0.3,
        2.5,
      );
      const urgency = 1 + Math.max(0, horizonS - closestTime) / Math.max(0.1, horizonS);
      risk += proximity * proximity * damagePressure * urgency;
    }
    const alignment = direction.x * preferred.x + direction.y * preferred.y;
    return risk - alignment * alignmentWeight;
  };

  const baselineRisk = scoreDirection(preferred);
  const ranked = directions
    .map((direction) => ({ direction, risk: scoreDirection(direction) }))
    .sort((a, b) => a.risk - b.risk);
  const best = ranked[0];
  if (!best || baselineRisk < 0.12 || best.risk >= baselineRisk * 0.97) return null;
  return {
    evadeX: best.direction.x,
    evadeY: best.direction.y,
    baselineRisk,
    selectedRisk: best.risk,
  };
}

export function computeMovementDecision(
  unit: UnitInstance,
  state: BattleState,
  targetX: number,
  targetY: number,
  desiredRange: number,
  dt: number,
): MovementDecision {
  const dx = targetX - unit.x;
  const dy = targetY - unit.y;
  const distance = Math.hypot(dx, dy);
  const dirX = distance > 0 ? dx / distance : 0;
  const dirY = distance > 0 ? dy / distance : 0;

  let evadeX = 0;
  let evadeY = 0;
  const primaryThreat = assessProjectileThreats(unit, state)[0];
  if (primaryThreat) {
    evadeX = primaryThreat.evadeX;
    evadeY = primaryThreat.evadeY;
  }
  const shouldEvade = (primaryThreat?.score ?? 0) > 0.28;
  const preferredMinRange = desiredRange * 0.74;
  const preferredMaxRange = desiredRange * 1.1;

  let baseAx = 0;
  if (distance > preferredMaxRange) {
    baseAx = dirX;
  } else if (distance < preferredMinRange) {
    baseAx = -dirX * 0.22;
  } else {
    baseAx = dirX * 0.34;
  }

  const strafeSign = ((Math.floor((unit.aiStateTimer + unit.id.length) * 10) % 2) === 0) ? 1 : -1;
  const strafeX = -dirY * strafeSign;
  const strafeY = dirX * strafeSign;
  const baseAy = dirY * (unit.type === "air" ? 0.42 : 0.25) + strafeY * 0.55;
  baseAx += strafeX * 0.22;
  const evadeWeight = shouldEvade ? 0.85 : 0.18;
  const jinkScale = shouldEvade ? (unit.type === "air" ? 0.35 : 0.2) : (unit.type === "air" ? 0.16 : 0.09);
  const jinkPhase = unit.aiStateTimer * 8.3 + stableUnitPhase(unit.id);
  const randomJinkX = Math.sin(jinkPhase) * jinkScale * 0.5 * dt * 60;
  const randomJinkY = Math.cos(jinkPhase * 0.83) * jinkScale * 0.5 * dt * 60;

  return {
    ax: clamp(baseAx + evadeX * evadeWeight + randomJinkX, -1.4, 1.4),
    ay: clamp(baseAy + evadeY * evadeWeight + randomJinkY, -1.4, 1.4),
    shouldEvade,
  };
}
