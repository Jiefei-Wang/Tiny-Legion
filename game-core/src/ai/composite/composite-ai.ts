import { AI_BEHAVIOR_CONFIG } from "../../config/ai/behavior.ts";
import type { ComponentId, ProjectileClass } from "../../types.ts";
import type { BattleState, UnitInstance } from "../../types.ts";

export interface WeaponFireAiInput {
  componentId: ComponentId;
  projectileClass: ProjectileClass;
  damage: number;
  penetration: number;
  spreadDeg: number;
  explosiveBlastRadius: number;
  trackingTurnRateDegPerSec: number;
  angleLimit?: {
    hasAngleLimit?: boolean;
    cwAngle?: number;
    ccwAngle?: number;
    facingAngleRad?: number;
  };
  effectiveRange: number;
  projectileSpeed: number;
  projectileGravity: number;
  firepointX: number;
  firepointY: number;
  /** Base and forward offset used by the runtime's angle-dependent muzzle. */
  projectileOriginBaseX: number;
  projectileOriginBaseY: number;
  projectileOriginForwardOffset: number;
  /** Reload/capacity properties exposed to property-derived craft tactics. */
  cooldownS: number;
  minimumFireIntervalS: number;
  maximumAmmo: number;
  loadedAmmo: number;
  requiresLoader: boolean;
}

export interface BattleAiInput {
  unit: UnitInstance;
  state: BattleState;
  dt: number;
  desiredRange: number;
  baseTarget: { x: number; y: number };
  battlefield: {
    width: number;
    height: number;
    laneBounds: {
      airMinZ: number;
      airMaxZ: number;
      groundMinY: number;
      groundMaxY: number;
    };
  };
  canShootAtAngle: (
    componentId: ComponentId,
    dx: number,
    dy: number,
    angleLimitOverride?: WeaponFireAiInput["angleLimit"],
  ) => boolean;
  getEffectiveWeaponRange: (baseRange: number) => number;
  getWeaponFireInput: (slot: number) => WeaponFireAiInput | null;
}

export interface RankedTarget {
  targetId: string;
  score: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: UnitInstance["type"];
}

export interface TargetDecision {
  rankedTargets: RankedTarget[];
  attackPoint: { x: number; y: number };
  debugTag: string;
}

export interface MovementDecision {
  ax: number;
  ay: number;
  shouldEvade: boolean;
  /** Requests a committed return to base for property-derived preservation tactics. */
  withdraw?: boolean;
  state: "engage" | "evade";
  debugTag: string;
}

export interface FirePlan {
  preferredSlot: number;
  intendedTargetId: string | null;
  intendedTargetY: number | null;
  angleRad: number;
  leadTimeS: number;
  effectiveRange: number;
  /** Accuracy wrappers may deliberately suppress missile homing for a biased shot. */
  disableTracking?: boolean;
}

export interface ShootDecision {
  firePlan: FirePlan | null;
  /** Optional independent plans for multiple ready weapon slots in the same update. */
  firePlans?: FirePlan[];
  fireBlockedReason: string | null;
  debugTag: string;
  /** Keep attachment/firepoint geometry stable for exact one-shot planning. */
  preserveFacing?: boolean;
}

export interface CombatDecision {
  facing: 1 | -1;
  state: "engage" | "evade";
  movement: { ax: number; ay: number; shouldEvade: boolean; withdraw?: boolean };
  firePlan: FirePlan | null;
  firePlans: FirePlan[];
  debug: {
    targetId: string | null;
    decisionPath: string;
    fireBlockedReason: string | null;
  };
}

export interface TargetAiModule {
  decideTarget: (input: BattleAiInput) => TargetDecision;
}

export interface MovementAiModule {
  decideMovement: (input: BattleAiInput, target: TargetDecision) => MovementDecision;
}

export interface ShootAiModule {
  decideShoot: (input: BattleAiInput, target: TargetDecision, movement: MovementDecision) => ShootDecision;
}

export interface CompositeAiModules {
  target: TargetAiModule;
  movement: MovementAiModule;
  shoot: ShootAiModule;
}

export interface BattleAiController {
  decide: (input: BattleAiInput) => CombatDecision;
}

export function createCompositeAiController(modules: CompositeAiModules): BattleAiController {
  const facingState = new Map<string, { facing: 1 | -1; changedAt: number }>();
  return {
    decide: (input): CombatDecision => {
      const target = modules.target.decideTarget(input);
      const movement = modules.movement.decideMovement(input, target);
      const shoot = modules.shoot.decideShoot(input, target, movement);
      const firePlans = shoot.firePlans ?? (shoot.firePlan ? [shoot.firePlan] : []);
      const requestedFacing = shoot.preserveFacing === true
        ? input.unit.facing
        : target.attackPoint.x >= input.unit.x ? 1 : -1;
      const previousFacing = facingState.get(input.unit.id) ?? {
        facing: input.unit.facing,
        changedAt: input.unit.aiStateTimer,
      };
      const canChangeFacing = input.unit.aiStateTimer - previousFacing.changedAt
        >= AI_BEHAVIOR_CONFIG.movement.minimumFacingChangeSeconds;
      const facing = requestedFacing !== previousFacing.facing && !canChangeFacing
        ? previousFacing.facing
        : requestedFacing;
      if (facing !== previousFacing.facing) {
        facingState.set(input.unit.id, { facing, changedAt: input.unit.aiStateTimer });
      } else if (!facingState.has(input.unit.id)) {
        facingState.set(input.unit.id, previousFacing);
      }
      const targetId = target.rankedTargets[0]?.targetId ?? null;
      return {
        facing,
        state: movement.state,
        movement: {
          ax: movement.ax,
          ay: movement.ay,
          shouldEvade: movement.shouldEvade,
          ...(movement.withdraw === true ? { withdraw: true } : {}),
        },
        firePlan: firePlans[0] ?? null,
        firePlans,
        debug: {
          targetId,
          decisionPath: `${target.debugTag} > ${movement.debugTag} > ${shoot.debugTag}`,
          fireBlockedReason: shoot.fireBlockedReason,
        },
      };
    },
  };
}
