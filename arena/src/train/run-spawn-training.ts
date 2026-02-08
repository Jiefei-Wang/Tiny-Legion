import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Params } from "../ai/ai-schema.ts";
import type { MatchResult, MatchSpec } from "../match/match-types.ts";
import { WorkerPool } from "../lib/worker-pool.ts";
import { aggregateResults, wilsonLowerBound } from "./fitness.ts";
import { crossover, defaultParams, mutate, randomParams } from "./param-genetics.ts";
import { ModelStore, type StoredModel } from "./model-store.ts";
import { getSpawnFamily } from "../spawn/families.ts";
import { loadBestParamsFromStore } from "./load-best-model.ts";

type Candidate = { params: Params; score: number; wins: number; games: number; wl: number; avgGas: number };

function isBetterCandidate(a: Candidate | null, b: Candidate): boolean {
  if (!a) {
    return true;
  }
  if (b.wl !== a.wl) {
    return b.wl > a.wl;
  }
  const aw = a.games > 0 ? a.wins / a.games : 0;
  const bw = b.games > 0 ? b.wins / b.games : 0;
  if (bw !== aw) {
    return bw > aw;
  }
  return b.score > a.score;
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

function makeEvalSpecs(
  base: Omit<MatchSpec, "seed" | "aiPlayer" | "aiEnemy" | "spawnMode" | "spawnPlayer" | "spawnEnemy">,
  micro: { familyId: string; params: Params },
  candidateSpawn: { familyId: string; params: Params },
  baselineSpawn: { familyId: string; params: Params },
  seeds: number[],
): MatchSpec[] {
  const specs: MatchSpec[] = [];
  for (const seed of seeds) {
    // candidate spawn as player
    specs.push({
      ...base,
      seed,
      aiPlayer: micro,
      aiEnemy: micro,
      spawnMode: "ai",
      spawnPlayer: candidateSpawn,
      spawnEnemy: baselineSpawn,
    });
    // candidate spawn as enemy (swap)
    specs.push({
      ...base,
      seed,
      aiPlayer: micro,
      aiEnemy: micro,
      spawnMode: "ai",
      spawnPlayer: baselineSpawn,
      spawnEnemy: candidateSpawn,
    });
  }
  return specs;
}

export async function runSpawnTraining(opts: {
  spawnAi: string;
  microFamily: string;
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
  spawnBurst: number;
  spawnMaxActive: number;
  maxModels: number;
  quiet?: boolean;
}): Promise<void> {
  const spawnFamily = getSpawnFamily(opts.spawnAi);

  // Validate micro exists.
  const microParams = opts.microFamily === "baseline" ? ({} as Params) : loadBestParamsFromStore(opts.microFamily);
  const micro = { familyId: opts.microFamily, params: microParams };

  const runId = `spawn-${spawnFamily.id}-with-${opts.microFamily}-${isoNow()}`;
  const dataRoot = resolve(process.cwd(), ".arena-data");
  const runDir = resolve(dataRoot, "runs", runId);
  ensureDir(runDir);

  const store = new ModelStore(dataRoot, `spawn-${spawnFamily.id}`, opts.maxModels);
  const baselineSpawn = { familyId: "spawn-baseline", params: defaultParams(getSpawnFamily("spawn-baseline").schema) };
  const seeds = buildSeedList(opts.seed0, opts.seeds);

  const baseMatch: Omit<MatchSpec, "seed" | "aiPlayer" | "aiEnemy" | "spawnMode" | "spawnPlayer" | "spawnEnemy"> = {
    maxSimSeconds: opts.maxSimSeconds,
    nodeDefense: opts.nodeDefense,
    ...(opts.baseHp ? { baseHp: opts.baseHp } : {}),
    playerGas: opts.playerGas,
    enemyGas: opts.enemyGas,
    spawnBurst: opts.spawnBurst,
    spawnMaxActive: opts.spawnMaxActive,
  };

  const pool = new WorkerPool(WorkerPool.matchWorkerUrl(), opts.parallel);
  try {
    const pop: Params[] = [];
    pop.push(defaultParams(spawnFamily.schema));
    while (pop.length < opts.population) {
      pop.push(randomParams(spawnFamily.schema));
    }

    let best: StoredModel | null = null;
    let bestCandidate: Candidate | null = null;
    for (let gen = 0; gen < opts.generations; gen += 1) {
      const evaluated: Candidate[] = [];
      for (const params of pop) {
        const candidateSpawn = { familyId: spawnFamily.id, params };
        const specs = makeEvalSpecs(baseMatch, micro, candidateSpawn, baselineSpawn, seeds);
        const results = (await Promise.all(specs.map((s) => pool.run(s)))) as MatchResult[];
        const agg = aggregateResults(results, (r) => {
          const isCandidateEnemy = r.spec.spawnEnemy?.familyId === spawnFamily.id;
          return isCandidateEnemy ? "enemy" : "player";
        });
        const winRate = agg.games > 0 ? agg.wins / agg.games : 0;
        const lb = wilsonLowerBound(agg.wins, agg.games);
        evaluated.push({ params, score: agg.score, wins: agg.wins, games: agg.games, wl: lb, avgGas: agg.avgGasWorthDelta });

        const model: StoredModel = {
          id: `${runId}-g${gen}-${Math.random().toString(16).slice(2)}`,
          aiFamilyId: `spawn-${spawnFamily.id}`,
          params,
          score: agg.score,
          winRate,
          winRateLowerBound: lb,
          avgGasWorthDelta: agg.avgGasWorthDelta,
          createdAt: new Date().toISOString(),
          generation: gen,
          runId,
        };
        const candidate: Candidate = { params, score: agg.score, wins: agg.wins, games: agg.games, wl: lb, avgGas: agg.avgGasWorthDelta };
        if (isBetterCandidate(bestCandidate, candidate)) {
          bestCandidate = candidate;
          best = model;
          writeFileSync(resolve(runDir, "best.json"), JSON.stringify(best, null, 2), "utf8");
        }
      }

      evaluated.sort((a, b) => {
        if (b.wl !== a.wl) {
          return b.wl - a.wl;
        }
        const aw = a.games > 0 ? a.wins / a.games : 0;
        const bw = b.games > 0 ? b.wins / b.games : 0;
        if (bw !== aw) {
          return bw - aw;
        }
        return b.score - a.score;
      });
      const elites = evaluated.slice(0, Math.max(2, Math.floor(opts.population * 0.2)));
      const next: Params[] = [];
      for (const elite of elites) {
        next.push(elite.params);
      }
      while (next.length < opts.population) {
        const a = elites[Math.floor(Math.random() * elites.length)]?.params ?? elites[0].params;
        const b = elites[Math.floor(Math.random() * elites.length)]?.params ?? elites[0].params;
        next.push(mutate(spawnFamily.schema, crossover(a, b)));
      }
      pop.splice(0, pop.length, ...next);

      const existing = store.load();
      const merged = best ? [...existing, best] : existing;
      store.save(merged);

      const promoted = best ? best.winRateLowerBound >= 0.8 : false;
      writeFileSync(
        resolve(runDir, `gen-${gen}.json`),
        JSON.stringify(
          {
            generation: gen,
            bestScore: best?.score ?? null,
            bestWinRate: best?.winRate ?? null,
            bestWinRateLowerBound: best?.winRateLowerBound ?? null,
            bestAvgGasWorthDelta: best?.avgGasWorthDelta ?? null,
            promoted,
            frozenMicroFamily: opts.microFamily,
          },
          null,
          2,
        ),
        "utf8",
      );
      if (!opts.quiet) {
        // eslint-disable-next-line no-console
        console.log(
          `[train-spawn] ${spawnFamily.id} with micro=${opts.microFamily} gen=${gen} bestScore=${(best?.score ?? 0).toFixed(2)} winRate=${((best?.winRate ?? 0) * 100).toFixed(1)}% lb=${((best?.winRateLowerBound ?? 0) * 100).toFixed(1)}% promoted=${promoted}`,
        );
      }
    }
  } finally {
    await pool.close();
  }
}
