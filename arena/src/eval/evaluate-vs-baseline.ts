import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getFamily } from "../ai/families.ts";
import type { Params } from "../ai/ai-schema.ts";
import type { MatchResult, MatchSpec } from "../match/match-types.ts";
import { WorkerPool } from "../lib/worker-pool.ts";
import { aggregateResults, wilsonLowerBound } from "../train/fitness.ts";

function buildSeedList(seed0: number, count: number): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < count; i += 1) {
    seeds.push(seed0 + i * 9973);
  }
  return seeds;
}

function readParams(path: string): Params {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid params JSON at ${path}`);
  }
  return parsed as Params;
}

function readTopParamsFromStore(rootDir: string, aiFamilyId: string): Params {
  const indexPath = resolve(rootDir, ".arena-data", "models", aiFamilyId, "index.json");
  const raw = readFileSync(indexPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`No models in store for ${aiFamilyId} (${indexPath})`);
  }
  const top = parsed[0] as { params?: Params };
  if (!top || !top.params || typeof top.params !== "object") {
    throw new Error(`Invalid top model in store for ${aiFamilyId} (${indexPath})`);
  }
  return top.params;
}

function makeEvalSpecs(
  base: Omit<MatchSpec, "seed" | "aiPlayer" | "aiEnemy">,
  candidateAi: { familyId: string; params: Params },
  seeds: number[],
): MatchSpec[] {
  const baselineAi = { familyId: "baseline", params: {} as Params };
  const specs: MatchSpec[] = [];
  for (const seed of seeds) {
    specs.push({ ...base, seed, aiPlayer: candidateAi, aiEnemy: baselineAi });
    // Mirror sides on identical seed for cleaner side-bias cancellation.
    specs.push({ ...base, seed, aiPlayer: baselineAi, aiEnemy: candidateAi });
  }
  return specs;
}

export async function evaluateVsBaseline(opts: {
  ai: string;
  paramsPath: string | null;
  fromStore: boolean;
  seed0: number;
  seeds: number;
  parallel: number;
  maxSimSeconds: number;
  nodeDefense: number;
  baseHp: number | null;
  playerGas: number;
  enemyGas: number;
  spawnBurst: number;
  spawnMaxActive: number;
  outPath: string | null;
}): Promise<void> {
  const family = getFamily(opts.ai);
  const params = opts.paramsPath
    ? readParams(opts.paramsPath)
    : opts.fromStore
      ? readTopParamsFromStore(process.cwd(), family.id)
      : (() => {
        throw new Error("Provide either --params <path> or --fromStore true");
      })();
  family.make(params);

  const seeds = buildSeedList(opts.seed0, opts.seeds);
  const baseMatch: Omit<MatchSpec, "seed" | "aiPlayer" | "aiEnemy"> = {
    maxSimSeconds: opts.maxSimSeconds,
    nodeDefense: opts.nodeDefense,
    ...(opts.baseHp ? { baseHp: opts.baseHp } : {}),
    playerGas: opts.playerGas,
    enemyGas: opts.enemyGas,
    spawnBurst: opts.spawnBurst,
    spawnMaxActive: opts.spawnMaxActive,
  };
  const specs = makeEvalSpecs(baseMatch, { familyId: family.id, params }, seeds);

  const pool = new WorkerPool(WorkerPool.matchWorkerUrl(), opts.parallel);
  try {
    const results = (await Promise.all(specs.map((s) => pool.run(s)))) as MatchResult[];
    const agg = aggregateResults(results, (r) => (r.spec.aiEnemy.familyId === family.id ? "enemy" : "player"));
    const winRate = agg.games > 0 ? agg.wins / agg.games : 0;
    const lb = wilsonLowerBound(agg.wins, agg.games);
    const summary = {
      aiFamilyId: family.id,
      params,
      games: agg.games,
      wins: agg.wins,
      ties: agg.ties,
      losses: agg.losses,
      winRate,
      winRateLowerBound95: lb,
      avgGasWorthDelta: agg.avgGasWorthDelta,
      meanScore: agg.score,
      config: {
        seed0: opts.seed0,
        seeds: opts.seeds,
        parallel: opts.parallel,
        maxSimSeconds: opts.maxSimSeconds,
        nodeDefense: opts.nodeDefense,
        baseHp: opts.baseHp,
        playerGas: opts.playerGas,
        enemyGas: opts.enemyGas,
        spawnBurst: opts.spawnBurst,
        spawnMaxActive: opts.spawnMaxActive,
      },
    };

    if (opts.outPath) {
      const full = resolve(process.cwd(), opts.outPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, JSON.stringify(summary, null, 2), "utf8");
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.close();
  }
}
