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
    affordabilityBias: { kind: "number", min: 0, max: 5, def: 1, sigma: 0.6 },
    durabilityBias: { kind: "number", min: 0, max: 5, def: 1, sigma: 0.6 },
    weaponBias: { kind: "number", min: 0, max: 5, def: 1, sigma: 0.6 },
    airBias: { kind: "number", min: 0, max: 5, def: 1, sigma: 0.6 },
  },
  pick: (params, roster, rng, ctx) => {
    const intervalS = typeof params.intervalS === "number" ? params.intervalS : 1.6;
    const reserve = typeof params.minGasReserve === "number" ? params.minGasReserve : 120;
    if (ctx.capRemaining <= 0 || ctx.gas < reserve || roster.length === 0) {
      return { templateId: null, intervalS };
    }

    const affordabilityBias = typeof params.affordabilityBias === "number" ? params.affordabilityBias : 1;
    const durabilityBias = typeof params.durabilityBias === "number" ? params.durabilityBias : 1;
    const weaponBias = typeof params.weaponBias === "number" ? params.weaponBias : 1;
    const airBias = typeof params.airBias === "number" ? params.airBias : 1;
    const maxCost = Math.max(1, ...roster.map((entry) => entry.gasCost));
    const maxStructure = Math.max(1, ...roster.map((entry) => entry.structureCells));
    const maxWeapons = Math.max(1, ...roster.map((entry) => entry.weaponCount));

    const items: Array<{ id: string; w: number }> = [];
    for (const entry of roster) {
      const affordability = 1 - entry.gasCost / maxCost;
      const durability = entry.structureCells / maxStructure;
      const weaponCapacity = entry.weaponCount / maxWeapons;
      const airCapability = entry.unitType === "air" ? 1 : 0;
      const weight = 1
        + affordabilityBias * affordability
        + durabilityBias * durability
        + weaponBias * weaponCapacity
        + airBias * airCapability;
      items.push({ id: entry.templateId, w: weight });
    }
    return { templateId: pickWeighted(rng, items), intervalS };
  },
};
