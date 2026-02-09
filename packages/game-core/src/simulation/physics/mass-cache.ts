import { MATERIALS } from "../../config/balance/materials.ts";
import { COMPONENTS } from "../../config/balance/weapons.ts";
import type { UnitInstance } from "../../types.ts";

export function recalcMass(unit: UnitInstance): void {
  let total = 0;
  for (const cell of unit.structure) {
    if (!cell.destroyed) {
      total += MATERIALS[cell.material].mass;
    }
  }
  for (const attachment of unit.attachments) {
    if (attachment.alive) {
      total += attachment.stats?.mass ?? COMPONENTS[attachment.component].mass;
    }
  }
  unit.mass = Math.max(14, total);
}
