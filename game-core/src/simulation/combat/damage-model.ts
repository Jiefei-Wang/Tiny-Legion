import { canOperate } from "../units/control-unit-rules.ts";
import { aliveStructureCells, destroyCell } from "../units/structure-grid.ts";
import { impulseToDeltaV } from "../physics/impulse-model.ts";
import type { UnitInstance } from "../../types.ts";

export interface DamageApplicationResult {
  incomingDamage: number;
  armorDeducted: number;
  deliveredDamage: number;
  structureDamage: number;
  functionalDamage: number;
}

export function scaleDamageByRemainingPenetration(
  baseDamage: number,
  initialPenetration: number,
  remainingPenetration: number,
): number {
  const safeDamage = Math.max(0, baseDamage);
  if (initialPenetration <= 0) {
    return safeDamage;
  }
  const ratio = Math.max(0, Math.min(1, remainingPenetration / initialPenetration));
  return safeDamage * ratio;
}

export function applyHitToUnit(
  unit: UnitInstance,
  incomingDamage: number,
  incomingImpulse: number,
  impactSide: number,
  impactedCellId: number | null = null,
  ignoreArmor = false,
): DamageApplicationResult {
  const noDamage = (): DamageApplicationResult => ({ incomingDamage, armorDeducted: 0, deliveredDamage: 0, structureDamage: 0, functionalDamage: 0 });
  if (!unit.alive) {
    return noDamage();
  }
  const cells = aliveStructureCells(unit.structure);
  if (cells.length === 0) {
    unit.alive = false;
    return noDamage();
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
  const armorDeducted = ignoreArmor
    ? 0
    : Math.min(Math.max(0, incomingDamage), Math.max(0, targetCell.armor));
  const damageAfterArmor = incomingDamage - armorDeducted;
  const effectiveDamage = ignoreArmor ? Math.max(0, incomingDamage) : (damageAfterArmor <= 0 ? 1 : damageAfterArmor);
  const deltaV = impulseToDeltaV(incomingImpulse, unit.mass);
  unit.vx += impactSide * deltaV;
  unit.vibrate = Math.min(1.7, unit.vibrate + deltaV * 1.6);

  const structureDamage = effectiveDamage;
  targetCell.strain += structureDamage;

  if (targetCell.strain >= targetCell.breakThreshold) {
    destroyCell(unit, targetCell.id);
  }

  if (!canOperate(unit)) {
    unit.vx = 0;
    unit.vy = 0;
    unit.vibrate = 0;
  }
  return {
    incomingDamage,
    armorDeducted,
    deliveredDamage: effectiveDamage,
    structureDamage,
    functionalDamage: 0,
  };
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
