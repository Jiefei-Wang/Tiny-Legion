import type { AiFamily, Params } from "../ai-schema.ts";

export const baselineFamily: AiFamily = {
  id: "baseline",
  schema: {},
  make: (_params: Params) => ({ kind: "baseline" }),
};
