import type { AiFamily, Params } from "../ai-schema.ts";

export const neuralLinearFamily: AiFamily = {
  id: "neural-linear",
  schema: {
    // 6-feature linear head for desired range scaling.
    wr0: { kind: "number", min: -3, max: 3, def: 0.2, sigma: 0.35 },
    wr1: { kind: "number", min: -3, max: 3, def: 0.4, sigma: 0.35 },
    wr2: { kind: "number", min: -3, max: 3, def: -0.3, sigma: 0.35 },
    wr3: { kind: "number", min: -3, max: 3, def: 0.1, sigma: 0.35 },
    wr4: { kind: "number", min: -3, max: 3, def: -0.2, sigma: 0.35 },
    wr5: { kind: "number", min: -3, max: 3, def: 0.15, sigma: 0.35 },
    br: { kind: "number", min: -2, max: 2, def: 0.0, sigma: 0.25 },
    // 6-feature linear head for retreat tendency.
    we0: { kind: "number", min: -3, max: 3, def: -0.3, sigma: 0.35 },
    we1: { kind: "number", min: -3, max: 3, def: 0.25, sigma: 0.35 },
    we2: { kind: "number", min: -3, max: 3, def: 0.45, sigma: 0.35 },
    we3: { kind: "number", min: -3, max: 3, def: -0.15, sigma: 0.35 },
    we4: { kind: "number", min: -3, max: 3, def: 0.2, sigma: 0.35 },
    we5: { kind: "number", min: -3, max: 3, def: 0.05, sigma: 0.35 },
    be: { kind: "number", min: -2, max: 2, def: 0.0, sigma: 0.25 },
    retreatScale: { kind: "number", min: 0.1, max: 2.6, def: 1.0, sigma: 0.22 },
  },
  make: (params: Params) => ({ kind: "neural-linear", params }),
};
