import type { MatchResult, MatchSpec } from "./match-types.ts";
import { setMathRandomSeed } from "../lib/seeded-rng.ts";
import { loadRuntimeMergedTemplates } from "./templates.ts";
import { mulberry32 } from "../lib/seeded-rng.ts";
import { getSpawnFamily } from "../spawn/families.ts";
import { BattleSession } from "../../../packages/game-core/src/gameplay/battle/battle-session.ts";
import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  BATTLE_SALVAGE_REFUND_FACTOR,
} from "../../../packages/game-core/src/config/balance/battlefield.ts";
import { makeCompositeAiController } from "../ai/composite-controller.ts";

type GameBattleHooks = {
  addLog: (text: string, tone?: any) => void;
  getCommanderSkill: () => number;
  getPlayerGas: () => number;
  spendPlayerGas: (amount: number) => boolean;
  addPlayerGas: (amount: number) => void;
  onBattleOver: (victory: boolean, nodeId: string, reason: string) => void;
};

function createMockCanvas(width: number, height: number): any {
  const contextStub = {};
  return {
    width,
    height,
    getContext: (type: string) => (type === "2d" ? contextStub : null),
  };
}

function computeOnFieldGasValue(units: any[], side: "player" | "enemy", refundFactor: number): number {
  let sum = 0;
  for (const unit of units) {
    if (!unit || !unit.alive || unit.side !== side) {
      continue;
    }
    const cost = typeof unit.deploymentGasCost === "number" ? unit.deploymentGasCost : 0;
    const refundable = Math.floor(cost * refundFactor);
    if (refundable > 0) {
      sum += refundable;
    }
  }
  return sum;
}

function scoreFor(outcome: "win" | "tie" | "loss", gasWorthDelta: number): number {
  const O = outcome === "win" ? 2 : outcome === "tie" ? 1 : 0;
  return O * 1_000_000 + gasWorthDelta;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesTemplatePattern(templateId: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }
  return wildcardToRegex(pattern).test(templateId);
}

function aliveCount(units: any[], side: "player" | "enemy"): number {
  return units.filter((unit: any) => unit.alive && unit.side === side).length;
}

export async function runMatch(spec: MatchSpec): Promise<MatchResult> {
  setMathRandomSeed(spec.seed);
  const allTemplates = await loadRuntimeMergedTemplates();
  const templatePatterns = Array.isArray(spec.templateNames) && spec.templateNames.length > 0
    ? spec.templateNames
    : ["*"];
  const templates = allTemplates.filter((template: any) => {
    const id = String(template?.id ?? "");
    if (!id) {
      return false;
    }
    return templatePatterns.some((pattern) => matchesTemplatePattern(id, String(pattern)));
  });
  if (templates.length <= 0) {
    throw new Error(`runMatch: no templates matched pattern(s): ${templatePatterns.join(", ")}`);
  }
  const templateById = new Map<string, any>(templates.map((t: any) => [String(t.id), t] as const));
  const refundFactor = BATTLE_SALVAGE_REFUND_FACTOR;

  let playerGas = spec.playerGas;
  const logs: string[] = [];
  const hooks: GameBattleHooks = {
    addLog: (text: string) => {
      logs.push(text);
    },
    getCommanderSkill: () => 10,
    getPlayerGas: () => playerGas,
    spendPlayerGas: (amount) => {
      if (playerGas < amount) {
        return false;
      }
      playerGas -= amount;
      return true;
    },
    addPlayerGas: (amount) => {
      playerGas += amount;
    },
    onBattleOver: () => {
      return;
    },
  };

  const aiForSide = (side: "player" | "enemy"): any => {
    const aiSpec = side === "player" ? spec.aiPlayer : spec.aiEnemy;
    const composite = makeCompositeAiController(aiSpec);
    if (composite) {
      return composite;
    }
    throw new Error(`Unsupported AI spec in runner: expected familyId=composite for side=${side}`);
  };

  const battlefieldWidth = clamp(Math.floor(spec.battlefield?.width ?? BATTLEFIELD_WIDTH), 640, 4096);
  const battlefieldHeight = clamp(Math.floor(spec.battlefield?.height ?? BATTLEFIELD_HEIGHT), 360, 2160);
  const canvas = createMockCanvas(battlefieldWidth, battlefieldHeight);
  const battle = new BattleSession(canvas, hooks, templates, {
    aiControllers: {
      player: aiForSide("player"),
      enemy: aiForSide("enemy"),
    },
    autoEnableAiWeaponAutoFire: true,
    disableAutoEnemySpawns: true,
    disableEnemyMinimumPresence: true,
    disableDefaultStarters: true,
  });

  const scenario = spec.scenario ?? { withBase: true, initialUnitsPerSide: 2 };
  const node: Parameters<BattleSession["start"]>[0] = {
    id: "arena",
    name: "Arena",
    owner: "neutral",
    garrison: false,
    reward: 0,
    defense: spec.nodeDefense,
    ...((scenario.withBase && typeof spec.baseHp === "number" && Number.isFinite(spec.baseHp) && spec.baseHp > 0)
      ? { testBaseHpOverride: spec.baseHp }
      : !scenario.withBase
        ? { testBaseHpOverride: 5_000_000 }
      : {}),
  };
  battle.start(node);
  if (typeof spec.battlefield?.groundHeight === "number" && Number.isFinite(spec.battlefield.groundHeight)) {
    battle.setGroundHeight(spec.battlefield.groundHeight);
  }
  battle.clearControlSelection();

  const rosterPreference = ["scout-ground", "tank-ground", "air-jet", "air-propeller", "air-light"];
  const availableTemplateIds = new Set<string>(templates.map((t: any) => String(t.id)));
  const roster = rosterPreference.filter((id) => availableTemplateIds.has(id));
  if (roster.length === 0) {
    for (const t of templates.slice(0, 6)) {
      roster.push(String(t.id));
    }
  }

  const spawnRng = mulberry32((spec.seed ^ 0x2f7a1d) >>> 0);

  if (scenario.withBase) {
    // Symmetric starters (free and non-refundable, like headless smoke test semantics).
    const starterTemplates = rosterPreference.filter((id) => availableTemplateIds.has(id)).slice(0, 2);
    for (const templateId of starterTemplates) {
      battle.arenaDeploy("player", templateId, { chargeGas: false, deploymentGasCost: 0, y: 300 });
      battle.arenaDeploy("enemy", templateId, { chargeGas: false, deploymentGasCost: 0, y: 300 });
    }
  } else {
    const unitsPerSide = Math.max(1, Math.floor(scenario.initialUnitsPerSide));
    for (let i = 0; i < unitsPerSide; i += 1) {
      if (roster.length === 0) {
        break;
      }
      const idx = Math.floor(spawnRng() * roster.length);
      const templateId = roster[Math.max(0, Math.min(roster.length - 1, idx))] ?? null;
      if (!templateId) {
        continue;
      }
      const y = 220 + spawnRng() * 260;
      battle.arenaDeploy("player", templateId, { chargeGas: false, deploymentGasCost: 0, y });
      battle.arenaDeploy("enemy", templateId, { chargeGas: false, deploymentGasCost: 0, y });
    }
  }

  // Override enemy gas if requested.
  const state0 = battle.getState();
  state0.enemyGas = scenario.withBase ? spec.enemyGas : 0;
  if (!scenario.withBase) {
    playerGas = 0;
  }

  const playerGasStart = playerGas;
  const enemyGasStart = state0.enemyGas;
  const onFieldPlayerStart = computeOnFieldGasValue(state0.units, "player", refundFactor);
  const onFieldEnemyStart = computeOnFieldGasValue(state0.units, "enemy", refundFactor);

  const dt = 1 / 60;
  const noKeys = { a: false, d: false, w: false, s: false, space: false };
  let t = 0;

  const spawnMode = spec.spawnMode ?? "mirrored-random";
  const spawnBurst = Math.max(1, Math.floor(spec.spawnBurst ?? 1));
  const spawnMaxActive = Math.max(1, Math.floor(spec.spawnMaxActive ?? 5));
  const allowSpawns = scenario.withBase;
  let spawnTimer = 0;
  let spawnIntervalS = 1.8;

  const spawnFamilyPlayer = spawnMode === "ai" && spec.spawnPlayer ? getSpawnFamily(spec.spawnPlayer.familyId) : null;
  const spawnFamilyEnemy = spawnMode === "ai" && spec.spawnEnemy ? getSpawnFamily(spec.spawnEnemy.familyId) : null;

  const pickMirrored = (): { templateId: string | null; y: number } => {
    if (roster.length === 0) {
      return { templateId: null, y: 0 };
    }
    const idx = Math.floor(spawnRng() * roster.length);
    const templateId = roster[Math.max(0, Math.min(roster.length - 1, idx))] ?? null;
    const y = 220 + spawnRng() * 260;
    return { templateId, y };
  };

  const stepSpawn = (): void => {
    if (roster.length === 0) {
      return;
    }
    const s = battle.getState();
    const alivePlayer = s.units.filter((u: any) => u.alive && u.side === "player").length;
    const aliveEnemy = s.units.filter((u: any) => u.alive && u.side === "enemy").length;
    let playerCapRemaining = Math.max(0, spawnMaxActive - alivePlayer);
    let enemyCapRemaining = Math.max(0, Math.min(s.enemyCap, spawnMaxActive) - aliveEnemy);

    if (spawnMode === "mirrored-random") {
      for (let i = 0; i < spawnBurst; i += 1) {
        const { templateId, y } = pickMirrored();
        if (!templateId) {
          continue;
        }
        const template = templateById.get(templateId) ?? null;
        const cost = template ? Number(template.gasCost ?? 0) : 0;
        if (playerCapRemaining <= 0 || enemyCapRemaining <= 0) {
          continue;
        }
        // Keep mirrored spawn truly mirrored: if either side can't pay, skip for both.
        if (playerGas < cost || s.enemyGas < cost) {
          continue;
        }
        const a = battle.arenaDeploy("player", templateId, { chargeGas: true, y, ignoreCap: true });
        const b = battle.arenaDeploy("enemy", templateId, { chargeGas: true, y, ignoreCap: true, ignoreLowGasThreshold: true });
        if (a && b) {
          playerCapRemaining -= 1;
          enemyCapRemaining -= 1;
        }
      }
      return;
    }

    let minInterval = spawnIntervalS;
    for (let i = 0; i < spawnBurst; i += 1) {
      const playerDecision = spawnFamilyPlayer
        ? spawnFamilyPlayer.pick(spec.spawnPlayer?.params ?? {}, roster, spawnRng, { gas: playerGas, capRemaining: playerCapRemaining })
        : { templateId: null, intervalS: spawnIntervalS };
      const enemyDecision = spawnFamilyEnemy
        ? spawnFamilyEnemy.pick(spec.spawnEnemy?.params ?? {}, roster, spawnRng, { gas: s.enemyGas, capRemaining: enemyCapRemaining })
        : { templateId: null, intervalS: spawnIntervalS };

      minInterval = Math.min(minInterval, playerDecision.intervalS, enemyDecision.intervalS);

      if (playerDecision.templateId && playerCapRemaining > 0) {
        const ok = battle.arenaDeploy("player", playerDecision.templateId, { chargeGas: true, ignoreCap: true });
        if (ok) {
          playerCapRemaining -= 1;
        }
      }
      if (enemyDecision.templateId && enemyCapRemaining > 0) {
        const ok = battle.arenaDeploy("enemy", enemyDecision.templateId, { chargeGas: true, ignoreCap: true, ignoreLowGasThreshold: true });
        if (ok) {
          enemyCapRemaining -= 1;
        }
      }
    }
    spawnIntervalS = Math.max(0.5, Math.min(6.0, minInterval));
  };

  while (battle.getState().active && !battle.getState().outcome && t < spec.maxSimSeconds) {
    if (allowSpawns) {
      spawnTimer += dt;
      if (spawnTimer >= spawnIntervalS) {
        spawnTimer = 0;
        stepSpawn();
      }
    }
    battle.update(dt, noKeys);
    t += dt;
    if (!scenario.withBase) {
      const s = battle.getState();
      const alivePlayer = aliveCount(s.units, "player");
      const aliveEnemy = aliveCount(s.units, "enemy");
      if (alivePlayer === 0 || aliveEnemy === 0) {
        battle.forceEnd(alivePlayer > aliveEnemy, "Unit elimination");
        break;
      }
    }
  }

  const state1 = battle.getState();
  if (state1.active && !state1.outcome) {
    if (scenario.withBase) {
      const victory = state1.enemyBase.hp <= state1.playerBase.hp;
      battle.forceEnd(victory, "Arena deadline reached");
    } else {
      const alivePlayer = aliveCount(state1.units, "player");
      const aliveEnemy = aliveCount(state1.units, "enemy");
      if (alivePlayer === aliveEnemy) {
        battle.forceEnd(false, "Arena deadline reached (no-base tie)");
      } else {
        battle.forceEnd(alivePlayer > aliveEnemy, "Arena deadline reached (no-base)");
      }
    }
  }

  const finalState = battle.getState();
  const outcome = finalState.outcome ?? { victory: false, reason: "unknown" };
  const playerGasEnd = playerGas;
  const enemyGasEnd = finalState.enemyGas;
  const onFieldPlayerEnd = computeOnFieldGasValue(finalState.units, "player", refundFactor);
  const onFieldEnemyEnd = computeOnFieldGasValue(finalState.units, "enemy", refundFactor);

  const worth0Player = playerGasStart + onFieldPlayerStart;
  const worth1Player = playerGasEnd + onFieldPlayerEnd;
  const worth0Enemy = enemyGasStart + onFieldEnemyStart;
  const worth1Enemy = enemyGasEnd + onFieldEnemyEnd;

  const reasonLower = String(outcome.reason).toLowerCase();
  const tie = reasonLower.includes("tie")
    || reasonLower.includes("round deadline");

  const playerOutcome: "win" | "tie" | "loss" = tie ? "tie" : Boolean(outcome.victory) ? "win" : "loss";
  const enemyOutcome: "win" | "tie" | "loss" = tie ? "tie" : Boolean(outcome.victory) ? "loss" : "win";

  return {
    spec,
    simSecondsElapsed: t,
    outcome: { playerVictory: Boolean(outcome.victory), reason: String(outcome.reason) },
    sides: {
      player: {
        win: Boolean(outcome.victory),
        tie,
        gasStart: playerGasStart,
        gasEnd: playerGasEnd,
        onFieldGasValueStart: onFieldPlayerStart,
        onFieldGasValueEnd: onFieldPlayerEnd,
        gasWorthDelta: worth1Player - worth0Player,
        score: scoreFor(playerOutcome, worth1Player - worth0Player),
      },
      enemy: {
        win: !Boolean(outcome.victory) && !tie,
        tie,
        gasStart: enemyGasStart,
        gasEnd: enemyGasEnd,
        onFieldGasValueStart: onFieldEnemyStart,
        onFieldGasValueEnd: onFieldEnemyEnd,
        gasWorthDelta: worth1Enemy - worth0Enemy,
        score: scoreFor(enemyOutcome, worth1Enemy - worth0Enemy),
      },
    },
    replay: {
      seed: spec.seed,
      maxSimSeconds: spec.maxSimSeconds,
      nodeDefense: spec.nodeDefense,
      playerGas: spec.playerGas,
      enemyGas: spec.enemyGas,
      aiPlayer: spec.aiPlayer,
      aiEnemy: spec.aiEnemy,
    },
  };
}
