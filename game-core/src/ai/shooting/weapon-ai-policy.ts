import type { WeaponClass } from "../../types.ts";

type WeaponAimCapabilities = {
  weaponClass: WeaponClass;
  explosiveBlastRadius: number;
  trackingTurnRateDegPerSec: number;
};

export function adjustAimForWeaponPolicy(weapon: WeaponAimCapabilities, aim: { x: number; y: number }): { x: number; y: number } {
  if (weapon.weaponClass === "tracking" || weapon.trackingTurnRateDegPerSec > 0) {
    return { x: aim.x, y: aim.y - 10 };
  }
  if (weapon.weaponClass === "explosive" || weapon.explosiveBlastRadius > 0) {
    return { x: aim.x, y: aim.y + 4 };
  }
  return aim;
}
