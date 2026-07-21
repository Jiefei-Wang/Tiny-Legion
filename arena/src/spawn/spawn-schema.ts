import type { Params, ParamSchema } from "../ai/ai-schema.ts";

export interface SpawnRosterEntry {
  templateId: string;
  gasCost: number;
  unitType: "ground" | "air";
  structureCells: number;
  weaponCount: number;
}

export interface SpawnFamily {
  id: string;
  schema: ParamSchema;
  pick: (params: Params, roster: SpawnRosterEntry[], rng: () => number, ctx: { gas: number; capRemaining: number }) => {
    templateId: string | null;
    intervalS: number;
  };
}
