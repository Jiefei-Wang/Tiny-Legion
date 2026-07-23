import type { MaterialId, MaterialStats } from "../../types.ts";
import { GAME_CONFIG } from "../generated/game-config.generated.ts";

export const MATERIALS: Record<MaterialId, MaterialStats> = GAME_CONFIG.balance.materials.materials;
