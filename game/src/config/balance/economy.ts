import type { GameBase, MapNode } from "../../types.ts";

export function getIncomeAndUpkeep(base: GameBase, nodes: MapNode[]): { income: number; upkeep: number } {
  const income = 8 + base.refineries * 6;
  const upkeep = nodes.filter((node) => node.garrison).length * 4;
  return { income, upkeep };
}
