import type { AiFamily, Params } from "../ai-schema.ts";

export const adaptiveKiteFamily: AiFamily = {
  id: "adaptive-kite",
  schema: {
    healthyRangeFactor: { kind: "number", min: 0.65, max: 1.45, def: 1.08, sigma: 0.1 },
    damagedRangeFactor: { kind: "number", min: 0.6, max: 1.8, def: 1.3, sigma: 0.14 },
    integrityPivot: { kind: "number", min: 0.12, max: 0.65, def: 0.36, sigma: 0.07 },
    retreatPush: { kind: "number", min: 0.1, max: 2.1, def: 0.95, sigma: 0.22 },
  },
  make: (params: Params) => ({ kind: "adaptive-kite", params }),
};
