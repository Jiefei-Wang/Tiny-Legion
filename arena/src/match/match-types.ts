import type { Params } from "../ai/ai-schema.ts";

export type Side = "player" | "enemy";

export type MatchAiSpec = {
  familyId: "composite";
  params: Params;
  composite: {
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
  spawnIntervalSeconds?: number;
  baseWorthUnits?: number;
  aiPlayer: MatchAiSpec;
  aiEnemy: MatchAiSpec;
  scenario?: {
    withBase: boolean;
    initialUnitsPerSide: number;
    /** Free, immediate Test-Arena-style replenishment target for each side. */
    maintainUnitsPerSide?: number;
    initialLineup?: {
      player: { templateId: number; count: number };
      enemy: { templateId: number; count: number };
    };
    replenishInitialLineup?: boolean;
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
  final: {
    playerBaseHp: number;
    enemyBaseHp: number;
    playerOperationalUnits: number;
    enemyOperationalUnits: number;
    playerUnitIntegrity: number;
    enemyUnitIntegrity: number;
  };
  losses: {
    player: { destroyedObjects: number };
    enemy: { destroyedObjects: number };
  };
  performance: {
    /** Weighted opposing objects destroyed by each side; a base uses baseWorthUnits. */
    destroyedByPlayer: number;
    destroyedByEnemy: number;
    playerDestroyedRatio: number;
    enemyDestroyedRatio: number;
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
