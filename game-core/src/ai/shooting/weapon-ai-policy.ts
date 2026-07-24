import type { ProjectileClass } from "../../types.ts";

type WeaponAimCapabilities = {
  projectileClass: ProjectileClass;
  explosiveBlastRadius: number;
  trackingTurnRateDegPerSec: number;
};

export function adjustAimForWeaponPolicy(weapon: WeaponAimCapabilities, aim: { x: number; y: number }): { x: number; y: number } {
  if (weapon.projectileClass === "missile" && weapon.trackingTurnRateDegPerSec > 0) {
    return { x: aim.x, y: aim.y - 10 };
  }
  if (weapon.explosiveBlastRadius > 0) {
    return { x: aim.x, y: aim.y + 4 };
  }
  return aim;
}
