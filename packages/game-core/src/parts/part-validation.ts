import { COMPONENTS } from "../config/balance/weapons.ts";
import type { PartDefinition } from "../types.ts";

export type PartValidationResult = {
  errors: string[];
  warnings: string[];
};

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

export function validatePartDefinitionDetailed(part: PartDefinition): PartValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!part.id || !/^[a-z0-9-]+$/.test(part.id)) {
    errors.push("part id must match [a-z0-9-]+.");
  }
  if (!part.name || part.name.trim().length < 2) {
    errors.push("part name is too short.");
  }
  if (part.layer !== "functional") {
    errors.push("part layer must be functional.");
  }
  if (!(part.baseComponent in COMPONENTS)) {
    errors.push("part baseComponent is invalid.");
  }

  if (!isFiniteInteger(part.anchor.x) || !isFiniteInteger(part.anchor.y)) {
    errors.push("part anchor coordinates must be integers.");
  }

  if (!Array.isArray(part.boxes) || part.boxes.length <= 0) {
    errors.push("part must include at least one box.");
  }

  const coordSet = new Set<string>();
  let hasFunctionalOccupancy = false;
  let hasStructureOccupancy = false;
  let hasDamageableBox = false;
  let hasAttachPoint = false;
  let hasShootingPoint = false;
  let anchorCovered = false;
  let anchorPointCount = 0;

  for (const box of part.boxes) {
    if (!isFiniteInteger(box.x) || !isFiniteInteger(box.y)) {
      errors.push("part box coordinates must be integers.");
      continue;
    }
    const key = `${box.x},${box.y}`;
    if (coordSet.has(key)) {
      errors.push("part boxes cannot overlap.");
    }
    coordSet.add(key);

    if (box.x === part.anchor.x && box.y === part.anchor.y) {
      anchorCovered = true;
    }

    const isAttachPoint = box.isAttachPoint === true;
    const occupiesStructure = isAttachPoint ? false : box.occupiesStructureSpace === true;
    const occupiesFunctional = isAttachPoint ? false : box.occupiesFunctionalSpace !== false;
    const needsStructureBehind = box.needsStructureBehind === true;
    const takesDamage = box.takesDamage ?? box.takesFunctionalDamage ?? (occupiesStructure || occupiesFunctional);
    const isAnchorPoint = box.isAnchorPoint === true;
    const isShootingPoint = box.isShootingPoint === true;

    if (occupiesFunctional) {
      hasFunctionalOccupancy = true;
    }
    if (occupiesStructure) {
      hasStructureOccupancy = true;
    }
    if (isAttachPoint) {
      hasAttachPoint = true;
    }
    if (isShootingPoint) {
      hasShootingPoint = true;
    }
    if (takesDamage) {
      hasDamageableBox = true;
    }
    if (isAnchorPoint) {
      anchorPointCount += 1;
      if (box.x !== part.anchor.x || box.y !== part.anchor.y) {
        warnings.push("anchorPoint flag should match part.anchor coordinates.");
      }
    }

    if (needsStructureBehind && (occupiesStructure || !occupiesFunctional)) {
      warnings.push("needsStructureBehind only applies to functional-only boxes.");
    }
    if (isAttachPoint && (box.occupiesStructureSpace === true || box.occupiesFunctionalSpace !== false)) {
      warnings.push("attach point boxes should not occupy structure/functional space.");
    }
  }

  if (!anchorCovered) {
    warnings.push("anchor is outside part box footprint.");
  }
  if (anchorPointCount > 1) {
    errors.push("part can define only one anchorPoint box.");
  }
  if (!hasFunctionalOccupancy && !hasStructureOccupancy) {
    warnings.push("part has no occupancy; defaults will treat boxes as functional occupancy.");
  }
  const partCategory = (part.properties?.category ?? "functional").trim().toLowerCase();
  if (!hasDamageableBox && partCategory !== "functional") {
    warnings.push("part has no damageable box.");
  }
  if (!hasShootingPoint && COMPONENTS[part.baseComponent].type === "weapon") {
    warnings.push("weapon part has no shooting point; anchor will be used as muzzle fallback.");
  }
  if (hasAttachPoint && !hasFunctionalOccupancy && !hasStructureOccupancy) {
    warnings.push("part contains attach-point markers but no occupancy boxes.");
  }

  const placement = part.placement;
  const checkOffsets = (offsets: ReadonlyArray<{ x: number; y: number }> | undefined, label: string): void => {
    for (const offset of offsets ?? []) {
      if (!isFiniteInteger(offset.x) || !isFiniteInteger(offset.y)) {
        errors.push(`${label} offsets must be integers.`);
      }
    }
  };
  checkOffsets(placement?.requireStructureOffsets, "requireStructure");
  checkOffsets(placement?.requireEmptyStructureOffsets, "requireEmptyStructure");
  checkOffsets(placement?.requireEmptyFunctionalOffsets, "requireEmptyFunctional");

  if (placement?.requireStructureOnFunctionalOccupiedBoxes === false && !hasStructureOccupancy) {
    warnings.push("functional occupied boxes do not require structure support.");
  }

  if (part.properties?.hp !== undefined && (!Number.isFinite(part.properties.hp) || part.properties.hp < 0)) {
    errors.push("part properties.hp must be a non-negative number.");
  }
  if (part.properties?.loaderCooldownMultiplier !== undefined && (!Number.isFinite(part.properties.loaderCooldownMultiplier) || part.properties.loaderCooldownMultiplier <= 0)) {
    errors.push("part properties.loaderCooldownMultiplier must be > 0.");
  }
  if (part.properties?.engineType !== undefined && part.properties.engineType !== "ground" && part.properties.engineType !== "air") {
    errors.push("part properties.engineType must be ground or air.");
  }
  if (part.properties?.isWeapon === true && !part.properties.weaponType) {
    warnings.push("is_weapon is enabled but weaponType is not set.");
  }
  if (part.properties?.isEngine === true && !part.properties.engineType) {
    warnings.push("is_engine is enabled but engineType is not set.");
  }
  if (part.properties?.isLoader === true && (!part.properties.loaderServesTags || part.properties.loaderServesTags.length <= 0)) {
    warnings.push("is_loader is enabled but loaderServesTags is empty.");
  }
  if (part.properties?.isLoader === true && part.properties.loaderCooldownMultiplier === undefined) {
    warnings.push("is_loader is enabled but loaderCooldownMultiplier is not set.");
  }
  if (part.properties?.isArmor === true && part.properties.hp === undefined) {
    warnings.push("is_armor is enabled but hp is not set.");
  }
  if (
    part.properties?.hasCoreTuning === true
    && part.runtimeOverrides?.mass === undefined
    && part.runtimeOverrides?.hpMul === undefined
  ) {
    warnings.push("core_tuning is enabled but neither mass nor hpMul override is set.");
  }
  if (part.properties?.isWeapon !== true && part.properties?.weaponType !== undefined) {
    warnings.push("weaponType is set while is_weapon is disabled.");
  }
  if (part.properties?.isEngine !== true && part.properties?.engineType !== undefined) {
    warnings.push("engineType is set while is_engine is disabled.");
  }
  if (part.properties?.isLoader !== true && part.properties?.loaderServesTags !== undefined) {
    warnings.push("loaderServesTags is set while is_loader is disabled.");
  }
  if (part.properties?.isLoader !== true && part.properties?.loaderCooldownMultiplier !== undefined) {
    warnings.push("loaderCooldownMultiplier is set while is_loader is disabled.");
  }

  return {
    errors: unique(errors),
    warnings: unique(warnings),
  };
}

export function validatePartDefinition(part: PartDefinition): { valid: boolean; reason: string | null } {
  const result = validatePartDefinitionDetailed(part);
  if (result.errors.length > 0) {
    return { valid: false, reason: result.errors[0] ?? "invalid part" };
  }
  return { valid: true, reason: null };
}
