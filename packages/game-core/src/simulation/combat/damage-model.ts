import { MATERIALS } from "../../config/balance/materials.ts";
import { COMPONENTS } from "../../config/balance/weapons.ts";
import { IMPULSE_DAMAGE_STRESS_FACTOR } from "../../config/balance/battlefield.ts";
import { canOperate } from "../units/control-unit-rules.ts";
import { aliveStructureCells, destroyCell } from "../units/structure-grid.ts";
import { clamp, impulseToDeltaV } from "../physics/impulse-model.ts";
import type { UnitInstance } from "../../types.ts";

export function applyHitToUnit(
  unit: UnitInstance,
  incomingDamage: number,
  incomingImpulse: number,
  impactSide: number,
  impactedCellId: number | null = null,
): void {
  if (!canOperate(unit)) {
    return;
  }
  const cells = aliveStructureCells(unit.structure);
  if (cells.length === 0) {
    unit.alive = false;
    return;
  }

  const ordered = cells.slice().sort((a, b) => {
    if (a.x !== b.x) {
      return a.x - b.x;
    }
    if (a.y !== b.y) {
      return a.y - b.y;
    }
    return a.id - b.id;
  });
  const targetCell = impactedCellId !== null
    ? ordered.find((cell) => cell.id === impactedCellId) ?? (impactSide >= 0 ? ordered[ordered.length - 1] : ordered[0])
    : (impactSide >= 0 ? ordered[ordered.length - 1] : ordered[0]);
  const material = MATERIALS[targetCell.material];
  const stress = incomingDamage / Math.max(0.7, material.armor);
  const impulseStress = incomingImpulse * IMPULSE_DAMAGE_STRESS_FACTOR;
  targetCell.strain += stress + impulseStress;

  const deltaV = impulseToDeltaV(incomingImpulse, unit.mass);
  unit.vx += impactSide * deltaV;
  unit.vibrate = Math.min(1.7, unit.vibrate + deltaV * 1.6);

  if (targetCell.strain >= targetCell.breakThreshold) {
    destroyCell(unit, targetCell.id);
  }

  const localAttachments = unit.attachments.filter((attachment) => {
    if (!attachment.alive) {
      return false;
    }
    if (attachment.occupiedOffsets && attachment.occupiedOffsets.length > 0) {
      return attachment.occupiedOffsets.some((offset) => {
        if (!(offset.takesDamage ?? offset.takesFunctionalDamage)) {
          return false;
        }
        return attachment.x + offset.x === targetCell.x && attachment.y + offset.y === targetCell.y;
      });
    }
    return attachment.cell === targetCell.id;
  });
  if (localAttachments.length > 0) {
    const attachmentStressChance = Math.min(0.75, 0.22 + incomingDamage / 180);
    if (Math.random() < attachmentStressChance) {
      const localIndex = Math.floor(Math.random() * localAttachments.length);
      const pick = localAttachments[localIndex];
      if (pick) {
        const hpMul = pick.stats?.hpMul ?? COMPONENTS[pick.component].hpMul;
        const fragility = clamp(1 / Math.max(0.35, hpMul), 1, 2.4);
        if (Math.random() < Math.min(0.98, attachmentStressChance * fragility)) {
          pick.alive = false;
        }
      }
    }
  }

  if (!canOperate(unit)) {
    unit.alive = false;
  }
}

export function applyStructureRecovery(unit: UnitInstance, dt: number): void {
  if (dt <= 0 || !unit.alive || !canOperate(unit)) {
    return;
  }
  for (const cell of unit.structure) {
    if (cell.destroyed || cell.strain <= 0) {
      continue;
    }
    cell.strain = Math.max(0, cell.strain - cell.recoverPerSecond * dt);
  }
}
