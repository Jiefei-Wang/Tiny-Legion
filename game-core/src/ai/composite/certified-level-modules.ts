import { AI_BEHAVIOR_CONFIG } from "../../config/ai/behavior.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";
import { canOperate } from "../../simulation/units/control-unit-rules.ts";
import { structureIntegrity } from "../../simulation/units/structure-grid.ts";
import {
  assessProjectileThreats,
  assessProjectileThreatsAdvanced,
  chooseModelPredictiveEvasion,
} from "../movement/threat-movement.ts";
import type { UnitInstance } from "../../types.ts";
import type { BattleAiInput, MovementAiModule, RankedTarget, TargetAiModule } from "./composite-ai.ts";

type CertifiedLevel = 1 | 2 | 3 | 4 | 5;
type TargetDecision = ReturnType<TargetAiModule["decideTarget"]>;
type TargetMemory = { strategicTargetId: string | null; committedAt: number; nextDecisionAt: number; lastDecision: TargetDecision | null };
type MovementMemory = { edgeExposureS: number; horizontalSign: -1 | 0 | 1; horizontalChangedAt: number };

const REACTION_SECONDS: Readonly<Record<CertifiedLevel, number>> = { 1: 0.75, 2: 0.55, 3: 0.35, 4: 0.2, 5: 0.1 };

function certifiedLevel(raw: number): CertifiedLevel {
  return clamp(Math.floor(raw), 1, 5) as CertifiedLevel;
}

function liveEnemies(input: BattleAiInput): UnitInstance[] {
  return input.state.units.filter((enemy) => enemy.alive && canOperate(enemy) && enemy.side !== input.unit.side && enemy.type !== "base");
}

function liveWeaponStats(unit: UnitInstance): { range: number; pressure: number } {
  let range = 0;
  let pressure = 0;
  for (const attachmentId of unit.weaponAttachmentIds) {
    const attachment = unit.attachments.find((candidate) => candidate.id === attachmentId && candidate.alive);
    if (!attachment) continue;
    range = Math.max(range, Math.max(0, attachment.stats?.range ?? 0));
    pressure += Math.max(0, attachment.stats?.damage ?? 0) / Math.max(0.08, attachment.stats?.cooldown ?? 1);
  }
  return { range, pressure };
}

function ownWeaponRanges(input: BattleAiInput): number[] {
  const ranges: number[] = [];
  for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
    const weapon = input.getWeaponFireInput(slot);
    if (weapon) ranges.push(weapon.effectiveRange);
  }
  return ranges;
}

/**
 * Uses the first enabled live weapon in the same stable slot order traversed
 * by unified shooting. Disabled weapons cannot stretch or shrink movement's
 * engagement distance; a live-weapon fallback covers unusual all-manual data.
 */
export function intendedWeaponStandoff(input: BattleAiInput): { slot: number; range: number } {
  const slots = Array.from({ length: input.unit.weaponAttachmentIds.length }, (_, slot) => slot);
  const enabled = slots.find((slot) => input.unit.weaponAutoFire[slot] && input.getWeaponFireInput(slot) !== null);
  const fallback = enabled ?? slots.find((slot) => input.getWeaponFireInput(slot) !== null) ?? -1;
  const weapon = fallback >= 0 ? input.getWeaponFireInput(fallback) : null;
  const range = weapon?.effectiveRange ?? input.desiredRange;
  return {
    slot: fallback,
    range: Math.max(input.unit.radius * 4, range * AI_BEHAVIOR_CONFIG.movement.intendedWeaponStandoffRangeRatio),
  };
}

export function immediateAwarenessRange(input: BattleAiInput): number {
  const ranges = ownWeaponRanges(input);
  const ownRange = ranges.length > 0 ? Math.max(...ranges) : input.desiredRange;
  return Math.max(input.unit.radius * 8, 260, ownRange * AI_BEHAVIOR_CONFIG.target.awarenessRangeFactor);
}

function incomingPressure(input: BattleAiInput, enemy: UnitInstance): number {
  let pressure = 0;
  for (const projectile of input.state.projectiles) {
    if (projectile.side === input.unit.side) continue;
    if (projectile.homingTargetId === input.unit.id) pressure += 2;
    if (Math.hypot(projectile.x - input.unit.x, projectile.y - input.unit.y) <= immediateAwarenessRange(input) * 0.8) pressure += 0.2;
  }
  const enemyStats = liveWeaponStats(enemy);
  const distance = Math.hypot(enemy.x - input.unit.x, enemy.y - input.unit.y);
  if (enemyStats.range > 0 && distance <= enemyStats.range * 1.15 + input.unit.radius + enemy.radius) {
    pressure += 1 + clamp(enemyStats.pressure / 120, 0, 2);
  }
  return pressure;
}

type ScoredTarget = RankedTarget & { immediate: boolean; engageable: boolean; utility: number; threat: number };

function scoreTarget(input: BattleAiInput, enemy: UnitInstance, level: CertifiedLevel): ScoredTarget {
  const distance = Math.hypot(enemy.x - input.unit.x, enemy.y - input.unit.y);
  const awareness = immediateAwarenessRange(input);
  const engageable = ownWeaponRanges(input).some((range) => distance <= range * 1.05);
  const threat = incomingPressure(input, enemy);
  const immediate = distance <= awareness && (engageable || threat > 0);
  const integrity = structureIntegrity(enemy);
  const closing = distance > 1e-6
    ? -(((enemy.vx - input.unit.vx) * (enemy.x - input.unit.x) + (enemy.vy - input.unit.vy) * (enemy.y - input.unit.y)) / distance)
    : 0;
  const utility = (immediate ? 1_200 + (1 - clamp(distance / awareness, 0, 1)) * 600 : 0)
    + (engageable ? 260 + level * 35 : 0)
    + threat * (90 + level * 35)
    + (level >= 3 ? (1 - integrity) * (level === 3 ? 240 : level === 4 ? 650 : 1_100) : 0)
    + (level >= 4 ? clamp(closing, 0, 180) * 0.7 : 0)
    - distance;
  return { targetId: enemy.id, score: -utility, x: enemy.x, y: enemy.y, vx: enemy.vx, vy: enemy.vy, type: enemy.type, immediate, engageable, utility, threat };
}

/** Local threats rank for fire while movement keeps a committed strategic focus. */
export function createCertifiedLevelTargetAi(levelRaw: number): TargetAiModule {
  const level = certifiedLevel(levelRaw);
  const memory = new Map<string, TargetMemory>();
  return {
    decideTarget: (input) => {
      const now = input.unit.aiStateTimer;
      const prior = memory.get(input.unit.id) ?? { strategicTargetId: null, committedAt: now, nextDecisionAt: 0, lastDecision: null };
      if (prior.lastDecision && now < prior.nextDecisionAt) return prior.lastDecision;
      const ranked = liveEnemies(input).map((enemy) => scoreTarget(input, enemy, level)).sort((a, b) => (
        Number(b.immediate) - Number(a.immediate)
        || Number(b.engageable) - Number(a.engageable)
        || b.utility - a.utility
        || a.targetId.localeCompare(b.targetId)
      ));
      const current = ranked.find((candidate) => candidate.targetId === prior.strategicTargetId) ?? null;
      const challenger = ranked.slice().sort((a, b) => b.utility - a.utility || a.targetId.localeCompare(b.targetId))[0] ?? null;
      const emergency = ranked.find((candidate) => candidate.immediate && candidate.threat >= 1) ?? null;
      const heldLongEnough = now - prior.committedAt >= AI_BEHAVIOR_CONFIG.target.minimumCommitSeconds;
      const requiredUtility = current ? current.utility + Math.max(1, Math.abs(current.utility)) * AI_BEHAVIOR_CONFIG.target.challengerImprovementRatio : Number.NEGATIVE_INFINITY;
      const nextStrategic = emergency ?? (!current || (heldLongEnough && challenger && challenger.utility >= requiredUtility) ? challenger : current);
      if (nextStrategic?.targetId !== prior.strategicTargetId) prior.committedAt = now;
      prior.strategicTargetId = nextStrategic?.targetId ?? null;
      const decision: TargetDecision = {
        rankedTargets: ranked.map(({ immediate: _i, engageable: _e, utility: _u, threat: _t, ...candidate }) => candidate),
        attackPoint: nextStrategic ? { x: nextStrategic.x, y: nextStrategic.y } : { ...input.baseTarget },
        debugTag: `target.certified-l${level}.${ranked[0]?.immediate ? "local" : "strategic"}`,
      };
      prior.nextDecisionAt = now + REACTION_SECONDS[level];
      prior.lastDecision = decision;
      memory.set(input.unit.id, prior);
      return decision;
    },
  };
}

export function borderRecoveryVector(input: BattleAiInput, exposureS: number): { x: number; y: number; edgeCount: number; strength: number } {
  const { width, laneBounds } = input.battlefield;
  const minY = input.unit.type === "air" ? laneBounds.airMinZ : laneBounds.groundMinY;
  const maxY = input.unit.type === "air" ? laneBounds.airMaxZ : laneBounds.groundMaxY;
  const xMargin = Math.max(44, width * AI_BEHAVIOR_CONFIG.border.marginRatio);
  const yMargin = Math.max(input.unit.radius * 1.5, (maxY - minY) * AI_BEHAVIOR_CONFIG.border.marginRatio);
  let x = 0;
  let y = 0;
  let edgeCount = 0;
  if (input.unit.x < xMargin) { x += 1; edgeCount += 1; }
  if (input.unit.x > width - xMargin) { x -= 1; edgeCount += 1; }
  if (input.unit.y < minY + yMargin) { y += 1; edgeCount += 1; }
  if (input.unit.y > maxY - yMargin) { y -= 1; edgeCount += 1; }
  const strength = clamp((exposureS - AI_BEHAVIOR_CONFIG.border.graceSeconds) / AI_BEHAVIOR_CONFIG.border.recoverySeconds, 0, 1);
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length, edgeCount, strength };
}

function nearestLocalEnemy(input: BattleAiInput): UnitInstance | null {
  const awareness = immediateAwarenessRange(input);
  return liveEnemies(input).map((enemy) => ({ enemy, distance: Math.hypot(enemy.x - input.unit.x, enemy.y - input.unit.y) }))
    .filter((entry) => entry.distance <= awareness)
    .sort((a, b) => a.distance - b.distance || a.enemy.id.localeCompare(b.enemy.id))[0]?.enemy ?? null;
}

/** Shared human-readable movement rules with progressively stronger threat prediction. */
export function createCertifiedLevelMovementAi(levelRaw: number): MovementAiModule {
  const level = certifiedLevel(levelRaw);
  const memory = new Map<string, MovementMemory>();
  return {
    decideMovement: (input, target) => {
      const now = input.unit.aiStateTimer;
      const prior = memory.get(input.unit.id) ?? { edgeExposureS: 0, horizontalSign: 0, horizontalChangedAt: now };
      const dx = target.attackPoint.x - input.unit.x;
      const dy = target.attackPoint.y - input.unit.y;
      const distance = Math.hypot(dx, dy) || 1;
      const towardX = dx / distance;
      const towardY = dy / distance;
      const intendedWeapon = intendedWeaponStandoff(input);
      const desired = intendedWeapon.range;
      const rangeDirection = distance > desired * 1.03 ? 1 : distance < desired * 0.97 ? -0.35 : 0;
      let ax = towardX * rangeDirection;
      let ay = towardY * Math.abs(rangeDirection) * 0.42;
      let shouldEvade = false;
      let tactic = `weapon-${intendedWeapon.slot}-standoff`;

      const localEnemy = nearestLocalEnemy(input);
      if (localEnemy) {
        const localDx = localEnemy.x - input.unit.x;
        const localDy = localEnemy.y - input.unit.y;
        const localDistance = Math.hypot(localDx, localDy) || 1;
        const localWeight = clamp(1 - localDistance / immediateAwarenessRange(input), 0.18, 0.72);
        const localRangeDirection = localDistance < desired * 0.97 ? -1 : localDistance > desired * 1.03 ? 1 : 0;
        ax = ax * (1 - localWeight * 0.35) + localDx / localDistance * localWeight * 0.35 * localRangeDirection;
        ay = ay * (1 - localWeight * 0.45) + localDy / localDistance * localWeight * 0.45 * localRangeDirection;
        tactic = "local-aware";
      }

      const threats = level >= 3 ? assessProjectileThreatsAdvanced(input.unit, input.state, 1.5 + level * 0.25) : assessProjectileThreats(input.unit, input.state);
      const threatThreshold = level === 5 ? 0.06 : 0.42 - level * 0.045;
      const relevant = threats.filter((threat) => threat.score >= threatThreshold).slice(0, level >= 3 ? level : 1);
      const primary = relevant[0] ?? null;
      if (primary) {
        shouldEvade = true;
        if (input.unit.type === "air") {
          let evadeX = 0;
          let evadeY = 0;
          let total = 0;
          for (const threat of relevant) {
            const weight = Math.max(0.05, threat.score);
            evadeX += threat.evadeX * weight;
            evadeY += threat.evadeY * weight;
            total += weight;
          }
          const predictive = level >= 5 ? chooseModelPredictiveEvasion(input.unit, input.state, evadeX, evadeY, 1.8, 16, 0.035) : null;
          ax = predictive?.evadeX ?? evadeX / Math.max(0.01, total);
          ay = predictive?.evadeY ?? evadeY / Math.max(0.01, total);
          tactic = level >= 5 ? "air-predictive-dodge" : "air-free-dodge";
        } else {
          const lane = input.battlefield.laneBounds;
          const roomUp = input.unit.y - lane.groundMinY;
          const roomDown = lane.groundMaxY - input.unit.y;
          let verticalSign = Math.abs(primary.evadeY) > 0.15 ? Math.sign(primary.evadeY) : (roomDown >= roomUp ? 1 : -1);
          if (verticalSign < 0 && roomUp < input.unit.radius * 2) verticalSign = 1;
          if (verticalSign > 0 && roomDown < input.unit.radius * 2) verticalSign = -1;
          ax *= 0.28;
          ay = verticalSign * (0.85 + level * 0.1);
          tactic = "ground-vertical-dodge";
        }
      }

      const borderBefore = borderRecoveryVector(input, prior.edgeExposureS);
      const attackingBase = target.rankedTargets.length === 0;
      if (borderBefore.edgeCount > 0 && !shouldEvade && !attackingBase) {
        prior.edgeExposureS += input.dt * (borderBefore.edgeCount >= 2 ? AI_BEHAVIOR_CONFIG.border.cornerMultiplier : 1);
      } else if (borderBefore.edgeCount === 0) {
        prior.edgeExposureS = Math.max(0, prior.edgeExposureS - input.dt * 2);
      }
      const recovery = borderRecoveryVector(input, prior.edgeExposureS);
      if (recovery.strength > 0 && !shouldEvade && !attackingBase) {
        ax += recovery.x * recovery.strength * 1.4;
        ay += recovery.y * recovery.strength * 1.4;
        tactic = `${tactic}-border-recovery`;
      }

      if (input.unit.type === "ground") {
        const integrity = structureIntegrity(input.unit);
        const dangerouslyClose = distance <= desired * AI_BEHAVIOR_CONFIG.movement.groundReverseCloseRangeFactor;
        const critical = integrity < 0.22;
        const imminent = (primary?.timeToClosestS ?? Number.POSITIVE_INFINITY) < 0.32;
        const restoringWeaponStandoff = distance < desired * 0.97;
        if (ax * towardX < -0.02 && !restoringWeaponStandoff && !dangerouslyClose && !critical && !imminent) ax = 0;
        const proposedSign = Math.abs(ax) < 0.08 ? 0 : Math.sign(ax) as -1 | 1;
        const ordinaryReversal = proposedSign !== 0 && prior.horizontalSign !== 0 && proposedSign !== prior.horizontalSign
          && now - prior.horizontalChangedAt < AI_BEHAVIOR_CONFIG.movement.minimumGroundDirectionHoldSeconds
          && !dangerouslyClose && !critical && !imminent;
        if (ordinaryReversal) ax = prior.horizontalSign * Math.min(0.12, Math.abs(ax));
        else if (proposedSign !== 0 && proposedSign !== prior.horizontalSign) {
          prior.horizontalSign = proposedSign;
          prior.horizontalChangedAt = now;
        }
      }

      memory.set(input.unit.id, prior);
      return { ax: clamp(ax, -1.4, 1.4), ay: clamp(ay, -1.4, 1.4), shouldEvade, state: shouldEvade ? "evade" : "engage", debugTag: `movement.certified-l${level}.${tactic}` };
    },
  };
}
