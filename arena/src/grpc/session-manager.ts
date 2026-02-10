import { BattleSession } from "../../../packages/game-core/src/gameplay/battle/battle-session.ts";
import type { MapNode, UnitCommand, KeyState } from "../../../packages/game-core/src/types.ts";
import { canOperate } from "../../../packages/game-core/src/simulation/units/control-unit-rules.ts";
import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  DEFAULT_GROUND_HEIGHT_RATIO,
} from "../../../packages/game-core/src/config/balance/battlefield.ts";
import { loadRuntimeMergedTemplates } from "../match/templates.ts";
import { mulberry32 } from "../lib/seeded-rng.ts";

type Side = "player" | "enemy";

type CreateBattleConfig = {
  seed?: number;
  maxSimSeconds?: number;
  nodeDefense?: number;
  baseHp?: number;
  playerGas?: number;
  enemyGas?: number;
  battlefield?: {
    width?: number;
    height?: number;
    groundHeight?: number;
  };
  scenario?: {
    withBase?: boolean;
    initialUnitsPerSide?: number;
  };
  externalAiSides?: {
    player?: boolean;
    enemy?: boolean;
  };
};

type PendingUnit = {
  unit_id: string;
  side: Side;
  type: "ground" | "air";
  alive: boolean;
  can_operate: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  weapon_count: number;
};

export type UnitStepCommand = {
  unit_id: string;
  move?: { dir_x?: number; dir_y?: number; allow_descend?: boolean };
  facing?: number;
  fire_requests?: Array<{
    slot: number;
    aim_x: number;
    aim_y: number;
    intended_target_id?: string;
    intended_target_y?: number;
  }>;
};

export type BattleStepResponse = {
  battle_id: string;
  tick: number;
  dt_seconds: number;
  snapshot_json: string;
  pending_units: PendingUnit[];
  terminal: boolean;
  outcome?: { victory: boolean; reason: string };
  errors: string[];
};

type Session = {
  id: string;
  seed: number;
  createdAtMs: number;
  updatedAtMs: number;
  tick: number;
  dt: number;
  simSecondsElapsed: number;
  maxSimSeconds: number;
  scenarioWithBase: boolean;
  playerGasRef: { value: number };
  battle: BattleSession;
};

const NO_KEYS: KeyState = { a: false, d: false, w: false, s: false, space: false };

function createMockCanvas(width: number, height: number): HTMLCanvasElement {
  const contextStub = {} as CanvasRenderingContext2D;
  return {
    width,
    height,
    getContext: (type: string) => (type === "2d" ? contextStub : null),
  } as unknown as HTMLCanvasElement;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseFacing(value: number | undefined): 1 | -1 | null {
  if (value === 1) return 1;
  if (value === -1) return -1;
  return null;
}

function aliveCount(units: Array<{ side: Side; alive: boolean }>, side: Side): number {
  let count = 0;
  for (const unit of units) {
    if (unit.alive && unit.side === side) {
      count += 1;
    }
  }
  return count;
}

export class ArenaSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly templatesPromise: Promise<any[]>;

  constructor() {
    this.templatesPromise = loadRuntimeMergedTemplates();
  }

  public async createBattle(config: CreateBattleConfig): Promise<BattleStepResponse> {
    const templates = await this.templatesPromise;
    const seed = Number.isFinite(config.seed) ? Number(config.seed) : Date.now() % 1_000_000;
    const maxSimSeconds = Number.isFinite(config.maxSimSeconds) ? Number(config.maxSimSeconds) : 240;
    const nodeDefense = Number.isFinite(config.nodeDefense) ? Number(config.nodeDefense) : 1;
    const withBase = config.scenario?.withBase !== false;
    const initialUnitsPerSide = Math.max(1, Math.floor(config.scenario?.initialUnitsPerSide ?? 2));
    const width = clampInt(Number(config.battlefield?.width ?? BATTLEFIELD_WIDTH), 640, 4096);
    const height = clampInt(Number(config.battlefield?.height ?? BATTLEFIELD_HEIGHT), 360, 2160);
    const groundHeight = clampInt(
      Number(config.battlefield?.groundHeight ?? Math.floor(height * DEFAULT_GROUND_HEIGHT_RATIO)),
      80,
      Math.max(120, height - 40),
    );
    const playerGasStart = Number.isFinite(config.playerGas) ? Number(config.playerGas) : 10000;
    const enemyGasStart = Number.isFinite(config.enemyGas) ? Number(config.enemyGas) : 10000;
    const baseHp = Number.isFinite(config.baseHp) && Number(config.baseHp) > 0 ? Number(config.baseHp) : null;
    const externalAiSides = {
      player: config.externalAiSides?.player !== false,
      enemy: config.externalAiSides?.enemy !== false,
    };

    const canvas = createMockCanvas(width, height);
    const playerGasRef = { value: playerGasStart };
    const hooks = {
      addLog: (_text: string): void => undefined,
      getCommanderSkill: (): number => 10,
      getPlayerGas: (): number => playerGasRef.value,
      spendPlayerGas: (amount: number): boolean => {
        if (playerGasRef.value < amount) {
          return false;
        }
        playerGasRef.value -= amount;
        return true;
      },
      addPlayerGas: (amount: number): void => {
        playerGasRef.value += amount;
      },
      onBattleOver: (): void => undefined,
    };
    const battle = new BattleSession(canvas, hooks, templates, {
      autoEnableAiWeaponAutoFire: true,
      disableAutoEnemySpawns: true,
      disableEnemyMinimumPresence: true,
      disableDefaultStarters: true,
      externalAiSides,
    });
    battle.setBattlefieldSize(width, height);
    battle.setGroundHeight(groundHeight);

    const node: MapNode = {
      id: "grpc-arena",
      name: "gRPC Arena",
      owner: "neutral",
      garrison: false,
      reward: 0,
      defense: nodeDefense,
      ...(baseHp ? { testBaseHpOverride: baseHp } : !withBase ? { testBaseHpOverride: 5_000_000 } : {}),
    };
    battle.start(node);
    battle.clearControlSelection();
    const state0 = battle.getState();
    state0.enemyGas = withBase ? enemyGasStart : 0;
    if (!withBase) {
      playerGasRef.value = 0;
    }

    this.spawnInitialUnits(battle, templates, seed, withBase, initialUnitsPerSide);

    const id = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const session: Session = {
      id,
      seed,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      tick: 0,
      dt: 1 / 60,
      simSecondsElapsed: 0,
      maxSimSeconds,
      scenarioWithBase: withBase,
      playerGasRef,
      battle,
    };
    this.sessions.set(id, session);
    return this.buildResponse(session, []);
  }

  public getBattle(battleId: string): BattleStepResponse {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new Error(`battle not found: ${battleId}`);
    }
    session.updatedAtMs = Date.now();
    return this.buildResponse(session, []);
  }

  public stepBattle(battleId: string, commands: UnitStepCommand[], nSteps: number): BattleStepResponse {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new Error(`battle not found: ${battleId}`);
    }
    const steps = clampInt(Number(nSteps || 1), 1, 60);
    const errors: string[] = [];
    let commandSet = this.decodeCommands(commands, errors);

    for (let i = 0; i < steps; i += 1) {
      const state = session.battle.getState();
      if (!state.active || state.outcome) {
        break;
      }
      session.battle.setExternalCommands(commandSet);
      session.battle.update(session.dt, NO_KEYS);
      session.tick += 1;
      session.simSecondsElapsed += session.dt;
      commandSet = [];

      if (session.simSecondsElapsed >= session.maxSimSeconds) {
        this.forceEndByDeadline(session);
        break;
      }
    }
    session.updatedAtMs = Date.now();
    return this.buildResponse(session, errors);
  }

  public closeBattle(battleId: string): boolean {
    return this.sessions.delete(battleId);
  }

  private forceEndByDeadline(session: Session): void {
    const state = session.battle.getState();
    if (!state.active || state.outcome) {
      return;
    }
    if (session.scenarioWithBase) {
      const victory = state.enemyBase.hp <= state.playerBase.hp;
      session.battle.forceEnd(victory, "Arena deadline reached");
      return;
    }
    const alivePlayer = aliveCount(state.units, "player");
    const aliveEnemy = aliveCount(state.units, "enemy");
    if (alivePlayer === aliveEnemy) {
      session.battle.forceEnd(false, "Arena deadline reached (no-base tie)");
    } else {
      session.battle.forceEnd(alivePlayer > aliveEnemy, "Arena deadline reached (no-base)");
    }
  }

  private spawnInitialUnits(battle: BattleSession, templates: any[], seed: number, withBase: boolean, initialUnitsPerSide: number): void {
    const availableTemplateIds = new Set<string>(templates.map((t) => String(t.id)));
    const rosterPreference = ["scout-ground", "tank-ground", "air-jet", "air-propeller", "air-light"];
    const roster = rosterPreference.filter((id) => availableTemplateIds.has(id));
    const rng = mulberry32((seed ^ 0x2f7a1d) >>> 0);
    const pickTemplateId = (): string | null => {
      if (roster.length === 0) return null;
      const idx = Math.floor(rng() * roster.length);
      return roster[Math.max(0, Math.min(roster.length - 1, idx))] ?? null;
    };
    if (withBase) {
      const starterTemplates = roster.slice(0, 2);
      for (const templateId of starterTemplates) {
        battle.arenaDeploy("player", templateId, { chargeGas: false, deploymentGasCost: 0, y: 300 });
        battle.arenaDeploy("enemy", templateId, { chargeGas: false, deploymentGasCost: 0, y: 300 });
      }
      return;
    }
    for (let i = 0; i < initialUnitsPerSide; i += 1) {
      const templateId = pickTemplateId();
      if (!templateId) continue;
      const y = 220 + rng() * 260;
      battle.arenaDeploy("player", templateId, { chargeGas: false, deploymentGasCost: 0, y });
      battle.arenaDeploy("enemy", templateId, { chargeGas: false, deploymentGasCost: 0, y });
    }
  }

  private decodeCommands(commands: UnitStepCommand[], errors: string[]): Array<{ unitId: string; command: UnitCommand }> {
    const out: Array<{ unitId: string; command: UnitCommand }> = [];
    for (const entry of commands ?? []) {
      const unitId = typeof entry.unit_id === "string" ? entry.unit_id.trim() : "";
      if (!unitId) {
        errors.push("command missing unit_id");
        continue;
      }
      const move = entry.move ?? {};
      const dirX = clampFloat(Number(move.dir_x ?? 0), -1.5, 1.5);
      const dirY = clampFloat(Number(move.dir_y ?? 0), -1.5, 1.5);
      const fire = Array.isArray(entry.fire_requests)
        ? entry.fire_requests.map((req) => ({
            slot: Math.floor(Number(req.slot ?? -1)),
            aimX: Number(req.aim_x ?? 0),
            aimY: Number(req.aim_y ?? 0),
            intendedTargetId: typeof req.intended_target_id === "string" && req.intended_target_id.length > 0 ? req.intended_target_id : null,
            intendedTargetY: Number.isFinite(req.intended_target_y) ? Number(req.intended_target_y) : null,
            manual: false,
          }))
        : [];
      const command: UnitCommand = {
        move: { dirX, dirY, allowDescend: move.allow_descend === true },
        facing: parseFacing(Number(entry.facing ?? 0)),
        fire,
      };
      out.push({ unitId, command });
    }
    return out;
  }

  private buildResponse(session: Session, errors: string[]): BattleStepResponse {
    const state = session.battle.getState();
    const info = session.battle.getBattlefieldInfo();
    const pendingUnits = session.battle.getPendingExternalAiUnits().map((unit): PendingUnit => ({
      unit_id: unit.id,
      side: unit.side,
      type: unit.type,
      alive: unit.alive,
      can_operate: canOperate(unit),
      x: unit.x,
      y: unit.y,
      vx: unit.vx,
      vy: unit.vy,
      weapon_count: unit.weaponAttachmentIds.length,
    }));
    const snapshot = {
      schema_version: "arena.v1",
      feature_schema_version: "v1",
      battle_id: session.id,
      seed: session.seed,
      tick: session.tick,
      dt_seconds: session.dt,
      sim_time_seconds: session.simSecondsElapsed,
      max_sim_seconds: session.maxSimSeconds,
      player_gas: session.playerGasRef.value,
      enemy_gas: state.enemyGas,
      battlefield: info,
      state,
    };
    return {
      battle_id: session.id,
      tick: session.tick,
      dt_seconds: session.dt,
      snapshot_json: JSON.stringify(snapshot),
      pending_units: pendingUnits,
      terminal: !state.active || Boolean(state.outcome),
      ...(state.outcome ? { outcome: { victory: state.outcome.victory, reason: state.outcome.reason } } : {}),
      errors,
    };
  }
}
