import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getFamily } from "../ai/families.ts";
import type { Params } from "../ai/ai-schema.ts";
import type { MatchResult, MatchSpec } from "../match/match-types.ts";
import { WorkerPool } from "../lib/worker-pool.ts";
import { aggregateResults, wilsonLowerBound } from "./fitness.ts";
import { crossover, defaultParams, mutate, randomParams } from "./param-genetics.ts";
import { ModelStore, type StoredModel } from "./model-store.ts";

type Candidate = { params: Params; score: number; wins: number; games: number; wl: number; avgGas: number };

function pct01(n: number): string {
  const v = Math.max(0, Math.min(1, n));
  return `${(v * 100).toFixed(1)}%`;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) {
    return "0";
  }
  const abs = Math.abs(n);
  if (abs >= 1000) {
    return n.toFixed(0);
  }
  if (abs >= 10) {
    return n.toFixed(1);
  }
  return n.toFixed(2);
}

function isoNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function buildSeedList(seed0: number, count: number): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < count; i += 1) {
    seeds.push(seed0 + i * 9973);
  }
  return seeds;
}

function makeEvalSpecs(base: Omit<MatchSpec, "seed" | "aiPlayer" | "aiEnemy">, candidateAi: { familyId: string; params: Params }, baselineAi: { familyId: string; params: Params }, seeds: number[]): MatchSpec[] {
  const specs: MatchSpec[] = [];
  for (const seed of seeds) {
    // candidate as player
    specs.push({ ...base, seed, aiPlayer: candidateAi, aiEnemy: baselineAi });
    // candidate as enemy (swap)
    specs.push({ ...base, seed: seed + 1_000_000, aiPlayer: baselineAi, aiEnemy: candidateAi });
  }
  return specs;
}

export async function runTraining(opts: {
  ai: string;
  seed0: number;
  seeds: number;
  generations: number;
  population: number;
  parallel: number;
  maxSimSeconds: number;
  nodeDefense: number;
  baseHp: number | null;
  playerGas: number;
  enemyGas: number;
  maxModels: number;
}): Promise<void> {
  const family = getFamily(opts.ai);
  if (family.id === "baseline") {
    throw new Error("Refusing to train baseline AI");
  }

  const runId = `${family.id}-${isoNow()}`;
  const dataRoot = resolve(process.cwd(), ".arena-data");
  const runDir = resolve(dataRoot, "runs", runId);
  ensureDir(runDir);

  const store = new ModelStore(dataRoot, family.id, opts.maxModels);
  const baselineAi = { familyId: "baseline", params: {} as Params };

  const seeds = buildSeedList(opts.seed0, opts.seeds);
  const baseMatch: Omit<MatchSpec, "seed" | "aiPlayer" | "aiEnemy"> = {
    maxSimSeconds: opts.maxSimSeconds,
    nodeDefense: opts.nodeDefense,
    ...(opts.baseHp ? { baseHp: opts.baseHp } : {}),
    playerGas: opts.playerGas,
    enemyGas: opts.enemyGas,
  };

  const pool = new WorkerPool(WorkerPool.matchWorkerUrl(), opts.parallel);
  try {
    // init population
    const pop: Params[] = [];
    pop.push(defaultParams(family.schema));
    while (pop.length < opts.population) {
      pop.push(randomParams(family.schema));
    }

    let best: StoredModel | null = null;
    for (let gen = 0; gen < opts.generations; gen += 1) {
      const totalMatches = opts.population * opts.seeds * 2;
      let doneMatches = 0;
      let lastProgressAt = Date.now();
      const evaluated: Candidate[] = [];
      for (const params of pop) {
        family.make(params);
        const candidateAi = { familyId: family.id, params };
        const specs = makeEvalSpecs(baseMatch, candidateAi, baselineAi, seeds);
        const results = (await Promise.all(
          specs.map((s) =>
            pool.run(s).then((r) => {
              doneMatches += 1;
              const now = Date.now();
              if (now - lastProgressAt > 900) {
                lastProgressAt = now;
                // eslint-disable-next-line no-console
                console.log(`[train] ${family.id} gen=${gen} progress=${doneMatches}/${totalMatches} (${pct01(doneMatches / totalMatches)})`);
              }
              return r;
            }),
          ),
        )) as MatchResult[];

        const agg = aggregateResults(results, (r) => {
          const isCandidateEnemy = r.spec.aiEnemy.familyId === family.id;
          return isCandidateEnemy ? "enemy" : "player";
        });
        const winRate = agg.games > 0 ? agg.wins / agg.games : 0;
        const lb = wilsonLowerBound(agg.wins, agg.games);
        evaluated.push({ params, score: agg.score, wins: agg.wins, games: agg.games, wl: lb, avgGas: agg.avgGasWorthDelta });

        const model: StoredModel = {
          id: `${runId}-g${gen}-${Math.random().toString(16).slice(2)}`,
          aiFamilyId: family.id,
          params,
          score: agg.score,
          winRate,
          winRateLowerBound: lb,
          avgGasWorthDelta: agg.avgGasWorthDelta,
          createdAt: new Date().toISOString(),
          generation: gen,
          runId,
        };
        if (!best || model.score > best.score) {
          best = model;
          writeFileSync(resolve(runDir, "best.json"), JSON.stringify(best, null, 2), "utf8");
        }
      }

      evaluated.sort((a, b) => b.score - a.score);

      const top = evaluated.slice(0, 3);
      // eslint-disable-next-line no-console
      console.log(`[train] ${family.id} gen=${gen} top3:`);
      for (let i = 0; i < top.length; i += 1) {
        const e = top[i];
        const wr = e.games > 0 ? e.wins / e.games : 0;
        // eslint-disable-next-line no-console
        console.log(
          `  #${i + 1} score=${fmt(e.score)} wins=${e.wins}/${e.games} winRate=${pct01(wr)} lb=${pct01(e.wl)} avgGasWorthDelta=${fmt(e.avgGas)}`,
        );
      }

      const elites = evaluated.slice(0, Math.max(2, Math.floor(opts.population * 0.2)));
      const next: Params[] = [];
      for (const elite of elites) {
        next.push(elite.params);
      }
      while (next.length < opts.population) {
        const a = elites[Math.floor(Math.random() * elites.length)]?.params ?? elites[0].params;
        const b = elites[Math.floor(Math.random() * elites.length)]?.params ?? elites[0].params;
        const child = mutate(family.schema, crossover(a, b));
        next.push(child);
      }
      pop.splice(0, pop.length, ...next);

      // Update persistent best-of store.
      const existing = store.load();
      const merged = best ? [...existing, best] : existing;
      store.save(merged);

      const promoted = best ? best.winRateLowerBound >= 0.8 : false;
      const line = {
        generation: gen,
        bestScore: best?.score ?? null,
        bestWinRate: best?.winRate ?? null,
        bestWinRateLowerBound: best?.winRateLowerBound ?? null,
        bestAvgGasWorthDelta: best?.avgGasWorthDelta ?? null,
        promoted,
      };
      writeFileSync(resolve(runDir, `gen-${gen}.json`), JSON.stringify(line, null, 2), "utf8");
      // eslint-disable-next-line no-console
      console.log(`[train] ${family.id} gen=${gen} bestScore=${(best?.score ?? 0).toFixed(2)} winRate=${((best?.winRate ?? 0) * 100).toFixed(1)}% lb=${((best?.winRateLowerBound ?? 0) * 100).toFixed(1)}% promoted=${promoted}`);
    }
  } finally {
    await pool.close();
  }
}
