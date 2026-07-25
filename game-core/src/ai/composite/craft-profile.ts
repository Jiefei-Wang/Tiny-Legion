import { structureIntegrity } from "../../simulation/units/structure-grid.ts";
import type { BattleAiInput, WeaponFireAiInput } from "./composite-ai.ts";

export type CraftCombatRole =
  | "raider"
  | "interceptor"
  | "skirmisher"
  | "siege"
  | "brawler"
  | "generalist";

export interface CraftCombatProfile {
  role: CraftCombatRole;
  mobility: number;
  acceleration: number;
  integrity: number;
  durability: number;
  averageArmor: number;
  maxRange: number;
  sustainedDamagePerSecond: number;
  burstDamage: number;
  maximumAmmo: number;
  loadedAmmo: number;
  loadedRatio: number;
  rapidWeaponRatio: number;
  trackingWeaponRatio: number;
  explosiveWeaponRatio: number;
  weapons: WeaponFireAiInput[];
}

/**
 * Classify the live craft from simulation properties only. Template/part names
 * and IDs are deliberately absent so authored craft inherit tactics naturally.
 */
export function classifyCraft(input: BattleAiInput): CraftCombatProfile {
  const weapons: WeaponFireAiInput[] = [];
  for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
    const weapon = input.getWeaponFireInput(slot);
    if (weapon) weapons.push(weapon);
  }

  const aliveCells = input.unit.structure.filter((cell) => !cell.destroyed);
  const integrity = structureIntegrity(input.unit);
  const averageArmor = aliveCells.length > 0
    ? aliveCells.reduce((sum, cell) => sum + cell.armor, 0) / aliveCells.length
    : 0;
  const remainingStructureHp = aliveCells.reduce(
    (sum, cell) => sum + Math.max(0, cell.breakThreshold - cell.strain),
    0,
  );
  const durability = remainingStructureHp + averageArmor * aliveCells.length * 0.7;
  const maxRange = weapons.reduce((value, weapon) => Math.max(value, weapon.effectiveRange), 0);
  const sustainedDamagePerSecond = weapons.reduce(
    (sum, weapon) => sum + weapon.damage / Math.max(0.05, weapon.cooldownS),
    0,
  );
  const burstDamage = weapons.reduce(
    (sum, weapon) => sum + weapon.damage * Math.max(1, weapon.maximumAmmo),
    0,
  );
  const maximumAmmo = weapons.reduce((sum, weapon) => sum + Math.max(1, weapon.maximumAmmo), 0);
  const loadedAmmo = weapons.reduce((sum, weapon) => sum + Math.max(0, weapon.loadedAmmo), 0);
  const loadedRatio = maximumAmmo > 0 ? Math.min(1, loadedAmmo / maximumAmmo) : 0;
  const rapidWeaponRatio = weapons.length > 0
    ? weapons.filter((weapon) => (
      weapon.projectileClass === "laser"
      || weapon.maximumAmmo >= 4
      || weapon.cooldownS <= 0.65
    )).length / weapons.length
    : 0;
  const trackingWeaponRatio = weapons.length > 0
    ? weapons.filter((weapon) => weapon.trackingTurnRateDegPerSec > 0).length / weapons.length
    : 0;
  const explosiveWeaponRatio = weapons.length > 0
    ? weapons.filter((weapon) => weapon.explosiveBlastRadius > 0).length / weapons.length
    : 0;
  const mobility = Math.max(0, input.unit.maxSpeed);
  const acceleration = Math.max(0, input.unit.accel);
  const movementPerEngagement = mobility / Math.max(80, maxRange);
  const durableForMass = durability / Math.max(16, input.unit.mass);
  const burstToSustain = burstDamage / Math.max(1, sustainedDamagePerSecond);

  let role: CraftCombatRole = "generalist";
  if (
    input.unit.type === "air"
    && movementPerEngagement >= 0.12
    && maximumAmmo >= 4
    && burstToSustain >= 0.8
  ) {
    role = "raider";
  } else if (
    (trackingWeaponRatio >= 0.5 || rapidWeaponRatio >= 0.6)
    && movementPerEngagement >= 0.08
  ) {
    role = "interceptor";
  } else if (
    maxRange >= 620
    && (explosiveWeaponRatio >= 0.35 || burstDamage >= sustainedDamagePerSecond * 1.8)
    && movementPerEngagement < 0.16
  ) {
    role = "siege";
  } else if (durableForMass >= 1.15 && averageArmor >= 8 && movementPerEngagement < 0.13) {
    role = "brawler";
  } else if (movementPerEngagement >= 0.12 || (mobility >= 70 && durableForMass < 1.2)) {
    role = "skirmisher";
  }

  return {
    role,
    mobility,
    acceleration,
    integrity,
    durability,
    averageArmor,
    maxRange,
    sustainedDamagePerSecond,
    burstDamage,
    maximumAmmo,
    loadedAmmo,
    loadedRatio,
    rapidWeaponRatio,
    trackingWeaponRatio,
    explosiveWeaponRatio,
    weapons,
  };
}
