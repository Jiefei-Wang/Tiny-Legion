import { AI_TARGET_HISTORY_SAMPLE_INTERVAL_S } from "../../config/balance/range.ts";
import { structureIntegrity } from "../../simulation/units/structure-grid.ts";
import { getStructureCellSize } from "../../config/balance/battlefield.ts";
import { MAX_CERTIFIED_AI_LEVEL } from "../../config/ai/levels.ts";
import { canOperate } from "../../simulation/units/control-unit-rules.ts";
import { solveBallisticAim } from "../shooting/ballistic-aim.ts";
import { createUnifiedLevelShootAi } from "../shooting/unified-level-shoot.ts";
import {
  assessProjectileThreats,
  assessProjectileThreatsAdvanced,
  chooseModelPredictiveEvasion,
} from "../movement/threat-movement.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";
import {
  createSkillTierMovementAi,
  createSkillTierShootAi,
  createSkillTierTargetAi,
} from "./skill-tier-modules.ts";
import { classifyCraft } from "./craft-profile.ts";
import type {
  BattleAiInput,
  FirePlan,
  MovementAiModule,
  RankedTarget,
  ShootAiModule,
  ShootDecision,
  TargetAiModule,
  TargetDecision,
  MovementDecision,
  WeaponFireAiInput,
} from "./composite-ai.ts";
import type { StructureCell, UnitInstance } from "../../types.ts";

export type AiLevel = number;
export { MAX_CERTIFIED_AI_LEVEL };

function remainingCellRatio(cell: StructureCell): number {
  return Math.max(0, cell.breakThreshold - cell.strain) / Math.max(1, cell.breakThreshold);
}

function cellWorldPoint(unit: UnitInstance, cell: StructureCell): { x: number; y: number } {
  const minX = Math.min(...unit.structure.map((candidate) => candidate.x));
  const maxX = Math.max(...unit.structure.map((candidate) => candidate.x));
  const minY = Math.min(...unit.structure.map((candidate) => candidate.y));
  const maxY = Math.max(...unit.structure.map((candidate) => candidate.y));
  const cellSize = getStructureCellSize(unit.radius);
  const localX = (cell.x - minX) * cellSize - (maxX - minX + 1) * cellSize / 2 + cellSize / 2;
  const localY = (cell.y - minY) * cellSize - (maxY - minY + 1) * cellSize / 2 + cellSize / 2;
  return { x: unit.x + localX * unit.facing, y: unit.y + localY };
}

function supportedCell(unit: UnitInstance, attachmentId: number | undefined): StructureCell | null {
  if (attachmentId === undefined) return null;
  const attachment = unit.attachments.find((candidate) => candidate.id === attachmentId && candidate.alive);
  if (!attachment) return null;
  const supportIds = new Set(attachment.attachedStructureCellIds);
  return unit.structure
    .filter((cell) => !cell.destroyed && supportIds.has(cell.id))
    .sort((a, b) => remainingCellRatio(a) - remainingCellRatio(b) || a.armor - b.armor)[0] ?? null;
}

function exposedCells(unit: UnitInstance, shooterX: number): StructureCell[] {
  const alive = unit.structure.filter((cell) => !cell.destroyed);
  if (alive.length === 0) return [];
  const frontX = shooterX < unit.x
    ? Math.min(...alive.map((cell) => cellWorldPoint(unit, cell).x))
    : Math.max(...alive.map((cell) => cellWorldPoint(unit, cell).x));
  return alive.filter((cell) => Math.abs(cellWorldPoint(unit, cell).x - frontX) < 1e-6);
}

/** Selects impact structure from live geometry and weapon capabilities only. */
function chooseWeaponAimCell(
  enemy: UnitInstance,
  shooterX: number,
  weapon: WeaponFireAiInput,
  aimLevel = 1,
): StructureCell | null {
  const exposed = exposedCells(enemy, shooterX);
  if (exposed.length === 0) return null;
  if (aimLevel >= 19) {
    const supportCandidates = [
      { cell: supportedCell(enemy, enemy.controlAttachmentId), disabledValue: 2.4 },
      ...enemy.weaponAttachmentIds.map((attachmentId) => ({
        cell: supportedCell(enemy, attachmentId),
        disabledValue: 1,
      })),
    ].filter((entry): entry is { cell: StructureCell; disabledValue: number } => entry.cell !== null);
    const exposedIds = new Set(exposed.map((cell) => cell.id));
    const bestDisable = supportCandidates
      .filter((entry) => exposedIds.has(entry.cell.id) || weapon.penetration >= entry.cell.armor)
      .map((entry) => {
        const sharedSupports = supportCandidates.filter((other) => other.cell.id === entry.cell.id);
        const disabledValue = sharedSupports.reduce((sum, other) => sum + other.disabledValue, 0);
        const effectiveDamage = Math.max(1, weapon.damage - entry.cell.armor);
        const remainingHp = Math.max(0, entry.cell.breakThreshold - entry.cell.strain);
        return {
          cell: entry.cell,
          efficiency: remainingHp / effectiveDamage / Math.max(1, disabledValue),
        };
      })
      .sort((a, b) => a.efficiency - b.efficiency || remainingCellRatio(a.cell) - remainingCellRatio(b.cell))[0];
    if (bestDisable) return bestDisable.cell;
  }
  if (weapon.penetration > 0) {
    const controlSupport = supportedCell(enemy, enemy.controlAttachmentId);
    if (controlSupport && weapon.penetration >= controlSupport.armor) return controlSupport;
  }
  if (weapon.explosiveBlastRadius > 0) {
    const alive = enemy.structure.filter((cell) => !cell.destroyed);
    return exposed
      .map((cell) => {
        const point = cellWorldPoint(enemy, cell);
        const nearby = alive.filter((other) => {
          const otherPoint = cellWorldPoint(enemy, other);
          return Math.hypot(otherPoint.x - point.x, otherPoint.y - point.y) <= weapon.explosiveBlastRadius;
        }).length;
        return { cell, nearby };
      })
      .sort((a, b) => b.nearby - a.nearby || remainingCellRatio(a.cell) - remainingCellRatio(b.cell))[0]?.cell ?? null;
  }
  return exposed.sort((a, b) => {
    const aEffective = Math.max(1, weapon.damage - a.armor);
    const bEffective = Math.max(1, weapon.damage - b.armor);
    return bEffective - aEffective || remainingCellRatio(a) - remainingCellRatio(b);
  })[0] ?? null;
}

function liveEnemy(input: BattleAiInput, targetId: string): UnitInstance | null {
  return input.state.units.find((unit) => unit.id === targetId && unit.alive && canOperate(unit) && unit.side !== input.unit.side) ?? null;
}

function liveWeaponProperties(unit: UnitInstance): {
  count: number;
  maxRange: number;
  damagePressure: number;
} {
  let count = 0;
  let maxRange = 0;
  let damagePressure = 0;
  for (const attachmentId of unit.weaponAttachmentIds) {
    const attachment = unit.attachments.find((candidate) => candidate.id === attachmentId && candidate.alive);
    const range = Math.max(0, attachment?.stats?.range ?? 0);
    const damage = Math.max(0, attachment?.stats?.damage ?? 0);
    if (!attachment || range <= 0 || damage <= 0) continue;
    count += 1;
    maxRange = Math.max(maxRange, range);
    damagePressure += damage / Math.max(0.08, attachment.stats?.cooldown ?? 1);
  }
  return { count, maxRange, damagePressure };
}

/**
 * Scores whether an enemy is an immediate local threat using only live motion,
 * geometry, and weapon properties. A positive value means it can engage now or
 * will enter its own firing envelope shortly while closing.
 */
function localThreatPressure(input: BattleAiInput, enemy: UnitInstance): number {
  const weapons = liveWeaponProperties(enemy);
  if (weapons.count === 0) return 0;
  const dx = enemy.x - input.unit.x;
  const dy = enemy.y - input.unit.y;
  const distance = Math.hypot(dx, dy);
  const closingSpeed = distance > 1e-6
    ? Math.max(0, -((enemy.vx - input.unit.vx) * dx + (enemy.vy - input.unit.vy) * dy) / distance)
    : 0;
  const contactBuffer = input.unit.radius + enemy.radius + 100;
  const dangerRange = Math.max(contactBuffer, weapons.maxRange * 1.12 + closingSpeed * 1.25);
  if (distance > dangerRange) return 0;
  const proximity = 1 - clamp(distance / Math.max(1, dangerRange), 0, 1);
  const outputScale = clamp(Math.log2(1 + weapons.damagePressure) / 6, 0.25, 2);
  return (0.35 + proximity) * (1 + Math.min(3, weapons.count - 1) * 0.2) * outputScale;
}

function enemyAwarenessRange(input: BattleAiInput, profile = classifyCraft(input)): number {
  return Math.max(
    600,
    input.desiredRange * 1.45,
    profile.maxRange * 1.2,
    profile.mobility * 5,
  );
}

export function hasEnemyWithinAwareness(
  unitX: number,
  unitY: number,
  awarenessRange: number,
  targets: ReadonlyArray<Pick<RankedTarget, "x" | "y">>,
): boolean {
  return targets.some((candidate) => (
    Math.hypot(candidate.x - unitX, candidate.y - unitY) <= awarenessRange
  ));
}

function hasEnemyAround(input: BattleAiInput, targets: ReadonlyArray<RankedTarget>, profile = classifyCraft(input)): boolean {
  return hasEnemyWithinAwareness(
    input.unit.x,
    input.unit.y,
    enemyAwarenessRange(input, profile),
    targets,
  );
}

function solvePlan(
  input: BattleAiInput,
  weapon: WeaponFireAiInput,
  slot: number,
  target: RankedTarget | null,
  point: { x: number; y: number },
): FirePlan | null {
  const distance = Math.hypot(point.x - weapon.firepointX, point.y - weapon.firepointY);
  if (distance > weapon.effectiveRange * 1.04) return null;
  const solved = solveBallisticAim(
    weapon.firepointX,
    weapon.firepointY,
    point.x,
    point.y,
    target?.vx ?? 0,
    target?.vy ?? 0,
    weapon.effectiveRange,
    weapon.projectileSpeed,
    weapon.projectileGravity,
  );
  const angleRad = solved?.firingAngleRad ?? Math.atan2(point.y - weapon.firepointY, point.x - weapon.firepointX);
  if (!input.canShootAtAngle(
    weapon.componentId,
    Math.cos(angleRad) * distance,
    Math.sin(angleRad) * distance,
    weapon.angleLimit,
  )) return null;
  return {
    preferredSlot: slot,
    intendedTargetId: target?.targetId ?? null,
    intendedTargetY: solved?.y ?? point.y,
    angleRad,
    leadTimeS: solved?.leadTimeS ?? 0,
    effectiveRange: weapon.effectiveRange,
  };
}

function createCadencedTargetAi(base: TargetAiModule, intervalS: number): TargetAiModule {
  if (intervalS <= 0) return base;
  const cache = new Map<string, { nextDecisionAt: number; decision: TargetDecision }>();
  return {
    decideTarget: (input) => {
      const prior = cache.get(input.unit.id);
      if (prior && input.unit.aiStateTimer < prior.nextDecisionAt) return prior.decision;
      const decision = base.decideTarget(input);
      cache.set(input.unit.id, {
        nextDecisionAt: input.unit.aiStateTimer + intervalS,
        decision,
      });
      return decision;
    },
  };
}

function createCadencedMovementAi(base: MovementAiModule, intervalS: number): MovementAiModule {
  if (intervalS <= 0) return base;
  const cache = new Map<string, { nextDecisionAt: number; decision: MovementDecision }>();
  return {
    decideMovement: (input, target) => {
      const prior = cache.get(input.unit.id);
      if (prior && input.unit.aiStateTimer < prior.nextDecisionAt) return prior.decision;
      const decision = base.decideMovement(input, target);
      cache.set(input.unit.id, {
        nextDecisionAt: input.unit.aiStateTimer + intervalS,
        decision,
      });
      return decision;
    },
  };
}

function createProactiveWeaveMovementAi(
  base: MovementAiModule,
  frequency: number,
  strength: number,
  retain: number,
): MovementAiModule {
  return {
    decideMovement: (input, target) => {
      const decision = base.decideMovement(input, target);
      if (decision.shouldEvade || input.unit.maxSpeed <= 0) return decision;
      const dx = target.attackPoint.x - input.unit.x;
      const dy = target.attackPoint.y - input.unit.y;
      const distance = Math.hypot(dx, dy) || 1;
      const towardX = dx / distance;
      const towardY = dy / distance;
      const maneuverability = clamp(
        input.unit.accel / Math.max(40, input.unit.maxSpeed),
        0.4,
        1.4,
      );
      const propertyPhase = input.unit.mass * 0.13
        + input.unit.deploymentGasCost * 0.07;
      const weave = Math.sin(input.unit.aiStateTimer * frequency + propertyPhase)
        * strength
        * maneuverability;
      return {
        ...decision,
        ax: clamp(decision.ax * retain - towardY * weave, -1.4, 1.4),
        ay: clamp(decision.ay * retain + towardX * weave, -1.4, 1.4),
        debugTag: `${decision.debugTag}-property-proactive-weave`,
      };
    },
  };
}

function createPreservationMovementAi(
  base: MovementAiModule,
  integrityThreshold: number,
): MovementAiModule {
  return {
    decideMovement: (input, target) => {
      const decision = base.decideMovement(input, target);
      const profile = classifyCraft(input);
      const operationalAllies = input.state.units.filter((ally) => (
        ally.alive && canOperate(ally) && ally.side === input.unit.side
      ));
      if (
        operationalAllies.length >= 2
        && profile.mobility > 0
        && profile.integrity < integrityThreshold
      ) {
        return {
          ...decision,
          shouldEvade: true,
          withdraw: true,
          state: "evade",
          debugTag: `${decision.debugTag}-property-damage-preservation`,
        };
      }
      return decision;
    },
  };
}

function createValueFormationMovementAi(
  base: MovementAiModule,
  screenRatio: number,
  supportRatio: number,
  backlineRatio: number,
): MovementAiModule {
  return {
    decideMovement: (input, target) => {
      const decision = base.decideMovement(input, target);
      if (decision.shouldEvade) return decision;
      const profile = classifyCraft(input);
      if (profile.maxRange <= 0) return decision;
      const operationalAllies = input.state.units.filter((ally) => (
        ally.alive && canOperate(ally) && ally.side === input.unit.side
      ));
      const highestAlliedValue = Math.max(
        1,
        ...operationalAllies.map((ally) => Math.max(1, ally.deploymentGasCost)),
      );
      const relativeValue = Math.max(1, input.unit.deploymentGasCost) / highestAlliedValue;
      const desiredRatio = relativeValue <= 0.22
        ? screenRatio
        : relativeValue >= 0.65
          ? backlineRatio
          : supportRatio;
      const dx = target.attackPoint.x - input.unit.x;
      const dy = target.attackPoint.y - input.unit.y;
      const distance = Math.hypot(dx, dy) || 1;
      const towardX = dx / distance;
      const towardY = dy / distance;
      const desired = Math.max(input.unit.radius * 4, profile.maxRange * desiredRatio);
      const rangeDirection = distance > desired * 1.05
        ? (relativeValue <= 0.22 ? 1.35 : 1.02)
        : distance < desired * 0.9
          ? (relativeValue >= 0.65 ? -1.28 : -0.55)
          : 0.12;
      return {
        ...decision,
        ax: clamp(towardX * rangeDirection - towardY * 0.1, -1.4, 1.4),
        ay: clamp(towardY * Math.abs(rangeDirection) * 0.56 + towardX * 0.3, -1.4, 1.4),
        debugTag: `${decision.debugTag}-property-value-formation`,
      };
    },
  };
}

function createCadencedShootAi(base: ShootAiModule, intervalS: number): ShootAiModule {
  if (intervalS <= 0) return base;
  const cache = new Map<string, { nextDecisionAt: number; decision: ShootDecision }>();
  return {
    decideShoot: (input, target, movement) => {
      const prior = cache.get(input.unit.id);
      if (prior && input.unit.aiStateTimer < prior.nextDecisionAt) return prior.decision;
      const decision = base.decideShoot(input, target, movement);
      cache.set(input.unit.id, {
        nextDecisionAt: input.unit.aiStateTimer + intervalS,
        decision,
      });
      return decision;
    },
  };
}

const REACTION_INTERVALS_S = [1.2, 0.8, 0.55, 0.35, 0.2, 0.1, 0.04, 0] as const;

export function createLevelTargetAi(level: AiLevel): TargetAiModule {
  if (level >= 40 && level <= 47) {
    return createCadencedTargetAi(
      createLevelTargetAi(29),
      REACTION_INTERVALS_S[level - 40]!,
    );
  }
  const high = createSkillTierTargetAi("high");
  const integrityWeight = 160;
  const weaponThreatWeight = 12;
  return {
    decideTarget: (input) => {
      const decision = high.decideTarget(input);
      const profile = classifyCraft(input);
      const rankedTargets = decision.rankedTargets
        .map((candidate) => {
          const enemy = liveEnemy(input, candidate.targetId);
          if (!enemy) return candidate;
          const integrity = structureIntegrity(enemy);
          const liveWeapons = enemy.weaponAttachmentIds.filter((attachmentId) => enemy.attachments.some((entry) => entry.id === attachmentId && entry.alive)).length;
          let score = candidate.score + integrity * integrityWeight - liveWeapons * weaponThreatWeight;
          if (level >= 2) {
            const aliveCells = enemy.structure.filter((cell) => !cell.destroyed);
            const maximumArmor = aliveCells.reduce((value, cell) => Math.max(value, cell.armor), 0);
            const averageArmor = aliveCells.length > 0
              ? aliveCells.reduce((sum, cell) => sum + cell.armor, 0) / aliveCells.length
              : 0;
            const bestPenetration = profile.weapons.reduce((value, weapon) => Math.max(value, weapon.penetration), 0);
            const antiAirOutput = profile.weapons.filter((weapon) => (
              weapon.projectileClass === "laser"
              || weapon.trackingTurnRateDegPerSec > 0
              || weapon.maximumAmmo >= 4
            )).length;
            const armorMismatch = Math.max(0, maximumArmor - bestPenetration);
            score += armorMismatch * (profile.rapidWeaponRatio >= 0.5 ? 2.6 : 0.7);
            if (enemy.type === "air" && antiAirOutput > 0) score -= 80 + antiAirOutput * 45;
            if (enemy.type === "ground" && bestPenetration >= averageArmor && bestPenetration > 0) score -= 95;
            if (level >= 3) {
              const alliedFocus = input.state.units.filter((ally) => (
                ally.alive
                && canOperate(ally)
                && ally.side === input.unit.side
                && ally.id !== input.unit.id
                && ally.aiDebugTargetId === enemy.id
              )).length;
              const remainingHp = aliveCells.reduce(
                (sum, cell) => sum + Math.max(0, cell.breakThreshold - cell.strain),
                0,
              );
              const ownShotDamage = Math.max(1, ...profile.weapons.map((weapon) => weapon.damage));
              const usefulFocus = Math.max(1, Math.ceil(remainingHp / Math.max(1, ownShotDamage * 2)));
              score += Math.max(0, alliedFocus - usefulFocus) * 110;
              score -= Math.min(alliedFocus, usefulFocus) * 18;
            }
            if (level >= 4) {
              const ownBase = input.unit.side === "player" ? input.state.playerBase : input.state.enemyBase;
              const baseCenterX = ownBase.x + ownBase.w * 0.5;
              const baseCenterY = ownBase.y + ownBase.h * 0.5;
              const baseDistance = Math.hypot(enemy.x - baseCenterX, enemy.y - baseCenterY);
              const opposingBase = input.unit.side === "player" ? input.state.enemyBase : input.state.playerBase;
              const baseSpan = Math.hypot(
                opposingBase.x + opposingBase.w * 0.5 - baseCenterX,
                opposingBase.y + opposingBase.h * 0.5 - baseCenterY,
              );
              const pressure = 1 - clamp(baseDistance / Math.max(1, baseSpan * 0.55), 0, 1);
              score -= pressure * (liveWeapons * 30 + 55);
            }
            if (level >= 5) {
              const controlCell = supportedCell(enemy, enemy.controlAttachmentId);
              const controlHp = controlCell
                ? Math.max(0, controlCell.breakThreshold - controlCell.strain)
                : aliveCells.reduce(
                  (minimum, cell) => Math.min(minimum, Math.max(0, cell.breakThreshold - cell.strain)),
                  Number.POSITIVE_INFINITY,
                );
              const bestDisableDamage = profile.weapons.reduce(
                (best, weapon) => Math.max(best, Math.max(1, weapon.damage - (controlCell?.armor ?? averageArmor))),
                1,
              );
              const disableShots = Number.isFinite(controlHp) ? Math.ceil(controlHp / bestDisableDamage) : 99;
              score += disableShots * 34;
              score -= liveWeapons * profile.sustainedDamagePerSecond * 0.08;
              const speed = Math.hypot(enemy.vx, enemy.vy);
              const escapePotential = speed / Math.max(1, input.unit.maxSpeed);
              score += Math.max(0, escapePotential - 0.8) * 24;
            }
            if (level >= 34 && level <= 37) {
              const controlSupport = supportedCell(enemy, enemy.controlAttachmentId);
              const decisiveHp = controlSupport
                ? Math.max(0, controlSupport.breakThreshold - controlSupport.strain)
                : aliveCells.reduce(
                  (minimum, cell) => Math.min(
                    minimum,
                    Math.max(0, cell.breakThreshold - cell.strain),
                  ),
                  Number.POSITIVE_INFINITY,
                );
              const committedDamage = input.state.projectiles
                .filter((projectile) => {
                  if (projectile.side !== input.unit.side) return false;
                  if (projectile.homingTargetId === enemy.id) return true;
                  return Math.hypot(
                    projectile.intendedTargetX - enemy.x,
                    projectile.intendedTargetY - enemy.y,
                  ) <= enemy.radius * 1.8;
                })
                .reduce((sum, projectile) => (
                  sum + Math.max(0, projectile.currentDamage)
                ), 0);
              const commitmentRatio = level === 34
                ? 0.6
                : level === 35
                  ? 0.8
                  : level === 36
                    ? 1
                    : 1.2;
              if (
                Number.isFinite(decisiveHp)
                && decisiveHp > 0
                && committedDamage >= decisiveHp * commitmentRatio
              ) {
                score += 4_000 + committedDamage * 4;
              }
            }
            if (level >= 52 && level <= 57) {
              const controlSupport = supportedCell(enemy, enemy.controlAttachmentId);
              const decisiveHp = controlSupport
                ? Math.max(0, controlSupport.breakThreshold - controlSupport.strain)
                : aliveCells.reduce(
                  (minimum, cell) => Math.min(
                    minimum,
                    Math.max(0, cell.breakThreshold - cell.strain),
                  ),
                  Number.POSITIVE_INFINITY,
                );
              const targetArmor = controlSupport?.armor ?? averageArmor;
              const bestEffectiveDamage = profile.weapons.reduce(
                (best, weapon) => Math.max(
                  best,
                  Math.max(1, weapon.damage - targetArmor),
                ),
                1,
              );
              const fastestProjectile = profile.weapons.reduce(
                (fastest, weapon) => Math.max(fastest, weapon.projectileSpeed),
                1,
              );
              const trackingRelief = profile.trackingWeaponRatio * 0.7
                + profile.rapidWeaponRatio * 0.2;
              const dx = enemy.x - input.unit.x;
              const dy = enemy.y - input.unit.y;
              const distance = Math.hypot(dx, dy) || 1;
              const lineX = dx / distance;
              const lineY = dy / distance;
              const lateralSpeed = Math.abs(enemy.vx * -lineY + enemy.vy * lineX);
              const flightTime = distance / Math.max(1, fastestProjectile);
              const movementUncertainty = Math.max(
                0,
                (
                  lateralSpeed * flightTime
                  + enemy.accel * flightTime * flightTime * 0.35
                ) / Math.max(12, enemy.radius * 2)
                - trackingRelief
              );
              const shotsToDisable = Number.isFinite(decisiveHp)
                ? decisiveHp / bestEffectiveDamage
                : 99;
              const expectedEffort = Math.max(
                0.25,
                shotsToDisable * (1 + movementUncertainty),
              );
              const valuePerExpectedShot = Math.max(1, enemy.deploymentGasCost)
                / expectedEffort;
              const efficiencyWeight = level === 52
                ? 10
                : level === 53
                  ? 25
                  : level === 54
                    ? 50
                    : level === 55
                      ? 100
                      : level === 56
                        ? 200
                        : 400;
              score -= valuePerExpectedShot * efficiencyWeight;
            }
            if (level >= 6 && level < 29) {
              const distance = Math.hypot(candidate.x - input.unit.x, candidate.y - input.unit.y);
              const reachableWeapons = profile.weapons.filter((weapon) => distance <= weapon.effectiveRange * 1.04).length;
              score -= reachableWeapons * 22;
            }
            if (level >= 8 && level < 12) {
              const remainingStructureHp = aliveCells.reduce(
                (sum, cell) => sum + Math.max(0, cell.breakThreshold - cell.strain),
                0,
              );
              const gasValue = Math.max(0, enemy.deploymentGasCost);
              const finishMultiplier = 1 + (1 - integrity) * 1.4;
              const valueDensity = gasValue / Math.max(1, Math.sqrt(remainingStructureHp));
              const gasWeight = level === 9
                ? 0.35
                : level === 10
                  ? 0.75
                  : level >= 11
                    ? 1.25
                    : 2.2;
              score -= gasValue * gasWeight * finishMultiplier + valueDensity * gasWeight * 7;
            }
            if (level >= 12 && level < 29 && enemy.escapeActive) {
              score -= 1_600 + Math.max(0, enemy.deploymentGasCost) * 3.2;
            }
            if (level >= 13 && level < 29) {
              score += integrity * 920;
              if (enemy.escapeActive) {
                score -= 1_400;
              }
            }
            if (level >= 14 && level < 29) {
              const remainingStructureHp = aliveCells.reduce(
                (sum, cell) => sum + Math.max(0, cell.breakThreshold - cell.strain),
                0,
              );
              const valueWeight = level === 14
                ? 4
                : level === 15
                  ? 8
                  : level === 16
                    ? 16
                    : 28;
              const finishProbability = 1 + (1 - integrity) * 2.2;
              const valueDensity = Math.max(0, enemy.deploymentGasCost)
                / Math.max(1, Math.sqrt(remainingStructureHp));
              score -= Math.max(0, enemy.deploymentGasCost) * valueWeight * finishProbability;
              score -= valueDensity * valueWeight * 18;
            }
            if (level >= 25 && level < 29) {
              const additionalFinishWeight = level === 25
                ? 500
                : level === 26
                  ? 1_000
                  : level === 27
                    ? 2_000
                    : 4_000;
              score += integrity * additionalFinishWeight;
            }
          }
          return { ...candidate, score };
        })
        .sort((a, b) => a.score - b.score || a.targetId.localeCompare(b.targetId));
      if (level === 38 || level === 39 || level === 50 || level === 51) {
        const opposingBase = input.unit.side === "player"
          ? input.state.enemyBase
          : input.state.playerBase;
        const baseRatio = opposingBase.hp / Math.max(1, opposingBase.maxHp);
        const pressureThreshold = level === 38
          ? 0.35
          : level === 39
            ? 0.6
            : level === 50
              ? 0.8
              : 1;
        const distanceToBase = Math.hypot(
          input.baseTarget.x - input.unit.x,
          input.baseTarget.y - input.unit.y,
        );
        if (
          profile.maxRange > 0
          && distanceToBase <= profile.maxRange * 1.04
          && baseRatio <= pressureThreshold
        ) {
          return {
            rankedTargets: [],
            attackPoint: { ...input.baseTarget },
            debugTag: "target.property-in-range-base-pressure",
          };
        }
      }
      if (level >= 29) {
        const opposingBase = input.unit.side === "player"
          ? input.state.enemyBase
          : input.state.playerBase;
        const readyBaseDamage = input.state.units
          .filter((ally) => ally.alive && canOperate(ally) && ally.side === input.unit.side)
          .reduce((alliedDamage, ally) => (
            alliedDamage + ally.weaponAttachmentIds.reduce((weaponDamage, attachmentId, slot) => {
              const attachment = ally.attachments.find((candidate) => (
                candidate.id === attachmentId && candidate.alive
              ));
              const damage = Math.max(0, attachment?.stats?.damage ?? 0);
              const range = Math.max(0, attachment?.stats?.range ?? 0);
              const loaded = Math.max(0, ally.weaponReadyCharges[slot] ?? 0);
              const distanceToBase = Math.hypot(
                input.baseTarget.x - ally.x,
                input.baseTarget.y - ally.y,
              );
              return weaponDamage + (
                distanceToBase <= range * 1.15
                  ? damage * loaded
                  : 0
              );
            }, 0)
          ), 0);
        const executionFactor = level >= 34
          ? 2
          : level === 29
          ? 2
          : level === 30
            ? 3
            : level === 31
              ? 4
              : level === 32
                ? 5
                : 6;
        if (readyBaseDamage > 0 && opposingBase.hp <= readyBaseDamage * executionFactor) {
          return {
            rankedTargets: [],
            attackPoint: { ...input.baseTarget },
            debugTag: "target.property-loaded-base-execution",
          };
        }
      }
      const primary = rankedTargets[0];
      const enemyIsAround = hasEnemyAround(input, rankedTargets, profile);
      return {
        rankedTargets,
        attackPoint: primary && enemyIsAround
          ? { x: primary.x, y: primary.y }
          : { ...input.baseTarget },
        debugTag: level <= 1
          ? "target.level-1.former-level-2"
          : `target.level-${Math.min(6, level)}.property-ranked`,
      };
    },
  };
}

export function createLevelMovementAi(level: AiLevel): MovementAiModule {
  if (level >= 88 && level <= 95) {
    return createCadencedMovementAi(
      createLevelMovementAi(86),
      REACTION_INTERVALS_S[level - 88]!,
    );
  }
  if (level >= 96 && level <= 101) {
    const settings = level === 96
      ? { frequency: 1.6, strength: 0.25, retain: 0.9 }
      : level === 97
        ? { frequency: 2.4, strength: 0.4, retain: 0.82 }
        : level === 98
          ? { frequency: 3.2, strength: 0.55, retain: 0.75 }
          : level === 99
            ? { frequency: 4.5, strength: 0.7, retain: 0.65 }
            : level === 100
              ? { frequency: 6, strength: 0.85, retain: 0.55 }
              : { frequency: 7.5, strength: 1, retain: 0.45 };
    return createProactiveWeaveMovementAi(
      createLevelMovementAi(86),
      settings.frequency,
      settings.strength,
      settings.retain,
    );
  }
  if (level >= 115 && level <= 119) {
    const settings = level === 115
      ? { frequency: 3.4, strength: 0.58, retain: 0.73 }
      : level === 116
        ? { frequency: 3.6, strength: 0.6, retain: 0.72 }
        : level === 117
          ? { frequency: 3.8, strength: 0.62, retain: 0.7 }
          : level === 118
            ? { frequency: 4, strength: 0.65, retain: 0.68 }
            : { frequency: 4.2, strength: 0.67, retain: 0.67 };
    return createProactiveWeaveMovementAi(
      createLevelMovementAi(86),
      settings.frequency,
      settings.strength,
      settings.retain,
    );
  }
  if (level >= 120 && level <= 124) {
    const predictiveBaseLevel = level === 120
      ? 85
      : level === 121
        ? 83
        : level === 122
          ? 80
          : level === 123
            ? 84
            : 81;
    return createProactiveWeaveMovementAi(
      createLevelMovementAi(predictiveBaseLevel),
      4.5,
      0.7,
      0.65,
    );
  }
  if (level >= 102 && level <= 108) {
    const threshold = level === 102
      ? 0.15
      : level === 103
        ? 0.25
        : level === 104
          ? 0.35
          : level === 105
            ? 0.45
            : level === 106
              ? 0.55
              : level === 107
                ? 0.65
                : 0.75;
    return createPreservationMovementAi(
      createLevelMovementAi(86),
      threshold,
    );
  }
  if (level >= 109 && level <= 114) {
    const bands = level === 109
      ? { screen: 0.35, support: 0.58, backline: 0.72 }
      : level === 110
        ? { screen: 0.4, support: 0.62, backline: 0.8 }
        : level === 111
          ? { screen: 0.45, support: 0.66, backline: 0.88 }
          : level === 112
            ? { screen: 0.5, support: 0.7, backline: 0.94 }
            : level === 113
              ? { screen: 0.3, support: 0.68, backline: 0.9 }
              : { screen: 0.55, support: 0.62, backline: 0.96 };
    return createValueFormationMovementAi(
      createLevelMovementAi(86),
      bands.screen,
      bands.support,
      bands.backline,
    );
  }
  const high = createSkillTierMovementAi("high");
  if (level <= 1) return high;
  const raidRetreatByUnit = new Map<string, boolean>();
  return {
    decideMovement: (input, target) => {
      const base = high.decideMovement(input, target);
      const profile = classifyCraft(input);
      const dx = target.attackPoint.x - input.unit.x;
      const dy = target.attackPoint.y - input.unit.y;
      const distance = Math.hypot(dx, dy) || 1;
      const towardX = dx / distance;
      const towardY = dy / distance;
      let ax = base.ax;
      let ay = base.ay;
      let shouldEvade = base.shouldEvade;
      let withdraw = false;
      let tactic: string = profile.role;

      if (profile.role === "raider") {
        let retreating = raidRetreatByUnit.get(input.unit.id) ?? false;
        if (profile.loadedRatio <= 0.28) retreating = true;
        if (profile.loadedRatio >= 0.76) retreating = false;
        raidRetreatByUnit.set(input.unit.id, retreating);
        if (retreating) {
          ax = -towardX * 1.25 - towardY * 0.3;
          ay = -towardY * 1.05 + towardX * 0.72;
          shouldEvade = true;
          tactic = "raider-reload";
        } else if (distance > input.desiredRange * 0.78) {
          ax = towardX * 1.18 - towardY * 0.18;
          ay = towardY * 0.85 + towardX * 0.3;
        } else {
          ax = -towardY * 0.5;
          ay = towardX * 0.92;
        }
      } else if (profile.role === "siege") {
        const desired = Math.max(input.desiredRange, profile.maxRange * 0.78);
        const rangeDirection = distance > desired * 1.04 ? 1 : distance < desired * 0.88 ? -1 : 0;
        ax = towardX * rangeDirection * 0.88 - towardY * 0.12;
        ay = towardY * rangeDirection * 0.55 + towardX * 0.22;
      } else if (profile.role === "brawler") {
        const push = distance > input.desiredRange * 0.62 ? 1.12 : 0.35;
        ax = towardX * push - towardY * 0.12;
        ay = towardY * push * 0.65 + towardX * 0.28;
      } else if (profile.role === "interceptor") {
        const rangeDirection = distance > input.desiredRange * 0.88 ? 1 : distance < input.desiredRange * 0.58 ? -0.6 : 0.1;
        ax = towardX * rangeDirection - towardY * 0.42;
        ay = towardY * Math.abs(rangeDirection) * 0.6 + towardX * 0.72;
      } else if (profile.role === "skirmisher") {
        const rangeDirection = distance > input.desiredRange * 0.94 ? 1 : distance < input.desiredRange * 0.72 ? -0.82 : 0.05;
        ax = towardX * rangeDirection - towardY * 0.38;
        ay = towardY * Math.abs(rangeDirection) * 0.55 + towardX * 0.62;
      }

      if (level >= 9 && level < 20 && profile.maxRange > 0) {
        const valuePreservation = clamp(
          input.unit.deploymentGasCost / Math.max(40, profile.durability),
          0,
          1.25,
        );
        const desired = Math.max(
          input.desiredRange * (0.9 + valuePreservation * 0.16),
          profile.maxRange * (0.8 + valuePreservation * 0.1),
        );
        const rangeDirection = distance > desired * 1.04
          ? 1
          : distance < desired * 0.9
            ? -(0.72 + valuePreservation * 0.28)
            : 0;
        ax = towardX * rangeDirection * 1.05 - towardY * 0.22;
        ay = towardY * Math.abs(rangeDirection) * 0.62 + towardX * 0.42;
        tactic = `${tactic}-value-range-control`;
      }

      if (level >= 10 && level < 20 && profile.maxRange > 0) {
        const alliedValues = input.state.units
          .filter((ally) => ally.alive && canOperate(ally) && ally.side === input.unit.side)
          .map((ally) => Math.max(1, ally.deploymentGasCost));
        const highestAlliedValue = Math.max(1, ...alliedValues);
        const relativeValue = Math.max(1, input.unit.deploymentGasCost) / highestAlliedValue;
        if (relativeValue >= 0.72) {
          const desired = Math.max(input.desiredRange, profile.maxRange * 0.9);
          const rangeDirection = distance > desired * 1.05 ? 0.82 : distance < desired * 0.96 ? -1.15 : -0.18;
          ax = towardX * rangeDirection - towardY * 0.16;
          ay = towardY * Math.abs(rangeDirection) * 0.5 + towardX * 0.3;
          tactic = `${tactic}-high-value-backline`;
        } else if (relativeValue <= 0.4) {
          const desired = Math.max(140, Math.min(input.desiredRange * 0.58, profile.maxRange * 0.58));
          const rangeDirection = distance > desired ? 1.28 : distance < desired * 0.62 ? -0.25 : 0.4;
          ax = towardX * rangeDirection - towardY * 0.12;
          ay = towardY * Math.abs(rangeDirection) * 0.58 + towardX * 0.28;
          tactic = `${tactic}-low-value-screen`;
        }
      }

      if (level >= 11 && level < 20 && profile.maxRange > 0) {
        const alliedValues = input.state.units
          .filter((ally) => ally.alive && canOperate(ally) && ally.side === input.unit.side)
          .map((ally) => Math.max(1, ally.deploymentGasCost));
        const highestAlliedValue = Math.max(1, ...alliedValues);
        const ownValue = Math.max(1, input.unit.deploymentGasCost);
        const relativeValue = ownValue / highestAlliedValue;
        if (ownValue >= 100 && relativeValue >= 0.65) {
          const desired = Math.max(input.desiredRange * 0.92, profile.maxRange * 0.82);
          const rangeDirection = distance > desired * 1.06 ? 0.92 : distance < desired * 0.9 ? -1.08 : 0;
          ax = towardX * rangeDirection - towardY * 0.1;
          ay = towardY * Math.abs(rangeDirection) * 0.45 + towardX * 0.2;
          tactic = `${tactic}-refined-backline`;
        } else if (ownValue <= highestAlliedValue * 0.2) {
          const desired = Math.max(160, Math.min(input.desiredRange * 0.65, profile.maxRange * 0.65));
          const rangeDirection = distance > desired ? 1.2 : distance < desired * 0.58 ? -0.2 : 0.3;
          ax = towardX * rangeDirection - towardY * 0.1;
          ay = towardY * Math.abs(rangeDirection) * 0.55 + towardX * 0.24;
          tactic = `${tactic}-refined-screen`;
        }
      }

      if (level >= 3 && profile.maximumAmmo > 0 && profile.loadedRatio < 0.18 && profile.mobility >= 55) {
        ax = ax * 0.25 - towardX * 0.95;
        ay = ay * 0.25 - towardY * 0.65 + towardX * 0.35;
        shouldEvade = true;
        tactic = `${tactic}-ammo-cover`;
      }

      if (level >= 4) {
        const threats = assessProjectileThreats(input.unit, input.state).slice(0, level >= 6 ? 1 : 2);
        let evadeX = 0;
        let evadeY = 0;
        let weight = 0;
        for (const threat of threats) {
          if (threat.score < 0.18) continue;
          const threatWeight = threat.score * (1 + Math.max(0, 0.9 - threat.timeToClosestS));
          evadeX += threat.evadeX * threatWeight;
          evadeY += threat.evadeY * threatWeight;
          weight += threatWeight;
        }
        if (weight > 0) {
          const mobilityGain = clamp(profile.mobility / 100, 0.45, 1.25);
          const engageBlend = level >= 6 ? 0.38 : 0.55;
          const evadeGain = level >= 6 ? 1.12 : 1;
          ax = ax * engageBlend + evadeX / weight * mobilityGain * evadeGain;
          ay = ay * engageBlend + evadeY / weight * mobilityGain * evadeGain;
          shouldEvade = true;
          tactic = `${tactic}-threat-vector`;
        }
      }

      if (level >= 5) {
        const nearbyAllies = input.state.units.filter((ally) => (
          ally.alive
          && canOperate(ally)
          && ally.side === input.unit.side
          && ally.id !== input.unit.id
          && ally.type === input.unit.type
          && Math.hypot(ally.x - input.unit.x, ally.y - input.unit.y) < input.unit.radius * 3.2
        ));
        for (const ally of nearbyAllies) {
          const awayX = input.unit.x - ally.x;
          const awayY = input.unit.y - ally.y;
          const awayLength = Math.hypot(awayX, awayY) || 1;
          ax += awayX / awayLength * 0.2;
          ay += awayY / awayLength * 0.32;
        }
      }

      if (level >= 15 && level < 20) {
        const primaryThreat = assessProjectileThreats(input.unit, input.state)[0];
        const dodgeSettings = level === 16
          ? { threshold: 0.03, horizon: 3, urgencyWindow: 2.5, retain: 0 }
          : level === 17
            ? { threshold: 0.15, horizon: 1.4, urgencyWindow: 1.1, retain: 0 }
            : level >= 18
              ? { threshold: 0.05, horizon: 2.7, urgencyWindow: 2.2, retain: 0.18 }
              : { threshold: 0.08, horizon: 2.2, urgencyWindow: 1.7, retain: 0 };
        if (
          primaryThreat
          && primaryThreat.score >= dodgeSettings.threshold
          && primaryThreat.timeToClosestS <= dodgeSettings.horizon
        ) {
          const urgency = clamp(
            (dodgeSettings.horizon - primaryThreat.timeToClosestS) / dodgeSettings.urgencyWindow,
            0.55,
            1,
          );
          const mobilityGain = clamp(profile.mobility / 70, 0.65, 1.35);
          ax = ax * dodgeSettings.retain
            + primaryThreat.evadeX * 1.4 * mobilityGain * urgency;
          ay = ay * dodgeSettings.retain
            + primaryThreat.evadeY * 1.4 * mobilityGain * urgency;
          shouldEvade = true;
          tactic = `${tactic}-committed-projectile-dodge`;
        }
      }

      if (level >= 6 && profile.integrity < 0.34 && profile.mobility >= 35) {
        const ownBase = input.unit.side === "player" ? input.state.playerBase : input.state.enemyBase;
        const safeX = ownBase.x + ownBase.w * 0.5;
        const safeY = ownBase.y + ownBase.h * 0.5;
        const safeDx = safeX - input.unit.x;
        const safeDy = safeY - input.unit.y;
        const safeDistance = Math.hypot(safeDx, safeDy) || 1;
        const retreatWeight = clamp((0.34 - profile.integrity) / 0.2, 0.45, 1);
        ax = ax * (1 - retreatWeight * 0.72) + safeDx / safeDistance * 1.25 * retreatWeight;
        ay = ay * (1 - retreatWeight * 0.72) + safeDy / safeDistance * 0.95 * retreatWeight;
        shouldEvade = true;
        tactic = `${tactic}-damaged-withdrawal`;
      }

      if (level >= 8 && level < 20) {
        const gasValue = Math.max(0, input.unit.deploymentGasCost);
        const preservationThreshold = clamp(
          0.24 + Math.log10(gasValue + 1) * 0.18,
          0.34,
          0.72,
        );
        if (profile.integrity < preservationThreshold) {
          const ownBase = input.unit.side === "player" ? input.state.playerBase : input.state.enemyBase;
          const safeX = ownBase.x + ownBase.w * 0.5;
          const safeY = ownBase.y + ownBase.h * 0.5;
          const safeDx = safeX - input.unit.x;
          const safeDy = safeY - input.unit.y;
          const safeDistance = Math.hypot(safeDx, safeDy) || 1;
          const urgency = clamp(
            (preservationThreshold - profile.integrity) / Math.max(0.1, preservationThreshold),
            0.55,
            1,
          );
          ax = ax * (1 - urgency * 0.88) + safeDx / safeDistance * 1.35 * urgency;
          ay = ay * (1 - urgency * 0.88) + safeDy / safeDistance * 1.05 * urgency;
          shouldEvade = true;
          tactic = `${tactic}-value-preservation`;
        }
      }

      if (level >= 12 && level < 20) {
        const operationalAllies = input.state.units.filter((ally) => (
          ally.alive && canOperate(ally) && ally.side === input.unit.side
        ));
        const highestAlliedValue = Math.max(
          1,
          ...operationalAllies.map((ally) => Math.max(1, ally.deploymentGasCost)),
        );
        const ownValue = Math.max(1, input.unit.deploymentGasCost);
        const relativeValue = ownValue / highestAlliedValue;
        const thresholdBand = level === 13
          ? { high: 0.985, medium: 0.94, low: 0.8 }
          : level >= 14
            ? { high: 0.9, medium: 0.7, low: 0.4 }
            : { high: 0.94, medium: 0.82, low: 0.58 };
        const withdrawalThreshold = relativeValue >= 0.65
          ? thresholdBand.high
          : ownValue >= highestAlliedValue * 0.3
            ? thresholdBand.medium
            : thresholdBand.low;
        if (operationalAllies.length >= 2 && profile.integrity < withdrawalThreshold) {
          withdraw = true;
          shouldEvade = true;
          tactic = `${tactic}-committed-withdrawal`;
        }
      }

      if (level >= 20) {
        const tacticalAx = ax;
        const tacticalAy = ay;
        const assessedThreats = level >= 58 && level < 62
          ? assessProjectileThreatsAdvanced(
            input.unit,
            input.state,
            level === 58 ? 2 : level === 60 ? 4 : level === 61 ? 2.5 : 3,
          )
          : assessProjectileThreats(input.unit, input.state);
        const primaryThreat = assessedThreats[0];
        const cleanDodge = level === 21
          ? { threshold: 0.08, horizon: 2.2, urgencyWindow: 1.7, retain: 0 }
          : level >= 22
            ? { threshold: 0.05, horizon: 2.7, urgencyWindow: 2.2, retain: 0.15 }
            : { threshold: 0.03, horizon: 3, urgencyWindow: 2.5, retain: 0 };
        if (
          level !== 24
          && primaryThreat
          && primaryThreat.score >= cleanDodge.threshold
          && primaryThreat.timeToClosestS <= cleanDodge.horizon
        ) {
          const urgency = clamp(
            (cleanDodge.horizon - primaryThreat.timeToClosestS) / cleanDodge.urgencyWindow,
            0.55,
            1,
          );
          const mobilityGain = clamp(profile.mobility / 70, 0.65, 1.35);
          let evadeX = primaryThreat.evadeX;
          let evadeY = primaryThreat.evadeY;
          if (level >= 38) {
            const threshold = level === 38
              ? 0.03
              : level === 39
                ? 0.05
                : level === 40
                  ? 0.08
                  : level === 59
                    ? 0.05
                    : level === 60
                      ? 0.08
                      : level === 61
                        ? 0.01
                        : 0.02;
            const relevantThreats = assessedThreats
              .filter((threat) => threat.score >= threshold && threat.timeToClosestS <= 3)
              .slice(0, level === 40 ? 3 : 6);
            let combinedX = 0;
            let combinedY = 0;
            let totalUrgency = 0;
            for (const threat of relevantThreats) {
              const threatUrgency = threat.score * (1 + Math.max(0, 2.6 - threat.timeToClosestS));
              combinedX += threat.evadeX * threatUrgency;
              combinedY += threat.evadeY * threatUrgency;
              totalUrgency += threatUrgency;
            }
            const combinedLength = Math.hypot(combinedX, combinedY);
            if (totalUrgency > 0 && combinedLength > 1e-6) {
              evadeX = combinedX / combinedLength;
              evadeY = combinedY / combinedLength;
            }
          } else if (level >= 25) {
            const relevantThreats = assessedThreats
              .filter((threat) => (
                threat.score >= 0.03
                && threat.timeToClosestS <= 3
              ))
              .slice(0, 4);
            const options = relevantThreats.flatMap((threat) => ([
              { x: threat.evadeX, y: threat.evadeY },
              { x: -threat.evadeY, y: threat.evadeX },
              { x: threat.evadeY, y: -threat.evadeX },
            ]));
            const best = options
              .map((option) => ({
                ...option,
                score: relevantThreats.reduce((sum, threat) => {
                  const alignment = option.x * threat.evadeX + option.y * threat.evadeY;
                  const threatUrgency = threat.score * (1 + Math.max(0, 2.4 - threat.timeToClosestS));
                  return sum + alignment * threatUrgency;
                }, 0),
              }))
              .sort((a, b) => b.score - a.score)[0];
            if (best) {
              evadeX = best.x;
              evadeY = best.y;
            }
          }
          ax = ax * cleanDodge.retain + evadeX * 1.4 * mobilityGain * urgency;
          ay = ay * cleanDodge.retain + evadeY * 1.4 * mobilityGain * urgency;
          shouldEvade = true;
          tactic = `${tactic}-clean-projectile-dodge`;
        }

        if (level >= 78) {
          const predictiveHorizon = level === 78
            ? 1.2
            : level === 79
              ? 1.5
              : level === 80
                ? 1.8
                : level === 81
                  ? 2.2
                  : level === 82
                    ? 1.35
                    : level === 84
                      ? 1.65
                      : 1.5;
          const predictiveDirections = level >= 85
            ? (level === 85 ? 24 : 16)
            : level >= 82
              ? 16
              : 12;
          const alignmentWeight = level === 86
            ? 0.01
            : level === 87
              ? 0.07
              : 0.035;
          const predictiveEvasion = chooseModelPredictiveEvasion(
            input.unit,
            input.state,
            tacticalAx,
            tacticalAy,
            predictiveHorizon,
            predictiveDirections,
            alignmentWeight,
          );
          if (predictiveEvasion) {
            ax = predictiveEvasion.evadeX * 1.4;
            ay = predictiveEvasion.evadeY * 1.4;
            shouldEvade = true;
            tactic = `${tactic}-model-predictive-evasion`;
          }
        }

        const operationalAllies = input.state.units.filter((ally) => (
          ally.alive && canOperate(ally) && ally.side === input.unit.side
        ));
        const highestAlliedValue = Math.max(
          1,
          ...operationalAllies.map((ally) => Math.max(1, ally.deploymentGasCost)),
        );
        const ownValue = Math.max(1, input.unit.deploymentGasCost);
        const relativeValue = ownValue / highestAlliedValue;
        const cleanThreshold = relativeValue >= 0.65
          ? (level === 21 ? 0.985 : 0.94)
          : ownValue >= highestAlliedValue * 0.3
            ? (level === 21 ? 0.94 : 0.82)
            : (level === 21 ? 0.8 : 0.58);
        if (
          level !== 23
          && level !== 25
          && level < 26
          && operationalAllies.length >= 2
          && profile.integrity < cleanThreshold
        ) {
          withdraw = true;
          shouldEvade = true;
          tactic = `${tactic}-clean-withdrawal`;
        }

        if (level >= 26 && level < 34 && !shouldEvade && profile.weapons.length > 0) {
          const enemy = target.rankedTargets
            .map((candidate) => liveEnemy(input, candidate.targetId))
            .find((candidate): candidate is UnitInstance => candidate !== null);
          if (enemy) {
            const projectileWeapons = profile.weapons.filter((weapon) => (
              weapon.projectileClass !== "laser"
              && weapon.trackingTurnRateDegPerSec <= 0
              && weapon.projectileSpeed > 0
            ));
            const projectileRatio = projectileWeapons.length / profile.weapons.length;
            const averageProjectileSpeed = projectileWeapons.length > 0
              ? projectileWeapons.reduce((sum, weapon) => sum + weapon.projectileSpeed, 0) / projectileWeapons.length
              : Number.POSITIVE_INFINITY;
            const targetMobility = Math.hypot(enemy.vx, enemy.vy) + Math.max(0, enemy.maxSpeed) * 0.35;
            const evasionPressure = clamp(
              projectileRatio
                * targetMobility
                / Math.max(80, averageProjectileSpeed)
                * 5,
              0,
              1,
            );
            const closeRatio = level === 26
              ? 0.7
              : level === 27
                ? 0.56
                : level === 28
                  ? 0.43
                  : level === 30
                    ? 0.25
                    : level === 31
                      ? 0.37
                      : level === 32
                        ? 0.28
                        : level === 33
                          ? 0.34
                          : 0.32;
            const desired = Math.max(
              input.unit.radius * 4,
              profile.maxRange * (1 - evasionPressure * (1 - closeRatio)),
            );
            const rangeDirection = distance > desired * 1.04
              ? 1.3
              : distance < desired * 0.78
                ? -0.45
                : 0.18;
            ax = towardX * rangeDirection - towardY * 0.12;
            ay = towardY * Math.abs(rangeDirection) * 0.58 + towardX * 0.34;
            tactic = `${tactic}-projectile-flight-control`;
          }
        }

        if (level >= 34 && level < 38 && !shouldEvade && profile.maxRange > 0) {
          const standoffRatio = level === 34
            ? 0.72
            : level === 35
              ? 0.82
              : level === 36
                ? 0.9
                : 0.96;
          const desired = Math.max(input.unit.radius * 4, profile.maxRange * standoffRatio);
          const rangeDirection = distance > desired * 1.05
            ? 1.08
            : distance < desired * 0.94
              ? -1.32
              : -0.08;
          ax = towardX * rangeDirection - towardY * 0.18;
          ay = towardY * Math.abs(rangeDirection) * 0.52 + towardX * 0.38;
          tactic = `${tactic}-weapon-relative-kite`;
        }

        if (
          ((level >= 42 && level < 46) || (level >= 62 && level < 67))
          && !shouldEvade
          && profile.maxRange > 0
        ) {
          const operationalAllies = input.state.units.filter((ally) => (
            ally.alive && canOperate(ally) && ally.side === input.unit.side
          ));
          const highestAlliedValue = Math.max(
            1,
            ...operationalAllies.map((ally) => Math.max(1, ally.deploymentGasCost)),
          );
          const ownValue = Math.max(1, input.unit.deploymentGasCost);
          const relativeValue = ownValue / highestAlliedValue;
          const bands = level === 42
            ? { screen: 0.35, support: 0.62, backline: 0.85 }
            : level === 43
              ? { screen: 0.5, support: 0.66, backline: 0.76 }
              : level === 62
                ? { screen: 0.45, support: 0.62, backline: 0.72 }
                : level === 63
                  ? { screen: 0.55, support: 0.7, backline: 0.8 }
                  : level === 64
                    ? { screen: 0.4, support: 0.7, backline: 0.75 }
                    : level === 65
                      ? { screen: 0.5, support: 0.62, backline: 0.82 }
                      : { screen: 0.6, support: 0.72, backline: 0.88 };
          const desiredRatio = relativeValue <= 0.22
            ? bands.screen
            : relativeValue >= 0.65
              ? bands.backline
              : bands.support;
          const desired = Math.max(input.unit.radius * 4, profile.maxRange * desiredRatio);
          const rangeDirection = distance > desired * 1.05
            ? (relativeValue <= 0.22 ? 1.35 : 1.02)
            : distance < desired * 0.9
              ? (relativeValue >= 0.65 ? -1.28 : -0.55)
              : 0.12;
          ax = towardX * rangeDirection - towardY * 0.1;
          ay = towardY * Math.abs(rangeDirection) * 0.56 + towardX * 0.3;
          tactic = `${tactic}-value-formation`;
          if (
            (level === 45 || level === 66)
            && operationalAllies.length >= 2
            && relativeValue >= 0.65
            && profile.integrity < 0.25
          ) {
            withdraw = true;
            shouldEvade = true;
            tactic = `${tactic}-critical-value-withdrawal`;
          }
        }

        if (level >= 46 && level < 55 && !shouldEvade && profile.mobility > 0) {
          const settings = level === 46
            ? { frequency: 2.4, strength: 0.48, retain: 0.82 }
            : level === 47
              ? { frequency: 3.8, strength: 0.72, retain: 0.68 }
              : level === 48
                ? { frequency: 5.4, strength: 0.92, retain: 0.55 }
                : level === 49
                  ? { frequency: 7.2, strength: 1.08, retain: 0.42 }
                  : level === 50
                    ? { frequency: 1.6, strength: 0.35, retain: 0.9 }
                    : level === 51
                      ? { frequency: 2, strength: 0.6, retain: 0.75 }
                      : level === 52
                        ? { frequency: 2.8, strength: 0.6, retain: 0.75 }
                        : level === 53
                          ? { frequency: 3.2, strength: 0.45, retain: 0.85 }
                          : { frequency: 1.8, strength: 0.8, retain: 0.65 };
          const maneuverability = clamp(
            profile.acceleration / Math.max(40, profile.mobility),
            0.45,
            1.35,
          );
          const phaseSeed = input.unit.mass * 0.13 + input.unit.deploymentGasCost * 0.07;
          const jink = Math.sin(input.unit.aiStateTimer * settings.frequency + phaseSeed)
            * settings.strength
            * maneuverability;
          ax = ax * settings.retain - towardY * jink;
          ay = ay * settings.retain + towardX * jink;
          tactic = `${tactic}-mobility-scaled-jink`;
        }

        if (level >= 55 && level < 58 && !shouldEvade && profile.mobility > 0) {
          const operationalAllies = input.state.units.filter((ally) => (
            ally.alive && canOperate(ally) && ally.side === input.unit.side
          ));
          const protectedAlly = operationalAllies
            .slice()
            .sort((a, b) => (
              b.deploymentGasCost - a.deploymentGasCost
              || b.structure.filter((cell) => !cell.destroyed).length
                - a.structure.filter((cell) => !cell.destroyed).length
            ))[0];
          const highestAlliedValue = Math.max(1, protectedAlly?.deploymentGasCost ?? 1);
          const relativeValue = Math.max(1, input.unit.deploymentGasCost) / highestAlliedValue;
          if (protectedAlly && protectedAlly.id !== input.unit.id && relativeValue <= 0.25) {
            const nearestThreat = input.state.units
              .filter((enemy) => enemy.alive && canOperate(enemy) && enemy.side !== input.unit.side)
              .map((enemy) => ({
                enemy,
                distance: Math.hypot(enemy.x - protectedAlly.x, enemy.y - protectedAlly.y),
              }))
              .sort((a, b) => a.distance - b.distance)[0]?.enemy;
            if (nearestThreat) {
              const guardDx = nearestThreat.x - protectedAlly.x;
              const guardDy = nearestThreat.y - protectedAlly.y;
              const guardDistance = Math.hypot(guardDx, guardDy) || 1;
              const spacing = level === 55 ? 2 : level === 56 ? 3.2 : 1.25;
              const screenDistance = (protectedAlly.radius + input.unit.radius) * spacing;
              const screenX = protectedAlly.x + guardDx / guardDistance * screenDistance;
              const screenY = protectedAlly.y + guardDy / guardDistance * screenDistance;
              const screenDx = screenX - input.unit.x;
              const screenDy = screenY - input.unit.y;
              const screenLength = Math.hypot(screenDx, screenDy) || 1;
              ax = screenDx / screenLength * 1.28;
              ay = screenDy / screenLength * 1.05;
              tactic = `${tactic}-value-bodyguard`;
            }
          } else if (relativeValue >= 0.65 && profile.maxRange > 0) {
            const desired = Math.max(input.unit.radius * 4, profile.maxRange * 0.88);
            const rangeDirection = distance > desired * 1.05
              ? 1
              : distance < desired * 0.94
                ? -1.3
                : -0.08;
            ax = towardX * rangeDirection - towardY * 0.12;
            ay = towardY * Math.abs(rangeDirection) * 0.48 + towardX * 0.26;
            tactic = `${tactic}-protected-value-standoff`;
          }
        }

        if (level >= 67 && !shouldEvade && profile.mobility > 0) {
          const escapingTarget = target.rankedTargets
            .map((candidate) => liveEnemy(input, candidate.targetId))
            .find((candidate): candidate is UnitInstance => candidate?.escapeActive === true);
          if (escapingTarget) {
            const targetSpeed = Math.hypot(escapingTarget.vx, escapingTarget.vy);
            const pursuitTime = clamp(
              distance / Math.max(20, profile.mobility + targetSpeed),
              0.15,
              3,
            );
            const leadScale = level === 67 ? 0.55 : level === 68 ? 1 : 1.45;
            const interceptX = escapingTarget.x + escapingTarget.vx * pursuitTime * leadScale;
            const interceptY = escapingTarget.y + escapingTarget.vy * pursuitTime * leadScale;
            const interceptDx = interceptX - input.unit.x;
            const interceptDy = interceptY - input.unit.y;
            const interceptDistance = Math.hypot(interceptDx, interceptDy) || 1;
            ax = interceptDx / interceptDistance * 1.4;
            ay = interceptDy / interceptDistance * 1.25;
            tactic = `${tactic}-escape-intercept`;
          }
        }

        if (level >= 70 && level < 74 && !shouldEvade && profile.maxRange > 0) {
          const spatialAllies = input.state.units
            .filter((ally) => ally.alive && canOperate(ally) && ally.side === input.unit.side)
            .slice()
            .sort((a, b) => (
              a.y - b.y
              || a.x - b.x
              || a.deploymentGasCost - b.deploymentGasCost
            ));
          const ownIndex = spatialAllies.findIndex((ally) => ally === input.unit);
          const centeredLane = ownIndex >= 0
            ? ownIndex - (spatialAllies.length - 1) * 0.5
            : 0;
          const laneNorm = spatialAllies.length > 1
            ? centeredLane / Math.max(1, (spatialAllies.length - 1) * 0.5)
            : 0;
          const lateralRatio = level === 70
            ? 0.18
            : level === 71
              ? 0.3
              : level === 72
                ? 0.45
                : 0.6;
          const standoff = Math.max(input.unit.radius * 4, profile.maxRange * 0.66);
          const laneOffset = profile.maxRange * lateralRatio * laneNorm;
          const desiredX = target.attackPoint.x - towardX * standoff - towardY * laneOffset;
          const desiredY = target.attackPoint.y - towardY * standoff + towardX * laneOffset;
          const formationDx = desiredX - input.unit.x;
          const formationDy = desiredY - input.unit.y;
          const formationDistance = Math.hypot(formationDx, formationDy) || 1;
          if (formationDistance > input.unit.radius * 1.5) {
            ax = formationDx / formationDistance * 1.28;
            ay = formationDy / formationDistance * 1.1;
          } else {
            ax = -towardY * laneNorm * 0.22;
            ay = towardX * laneNorm * 0.3;
          }
          tactic = `${tactic}-property-crossfire-lane`;
        }

        if (level >= 74 && level < 78) {
          const operationalAllies = input.state.units.filter((ally) => (
            ally.alive && canOperate(ally) && ally.side === input.unit.side
          ));
          const highestAlliedValue = Math.max(
            1,
            ...operationalAllies.map((ally) => Math.max(1, ally.deploymentGasCost)),
          );
          const relativeValue = Math.max(1, input.unit.deploymentGasCost) / highestAlliedValue;
          const primaryThreat = assessedThreats[0];
          const threatProjectile = primaryThreat
            ? input.state.projectiles[primaryThreat.projectileIndex]
            : null;
          const incomingDamageRatio = threatProjectile
            ? Math.max(threatProjectile.damage, threatProjectile.currentDamage)
              / Math.max(1, profile.durability)
            : 0;
          const integrityThreshold = level === 74
            ? 0.38
            : level === 75
              ? 0.5
              : level === 76
                ? 0.62
                : 0.74;
          if (
            operationalAllies.length >= 2
            && relativeValue >= 0.6
            && (
              profile.integrity < integrityThreshold
              || (
                primaryThreat
                && primaryThreat.timeToClosestS < 0.8
                && incomingDamageRatio > Math.max(0.08, profile.integrity * 0.22)
              )
            )
          ) {
            withdraw = true;
            shouldEvade = true;
            tactic = `${tactic}-forecast-value-withdrawal`;
          }
        }
      }

      return {
        ax: clamp(ax, -1.4, 1.4),
        ay: clamp(ay, -1.4, 1.4),
        shouldEvade,
        ...(withdraw ? { withdraw: true } : {}),
        state: shouldEvade ? "evade" : "engage",
        debugTag: `movement.level-${Math.min(25, level)}.${tactic}`,
      };
    },
  };
}

function estimateHistoryVelocity(enemy: UnitInstance): { vx: number; vy: number; ax: number; ay: number } {
  const history = enemy.targetHistory;
  if (history.length < 2) return { vx: enemy.vx, vy: enemy.vy, ax: 0, ay: 0 };
  const samples = history.slice(-Math.min(6, history.length));
  let weightedVx = 0;
  let weightedVy = 0;
  let weightSum = 0;
  let priorVx = enemy.vx;
  let priorVy = enemy.vy;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const weight = index;
    priorVx = (current.x - previous.x) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
    priorVy = (current.y - previous.y) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
    weightedVx += priorVx * weight;
    weightedVy += priorVy * weight;
    weightSum += weight;
  }
  const vx = weightSum > 0 ? weightedVx / weightSum : enemy.vx;
  const vy = weightSum > 0 ? weightedVy / weightSum : enemy.vy;
  return {
    vx,
    vy,
    ax: (enemy.vx - priorVx) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S),
    ay: (enemy.vy - priorVy) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S),
  };
}

function estimateCommandedAverageVelocity(
  enemy: UnitInstance,
  horizonS: number,
): { vx: number; vy: number } {
  const horizon = clamp(horizonS, 0.05, 2.5);
  const commandLength = Math.hypot(
    enemy.aiLastThreatDirX,
    enemy.aiLastThreatDirY,
  );
  if (commandLength <= 1e-6 || enemy.maxSpeed <= 0) {
    return { vx: enemy.vx, vy: enemy.vy };
  }
  const directionX = enemy.aiLastThreatDirX / commandLength;
  const directionY = enemy.aiLastThreatDirY / commandLength;
  let x = 0;
  let y = 0;
  let vx = enemy.vx;
  let vy = enemy.vy;
  let elapsed = 0;
  const stepS = 0.05;
  while (elapsed < horizon) {
    const dt = Math.min(stepS, horizon - elapsed);
    if (enemy.type === "air") {
      const targetVx = directionX * enemy.maxSpeed;
      const targetVy = directionY * enemy.maxSpeed;
      const deltaVx = targetVx - vx;
      const deltaVy = targetVy - vy;
      const deltaSpeed = Math.hypot(deltaVx, deltaVy);
      const accelerationStep = Math.max(0, enemy.accel) * dt;
      if (deltaSpeed <= accelerationStep) {
        vx = targetVx;
        vy = targetVy;
      } else if (deltaSpeed > 1e-6 && accelerationStep > 0) {
        vx += deltaVx / deltaSpeed * accelerationStep;
        vy += deltaVy / deltaSpeed * accelerationStep;
      }
    } else {
      vx += directionX * Math.max(0, enemy.accel) * dt;
      vy += directionY * Math.max(0, enemy.accel) * dt;
      const frameScale = dt * 60;
      vx *= Math.pow(Math.max(0, enemy.turnDrag), frameScale);
      vy *= Math.pow(0.83, frameScale);
    }
    vx = clamp(vx, -enemy.maxSpeed, enemy.maxSpeed);
    const verticalCap = enemy.maxSpeed * (enemy.type === "air" ? 1 : 0.75);
    vy = clamp(vy, -verticalCap, verticalCap);
    x += vx * dt;
    y += vy * dt;
    elapsed += dt;
  }
  return {
    vx: x / horizon,
    vy: y / horizon,
  };
}

function canWeaponInterceptTarget(
  input: BattleAiInput,
  candidate: RankedTarget,
  weapon: WeaponFireAiInput,
): boolean {
  const rx = candidate.x - weapon.firepointX;
  const ry = candidate.y - weapon.firepointY;
  const distance = Math.hypot(rx, ry);
  if (distance > weapon.effectiveRange * 1.04) return false;
  if (!input.canShootAtAngle(weapon.componentId, rx, ry, weapon.angleLimit)) return false;
  if (weapon.projectileClass === "laser") return true;
  const projectileSpeed = Math.max(1, weapon.projectileSpeed);
  const vx = candidate.vx - input.unit.vx;
  const vy = candidate.vy - input.unit.vy;
  const a = vx * vx + vy * vy - projectileSpeed * projectileSpeed;
  const b = 2 * (rx * vx + ry * vy);
  const c = rx * rx + ry * ry;
  let interceptTime = Number.POSITIVE_INFINITY;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-6) interceptTime = distance / projectileSpeed;
    else if (-c / b > 0) interceptTime = -c / b;
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const first = (-b - root) / (2 * a);
      const second = (-b + root) / (2 * a);
      interceptTime = Math.min(
        first > 0 ? first : Number.POSITIVE_INFINITY,
        second > 0 ? second : Number.POSITIVE_INFINITY,
      );
    }
  }
  return Number.isFinite(interceptTime)
    && interceptTime * projectileSpeed <= weapon.effectiveRange * 1.04;
}

export function isImmediateLoadedKillOpportunity(
  distance: number,
  immediateRange: number,
  shotsToDisable: number,
  loadedAmmo: number,
): boolean {
  return distance <= immediateRange
    && shotsToDisable <= Math.max(1, loadedAmmo);
}

export function shouldPreferImmediateKillTarget(
  primaryReachable: boolean,
  primaryDistance: number,
  immediateDistance: number,
): boolean {
  return !primaryReachable || immediateDistance * 1.35 < primaryDistance;
}

function selectReachableLocalTarget(
  input: BattleAiInput,
  rankedTargets: ReadonlyArray<RankedTarget>,
  weapon: WeaponFireAiInput,
  assignedDamageByTarget: ReadonlyMap<string, number>,
  immediateKillOnly = false,
): RankedTarget | null {
  return rankedTargets
    .filter((candidate) => canWeaponInterceptTarget(input, candidate, weapon))
    .map((candidate) => {
      const enemy = liveEnemy(input, candidate.targetId);
      if (!enemy) return { candidate, score: Number.POSITIVE_INFINITY };
      const aliveCells = enemy.structure.filter((cell) => !cell.destroyed);
      const averageArmor = aliveCells.length > 0
        ? aliveCells.reduce((sum, cell) => sum + cell.armor, 0) / aliveCells.length
        : 0;
      const decisiveCell = supportedCell(enemy, enemy.controlAttachmentId)
        ?? aliveCells.slice().sort((a, b) => remainingCellRatio(a) - remainingCellRatio(b))[0]
        ?? null;
      const decisiveHp = decisiveCell
        ? Math.max(1, decisiveCell.breakThreshold - decisiveCell.strain)
        : 1;
      const effectiveDamage = Math.max(1, weapon.damage - (decisiveCell?.armor ?? averageArmor));
      const distance = Math.hypot(candidate.x - weapon.firepointX, candidate.y - weapon.firepointY);
      const armorMismatch = Math.max(0, averageArmor - weapon.penetration)
        * (weapon.projectileClass === "bullet" || weapon.projectileClass === "laser" ? 4 : 1);
      const assignedDamage = assignedDamageByTarget.get(enemy.id) ?? 0;
      const assignmentRatio = assignedDamage / decisiveHp;
      const remainingDecisiveHp = Math.max(0, decisiveHp - assignedDamage);
      const shotsToDisable = Math.ceil(remainingDecisiveHp / effectiveDamage);
      const immediateRange = Math.max(
        input.unit.radius + enemy.radius + 120,
        Math.min(650, weapon.effectiveRange * 0.5),
      );
      const loadedKillOpportunity = isImmediateLoadedKillOpportunity(
        distance,
        immediateRange,
        shotsToDisable,
        weapon.loadedAmmo,
      );
      if (immediateKillOnly && !loadedKillOpportunity) {
        return { candidate, score: Number.POSITIVE_INFINITY };
      }
      const overkillPenalty = assignmentRatio >= 1
        ? 1_600 + (assignmentRatio - 1) * 600
        : assignmentRatio * 90;
      const localDefenseReward = localThreatPressure(input, enemy) * 8_000;
      return {
        candidate,
        score: distance * 0.6
          + shotsToDisable * 28
          + armorMismatch
          + overkillPenalty
          - localDefenseReward,
      };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.candidate.targetId.localeCompare(b.candidate.targetId))[0]?.candidate
    ?? null;
}

function createCapabilityAwareShootAi(level: AiLevel): ShootAiModule {
  const fallback = createSkillTierShootAi("high");
  const velocityByTarget = new Map<string, { vx: number; vy: number }>();
  const observedVelocityByTarget = new Map<string, { vx: number; vy: number }>();
  return {
    decideShoot: (input, target, movement) => {
      const primary = target.rankedTargets[0];
      const profile = classifyCraft(input);
      const enemyIsAround = hasEnemyAround(input, target.rankedTargets, profile);
      if (!primary) {
        const firePlans: FirePlan[] = [];
        for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
          if (!input.unit.weaponAutoFire[slot] || (input.unit.weaponFireTimers[slot] ?? 0) > 0) continue;
          const weapon = input.getWeaponFireInput(slot);
          if (!weapon) continue;
          const plan = solvePlan(input, weapon, slot, null, input.baseTarget);
          if (plan) firePlans.push(plan);
        }
        return {
          firePlan: firePlans[0] ?? null,
          firePlans,
          fireBlockedReason: firePlans.length > 0 ? null : "no-ready-weapon",
          debugTag: "shoot.level-2.base",
        };
      }
      if (!liveEnemy(input, primary.targetId)) return fallback.decideShoot(input, target, movement);
      let maxReadyDamage = 0;
      for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
        const weapon = input.getWeaponFireInput(slot);
        if (weapon) maxReadyDamage = Math.max(maxReadyDamage, weapon.damage);
      }
      const firePlans: FirePlan[] = [];
      const assignedDamageByTarget = new Map<string, number>();
      const frameMotion = new Map<string, { ax: number; ay: number; magnitude: number }>();
      for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
        if (!input.unit.weaponAutoFire[slot] || (input.unit.weaponFireTimers[slot] ?? 0) > 0) continue;
        const weapon = input.getWeaponFireInput(slot);
        if (!weapon) continue;
        let selectedTarget = primary;
        if (level === 93) {
          const alternativeTargets = target.rankedTargets.filter((candidate) => candidate.targetId !== primary.targetId);
          const primaryReachable = canWeaponInterceptTarget(input, primary, weapon);
          const immediateKill = selectReachableLocalTarget(
            input,
            alternativeTargets,
            weapon,
            assignedDamageByTarget,
            true,
          );
          const primaryDistance = Math.hypot(primary.x - weapon.firepointX, primary.y - weapon.firepointY);
          const immediateDistance = immediateKill
            ? Math.hypot(immediateKill.x - weapon.firepointX, immediateKill.y - weapon.firepointY)
            : Number.POSITIVE_INFINITY;
          if (immediateKill && shouldPreferImmediateKillTarget(primaryReachable, primaryDistance, immediateDistance)) {
            // Movement retains the strategic target, but this weapon takes a
            // clearly closer magazine-feasible disable opportunity.
            selectedTarget = immediateKill;
          } else if (!primaryReachable) {
            selectedTarget = selectReachableLocalTarget(
              input,
              alternativeTargets,
              weapon,
              assignedDamageByTarget,
            ) ?? primary;
          }
        } else if (level >= 21 && level < 25) {
          selectedTarget = target.rankedTargets
            .filter((candidate) => (
              Math.hypot(candidate.x - weapon.firepointX, candidate.y - weapon.firepointY)
                <= weapon.effectiveRange * 1.04
            ))
            .map((candidate) => {
              const candidateEnemy = liveEnemy(input, candidate.targetId);
              if (!candidateEnemy) return { candidate, score: Number.POSITIVE_INFINITY };
              const aliveCells = candidateEnemy.structure.filter((cell) => !cell.destroyed);
              const averageArmor = aliveCells.length > 0
                ? aliveCells.reduce((sum, cell) => sum + cell.armor, 0) / aliveCells.length
                : 0;
              const remainingHp = aliveCells.reduce(
                (sum, cell) => sum + Math.max(0, cell.breakThreshold - cell.strain),
                0,
              );
              const effectiveDamage = Math.max(1, weapon.damage - averageArmor);
              const shotsToBreak = remainingHp / effectiveDamage;
              const distance = Math.hypot(
                candidate.x - weapon.firepointX,
                candidate.y - weapon.firepointY,
              );
              const mobility = Math.hypot(candidate.vx, candidate.vy) + candidateEnemy.maxSpeed * 0.3;
              const trackingQuality = weapon.trackingTurnRateDegPerSec > 0
                || weapon.projectileClass === "laser"
                || weapon.maximumAmmo >= 4;
              const airMismatch = candidate.type === "air" && !trackingQuality
                ? mobility * 1.8
                : 0;
              const armorMismatch = Math.max(0, averageArmor - weapon.penetration)
                * (weapon.projectileClass === "bullet" || weapon.projectileClass === "laser" ? 4 : 1);
              const economicReward = Math.max(0, candidateEnemy.deploymentGasCost)
                / Math.max(1, shotsToBreak);
              return {
                candidate,
                score: distance * 0.28
                  + shotsToBreak * 20
                  + airMismatch
                  + armorMismatch
                  - economicReward * 4.2,
              };
            })
            .sort((a, b) => a.score - b.score || a.candidate.targetId.localeCompare(b.candidate.targetId))[0]?.candidate
            ?? primary;
        } else if (level >= 7 && level < 25) {
          selectedTarget = target.rankedTargets.find((candidate) => (
            Math.hypot(candidate.x - weapon.firepointX, candidate.y - weapon.firepointY) <= weapon.effectiveRange * 1.04
          )) ?? primary;
        } else if (maxReadyDamage > 0 && weapon.damage < maxReadyDamage * 0.5) {
          const compatible = target.rankedTargets
            .map((candidate) => ({ candidate, distance: Math.hypot(candidate.x - weapon.firepointX, candidate.y - weapon.firepointY) }))
            .filter((entry) => entry.distance <= weapon.effectiveRange * 1.04)
            .sort((a, b) => {
              const counterScore = (candidate: RankedTarget): number => {
                const enemy = liveEnemy(input, candidate.targetId);
                if (!enemy) return 0;
                if ((weapon.projectileClass === "bullet" || weapon.projectileClass === "laser") && candidate.type === "air") return -200;
                const maxArmor = enemy.structure.filter((cell) => !cell.destroyed).reduce((value, cell) => Math.max(value, cell.armor), 0);
                if (weapon.penetration > 0 && weapon.penetration >= maxArmor && candidate.type === "ground") return -160;
                return 0;
              };
              return counterScore(a.candidate) + a.distance - (counterScore(b.candidate) + b.distance)
                || a.candidate.targetId.localeCompare(b.candidate.targetId);
            });
          selectedTarget = compatible[0]?.candidate ?? primary;
        }
        const enemy = liveEnemy(input, selectedTarget.targetId);
        if (!enemy) continue;
        let observedMotion = frameMotion.get(enemy.id);
        if (!observedMotion) {
          const priorObservedVelocity = observedVelocityByTarget.get(enemy.id);
          const rawAx = priorObservedVelocity
            ? (selectedTarget.vx - priorObservedVelocity.vx) / Math.max(1e-3, input.dt)
            : 0;
          const rawAy = priorObservedVelocity
            ? (selectedTarget.vy - priorObservedVelocity.vy) / Math.max(1e-3, input.dt)
            : 0;
          const rawMagnitude = Math.hypot(rawAx, rawAy);
          const physicalLimit = Math.max(1, enemy.accel) * 1.4;
          const accelerationScale = rawMagnitude > physicalLimit
            ? physicalLimit / rawMagnitude
            : 1;
          const ax = rawAx * accelerationScale;
          const ay = rawAy * accelerationScale;
          observedMotion = { ax, ay, magnitude: Math.hypot(ax, ay) };
          frameMotion.set(enemy.id, observedMotion);
          observedVelocityByTarget.set(enemy.id, { vx: selectedTarget.vx, vy: selectedTarget.vy });
        }
        const observedAcceleration = observedMotion.magnitude;
        const aimCell = chooseWeaponAimCell(
          enemy,
          weapon.firepointX,
          weapon,
          level >= 59 && level <= 67 ? 19 : level >= 25 ? 4 : level,
        );
        let point = aimCell ? cellWorldPoint(enemy, aimCell) : { x: selectedTarget.x, y: selectedTarget.y };
        if (
          level >= 83
          && level <= 92
          && weapon.maximumAmmo >= 4
          && weapon.trackingTurnRateDegPerSec <= 0
          && weapon.projectileClass !== "laser"
        ) {
          const lineDx = point.x - weapon.firepointX;
          const lineDy = point.y - weapon.firepointY;
          const lineLength = Math.hypot(lineDx, lineDy) || 1;
          const offsetRatio = level === 83
            ? 0.2
            : level === 84
              ? 0.35
              : level === 85
                ? 0.5
                : level === 86
                  ? 0.7
                  : level === 87
                    ? 0.9
                    : level === 88
                      ? 1.1
                      : level === 89
                        ? 1.3
                        : level === 90
                          ? 1.5
                          : level === 91
                            ? 1.8
                            : 2.2;
          const volleyIndex = Math.max(0, weapon.maximumAmmo - weapon.loadedAmmo);
          const side = volleyIndex % 2 === 0 ? 1 : -1;
          const offset = enemy.radius * offsetRatio * side;
          point = {
            x: point.x - lineDy / lineLength * offset,
            y: point.y + lineDx / lineLength * offset,
          };
        }
        let predictedVx = selectedTarget.vx;
        let predictedVy = selectedTarget.vy;
        let allowHistoryCorrection = true;
        const historyMotion = estimateHistoryVelocity(enemy);
        if (level >= 5 && level < 8) {
          const historyGain = level === 5
            ? 0.68
            : level === 6
              ? 0.84
              : clamp(
                (1_200 - weapon.projectileSpeed) / 1_000
                  * (weapon.trackingTurnRateDegPerSec > 0 ? 0.55 : 1),
                0.08,
                0.72,
              );
          predictedVx = selectedTarget.vx * (1 - historyGain) + historyMotion.vx * historyGain;
          predictedVy = selectedTarget.vy * (1 - historyGain) + historyMotion.vy * historyGain;
        }
        if (level >= 5 && level < 8) {
          const previousEstimate = velocityByTarget.get(enemy.id) ?? { vx: predictedVx, vy: predictedVy };
          const alpha = level >= 6 ? 0.48 : 0.32;
          predictedVx = previousEstimate.vx * (1 - alpha) + predictedVx * alpha;
          predictedVy = previousEstimate.vy * (1 - alpha) + predictedVy * alpha;
          velocityByTarget.set(enemy.id, { vx: predictedVx, vy: predictedVy });
        }
        if (level >= 9 && level < 19) {
          const minimumLead = level === 9
            ? 0.15
            : level === 10
              ? 0.3
              : level === 11
                ? 0.5
                : level === 13 || level === 14
                  ? 0.25
                  : level === 15 || level === 16
                    ? 0.35
                    : level === 17
                      ? 0.2
                      : level === 18
                        ? 0.4
                        : 0;
          const accelerationScale = level === 9
            ? 420
            : level === 10
              ? 560
              : level === 11
                ? 720
                : level === 13 || level === 15
                  ? 480
                  : level === 14 || level === 16
                    ? 640
                    : level === 17 || level === 18
                      ? 560
                      : 1;
          const leadGain = level === 12
            ? 0
            : clamp(1 - observedAcceleration / accelerationScale, minimumLead, 1);
          predictedVx = selectedTarget.vx * leadGain;
          predictedVy = selectedTarget.vy * leadGain;
        }
        if (level >= 19 && level < 25) {
          const leadGain = clamp(1 - observedAcceleration / 640, 0.35, 1);
          predictedVx = selectedTarget.vx * leadGain;
          predictedVy = selectedTarget.vy * leadGain;
        }
        if (level >= 53 && level <= 61) {
          const accelerationScale = level === 53
            ? 480
            : level === 54 || level === 56 || level === 59
              ? 640
              : level === 55 || level === 57 || level === 60
                ? 800
                : 1_000;
          const minimumLead = level <= 55 || level === 59
            ? 0
            : level <= 57 || level === 60
              ? 0.2
              : 0.3;
          const leadGain = clamp(
            1 - observedAcceleration / accelerationScale,
            minimumLead,
            1,
          );
          predictedVx = selectedTarget.vx * leadGain;
          predictedVy = selectedTarget.vy * leadGain;
          allowHistoryCorrection = observedAcceleration <= accelerationScale * 0.25;
        }
        if (level >= 78 && level <= 82) {
          const leadGain = clamp(1 - observedAcceleration / 800, 0.2, 1);
          predictedVx = selectedTarget.vx * leadGain;
          predictedVy = selectedTarget.vy * leadGain;
          allowHistoryCorrection = observedAcceleration <= 200;
          if (weapon.projectileClass === "laser") {
            predictedVx = 0;
            predictedVy = 0;
            allowHistoryCorrection = false;
          } else if (weapon.trackingTurnRateDegPerSec > 0) {
            const trackingLeadRatio = level === 78
              ? 0
              : level === 79
                ? 0.2
                : level === 80
                  ? 0.4
                  : level === 81
                    ? 0.6
                    : 0.8;
            predictedVx *= trackingLeadRatio;
            predictedVy *= trackingLeadRatio;
            allowHistoryCorrection = false;
          }
        }
        if (level >= 83 && level <= 92) {
          const leadGain = clamp(1 - observedAcceleration / 800, 0.2, 1);
          predictedVx = selectedTarget.vx * leadGain;
          predictedVy = selectedTarget.vy * leadGain;
          allowHistoryCorrection = observedAcceleration <= 200;
        }
        if (level >= 63 && level <= 72) {
          const approximateLeadS = Math.min(
            2.5,
            Math.hypot(point.x - weapon.firepointX, point.y - weapon.firepointY)
              / Math.max(1, weapon.projectileSpeed),
          );
          const commandedVelocity = estimateCommandedAverageVelocity(
            enemy,
            approximateLeadS,
          );
          const normalizedIntentLevel = level >= 68 ? level - 5 : level;
          const intentBlend = normalizedIntentLevel === 63
            ? 0.25
            : normalizedIntentLevel === 64
              ? 0.5
              : normalizedIntentLevel === 65
                ? 0.75
                : normalizedIntentLevel === 66
                  ? 0.9
                  : 1;
          predictedVx = predictedVx * (1 - intentBlend) + commandedVelocity.vx * intentBlend;
          predictedVy = predictedVy * (1 - intentBlend) + commandedVelocity.vy * intentBlend;
          allowHistoryCorrection = false;
        }
        if (level >= 73 && level <= 77 && enemy.targetHistory.length >= 4) {
          const samples = enemy.targetHistory;
          const p0 = samples[samples.length - 1]!;
          const p1 = samples[samples.length - 2]!;
          const p2 = samples[samples.length - 3]!;
          const p3 = samples[samples.length - 4]!;
          const sampleDt = Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
          const vx0 = (p0.x - p1.x) / sampleDt;
          const vy0 = (p0.y - p1.y) / sampleDt;
          const vx1 = (p1.x - p2.x) / sampleDt;
          const vy1 = (p1.y - p2.y) / sampleDt;
          const vx2 = (p2.x - p3.x) / sampleDt;
          const vy2 = (p2.y - p3.y) / sampleDt;
          const ax0 = (vx0 - vx1) / sampleDt;
          const ay0 = (vy0 - vy1) / sampleDt;
          const ax1 = (vx1 - vx2) / sampleDt;
          const ay1 = (vy1 - vy2) / sampleDt;
          const jerkX = (ax0 - ax1) / sampleDt;
          const jerkY = (ay0 - ay1) / sampleDt;
          const approximateLeadS = Math.min(
            1.4,
            Math.hypot(point.x - weapon.firepointX, point.y - weapon.firepointY)
              / Math.max(1, weapon.projectileSpeed),
          );
          const historyGain = (level - 72) * 0.2;
          const accelerationContributionX = clamp(
            ax0 * approximateLeadS * 0.5,
            -enemy.accel * 1.5,
            enemy.accel * 1.5,
          );
          const accelerationContributionY = clamp(
            ay0 * approximateLeadS * 0.5,
            -enemy.accel * 1.5,
            enemy.accel * 1.5,
          );
          const jerkContributionX = clamp(
            jerkX * approximateLeadS * approximateLeadS / 6,
            -enemy.accel * 1.5,
            enemy.accel * 1.5,
          );
          const jerkContributionY = clamp(
            jerkY * approximateLeadS * approximateLeadS / 6,
            -enemy.accel * 1.5,
            enemy.accel * 1.5,
          );
          predictedVx = selectedTarget.vx
            + (accelerationContributionX + jerkContributionX) * historyGain;
          predictedVy = selectedTarget.vy
            + (accelerationContributionY + jerkContributionY) * historyGain;
          allowHistoryCorrection = false;
        }
        if (level >= 31 && level <= 34) {
          const predictedDodge = assessProjectileThreats(enemy, input.state)[0];
          if (predictedDodge && predictedDodge.score >= 0.02) {
            const approximateLeadS = Math.min(
              2,
              Math.hypot(point.x - weapon.firepointX, point.y - weapon.firepointY)
                / Math.max(1, weapon.projectileSpeed),
            );
            const dodgeGain = level === 31
              ? 0.25
              : level === 32
                ? 0.5
                : level === 33
                  ? 0.75
                  : 1;
            predictedVx += predictedDodge.evadeX
              * Math.max(0, enemy.accel)
              * approximateLeadS
              * dodgeGain;
            predictedVy += predictedDodge.evadeY
              * Math.max(0, enemy.accel)
              * approximateLeadS
              * dodgeGain;
          }
        }
        if (level >= 37 && level <= 41) {
          const approximateLeadS = Math.min(
            2.5,
            Math.hypot(point.x - weapon.firepointX, point.y - weapon.firepointY)
              / Math.max(1, weapon.projectileSpeed),
          );
          const accelerationGain = level === 37
            ? 0.25
            : level === 38
              ? 0.5
              : level === 39
                ? 0.75
                : level === 40
                  ? 1
                  : 1.25;
          predictedVx += observedMotion.ax * approximateLeadS * 0.5 * accelerationGain;
          predictedVy += observedMotion.ay * approximateLeadS * 0.5 * accelerationGain;
        }
        const initialTarget = { ...selectedTarget, x: point.x, y: point.y, vx: predictedVx, vy: predictedVy };
        const initialPlan = solvePlan(input, weapon, slot, initialTarget, point);
        let plan = initialPlan;
        const history = enemy.targetHistory;
        if (
          (level < 8 || (level >= 25 && (level < 37 || level > 41)))
          && allowHistoryCorrection
          && initialPlan
          && history.length >= 2
          && initialPlan.leadTimeS > 0
        ) {
          const previous = history[history.length - 2]!;
          const newest = history[history.length - 1]!;
          const sampledVx = (newest.x - previous.x) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
          const sampledVy = (newest.y - previous.y) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
          let accelX = (predictedVx - sampledVx) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
          let accelY = (predictedVy - sampledVy) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
          if (history.length >= 3) {
            const older = history[history.length - 3]!;
            const priorVx = (previous.x - older.x) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
            const priorVy = (previous.y - older.y) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
            accelX = accelX * 0.9 + (sampledVx - priorVx) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S) * 0.1;
            accelY = accelY * 0.9 + (sampledVy - priorVy) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S) * 0.1;
          }
          if (level >= 4) {
            accelX = accelX * 0.6 + historyMotion.ax * 0.4;
            accelY = accelY * 0.6 + historyMotion.ay * 0.4;
          }
          const horizonGain = level === 25
            ? 0.1
            : level === 26
              ? 0.14
              : level === 27
                ? 0.18
                : level === 28
                  ? 0.22
                  : level === 29
                    ? 0.26
                    : level === 35
                      ? 0.28
                      : level === 36
                        ? 0.29
                        : level >= 30
                      ? 0.3
                      : level <= 4
                        ? 0.18
                        : level === 5
                          ? 0.27
                          : 0.34;
          const horizon = Math.min(0.8, initialPlan.leadTimeS) * horizonGain;
          plan = solvePlan(input, weapon, slot, {
            ...initialTarget,
            vx: predictedVx + clamp(accelX * horizon, -180, 180),
            vy: predictedVy + clamp(accelY * horizon, -180, 180),
          }, point) ?? initialPlan;
        }
        const basePlan = level >= 2 && !enemyIsAround
          ? solvePlan(input, weapon, slot, null, input.baseTarget)
          : null;
        if (!plan && basePlan) {
          plan = basePlan;
        }
        if (plan) {
          firePlans.push(plan);
          if (plan.intendedTargetId) {
            assignedDamageByTarget.set(
              plan.intendedTargetId,
              (assignedDamageByTarget.get(plan.intendedTargetId) ?? 0) + weapon.damage,
            );
          }
        }
      }
      return {
        firePlan: firePlans[0] ?? null,
        firePlans,
        fireBlockedReason: firePlans.length > 0 ? null : "no-ready-weapon",
        debugTag: level <= 1
          ? "shoot.level-1.former-level-2-capability-aware"
          : `shoot.level-${Math.min(8, level)}.property-capability-aware`,
      };
    },
  };
}

// Retained as internal compatibility/reference implementations for saved AI
// research artifacts; certified level resolution no longer calls them.
void createCadencedShootAi;
void createCapabilityAwareShootAi;

export function createLevelShootAi(level: AiLevel): ShootAiModule {
  return createUnifiedLevelShootAi(level);
}
