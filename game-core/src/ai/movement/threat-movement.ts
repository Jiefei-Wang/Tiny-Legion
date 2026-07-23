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
