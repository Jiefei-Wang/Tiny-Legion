import type { MatchResult, MatchSpec } from "./match-types.ts";
import { setMathRandomSeed } from "../lib/seeded-rng.ts";
import { loadRuntimeMergedParts, loadRuntimeMergedTemplates } from "./templates.ts";
import { mulberry32 } from "../lib/seeded-rng.ts";
import { getSpawnFamily } from "../spawn/families.ts";
import { BattleSession } from "../../../game-core/src/gameplay/battle/battle-session.ts";
import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  BATTLE_SALVAGE_REFUND_FACTOR,
} from "../../../game-core/src/config/balance/battlefield.ts";
import { makeCompositeAiController } from "../ai/composite-controller.ts";
import { structureIntegrity } from "../../../game-core/src/simulation/units/structure-grid.ts";
import { canOperate } from "../../../game-core/src/simulation/units/control-unit-rules.ts";
import { validateTemplateDetailed } from "../../../game-core/src/templates/template-validation.ts";
import type { UnitTemplate } from "../../../game-core/src/types.ts";
import type { SpawnRosterEntry } from "../spawn/spawn-schema.ts";
import { resetUidCounter } from "../../../game-core/src/core/ids/uid.ts";

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
    if (!unit || !unit.alive || !canOperate(unit) || unit.side !== side) {
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
  return units.filter((unit: any) => unit.alive && canOperate(unit) && unit.side === side).length;
}

export async function runMatch(spec: MatchSpec): Promise<MatchResult> {
  setMathRandomSeed(spec.seed);
  resetUidCounter();
  const partCatalog = loadRuntimeMergedParts();
  const allTemplates = await loadRuntimeMergedTemplates(partCatalog);
  const templatePatterns = Array.isArray(spec.templateNames) && spec.templateNames.length > 0
    ? spec.templateNames
    : ["*"];
  const templates = allTemplates.filter((template) => {
    const id = String(template?.id ?? "");
    const name = String(template?.name ?? "");
    if (!id && !name) {
      return false;
    }
    return templatePatterns.some((pattern) => {
      const normalized = String(pattern);
      return matchesTemplatePattern(id, normalized) || matchesTemplatePattern(name, normalized);
    });
  });
  const validTemplates = templates.filter((template) => validateTemplateDetailed(template, { partCatalog }).errors.length === 0);
  if (validTemplates.length <= 0) {
    throw new Error(`runMatch: no templates matched pattern(s): ${templatePatterns.join(", ")}`);
  }
  const templateById = new Map<number, UnitTemplate>(validTemplates.map((template) => [template.id, template] as const));
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

  const battlefieldWidth = Math.max(640, Math.floor(spec.battlefield?.width ?? BATTLEFIELD_WIDTH));
  const battlefieldHeight = Math.max(360, Math.floor(spec.battlefield?.height ?? BATTLEFIELD_HEIGHT));
  const canvas = createMockCanvas(battlefieldWidth, battlefieldHeight);
  const battle = new BattleSession(canvas, hooks, validTemplates, {
    aiControllers: {
      player: aiForSide("player"),
      enemy: aiForSide("enemy"),
    },
    autoEnableAiWeaponAutoFire: true,
    disableAutoEnemySpawns: true,
    disableEnemyMinimumPresence: true,
    disableDefaultStarters: true,
    partCatalog,
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

  const roster = Array.from(new Set(validTemplates.map((template) => template.id))).sort((a, b) => a - b);
  const spawnRoster: SpawnRosterEntry[] = validTemplates.map((template) => ({
    templateId: String(template.id),
    gasCost: Math.max(0, template.gasCost),
    unitType: template.type,
    structureCells: template.structure.length,
    weaponCount: template.attachments.filter((attachment) => {
      const part = partCatalog.find((candidate) => candidate.id === attachment.partId);
      return part?.partType === "weapon";
    }).length,
  }));

  const spawnRng = mulberry32((spec.seed ^ 0x2f7a1d) >>> 0);

  if (scenario.initialLineup) {
    for (const side of ["player", "enemy"] as const) {
      const lineup = scenario.initialLineup[side];
      const template = templateById.get(lineup.templateId);
      if (!template) {
        throw new Error(`runMatch: initial lineup template ${lineup.templateId} is unavailable for ${side}`);
      }
      const count = Math.max(1, Math.floor(lineup.count));
      for (let index = 0; index < count; index += 1) {
        const y = 220 + spawnRng() * 260;
        const deployed = battle.arenaDeploy(side, template.id, {
          chargeGas: false,
          ignoreCap: true,
          ignoreLowGasThreshold: true,
          y,
        });
        if (!deployed) {
          throw new Error(`runMatch: could not deploy ${side} lineup unit ${index + 1}/${count}`);
        }
      }
    }
  } else if (scenario.withBase) {
    // Symmetric starters (free and non-refundable, like headless smoke test semantics).
    const unitsPerSide = Math.max(1, Math.floor(scenario.initialUnitsPerSide));
    const starterRoster = [...roster];
    for (let index = starterRoster.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(spawnRng() * (index + 1));
      [starterRoster[index], starterRoster[swapIndex]] = [starterRoster[swapIndex]!, starterRoster[index]!];
    }
    for (let index = 0; index < unitsPerSide; index += 1) {
      const templateId = starterRoster[index % starterRoster.length] ?? null;
      if (!templateId) continue;
      const y = 220 + spawnRng() * 260;
      battle.arenaDeploy("player", templateId, { chargeGas: false, deploymentGasCost: 0, y });
      battle.arenaDeploy("enemy", templateId, { chargeGas: false, deploymentGasCost: 0, y });
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

  const pickMirrored = (): { templateId: number | null; y: number } => {
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
    const alivePlayer = s.units.filter((u: any) => u.alive && canOperate(u) && u.side === "player").length;
    const aliveEnemy = s.units.filter((u: any) => u.alive && canOperate(u) && u.side === "enemy").length;
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
        ? spawnFamilyPlayer.pick(spec.spawnPlayer?.params ?? {}, spawnRoster, spawnRng, { gas: playerGas, capRemaining: playerCapRemaining })
        : { templateId: null, intervalS: spawnIntervalS };
      const enemyDecision = spawnFamilyEnemy
        ? spawnFamilyEnemy.pick(spec.spawnEnemy?.params ?? {}, spawnRoster, spawnRng, { gas: s.enemyGas, capRemaining: enemyCapRemaining })
        : { templateId: null, intervalS: spawnIntervalS };

      minInterval = Math.min(minInterval, playerDecision.intervalS, enemyDecision.intervalS);

      if (playerDecision.templateId && playerCapRemaining > 0) {
        const playerTemplateId = Number.parseInt(playerDecision.templateId, 10);
        if (!Number.isInteger(playerTemplateId) || playerTemplateId < 1) {
          continue;
        }
        const ok = battle.arenaDeploy("player", playerTemplateId, { chargeGas: true, ignoreCap: true });
        if (ok) {
          playerCapRemaining -= 1;
        }
      }
      if (enemyDecision.templateId && enemyCapRemaining > 0) {
        const enemyTemplateId = Number.parseInt(enemyDecision.templateId, 10);
        if (!Number.isInteger(enemyTemplateId) || enemyTemplateId < 1) {
          continue;
        }
        const ok = battle.arenaDeploy("enemy", enemyTemplateId, { chargeGas: true, ignoreCap: true, ignoreLowGasThreshold: true });
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
      const baseHpDelta = state1.playerBase.hp - state1.enemyBase.hp;
      const integrityFor = (side: "player" | "enemy"): number => state1.units
        .filter((unit) => unit.alive && canOperate(unit) && unit.side === side)
        .reduce((total, unit) => total + structureIntegrity(unit), 0);
      const integrityDelta = integrityFor("player") - integrityFor("enemy");
      if (Math.abs(baseHpDelta) > 1e-6) {
        battle.forceEnd(baseHpDelta > 0, "Arena deadline reached (base HP)");
      } else if (Math.abs(integrityDelta) > 1e-6) {
        battle.forceEnd(integrityDelta > 0, "Arena deadline reached (unit integrity)");
      } else {
        battle.forceEnd(false, "Arena deadline reached (tie)");
      }
    } else {
      const alivePlayer = aliveCount(state1.units, "player");
      const aliveEnemy = aliveCount(state1.units, "enemy");
      if (alivePlayer !== aliveEnemy) {
        battle.forceEnd(alivePlayer > aliveEnemy, "Arena deadline reached (no-base)");
      } else {
        const integrityFor = (side: "player" | "enemy"): number => state1.units
          .filter((unit) => unit.alive && canOperate(unit) && unit.side === side)
          .reduce((total, unit) => total + structureIntegrity(unit), 0);
        const playerIntegrity = integrityFor("player");
        const enemyIntegrity = integrityFor("enemy");
        if (Math.abs(playerIntegrity - enemyIntegrity) <= 1e-6) {
          battle.forceEnd(false, "Arena deadline reached (no-base tie)");
        } else {
          battle.forceEnd(playerIntegrity > enemyIntegrity, "Arena deadline reached (no-base integrity)");
        }
      }
    }
  }

  const finalState = battle.getState();
  const outcome = finalState.outcome ?? { victory: false, reason: "unknown" };
  const losses = battle.getLossStats();
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
  const operationalUnits = (side: "player" | "enemy") => finalState.units
    .filter((unit) => unit.alive && canOperate(unit) && unit.side === side);
  const playerOperationalUnits = operationalUnits("player");
  const enemyOperationalUnits = operationalUnits("enemy");

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
    final: {
      playerBaseHp: finalState.playerBase.hp,
      enemyBaseHp: finalState.enemyBase.hp,
      playerOperationalUnits: playerOperationalUnits.length,
      enemyOperationalUnits: enemyOperationalUnits.length,
      playerUnitIntegrity: playerOperationalUnits.reduce((total, unit) => total + structureIntegrity(unit), 0),
      enemyUnitIntegrity: enemyOperationalUnits.reduce((total, unit) => total + structureIntegrity(unit), 0),
    },
    losses,
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
