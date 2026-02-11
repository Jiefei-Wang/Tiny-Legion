import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { baselineCompositeConfig, type CompositeConfig } from "../ai/composite-controller.ts";
import type { MatchAiSpec, MatchSpec } from "./match-types.ts";
import { runMatch } from "./run-match.ts";

function parseCompositeSpec(path: string): MatchAiSpec {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid composite file: ${path}`);
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.familyId === "composite" && obj.composite && typeof obj.composite === "object") {
    return {
      familyId: "composite",
      params: {},
      composite: obj.composite as MatchAiSpec["composite"],
    };
  }

  if (obj.target && obj.movement && obj.shoot) {
    return {
      familyId: "composite",
      params: {},
      composite: obj as unknown as CompositeConfig,
    };
  }

  throw new Error(`Invalid composite file: ${path}. Expected full MatchAiSpec or {target,movement,shoot}.`);
}

function resolveComposite(path: string | null): MatchAiSpec {
  if (!path) {
    return {
      familyId: "composite",
      params: {},
      composite: baselineCompositeConfig(),
    };
  }
  return parseCompositeSpec(path);
}

export async function runSingleMatch(opts: {
  playerCompositePath: string | null;
  enemyCompositePath: string | null;
  seed: number;
  maxSimSeconds: number;
  nodeDefense: number;
  baseHp: number | null;
  spawnBurst: number;
  spawnMaxActive: number;
  playerGas: number;
  enemyGas: number;
  outPath: string | null;
}): Promise<void> {
  const spec: MatchSpec = {
    seed: opts.seed,
    maxSimSeconds: opts.maxSimSeconds,
    nodeDefense: opts.nodeDefense,
    ...(opts.baseHp ? { baseHp: opts.baseHp } : {}),
    spawnBurst: opts.spawnBurst,
    spawnMaxActive: opts.spawnMaxActive,
    playerGas: opts.playerGas,
    enemyGas: opts.enemyGas,
    aiPlayer: resolveComposite(opts.playerCompositePath),
    aiEnemy: resolveComposite(opts.enemyCompositePath),
  };

  const result = await runMatch(spec);
  const out = JSON.stringify(result, null, 2);
  if (opts.outPath) {
    const full = resolve(process.cwd(), opts.outPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, out, "utf8");
  } else {
    // eslint-disable-next-line no-console
    console.log(out);
  }
}
