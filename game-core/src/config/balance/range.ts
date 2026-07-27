import type { UnitInstance } from "../../types.ts";
import { GAME_CONFIG } from "../generated/game-config.generated.ts";

const config = GAME_CONFIG.balance.range;

export const GLOBAL_WEAPON_RANGE_MULTIPLIER = config.weaponRangeMultiplier;
export const AIRCRAFT_RANGE_BONUS_MAX = config.aircraftRangeBonusMax;
export const PROJECTILE_SPEED = config.projectileSpeed;
export const PROJECTILE_GRAVITY = config.projectileGravity;
export const AI_TARGET_HISTORY_WINDOW_S = config.targetHistory.windowSeconds;
export const AI_TARGET_HISTORY_SAMPLES = config.targetHistory.samples;
export const AI_TARGET_HISTORY_SAMPLE_INTERVAL_S = AI_TARGET_HISTORY_WINDOW_S / AI_TARGET_HISTORY_SAMPLES;

export function getAircraftAltitudeBonus(unit: UnitInstance, airMinZ: number, groundMinY: number): number {
  if (unit.type !== "air") {
    return 0;
  }
  const altitudeSpan = Math.max(1, groundMinY - airMinZ);
  const normalized = (groundMinY - unit.y) / altitudeSpan;
  return Math.max(0, Math.min(AIRCRAFT_RANGE_BONUS_MAX, normalized * AIRCRAFT_RANGE_BONUS_MAX));
}
