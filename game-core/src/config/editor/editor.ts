import { GAME_CONFIG } from "../generated/game-config.generated.ts";

export const EDITOR_CONFIG = GAME_CONFIG.editor.editor;
export const EDITOR_GRID_MAX_COLS: number = EDITOR_CONFIG.grid.maxColumns;
export const EDITOR_GRID_MAX_ROWS: number = EDITOR_CONFIG.grid.maxRows;
