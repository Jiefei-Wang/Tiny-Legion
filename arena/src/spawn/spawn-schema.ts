import type { Params, ParamSchema } from "../ai/ai-schema.ts";

export interface SpawnFamily {
  id: string;
  schema: ParamSchema;
  pick: (params: Params, roster: string[], rng: () => number, ctx: { gas: number; capRemaining: number }) => {
    templateId: string | null;
    intervalS: number;
  };
}
