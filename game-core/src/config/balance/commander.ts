import { GAME_CONFIG } from "../generated/game-config.generated.ts";

export function armyCap(commanderSkill: number): number {
  const config = GAME_CONFIG.balance.commander.armyCap;
  return config.base + Math.floor(commanderSkill / config.skillPerAdditionalUnit);
}
