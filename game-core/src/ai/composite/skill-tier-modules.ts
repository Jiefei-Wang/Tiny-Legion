import { GROUND_FIRE_Y_TOLERANCE } from "../../config/balance/range.ts";
import { getStructureCellSize } from "../../config/balance/battlefield.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";
import { canOperate } from "../../simulation/units/control-unit-rules.ts";
import { structureIntegrity } from "../../simulation/units/structure-grid.ts";
import { assessProjectileThreats } from "../movement/threat-movement.ts";
import { solveBallisticAim } from "../shooting/ballistic-aim.ts";
import {
  createBaselineMovementAi,
  createBaselineShootAi,
} from "./baseline-modules.ts";
import type {
  BattleAiInput,
  MovementAiModule,
  RankedTarget,
  ShootAiModule,
  TargetAiModule,
} from "./composite-ai.ts";
import type { StructureCell, UnitInstance } from "../../types.ts";

export type AiSkillTier = "baseline" | "low" | "medium" | "high";

function canHitByAxis(unitY: number, unitType: "ground" | "air", targetY: number, targetType: "ground" | "air"): boolean {
  return unitType === "air" || targetType === "air" || Math.abs(targetY - unitY) <= GROUND_FIRE_Y_TOLERANCE;
}

function stableUnitPhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000 * Math.PI * 2;
}

function remainingCellRatio(cell: StructureCell): number {
  return Math.max(0, cell.breakThreshold - cell.strain) / Math.max(1, cell.breakThreshold);
}

function supportedCell(enemy: UnitInstance, attachmentId: number | undefined): StructureCell | null {
  if (attachmentId === undefined) return null;
  const attachment = enemy.attachments.find((candidate) => candidate.id === attachmentId && candidate.alive);
  if (!attachment) return null;
  const supportIds = new Set(attachment.attachedStructureCellIds);
  return enemy.structure
    .filter((cell) => !cell.destroyed && supportIds.has(cell.id))
    .sort((a, b) => remainingCellRatio(a) - remainingCellRatio(b) || a.armor - b.armor)[0] ?? null;
}

function chooseAimCell(enemy: UnitInstance, tier: AiSkillTier, shooterX: number, penetration: number): StructureCell | null {
  if (tier === "baseline") return null;
  const aliveCells = enemy.structure.filter((cell) => !cell.destroyed);
  if (aliveCells.length === 0) return null;
  if (tier === "high" && penetration > 0) {
    const controlCell = supportedCell(enemy, enemy.controlAttachmentId);
    if (controlCell) return controlCell;
  }
  const worldX = (cell: StructureCell): number => cellWorldPoint(enemy, cell).x;
  const frontX = shooterX < enemy.x
    ? Math.min(...aliveCells.map(worldX))
    : Math.max(...aliveCells.map(worldX));
  const exposed = aliveCells.filter((cell) => Math.abs(worldX(cell) - frontX) < 1e-6);
  return exposed.sort((a, b) => remainingCellRatio(a) - remainingCellRatio(b) || a.armor - b.armor)[0] ?? aliveCells[0] ?? null;
}

function cellWorldPoint(enemy: UnitInstance, cell: StructureCell | null): { x: number; y: number } {
  if (!cell) return { x: enemy.x, y: enemy.y };
  const aliveOrDestroyed = enemy.structure;
  const minX = Math.min(...aliveOrDestroyed.map((candidate) => candidate.x));
  const maxX = Math.max(...aliveOrDestroyed.map((candidate) => candidate.x));
  const minY = Math.min(...aliveOrDestroyed.map((candidate) => candidate.y));
  const maxY = Math.max(...aliveOrDestroyed.map((candidate) => candidate.y));
  const cellSize = getStructureCellSize(enemy.radius, enemy.type);
  const localX = (cell.x - minX) * cellSize - (maxX - minX + 1) * cellSize / 2 + cellSize / 2;
  const localY = (cell.y - minY) * cellSize - (maxY - minY + 1) * cellSize / 2 + cellSize / 2;
  return { x: enemy.x + localX * enemy.facing, y: enemy.y + localY };
}

function ownWeaponProfile(input: BattleAiInput): { maxRange: number; maxPenetration: number; hasRapidFire: boolean } {
  let maxRange = 0;
  let maxPenetration = 0;
  let hasRapidFire = false;
  for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
    const weapon = input.getWeaponFireInput(slot);
    if (!weapon) continue;
    maxRange = Math.max(maxRange, weapon.effectiveRange);
    maxPenetration = Math.max(maxPenetration, weapon.penetration);
    hasRapidFire ||= weapon.projectileClass === "laser" || weapon.projectileClass === "bullet";
  }
  return { maxRange, maxPenetration, hasRapidFire };
}

/**
 * Tier targeting is weapon-aware: it weighs range, penetration versus armor,
 * target type, threat, and exposed structure. High-penetration high-tier shots
 * can deliberately attack the structure supporting a control unit.
 */
export function createSkillTierTargetAi(tier: AiSkillTier): TargetAiModule {
  return {
    decideTarget: (input) => {
      const weapon = ownWeaponProfile(input);
      const enemies = input.state.units
        .filter((unit) => unit.alive && canOperate(unit) && unit.side !== input.unit.side)
        .map((enemy) => {
          const aimPoint = cellWorldPoint(enemy, chooseAimCell(enemy, tier, input.unit.x, weapon.maxPenetration));
          const distance = Math.hypot(aimPoint.x - input.unit.x, aimPoint.y - input.unit.y);
          const integrity = structureIntegrity(enemy);
          const threat = enemy.weaponAttachmentIds.filter((attachmentId) => enemy.attachments.some((a) => a.id === attachmentId && a.alive)).length;
          const maxArmor = enemy.structure.filter((cell) => !cell.destroyed).reduce((value, cell) => Math.max(value, cell.armor), 0);
          const axisPenalty = canHitByAxis(input.unit.y, input.unit.type, aimPoint.y, enemy.type) ? 0 : 50_000;
          const rangePenalty = Math.max(0, distance - weapon.maxRange * 1.08) * 0.3;
          const armorMismatch = Math.max(0, maxArmor - weapon.maxPenetration) * (weapon.hasRapidFire ? 2.2 : 0.5);
          const finishWeight = tier === "baseline" ? 0 : 320;
          const distanceWeight = tier === "baseline" ? 1.2 : 0.95;
          const threatWeight = tier === "baseline" ? 0 : 12;
          const counterScale = tier === "medium" ? 1 : tier === "high" ? 1.6 : 0;
          const counterBonus = counterScale * (
            weapon.hasRapidFire && enemy.type === "air"
              ? 260
              : weapon.maxPenetration >= maxArmor && weapon.maxPenetration > 0 && enemy.type === "ground"
                ? 190
                : 0
          );
          return {
            targetId: enemy.id,
            score: axisPenalty + rangePenalty + distance * distanceWeight + integrity * finishWeight + armorMismatch - threat * threatWeight - counterBonus,
            x: aimPoint.x,
            y: aimPoint.y,
            vx: enemy.vx,
            vy: enemy.vy,
            type: enemy.type,
          } satisfies RankedTarget;
        })
        .sort((a, b) => a.score - b.score || a.targetId.localeCompare(b.targetId));
      const primary = enemies[0];
      return {
        rankedTargets: enemies,
        attackPoint: primary ? { x: primary.x, y: primary.y } : { ...input.baseTarget },
        debugTag: `target.skill-${tier}.weapon-aware`,
      };
    },
  };
}

/** Skilled tiers add danger-aware evasion and de-synchronized strafing to baseline movement. */
export function createSkillTierMovementAi(tier: AiSkillTier): MovementAiModule {
  const baseline = createBaselineMovementAi();
  const settings = { threatCount: 1, threshold: 0.34, evadeStrength: 0.92, jink: 0.22, retain: 0.82 };
  return {
    decideMovement: (input, target) => {
      const decision = baseline.decideMovement(input, target);
      if (tier === "baseline") {
        const dx = target.attackPoint.x - input.unit.x;
        const dy = target.attackPoint.y - input.unit.y;
        const distance = Math.hypot(dx, dy) || 1;
        const rangeDirection = distance > input.desiredRange ? 1 : distance < input.desiredRange * 0.65 ? -0.15 : 0.2;
        return {
          ax: clamp(dx / distance * rangeDirection, -1, 1),
          ay: clamp(dy / distance * Math.abs(rangeDirection) * 0.35, -0.5, 0.5),
          shouldEvade: false,
          state: "engage",
          debugTag: `movement.skill-${tier}.direct`,
        };
      }
      const dx = target.attackPoint.x - input.unit.x;
      const dy = target.attackPoint.y - input.unit.y;
      const distance = Math.hypot(dx, dy) || 1;
      const phase = input.unit.aiStateTimer * (tier === "low" ? 2.3 : tier === "medium" ? 3.4 : 4.6) + stableUnitPhase(input.unit.id);
      const jink = Math.sin(phase) * settings.jink;
      const baseX = clamp(decision.ax + (-dy / distance) * jink * 0.55, -1.4, 1.4);
      const baseY = clamp(decision.ay + (dx / distance) * jink, -1.4, 1.4);
      const threats = assessProjectileThreats(input.unit, input.state).slice(0, settings.threatCount);
      let evadeX = 0;
      let evadeY = 0;
      let totalWeight = 0;
      for (const threat of threats) {
        if (threat.score < settings.threshold) continue;
        const urgency = 1 + Math.max(0, 1.25 - threat.timeToClosestS) * 0.75;
        const weight = Math.max(0.03, threat.score) * urgency;
        evadeX += threat.evadeX * weight;
        evadeY += threat.evadeY * weight;
        totalWeight += weight;
      }
      if (totalWeight <= 0) {
        return {
          ...decision,
          ax: baseX,
          ay: baseY,
          debugTag: `movement.skill-${tier}.strafe`,
        };
      }
      return {
        ax: clamp(baseX * settings.retain + evadeX / totalWeight * settings.evadeStrength, -1.4, 1.4),
        ay: clamp(baseY * settings.retain + evadeY / totalWeight * settings.evadeStrength, -1.4, 1.4),
        shouldEvade: true,
        state: "evade",
        debugTag: `movement.skill-${tier}.threats-${threats.length}`,
      };
    },
  };
}

function historyVelocity(input: BattleAiInput, target: RankedTarget, tier: AiSkillTier): { vx: number; vy: number } {
  void input;
  const predictionGain = tier === "baseline" ? 0 : tier === "low" ? 0.3 : tier === "medium" ? 0.6 : 1;
  return { vx: target.vx * predictionGain, vy: target.vy * predictionGain };
}

/**
 * Skill shooting searches progressively more target/weapon combinations and
 * re-solves each intercept with live per-weapon ballistics. Baseline fallback
 * is retained for firing at an undefended base.
 */
export function createSkillTierShootAi(tier: AiSkillTier): ShootAiModule {
  const baseline = createBaselineShootAi();
  const targetLimit = tier === "baseline" || tier === "low" ? 1 : tier === "medium" ? 3 : Number.POSITIVE_INFINITY;
  return {
    decideShoot: (input, target, movement) => {
      if (target.rankedTargets.length === 0) {
        const baseDecision = baseline.decideShoot(input, target, movement);
        return { ...baseDecision, debugTag: `shoot.skill-${tier}.base` };
      }
      let best: ReturnType<ShootAiModule["decideShoot"]>["firePlan"] = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      let blockedReason = "no-ready-weapon";
      const cadencePeriod = 4;
      const cadenceOpen = tier === "baseline" ? 0.2 : tier === "low" ? 0.65 : tier === "medium" ? 1.6 : cadencePeriod;
      const cadencePhase = stableUnitPhase(input.unit.id) / (Math.PI * 2) * cadencePeriod;
      if (((input.unit.aiStateTimer + cadencePhase) % cadencePeriod) > cadenceOpen) {
        return {
          firePlan: null,
          fireBlockedReason: "skill-reaction-window",
          debugTag: `shoot.skill-${tier}.reaction`,
        };
      }
      const maxPredictionErrorRad = (tier === "baseline" ? 60 : tier === "low" ? 30 : tier === "medium" ? 15 : 0) * Math.PI / 180;
      const candidates = target.rankedTargets.slice(0, targetLimit);
      for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
        if (!input.unit.weaponAutoFire[slot] || (input.unit.weaponFireTimers[slot] ?? 0) > 0) continue;
        const weapon = input.getWeaponFireInput(slot);
        if (!weapon) continue;
        for (let targetIndex = 0; targetIndex < candidates.length; targetIndex += 1) {
          const candidate = candidates[targetIndex]!;
          if (!canHitByAxis(input.unit.y, input.unit.type, candidate.y, candidate.type)) {
            blockedReason = "axis-mismatch";
            continue;
          }
          const distance = Math.hypot(candidate.x - weapon.firepointX, candidate.y - weapon.firepointY);
          if (distance > weapon.effectiveRange * 1.04) {
            blockedReason = "out-of-range";
            continue;
          }
          const velocity = historyVelocity(input, candidate, tier);
          const solution = solveBallisticAim(
            weapon.firepointX,
            weapon.firepointY,
            candidate.x,
            candidate.y,
            velocity.vx,
            velocity.vy,
            weapon.effectiveRange,
            weapon.projectileSpeed,
            weapon.projectileGravity,
          );
          const solvedAngle = solution?.firingAngleRad ?? Math.atan2(candidate.y - weapon.firepointY, candidate.x - weapon.firepointX);
          const predictionError = Math.sin(stableUnitPhase(input.unit.id) + input.unit.aiStateTimer * 1.31) * maxPredictionErrorRad;
          const angleRad = solvedAngle + predictionError;
          if (!input.canShootAtAngle(
            weapon.componentId,
            Math.cos(angleRad) * distance,
            Math.sin(angleRad) * distance,
            weapon.angleLimit,
          )) {
            blockedReason = "angle-locked";
            continue;
          }
          const solutionBonus = solution ? 55 : 0;
          const rankPenalty = targetIndex * 1_000;
          const rangeQuality = 1 - Math.abs(distance / Math.max(1, weapon.effectiveRange) - 0.72);
          const score = weapon.damage * 1.4 + solutionBonus + rangeQuality * 30 - rankPenalty;
          if (score <= bestScore) continue;
          bestScore = score;
          best = {
            preferredSlot: slot,
            intendedTargetId: candidate.targetId,
            intendedTargetY: solution?.y ?? candidate.y,
            angleRad,
            leadTimeS: solution?.leadTimeS ?? 0,
            effectiveRange: weapon.effectiveRange,
          };
        }
      }
      if (!best) {
        return {
          firePlan: null,
          fireBlockedReason: blockedReason,
          debugTag: `shoot.skill-${tier}.${blockedReason}`,
        };
      }
      return {
        firePlan: best,
        fireBlockedReason: null,
        debugTag: `shoot.skill-${tier}.weapon-target-search`,
      };
    },
  };
}
