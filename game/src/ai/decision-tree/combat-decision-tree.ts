import { COMPONENTS } from "../../config/balance/weapons.ts";
import { GROUND_FIRE_Y_TOLERANCE, PROJECTILE_SPEED } from "../../config/balance/range.ts";
import { getAliveWeaponAttachments } from "../../simulation/combat/recoil.ts";
import { structureIntegrity } from "../../simulation/units/structure-grid.ts";
import type { BattleState, ComponentId, UnitInstance } from "../../types.ts";
import { computeMovementDecision } from "../movement/threat-movement.ts";
import { solveBallisticAim } from "../shooting/ballistic-aim.ts";
import { adjustAimForWeaponPolicy } from "../shooting/weapon-ai-policy.ts";
import { selectBestTarget } from "../targeting/target-selector.ts";

type TickResult = "success" | "failure";

interface TreeNode {
  readonly id: string;
  tick: (ctx: Blackboard) => TickResult;
}

interface WeaponPlan {
  slot: number;
  attachmentId: number;
  componentId: ComponentId;
  effectiveRange: number;
  aim: { x: number; y: number };
  intendedTargetY: number | null;
  leadTimeS: number;
  angleRad: number;
  score: number;
}

interface Blackboard {
  readonly unit: UnitInstance;
  readonly state: BattleState;
  readonly dt: number;
  readonly desiredRange: number;
  readonly canShootAtAngle: (componentId: ComponentId, dx: number, dy: number) => boolean;
  readonly getEffectiveWeaponRange: (baseRange: number) => number;
  trace: string[];
  target: UnitInstance | null;
  attackPoint: { x: number; y: number };
  move: { ax: number; ay: number; shouldEvade: boolean };
  facing: 1 | -1;
  bestPlan: WeaponPlan | null;
  fireBlockedReason: string | null;
}

export interface CombatDecision {
  facing: 1 | -1;
  state: "engage" | "evade";
  movement: { ax: number; ay: number; shouldEvade: boolean };
  firePlan: {
    preferredSlot: number;
    aim: { x: number; y: number };
    intendedTargetId: string | null;
    intendedTargetY: number | null;
    angleRad: number;
    leadTimeS: number;
    effectiveRange: number;
  } | null;
  debug: {
    targetId: string | null;
    decisionPath: string;
    fireBlockedReason: string | null;
  };
}

function condition(id: string, predicate: (ctx: Blackboard) => boolean): TreeNode {
  return {
    id,
    tick: (ctx) => {
      ctx.trace.push(id);
      return predicate(ctx) ? "success" : "failure";
    },
  };
}

function action(id: string, run: (ctx: Blackboard) => TickResult): TreeNode {
  return {
    id,
    tick: (ctx) => {
      ctx.trace.push(id);
      return run(ctx);
    },
  };
}

function sequence(id: string, children: TreeNode[]): TreeNode {
  return {
    id,
    tick: (ctx) => {
      ctx.trace.push(id);
      for (const child of children) {
        if (child.tick(ctx) !== "success") {
          return "failure";
        }
      }
      return "success";
    },
  };
}

function selector(id: string, children: TreeNode[]): TreeNode {
  return {
    id,
    tick: (ctx) => {
      ctx.trace.push(id);
      for (const child of children) {
        if (child.tick(ctx) === "success") {
          return "success";
        }
      }
      return "failure";
    },
  };
}

function canHitByAxis(unit: UnitInstance, target: UnitInstance | null): boolean {
  if (!target) {
    return true;
  }
  if (unit.type === "air" || target.type === "air") {
    return true;
  }
  return Math.abs(target.y - unit.y) <= GROUND_FIRE_Y_TOLERANCE;
}

function createRootNode(): TreeNode {
  const chooseTarget = action("target.choose", (ctx) => {
    ctx.target = selectBestTarget(ctx.unit, ctx.state);
    if (ctx.target) {
      ctx.attackPoint = { x: ctx.target.x, y: ctx.target.y };
    }
    ctx.facing = ctx.attackPoint.x >= ctx.unit.x ? 1 : -1;
    return "success";
  });

  const planMovement = action("movement.plan", (ctx) => {
    const decision = computeMovementDecision(
      ctx.unit,
      ctx.state,
      ctx.attackPoint.x,
      ctx.attackPoint.y,
      ctx.desiredRange,
      ctx.dt,
    );

    const health = structureIntegrity(ctx.unit);
    let ax = decision.ax;
    let ay = decision.ay;
    if (health < 0.24) {
      ax -= Math.sign(ctx.attackPoint.x - ctx.unit.x) * 1.0;
      ay -= Math.sign(ctx.attackPoint.y - ctx.unit.y) * 0.6;
    }

    ctx.move = { ax, ay, shouldEvade: decision.shouldEvade || health < 0.24 };
    return "success";
  });

  const hasOperationalWeapons = condition("weapon.hasAny", (ctx) => {
    return getAliveWeaponAttachments(ctx.unit).length > 0;
  });

  const evaluateBestWeaponPlan = action("weapon.evaluate", (ctx) => {
    let best: WeaponPlan | null = null;
    let reason: string | null = null;

    const target = ctx.target;
    if (!canHitByAxis(ctx.unit, target)) {
      ctx.fireBlockedReason = "axis-mismatch";
      return "failure";
    }

    const targetVx = target?.vx ?? 0;
    const targetVy = target?.vy ?? 0;
    const distanceToTarget = Math.hypot(ctx.attackPoint.x - ctx.unit.x, ctx.attackPoint.y - ctx.unit.y);

    for (let slot = 0; slot < ctx.unit.weaponAttachmentIds.length; slot += 1) {
      if (!ctx.unit.weaponAutoFire[slot]) {
        continue;
      }
      if ((ctx.unit.weaponFireTimers[slot] ?? 0) > 0) {
        continue;
      }

      const attachmentId = ctx.unit.weaponAttachmentIds[slot];
      const attachment = ctx.unit.attachments.find((entry) => entry.id === attachmentId && entry.alive) ?? null;
      if (!attachment) {
        continue;
      }

      const stats = COMPONENTS[attachment.component];
      if (stats.range === undefined || stats.damage === undefined) {
        continue;
      }

      const effectiveRange = ctx.getEffectiveWeaponRange(stats.range);
      if (distanceToTarget > effectiveRange * 1.05) {
        reason = "out-of-range";
        continue;
      }

      const solved = solveBallisticAim(
        ctx.unit.x,
        ctx.unit.y,
        ctx.attackPoint.x,
        ctx.attackPoint.y,
        targetVx,
        targetVy,
        effectiveRange,
      );

      const leadTimeS = solved?.leadTimeS ?? 0;
      const angleRad = solved?.firingAngleRad ?? Math.atan2(ctx.attackPoint.y - ctx.unit.y, ctx.attackPoint.x - ctx.unit.x);
      const aimDistance = solved
        ? Math.max(90, Math.min(effectiveRange, PROJECTILE_SPEED * solved.leadTimeS))
        : Math.min(effectiveRange, Math.max(90, distanceToTarget));
      const baseAim = {
        x: ctx.unit.x + Math.cos(angleRad) * aimDistance,
        y: ctx.unit.y + Math.sin(angleRad) * aimDistance + ctx.unit.aiAimCorrectionY,
      };
      const aim = adjustAimForWeaponPolicy(attachment.component, baseAim);
      const aimDx = aim.x - ctx.unit.x;
      const aimDy = aim.y - ctx.unit.y;
      const angleAligned = ctx.canShootAtAngle(attachment.component, aimDx, aimDy);

      const rangeAlignment = 1 - Math.min(1, Math.abs(distanceToTarget - effectiveRange * 0.72) / Math.max(1, effectiveRange));
      const leadBonus = solved ? 1.15 : 0.62;
      const anglePenalty = angleAligned ? 0 : 7;
      const score = stats.damage * 1.2 + rangeAlignment * 25 + leadBonus * 18 - anglePenalty;

      if (!best || score > best.score) {
        best = {
          slot,
          attachmentId,
          componentId: attachment.component,
          effectiveRange,
          aim,
          intendedTargetY: solved?.y ?? (target ? ctx.attackPoint.y : null),
          leadTimeS,
          angleRad,
          score,
        };
      }
    }

    ctx.bestPlan = best;
    ctx.fireBlockedReason = best ? null : reason ?? "no-ready-weapon";
    return best ? "success" : "failure";
  });

  const hasShotPlan = condition("weapon.hasPlan", (ctx) => ctx.bestPlan !== null);

  const doReposition = action("movement.reposition", (ctx) => {
    if (ctx.fireBlockedReason === "angle-locked") {
      ctx.move.ax += ctx.facing * 0.65;
      ctx.move.ay += Math.sign(ctx.attackPoint.y - ctx.unit.y) * 0.35;
      return "success";
    }
    if (ctx.fireBlockedReason === "out-of-range") {
      const dx = ctx.attackPoint.x - ctx.unit.x;
      const dy = ctx.attackPoint.y - ctx.unit.y;
      const len = Math.hypot(dx, dy) || 1;
      ctx.move.ax += (dx / len) * 0.55;
      ctx.move.ay += (dy / len) * 0.35;
      return "success";
    }
    return "failure";
  });

  return sequence("root", [
    chooseTarget,
    planMovement,
    selector("combat.selector", [
      sequence("combat.fire-sequence", [hasOperationalWeapons, evaluateBestWeaponPlan, hasShotPlan]),
      doReposition,
    ]),
  ]);
}

const ROOT_NODE = createRootNode();

export function evaluateCombatDecisionTree(
  unit: UnitInstance,
  state: BattleState,
  dt: number,
  desiredRange: number,
  baseTarget: { x: number; y: number },
  canShootAtAngle: (componentId: ComponentId, dx: number, dy: number) => boolean,
  getEffectiveWeaponRange: (baseRange: number) => number,
): CombatDecision {
  const ctx: Blackboard = {
    unit,
    state,
    dt,
    desiredRange,
    canShootAtAngle,
    getEffectiveWeaponRange,
    trace: [],
    target: null,
    attackPoint: { x: baseTarget.x, y: baseTarget.y },
    move: { ax: 0, ay: 0, shouldEvade: false },
    facing: unit.facing,
    bestPlan: null,
    fireBlockedReason: null,
  };

  ROOT_NODE.tick(ctx);

  return {
    facing: ctx.facing,
    state: ctx.move.shouldEvade ? "evade" : "engage",
    movement: ctx.move,
    firePlan: ctx.bestPlan
      ? {
          preferredSlot: ctx.bestPlan.slot,
          aim: ctx.bestPlan.aim,
          intendedTargetId: ctx.target?.id ?? null,
          intendedTargetY: ctx.bestPlan.intendedTargetY,
          angleRad: ctx.bestPlan.angleRad,
          leadTimeS: ctx.bestPlan.leadTimeS,
          effectiveRange: ctx.bestPlan.effectiveRange,
        }
      : null,
    debug: {
      targetId: ctx.target?.id ?? null,
      decisionPath: ctx.trace.join(" > "),
      fireBlockedReason: ctx.fireBlockedReason,
    },
  };
}
