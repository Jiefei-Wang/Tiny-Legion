import type { AiFamily, Params } from "../ai-schema.ts";

export const evadeBiasFamily: AiFamily = {
  id: "evade-bias",
  schema: {
    lowIntegrityThreshold: { kind: "number", min: 0.12, max: 0.5, def: 0.24, sigma: 0.06 },
    evadePush: { kind: "number", min: 0.2, max: 1.4, def: 0.9, sigma: 0.2 },
  },
  make: (params: Params) => ({ kind: "evade-bias", params }),
};
