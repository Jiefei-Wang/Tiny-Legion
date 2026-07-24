import { AI_TARGET_HISTORY_SAMPLE_INTERVAL_S, GROUND_FIRE_Y_TOLERANCE } from "../../config/balance/range.ts";
import { structureIntegrity } from "../../simulation/units/structure-grid.ts";
import { getStructureCellSize } from "../../config/balance/battlefield.ts";
import { MAX_CERTIFIED_AI_LEVEL } from "../../config/ai/levels.ts";
import { canOperate } from "../../simulation/units/control-unit-rules.ts";
import { solveBallisticAim } from "../shooting/ballistic-aim.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";
import {
  createSkillTierMovementAi,
  createSkillTierShootAi,
  createSkillTierTargetAi,
} from "./skill-tier-modules.ts";
import {
  createAutoregShootAi,
  createHistoryWeightedShootAi,
} from "./baseline-modules.ts";
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
  if (level <= 1) return high;
  const integrityWeight = 160;
  const weaponThreatWeight = 12;
  return {
    decideTarget: (input) => {
      const decision = high.decideTarget(input);
      const rankedTargets = decision.rankedTargets
        .map((candidate) => {
          const enemy = liveEnemy(input, candidate.targetId);
          if (!enemy) return candidate;
          const integrity = structureIntegrity(enemy);
          const liveWeapons = enemy.weaponAttachmentIds.filter((attachmentId) => enemy.attachments.some((entry) => entry.id === attachmentId && entry.alive)).length;
          return { ...candidate, score: candidate.score + integrity * integrityWeight - liveWeapons * weaponThreatWeight };
        })
        .sort((a, b) => a.score - b.score || a.targetId.localeCompare(b.targetId));
      const primary = rankedTargets[0];
      return {
        rankedTargets,
        attackPoint: primary ? { x: primary.x, y: primary.y } : decision.attackPoint,
        debugTag: "target.level-2.finish-threat-blend",
      };
    },
  };
}

export function createLevelMovementAi(level: AiLevel): MovementAiModule {
  void level;
  return createSkillTierMovementAi("high");
}

function createCapabilityAwareShootAi(): ShootAiModule {
  const fallback = createSkillTierShootAi("high");
  return {
    decideShoot: (input, target, movement) => {
      const primary = target.rankedTargets[0];
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
        if (maxReadyDamage > 0 && weapon.damage < maxReadyDamage * 0.5) {
          const compatible = target.rankedTargets
            .filter((candidate) => canHitByAxis(input.unit, candidate))
            .map((candidate) => ({ candidate, distance: Math.hypot(candidate.x - weapon.firepointX, candidate.y - weapon.firepointY) }))
            .filter((entry) => entry.distance <= weapon.effectiveRange * 1.04)
            .sort((a, b) => {
              const counterScore = (candidate: RankedTarget): number => {
                const enemy = liveEnemy(input, candidate.targetId);
                if (!enemy) return 0;
                if ((weapon.weaponClass === "rapid-fire" || weapon.weaponClass === "beam-precision") && candidate.type === "air") return -200;
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
        const initialTarget = { ...selectedTarget, x: point.x, y: point.y };
        const initialPlan = solvePlan(input, weapon, slot, initialTarget, point);
        let plan = initialPlan;
        const history = enemy.targetHistory;
        if (initialPlan && history.length >= 2 && initialPlan.leadTimeS > 0) {
          const previous = history[history.length - 2]!;
          const newest = history[history.length - 1]!;
          const sampledVx = (newest.x - previous.x) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
          const sampledVy = (newest.y - previous.y) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
          let accelX = (selectedTarget.vx - sampledVx) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
          let accelY = (selectedTarget.vy - sampledVy) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
          if (history.length >= 3) {
            const older = history[history.length - 3]!;
            const priorVx = (previous.x - older.x) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
            const priorVy = (previous.y - older.y) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
            accelX = accelX * 0.9 + (sampledVx - priorVx) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S) * 0.1;
            accelY = accelY * 0.9 + (sampledVy - priorVy) / Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S) * 0.1;
          }
          const horizon = Math.min(0.8, initialPlan.leadTimeS) * 0.18;
          plan = solvePlan(input, weapon, slot, {
            ...initialTarget,
            vx: selectedTarget.vx + clamp(accelX * horizon, -180, 180),
            vy: selectedTarget.vy + clamp(accelY * horizon, -180, 180),
          }, point) ?? initialPlan;
        }
        if (plan) firePlans.push(plan);
      }
      return {
        firePlan: firePlans[0] ?? null,
        firePlans,
        fireBlockedReason: firePlans.length > 0 ? null : "no-ready-weapon",
        debugTag: "shoot.level-2.capability-aware",
      };
    },
  };
}

export function createLevelShootAi(level: AiLevel): ShootAiModule {
  if (level <= 1) return createSkillTierShootAi("high");
  if (level === 2) return createCapabilityAwareShootAi();
  if (level <= 4) return createHistoryWeightedShootAi(1);
  return createAutoregShootAi(0.2);
}
