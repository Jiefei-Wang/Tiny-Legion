import { COMPONENTS } from "../../config/balance/weapons.ts";
import { PROJECTILE_GRAVITY, PROJECTILE_SPEED } from "../../config/balance/range.ts";
import { impulseToDeltaV } from "../physics/impulse-model.ts";
import type { Attachment, UnitInstance } from "../../types.ts";

export function getAliveWeaponAttachments(unit: UnitInstance): Attachment[] {
  return unit.weaponAttachmentIds
    .map((id) => unit.attachments.find((entry) => entry.id === id && entry.alive) ?? null)
    .filter((entry): entry is Attachment => entry !== null);
}

export function firstAliveWeaponAttachment(unit: UnitInstance): Attachment | null {
  if (unit.weaponAttachmentIds.length === 0) {
    return null;
  }
  const selectedAttachmentId = unit.weaponAttachmentIds[unit.selectedWeaponIndex] ?? unit.weaponAttachmentIds[0];
  const preferred = unit.attachments.find((entry) => {
    return entry.id === selectedAttachmentId && entry.alive;
  });
  if (preferred) {
    return preferred;
  }
  const all = getAliveWeaponAttachments(unit);
  return all[0] ?? null;
}

export function applyRecoilForAttachment(
  unit: UnitInstance,
  weaponAttachmentId: number,
): {
  damage: number;
  impulse: number;
  range: number;
  cooldown: number;
  weaponClass: NonNullable<(typeof COMPONENTS)[keyof typeof COMPONENTS]["weaponClass"]>;
  projectileSpeed: number;
  projectileGravity: number;
  spreadDeg: number;
  explosive: (typeof COMPONENTS)[keyof typeof COMPONENTS]["explosive"] | null;
  trackingTurnRateDegPerSec: number;
  controlImpairFactor: number;
  controlDuration: number;
} | null {
  const weaponAttachment = unit.attachments.find((entry) => entry.id === weaponAttachmentId && entry.alive);
  if (!weaponAttachment) {
    return null;
  }
  const weapon = COMPONENTS[weaponAttachment.component];
  if (
    weapon.type !== "weapon" ||
    weapon.recoil === undefined ||
    weapon.hitImpulse === undefined ||
    weapon.damage === undefined ||
    weapon.range === undefined ||
    weapon.cooldown === undefined
  ) {
    return null;
  }

  const direction = unit.side === "player" ? 1 : -1;
  unit.vx -= direction * impulseToDeltaV(weapon.recoil, unit.mass);
  unit.vibrate = Math.min(1.2, unit.vibrate + impulseToDeltaV(weapon.recoil, unit.mass) * 2.2);

  return {
    damage: weapon.damage,
    impulse: weapon.hitImpulse,
    range: weapon.range,
    cooldown: weapon.cooldown,
    weaponClass: weapon.weaponClass ?? "rapid-fire",
    projectileSpeed: weapon.projectileSpeed ?? PROJECTILE_SPEED,
    projectileGravity: weapon.projectileGravity ?? PROJECTILE_GRAVITY,
    spreadDeg: weapon.spreadDeg ?? 0,
    explosive: weapon.explosive ?? null,
    trackingTurnRateDegPerSec: weapon.tracking?.turnRateDegPerSec ?? 0,
    controlImpairFactor: weapon.control?.impairFactor ?? 1,
    controlDuration: weapon.control?.duration ?? 0,
  };
}

export function applyRecoil(unit: UnitInstance): ReturnType<typeof applyRecoilForAttachment> {
  const attachment = firstAliveWeaponAttachment(unit);
  if (!attachment) {
    return null;
  }
  return applyRecoilForAttachment(unit, attachment.id);
}
