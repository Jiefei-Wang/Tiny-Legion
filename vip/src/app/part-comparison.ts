import { MATERIALS } from "../config/balance/materials.ts";
import { COMPONENTS } from "../config/balance/weapons.ts";
import type { PartDefinition } from "../types.ts";

export interface WeaponComparisonValues {
  gasCost: number;
  mass: number;
  damage: number;
  penetration: number;
  cooldown: number;
  maxCapacity: number;
  minFireInterval: number;
}

export interface StructureComparisonValues {
  gasCost: number;
  mass: number;
  armor: number;
  hp: number;
}

const finiteNonNegative = (value: number | undefined, fallback: number): number => (
  Number.isFinite(value) ? Math.max(0, Number(value)) : fallback
);

export function resolvePartGasCost(part: PartDefinition): number {
  return finiteNonNegative(
    part.stats?.gasCost ?? part.partProperties?.gasCost,
    COMPONENTS[part.baseComponent].gasCost ?? 0,
  );
}

export function resolvePartMass(part: PartDefinition): number {
  return finiteNonNegative(
    part.stats?.mass ?? part.partProperties?.mass,
    COMPONENTS[part.baseComponent].mass ?? 0,
  );
}

export function resolveWeaponComparisonValues(part: PartDefinition): WeaponComparisonValues {
  const base = COMPONENTS[part.baseComponent];
  const maxCapacity = Math.max(
    1,
    Math.floor(finiteNonNegative(part.partProperties?.maxCapacity, base.maxLoadedAmmo ?? 1)),
  );
  return {
    gasCost: resolvePartGasCost(part),
    mass: resolvePartMass(part),
    damage: finiteNonNegative(part.stats?.damage ?? part.partProperties?.damage, base.damage ?? 0),
    penetration: finiteNonNegative(part.stats?.penetration ?? part.partProperties?.penetration, base.penetration ?? 0),
    cooldown: finiteNonNegative(part.stats?.cooldown ?? part.partProperties?.cooldown, base.cooldown ?? 0),
    maxCapacity,
    minFireInterval: finiteNonNegative(part.partProperties?.minFireInterval, 0.2),
  };
}

export function resolveStructureComparisonValues(part: PartDefinition): StructureComparisonValues {
  const material = part.properties?.materialId
    ? MATERIALS[part.properties.materialId]
    : MATERIALS.basic;
  return {
    gasCost: resolvePartGasCost(part),
    mass: resolvePartMass(part),
    armor: finiteNonNegative(
      part.properties?.materialArmor ?? part.partProperties?.armor,
      material.armor,
    ),
    hp: finiteNonNegative(
      part.properties?.hp ?? part.partProperties?.hp,
      material.hp,
    ),
  };
}

export function calculateHitsToDestroy(
  weapon: WeaponComparisonValues,
  structure: StructureComparisonValues,
): number {
  if (structure.hp <= 0) {
    return 0;
  }
  const effectiveDamage = Math.max(1, weapon.damage - structure.armor);
  return Math.ceil(structure.hp / effectiveDamage);
}

export function calculateDestroyTimeSeconds(
  hits: number,
  weapon: WeaponComparisonValues,
): number {
  const safeHits = Math.max(0, Math.floor(hits));
  if (safeHits <= 1) {
    return 0;
  }
  const capacity = Math.max(1, Math.floor(weapon.maxCapacity));
  const completedMagazines = Math.floor((safeHits - 1) / capacity);
  const shotsIntoFinalMagazine = (safeHits - 1) % capacity;
  const magazineCycle = (capacity - 1) * weapon.minFireInterval + weapon.cooldown;
  return completedMagazines * magazineCycle + shotsIntoFinalMagazine * weapon.minFireInterval;
}

export function formatDestroyTime(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return "—";
  }
  const rounded = Math.round(Math.max(0, seconds) * 100) / 100;
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })}s`;
}
