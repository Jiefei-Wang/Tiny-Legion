import type { SpawnFamily } from "../spawn-schema.ts";

function pickWeighted(rng: () => number, items: Array<{ id: string; w: number }>): string | null {
  const total = items.reduce((acc, it) => acc + Math.max(0, it.w), 0);
  if (total <= 0) {
    return items.length > 0 ? items[Math.floor(rng() * items.length)]?.id ?? null : null;
  }
  let r = rng() * total;
  for (const it of items) {
    r -= Math.max(0, it.w);
    if (r <= 0) {
      return it.id;
    }
  }
  return items.at(-1)?.id ?? null;
}

export const spawnWeighted: SpawnFamily = {
  id: "spawn-weighted",
  schema: {
    intervalS: { kind: "number", min: 0.6, max: 3.6, def: 1.6, sigma: 0.25 },
    minGasReserve: { kind: "number", min: 0, max: 4000, def: 120, sigma: 140 },
    wScout: { kind: "number", min: 0, max: 5, def: 1, sigma: 0.6 },
    wTank: { kind: "number", min: 0, max: 5, def: 1, sigma: 0.6 },
    wAir: { kind: "number", min: 0, max: 5, def: 1, sigma: 0.6 },
  },
  pick: (params, roster, rng, ctx) => {
    const intervalS = typeof params.intervalS === "number" ? params.intervalS : 1.6;
    const reserve = typeof params.minGasReserve === "number" ? params.minGasReserve : 120;
    if (ctx.capRemaining <= 0 || ctx.gas < reserve || roster.length === 0) {
      return { templateId: null, intervalS };
    }

    const wScout = typeof params.wScout === "number" ? params.wScout : 1;
    const wTank = typeof params.wTank === "number" ? params.wTank : 1;
    const wAir = typeof params.wAir === "number" ? params.wAir : 1;

    const items: Array<{ id: string; w: number }> = [];
    for (const id of roster) {
      const w = id.includes("scout") ? wScout : id.includes("tank") ? wTank : id.includes("air") ? wAir : 1;
      items.push({ id, w });
    }
    return { templateId: pickWeighted(rng, items), intervalS };
  },
};
