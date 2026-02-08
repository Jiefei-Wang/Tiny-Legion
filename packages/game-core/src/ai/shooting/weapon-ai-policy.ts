import type { ComponentId } from "../../types.ts";

export function adjustAimForWeaponPolicy(componentId: ComponentId, aim: { x: number; y: number }): { x: number; y: number } {
  if (componentId === "trackingMissile") {
    return { x: aim.x, y: aim.y - 10 };
  }
  if (componentId === "explosiveShell") {
    return { x: aim.x, y: aim.y + 4 };
  }
  return aim;
}
