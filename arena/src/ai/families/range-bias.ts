import type { AiFamily, Params } from "../ai-schema.ts";

export const rangeBiasFamily: AiFamily = {
  id: "range-bias",
  schema: {
    rangeFactor: { kind: "number", min: 0.35, max: 1.05, def: 0.72, sigma: 0.08 },
  },
  make: (params: Params) => ({ kind: "range-bias", params }),
};
