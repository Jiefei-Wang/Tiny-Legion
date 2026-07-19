import { canOperate } from "./control-unit-rules.ts";
import { recalcMass } from "../physics/mass-cache.ts";
import type { UnitInstance } from "../../types.ts";

export function detachCellAttachments(unit: UnitInstance, cellId: number): void {
  for (const attachment of unit.attachments) {
    if (attachment.alive && attachment.attachedStructureCellIds.includes(cellId)) {
      attachment.alive = false;
    }
  }
  recalcMass(unit);
  if (!canOperate(unit)) {
    unit.vx = 0;
    unit.vy = 0;
    unit.vibrate = 0;
  }
}
