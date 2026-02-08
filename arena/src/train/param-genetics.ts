import type { Params, ParamSchema } from "../ai/ai-schema.ts";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function randn(): number {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = Math.random();
  }
  while (v === 0) {
    v = Math.random();
  }
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function defaultParams(schema: ParamSchema): Params {
  const out: Params = {};
  for (const [k, def] of Object.entries(schema)) {
    out[k] = def.kind === "boolean" ? def.def : def.def;
  }
  return out;
}

export function randomParams(schema: ParamSchema): Params {
  const out: Params = {};
  for (const [k, def] of Object.entries(schema)) {
    if (def.kind === "boolean") {
      out[k] = Math.random() < 0.5 ? def.def : !def.def;
      continue;
    }
    if (def.kind === "int") {
      const span = def.max - def.min;
      const steps = Math.max(1, Math.floor(span / Math.max(1, def.step)));
      const pick = def.min + Math.floor(Math.random() * (steps + 1)) * def.step;
      out[k] = clamp(pick, def.min, def.max);
      continue;
    }
    const pick = def.min + Math.random() * (def.max - def.min);
    out[k] = clamp(pick, def.min, def.max);
  }
  return out;
}

export function mutate(schema: ParamSchema, params: Params): Params {
  const out: Params = { ...params };
  for (const [k, def] of Object.entries(schema)) {
    const cur = out[k];
    if (def.kind === "boolean") {
      if (Math.random() < def.mutateRate) {
        out[k] = !Boolean(cur);
      }
      continue;
    }
    if (def.kind === "int") {
      if (Math.random() < def.mutateRate) {
        const direction = Math.random() < 0.5 ? -1 : 1;
        const next = (typeof cur === "number" ? cur : def.def) + direction * def.step;
        out[k] = clamp(Math.round(next), def.min, def.max);
      }
      continue;
    }
    const curN = typeof cur === "number" ? cur : def.def;
    const next = curN + randn() * def.sigma;
    out[k] = clamp(next, def.min, def.max);
  }
  return out;
}

export function crossover(a: Params, b: Params): Params {
  const out: Params = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    out[k] = Math.random() < 0.5 ? (a[k] as any) : (b[k] as any);
  }
  return out;
}
