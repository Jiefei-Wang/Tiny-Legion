import type { UnitInstance } from "../../types.ts";

export const GLOBAL_WEAPON_RANGE_MULTIPLIER = 1.5;
export const AIRCRAFT_RANGE_BONUS_MAX = 1.0;
export const PROJECTILE_SPEED = 260;
export const PROJECTILE_GRAVITY = 95;
export const GROUND_FIRE_Y_TOLERANCE = 92;
export const AI_GRAVITY_CORRECTION_STEP = 10;
export const AI_GRAVITY_CORRECTION_CLAMP = 120;
export const AI_MISS_VERTICAL_TOLERANCE = 8;

export function getAircraftAltitudeBonus(unit: UnitInstance, airMinZ: number, groundMinY: number): number {
  if (unit.type !== "air") {
    return 0;
  }
  const altitudeSpan = Math.max(1, groundMinY - airMinZ);
  const normalized = (groundMinY - unit.y) / altitudeSpan;
  return Math.max(0, Math.min(AIRCRAFT_RANGE_BONUS_MAX, normalized * AIRCRAFT_RANGE_BONUS_MAX));
}
