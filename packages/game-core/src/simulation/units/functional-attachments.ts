import { COMPONENTS } from "../../config/balance/weapons.ts";
import { canOperate } from "./control-unit-rules.ts";
import { recalcMass } from "../physics/mass-cache.ts";
import type { UnitInstance } from "../../types.ts";

export function detachCellAttachments(unit: UnitInstance, cellId: number): void {
  for (const attachment of unit.attachments) {
    if (attachment.alive && attachment.cell === cellId) {
      attachment.alive = false;
      const component = COMPONENTS[attachment.component];
      if (component.type === "control") {
        unit.alive = false;
      }
      if (component.type === "ammo" && Math.random() < 0.3) {
        for (const cell of unit.structure) {
          if (!cell.destroyed) {
            cell.strain += 18;
          }
        }
      }
    }
  }
  recalcMass(unit);
  if (!canOperate(unit)) {
    unit.alive = false;
  }
}
