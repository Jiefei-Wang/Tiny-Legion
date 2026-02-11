import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Params } from "../ai/ai-schema.ts";
import { getModuleSchema, type CompositeModuleSpec, baselineCompositeConfig } from "../ai/composite-controller.ts";
import type { MatchResult, MatchSpec } from "../match/match-types.ts";
import { WorkerPool } from "../lib/worker-pool.ts";
import { aggregateResults, wilsonLowerBound } from "./fitness.ts";
import { crossover, defaultParams, mutate, randomParams } from "./param-genetics.ts";

type ModuleKind = "shoot" | "movement" | "target";
type TrainScope = ModuleKind | "all";
type ModuleSourceArg = "baseline" | "new" | `trained:${string}`;

type Candidate = {
  params: Params;
  score: number;
  wins: number;
  games: number;
  wl: number;
  avgGas: number;
};

type PhaseDef = {
  id: string;
  withBase: boolean;
  initialUnitsPerSide: number;
  seeds: number;
};

type CompositeSnapshot = {
  target: CompositeModuleSpec;
  movement: CompositeModuleSpec;
  shoot: CompositeModuleSpec;
};

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function isoNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildSeedList(seed0: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(seed0 + i * 9973);
  }
  return out;
}

function familyIdFor(kind: ModuleKind): string {
  if (kind === "shoot") return "dt-shoot";
  if (kind === "movement") return "dt-movement";
  return "dt-target";
}

function defaultPhaseDefs(nUnits: number, phaseSeeds: number): Record<ModuleKind, PhaseDef[]> {
  return {
    shoot: [
      { id: "p1-no-base-1v1", withBase: false, initialUnitsPerSide: 1, seeds: phaseSeeds },
      { id: "p2-no-base-nvn", withBase: false, initialUnitsPerSide: nUnits, seeds: phaseSeeds },
      { id: "p3-battlefield-base", withBase: true, initialUnitsPerSide: nUnits, seeds: phaseSeeds },
    ],
    movement: [
      { id: "p1-no-base-1v1", withBase: false, initialUnitsPerSide: 1, seeds: phaseSeeds },
      { id: "p2-no-base-nvn", withBase: false, initialUnitsPerSide: nUnits, seeds: phaseSeeds },
      { id: "p3-battlefield-base", withBase: true, initialUnitsPerSide: nUnits, seeds: phaseSeeds },
    ],
    target: [
      { id: "p2-no-base-nvn", withBase: false, initialUnitsPerSide: nUnits, seeds: phaseSeeds },
      { id: "p3-battlefield-base", withBase: true, initialUnitsPerSide: nUnits, seeds: phaseSeeds },
    ],
  };
}

function aiSpecFromModules(modules: CompositeSnapshot): MatchSpec["aiPlayer"] {
  return {
    familyId: "composite",
    params: {},
    composite: {
      target: modules.target,
      movement: modules.movement,
      shoot: modules.shoot,
    },
  };
}

function parseModuleSpecFile(path: string, moduleKind: ModuleKind): CompositeModuleSpec {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid trained AI file: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.familyId === "composite" && obj.composite && typeof obj.composite === "object") {
    const comp = obj.composite as Record<string, unknown>;
    const moduleObj = comp[moduleKind];
    if (!moduleObj || typeof moduleObj !== "object") {
      throw new Error(`Composite spec in ${path} missing module ${moduleKind}`);
    }
    const m = moduleObj as Record<string, unknown>;
    const familyId = typeof m.familyId === "string" ? m.familyId : "";
    const params = (m.params && typeof m.params === "object") ? (m.params as Params) : {};
    if (!familyId) {
      throw new Error(`Composite spec in ${path} has invalid ${moduleKind}.familyId`);
    }
    return { familyId, params };
  }
  const familyId = typeof obj.familyId === "string" ? obj.familyId : "";
  const params = (obj.params && typeof obj.params === "object") ? (obj.params as Params) : {};
  if (!familyId) {
    throw new Error(`Invalid module spec file: ${path}`);
  }
  return { familyId, params };
}

function resolveSource(
  moduleKind: ModuleKind,
  source: ModuleSourceArg,
): CompositeModuleSpec {
  if (source === "baseline") {
    return baselineCompositeConfig()[moduleKind];
  }
  if (source === "new") {
    const schema = getModuleSchema(moduleKind);
    return {
      familyId: familyIdFor(moduleKind),
      params: defaultParams(schema),
    };
  }
  const trainedPath = source.slice("trained:".length);
  return parseModuleSpecFile(resolve(process.cwd(), trainedPath), moduleKind);
}

function makeEvalSpecs(
  base: Omit<MatchSpec, "seed" | "aiPlayer" | "aiEnemy">,
  candidateModules: CompositeSnapshot,
  baselineModules: CompositeSnapshot,
  seeds: number[],
): MatchSpec[] {
  const candidateAi = aiSpecFromModules(candidateModules);
  const baselineAi = aiSpecFromModules(baselineModules);
  const specs: MatchSpec[] = [];
  for (const seed of seeds) {
    specs.push({ ...base, seed, aiPlayer: candidateAi, aiEnemy: baselineAi });
    specs.push({ ...base, seed, aiPlayer: baselineAi, aiEnemy: candidateAi });
  }
  return specs;
}

function withCandidate(base: CompositeSnapshot, kind: ModuleKind, params: Params): CompositeSnapshot {
  if (kind === "shoot") {
    return { ...base, shoot: { familyId: familyIdFor(kind), params } };
  }
  if (kind === "movement") {
    return { ...base, movement: { familyId: familyIdFor(kind), params } };
  }
  return { ...base, target: { familyId: familyIdFor(kind), params } };
}

export async function runCompositeTraining(opts: {
  seed0: number;
  phaseSeeds: number;
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
  nUnits: number;
  scope?: TrainScope;
  seedCompositePath?: string | null;
  targetSource?: ModuleSourceArg;
  movementSource?: ModuleSourceArg;
  shootSource?: ModuleSourceArg;
  quiet?: boolean;
}): Promise<void> {
  const scope: TrainScope = opts.scope ?? "all";
  const order: ModuleKind[] = scope === "all" ? ["shoot", "movement", "target"] : [scope];

  let best: CompositeSnapshot = baselineCompositeConfig();
  if (opts.seedCompositePath) {
    best.target = parseModuleSpecFile(resolve(process.cwd(), opts.seedCompositePath), "target");
    best.movement = parseModuleSpecFile(resolve(process.cwd(), opts.seedCompositePath), "movement");
    best.shoot = parseModuleSpecFile(resolve(process.cwd(), opts.seedCompositePath), "shoot");
  }

  best.target = resolveSource("target", opts.targetSource ?? "baseline");
  best.movement = resolveSource("movement", opts.movementSource ?? "baseline");
  best.shoot = resolveSource("shoot", opts.shootSource ?? "baseline");

  const normalizeName = (familyId: string): string => {
    const normalized = familyId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized || "unknown";
  };
  const runId = `${normalizeName(best.target.familyId)}-${normalizeName(best.movement.familyId)}-${normalizeName(best.shoot.familyId)}-${isoNow()}`;
  const dataRoot = resolve(process.cwd(), ".arena-data");
  const runDir = resolve(dataRoot, "runs", runId);
  ensureDir(runDir);

  const phases = defaultPhaseDefs(opts.nUnits, opts.phaseSeeds);
  const pool = new WorkerPool(WorkerPool.matchWorkerUrl(), opts.parallel);
  try {
    for (const moduleKind of order) {
      const schema = getModuleSchema(moduleKind);
      let currentBestParams = best[moduleKind].familyId === familyIdFor(moduleKind)
        ? best[moduleKind].params
        : defaultParams(schema);

      for (const phase of phases[moduleKind]) {
        const phaseDir = resolve(runDir, moduleKind, phase.id);
        ensureDir(phaseDir);

        const baseMatch: Omit<MatchSpec, "seed" | "aiPlayer" | "aiEnemy"> = {
          maxSimSeconds: opts.maxSimSeconds,
          nodeDefense: opts.nodeDefense,
          ...(opts.baseHp ? { baseHp: opts.baseHp } : {}),
          playerGas: opts.playerGas,
          enemyGas: opts.enemyGas,
          spawnBurst: opts.spawnBurst,
          spawnMaxActive: opts.spawnMaxActive,
          scenario: {
            withBase: phase.withBase,
            initialUnitsPerSide: phase.initialUnitsPerSide,
          },
        };

        const seeds = buildSeedList(opts.seed0, phase.seeds);
        const pop: Params[] = [currentBestParams];
        while (pop.length < opts.population) {
          pop.push(randomParams(schema));
        }

        let bestCandidate: Candidate | null = null;
        for (let gen = 0; gen < opts.generations; gen += 1) {
          const evaluated: Candidate[] = [];
          for (const params of pop) {
            const candidateModules = withCandidate(best, moduleKind, params);
            const baselineModules = best;
            const specs = makeEvalSpecs(baseMatch, candidateModules, baselineModules, seeds);
            const results = (await Promise.all(specs.map((s) => pool.run(s)))) as MatchResult[];

            const candidateKey = JSON.stringify(candidateModules);
            const agg = aggregateResults(results, (r) => {
              const playerKey = JSON.stringify(r.spec.aiPlayer.composite ?? null);
              return playerKey === candidateKey ? "player" : "enemy";
            });

            const wl = wilsonLowerBound(agg.wins, agg.games);
            const candidate: Candidate = {
              params,
              score: agg.score,
              wins: agg.wins,
              games: agg.games,
              wl,
              avgGas: agg.avgGasWorthDelta,
            };
            evaluated.push(candidate);
            if (!bestCandidate || candidate.wl > bestCandidate.wl || (candidate.wl === bestCandidate.wl && candidate.score > bestCandidate.score)) {
              bestCandidate = candidate;
              currentBestParams = candidate.params;
            }
          }

          evaluated.sort((a, b) => (b.wl - a.wl) || (b.score - a.score));
          const elites = evaluated.slice(0, Math.max(2, Math.floor(opts.population * 0.2)));
          pop.splice(0, pop.length, ...elites.map((e) => e.params));
          while (pop.length < opts.population) {
            const a = elites[Math.floor(Math.random() * elites.length)]?.params ?? elites[0].params;
            const b = elites[Math.floor(Math.random() * elites.length)]?.params ?? elites[0].params;
            pop.push(mutate(schema, crossover(a, b)));
          }

          if (!opts.quiet) {
            // eslint-disable-next-line no-console
            console.log(`[compare-composite] scope=${scope} module=${moduleKind} phase=${phase.id} gen=${gen} bestLB=${(bestCandidate?.wl ?? 0).toFixed(4)} bestScore=${(bestCandidate?.score ?? 0).toFixed(2)}`);
          }

          writeFileSync(
            resolve(phaseDir, `gen-${gen}.json`),
            JSON.stringify({ module: moduleKind, phase: phase.id, generation: gen, best: bestCandidate }, null, 2),
            "utf8",
          );
        }

        best = withCandidate(best, moduleKind, currentBestParams);
        writeFileSync(
          resolve(phaseDir, "best-module.json"),
          JSON.stringify({ familyId: familyIdFor(moduleKind), params: currentBestParams }, null, 2),
          "utf8",
        );
      }
    }

    writeFileSync(resolve(runDir, "best-composite.json"), JSON.stringify(aiSpecFromModules(best), null, 2), "utf8");
  } finally {
    await pool.close();
  }
}
