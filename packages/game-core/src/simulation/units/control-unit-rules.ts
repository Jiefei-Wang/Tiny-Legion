import { COMPONENTS } from "../../config/balance/weapons.ts";
import type { Attachment, UnitInstance } from "../../types.ts";

export function getControlUnit(attachments: Attachment[]): Attachment | null {
  const controlUnits = attachments.filter((attachment) => {
    return attachment.alive && COMPONENTS[attachment.component].type === "control";
  });
  return controlUnits[0] ?? null;
}

export function validateSingleControlUnit(attachments: Attachment[]): boolean {
  return attachments.some((attachment) => attachment.alive && COMPONENTS[attachment.component].type === "control");
}

export function canOperate(unit: UnitInstance): boolean {
  if (!unit.alive) {
    return false;
  }
  return unit.attachments.some((attachment) => attachment.alive && COMPONENTS[attachment.component].type === "control");
}
