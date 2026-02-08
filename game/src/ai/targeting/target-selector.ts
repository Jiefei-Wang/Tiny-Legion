import type { BattleState, UnitInstance } from "../../types.ts";

export function selectBestTarget(unit: UnitInstance, state: BattleState): UnitInstance | null {
  let best: UnitInstance | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const other of state.units) {
    if (!other.alive || other.side === unit.side) {
      continue;
    }
    const dx = other.x - unit.x;
    const dy = other.y - unit.y;
    const distance = Math.hypot(dx, dy);
    const closingPenalty = Math.max(0, 40 - Math.hypot(other.vx, other.vy)) * 0.2;
    const score = distance + Math.abs(dy) * 0.7 + closingPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}
