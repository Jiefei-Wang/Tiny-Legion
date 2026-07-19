import { GROUND_FIRE_Y_TOLERANCE } from "../../config/balance/range.ts";
import { getStructureCellSize } from "../../config/balance/battlefield.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";
import { structureIntegrity } from "../../simulation/units/structure-grid.ts";
import { assessProjectileThreats } from "../movement/threat-movement.ts";
import { solveBallisticAim } from "../shooting/ballistic-aim.ts";
import {
  createBaselineMovementAi,
  createBaselineShootAi,
} from "./baseline-modules.ts";
import type {
  MovementAiModule,
  ShootAiModule,
  TargetAiModule,
} from "./composite-ai.ts";

export type AiSkillTier = "low" | "medium" | "high";

const TIER_RANK: Record<AiSkillTier, number> = { low: 1, medium: 2, high: 3 };

function canHitByAxis(unitY: number, unitType: "ground" | "air", targetY: number, targetType: "ground" | "air"): boolean {
  return unitType === "air" || targetType === "air" || Math.abs(targetY - unitY) <= GROUND_FIRE_Y_TOLERANCE;
}

/** Built-in skill tiers use increasingly coordinated focus fire without changing unit stats. */
export function createSkillTierTargetAi(tier: AiSkillTier): TargetAiModule {
  const rank = TIER_RANK[tier];
  const aimPointFor = (enemy: Parameters<TargetAiModule["decideTarget"]>[0]["unit"]): { x: number; y: number } => {
    const aliveCells = enemy.structure.filter((cell) => !cell.destroyed);
    if (aliveCells.length === 0) return { x: enemy.x, y: enemy.y };
    let cell = aliveCells.reduce((best, candidate) => candidate.armor < best.armor ? candidate : best);
    const aliveWeapons = enemy.attachments.filter((attachment) => attachment.alive && enemy.weaponAttachmentIds.includes(attachment.id));
    const weaponAttachment = aliveWeapons[0];
    cell = aliveCells.find((candidate) => candidate.id === weaponAttachment?.cell) ?? cell;
    if (tier === "high") {
      const controlAttachment = enemy.attachments.find((attachment) => attachment.alive && attachment.id === enemy.controlAttachmentId);
      cell = aliveCells.find((candidate) => candidate.id === controlAttachment?.cell) ?? cell;
    }
    const minX = Math.min(...enemy.structure.map((candidate) => candidate.x));
    const maxX = Math.max(...enemy.structure.map((candidate) => candidate.x));
    const minY = Math.min(...enemy.structure.map((candidate) => candidate.y));
    const maxY = Math.max(...enemy.structure.map((candidate) => candidate.y));
    const cellSize = getStructureCellSize(enemy.radius);
    const localX = (cell.x - minX) * cellSize - (maxX - minX + 1) * cellSize / 2 + cellSize / 2;
    const localY = (cell.y - minY) * cellSize - (maxY - minY + 1) * cellSize / 2 + cellSize / 2;
    return { x: enemy.x + localX * enemy.facing, y: enemy.y + localY };
  };
  return {
    decideTarget: (input) => {
      const enemies = input.state.units
        .filter((unit) => unit.alive && unit.side !== input.unit.side)
        .map((enemy) => {
          const aimPoint = aimPointFor(enemy);
          const distance = Math.hypot(enemy.x - input.unit.x, enemy.y - input.unit.y);
          const integrity = structureIntegrity(enemy);
          const threat = enemy.weaponAttachmentIds.filter((_, slot) => enemy.weaponAutoFire[slot] !== false).length;
          const axisPenalty = canHitByAxis(input.unit.y, input.unit.type, enemy.y, enemy.type) ? 0 : 10_000;
          const threatFocus = rank === 1 ? 8 : rank === 2 ? 18 : 30;
          const finishScore = integrity * 2_000;
          return {
            targetId: enemy.id,
            score: axisPenalty + distance * 0.12 + Math.abs(enemy.y - input.unit.y) * 0.08 + finishScore - threat * threatFocus,
            x: aimPoint.x,
            y: aimPoint.y,
            vx: enemy.vx,
            vy: enemy.vy,
            type: enemy.type,
          };
        })
        .sort((a, b) => a.score - b.score || a.targetId.localeCompare(b.targetId));
      const enemyBase = input.unit.side === "player" ? input.state.enemyBase : input.state.playerBase;
      const basePoint = { x: enemyBase.x + enemyBase.w * 0.5, y: enemyBase.y + enemyBase.h * 0.5 };
      const baseDistance = Math.hypot(basePoint.x - input.unit.x, basePoint.y - input.unit.y);
      const baseIntegrity = enemyBase.hp / Math.max(1, enemyBase.maxHp);
      if (tier === "high" && (baseIntegrity < 0.8 || baseDistance <= input.desiredRange * 1.12)) {
        return { rankedTargets: [], attackPoint: basePoint, debugTag: "target.skill-high.finish-base" };
      }
      const primary = enemies[0];
      return {
        rankedTargets: enemies,
        attackPoint: primary ? { x: primary.x, y: primary.y } : { ...input.baseTarget },
        debugTag: `target.skill-${tier}`,
      };
    },
  };
}

/** Higher tiers react earlier and combine several incoming trajectories instead of one. */
export function createSkillTierMovementAi(tier: AiSkillTier): MovementAiModule {
  const baseline = createBaselineMovementAi();
  const rank = TIER_RANK[tier];
  return {
    decideMovement: (input, target) => {
      const decision = baseline.decideMovement(input, target);
      const targetDx = target.attackPoint.x - input.unit.x;
      const targetDy = target.attackPoint.y - input.unit.y;
      const targetDistance = Math.hypot(targetDx, targetDy) || 1;
      const jinkStrength = 0.45;
      const jinkPhase = input.unit.aiStateTimer * 3.1 + input.unit.id.length * 0.91;
      const jink = Math.sin(jinkPhase) * jinkStrength;
      const jinkedDecision = {
        ...decision,
        ax: clamp(decision.ax + (-targetDy / targetDistance) * jink * 0.55, -1.4, 1.4),
        ay: clamp(decision.ay + (targetDx / targetDistance) * jink, -1.4, 1.4),
        debugTag: `movement.skill-${tier}.jink`,
      };
      const threats = assessProjectileThreats(input.unit, input.state).slice(0, rank);
      const threshold = 0.56;
      let evadeX = 0;
      let evadeY = 0;
      let weightTotal = 0;
      for (const threat of threats) {
        if (threat.score < threshold) continue;
        const weight = Math.max(0.05, threat.score) * (1 + (1.15 - threat.timeToClosestS) * 0.35);
        evadeX += threat.evadeX * weight;
        evadeY += threat.evadeY * weight;
        weightTotal += weight;
      }
      if (weightTotal <= 0) {
        return jinkedDecision;
      }
      const evadeStrength = tier === "low" ? 0.9 : tier === "medium" ? 1.22 : 1.4;
      return {
        ax: clamp(jinkedDecision.ax * 0.68 + evadeX / weightTotal * evadeStrength, -1.4, 1.4),
        ay: clamp(jinkedDecision.ay * 0.68 + evadeY / weightTotal * evadeStrength, -1.4, 1.4),
        shouldEvade: true,
        state: "evade",
        debugTag: `movement.skill-${tier}.projectile-${threats.length}`,
      };
    },
  };
}

/** Re-solves per-weapon intercepts and models increasingly short reaction windows. */
export function createSkillTierShootAi(tier: AiSkillTier): ShootAiModule {
  const baseline = createBaselineShootAi();
  return {
    decideShoot: (input, target, movement) => {
      const base = baseline.decideShoot(input, target, movement);
      const primary = target.rankedTargets[0] ?? null;
      if (!base.firePlan || !primary) return { ...base, debugTag: `shoot.skill-${tier}.${base.debugTag}` };
      const weapon = input.getWeaponFireInput(base.firePlan.preferredSlot);
      if (!weapon) return base;

      const solution = solveBallisticAim(
        weapon.firepointX,
        weapon.firepointY,
        primary.x,
        primary.y,
        primary.vx,
        primary.vy,
        weapon.effectiveRange,
        weapon.projectileSpeed,
        weapon.projectileGravity,
      );
      if (!solution) return { ...base, debugTag: `shoot.skill-${tier}.fallback` };
      const cadencePeriod = 1.7;
      const cadenceOpen = tier === "low" ? 1 : tier === "medium" ? 1.32 : cadencePeriod;
      if ((input.unit.aiStateTimer % cadencePeriod) > cadenceOpen) {
        return { firePlan: null, fireBlockedReason: "skill-reaction-window", debugTag: `shoot.skill-${tier}.reaction` };
      }
      return {
        firePlan: {
          ...base.firePlan,
          intendedTargetId: primary.targetId,
          intendedTargetY: solution.y,
          angleRad: solution.firingAngleRad,
          leadTimeS: solution.leadTimeS,
        },
        fireBlockedReason: null,
        debugTag: `shoot.skill-${tier}.intercept`,
      };
    },
  };
}
