import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  eloScore?: number;
};

type PhaseDef = {
  id: string;
  withBase: boolean;
  initialUnitsPerSide: number;
  seeds: number;
  templateNames: string[];
  battlefield: {
    width: number;
    height: number;
    groundHeight?: number;
  };
  opponentMode?: "best" | "leaderboard-nearby";
  leaderboard?: {
    opponentCount: number;
  };
};

type CompositeSnapshot = {
  target: CompositeModuleSpec;
  movement: CompositeModuleSpec;
  shoot: CompositeModuleSpec;
};

type LeaderboardOpponent = {
  runId: string;
  score: number;
  modules: CompositeSnapshot;
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

function makePhase(
  id: string,
  withBase: boolean,
  initialUnitsPerSide: number,
  seeds: number,
  config?: Partial<PhaseDef>,
): PhaseDef {
  return {
    id,
    withBase,
    initialUnitsPerSide,
    seeds,
    templateNames: config?.templateNames ?? ["*"],
    battlefield: {
      width: config?.battlefield?.width ?? 2000,
      height: config?.battlefield?.height ?? 1000,
      ...(typeof config?.battlefield?.groundHeight === "number" ? { groundHeight: config.battlefield.groundHeight } : {}),
    },
    opponentMode: config?.opponentMode ?? "best",
    ...(config?.leaderboard ? { leaderboard: { opponentCount: Math.max(1, Math.floor(config.leaderboard.opponentCount)) } } : {}),
  };
}

function defaultPhaseDefs(nUnits: number, phaseSeeds: number): PhaseDef[] {
  return [
    makePhase("p1-no-base-1v1", false, 1, phaseSeeds),
    makePhase("p2-no-base-nvn", false, nUnits, phaseSeeds),
    makePhase("p3-battlefield-base", true, nUnits, phaseSeeds),
    makePhase("p4-leaderboard", true, nUnits, phaseSeeds, {
      opponentMode: "leaderboard-nearby",
      leaderboard: { opponentCount: 6 },
    }),
  ];
}

type PhaseConfigFile = {
  phases?: Array<Partial<PhaseDef>>;
  byComponent?: Partial<Record<ModuleKind, Array<Partial<PhaseDef>>>>;
} | Partial<Record<ModuleKind, Array<Partial<PhaseDef>>>>;

function loadPhaseDefs(
  nUnits: number,
  phaseSeeds: number,
  phaseConfigPath?: string | null,
): Record<ModuleKind, PhaseDef[]> {
  const defaults = defaultPhaseDefs(nUnits, phaseSeeds);
  const configPath = phaseConfigPath
    ? resolve(process.cwd(), phaseConfigPath)
    : resolve(process.cwd(), "composite-training.phases.json");
  if (!existsSync(configPath)) {
    return { shoot: defaults, movement: defaults, target: defaults };
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as PhaseConfigFile;
    const parseEntries = (entries: Array<Partial<PhaseDef>> | undefined): PhaseDef[] => {
      if (!Array.isArray(entries) || entries.length <= 0) {
        return [];
      }
      const out: PhaseDef[] = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const id = typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id : "";
        if (!id) {
          continue;
        }
        const withBase = Boolean(entry.withBase);
        const initialUnitsPerSide = Math.max(1, Math.floor(Number(entry.initialUnitsPerSide ?? nUnits)));
        const seeds = Math.max(1, Math.floor(Number(entry.seeds ?? phaseSeeds)));
        out.push(makePhase(id, withBase, initialUnitsPerSide, seeds, entry));
      }
      return out;
    };
    const globalEntries = parseEntries((parsed as { phases?: Array<Partial<PhaseDef>> })?.phases);
    const legacyByComponent = parsed as Partial<Record<ModuleKind, Array<Partial<PhaseDef>>>>;
    const byComponent = (parsed as { byComponent?: Partial<Record<ModuleKind, Array<Partial<PhaseDef>>>> })?.byComponent;
    const readModulePhases = (kind: ModuleKind): PhaseDef[] => {
      const specific = parseEntries(byComponent?.[kind] ?? legacyByComponent?.[kind]);
      if (specific.length > 0) {
        return specific;
      }
      if (globalEntries.length > 0) {
        return globalEntries;
      }
      return defaults;
    };
    return {
      shoot: readModulePhases("shoot"),
      movement: readModulePhases("movement"),
      target: readModulePhases("target"),
    };
  } catch {
    return { shoot: defaults, movement: defaults, target: defaults };
  }
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

function modulesFromAiSpec(spec: MatchSpec["aiPlayer"]): CompositeSnapshot | null {
  if (spec.familyId !== "composite" || !spec.composite) {
    return null;
  }
  return {
    target: { familyId: spec.composite.target.familyId, params: spec.composite.target.params },
    movement: { familyId: spec.composite.movement.familyId, params: spec.composite.movement.params },
    shoot: { familyId: spec.composite.shoot.familyId, params: spec.composite.shoot.params },
  };
}

function loadLeaderboardOpponents(dataRoot: string): LeaderboardOpponent[] {
  const runsDir = resolve(dataRoot, "runs");
  const leaderboardPath = resolve(dataRoot, "leaderboard", "composite-elo.json");
  const scoresByRunId = new Map<string, number>();
  if (existsSync(leaderboardPath)) {
    try {
      const raw = readFileSync(leaderboardPath, "utf8");
      const parsed = JSON.parse(raw) as { ratings?: Record<string, { score?: number }> };
      const ratings = parsed?.ratings ?? {};
      for (const [runId, rating] of Object.entries(ratings)) {
        const score = Number.isFinite(rating?.score) ? Number(rating.score) : 100;
        scoresByRunId.set(runId, score);
      }
    } catch {
      // ignore malformed leaderboard store
    }
  }
  const out: LeaderboardOpponent[] = [];
  if (existsSync(runsDir)) {
    const runIds = readdirSync(runsDir);
    for (const runId of runIds) {
      const filePath = resolve(runsDir, runId, "best-composite.json");
      if (!existsSync(filePath)) {
        continue;
      }
      try {
        statSync(filePath);
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as MatchSpec["aiPlayer"];
        const modules = modulesFromAiSpec(parsed);
        if (!modules) {
          continue;
        }
        out.push({
          runId,
          score: scoresByRunId.get(runId) ?? 100,
          modules,
        });
      } catch {
        continue;
      }
    }
  }
  // Include baseline composite as a stable ladder anchor near default score.
  out.push({
    runId: "baseline-composite",
    score: 100,
    modules: baselineCompositeConfig(),
  });
  return out;
}

type EvalJob = {
  spec: MatchSpec;
  opponentScore: number;
  candidateSide: "player" | "enemy";
};

function makeEvalJobsVsOpponents(
  base: Omit<MatchSpec, "seed" | "aiPlayer" | "aiEnemy">,
  candidateModules: CompositeSnapshot,
  opponents: LeaderboardOpponent[],
  seeds: number[],
): EvalJob[] {
  const candidateAi = aiSpecFromModules(candidateModules);
  const jobs: EvalJob[] = [];
  for (const seed of seeds) {
    for (const opponent of opponents) {
      const opponentAi = aiSpecFromModules(opponent.modules);
      jobs.push({
        spec: { ...base, seed, aiPlayer: candidateAi, aiEnemy: opponentAi },
        opponentScore: opponent.score,
        candidateSide: "player",
      });
      jobs.push({
        spec: { ...base, seed, aiPlayer: opponentAi, aiEnemy: candidateAi },
        opponentScore: opponent.score,
        candidateSide: "enemy",
      });
    }
  }
  return jobs;
}

function expectedScore(ra: number, rb: number): number {
  const scale = 80;
  return 1 / (1 + 10 ** ((rb - ra) / scale));
}

function applyEloStep(ra: number, rb: number, outcomeA: 0 | 0.5 | 1): number {
  const gap = Math.abs(ra - rb);
  const k = 14 + Math.min(48, gap * 0.2);
  const ea = expectedScore(ra, rb);
  return ra + k * (outcomeA - ea);
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
  phaseConfigPath?: string | null;
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

  const phases = loadPhaseDefs(opts.nUnits, opts.phaseSeeds, opts.phaseConfigPath);
  const pool = new WorkerPool(WorkerPool.matchWorkerUrl(), opts.parallel);
  const leaderboardOpponents = loadLeaderboardOpponents(dataRoot);
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
          templateNames: phase.templateNames,
          battlefield: phase.battlefield,
        };

        const seeds = buildSeedList(opts.seed0, phase.seeds);
        const pop: Params[] = [currentBestParams];
        while (pop.length < opts.population) {
          pop.push(randomParams(schema));
        }

        let bestCandidate: Candidate | null = null;
        for (let gen = 0; gen < opts.generations; gen += 1) {
          const evaluated: Candidate[] = [];
          const referenceScore = bestCandidate?.eloScore ?? 100;
          const sortedOpponents = [...leaderboardOpponents]
            .sort((a, b) => Math.abs(a.score - referenceScore) - Math.abs(b.score - referenceScore));
          const nearbyOpponents = sortedOpponents.slice(0, Math.max(1, phase.leaderboard?.opponentCount ?? 6));
          for (const params of pop) {
            const candidateModules = withCandidate(best, moduleKind, params);
            let agg;
            let eloScore = referenceScore;
            if (phase.opponentMode === "leaderboard-nearby" && nearbyOpponents.length > 0) {
              const jobs = makeEvalJobsVsOpponents(baseMatch, candidateModules, nearbyOpponents, seeds);
              const results = (await Promise.all(jobs.map((j) => pool.run(j.spec)))) as MatchResult[];
              agg = aggregateResults(results, (_r, i) => jobs[i]?.candidateSide ?? "player");
              for (let i = 0; i < results.length; i += 1) {
                const side = jobs[i]?.candidateSide ?? "player";
                const opponentScore = Number.isFinite(jobs[i]?.opponentScore) ? Number(jobs[i]?.opponentScore) : 100;
                const outcomeSide = results[i]?.sides?.[side];
                if (!outcomeSide) {
                  continue;
                }
                const outcomeA: 0 | 0.5 | 1 = outcomeSide.tie ? 0.5 : (outcomeSide.win ? 1 : 0);
                eloScore = applyEloStep(eloScore, opponentScore, outcomeA);
              }
            } else {
              const baselineModules = best;
              const specs = makeEvalSpecs(baseMatch, candidateModules, baselineModules, seeds);
              const results = (await Promise.all(specs.map((s) => pool.run(s)))) as MatchResult[];

              const candidateKey = JSON.stringify(candidateModules);
              agg = aggregateResults(results, (r) => {
                const playerKey = JSON.stringify(r.spec.aiPlayer.composite ?? null);
                return playerKey === candidateKey ? "player" : "enemy";
              });
            }

            const wl = wilsonLowerBound(agg.wins, agg.games);
            const candidate: Candidate = {
              params,
              score: agg.score,
              wins: agg.wins,
              games: agg.games,
              wl,
              avgGas: agg.avgGasWorthDelta,
              ...(phase.opponentMode === "leaderboard-nearby" ? { eloScore } : {}),
            };
            evaluated.push(candidate);
            const better = phase.opponentMode === "leaderboard-nearby"
              ? (!bestCandidate
                || (candidate.eloScore ?? 0) > (bestCandidate.eloScore ?? 0)
                || ((candidate.eloScore ?? 0) === (bestCandidate.eloScore ?? 0)
                  && (candidate.wl > bestCandidate.wl || (candidate.wl === bestCandidate.wl && candidate.score > bestCandidate.score))))
              : (!bestCandidate || candidate.wl > bestCandidate.wl || (candidate.wl === bestCandidate.wl && candidate.score > bestCandidate.score));
            if (better) {
              bestCandidate = candidate;
              currentBestParams = candidate.params;
            }
          }

          if (phase.opponentMode === "leaderboard-nearby") {
            evaluated.sort((a, b) => ((b.eloScore ?? 0) - (a.eloScore ?? 0)) || (b.wl - a.wl) || (b.score - a.score));
          } else {
            evaluated.sort((a, b) => (b.wl - a.wl) || (b.score - a.score));
          }
          const elites = evaluated.slice(0, Math.max(2, Math.floor(opts.population * 0.2)));
          pop.splice(0, pop.length, ...elites.map((e) => e.params));
          while (pop.length < opts.population) {
            const a = elites[Math.floor(Math.random() * elites.length)]?.params ?? elites[0].params;
            const b = elites[Math.floor(Math.random() * elites.length)]?.params ?? elites[0].params;
            pop.push(mutate(schema, crossover(a, b)));
          }

          if (!opts.quiet) {
            // eslint-disable-next-line no-console
            console.log(
              `[compare-composite] scope=${scope} module=${moduleKind} phase=${phase.id} gen=${gen} `
              + `bestLB=${(bestCandidate?.wl ?? 0).toFixed(4)} bestScore=${(bestCandidate?.score ?? 0).toFixed(2)}`
              + `${phase.opponentMode === "leaderboard-nearby" ? ` bestElo=${(bestCandidate?.eloScore ?? 0).toFixed(2)}` : ""}`,
            );
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
