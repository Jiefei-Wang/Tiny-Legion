import type { SpawnFamily } from "../spawn-schema.ts";

export const spawnBaseline: SpawnFamily = {
  id: "spawn-baseline",
  schema: {
    intervalS: { kind: "number", min: 0.7, max: 4.0, def: 1.8, sigma: 0.2 },
    minGasReserve: { kind: "number", min: 0, max: 2000, def: 40, sigma: 80 },
  },
  pick: (params, roster, rng, ctx) => {
    const intervalS = typeof params.intervalS === "number" ? params.intervalS : 1.8;
    const reserve = typeof params.minGasReserve === "number" ? params.minGasReserve : 40;
    if (ctx.capRemaining <= 0 || ctx.gas < reserve || roster.length === 0) {
      return { templateId: null, intervalS };
    }
    const idx = Math.floor(rng() * roster.length);
    return { templateId: roster[Math.max(0, Math.min(roster.length - 1, idx))] ?? null, intervalS };
  },
};
