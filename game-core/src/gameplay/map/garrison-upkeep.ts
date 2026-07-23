import { getIncomeAndUpkeep } from "../../config/balance/economy.ts";
import type { GameBase, MapNode } from "../../types.ts";

export function applyStrategicEconomyTick(gas: number, base: GameBase, nodes: MapNode[]): number {
  const economy = getIncomeAndUpkeep(base, nodes);
  return Math.max(0, gas + economy.income - economy.upkeep);
}
