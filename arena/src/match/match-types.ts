import type { Params } from "../ai/ai-schema.ts";

export type Side = "player" | "enemy";

export type MatchAiSpec = {
  familyId: string;
  params: Params;
  composite?: {
    target: { familyId: string; params: Params };
    movement: { familyId: string; params: Params };
    shoot: { familyId: string; params: Params };
  };
};

export type SpawnMode = "mirrored-random" | "ai";

export type SpawnSpec = {
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
  spawnBurst?: number;
  spawnMaxActive?: number;
  aiPlayer: MatchAiSpec;
  aiEnemy: MatchAiSpec;
  scenario?: {
    withBase: boolean;
    initialUnitsPerSide: number;
  };
  templateNames?: string[];
  battlefield?: {
    width?: number;
    height?: number;
    groundHeight?: number;
  };
  spawnMode?: SpawnMode;
  spawnPlayer?: SpawnSpec;
  spawnEnemy?: SpawnSpec;
};

export type SideOutcome = {
  win: boolean;
  tie: boolean;
  gasStart: number;
  gasEnd: number;
  onFieldGasValueStart: number;
  onFieldGasValueEnd: number;
  gasWorthDelta: number;
  score: number;
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
