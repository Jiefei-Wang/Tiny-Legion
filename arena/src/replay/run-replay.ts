import { readFileSync } from "node:fs";
import type { MatchResult, MatchSpec } from "../match/match-types.ts";
import { runMatch } from "../match/run-match.ts";

export async function runReplay(opts: { replayPath: string }): Promise<void> {
  const raw = readFileSync(opts.replayPath, "utf8");
  const parsed = JSON.parse(raw) as MatchResult;
  const spec: MatchSpec = parsed.spec;
  const result = await runMatch(spec);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}
