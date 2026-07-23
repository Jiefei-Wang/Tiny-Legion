import { GAME_CONFIG } from "../generated/game-config.generated.ts";

export const BATTLE_DISPLAY_CONFIG = GAME_CONFIG.display.battle;
export const MIN_BATTLE_VIEW_SCALE: number = BATTLE_DISPLAY_CONFIG.view.minScale;
export const MAX_BATTLE_VIEW_SCALE: number = BATTLE_DISPLAY_CONFIG.view.maxScale;
export const DEFAULT_BATTLE_VERTICAL_PADDING: number = BATTLE_DISPLAY_CONFIG.view.verticalPadding;
