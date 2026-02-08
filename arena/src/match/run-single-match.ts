import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { getFamily } from "../ai/families.ts";
import type { Params } from "../ai/ai-schema.ts";
import type { MatchSpec } from "./match-types.ts";
import { runMatch } from "./run-match.ts";

function readParams(path: string | null): Params {
  if (!path) {
    return {};
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid params file: ${path}`);
  }
  return parsed as Params;
}

export async function runSingleMatch(opts: {
  aiA: string;
  aiB: string;
  paramsAPath: string | null;
  paramsBPath: string | null;
  seed: number;
  maxSimSeconds: number;
  nodeDefense: number;
  baseHp: number | null;
  playerGas: number;
  enemyGas: number;
  outPath: string | null;
}): Promise<void> {
  const familyA = getFamily(opts.aiA);
  const familyB = getFamily(opts.aiB);
  const paramsA = readParams(opts.paramsAPath);
  const paramsB = readParams(opts.paramsBPath);

  // Validate by instantiation.
  familyA.make(paramsA);
  familyB.make(paramsB);

  const spec: MatchSpec = {
    seed: opts.seed,
    maxSimSeconds: opts.maxSimSeconds,
    nodeDefense: opts.nodeDefense,
    ...(opts.baseHp ? { baseHp: opts.baseHp } : {}),
    playerGas: opts.playerGas,
    enemyGas: opts.enemyGas,
    aiPlayer: { familyId: familyA.id, params: paramsA },
    aiEnemy: { familyId: familyB.id, params: paramsB },
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
