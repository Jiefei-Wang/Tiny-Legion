import { baselineFamily } from "./families/baseline.ts";
import { rangeBiasFamily } from "./families/range-bias.ts";
import { evadeBiasFamily } from "./families/evade-bias.ts";
import { aggressiveRushFamily } from "./families/aggressive-rush.ts";
import { adaptiveKiteFamily } from "./families/adaptive-kite.ts";
import { neuralLinearFamily } from "./families/neural-linear.ts";
import { baseRushFamily } from "./families/base-rush.ts";
import type { AiFamily } from "./ai-schema.ts";

export const AI_FAMILIES: AiFamily[] = [
  baselineFamily,
  rangeBiasFamily,
  evadeBiasFamily,
  aggressiveRushFamily,
  adaptiveKiteFamily,
  neuralLinearFamily,
  baseRushFamily,
];

export function getFamily(id: string): AiFamily {
  const found = AI_FAMILIES.find((f) => f.id === id);
  if (!found) {
    throw new Error(`Unknown AI family: ${id}`);
  }
  return found;
}
