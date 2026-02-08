import type { AiFamily, Params } from "../ai-schema.ts";

export const aggressiveRushFamily: AiFamily = {
  id: "aggressive-rush",
  schema: {
    rangeFactor: { kind: "number", min: 0.18, max: 0.95, def: 0.52, sigma: 0.1 },
    forwardBias: { kind: "number", min: 0, max: 1.6, def: 0.7, sigma: 0.18 },
    evadeThreshold: { kind: "number", min: 0.08, max: 0.45, def: 0.18, sigma: 0.05 },
    evadePush: { kind: "number", min: 0, max: 1.5, def: 0.55, sigma: 0.2 },
  },
  make: (params: Params) => ({ kind: "aggressive-rush", params }),
};
