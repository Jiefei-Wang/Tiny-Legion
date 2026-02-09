import type { ComponentId } from "../../types.ts";
import type { BattleState, UnitInstance } from "../../types.ts";

export interface BattleAiInput {
  unit: UnitInstance;
  state: BattleState;
  dt: number;
  desiredRange: number;
  baseTarget: { x: number; y: number };
  canShootAtAngle: (componentId: ComponentId, dx: number, dy: number, shootAngleDegOverride?: number) => boolean;
  getEffectiveWeaponRange: (baseRange: number) => number;
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
  state: "engage" | "evade";
  debugTag: string;
}

export interface FirePlan {
  preferredSlot: number;
  aim: { x: number; y: number };
  intendedTargetId: string | null;
  intendedTargetY: number | null;
  angleRad: number;
  leadTimeS: number;
  effectiveRange: number;
}

export interface ShootDecision {
  firePlan: FirePlan | null;
  fireBlockedReason: string | null;
  debugTag: string;
}

export interface CombatDecision {
  facing: 1 | -1;
  state: "engage" | "evade";
  movement: { ax: number; ay: number; shouldEvade: boolean };
  firePlan: FirePlan | null;
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
  return {
    decide: (input): CombatDecision => {
      const target = modules.target.decideTarget(input);
      const movement = modules.movement.decideMovement(input, target);
      const shoot = modules.shoot.decideShoot(input, target, movement);
      const facing = target.attackPoint.x >= input.unit.x ? 1 : -1;
      const targetId = target.rankedTargets[0]?.targetId ?? null;
      return {
        facing,
        state: movement.state,
        movement: {
          ax: movement.ax,
          ay: movement.ay,
          shouldEvade: movement.shouldEvade,
        },
        firePlan: shoot.firePlan,
        debug: {
          targetId,
          decisionPath: `${target.debugTag} > ${movement.debugTag} > ${shoot.debugTag}`,
          fireBlockedReason: shoot.fireBlockedReason,
        },
      };
    },
  };
}
