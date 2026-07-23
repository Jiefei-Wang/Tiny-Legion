import type { GameBase, MapNode } from "../../types.ts";
import { GAME_CONFIG } from "../generated/game-config.generated.ts";

export function getIncomeAndUpkeep(base: GameBase, nodes: MapNode[]): { income: number; upkeep: number } {
  const config = GAME_CONFIG.balance.economy;
  const income = config.baseIncome + base.refineries * config.refineryIncome;
  const upkeep = nodes.filter((node) => node.garrison).length * config.garrisonUpkeep;
  return { income, upkeep };
}
