export type ParamKind = "number" | "int" | "boolean";

export type ParamDef =
  | { kind: "number"; min: number; max: number; def: number; sigma: number }
  | { kind: "int"; min: number; max: number; def: number; step: number; mutateRate: number }
  | { kind: "boolean"; def: boolean; mutateRate: number };

export type ParamSchema = Record<string, ParamDef>;
export type Params = Record<string, number | boolean>;

export interface AiFamily {
  id: string;
  schema: ParamSchema;
  make: (params: Params) => unknown; // runtime controller shape handled in match runner
}
