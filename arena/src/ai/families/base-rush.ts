import type { AiFamily, Params } from "../ai-schema.ts";

export const baseRushFamily: AiFamily = {
  id: "base-rush",
  schema: {
    rangeFactor: { kind: "number", min: 0.1, max: 0.9, def: 0.35, sigma: 0.1 },
    basePush: { kind: "number", min: 0.1, max: 2.2, def: 1.1, sigma: 0.22 },
    yBias: { kind: "number", min: -0.8, max: 0.8, def: 0, sigma: 0.12 },
  },
  make: (params: Params) => ({ kind: "base-rush", params }),
};
