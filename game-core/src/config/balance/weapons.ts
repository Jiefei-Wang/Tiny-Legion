import type { ComponentId, ComponentStats } from "../../types.ts";
import { GAME_CONFIG } from "../generated/game-config.generated.ts";

export const COMPONENTS: Record<ComponentId, ComponentStats> = {
  ...GAME_CONFIG.balance.units.components,
  ...GAME_CONFIG.balance.weapons.components,
} as Record<ComponentId, ComponentStats>;
