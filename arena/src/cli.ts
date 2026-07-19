import { runSingleMatch } from "./match/run-single-match.ts";
import { runReplay } from "./replay/run-replay.ts";
import { loadArenaDefaults } from "./config/arena-config.ts";
import { openReplayUiFromFile } from "./replay/open-replay-ui.ts";
import { runCompositeTraining } from "./train/run-composite-training.ts";
import { evaluateAiTiers } from "./eval/evaluate-ai-tiers.ts";

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

function asShootFamily(
  value: unknown,
  fallback: "dt-shoot" | "dt-shoot-atan" | "w11-shoot" | "autoreg-shoot" | "history-shoot",
): "dt-shoot" | "dt-shoot-atan" | "w11-shoot" | "autoreg-shoot" | "history-shoot" {
  if (value === "dt-shoot" || value === "dt-shoot-atan" || value === "w11-shoot" || value === "autoreg-shoot" || value === "history-shoot") {
    return value;
  }
  return fallback;
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const defaults = loadArenaDefaults();
  if (cmd === "match") {
    const playerCompositePath = typeof args.playerComposite === "string" ? args.playerComposite : null;
    const enemyCompositePath = typeof args.enemyComposite === "string" ? args.enemyComposite : null;
    const seed = asNumber(args.seed, Date.now() % 1_000_000);
    const maxSimSeconds = asNumber(args.maxSimSeconds, defaults.maxSimSeconds ?? 240);
    const nodeDefense = asNumber(args.nodeDefense, defaults.nodeDefense ?? 1);
    const playerGas = asNumber(args.playerGas, defaults.playerGas ?? 10000);
    const enemyGas = asNumber(args.enemyGas, defaults.enemyGas ?? 10000);
    const baseHp = asNumber(args.baseHp, defaults.baseHp ?? NaN);
    const spawnBurst = asNumber(args.spawnBurst, defaults.spawnBurst ?? 1);
    const spawnMaxActive = asNumber(args.spawnMaxActive, defaults.spawnMaxActive ?? 5);
    const outPath = typeof args.out === "string" ? args.out : null;
    await runSingleMatch({
      playerCompositePath,
      enemyCompositePath,
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
  if (cmd === "train-composite") {
    const seed0 = asNumber(args.seed0, 100);
    const phaseSeeds = asNumber(args.phaseSeeds, defaults.seeds ?? 16);
    const generations = asNumber(args.generations, defaults.generations ?? 20);
    const population = asNumber(args.population, defaults.population ?? 24);
    const parallel = asNumber(args.parallel, defaults.parallel ?? 8);
    const nodeDefense = asNumber(args.nodeDefense, defaults.nodeDefense ?? 1);
    const playerGas = asNumber(args.playerGas, defaults.playerGas ?? 10000);
    const enemyGas = asNumber(args.enemyGas, defaults.enemyGas ?? 10000);
    const baseHp = asNumber(args.baseHp, defaults.baseHp ?? NaN);
    const spawnBurst = asNumber(args.spawnBurst, defaults.spawnBurst ?? 1);
    const spawnMaxActive = asNumber(args.spawnMaxActive, defaults.spawnMaxActive ?? 5);
    const nUnits = asNumber(args.nUnits, 4);
    const scope = asString(args.scope, "all");
    const seedCompositePath = typeof args.seedComposite === "string" ? args.seedComposite : null;
    const phaseConfigPath = typeof args.phaseConfig === "string" ? args.phaseConfig : null;
    const targetSource = asModuleSource(args.targetSource, "baseline");
    const movementSource = asModuleSource(args.movementSource, "baseline");
    const shootSource = asModuleSource(args.shootSource, "baseline");
    const shootFamily = asShootFamily(args.shootFamily ?? args["shoot-family"], "dt-shoot");
    const quiet = args.quiet === true || args.quiet === "true";
    await runCompositeTraining({
      seed0,
      phaseSeeds: Math.max(2, Math.floor(phaseSeeds)),
      generations: Math.max(1, Math.floor(generations)),
      population: Math.max(4, Math.floor(population)),
      parallel: Math.max(1, Math.floor(parallel)),
      nodeDefense,
      baseHp: Number.isFinite(baseHp) && baseHp > 0 ? baseHp : null,
      playerGas,
      enemyGas,
      spawnBurst: Math.max(1, Math.floor(spawnBurst)),
      spawnMaxActive: Math.max(1, Math.floor(spawnMaxActive)),
      nUnits: Math.max(2, Math.floor(nUnits)),
      phaseConfigPath,
      scope: scope === "shoot" || scope === "movement" || scope === "target" || scope === "all" ? scope : "all",
      seedCompositePath,
      targetSource,
      movementSource,
      shootSource,
      shootFamily,
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
  if (cmd === "eval-tiers") {
    await evaluateAiTiers(asNumber(args.seeds, 10));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    [
      "arena cli",
      "",
      "Commands:",
      "  match --seed 123 --out match.json",
      "  match --playerComposite player.json --enemyComposite enemy.json --seed 123 --out match.json",
      "  eval-tiers --seeds 10",
      "  train-composite --scope all --generations 20 --population 24 --phaseSeeds 16 --nUnits 4",
      "  train-composite --scope shoot --shootSource new --movementSource baseline --targetSource baseline",
      "  train-composite --scope shoot --shootSource new --shootFamily dt-shoot-atan",
      "  train-composite --scope shoot --shootSource new --shootFamily w11-shoot",
      "  train-composite --scope shoot --shootSource new --shootFamily autoreg-shoot",
      "  train-composite --scope shoot --shootSource new --shootFamily history-shoot",
      "  train-composite --phaseConfig composite-training.phases.json",
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
