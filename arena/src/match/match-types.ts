import type { Params } from "../ai/ai-schema.ts";

export type Side = "player" | "enemy";

export type MatchAiSpec = {
  familyId: string;
  params: Params;
};

export type MatchSpec = {
  seed: number;
  maxSimSeconds: number;
  nodeDefense: number;
  baseHp?: number;
  playerGas: number;
  enemyGas: number;
  aiPlayer: MatchAiSpec;
  aiEnemy: MatchAiSpec;
};

export type SideOutcome = {
  win: boolean;
  tie: boolean;
  gasStart: number;
  gasEnd: number;
  onFieldGasValueStart: number;
  onFieldGasValueEnd: number;
  gasWorthDelta: number;
};

export type MatchResult = {
  spec: MatchSpec;
  simSecondsElapsed: number;
  outcome: {
    playerVictory: boolean;
    reason: string;
  };
  sides: {
    player: SideOutcome;
    enemy: SideOutcome;
  };
  replay: {
    seed: number;
    maxSimSeconds: number;
    nodeDefense: number;
    playerGas: number;
    enemyGas: number;
    aiPlayer: MatchAiSpec;
    aiEnemy: MatchAiSpec;
  };
};
