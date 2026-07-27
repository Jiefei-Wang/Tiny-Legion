import { createBaselineCompositeAiController } from "../composite/baseline-modules.ts";
import type { BattleAiInput, CombatDecision } from "../composite/composite-ai.ts";

const BASELINE_CONTROLLER = createBaselineCompositeAiController();

export type { CombatDecision };

export function evaluateCombatDecisionTree(
  unit: BattleAiInput["unit"],
  state: BattleAiInput["state"],
  dt: number,
  desiredRange: number,
  baseTarget: BattleAiInput["baseTarget"],
  battlefield: BattleAiInput["battlefield"],
  canShootAtAngle: BattleAiInput["canShootAtAngle"],
  getEffectiveWeaponRange: BattleAiInput["getEffectiveWeaponRange"],
  getWeaponFireInput: BattleAiInput["getWeaponFireInput"],
): CombatDecision {
  const decision = BASELINE_CONTROLLER.decide({
    unit,
    state,
    dt,
    desiredRange,
    baseTarget,
    battlefield,
    canShootAtAngle,
    getEffectiveWeaponRange,
    getWeaponFireInput,
  });
  return {
    ...decision,
    debug: {
      ...decision.debug,
      decisionPath: `decision-tree-compat > ${decision.debug.decisionPath}`,
    },
  };
}
