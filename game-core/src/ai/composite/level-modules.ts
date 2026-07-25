import { AI_TARGET_HISTORY_SAMPLE_INTERVAL_S, GROUND_FIRE_Y_TOLERANCE } from "../../config/balance/range.ts";
import { structureIntegrity } from "../../simulation/units/structure-grid.ts";
import { getStructureCellSize } from "../../config/balance/battlefield.ts";
import { MAX_CERTIFIED_AI_LEVEL } from "../../config/ai/levels.ts";
import { canOperate } from "../../simulation/units/control-unit-rules.ts";
import { solveBallisticAim } from "../shooting/ballistic-aim.ts";
import { assessProjectileThreats } from "../movement/threat-movement.ts";
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
  TargetAiModule,
  WeaponFireAiInput,
} from "./composite-ai.ts";
import type { StructureCell, UnitInstance } from "../../types.ts";

export type AiLevel = number;
export { MAX_CERTIFIED_AI_LEVEL };

function canHitByAxis(unit: UnitInstance, target: RankedTarget): boolean {
  return unit.type === "air" || target.type === "air" || Math.abs(target.y - unit.y) <= GROUND_FIRE_Y_TOLERANCE;
}

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
function chooseWeaponAimCell(enemy: UnitInstance, shooterX: number, weapon: WeaponFireAiInput): StructureCell | null {
  const exposed = exposedCells(enemy, shooterX);
  if (exposed.length === 0) return null;
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
  if (target && !canHitByAxis(input.unit, target)) return null;
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

export function createLevelTargetAi(level: AiLevel): TargetAiModule {
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
            if (level >= 6) {
              const distance = Math.hypot(candidate.x - input.unit.x, candidate.y - input.unit.y);
              const reachableWeapons = profile.weapons.filter((weapon) => distance <= weapon.effectiveRange * 1.04).length;
              score -= reachableWeapons * 22;
            }
          }
          return { ...candidate, score };
        })
        .sort((a, b) => a.score - b.score || a.targetId.localeCompare(b.targetId));
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

      return {
        ax: clamp(ax, -1.4, 1.4),
        ay: clamp(ay, -1.4, 1.4),
        shouldEvade,
        state: shouldEvade ? "evade" : "engage",
        debugTag: `movement.level-${Math.min(6, level)}.${tactic}`,
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

function createCapabilityAwareShootAi(level: AiLevel): ShootAiModule {
  const fallback = createSkillTierShootAi("high");
  const velocityByTarget = new Map<string, { vx: number; vy: number }>();
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
      for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
        if (!input.unit.weaponAutoFire[slot] || (input.unit.weaponFireTimers[slot] ?? 0) > 0) continue;
        const weapon = input.getWeaponFireInput(slot);
        if (!weapon) continue;
        let selectedTarget = primary;
        if (level >= 7) {
          selectedTarget = target.rankedTargets.find((candidate) => (
            canHitByAxis(input.unit, candidate)
            && Math.hypot(candidate.x - weapon.firepointX, candidate.y - weapon.firepointY) <= weapon.effectiveRange * 1.04
          )) ?? primary;
        } else if (maxReadyDamage > 0 && weapon.damage < maxReadyDamage * 0.5) {
          const compatible = target.rankedTargets
            .filter((candidate) => canHitByAxis(input.unit, candidate))
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
        const aimCell = chooseWeaponAimCell(enemy, weapon.firepointX, weapon);
        const point = aimCell ? cellWorldPoint(enemy, aimCell) : { x: selectedTarget.x, y: selectedTarget.y };
        let predictedVx = selectedTarget.vx;
        let predictedVy = selectedTarget.vy;
        const historyMotion = estimateHistoryVelocity(enemy);
        if (level >= 5) {
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
        if (level >= 5) {
          const previousEstimate = velocityByTarget.get(enemy.id) ?? { vx: predictedVx, vy: predictedVy };
          const alpha = level >= 6 ? 0.48 : 0.32;
          predictedVx = previousEstimate.vx * (1 - alpha) + predictedVx * alpha;
          predictedVy = previousEstimate.vy * (1 - alpha) + predictedVy * alpha;
          velocityByTarget.set(enemy.id, { vx: predictedVx, vy: predictedVy });
        }
        const initialTarget = { ...selectedTarget, x: point.x, y: point.y, vx: predictedVx, vy: predictedVy };
        const initialPlan = solvePlan(input, weapon, slot, initialTarget, point);
        let plan = initialPlan;
        const history = enemy.targetHistory;
        if (initialPlan && history.length >= 2 && initialPlan.leadTimeS > 0) {
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
          const horizonGain = level <= 4 ? 0.18 : level === 5 ? 0.27 : 0.34;
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
        if (plan) firePlans.push(plan);
      }
      return {
        firePlan: firePlans[0] ?? null,
        firePlans,
        fireBlockedReason: firePlans.length > 0 ? null : "no-ready-weapon",
        debugTag: level <= 1
          ? "shoot.level-1.former-level-2-capability-aware"
          : `shoot.level-${Math.min(7, level)}.property-capability-aware`,
      };
    },
  };
}

export function createLevelShootAi(level: AiLevel): ShootAiModule {
  return createCapabilityAwareShootAi(level);
}
