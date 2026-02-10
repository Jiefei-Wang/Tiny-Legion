import { runSingleMatch } from "./match/run-single-match.ts";
import { runTraining } from "./train/run-training.ts";
import { runReplay } from "./replay/run-replay.ts";
import { loadArenaDefaults } from "./config/arena-config.ts";
import { runSpawnTraining } from "./train/run-spawn-training.ts";
import { openReplayUiFromFile } from "./replay/open-replay-ui.ts";
import { evaluateVsBaseline } from "./eval/evaluate-vs-baseline.ts";
import { runCompositeTraining } from "./train/run-composite-training.ts";
import { startGrpcServer } from "./grpc/server.ts";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd = ""] = argv;
  const args: Args = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return { cmd, args };
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function asModuleSource(value: unknown, fallback: "baseline" | "new" | `trained:${string}`): "baseline" | "new" | `trained:${string}` {
  if (typeof value !== "string") {
    return fallback;
  }
  const v = value.trim();
  if (v === "baseline" || v === "new") {
    return v;
  }
  if (v.startsWith("trained:") && v.length > "trained:".length) {
    return v as `trained:${string}`;
  }
  return fallback;
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const defaults = loadArenaDefaults();
  if (cmd === "match") {
    const aiA = asString(args.aiA, "baseline");
    const aiB = asString(args.aiB, "baseline");
    const seed = asNumber(args.seed, Date.now() % 1_000_000);
    const maxSimSeconds = asNumber(args.maxSimSeconds, defaults.maxSimSeconds ?? 240);
    const nodeDefense = asNumber(args.nodeDefense, defaults.nodeDefense ?? 1);
    const playerGas = asNumber(args.playerGas, defaults.playerGas ?? 10000);
    const enemyGas = asNumber(args.enemyGas, defaults.enemyGas ?? 10000);
    const baseHp = asNumber(args.baseHp, defaults.baseHp ?? NaN);
    const spawnBurst = asNumber(args.spawnBurst, defaults.spawnBurst ?? 1);
    const spawnMaxActive = asNumber(args.spawnMaxActive, defaults.spawnMaxActive ?? 5);
    const paramsAPath = typeof args.paramsA === "string" ? args.paramsA : null;
    const paramsBPath = typeof args.paramsB === "string" ? args.paramsB : null;
    const outPath = typeof args.out === "string" ? args.out : null;
    await runSingleMatch({
      aiA,
      aiB,
      paramsAPath,
      paramsBPath,
      seed,
      maxSimSeconds,
      nodeDefense,
      baseHp: Number.isFinite(baseHp) && baseHp > 0 ? baseHp : null,
      spawnBurst: Math.max(1, Math.floor(spawnBurst)),
      spawnMaxActive: Math.max(1, Math.floor(spawnMaxActive)),
      playerGas,
      enemyGas,
      outPath,
    });
    return;
  }
  if (cmd === "train") {
    const ai = asString(args.ai, "range-bias");
    const seed0 = asNumber(args.seed0, 100);
    const seeds = asNumber(args.seeds, defaults.seeds ?? 20);
    const generations = asNumber(args.generations, defaults.generations ?? 25);
    const population = asNumber(args.population, defaults.population ?? 40);
    const parallel = asNumber(args.parallel, defaults.parallel ?? 8);
    const maxSimSeconds = asNumber(args.maxSimSeconds, defaults.maxSimSeconds ?? 240);
    const nodeDefense = asNumber(args.nodeDefense, defaults.nodeDefense ?? 1);
    const playerGas = asNumber(args.playerGas, defaults.playerGas ?? 10000);
    const enemyGas = asNumber(args.enemyGas, defaults.enemyGas ?? 10000);
    const baseHp = asNumber(args.baseHp, defaults.baseHp ?? NaN);
    const maxModels = asNumber(args.maxModels, defaults.maxModels ?? 100);
    const spawnBurst = asNumber(args.spawnBurst, defaults.spawnBurst ?? 1);
    const spawnMaxActive = asNumber(args.spawnMaxActive, defaults.spawnMaxActive ?? 5);
    const quiet = args.quiet === true || args.quiet === "true";
    await runTraining({
      ai,
      seed0,
      seeds,
      generations,
      population,
      parallel,
      maxSimSeconds,
      nodeDefense,
      baseHp: Number.isFinite(baseHp) && baseHp > 0 ? baseHp : null,
      playerGas,
      enemyGas,
      spawnBurst: Math.max(1, Math.floor(spawnBurst)),
      spawnMaxActive: Math.max(1, Math.floor(spawnMaxActive)),
      maxModels,
      quiet,
    });
    return;
  }
  if (cmd === "train-spawn") {
    const spawnAi = asString(args.spawnAi, "spawn-weighted");
    const microFamily = asString(args.microFamily, "range-bias");
    const seed0 = asNumber(args.seed0, 100);
    const seeds = asNumber(args.seeds, defaults.seeds ?? 20);
    const generations = asNumber(args.generations, defaults.generations ?? 25);
    const population = asNumber(args.population, defaults.population ?? 40);
    const parallel = asNumber(args.parallel, defaults.parallel ?? 8);
    const maxSimSeconds = asNumber(args.maxSimSeconds, defaults.maxSimSeconds ?? 240);
    const nodeDefense = asNumber(args.nodeDefense, defaults.nodeDefense ?? 1);
    const playerGas = asNumber(args.playerGas, defaults.playerGas ?? 10000);
    const enemyGas = asNumber(args.enemyGas, defaults.enemyGas ?? 10000);
    const baseHp = asNumber(args.baseHp, defaults.baseHp ?? NaN);
    const maxModels = asNumber(args.maxModels, defaults.maxModels ?? 100);
    const spawnBurst = asNumber(args.spawnBurst, defaults.spawnBurst ?? 1);
    const spawnMaxActive = asNumber(args.spawnMaxActive, defaults.spawnMaxActive ?? 5);
    const quiet = args.quiet === true || args.quiet === "true";
    await runSpawnTraining({
      spawnAi,
      microFamily,
      seed0,
      seeds,
      generations,
      population,
      parallel,
      maxSimSeconds,
      nodeDefense,
      baseHp: Number.isFinite(baseHp) && baseHp > 0 ? baseHp : null,
      playerGas,
      enemyGas,
      spawnBurst: Math.max(1, Math.floor(spawnBurst)),
      spawnMaxActive: Math.max(1, Math.floor(spawnMaxActive)),
      maxModels,
      quiet,
    });
    return;
  }
  if (cmd === "train-composite") {
    const seed0 = asNumber(args.seed0, 100);
    const phaseSeeds = asNumber(args.phaseSeeds, defaults.seeds ?? 16);
    const generations = asNumber(args.generations, defaults.generations ?? 20);
    const population = asNumber(args.population, defaults.population ?? 24);
    const parallel = asNumber(args.parallel, defaults.parallel ?? 8);
    const maxSimSeconds = asNumber(args.maxSimSeconds, defaults.maxSimSeconds ?? 240);
    const nodeDefense = asNumber(args.nodeDefense, defaults.nodeDefense ?? 1);
    const playerGas = asNumber(args.playerGas, defaults.playerGas ?? 10000);
    const enemyGas = asNumber(args.enemyGas, defaults.enemyGas ?? 10000);
    const baseHp = asNumber(args.baseHp, defaults.baseHp ?? NaN);
    const spawnBurst = asNumber(args.spawnBurst, defaults.spawnBurst ?? 1);
    const spawnMaxActive = asNumber(args.spawnMaxActive, defaults.spawnMaxActive ?? 5);
    const nUnits = asNumber(args.nUnits, 4);
    const scope = asString(args.scope, "all");
    const seedCompositePath = typeof args.seedComposite === "string" ? args.seedComposite : null;
    const targetSource = asModuleSource(args.targetSource, "baseline");
    const movementSource = asModuleSource(args.movementSource, "baseline");
    const shootSource = asModuleSource(args.shootSource, "baseline");
    const targetLayers = asNumber(args.targetLayers, NaN);
    const targetHidden = asNumber(args.targetHidden, NaN);
    const movementLayers = asNumber(args.movementLayers, NaN);
    const movementHidden = asNumber(args.movementHidden, NaN);
    const shootLayers = asNumber(args.shootLayers, NaN);
    const shootHidden = asNumber(args.shootHidden, NaN);
    const quiet = args.quiet === true || args.quiet === "true";
    await runCompositeTraining({
      seed0,
      phaseSeeds: Math.max(2, Math.floor(phaseSeeds)),
      generations: Math.max(1, Math.floor(generations)),
      population: Math.max(4, Math.floor(population)),
      parallel: Math.max(1, Math.floor(parallel)),
      maxSimSeconds,
      nodeDefense,
      baseHp: Number.isFinite(baseHp) && baseHp > 0 ? baseHp : null,
      playerGas,
      enemyGas,
      spawnBurst: Math.max(1, Math.floor(spawnBurst)),
      spawnMaxActive: Math.max(1, Math.floor(spawnMaxActive)),
      nUnits: Math.max(2, Math.floor(nUnits)),
      scope: scope === "shoot" || scope === "movement" || scope === "target" || scope === "all" ? scope : "all",
      seedCompositePath,
      targetSource,
      movementSource,
      shootSource,
      targetLayers: Number.isFinite(targetLayers) ? targetLayers : null,
      targetHidden: Number.isFinite(targetHidden) ? targetHidden : null,
      movementLayers: Number.isFinite(movementLayers) ? movementLayers : null,
      movementHidden: Number.isFinite(movementHidden) ? movementHidden : null,
      shootLayers: Number.isFinite(shootLayers) ? shootLayers : null,
      shootHidden: Number.isFinite(shootHidden) ? shootHidden : null,
      quiet,
    });
    return;
  }
  if (cmd === "replay") {
    const replayPath = asString(args.file, "");
    if (!replayPath) {
      throw new Error("replay requires --file <path>");
    }
    const headless = args.headless === true || args.headless === "true";
    if (headless) {
      await runReplay({ replayPath });
      return;
    }
    await openReplayUiFromFile(replayPath);
    return;
  }
  if (cmd === "eval") {
    const ai = asString(args.ai, "range-bias");
    const paramsPath = typeof args.params === "string" ? args.params : null;
    const fromStore = args.fromStore === true || args.fromStore === "true";
    const seed0 = asNumber(args.seed0, 2000);
    const seeds = asNumber(args.seeds, 200);
    const parallel = asNumber(args.parallel, 20);
    const maxSimSeconds = asNumber(args.maxSimSeconds, defaults.maxSimSeconds ?? 240);
    const nodeDefense = asNumber(args.nodeDefense, defaults.nodeDefense ?? 1);
    const playerGas = asNumber(args.playerGas, defaults.playerGas ?? 10000);
    const enemyGas = asNumber(args.enemyGas, defaults.enemyGas ?? 10000);
    const baseHp = asNumber(args.baseHp, defaults.baseHp ?? NaN);
    const spawnBurst = asNumber(args.spawnBurst, defaults.spawnBurst ?? 1);
    const spawnMaxActive = asNumber(args.spawnMaxActive, defaults.spawnMaxActive ?? 5);
    const outPath = typeof args.out === "string" ? args.out : null;
    await evaluateVsBaseline({
      ai,
      paramsPath,
      fromStore,
      seed0,
      seeds,
      parallel,
      maxSimSeconds,
      nodeDefense,
      baseHp: Number.isFinite(baseHp) && baseHp > 0 ? baseHp : null,
      playerGas,
      enemyGas,
      spawnBurst: Math.max(1, Math.floor(spawnBurst)),
      spawnMaxActive: Math.max(1, Math.floor(spawnMaxActive)),
      outPath,
    });
    return;
  }
  if (cmd === "serve-grpc") {
    const port = asNumber(args.port, Number(process.env.ARENA_GRPC_PORT ?? 50051));
    await startGrpcServer(Math.max(1, Math.floor(port)));
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      "arena cli",
      "",
      "Commands:",
      "  match --aiA baseline --aiB range-bias --seed 123 --out match.json",
      "  train --ai range-bias --generations 25 --population 40 --parallel 8",
      "  train-spawn --spawnAi spawn-weighted --microFamily range-bias --generations 25 --population 40 --parallel 8",
      "  train-composite --scope all --generations 20 --population 24 --phaseSeeds 16 --nUnits 4",
      "  train-composite --scope shoot --shootSource new --movementSource baseline --targetSource baseline --shootLayers 2 --shootHidden 16",
      "  eval --ai range-bias --fromStore true --seeds 200 --parallel 20",
      "  serve-grpc --port 50051",
      "  replay --file match.json",
      "",
      "Common flags:",
      "  --maxSimSeconds 240 --nodeDefense 1 --baseHp 1200 --playerGas 10000 --enemyGas 10000 --spawnBurst 1",
      "",
      "Global defaults:",
      "  arena/arena.config.json (and/or env vars like ARENA_PLAYER_GAS)",
    ].join("\n"),
  );
}

await main();
