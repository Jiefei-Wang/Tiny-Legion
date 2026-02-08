import { clamp } from "../../simulation/physics/impulse-model.ts";
import type { BattleState, UnitInstance } from "../../types.ts";

export interface MovementDecision {
  ax: number;
  ay: number;
  shouldEvade: boolean;
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
  let highestThreat = 0;

  for (const projectile of state.projectiles) {
    if (projectile.side === unit.side) {
      continue;
    }
    const rx = unit.x - projectile.x;
    const ry = unit.y - projectile.y;
    const pvx = projectile.vx;
    const pvy = projectile.vy;
    const pv2 = pvx * pvx + pvy * pvy;
    if (pv2 < 1) {
      continue;
    }
    const t = clamp((rx * pvx + ry * pvy) / pv2, 0, 0.75);
    const cx = projectile.x + pvx * t;
    const cy = projectile.y + pvy * t;
    const mdx = unit.x - cx;
    const mdy = unit.y - cy;
    const miss = Math.hypot(mdx, mdy);
    const threat = 1 / Math.max(22, miss);
    if (threat > highestThreat) {
      highestThreat = threat;
      const perpX = -pvy;
      const perpY = pvx;
      const norm = Math.hypot(perpX, perpY) || 1;
      const sign = (mdx * perpX + mdy * perpY) >= 0 ? 1 : -1;
      evadeX = (perpX / norm) * sign;
      evadeY = (perpY / norm) * sign;
    }
  }

  const shouldEvade = highestThreat > 0.022;
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
  const randomJinkX = (Math.random() - 0.5) * jinkScale * dt * 60;
  const randomJinkY = (Math.random() - 0.5) * jinkScale * dt * 60;

  return {
    ax: clamp(baseAx + evadeX * evadeWeight + randomJinkX, -1.4, 1.4),
    ay: clamp(baseAy + evadeY * evadeWeight + randomJinkY, -1.4, 1.4),
    shouldEvade,
  };
}
