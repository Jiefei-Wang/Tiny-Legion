import { armyCap } from "../../config/balance/commander.ts";
import {
  DEFAULT_UNIT_MOVEMENT_SPEED_MULTIPLIER,
  DEFAULT_GROUND_HEIGHT_RATIO,
  AIR_MIN_Z_RATIO,
  AIR_GROUND_GAP_RATIO,
  AIR_TARGET_Z_TOLERANCE_RATIO,
  AIR_HOLD_GRAVITY,
  AIR_DROP_GRAVITY,
  AIR_DROP_SPEED_CAP,
  AIR_POWER_TO_SPEED_SCALE,
  AIRCRAFT_ACCELERATION_RATIO,
  GROUND_PROJECTILE_MAX_DROP_BELOW_FIRE_Y,
  BATTLE_SALVAGE_REFUND_FACTOR,
  PENETRATION_ARMOR_SCALER,
  GROUND_WRECK_LIFETIME_SECONDS,
  GROUND_WRECK_MIN_INITIAL_HP_LOSS_RATIO,
  GROUND_WRECK_MAX_INITIAL_HP_LOSS_RATIO,
  getStructureCellSize,
  UNIT_SEPARATION_ENABLED,
  UNIT_OVERLAP_ALLOWANCE_RATIO,
  UNIT_SEPARATION_POSITION_FACTOR,
  UNIT_SEPARATION_VELOCITY_DAMPING,
  UNIT_SEPARATION_GRID_SIZE,
  UNIT_SPAWN_PLACEMENT_ATTEMPTS,
} from "../../config/balance/battlefield.ts";
import { COMPONENTS } from "../../config/balance/weapons.ts";
import {
  AI_TARGET_HISTORY_SAMPLE_INTERVAL_S,
  AI_TARGET_HISTORY_SAMPLES,
  GLOBAL_WEAPON_RANGE_MULTIPLIER,
  PROJECTILE_GRAVITY,
  PROJECTILE_SPEED,
  getAircraftAltitudeBonus,
} from "../../config/balance/range.ts";
import { applyHitToUnit, applyStructureRecovery, scaleDamageByRemainingPenetration } from "../../simulation/combat/damage-model.ts";
import { applyRecoilForAttachment, getAliveWeaponAttachments } from "../../simulation/combat/recoil.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";
import { canOperate } from "../../simulation/units/control-unit-rules.ts";
import { destroyCell } from "../../simulation/units/structure-grid.ts";
import { instantiateUnit } from "../../simulation/units/unit-builder.ts";
import { selectBestTarget } from "../../ai/targeting/target-selector.ts";
import { createBaselineCompositeAiController } from "../../ai/composite/baseline-modules.ts";
import { validateTemplateDetailed } from "../../templates/template-validation.ts";
import { createDefaultPartDefinitions, mergePartCatalogs, normalizePartAttachmentRotate } from "../../parts/part-schema.ts";
import { PROJECTILE_ASSETS } from "../../projectiles/generated/projectile-assets.generated.ts";
import type { BattleAiController, CombatDecision, WeaponFireAiInput } from "../../ai/composite/composite-ai.ts";
import type {
  BattleState,
  CommandResult,
  ComponentId,
  ComponentStats,
  FireBlockDetail,
  FireRequest,
  FireSoundPool,
  KeyState,
  MapNode,
  PartDefinition,
  PartDirection,
  ProjectileClass,
  Side,
  UnitCommand,
  UnitInstance,
  UnitTemplate,
} from "../../types.ts";

export interface BattleHooks {
  addLog: (text: string, tone?: "good" | "warn" | "bad" | "") => void;
  getCommanderSkill: () => number;
  getPlayerGas: () => number;
  spendPlayerGas: (amount: number) => boolean;
  addPlayerGas: (amount: number) => void;
  onBattleOver: (victory: boolean, nodeId: string, reason: string) => void;
}

export type { BattleAiController, BattleAiInput, CombatDecision } from "../../ai/composite/composite-ai.ts";

export interface BattleSessionOptions {
  aiControllers?: Partial<Record<Side, BattleAiController>>;
  autoEnableAiWeaponAutoFire?: boolean;
  disableAutoEnemySpawns?: boolean;
  disableEnemyMinimumPresence?: boolean;
  disableDefaultStarters?: boolean;
  externalAiSides?: Partial<Record<Side, boolean>>;
  partCatalog?: ReadonlyArray<PartDefinition>;
  movementSpeedMultiplier?: number;
}

export type BattleAudioEvent =
  | {
      kind: "fire";
      x: number;
      y: number;
      projectileClass: ProjectileClass;
      fireSoundPool: FireSoundPool;
      damage: number;
      projectileSpeed: number;
      volume: number;
    }
  | {
      kind: "impact";
      x: number;
      y: number;
      projectileClass: ProjectileClass;
      impactSoundPool: FireSoundPool;
      materialColor: string;
      armor: number;
      incomingDamage: number;
      deliveredDamage: number;
    }
  | { kind: "explosion"; x: number; y: number; intensity: number; radius: number };

export interface BattleLossStats {
  player: { destroyedObjects: number; gasWasted: number };
  enemy: { destroyedObjects: number; gasWasted: number };
}

type UnitProjectileHit = {
  structureCellId: number;
  ignoreArmor: boolean;
};

export class BattleSession {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hooks: BattleHooks;
  private readonly templates: UnitTemplate[];
  private aiControllers: Partial<Record<Side, BattleAiController>>;
  private readonly autoEnableAiWeaponAutoFire: boolean;
  private readonly disableAutoEnemySpawns: boolean;
  private readonly disableEnemyMinimumPresence: boolean;
  private readonly disableDefaultStarters: boolean;
  private externalAiSides: Partial<Record<Side, boolean>>;
  private externalCommandsByUnitId: Map<string, UnitCommand>;
  private partCatalog: PartDefinition[];
  private state: BattleState;
  private selectedUnitId: string | null;
  private playerControlledId: string | null;
  private aimX: number;
  private aimY: number;
  private controllerAimAngleRad: number | null;
  private manualFireHeld: boolean;
  private displayEnabled: boolean;
  private debugDrawEnabled: boolean;
  private debugTargetLineEnabled: boolean;
  private debugPartHpEnabled: boolean;
  private controlledUnitInvincible: boolean;
  private enemySpawnTemplateAllowList: Set<number> | null;
  private autoSpawnEnemyTemplateOnPlayerSide: boolean;
  private autoSpawnPlayerSideEnabled: boolean;
  private autoSpawnPlayerTargetCount: number;
  private playerSpawnTemplateAllowList: Set<number> | null;
  private groundHeightPx: number;
  private readonly baselineController: BattleAiController;
  private audioEvents: BattleAudioEvent[];
  private movementSpeedMultiplier: number;
  private lossStats: BattleLossStats;

  constructor(canvas: HTMLCanvasElement, hooks: BattleHooks, templates: UnitTemplate[], options: BattleSessionOptions = {}) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2D canvas context unavailable");
    }
    this.canvas = canvas;
    this.ctx = context;
    this.hooks = hooks;
    this.templates = templates;
    this.aiControllers = options.aiControllers ?? {};
    this.autoEnableAiWeaponAutoFire = options.autoEnableAiWeaponAutoFire ?? false;
    this.disableAutoEnemySpawns = options.disableAutoEnemySpawns ?? false;
    this.disableEnemyMinimumPresence = options.disableEnemyMinimumPresence ?? false;
    this.disableDefaultStarters = options.disableDefaultStarters ?? false;
    this.externalAiSides = {
      player: options.externalAiSides?.player === true,
      enemy: options.externalAiSides?.enemy === true,
    };
    this.externalCommandsByUnitId = new Map<string, UnitCommand>();
    this.partCatalog = options.partCatalog && options.partCatalog.length > 0
      ? mergePartCatalogs(createDefaultPartDefinitions(), options.partCatalog)
      : createDefaultPartDefinitions();
    this.state = this.createEmptyBattle();
    this.selectedUnitId = null;
    this.playerControlledId = null;
    this.aimX = canvas.width * 0.7;
    this.aimY = canvas.height * 0.5;
    this.controllerAimAngleRad = null;
    this.manualFireHeld = false;
    this.displayEnabled = false;
    this.debugDrawEnabled = false;
    this.debugTargetLineEnabled = false;
    this.debugPartHpEnabled = false;
    this.controlledUnitInvincible = false;
    this.enemySpawnTemplateAllowList = null;
    this.autoSpawnEnemyTemplateOnPlayerSide = false;
    this.autoSpawnPlayerSideEnabled = false;
    this.autoSpawnPlayerTargetCount = 0;
    this.playerSpawnTemplateAllowList = null;
    this.groundHeightPx = Math.max(80, canvas.height * DEFAULT_GROUND_HEIGHT_RATIO);
    this.baselineController = createBaselineCompositeAiController();
    this.audioEvents = [];
    this.movementSpeedMultiplier = this.normalizeMovementSpeedMultiplier(options.movementSpeedMultiplier);
    this.lossStats = this.createEmptyLossStats();
  }

  public getMovementSpeedMultiplier(): number {
    return this.movementSpeedMultiplier;
  }

  public setMovementSpeedMultiplier(multiplier: number): number {
    this.movementSpeedMultiplier = this.normalizeMovementSpeedMultiplier(multiplier);
    return this.movementSpeedMultiplier;
  }

  public getState(): BattleState {
    return this.state;
  }

  public getLossStats(): BattleLossStats {
    return {
      player: { ...this.lossStats.player },
      enemy: { ...this.lossStats.enemy },
    };
  }

  public getSelection(): { selectedUnitId: string | null; playerControlledId: string | null } {
    return { selectedUnitId: this.selectedUnitId, playerControlledId: this.playerControlledId };
  }

  public setAiControllers(aiControllers: Partial<Record<Side, BattleAiController>>): void {
    this.aiControllers = aiControllers;
  }

  public setExternalAiSides(sides: Partial<Record<Side, boolean>>): void {
    this.externalAiSides = {
      player: sides.player === true,
      enemy: sides.enemy === true,
    };
  }

  public clearExternalCommands(): void {
    this.externalCommandsByUnitId.clear();
  }

  public setExternalCommands(commands: ReadonlyArray<{ unitId: string; command: UnitCommand }>): void {
    this.externalCommandsByUnitId.clear();
    for (const entry of commands) {
      if (!entry || typeof entry.unitId !== "string" || entry.unitId.length <= 0) {
        continue;
      }
      this.externalCommandsByUnitId.set(entry.unitId, entry.command);
    }
  }

  public getPendingExternalAiUnits(side?: Side): UnitInstance[] {
    const pending: UnitInstance[] = [];
    for (const unit of this.state.units) {
      if (!unit.alive || !canOperate(unit)) {
        continue;
      }
      if (side && unit.side !== side) {
        continue;
      }
      if (!this.isExternalAiEnabled(unit.side)) {
        continue;
      }
      if (unit.side === "player" && unit.id === this.playerControlledId) {
        continue;
      }
      if (unit.airDropActive) {
        continue;
      }
      if (!this.hasAvailableWeapons(unit)) {
        continue;
      }
      pending.push(unit);
    }
    return pending;
  }

  public getBattlefieldInfo(): {
    width: number;
    height: number;
    groundHeight: number;
    laneBounds: { airMinZ: number; airMaxZ: number; groundMinY: number; groundMaxY: number; airTargetTolerance: number };
  } {
    return {
      width: this.canvas.width,
      height: this.canvas.height,
      groundHeight: Math.floor(this.groundHeightPx),
      laneBounds: this.getLaneBounds(),
    };
  }

  public isDisplayEnabled(): boolean {
    return this.displayEnabled;
  }

  public setDisplayLayerEnabled(enabled: boolean): void {
    const next = enabled === true;
    if (this.displayEnabled === next) {
      return;
    }
    this.displayEnabled = next;
    this.hooks.addLog(this.displayEnabled ? "Display layer ON" : "Display layer OFF", "warn");
  }

  public toggleDisplayLayer(): void {
    this.setDisplayLayerEnabled(!this.displayEnabled);
  }

  public isPartHpOverlayEnabled(): boolean {
    return this.debugPartHpEnabled;
  }

  public getRenderOptions(): {
    displayLayer: boolean;
    debugDraw: boolean;
    debugTargetLines: boolean;
    debugPartHp: boolean;
  } {
    return {
      displayLayer: this.displayEnabled,
      debugDraw: this.debugDrawEnabled,
      debugTargetLines: this.debugTargetLineEnabled,
      debugPartHp: this.debugPartHpEnabled,
    };
  }

  public setDebugPartHpEnabled(enabled: boolean): void {
    this.debugPartHpEnabled = enabled === true;
  }

  public setDebugDrawEnabled(enabled: boolean): void {
    this.debugDrawEnabled = enabled;
  }

  public setDebugTargetLineEnabled(enabled: boolean): void {
    this.debugTargetLineEnabled = enabled;
  }

  public setPartCatalog(partCatalog: ReadonlyArray<PartDefinition>): void {
    this.partCatalog = partCatalog.length > 0
      ? mergePartCatalogs(createDefaultPartDefinitions(), partCatalog)
      : createDefaultPartDefinitions();
  }

  public isControlledUnitInvincible(): boolean {
    return this.controlledUnitInvincible;
  }

  public setControlledUnitInvincible(enabled: boolean): void {
    this.controlledUnitInvincible = enabled === true;
  }

  public getAliveEnemyCount(): number {
    return this.state.units.filter((unit) => unit.side === "enemy" && unit.alive && canOperate(unit)).length;
  }

  public getAlivePlayerCount(): number {
    return this.state.units.filter((unit) => unit.side === "player" && unit.alive && canOperate(unit)).length;
  }

  public setEnemyActiveCount(targetCount: number): number {
    const normalizedTarget = clamp(Math.floor(targetCount), 0, 40);
    this.state.enemyMinActive = normalizedTarget;
    this.state.enemyCap = normalizedTarget;
    if (!this.state.active || this.state.outcome) {
      return this.getAliveEnemyCount();
    }

    const aliveEnemies = this.state.units.filter((unit) => unit.side === "enemy" && unit.alive && canOperate(unit));
    if (aliveEnemies.length > normalizedTarget) {
      const removeCount = aliveEnemies.length - normalizedTarget;
      for (let i = 0; i < removeCount; i += 1) {
        const enemy = aliveEnemies[aliveEnemies.length - 1 - i];
        if (!enemy) {
          continue;
        }
        enemy.alive = false;
      }
      this.state.units = this.state.units.filter((unit) => unit.alive);
    }

    let aliveCount = this.getAliveEnemyCount();
    let attempts = 0;
    const maxAttempts = Math.max(4, normalizedTarget * 4);
    while (aliveCount < normalizedTarget && attempts < maxAttempts) {
      const spawned = this.maybeSpawnEnemy();
      if (!spawned) {
        break;
      }
      aliveCount += 1;
      attempts += 1;
    }
    return this.getAliveEnemyCount();
  }

  public clearAllUnits(): number {
    const removed = this.state.units.length;
    if (removed <= 0) {
      return 0;
    }
    this.state.units = [];
    this.clearControlSelection();
    return removed;
  }

  public spawnEnemyTemplate(templateId: number): boolean {
    return this.arenaDeploy("enemy", templateId, { chargeGas: false, ignoreCap: true, ignoreLowGasThreshold: true });
  }

  public setEnemySpawnTemplateFilter(templateIds: ReadonlyArray<number> | null): number[] {
    if (templateIds === null) {
      this.enemySpawnTemplateAllowList = null;
      return [];
    }
    const validIds = new Set<number>(this.templates.map((template) => template.id));
    const normalized: number[] = [];
    for (const id of templateIds) {
      if (!validIds.has(id)) {
        continue;
      }
      if (normalized.includes(id)) {
        continue;
      }
      normalized.push(id);
    }
    this.enemySpawnTemplateAllowList = new Set<number>(normalized);
    return normalized;
  }

  public setAutoSpawnEnemyTemplateOnPlayerSide(enabled: boolean): void {
    this.autoSpawnEnemyTemplateOnPlayerSide = enabled === true;
  }

  public setPlayerAutoSpawnEnabled(enabled: boolean): void {
    this.autoSpawnPlayerSideEnabled = enabled === true;
  }

  public setPlayerAutoSpawnTargetCount(targetCount: number): number {
    this.autoSpawnPlayerTargetCount = clamp(Math.floor(targetCount), 0, 40);
    return this.autoSpawnPlayerTargetCount;
  }

  public setPlayerSpawnTemplateFilter(templateIds: ReadonlyArray<number> | null): number[] {
    if (templateIds === null) {
      this.playerSpawnTemplateAllowList = null;
      return [];
    }
    const validIds = new Set<number>(this.templates.map((template) => template.id));
    const normalized: number[] = [];
    for (const id of templateIds) {
      if (!validIds.has(id)) {
        continue;
      }
      if (normalized.includes(id)) {
        continue;
      }
      normalized.push(id);
    }
    this.playerSpawnTemplateAllowList = new Set<number>(normalized);
    return normalized;
  }

  public syncAutoSpawnTargets(): void {
    this.ensureEnemyMinimumPresence();
    this.ensurePlayerMinimumPresence();
  }

  public setBattlefieldSize(width: number, height: number): { width: number; height: number } {
    const normalizedWidth = clamp(Math.floor(width), 640, 4096);
    const normalizedHeight = clamp(Math.floor(height), 360, 2160);
    this.canvas.width = normalizedWidth;
    this.canvas.height = normalizedHeight;
    this.groundHeightPx = clamp(this.groundHeightPx, 80, Math.max(120, this.canvas.height - 40));
    this.relayoutBasesPreservingHp();

    this.aimX = clamp(this.aimX, 0, this.canvas.width);
    this.aimY = clamp(this.aimY, 0, this.canvas.height);
    this.clampEntitiesToBattlefield();
    return { width: this.canvas.width, height: this.canvas.height };
  }

  public setGroundHeight(height: number): number {
    const normalized = clamp(Math.floor(height), 80, Math.max(120, this.canvas.height - 40));
    this.groundHeightPx = normalized;
    this.relayoutBasesPreservingHp();
    this.clampEntitiesToBattlefield();
    return this.groundHeightPx;
  }

  public getGroundHeight(): number {
    return Math.floor(this.groundHeightPx);
  }

  public setAim(mouseX: number, mouseY: number): void {
    this.aimX = clamp(mouseX, 0, this.canvas.width);
    this.aimY = clamp(mouseY, 0, this.canvas.height);
    this.controllerAimAngleRad = null;
  }

  public setControlByClick(mouseX: number, mouseY: number): void {
    if (!this.state.active) {
      return;
    }
    const lockedControlled = this.getControlledUnit();
    if (lockedControlled?.airDropActive) {
      this.clearControlSelection();
    }
    if (lockedControlled && this.hasAvailableWeapons(lockedControlled)) {
      this.setAim(mouseX, mouseY);
      return;
    }
    if (lockedControlled && !this.hasAvailableWeapons(lockedControlled)) {
      this.clearControlSelection();
    }
    let picked: UnitInstance | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const unit of this.state.units) {
      if (!unit.alive || unit.side !== "player") {
        continue;
      }
      if (unit.returnedToBase || unit.airDropActive || unit.escapeActive || !this.hasAvailableWeapons(unit)) {
        continue;
      }
      const dx = unit.x - mouseX;
      const dy = unit.y - mouseY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < unit.radius + 6 && distance < bestDistance) {
        picked = unit;
        bestDistance = distance;
      }
    }
    if (!picked) {
      this.setAim(mouseX, mouseY);
      return;
    }
    this.selectedUnitId = picked.id;
    this.playerControlledId = picked.id;
  }

  public clearControlSelection(): void {
    this.selectedUnitId = null;
    this.playerControlledId = null;
    this.manualFireHeld = false;
  }

  public handleLeftPointerDown(mouseX: number, mouseY: number): void {
    this.setAim(mouseX, mouseY);
    const previousControlled = this.playerControlledId;
    this.setControlByClick(mouseX, mouseY);
    const selectedDifferentUnit = previousControlled !== this.playerControlledId;
    if (selectedDifferentUnit || !this.playerControlledId) {
      this.manualFireHeld = false;
      return;
    }
    const controlled = this.state.units.find((unit) => unit.id === this.playerControlledId && unit.alive && unit.side === "player");
    if (!controlled) {
      this.manualFireHeld = false;
      return;
    }
    this.manualFireHeld = true;
    const fireReqs: FireRequest[] = [];
    for (let slot = 0; slot < controlled.weaponAttachmentIds.length; slot += 1) {
      if (this.isWeaponManualControlEnabled(controlled, slot)) {
        const angleRad = Math.atan2(this.aimY - controlled.y, this.aimX - controlled.x);
        fireReqs.push(this.createManualFireRequest(controlled, slot, angleRad));
      }
    }
    if (fireReqs.length > 0) {
      this.executeCommand(controlled, { move: { dirX: 0, dirY: 0 }, facing: null, fire: fireReqs }, 0);
    }
  }

  public handlePointerUp(): void {
    this.manualFireHeld = false;
  }

  public flipControlledDirection(): void {
    if (!this.state.active || !this.playerControlledId) {
      return;
    }
    const controlled = this.state.units.find((unit) => {
      return unit.id === this.playerControlledId && unit.side === "player" && unit.alive;
    });
    if (!controlled) {
      return;
    }
    controlled.facing = controlled.facing === 1 ? -1 : 1;
    this.hooks.addLog(`${controlled.name} flipped direction`, "warn");
  }

  public toggleControlledWeaponManualControl(slotIndex: number): void {
    if (!this.playerControlledId || !this.state.active) {
      return;
    }
    const controlled = this.state.units.find((unit) => unit.id === this.playerControlledId && unit.alive && unit.side === "player");
    if (!controlled) {
      return;
    }
    if (slotIndex < 0 || slotIndex >= controlled.weaponAttachmentIds.length) {
      return;
    }
    const next = !this.isWeaponManualControlEnabled(controlled, slotIndex);
    controlled.weaponManualControl[slotIndex] = next;
    if (next) {
      controlled.selectedWeaponIndex = slotIndex;
    }
    const status = next ? "ON" : "OFF";
    this.hooks.addLog(`${controlled.name} weapon #${slotIndex + 1} manual control ${status}`, "warn");
  }

  public selectControlledWeapon(slotIndex: number): void {
    this.toggleControlledWeaponManualControl(slotIndex);
  }

  public toggleControlledWeaponAutoFire(slotIndex: number): void {
    if (!this.playerControlledId || !this.state.active) {
      return;
    }
    const controlled = this.state.units.find((unit) => unit.id === this.playerControlledId && unit.alive && unit.side === "player");
    if (!controlled) {
      return;
    }
    if (slotIndex < 0 || slotIndex >= controlled.weaponAutoFire.length) {
      return;
    }
    controlled.weaponAutoFire[slotIndex] = !controlled.weaponAutoFire[slotIndex];
    const status = controlled.weaponAutoFire[slotIndex] ? "ON" : "OFF";
    this.hooks.addLog(`${controlled.name} weapon #${slotIndex + 1} auto fire ${status}`, "warn");
  }

  public start(node: MapNode): void {
    this.state = this.createEmptyBattle();
    this.lossStats = this.createEmptyLossStats();
    this.state.active = true;
    this.state.nodeId = node.id;
    this.state.enemyCap = Math.max(3, Math.ceil(node.defense * 3.2 + 1));
    this.state.enemyGas = 190 + Math.floor(node.defense * 130);
    this.state.enemyMinActive = Math.max(0, node.testEnemyMinActive ?? 0);
    this.state.enemyInfiniteGas = node.testEnemyInfiniteGas ?? false;
    this.state.enemyCap = Math.max(this.state.enemyCap, this.state.enemyMinActive);
    if (typeof node.testBaseHpOverride === "number" && Number.isFinite(node.testBaseHpOverride) && node.testBaseHpOverride > 0) {
      this.state.playerBase.maxHp = node.testBaseHpOverride;
      this.state.playerBase.hp = node.testBaseHpOverride;
      this.state.enemyBase.maxHp = node.testBaseHpOverride;
      this.state.enemyBase.hp = node.testBaseHpOverride;
    }

    if (!this.disableDefaultStarters) {
      const starterA = this.instantiateSpawnWithSpacing(1, "player", 140, this.getLaneBounds(), {
        deploymentGasCost: 0,
        preferredY: 300,
      });
      const starterB = this.instantiateSpawnWithSpacing(2, "player", 150, this.getLaneBounds(), {
        deploymentGasCost: 0,
        preferredY: 430,
      });
      if (starterA) {
        this.state.units.push(starterA);
      }
      if (starterB) {
        this.state.units.push(starterB);
      }
    }
    if (!this.disableAutoEnemySpawns) {
      for (let i = 0; i < 2; i += 1) {
        this.maybeSpawnEnemy();
      }
    }

    this.playerControlledId = null;
    this.selectedUnitId = null;
    this.manualFireHeld = false;
  }

  public resetToMapMode(): void {
    this.state = this.createEmptyBattle();
    this.lossStats = this.createEmptyLossStats();
    this.selectedUnitId = null;
    this.playerControlledId = null;
    this.manualFireHeld = false;
    this.aimX = this.canvas.width * 0.7;
    this.aimY = this.canvas.height * 0.5;
    this.controllerAimAngleRad = null;
  }

  public deployUnit(templateId: number): void {
    if (!this.state.active || this.state.outcome) {
      return;
    }
    const template = this.templates.find((entry) => entry.id === templateId);
    if (!template) {
      return;
    }

    const friendlyActive = this.state.units.filter((unit) => unit.side === "player" && unit.alive && canOperate(unit)).length;
    if (friendlyActive >= armyCap(this.hooks.getCommanderSkill())) {
      this.hooks.addLog("Commander cap reached", "warn");
      return;
    }
    const validation = validateTemplateDetailed(template, { partCatalog: this.partCatalog });
    if (validation.errors.length > 0) {
      this.hooks.addLog(`Cannot deploy ${template.name}: ${validation.errors[0] ?? "invalid template"}`, "bad");
      return;
    }

    const laneBounds = this.getLaneBounds();
    const unit = this.instantiateSpawnWithSpacing(templateId, "player", 120, laneBounds);
    if (!unit) {
      this.hooks.addLog(`Cannot deploy ${template.name}: instantiate failed`, "bad");
      return;
    }
    if (!this.hooks.spendPlayerGas(template.gasCost)) {
      this.hooks.addLog("Not enough gas for deployment", "warn");
      return;
    }
    this.state.units.push(unit);
    this.hooks.addLog(`Deployed ${template.name} (-${template.gasCost} gas)`);
  }

  public update(dt: number, keys: KeyState): void {
    if (!this.state.active || this.state.outcome) {
      return;
    }

    if (!this.disableAutoEnemySpawns) {
      this.state.enemySpawnTimer -= dt;
      if (this.state.enemySpawnTimer <= 0) {
        this.state.enemySpawnTimer = 4.2 + Math.random() * 2.8;
        this.maybeSpawnEnemy();
      }
    }
    if (!this.disableEnemyMinimumPresence) {
      this.ensureEnemyMinimumPresence();
    }
    this.ensurePlayerMinimumPresence();
    this.updateTargetHistorySamples(dt);

    const laneBounds = this.getLaneBounds();
    for (const unit of this.state.units) {
      if (!unit.alive) {
        continue;
      }
      if (this.shouldGroundUnitEnterWreck(unit)) {
        if (unit.id === this.playerControlledId || unit.id === this.selectedUnitId) {
          this.clearControlSelection();
        }
        unit.vx = 0;
        unit.vy = 0;
        unit.vibrate = 0;
        this.updateGroundWreck(unit, dt);
        continue;
      }
      if (!canOperate(unit)) {
        if (unit.id === this.playerControlledId || unit.id === this.selectedUnitId) {
          this.clearControlSelection();
        }
        if (unit.type === "air") {
          if (!unit.airDropActive) {
            unit.airDropActive = true;
            unit.airDropTargetY = laneBounds.groundMinY + Math.random() * (laneBounds.groundMaxY - laneBounds.groundMinY);
            unit.aiDebugDecisionPath = "air-control-loss-drop";
          }
        }
      }
      this.refreshUnitMobility(unit);

      if (unit.type === "air" && !unit.airDropActive && this.computeAirThrustSpeed(unit) <= AIR_HOLD_GRAVITY) {
        unit.airDropActive = true;
        unit.airDropTargetY = laneBounds.groundMinY + Math.random() * (laneBounds.groundMaxY - laneBounds.groundMinY);
        unit.aiDebugDecisionPath = "air-no-lift-drop";
      }

      if (unit.controlImpairTimer > 0) {
        unit.controlImpairTimer = Math.max(0, unit.controlImpairTimer - dt);
        if (unit.controlImpairTimer <= 0) {
          unit.controlImpairFactor = 1;
        }
      }

      this.activateEscapeIfUnavailable(unit);

      const isControlled = unit.side === "player" && unit.id === this.playerControlledId;
      let command: UnitCommand;

      if (isControlled && !unit.airDropActive) {
        command = this.playerInputToCommand(unit, dt, keys);
      } else if (unit.airDropActive) {
        command = this.airDropReturnToCommand(unit, dt);
      } else if (unit.escapeActive) {
        unit.escapeFacingDelayS = Math.max(0, unit.escapeFacingDelayS - dt);
        command = this.retreatToCommand(unit);
      } else if (this.hasAvailableWeapons(unit)) {
        if (this.isExternalAiEnabled(unit.side)) {
          command = this.consumeExternalCommandOrNoop(unit);
        } else {
          if (this.autoEnableAiWeaponAutoFire) {
            for (let i = 0; i < unit.weaponAutoFire.length; i += 1) {
              unit.weaponAutoFire[i] = true;
            }
          }
          unit.aiStateTimer += dt;
          unit.aiDodgeCooldown = Math.max(0, unit.aiDodgeCooldown - dt);
          const decision = this.getCombatDecision(unit, dt);
          command = this.aiDecisionToCommand(unit, decision);
        }
      } else {
        command = this.retreatToCommand(unit);
      }

      const cmdResult = this.executeCommand(unit, command, dt);

      for (const firedSlot of cmdResult.firedSlots) {
        const req = command.fire.find((r) => r.slot === firedSlot);
        if (req && !req.manual) {
          unit.aiWeaponCycleIndex = (firedSlot + 1) % Math.max(1, unit.weaponAttachmentIds.length);
        }
      }

      if (unit.controlImpairFactor < 1) {
        unit.vx *= unit.controlImpairFactor;
        unit.vy *= unit.controlImpairFactor;
      }

      const speedCap = this.scaleMovementSpeed(
        unit.airDropActive ? Math.max(unit.maxSpeed, AIR_DROP_SPEED_CAP) : unit.maxSpeed,
      );
      unit.vx = clamp(unit.vx, -speedCap, speedCap);
      const verticalSpeedCap = unit.type === "air" ? speedCap : speedCap * 0.75;
      unit.vy = clamp(unit.vy, -verticalSpeedCap, verticalSpeedCap);
      unit.x += unit.vx * dt;
      unit.y += unit.vy * dt;

      if (!unit.airDropActive) {
        if (unit.type === "air") {
          unit.vx *= 1;
          unit.vy *= 1;
        } else {
          unit.vx *= unit.turnDrag;
          unit.vy *= 0.83;
        }
      }

      for (let i = 0; i < unit.weaponFireTimers.length; i += 1) {
        unit.weaponFireTimers[i] = Math.max(0, unit.weaponFireTimers[i] - dt);
      }
      this.updateWeaponLoaders(unit, dt, isControlled);
      this.activateEscapeIfUnavailable(unit);
      unit.vibrate *= 0.85;
      applyStructureRecovery(unit, dt);

      this.clampUnitToBattlefield(unit, laneBounds);

      if (unit.airDropActive) {
        if (unit.y >= unit.airDropTargetY - 2) {
          this.onAirDropImpact(unit);
        }
      }

      if (unit.escapeActive && !unit.returnedToBase) {
        const base = unit.side === "player" ? this.state.playerBase : this.state.enemyBase;
        if (this.isUnitInsideBase(unit, base)) {
          this.onUnitReturnedToBase(unit);
        }
      }
    }
    this.resolveUnitSeparation();

    for (const projectile of this.state.projectiles) {
      projectile.ttl -= dt;
      projectile.prevX = projectile.x;
      projectile.prevY = projectile.y;
      if (projectile.projectileClass === "missile" && projectile.homingTurnRateDegPerSec > 0) {
        let target = projectile.homingTargetId
          ? this.state.units.find((unit) => unit.id === projectile.homingTargetId && unit.alive && unit.side !== projectile.side && canOperate(unit)) ?? null
          : null;
        if (!target) {
          target = this.findClosestEnemyToPoint(projectile.side, projectile.homingAimX, projectile.homingAimY);
          projectile.homingTargetId = target?.id ?? null;
        }
        if (target) {
          const currentAngle = Math.atan2(projectile.vy, projectile.vx);
          const desiredAngle = Math.atan2(target.y - projectile.y, target.x - projectile.x);
          const maxTurn = (projectile.homingTurnRateDegPerSec * Math.PI / 180) * dt;
          const delta = Math.atan2(Math.sin(desiredAngle - currentAngle), Math.cos(desiredAngle - currentAngle));
          const nextAngle = currentAngle + clamp(delta, -maxTurn, maxTurn);
          const speed = Math.hypot(projectile.vx, projectile.vy);
          projectile.vx = Math.cos(nextAngle) * speed;
          projectile.vy = Math.sin(nextAngle) * speed;
        }
      }
      const instantBeam = projectile.projectileClass === "laser";
      const remainingRange = Math.max(0, projectile.maxDistance - projectile.traveledDistance);
      const projectileSpeed = Math.max(1, Math.hypot(projectile.vx, projectile.vy));
      const stepX = instantBeam ? (projectile.vx / projectileSpeed) * remainingRange : projectile.vx * dt;
      if (!instantBeam) {
        projectile.vy += projectile.gravity * dt;
      }
      const stepY = instantBeam ? (projectile.vy / projectileSpeed) * remainingRange : projectile.vy * dt;
      projectile.x += stepX;
      projectile.y += stepY;
      projectile.traveledDistance += Math.hypot(stepX, stepY);
      const expireAfterCollision = instantBeam && projectile.traveledDistance >= projectile.maxDistance;
      if (!instantBeam && projectile.traveledDistance >= projectile.maxDistance) {
        projectile.ttl = -1;
      }
      const exceededGroundDropLimit = projectile.sourceUnitType === "ground" &&
        projectile.projectileClass !== "missile" &&
        projectile.initialVy < 0 &&
        projectile.y >= projectile.fireOriginY + GROUND_PROJECTILE_MAX_DROP_BELOW_FIRE_Y;
      if (exceededGroundDropLimit) {
        projectile.ttl = -1;
        continue;
      }
      if (projectile.ttl <= 0) {
        continue;
      }

      const orderedTargets = this.state.units.slice().sort((a, b) => {
        const aProgress = (a.x - projectile.prevX) * projectile.vx + (a.y - projectile.prevY) * projectile.vy;
        const bProgress = (b.x - projectile.prevX) * projectile.vx + (b.y - projectile.prevY) * projectile.vy;
        return aProgress - bProgress;
      });
      for (const target of orderedTargets) {
        if (!target.alive || target.side === projectile.side) {
          continue;
        }
        if (target.type === "air") {
          const hit = this.projectileHitsUnitPart(projectile, target, true);
          if (hit !== null) {
            const hitCellId = hit.structureCellId;
            const hitPartKey = `${target.id}:${hitCellId}`;
            if (projectile.hitPartKeys.includes(hitPartKey)) {
              continue;
            }
            const hitCell = target.structure.find((cell) => cell.id === hitCellId && !cell.destroyed);
            if (!hitCell) {
              continue;
            }
            const currentHp = Math.max(0, hitCell.breakThreshold - hitCell.strain);
            const penetrationCost = (hit.ignoreArmor ? 0 : Math.max(0, hitCell.armor) * PENETRATION_ARMOR_SCALER) + currentHp;
            const impactDamage = projectile.currentDamage;
            projectile.remainingPenetration -= penetrationCost;
            const beforeDestroyed = new Set(target.structure.filter((cell) => cell.destroyed).map((cell) => cell.id));
            const beforeAliveAttachments = new Set(target.attachments.filter((attachment) => attachment.alive).map((attachment) => attachment.id));
            const wasAlive = target.alive;
            const impactSide = projectile.vx >= 0 ? -1 : 1;
            let deliveredDamage = 0;
            if (!this.shouldIgnoreDamageForUnit(target)) {
              deliveredDamage = applyHitToUnit(target, impactDamage, projectile.hitImpulse, impactSide, hitCellId, hit.ignoreArmor).deliveredDamage;
            }
            this.queueImpactAudioEvent(projectile, hitCell, impactDamage, deliveredDamage, hit.ignoreArmor);
            projectile.hitPartKeys.push(hitPartKey);
            this.hooks.addLog(`Hit ${target.name} (air) by projectile from ${projectile.sourceId}`, "warn");
            this.spawnBreakDebris(target, beforeDestroyed, beforeAliveAttachments, wasAlive);
            this.state.particles.push({
              x: projectile.x,
              y: target.y,
              life: 0.23 + Math.random() * 0.2,
              size: 6 + impactDamage * 0.05,
            });
            if (projectile.controlImpairDuration > 0) {
              this.applyControlImpair(target, projectile.controlImpairFactor, projectile.controlImpairDuration);
            }
            if (projectile.explosiveBlastRadius > 0) {
              this.applyExplosiveBlast(projectile, target.id);
              projectile.ttl = -1;
              break;
            }
            if (projectile.remainingPenetration <= 0) {
              projectile.ttl = -1;
              break;
            }
            projectile.currentDamage = scaleDamageByRemainingPenetration(projectile.damage, projectile.initialPenetration, projectile.remainingPenetration);
          }
          continue;
        }

        const hit = this.projectileHitsUnitPart(projectile, target, false);
        if (hit !== null) {
          const hitCellId = hit.structureCellId;
          const hitPartKey = `${target.id}:${hitCellId}`;
          if (projectile.hitPartKeys.includes(hitPartKey)) {
            continue;
          }
          const hitCell = target.structure.find((cell) => cell.id === hitCellId && !cell.destroyed);
          if (!hitCell) {
            continue;
          }
          const currentHp = Math.max(0, hitCell.breakThreshold - hitCell.strain);
          const penetrationCost = (hit.ignoreArmor ? 0 : Math.max(0, hitCell.armor) * PENETRATION_ARMOR_SCALER) + currentHp;
          const impactDamage = projectile.currentDamage;
          projectile.remainingPenetration -= penetrationCost;
          const beforeDestroyed = new Set(target.structure.filter((cell) => cell.destroyed).map((cell) => cell.id));
          const beforeAliveAttachments = new Set(target.attachments.filter((attachment) => attachment.alive).map((attachment) => attachment.id));
          const wasAlive = target.alive;
          const impactSide = projectile.vx >= 0 ? -1 : 1;
          let deliveredDamage = 0;
          if (!this.shouldIgnoreDamageForUnit(target)) {
            deliveredDamage = applyHitToUnit(target, impactDamage, projectile.hitImpulse, impactSide, hitCellId, hit.ignoreArmor).deliveredDamage;
          }
          this.queueImpactAudioEvent(projectile, hitCell, impactDamage, deliveredDamage, hit.ignoreArmor);
          projectile.hitPartKeys.push(hitPartKey);
          this.hooks.addLog(`Hit ${target.name} (ground) by projectile from ${projectile.sourceId}`, "warn");
          this.spawnBreakDebris(target, beforeDestroyed, beforeAliveAttachments, wasAlive);
          this.state.particles.push({
            x: projectile.x,
            y: target.y,
            life: 0.23 + Math.random() * 0.2,
            size: 6 + impactDamage * 0.05,
          });
          if (projectile.controlImpairDuration > 0) {
            this.applyControlImpair(target, projectile.controlImpairFactor, projectile.controlImpairDuration);
          }
          if (projectile.explosiveBlastRadius > 0) {
            this.applyExplosiveBlast(projectile, target.id);
            projectile.ttl = -1;
            break;
          }
          if (projectile.remainingPenetration <= 0) {
            projectile.ttl = -1;
            break;
          }
          projectile.currentDamage = scaleDamageByRemainingPenetration(projectile.damage, projectile.initialPenetration, projectile.remainingPenetration);
        }
      }

      if (projectile.ttl > 0) {
        this.applyBaseDamage(projectile);
      }
      if (expireAfterCollision) {
        projectile.ttl = -1;
      }
    }

    this.state.projectiles = this.state.projectiles.filter(
      (projectile) => projectile.ttl > 0 && projectile.x > 0 && projectile.x < this.canvas.width,
    );
    for (const effect of this.state.particles) {
      effect.life -= dt;
    }
    this.state.particles = this.state.particles.filter((effect) => effect.life > 0);
    for (const effect of this.state.blockExplosions) {
      effect.age += dt;
    }
    this.state.blockExplosions = this.state.blockExplosions.filter((effect) => effect.age < effect.life);
    for (const beam of this.state.beamEffects) {
      beam.life -= dt;
    }
    this.state.beamEffects = this.state.beamEffects.filter((beam) => beam.life > 0);

    for (const chunk of this.state.debris) {
      chunk.life -= dt;
      if (!chunk.grounded) {
        chunk.vy += 260 * dt;
        chunk.x += chunk.vx * dt;
        chunk.y += chunk.vy * dt;
        if (chunk.y >= laneBounds.groundMaxY + 4) {
          chunk.y = laneBounds.groundMinY + Math.random() * (laneBounds.groundMaxY - laneBounds.groundMinY);
          chunk.vx *= 0.38;
          chunk.vy = 0;
          chunk.grounded = true;
        }
      } else {
        chunk.vx = 0;
        chunk.vy = 0;
      }
    }
    this.state.debris = this.state.debris.filter((chunk) => chunk.life > 0);
    this.recordDestroyedUnits();
    this.state.units = this.state.units.filter((unit) => unit.alive);

    if (this.state.playerBase.hp <= 0) {
      this.endBattle(false, "Player battle base destroyed");
    }
    if (this.state.enemyBase.hp <= 0) {
      this.endBattle(true, "Enemy base destroyed");
    }
  }

  public forceEnd(victory: boolean, reason: string): void {
    this.endBattle(victory, reason);
  }

  public draw(now: number): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.state.active && !this.state.outcome) {
      this.drawIdleMessage();
      return;
    }

    this.drawLanes();
    this.drawBase(this.state.playerBase, "#5d8bb3", "Player Base");
    this.drawBase(this.state.enemyBase, "#b36b63", "Enemy Base");

    for (const effect of this.state.particles) {
      this.ctx.globalAlpha = clamp(effect.life / 0.4, 0, 1);
      this.ctx.fillStyle = "#f5c07a";
      this.ctx.beginPath();
      this.ctx.arc(effect.x, effect.y, effect.size * (1 - effect.life * 0.8), 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;

    for (const beam of this.state.beamEffects) {
      const alpha = clamp(beam.life / beam.maxLife, 0, 1);
      this.ctx.strokeStyle = beam.side === "player" ? `rgba(143, 246, 255, ${alpha})` : `rgba(255, 143, 168, ${alpha})`;
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.moveTo(beam.x1, beam.y1);
      this.ctx.lineTo(beam.x2, beam.y2);
      this.ctx.stroke();
    }

    for (const projectile of this.state.projectiles) {
      this.ctx.fillStyle = projectile.side === "player" ? "#9bd5ff" : "#ffb19a";
      this.ctx.beginPath();
      this.ctx.arc(projectile.x, projectile.y, projectile.r, 0, Math.PI * 2);
      this.ctx.fill();

      if (this.debugDrawEnabled) {
        this.ctx.strokeStyle = "rgba(255, 235, 150, 0.8)";
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(projectile.prevX, projectile.prevY);
        this.ctx.lineTo(projectile.x, projectile.y);
        this.ctx.stroke();
      }
    }

    for (const chunk of this.state.debris) {
      this.ctx.fillStyle = chunk.color;
      this.ctx.fillRect(chunk.x - chunk.size / 2, chunk.y - chunk.size / 2, chunk.size, chunk.size);
      this.ctx.strokeStyle = chunk.kind === "functional" ? "rgba(230, 241, 255, 0.8)" : "rgba(22, 28, 38, 0.35)";
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(chunk.x - chunk.size / 2, chunk.y - chunk.size / 2, chunk.size, chunk.size);
    }

    for (const unit of this.state.units) {
      this.drawUnit(unit, now);

      if (this.debugDrawEnabled) {
        this.ctx.strokeStyle = unit.type === "air" ? "rgba(120, 212, 255, 0.8)" : "rgba(141, 228, 169, 0.8)";
        this.ctx.lineWidth = 1;
        const rects = this.getLiveCellRects(unit);
        for (const rect of rects) {
          this.ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        }
      }
    }

    if (this.debugTargetLineEnabled) {
      this.drawTargetLines();
    }

    const controlled = this.getControlledUnit();
    if (controlled) {
      const selectedRange = this.getSelectedWeaponRange(controlled);
      if (selectedRange > 0) {
        this.ctx.strokeStyle = "rgba(141, 228, 169, 0.45)";
        this.ctx.lineWidth = 1.5;
        this.ctx.setLineDash([7, 5]);
        this.ctx.beginPath();
        this.ctx.arc(controlled.x, controlled.y, selectedRange, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
    }

    if (this.state.outcome) {
      this.ctx.fillStyle = "rgba(10, 14, 22, 0.78)";
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.fillStyle = this.state.outcome.victory ? "#74d8a0" : "#f28b8b";
      this.ctx.font = "700 34px Trebuchet MS";
      this.ctx.fillText(this.state.outcome.victory ? "VICTORY" : "DEFEAT", this.canvas.width / 2 - 82, this.canvas.height / 2 - 8);
      this.ctx.fillStyle = "#dce8f5";
      this.ctx.font = "16px Trebuchet MS";
      this.ctx.fillText(this.state.outcome.reason, this.canvas.width / 2 - 110, this.canvas.height / 2 + 24);
    }
  }

  private createEmptyBattle(): BattleState {
    const playerBase = this.createDefaultBase("player");
    const enemyBase = this.createDefaultBase("enemy");
    return {
      active: false,
      nodeId: null,
      units: [],
      projectiles: [],
      beamEffects: [],
      blockExplosions: [],
      particles: [],
      debris: [],
      playerBase: { hp: 1300, maxHp: 1300, x: playerBase.x, y: playerBase.y, w: playerBase.w, h: playerBase.h },
      enemyBase: { hp: 1300, maxHp: 1300, x: enemyBase.x, y: enemyBase.y, w: enemyBase.w, h: enemyBase.h },
      enemyGas: 220,
      enemyCap: 3,
      enemyMinActive: 0,
      enemyInfiniteGas: false,
      enemySpawnTimer: 0,
      outcome: null,
    };
  }

  private createDefaultBase(side: Side): { x: number; y: number; w: number; h: number } {
    const w = clamp(Math.round(this.canvas.width * (38 / 2000)), 28, 70);
    const h = clamp(Math.round(this.canvas.height * (160 / 1000)), 90, Math.floor(this.canvas.height * 0.5));
    const laneBounds = this.getLaneBounds();
    const verticalMid = (laneBounds.airMaxZ + laneBounds.groundMinY) * 0.5;
    const y = clamp(Math.round(verticalMid - h * 0.5), 18, Math.max(18, this.canvas.height - h - 18));
    const x = side === "player" ? 18 : this.canvas.width - w - 18;
    return { x, y, w, h };
  }

  private relayoutBasesPreservingHp(): void {
    const nextPlayerBase = this.createDefaultBase("player");
    const nextEnemyBase = this.createDefaultBase("enemy");
    const playerRatio = this.state.playerBase.maxHp > 0 ? clamp(this.state.playerBase.hp / this.state.playerBase.maxHp, 0, 1) : 1;
    const enemyRatio = this.state.enemyBase.maxHp > 0 ? clamp(this.state.enemyBase.hp / this.state.enemyBase.maxHp, 0, 1) : 1;
    this.state.playerBase.x = nextPlayerBase.x;
    this.state.playerBase.y = nextPlayerBase.y;
    this.state.playerBase.w = nextPlayerBase.w;
    this.state.playerBase.h = nextPlayerBase.h;
    this.state.playerBase.hp = this.state.playerBase.maxHp * playerRatio;
    this.state.enemyBase.x = nextEnemyBase.x;
    this.state.enemyBase.y = nextEnemyBase.y;
    this.state.enemyBase.w = nextEnemyBase.w;
    this.state.enemyBase.h = nextEnemyBase.h;
    this.state.enemyBase.hp = this.state.enemyBase.maxHp * enemyRatio;
  }

  private getLaneBounds(): {
    airMinZ: number;
    airMaxZ: number;
    groundMinY: number;
    groundMaxY: number;
    airTargetTolerance: number;
  } {
    const h = Math.max(360, this.canvas.height);
    const groundMaxY = h - 8;
    const clampedGroundHeight = clamp(this.groundHeightPx, 80, Math.max(120, h - 40));
    const groundMinY = clamp(groundMaxY - clampedGroundHeight, 0, groundMaxY - 12);
    const airMinZ = clamp(h * AIR_MIN_Z_RATIO, 0, groundMinY - 12);
    const airGap = Math.max(10, h * AIR_GROUND_GAP_RATIO);
    const airMaxZ = clamp(groundMinY - airGap, airMinZ + 12, groundMinY - 4);
    const airTargetTolerance = Math.max(6, h * AIR_TARGET_Z_TOLERANCE_RATIO);
    return { airMinZ, airMaxZ, groundMinY, groundMaxY, airTargetTolerance };
  }

  private clampEntitiesToBattlefield(): void {
    const bounds = this.getLaneBounds();
    for (const unit of this.state.units) {
      if (!unit.alive) {
        continue;
      }
      this.clampUnitToBattlefield(unit, bounds);
    }
  }

  private clampUnitToBattlefield(
    unit: UnitInstance,
    bounds: { airMinZ: number; airMaxZ: number; groundMinY: number; groundMaxY: number; airTargetTolerance: number },
  ): void {
    if (unit.type === "ground") {
      unit.y = clamp(unit.y, bounds.groundMinY, bounds.groundMaxY);
    } else if (unit.airDropActive) {
      unit.airDropTargetY = clamp(unit.airDropTargetY, bounds.groundMinY, bounds.groundMaxY);
      unit.y = clamp(unit.y, bounds.airMinZ, unit.airDropTargetY);
    } else {
      unit.y = clamp(unit.y, bounds.airMinZ, bounds.groundMinY);
    }
    unit.x = clamp(unit.x, 44, this.canvas.width - 44);
  }

  private minAllowedCenterDistance(a: UnitInstance, b: UnitInstance): number {
    const overlapAllowance = Math.max(0, Math.min(0.95, UNIT_OVERLAP_ALLOWANCE_RATIO));
    const penetrationAllowance = Math.min(a.radius, b.radius) * overlapAllowance;
    return Math.max(4, a.radius + b.radius - penetrationAllowance);
  }

  private hasBlockingSpawnOverlap(candidate: UnitInstance): boolean {
    for (const other of this.state.units) {
      if (!other.alive || other.type !== candidate.type) {
        continue;
      }
      const dx = other.x - candidate.x;
      const dy = other.y - candidate.y;
      const minDist = this.minAllowedCenterDistance(candidate, other);
      if ((dx * dx + dy * dy) < (minDist * minDist)) {
        return true;
      }
    }
    return false;
  }

  private instantiateSpawnWithSpacing(templateId: number, side: Side, spawnX: number, laneBounds: {
    airMinZ: number;
    airMaxZ: number;
    groundMinY: number;
    groundMaxY: number;
    airTargetTolerance: number;
  }, options?: { deploymentGasCost?: number; preferredY?: number }): UnitInstance | null {
    const maxAttempts = Math.max(1, Math.floor(UNIT_SPAWN_PLACEMENT_ATTEMPTS));
    let fallback: UnitInstance | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const preferredY = options?.preferredY;
      const y = attempt === 0 && preferredY !== undefined
        ? preferredY
        : this.pickSpawnYForTemplate(templateId, laneBounds);
      const unit = instantiateUnit(this.templates, templateId, side, spawnX, y, {
        deploymentGasCost: options?.deploymentGasCost,
        partCatalog: this.partCatalog,
      });
      if (!unit) {
        continue;
      }
      this.clampUnitToBattlefield(unit, laneBounds);
      if (!fallback) {
        fallback = unit;
      }
      if (!this.hasBlockingSpawnOverlap(unit)) {
        return unit;
      }
    }
    return fallback;
  }

  private pickSpawnYForTemplate(templateId: number, laneBounds: {
    airMinZ: number;
    airMaxZ: number;
    groundMinY: number;
    groundMaxY: number;
    airTargetTolerance: number;
  }): number {
    const template = this.templates.find((entry) => entry.id === templateId);
    if (!template) {
      return laneBounds.groundMinY + Math.random() * (laneBounds.groundMaxY - laneBounds.groundMinY);
    }
    if (template.type === "air") {
      return laneBounds.airMinZ + Math.random() * (laneBounds.airMaxZ - laneBounds.airMinZ);
    }
    return laneBounds.groundMinY + Math.random() * (laneBounds.groundMaxY - laneBounds.groundMinY);
  }

  private resolveUnitOverlapBetween(
    a: UnitInstance,
    b: UnitInstance,
    laneBounds: { airMinZ: number; airMaxZ: number; groundMinY: number; groundMaxY: number; airTargetTolerance: number },
  ): void {
    if (!a.alive || !b.alive || a.type !== b.type) {
      return;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const minDist = this.minAllowedCenterDistance(a, b);
    const distSq = dx * dx + dy * dy;
    if (distSq >= minDist * minDist) {
      return;
    }
    const distance = Math.sqrt(Math.max(distSq, 1e-9));
    const nx = distance > 1e-6 ? dx / distance : (a.id < b.id ? 1 : -1);
    const ny = distance > 1e-6 ? dy / distance : 0;
    const penetrationDepth = minDist - distance;
    const correction = penetrationDepth * Math.max(0, UNIT_SEPARATION_POSITION_FACTOR);
    if (correction <= 0) {
      return;
    }
    const invMassA = 1 / Math.max(1, a.mass);
    const invMassB = 1 / Math.max(1, b.mass);
    const invMassSum = invMassA + invMassB;
    const weightA = invMassA / Math.max(1e-6, invMassSum);
    const weightB = invMassB / Math.max(1e-6, invMassSum);

    a.x -= nx * correction * weightA;
    a.y -= ny * correction * weightA;
    b.x += nx * correction * weightB;
    b.y += ny * correction * weightB;
    this.clampUnitToBattlefield(a, laneBounds);
    this.clampUnitToBattlefield(b, laneBounds);

    const relVx = b.vx - a.vx;
    const relVy = b.vy - a.vy;
    const relAlongNormal = relVx * nx + relVy * ny;
    if (relAlongNormal >= 0) {
      return;
    }
    const damping = Math.max(0, Math.min(1, UNIT_SEPARATION_VELOCITY_DAMPING));
    const normalSpeedDelta = -relAlongNormal * damping;
    a.vx -= nx * normalSpeedDelta * weightA;
    a.vy -= ny * normalSpeedDelta * weightA;
    b.vx += nx * normalSpeedDelta * weightB;
    b.vy += ny * normalSpeedDelta * weightB;
  }

  private resolveUnitSeparation(): void {
    if (!UNIT_SEPARATION_ENABLED) {
      return;
    }
    const alive = this.state.units.filter((unit) => unit.alive && canOperate(unit));
    if (alive.length <= 1) {
      return;
    }
    const cellSize = Math.max(24, UNIT_SEPARATION_GRID_SIZE);
    const grid = new Map<string, number[]>();
    const cellKey = (cellX: number, cellY: number): string => `${cellX}:${cellY}`;
    for (let i = 0; i < alive.length; i += 1) {
      const unit = alive[i];
      const cellX = Math.floor(unit.x / cellSize);
      const cellY = Math.floor(unit.y / cellSize);
      const key = cellKey(cellX, cellY);
      const bucket = grid.get(key);
      if (bucket) {
        bucket.push(i);
      } else {
        grid.set(key, [i]);
      }
    }

    const laneBounds = this.getLaneBounds();
    const neighborOffsets = [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
    ];
    for (const [key, bucket] of grid.entries()) {
      const [cxRaw, cyRaw] = key.split(":");
      const cx = Number(cxRaw);
      const cy = Number(cyRaw);
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          this.resolveUnitOverlapBetween(alive[bucket[i]], alive[bucket[j]], laneBounds);
        }
      }
      for (const [ox, oy] of neighborOffsets) {
        const other = grid.get(cellKey(cx + ox, cy + oy));
        if (!other) {
          continue;
        }
        for (const indexA of bucket) {
          for (const indexB of other) {
            this.resolveUnitOverlapBetween(alive[indexA], alive[indexB], laneBounds);
          }
        }
      }
    }
  }

  private maybeSpawnEnemy(): boolean {
    const aliveEnemy = this.state.units.filter((unit) => unit.side === "enemy" && unit.alive && canOperate(unit)).length;
    if (aliveEnemy >= this.state.enemyCap) {
      return false;
    }
    const candidates = this.templates.filter((template) => {
      if (this.enemySpawnTemplateAllowList && !this.enemySpawnTemplateAllowList.has(template.id)) {
        return false;
      }
      const validation = validateTemplateDetailed(template, { partCatalog: this.partCatalog });
      if (validation.errors.length > 0) {
        return false;
      }
      if (this.state.enemyInfiniteGas) {
        return true;
      }
      if (this.state.enemyGas < 20) {
        return false;
      }
      return this.state.enemyGas >= template.gasCost;
    });
    if (candidates.length <= 0) {
      return false;
    }
    const template = candidates[Math.floor(Math.random() * candidates.length)] ?? null;
    if (!template) {
      return false;
    }

    const bounds = this.getLaneBounds();
    const enemy = this.instantiateSpawnWithSpacing(template.id, "enemy", this.canvas.width - 120, bounds);
    if (!enemy) {
      return false;
    }
    if (!this.state.enemyInfiniteGas) {
      this.state.enemyGas -= template.gasCost;
    }
    this.state.units.push(enemy);
    if (this.autoSpawnEnemyTemplateOnPlayerSide) {
      this.spawnMirroredPlayerTemplate(template);
    }
    return true;
  }

  private spawnMirroredPlayerTemplate(template: UnitTemplate): void {
    const player = this.instantiateSpawnWithSpacing(template.id, "player", 120, this.getLaneBounds());
    if (!player) {
      return;
    }
    this.state.units.push(player);
  }

  private ensurePlayerMinimumPresence(): void {
    if (!this.autoSpawnPlayerSideEnabled || this.autoSpawnPlayerTargetCount <= 0) {
      return;
    }
    const candidates = this.templates.filter((template) => {
      if (this.playerSpawnTemplateAllowList && !this.playerSpawnTemplateAllowList.has(template.id)) {
        return false;
      }
      const validation = validateTemplateDetailed(template, { partCatalog: this.partCatalog });
      return validation.errors.length <= 0;
    });
    if (candidates.length <= 0) {
      return;
    }
    let alivePlayer = this.getAlivePlayerCount();
    let attempts = 0;
    const maxAttempts = Math.max(2, this.autoSpawnPlayerTargetCount * 3);
    while (alivePlayer < this.autoSpawnPlayerTargetCount && attempts < maxAttempts) {
      const template = candidates[Math.floor(Math.random() * candidates.length)] ?? null;
      if (!template) {
        break;
      }
      const spawned = this.arenaDeploy("player", template.id, {
        chargeGas: false,
        deploymentGasCost: 0,
        ignoreCap: true,
      });
      if (!spawned) {
        break;
      }
      alivePlayer += 1;
      attempts += 1;
    }
  }

  public arenaDeploy(
    side: Side,
    templateId: number,
    opts: { chargeGas?: boolean; y?: number; deploymentGasCost?: number; ignoreCap?: boolean; ignoreLowGasThreshold?: boolean } = {},
  ): boolean {
    if (!this.state.active || this.state.outcome) {
      return false;
    }
    const template = this.templates.find((entry) => entry.id === templateId);
    if (!template) {
      return false;
    }
    const validation = validateTemplateDetailed(template, { partCatalog: this.partCatalog });
    if (validation.errors.length > 0) {
      return false;
    }

    const chargeGas = opts.chargeGas ?? true;
    const ignoreCap = opts.ignoreCap ?? false;
    if (side === "player") {
      const friendlyActive = this.state.units.filter((unit) => unit.side === "player" && unit.alive && canOperate(unit)).length;
      if (!ignoreCap && friendlyActive >= armyCap(this.hooks.getCommanderSkill())) {
        return false;
      }
      const bounds = this.getLaneBounds();
      const unit = this.instantiateSpawnWithSpacing(templateId, "player", 120, bounds, {
        deploymentGasCost: typeof opts.deploymentGasCost === "number" && Number.isFinite(opts.deploymentGasCost) ? opts.deploymentGasCost : undefined,
        preferredY: typeof opts.y === "number" && Number.isFinite(opts.y) ? opts.y : undefined,
      });
      if (!unit) {
        return false;
      }
      if (chargeGas && !this.hooks.spendPlayerGas(template.gasCost)) {
        return false;
      }
      this.state.units.push(unit);
      return true;
    }

    const aliveEnemy = this.state.units.filter((unit) => unit.side === "enemy" && unit.alive && canOperate(unit)).length;
    if (!ignoreCap && aliveEnemy >= this.state.enemyCap) {
      return false;
    }
    const hasGas = this.state.enemyGas >= template.gasCost;
    const ignoreLowGasThreshold = opts.ignoreLowGasThreshold ?? false;
    if (chargeGas && !this.state.enemyInfiniteGas && (!hasGas || (!ignoreLowGasThreshold && this.state.enemyGas < 20))) {
      return false;
    }
    const bounds = this.getLaneBounds();
    const enemy = this.instantiateSpawnWithSpacing(templateId, "enemy", this.canvas.width - 120, bounds, {
      deploymentGasCost: typeof opts.deploymentGasCost === "number" && Number.isFinite(opts.deploymentGasCost) ? opts.deploymentGasCost : undefined,
      preferredY: typeof opts.y === "number" && Number.isFinite(opts.y) ? opts.y : undefined,
    });
    if (!enemy) {
      return false;
    }
    if (chargeGas && !this.state.enemyInfiniteGas) {
      this.state.enemyGas -= template.gasCost;
    }
    this.state.units.push(enemy);
    return true;
  }

  private ensureEnemyMinimumPresence(): void {
    if (this.state.enemyMinActive <= 0) {
      return;
    }
    let aliveEnemy = this.state.units.filter((unit) => unit.side === "enemy" && unit.alive && canOperate(unit)).length;
    let attempts = 0;
    const maxAttempts = Math.max(2, this.state.enemyMinActive * 3);
    while (aliveEnemy < this.state.enemyMinActive && attempts < maxAttempts) {
      const spawned = this.maybeSpawnEnemy();
      if (!spawned) {
        break;
      }
      aliveEnemy += 1;
      attempts += 1;
    }
  }

  private applyBaseDamage(projectile: BattleState["projectiles"][number]): void {
    const playerHasDefenders = this.state.units.some((unit) => {
      return unit.alive && unit.side === "player" && canOperate(unit) && this.hasAvailableWeapons(unit);
    });
    const enemyHasDefenders = this.state.units.some((unit) => {
      return unit.alive && unit.side === "enemy" && canOperate(unit) && this.hasAvailableWeapons(unit);
    });

    if (projectile.side === "player") {
      if (enemyHasDefenders) {
        return;
      }
      if (this.projectileAabbEntryTime(
        projectile,
        this.state.enemyBase.x,
        this.state.enemyBase.y,
        this.state.enemyBase.x + this.state.enemyBase.w,
        this.state.enemyBase.y + this.state.enemyBase.h,
      ) !== null) {
        this.state.enemyBase.hp -= projectile.currentDamage * 0.5;
        projectile.ttl = -1;
      }
      return;
    }

    if (playerHasDefenders) {
      return;
    }
    if (this.projectileAabbEntryTime(
      projectile,
      this.state.playerBase.x,
      this.state.playerBase.y,
      this.state.playerBase.x + this.state.playerBase.w,
      this.state.playerBase.y + this.state.playerBase.h,
    ) !== null) {
      this.state.playerBase.hp -= projectile.currentDamage * 0.5;
      projectile.ttl = -1;
    }
  }

  private applyControlImpair(unit: UnitInstance, factor: number, duration: number): void {
    unit.controlImpairFactor = Math.min(unit.controlImpairFactor, clamp(factor, 0.25, 1));
    unit.controlImpairTimer = Math.max(unit.controlImpairTimer, duration);
  }

  private applyExplosiveBlast(projectile: BattleState["projectiles"][number], directHitUnitId: string | null): void {
    const radius = projectile.explosiveBlastRadius;
    const maxDamage = projectile.explosiveBlastDamage;
    if (radius <= 0 || maxDamage <= 0) {
      return;
    }
    this.queueAudioEvent({ kind: "explosion", x: projectile.x, y: projectile.y, intensity: maxDamage, radius });

    for (const target of this.state.units) {
      if (!target.alive || target.side === projectile.side) {
        continue;
      }
      if (directHitUnitId && target.id === directHitUnitId) {
        continue;
      }
      const dx = target.x - projectile.x;
      const dy = target.y - projectile.y;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) {
        continue;
      }
      const normalized = 1 - distance / Math.max(1, radius);
      const falloff = Math.pow(normalized, projectile.explosiveFalloffPower);
      const splashDamage = Math.max(0, maxDamage * falloff);
      if (splashDamage <= 0.25) {
        continue;
      }
      const splashHit = this.projectileHitsUnitPart(projectile, target, target.type === "air");
      const hitCellId = splashHit?.structureCellId ?? null;
      const impactSide = dx >= 0 ? 1 : -1;
      const beforeDestroyed = new Set(target.structure.filter((cell) => cell.destroyed).map((cell) => cell.id));
      const beforeAliveAttachments = new Set(target.attachments.filter((attachment) => attachment.alive).map((attachment) => attachment.id));
      const wasAlive = target.alive;
      if (!this.shouldIgnoreDamageForUnit(target)) {
        applyHitToUnit(target, splashDamage, projectile.hitImpulse * 0.45, impactSide, hitCellId, splashHit?.ignoreArmor ?? false);
      }
      this.spawnBreakDebris(target, beforeDestroyed, beforeAliveAttachments, wasAlive);
      if (projectile.controlImpairDuration > 0) {
        this.applyControlImpair(target, projectile.controlImpairFactor, projectile.controlImpairDuration * 0.8);
      }
    }

    this.state.particles.push({
      x: projectile.x,
      y: projectile.y,
      life: 0.28 + Math.random() * 0.18,
      size: Math.max(10, radius * 0.22),
    });
  }

  private fireWeaponSlot(
    unit: UnitInstance,
    slot: number,
    manual: boolean,
    requestedAngleRad: number,
    intendedTargetId: string | null,
    intendedTargetY: number | null,
  ): boolean {
    if (slot < 0 || slot >= unit.weaponAttachmentIds.length) {
      return false;
    }
    if ((unit.weaponFireTimers[slot] ?? 0) > 0) {
      return false;
    }
    const attachmentId = unit.weaponAttachmentIds[slot];
    const attachment = unit.attachments.find((entry) => entry.id === attachmentId && entry.alive);
    if (!attachment) {
      return false;
    }
    const attachmentStats = COMPONENTS[attachment.component];
    if (attachmentStats.type !== "weapon") {
      return false;
    }
    const requiresDedicatedLoader = this.requiresDedicatedLoaderForAttachment(attachment);
    // Cooldown/reload commands should be a true no-op: skip recoil if not ready.
    if (requiresDedicatedLoader) {
      const charges = unit.weaponReadyCharges[slot] ?? 0;
      if (charges <= 0) {
        return false;
      }
    }
    const shot = applyRecoilForAttachment(unit, attachmentId);
    if (!shot) {
      return false;
    }
    const safeAngle = Number.isFinite(requestedAngleRad) ? requestedAngleRad : 0;
    const effectiveRange = this.getEffectiveWeaponRange(unit, shot.range);
    // Calculate target point for intended target tracking (homings, etc.)
    const targetX = unit.x + Math.cos(safeAngle) * effectiveRange;
    const targetY = unit.y + Math.sin(safeAngle) * effectiveRange;
    const adjustedTargetY = (() => {
      if (attachment.component === "trackingMissile") return targetY - 10;
      if (attachment.component === "explosiveShell") return targetY + 4;
      return targetY;
    })();
    const finalIntendedTargetY = intendedTargetY ?? adjustedTargetY;
    const finalIntendedTargetX = targetX;
    const resolvedHomingTargetId = shot.projectileClass === "missile" && shot.trackingTurnRateDegPerSec > 0
      ? (intendedTargetId ?? this.findClosestEnemyToPoint(unit.side, finalIntendedTargetX, finalIntendedTargetY)?.id ?? null)
      : null;
    // Clamp angle directly (no dx/dy round-trip)
    const fireAngle = this.clampAndAdjustAngle(unit, attachment.component, safeAngle, attachment);
    const spreadRad = (((Math.random() * 2) - 1) * shot.spreadDeg * Math.PI) / 180;
    const finalFireAngle = fireAngle + spreadRad;
    const ux = Math.cos(finalFireAngle);
    const uy = Math.sin(finalFireAngle);
    // Projectile position starts at the visible barrel tip. Spread changes the
    // projectile velocity, but not the physical point where it leaves the gun.
    const muzzle = this.getAttachmentVisualMuzzleWorld(unit, attachment, fireAngle);
    const projectileSpeed = shot.projectileSpeed;
    const gravity = shot.projectileGravity;
    const ttl = Math.max(2.0, effectiveRange / Math.max(120, projectileSpeed));
    const nominalRadius = Math.max(2, Math.sqrt(shot.damage) * 0.35) * shot.projectileSizeRatio;
    const projectileAsset = PROJECTILE_ASSETS[shot.projectileShape];
    const visualHeight = nominalRadius * 2 * (shot.projectileClass === "laser" ? 4 : 1);
    const visualWidth = visualHeight * projectileAsset.aspect;
    const capsule = projectileAsset.collider.kind === "capsule"
      ? {
          centerX: (projectileAsset.collider.centerX - 0.5) * visualWidth,
          centerY: (projectileAsset.collider.centerY - 0.5) * visualHeight,
          halfLength: projectileAsset.collider.halfLength * visualWidth,
          radius: projectileAsset.collider.radius * visualHeight,
        }
      : {
          centerX: 0,
          centerY: (projectileAsset.collider.centerY - 0.5) * visualHeight,
          halfLength: 0,
          radius: projectileAsset.collider.halfHeight * visualHeight,
        };
    if (shot.projectileClass === "laser") {
      this.state.beamEffects.push({
        x1: muzzle.x,
        y1: muzzle.y,
        x2: muzzle.x + ux * effectiveRange,
        y2: muzzle.y + uy * effectiveRange,
        side: unit.side,
        life: 0.12,
        maxLife: 0.12,
        shape: shot.projectileShape as import("../../types.ts").LaserShape,
        halfWidth: capsule.radius,
      });
    }
    this.state.projectiles.push({
      x: muzzle.x,
      y: muzzle.y,
      prevX: muzzle.x,
      prevY: muzzle.y,
      vx: ux * projectileSpeed,
      vy: uy * projectileSpeed,
      traveledDistance: 0,
      maxDistance: effectiveRange,
      hitPartKeys: [],
      intendedTargetX: finalIntendedTargetX,
      intendedTargetY: finalIntendedTargetY,
      axisY: finalIntendedTargetY,
      allowAirPierce: unit.type === "ground",
      gravity,
      projectileClass: shot.projectileClass,
      projectileShape: shot.projectileShape,
      projectileSizeRatio: shot.projectileSizeRatio,
      visualHeight,
      capsuleCenterX: capsule.centerX,
      capsuleCenterY: capsule.centerY,
      capsuleHalfLength: capsule.halfLength,
      capsuleRadius: capsule.radius,
      explosiveBlastRadius: shot.explosive?.blastRadius ?? 0,
      explosiveBlastDamage: shot.explosive?.blastDamage ?? 0,
      explosiveFalloffPower: shot.explosive?.falloffPower ?? 1,
      controlImpairFactor: shot.controlImpairFactor,
      controlImpairDuration: shot.controlDuration,
      homingTargetId: resolvedHomingTargetId,
      homingAimX: finalIntendedTargetX,
      homingAimY: finalIntendedTargetY,
      homingTurnRateDegPerSec: shot.trackingTurnRateDegPerSec,
      ttl,
      sourceId: unit.id,
      side: unit.side,
      sourceUnitType: unit.type,
      fireOriginY: muzzle.y,
      initialVy: uy * projectileSpeed,
      sourceWeaponAttachmentId: attachmentId,
      damage: shot.damage,
      currentDamage: shot.damage,
      hitImpulse: shot.impulse,
      initialPenetration: shot.penetration,
      remainingPenetration: shot.penetration,
      r: capsule.halfLength + capsule.radius,
    });
    if (requiresDedicatedLoader) {
      unit.weaponReadyCharges[slot] = Math.max(0, (unit.weaponReadyCharges[slot] ?? 0) - 1);
      unit.weaponFireTimers[slot] = this.getWeaponMinFireInterval(unit, slot);
    } else {
      unit.weaponFireTimers[slot] = shot.cooldown;
    }
    this.queueAudioEvent({
      kind: "fire",
      x: muzzle.x,
      y: muzzle.y,
      projectileClass: shot.projectileClass,
      fireSoundPool: this.getAttachmentPart(attachment)?.partProperties?.fireSoundPool ?? this.getDefaultFireSoundPool(attachment.component),
      damage: shot.damage,
      projectileSpeed,
      volume: clamp(this.getAttachmentPart(attachment)?.partProperties?.fireSoundVolume ?? 1, 0, 2),
    });
    if (manual) {
      this.hooks.addLog(`${unit.name} fired weapon #${slot + 1}`, "warn");
    }
    return true;
  }

  private clampAndAdjustAngle(
    unit: UnitInstance,
    componentId: keyof typeof COMPONENTS,
    angleRad: number,
    attachment?: UnitInstance["attachments"][number],
  ): number {
    const stats = COMPONENTS[componentId];
    const facingAngle = attachment
      ? this.getAttachmentWeaponFacingAngleRad(unit, attachment)
      : (unit.facing === 1 ? 0 : Math.PI);
    const angleLimit = this.resolveWeaponAngleLimit(
      stats,
      attachment ? this.getAttachmentPart(attachment) : null,
    );
    if (!angleLimit.enabled) {
      return angleRad;
    }

    // Normalize angle relative to facing
    const relativeAngle = Math.atan2(Math.sin(angleRad - facingAngle), Math.cos(angleRad - facingAngle));

    // Clamp to weapon arc (cw is +delta, ccw is -delta in this coordinate system)
    const clampedRelative = clamp(relativeAngle, -angleLimit.ccwRad, angleLimit.cwRad);

    return facingAngle + clampedRelative;
  }

  private createEmptyLossStats(): BattleLossStats {
    return {
      player: { destroyedObjects: 0, gasWasted: 0 },
      enemy: { destroyedObjects: 0, gasWasted: 0 },
    };
  }

  private updateGroundWreck(unit: UnitInstance, dt: number): void {
    if (unit.groundWreckTimerS === null) {
      unit.groundWreckTimerS = GROUND_WRECK_LIFETIME_SECONDS;
      unit.groundWreckInitialCellHp = [];
      unit.aiDebugDecisionPath = "ground-wreck";
      for (const cell of unit.structure) {
        if (cell.destroyed) {
          continue;
        }
        const roll = this.stableUnitCellRandom(unit.id, cell.id);
        const initialLossRatio = GROUND_WRECK_MIN_INITIAL_HP_LOSS_RATIO
          + roll * (GROUND_WRECK_MAX_INITIAL_HP_LOSS_RATIO - GROUND_WRECK_MIN_INITIAL_HP_LOSS_RATIO);
        const currentRemainingHp = Math.max(0, cell.breakThreshold - cell.strain);
        const damagedRemainingHp = cell.breakThreshold * (1 - initialLossRatio);
        const initialRemainingHp = Math.min(currentRemainingHp, damagedRemainingHp);
        unit.groundWreckInitialCellHp[cell.id] = initialRemainingHp;
        cell.strain = Math.max(cell.strain, cell.breakThreshold - initialRemainingHp);
      }
    }

    unit.groundWreckTimerS = Math.max(0, unit.groundWreckTimerS - dt);
    const lifetimeRatio = unit.groundWreckTimerS / Math.max(0.001, GROUND_WRECK_LIFETIME_SECONDS);
    for (const cell of unit.structure) {
      if (cell.destroyed) {
        continue;
      }
      const initialRemainingHp = unit.groundWreckInitialCellHp[cell.id]
        ?? Math.max(0, cell.breakThreshold - cell.strain);
      const linearRemainingHp = initialRemainingHp * lifetimeRatio;
      cell.strain = Math.max(cell.strain, cell.breakThreshold - linearRemainingHp);
    }
    if (unit.groundWreckTimerS <= 0) {
      this.detonateGroundWreck(unit);
    }
  }

  private shouldGroundUnitEnterWreck(unit: UnitInstance): boolean {
    if (unit.type !== "ground") {
      return false;
    }
    if (unit.groundWreckTimerS !== null || !canOperate(unit)) {
      return true;
    }
    const hasGroundEngine = unit.attachments.some((attachment) => {
      if (!attachment.alive) {
        return false;
      }
      const stats = COMPONENTS[attachment.component];
      const power = attachment.stats?.power ?? stats.power ?? 0;
      return stats.type === "engine" && power > 0 && this.engineSupportsGround(attachment, stats);
    });
    return !hasGroundEngine || !this.hasAvailableWeapons(unit);
  }

  private detonateGroundWreck(unit: UnitInstance): void {
    const beforeDestroyed = new Set(unit.structure.filter((cell) => cell.destroyed).map((cell) => cell.id));
    const beforeAliveAttachments = new Set(unit.attachments.filter((attachment) => attachment.alive).map((attachment) => attachment.id));
    const wasAlive = unit.alive;
    for (const cell of unit.structure) {
      if (!cell.destroyed) {
        destroyCell(unit, cell.id);
      }
    }
    unit.alive = false;
    unit.groundWreckTimerS = 0;
    this.spawnBreakDebris(unit, beforeDestroyed, beforeAliveAttachments, wasAlive);
    this.queueAudioEvent({
      kind: "explosion",
      x: unit.x,
      y: unit.y,
      intensity: Math.max(12, unit.structure.length * 5),
      radius: Math.max(24, unit.radius * 1.35),
    });
  }

  private stableUnitCellRandom(unitId: string, cellId: number): number {
    let hash = 2166136261;
    const key = `${unitId}:${cellId}`;
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 0xffffffff;
  }

  private recordDestroyedUnits(): void {
    for (const unit of this.state.units) {
      if (unit.alive || unit.returnedToBase) {
        continue;
      }
      const sideStats = this.lossStats[unit.side];
      const templateGasCost = this.templates.find((template) => template.id === unit.templateId)?.gasCost;
      const gasValue = typeof templateGasCost === "number" && Number.isFinite(templateGasCost)
        ? templateGasCost
        : unit.deploymentGasCost;
      sideStats.destroyedObjects += 1;
      sideStats.gasWasted += Math.max(0, gasValue);
    }
  }

  public setBaseHp(side: Side | "both", maxHp: number, refill = true): number {
    const normalized = clamp(Math.floor(maxHp), 1, 1_000_000_000);
    const bases = side === "both"
      ? [this.state.playerBase, this.state.enemyBase]
      : [side === "player" ? this.state.playerBase : this.state.enemyBase];
    for (const base of bases) {
      const ratio = base.maxHp > 0 ? clamp(base.hp / base.maxHp, 0, 1) : 1;
      base.maxHp = normalized;
      base.hp = refill ? normalized : normalized * ratio;
    }
    return normalized;
  }

  private queueAudioEvent(event: BattleAudioEvent): void {
    if (this.audioEvents.length >= 96) this.audioEvents.shift();
    this.audioEvents.push(event);
  }

  private queueImpactAudioEvent(projectile: BattleState["projectiles"][number], cell: UnitInstance["structure"][number], incomingDamage: number, deliveredDamage: number, ignoreArmor = false): void {
    this.queueAudioEvent({
      kind: "impact",
      x: projectile.x,
      y: projectile.y,
      projectileClass: projectile.projectileClass,
      impactSoundPool: this.getDefaultFireSoundPool(
        this.state.units
          .find((unit) => unit.id === projectile.sourceId)
          ?.attachments.find((attachment) => attachment.id === projectile.sourceWeaponAttachmentId)
          ?.component ?? "rapidGun",
      ),
      materialColor: cell.color,
      armor: ignoreArmor ? 0 : cell.armor,
      incomingDamage,
      deliveredDamage,
    });
  }

  /** Browser renderers consume these transient events; simulation/headless callers can ignore them. */
  public consumeBattleAudioEvents(): BattleAudioEvent[] {
    const events = this.audioEvents;
    this.audioEvents = [];
    return events;
  }

  public getDebugSnapshot(): Record<string, unknown> {
    const aliveUnits = this.state.units.filter((unit) => unit.alive);
    return {
      battlefield: this.getBattlefieldInfo(),
      movementSpeedMultiplier: this.movementSpeedMultiplier,
      active: this.state.active,
      nodeId: this.state.nodeId,
      outcome: this.state.outcome,
      counts: {
        units: aliveUnits.length,
        playerUnits: aliveUnits.filter((unit) => unit.side === "player").length,
        enemyUnits: aliveUnits.filter((unit) => unit.side === "enemy").length,
        projectiles: this.state.projectiles.length,
        particles: this.state.particles.length,
        debris: this.state.debris.length,
      },
      selection: this.getSelection(),
      units: aliveUnits.map((unit) => ({
        id: unit.id,
        name: unit.name,
        side: unit.side,
        type: unit.type,
        position: { x: unit.x, y: unit.y },
        velocity: { x: unit.vx, y: unit.vy },
        mass: unit.mass,
        structureAlive: unit.structure.filter((cell) => !cell.destroyed).length,
        structureTotal: unit.structure.length,
        functionalAlive: unit.attachments.filter((part) => part.alive).length,
        functionalTotal: unit.attachments.length,
        functionalSupportLinks: unit.attachments.reduce((sum, part) => sum + part.attachedStructureCellIds.length, 0),
        operational: canOperate(unit),
        escapeActive: unit.escapeActive,
        ai: {
          state: unit.aiState,
          targetId: unit.aiDebugTargetId,
          shouldEvade: unit.aiDebugShouldEvade,
          leadTimeS: unit.aiDebugLeadTimeS,
          aimAngleRad: unit.aiDebugLastAngleRad,
          range: unit.aiDebugLastRange,
          decisionPath: unit.aiDebugDecisionPath,
          fireBlockReason: unit.aiDebugFireBlockReason,
        },
      })),
    };
  }

  private getAttachmentWeaponFacingAngleRad(
    unit: UnitInstance,
    attachment: UnitInstance["attachments"][number],
  ): number {
    const q = this.resolveAttachmentFacingQuarter(attachment);
    let x = 1;
    let y = 0;
    if (q === 1) {
      x = 0;
      y = 1;
    } else if (q === 2) {
      x = -1;
      y = 0;
    } else if (q === 3) {
      x = 0;
      y = -1;
    }
    if (unit.facing !== 1) {
      x = -x;
    }
    return Math.atan2(y, x);
  }

  private getAttachmentProjectileClass(attachment: UnitInstance["attachments"][number]): ProjectileClass {
    const stats = COMPONENTS[attachment.component];
    return attachment.stats?.projectileClass
      ?? this.getAttachmentPart(attachment)?.partProperties?.projectileClass
      ?? stats.projectileClass
      ?? "bullet";
  }

  private requiresDedicatedLoaderForAttachment(attachment: UnitInstance["attachments"][number]): boolean {
    return this.getAttachmentPart(attachment)?.partProperties?.needLoader
      ?? (
        attachment.component === "heavyCannon"
        || attachment.component === "explosiveShell"
        || attachment.component === "trackingMissile"
      );
  }

  private getDefaultFireSoundPool(component: ComponentId): FireSoundPool {
    if (component === "heavyCannon") return "heavy-shot";
    if (component === "explosiveShell") return "explosive";
    if (component === "trackingMissile") return "tracking";
    if (component === "precisionBeam") return "beam-precision";
    return "rapid-fire";
  }

  private normalizeLoaderSupports(values: ReadonlyArray<string> | undefined): ProjectileClass[] {
    if (!values || values.length <= 0) {
      return [];
    }
    const supports: ProjectileClass[] = [];
    for (const value of values) {
      if (
        value === "bullet"
        || value === "missile"
        || value === "laser"
      ) {
        supports.push(value);
      }
    }
    return supports;
  }

  private getLoaderConfig(loaderAttachment: UnitInstance["attachments"][number]): {
    supports: ProjectileClass[];
    loadMultiplier: number;
    fastOperation: boolean;
    minLoadTime: number;
    minBurstInterval: number;
  } | null {
    const loaderStats = COMPONENTS[loaderAttachment.component];
    if (loaderStats.type !== "loader" || !loaderStats.loader) {
      return null;
    }
    const partDefinition = loaderAttachment.partId
      ? this.partCatalog.find((part) => part.id === loaderAttachment.partId)
      : undefined;
    const supportsFromStats = loaderAttachment.stats?.loaderSupports && loaderAttachment.stats.loaderSupports.length > 0
      ? [...loaderAttachment.stats.loaderSupports]
      : [];
    const supportsLegacy = this.normalizeLoaderSupports(
      partDefinition?.properties?.loaderServesTags,
    );
    const supports = supportsFromStats.length > 0
      ? supportsFromStats
      : supportsLegacy.length > 0
        ? supportsLegacy
        : [...loaderStats.loader.supports];
    return {
      supports,
      loadMultiplier: loaderAttachment.stats?.loaderLoadMultiplier
        ?? partDefinition?.properties?.loaderCooldownMultiplier
        ?? loaderStats.loader.loadMultiplier,
      fastOperation: loaderAttachment.stats?.loaderFastOperation ?? loaderStats.loader.fastOperation,
      minLoadTime: loaderAttachment.stats?.loaderMinLoadTime ?? loaderStats.loader.minLoadTime,
      minBurstInterval: loaderAttachment.stats?.loaderMinBurstInterval ?? loaderStats.loader.minBurstInterval,
    };
  }

  private getWeaponMinFireInterval(unit: UnitInstance, slot: number): number {
    const weaponAttachmentId = unit.weaponAttachmentIds[slot];
    const weaponAttachment = unit.attachments.find((entry) => entry.id === weaponAttachmentId && entry.alive);
    if (!weaponAttachment) {
      return 0;
    }
    const weaponStats = COMPONENTS[weaponAttachment.component];
    if (weaponStats.type !== "weapon") {
      return 0;
    }
    const capacity = this.getWeaponChargeCapacity(unit, slot);
    if (capacity === 1) {
      return 0;
    }
    const part = this.getAttachmentPart(weaponAttachment);
    return Math.max(0, part?.partProperties?.minFireInterval ?? 0.2);
  }

  private getWeaponChargeCapacity(unit: UnitInstance, slot: number): number {
    const weaponAttachmentId = unit.weaponAttachmentIds[slot];
    const weaponAttachment = unit.attachments.find((entry) => entry.id === weaponAttachmentId && entry.alive);
    if (!weaponAttachment) {
      return 0;
    }
    const weaponStats = COMPONENTS[weaponAttachment.component];
    if (weaponStats.type !== "weapon") {
      return 0;
    }
    if (!this.requiresDedicatedLoaderForAttachment(weaponAttachment)) {
      return 1;
    }
    let hasCompatibleLoader = false;
    for (const loaderState of unit.loaderStates) {
      const loaderAttachment = unit.attachments.find((entry) => entry.id === loaderState.attachmentId && entry.alive);
      if (!loaderAttachment) {
        continue;
      }
      const loader = this.getLoaderConfig(loaderAttachment);
      if (!loader || !loader.supports.includes(this.getAttachmentProjectileClass(weaponAttachment))) {
        continue;
      }
      hasCompatibleLoader = true;
    }
    if (!hasCompatibleLoader) {
      return 0;
    }
    const partDefinition = weaponAttachment.partId
      ? this.partCatalog.find((part) => part.id === weaponAttachment.partId)
      : undefined;
    return Math.max(1, Math.floor(partDefinition?.partProperties?.maxCapacity ?? weaponStats.maxLoadedAmmo ?? 1));
  }

  private computeLoaderDuration(
    loader: {
      loadMultiplier: number;
      fastOperation: boolean;
      minLoadTime: number;
    },
    weaponCooldown: number,
  ): number {
    const operationFactor = loader.fastOperation ? 0.82 : 1.08;
    const scaled = weaponCooldown * loader.loadMultiplier * operationFactor;
    return Math.max(loader.minLoadTime, scaled);
  }

  private updateWeaponLoaders(unit: UnitInstance, dt: number, prioritizeSelectedWeapon: boolean): void {
    for (let i = 0; i < unit.weaponLoadTimers.length; i += 1) {
      unit.weaponLoadTimers[i] = 0;
      const cap = this.getWeaponChargeCapacity(unit, i);
      unit.weaponReadyCharges[i] = Math.min(cap, Math.max(0, unit.weaponReadyCharges[i] ?? 0));
    }

    const alreadyLoading = new Set<number>();
    for (const loaderState of unit.loaderStates) {
      const loaderAttachment = unit.attachments.find((entry) => entry.id === loaderState.attachmentId && entry.alive);
      if (!loaderAttachment) {
        loaderState.targetWeaponSlot = null;
        loaderState.remaining = 0;
        continue;
      }
      const loaderConfig = this.getLoaderConfig(loaderAttachment);
      if (!loaderConfig) {
        loaderState.targetWeaponSlot = null;
        loaderState.remaining = 0;
        continue;
      }

      if (loaderState.targetWeaponSlot !== null) {
        const targetSlot = loaderState.targetWeaponSlot;
        const weaponAttachmentId = unit.weaponAttachmentIds[targetSlot];
        const weaponAttachment = unit.attachments.find((entry) => entry.id === weaponAttachmentId && entry.alive);
        const weaponStats = weaponAttachment ? COMPONENTS[weaponAttachment.component] : null;
        const projectileClass = weaponStats?.type === "weapon" && weaponAttachment
          ? this.getAttachmentProjectileClass(weaponAttachment)
          : null;
        if (
          projectileClass === null ||
          !loaderConfig.supports.includes(projectileClass) ||
          (unit.weaponReadyCharges[targetSlot] ?? 0) >= this.getWeaponChargeCapacity(unit, targetSlot)
        ) {
          loaderState.targetWeaponSlot = null;
          loaderState.remaining = 0;
        }
      }

      if (loaderState.targetWeaponSlot !== null) {
        loaderState.remaining = Math.max(0, loaderState.remaining - dt);
        const targetSlot = loaderState.targetWeaponSlot;
        unit.weaponLoadTimers[targetSlot] = Math.max(unit.weaponLoadTimers[targetSlot] ?? 0, loaderState.remaining);
        alreadyLoading.add(targetSlot);
        if (loaderState.remaining <= 0) {
          const cap = this.getWeaponChargeCapacity(unit, targetSlot);
          unit.weaponReadyCharges[targetSlot] = Math.min(cap, (unit.weaponReadyCharges[targetSlot] ?? 0) + 1);
          loaderState.targetWeaponSlot = null;
          loaderState.remaining = 0;
        }
      }
    }

    for (const loaderState of unit.loaderStates) {
      if (loaderState.targetWeaponSlot !== null) {
        continue;
      }
      const loaderAttachment = unit.attachments.find((entry) => entry.id === loaderState.attachmentId && entry.alive);
      if (!loaderAttachment) {
        continue;
      }
      const loaderConfig = this.getLoaderConfig(loaderAttachment);
      if (!loaderConfig) {
        continue;
      }

      const slotOrder: number[] = [];
      if (prioritizeSelectedWeapon) {
        slotOrder.push(clamp(unit.selectedWeaponIndex, 0, Math.max(0, unit.weaponAttachmentIds.length - 1)));
      }
      for (let i = 0; i < unit.weaponAttachmentIds.length; i += 1) {
        if (!slotOrder.includes(i)) {
          slotOrder.push(i);
        }
      }

      const nextSlot = slotOrder.find((slot) => {
        if (alreadyLoading.has(slot)) {
          return false;
        }
        const weaponAttachmentId = unit.weaponAttachmentIds[slot];
        const weaponAttachment = unit.attachments.find((entry) => entry.id === weaponAttachmentId && entry.alive);
        if (!weaponAttachment) {
          return false;
        }
        const weaponStats = COMPONENTS[weaponAttachment.component];
        if (weaponStats.type !== "weapon") {
          return false;
        }
        const projectileClass = this.getAttachmentProjectileClass(weaponAttachment);
        if (!loaderConfig.supports.includes(projectileClass)) {
          return false;
        }
        const cap = this.getWeaponChargeCapacity(unit, slot);
        return (unit.weaponReadyCharges[slot] ?? 0) < cap;
      });

      if (nextSlot === undefined) {
        continue;
      }

      const weaponAttachmentId = unit.weaponAttachmentIds[nextSlot];
      const weaponAttachment = unit.attachments.find((entry) => entry.id === weaponAttachmentId && entry.alive);
      const weaponStats = weaponAttachment ? COMPONENTS[weaponAttachment.component] : null;
      if (!weaponStats || weaponStats.type !== "weapon") {
        continue;
      }
      const weaponCooldown = weaponAttachment?.stats?.cooldown ?? weaponStats.cooldown ?? 1;

      loaderState.targetWeaponSlot = nextSlot;
      loaderState.remaining = this.computeLoaderDuration(loaderConfig, weaponCooldown);
      unit.weaponLoadTimers[nextSlot] = Math.max(unit.weaponLoadTimers[nextSlot] ?? 0, loaderState.remaining);
      alreadyLoading.add(nextSlot);
    }
  }

  private refreshUnitMobility(unit: UnitInstance): void {
    let totalPower = 0;
    let weightedSpeedCap = 0;
    let capWeight = 0;
    for (const attachment of unit.attachments) {
      if (!attachment.alive) {
        continue;
      }
      const stats = COMPONENTS[attachment.component];
      if (stats.type !== "engine") {
        continue;
      }
      if (unit.type === "air") {
        if (!this.engineSupportsAir(attachment, stats)) {
          continue;
        }
      } else if (!this.engineSupportsGround(attachment, stats)) {
        continue;
      }
      const enginePower = Math.max(0, attachment.stats?.power ?? stats.power ?? 0);
      const engineSpeedCap = Math.max(1, attachment.stats?.maxSpeed ?? stats.maxSpeed ?? 90);
      totalPower += enginePower;
      weightedSpeedCap += engineSpeedCap * Math.max(1, enginePower);
      capWeight += Math.max(1, enginePower);
    }
    if (totalPower <= 0) {
      unit.maxSpeed = 0;
      unit.accel = 0;
      unit.turnDrag = 0.8;
      return;
    }
    const speedCap = Math.max(1, weightedSpeedCap / Math.max(1, capWeight));
    const powerToMass = totalPower / Math.max(16, unit.mass);
    const rawSpeed = unit.type === "ground"
      ? powerToMass * 74
      : Math.max(0, powerToMass * AIR_POWER_TO_SPEED_SCALE - AIR_HOLD_GRAVITY);
    unit.maxSpeed = clamp(Math.min(rawSpeed, speedCap), 0, speedCap);
    unit.accel = unit.type === "air"
      ? Math.max(0, powerToMass * AIR_POWER_TO_SPEED_SCALE * AIRCRAFT_ACCELERATION_RATIO)
      : clamp(rawSpeed * 0.92, 0, Math.max(16, unit.maxSpeed * 1.6));
    const speedRatio = unit.maxSpeed / Math.max(1, speedCap);
    unit.turnDrag = clamp(0.8 + speedRatio * 0.14, 0.8, 0.94);
  }

  private getDirectionQuarter(direction: PartDirection | undefined): 0 | 1 | 2 | 3 {
    if (direction === "down") {
      return 1;
    }
    if (direction === "left") {
      return 2;
    }
    if (direction === "up") {
      return 3;
    }
    return 0;
  }

  private resolveAttachmentFacingQuarter(attachment: { partId?: number; component: ComponentId; rotateQuarter: number }): 0 | 1 | 2 | 3 {
    const part = attachment.partId
      ? this.partCatalog.find((catalogPart) => catalogPart.id === attachment.partId)
      : undefined;
    const baseQuarter = this.getDirectionQuarter(
      part?.direction,
    );
    const rotateQuarter = part
      ? normalizePartAttachmentRotate(part, attachment.rotateQuarter)
      : ((attachment.rotateQuarter % 4 + 4) % 4) as 0 | 1 | 2 | 3;
    const placementChangesFacing = part?.directional ?? COMPONENTS[attachment.component].directional === true;
    const facingRotation = placementChangesFacing ? rotateQuarter : 0;
    return ((baseQuarter + facingRotation) % 4 + 4) % 4 as 0 | 1 | 2 | 3;
  }

  private getAttachmentPart(attachment: { partId?: number }): PartDefinition | null {
    if (!attachment.partId) {
      return null;
    }
    return this.partCatalog.find((part) => part.id === attachment.partId) ?? null;
  }

  private engineSupportsAir(attachment: UnitInstance["attachments"][number], stats: ComponentStats): boolean {
    const part = this.getAttachmentPart(attachment);
    if (part?.partType === "engine" && part.partProperties?.powerAir !== undefined) {
      return part.partProperties.powerAir === true;
    }
    if (part?.properties?.engineType) {
      return part.properties.engineType === "air";
    }
    return stats.propulsion?.platform === "air";
  }

  private engineSupportsGround(attachment: UnitInstance["attachments"][number], stats: ComponentStats): boolean {
    const part = this.getAttachmentPart(attachment);
    if (part?.partType === "engine" && part.partProperties?.powerGround !== undefined) {
      return part.partProperties.powerGround === true;
    }
    if (part?.properties?.engineType) {
      return part.properties.engineType === "ground";
    }
    return stats.propulsion?.platform === "ground";
  }

  private resolveWeaponAngleLimit(
    stats: ComponentStats,
    part: PartDefinition | null = null,
  ): { enabled: boolean; cwRad: number; ccwRad: number } {
    const hasAngleLimit = part?.partProperties?.hasAngleLimit;
    if (hasAngleLimit === false) {
      return { enabled: false, cwRad: 0, ccwRad: 0 };
    }
    const explicitCw = part?.partProperties?.cwAngle;
    const explicitCcw = part?.partProperties?.ccwAngle;
    if (hasAngleLimit === true && Number.isFinite(explicitCw) && Number.isFinite(explicitCcw)) {
      return {
        enabled: true,
        cwRad: Math.max(0, explicitCw ?? 0) * Math.PI / 180,
        ccwRad: Math.max(0, explicitCcw ?? 0) * Math.PI / 180,
      };
    }

    if (stats.hasAngleLimit !== true || !Number.isFinite(stats.cwAngle) || !Number.isFinite(stats.ccwAngle)) {
      return { enabled: false, cwRad: 0, ccwRad: 0 };
    }
    return {
      enabled: true,
      cwRad: Math.max(0, stats.cwAngle ?? 0) * Math.PI / 180,
      ccwRad: Math.max(0, stats.ccwAngle ?? 0) * Math.PI / 180,
    };
  }

  private normalizeMovementSpeedMultiplier(multiplier: number | undefined): number {
    return typeof multiplier === "number" && Number.isFinite(multiplier)
      ? multiplier
      : DEFAULT_UNIT_MOVEMENT_SPEED_MULTIPLIER;
  }

  private scaleMovementSpeed(speed: number): number {
    return speed * this.movementSpeedMultiplier;
  }

  private computeAirThrustSpeed(unit: UnitInstance): number {
    let thrustSpeed = 0;
    for (const attachment of unit.attachments) {
      if (!attachment.alive) {
        continue;
      }
      const stats = COMPONENTS[attachment.component];
      if (stats.type !== "engine" || !this.engineSupportsAir(attachment, stats)) {
        continue;
      }
      const enginePower = Math.max(0, attachment.stats?.power ?? stats.power ?? 0);
      thrustSpeed += (enginePower / Math.max(16, unit.mass)) * AIR_POWER_TO_SPEED_SCALE;
    }
    return thrustSpeed;
  }

  private applyAirThrustMovement(unit: UnitInstance, dt: number, inputX: number, inputY: number, allowDescend: boolean): void {
    const clampedX = clamp(inputX, -1.4, 1.4);
    const clampedY = clamp(inputY, -1.4, 1.4);
    void allowDescend;
    const moveLen = Math.hypot(clampedX, clampedY);
    const ux = moveLen > 1e-6 ? clampedX / moveLen : 0;
    const uy = moveLen > 1e-6 ? clampedY / moveLen : 0;
    const moveSpeed = this.scaleMovementSpeed(unit.maxSpeed);
    const targetVx = ux * moveSpeed;
    const targetVy = uy * moveSpeed;
    const deltaVx = targetVx - unit.vx;
    const deltaVy = targetVy - unit.vy;
    const deltaSpeed = Math.hypot(deltaVx, deltaVy);
    const accelerationStep = Math.max(0, unit.accel) * dt;
    if (deltaSpeed <= accelerationStep || deltaSpeed <= 1e-6) {
      unit.vx = targetVx;
      unit.vy = targetVy;
    } else if (accelerationStep > 0) {
      unit.vx += deltaVx / deltaSpeed * accelerationStep;
      unit.vy += deltaVy / deltaSpeed * accelerationStep;
    }

    const fallAccel = Math.max(0, AIR_HOLD_GRAVITY - this.computeAirThrustSpeed(unit));
    if (fallAccel > 0) {
      unit.vy += fallAccel * dt;
      unit.aiDebugFireBlockReason = "low-lift";
    } else if (Math.abs(unit.vy) < 1.2) {
      unit.vy = 0;
    }
  }

  private executeCommand(unit: UnitInstance, command: UnitCommand, dt: number): CommandResult {
    const result: CommandResult = { firedSlots: [], fireBlocked: [] };

    // --- Facing ---
    if (command.facing !== null) {
      unit.facing = command.facing;
    }

    // --- Movement ---
    if (unit.airDropActive) {
      unit.vx = 0;
      unit.vy = Math.max(0, unit.vy);
      unit.vy += AIR_DROP_GRAVITY * dt;
    } else if (unit.type === "air") {
      this.applyAirThrustMovement(unit, dt, command.move.dirX, command.move.dirY, command.move.allowDescend ?? false);
    } else {
      // Ground movement
      const movementAccel = this.scaleMovementSpeed(unit.accel);
      unit.vx += command.move.dirX * movementAccel * dt;
      unit.vy += command.move.dirY * movementAccel * dt;
    }

    // --- Fire ---
    if (!canOperate(unit)) {
      for (const req of command.fire) {
        result.fireBlocked.push({ slot: req.slot, reason: "cannot-operate" });
      }
      return result;
    }
    for (const req of command.fire) {
      if (req.slot >= 0 && req.slot < unit.weaponAimAngles.length) {
        unit.weaponAimAngles[req.slot] = req.angleRad;
      }
      const fired = this.fireWeaponSlot(unit, req.slot, req.manual, req.angleRad, req.intendedTargetId, req.intendedTargetY);
      if (fired) {
        result.firedSlots.push(req.slot);
      } else {
        // Determine block reason
        let reason: FireBlockDetail["reason"] = "cooldown";
        if (req.slot < 0 || req.slot >= unit.weaponAttachmentIds.length) {
          reason = "invalid-slot";
        } else {
          const attachmentId = unit.weaponAttachmentIds[req.slot];
          const attachment = unit.attachments.find((a) => a.id === attachmentId && a.alive);
          if (!attachment) {
            reason = "dead-weapon";
          } else if ((unit.weaponFireTimers[req.slot] ?? 0) > 0) {
            reason = "cooldown";
          } else {
            const stats = COMPONENTS[attachment.component];
            if (stats.type === "weapon") {
              if (this.requiresDedicatedLoaderForAttachment(attachment)) {
                const charges = unit.weaponReadyCharges[req.slot] ?? 0;
                if (charges <= 0) {
                  reason = "no-charges";
                }
              }
            }
          }
        }
        result.fireBlocked.push({ slot: req.slot, reason });
      }
    }

    return result;
  }

  private playerInputToCommand(unit: UnitInstance, _dt: number, keys: KeyState): UnitCommand {
    let dx = clamp(keys.moveX ?? 0, -1, 1);
    let dy = clamp(keys.moveY ?? 0, -1, 1);
    if (keys.a) dx -= 1;
    if (keys.d) dx += 1;
    if (keys.w) dy -= 1;
    if (keys.s) dy += 1;
    const moveLength = Math.hypot(dx, dy);
    if (moveLength > 1) {
      dx /= moveLength;
      dy /= moveLength;
    }

    const controllerAimX = keys.aimX ?? 0;
    const controllerAimY = keys.aimY ?? 0;
    if (Math.hypot(controllerAimX, controllerAimY) > 0.01) {
      const aimAngle = Math.atan2(controllerAimY, controllerAimX);
      this.controllerAimAngleRad = aimAngle;
      const aimDistance = Math.max(this.canvas.width, this.canvas.height);
      this.aimX = clamp(unit.x + Math.cos(aimAngle) * aimDistance, 0, this.canvas.width);
      this.aimY = clamp(unit.y + Math.sin(aimAngle) * aimDistance, 0, this.canvas.height);
    }

    const fire: FireRequest[] = [];

    const manualAimAngle = this.controllerAimAngleRad ?? Math.atan2(this.aimY - unit.y, this.aimX - unit.x);
    for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
      if (this.isWeaponManualControlEnabled(unit, slot)) unit.weaponAimAngles[slot] = manualAimAngle;
    }

    if (!this.hasAvailableWeapons(unit)) {
      // Weaponless player unit — no fire, just movement
      return { move: { dirX: dx, dirY: dy, allowDescend: dy > 0.06 }, facing: null, fire };
    }

    // Manual fire from mouse hold or controller trigger/bumper.
    if (this.manualFireHeld || keys.manualFire === true) {
      for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
        if (this.isWeaponManualControlEnabled(unit, slot)) {
          const angleRad = manualAimAngle;
          fire.push(this.createManualFireRequest(unit, slot, angleRad));
        }
      }
    }

    // Auto-fire for non-manual slots uses the same fire decision path as AI units.
    const suppressedAutoSlots = this.getManualControlSuppressedSlots(unit);
    unit.aiStateTimer += _dt;
    unit.aiDodgeCooldown = Math.max(0, unit.aiDodgeCooldown - _dt);
    const decision = this.getCombatDecision(unit, _dt);
    this.appendFireRequestsFromDecision(unit, decision, fire, suppressedAutoSlots);

    return { move: { dirX: dx, dirY: dy, allowDescend: dy > 0.06 }, facing: null, fire };
  }

  private createManualFireRequest(unit: UnitInstance, slot: number, angleRad: number): FireRequest {
    const attachmentId = unit.weaponAttachmentIds[slot];
    const attachment = unit.attachments.find((entry) => entry.id === attachmentId && entry.alive) ?? null;
    const stats = attachment ? COMPONENTS[attachment.component] : null;
    const needsTarget = stats?.type === "weapon" && attachment !== null
      && this.getAttachmentProjectileClass(attachment) === "missile"
      && (attachment.stats?.trackingTurnRateDegPerSec ?? stats.tracking?.turnRateDegPerSec ?? 0) > 0;
    const target = needsTarget ? this.findEnemyAlongAim(unit, slot, angleRad) : null;
    return {
      slot,
      angleRad,
      intendedTargetId: target?.id ?? null,
      intendedTargetY: target?.y ?? null,
      manual: true,
    };
  }

  /** Selects the target closest to the forward aim ray for target-dependent player weapons. */
  private findEnemyAlongAim(unit: UnitInstance, slot: number, angleRad: number): UnitInstance | null {
    const weapon = this.getWeaponFireInput(unit, slot);
    const maxRange = weapon?.effectiveRange ?? Math.max(this.canvas.width, this.canvas.height);
    const ux = Math.cos(angleRad);
    const uy = Math.sin(angleRad);
    let best: UnitInstance | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of this.state.units) {
      if (!candidate.alive || !canOperate(candidate) || candidate.side === unit.side) continue;
      const relX = candidate.x - unit.x;
      const relY = candidate.y - unit.y;
      const forwardDistance = relX * ux + relY * uy;
      if (forwardDistance <= 0 || forwardDistance > maxRange * 1.2) continue;
      const perpendicularDistance = Math.abs(relX * uy - relY * ux);
      const lockWidth = Math.max(candidate.radius + 36, forwardDistance * 0.32);
      if (perpendicularDistance > lockWidth) continue;
      const score = perpendicularDistance + forwardDistance * 0.035;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  private aiDecisionToCommand(unit: UnitInstance, decision: CombatDecision): UnitCommand {
    const fire: FireRequest[] = [];
    this.appendFireRequestsFromDecision(unit, decision, fire, null);

    return {
      move: { dirX: decision.movement.ax, dirY: decision.movement.ay },
      facing: decision.facing,
      fire,
    };
  }

  private getCombatDecision(unit: UnitInstance, dt: number): CombatDecision {
    const desiredRange = this.getDesiredEngageRange(unit);
    const baseTarget = this.getEnemyBaseCenter(unit.side);
    const controller = this.aiControllers[unit.side] ?? null;
    const input = {
      unit,
      state: this.state,
      dt,
      desiredRange,
      baseTarget,
      canShootAtAngle: (
        componentId: keyof typeof COMPONENTS,
        dx: number,
        dy: number,
        angleLimitOverride?: WeaponFireAiInput["angleLimit"],
      ) => this.canShootAtAngle(unit, componentId, dx, dy, angleLimitOverride),
      getEffectiveWeaponRange: (baseRange: number) => this.getEffectiveWeaponRange(unit, baseRange),
      getWeaponFireInput: (slot: number) => this.getWeaponFireInput(unit, slot),
    };
    return controller ? controller.decide(input) : this.baselineController.decide(input);
  }

  private appendFireRequestsFromDecision(
    unit: UnitInstance,
    decision: CombatDecision,
    fire: FireRequest[],
    suppressedAutoSlots: ReadonlySet<number> | null,
  ): void {
    unit.aiState = decision.state;
    unit.aiDebugShouldEvade = decision.movement.shouldEvade;
    unit.aiDebugTargetId = decision.debug.targetId;
    unit.aiDebugDecisionPath = decision.debug.decisionPath;
    unit.aiDebugFireBlockReason = decision.debug.fireBlockedReason;

    const plans = decision.firePlans.length > 0
      ? decision.firePlans
      : decision.firePlan
        ? [decision.firePlan]
        : [];
    const primaryPlan = plans[0] ?? null;
    if (!primaryPlan) {
      unit.aiDebugLastRange = 0;
      unit.aiDebugLastAngleRad = 0;
      unit.aiDebugPreferredWeaponSlot = -1;
      unit.aiDebugLeadTimeS = 0;
      return;
    }

    unit.aiDebugLastRange = primaryPlan.effectiveRange;
    unit.aiDebugLastAngleRad = primaryPlan.angleRad;
    unit.aiDebugPreferredWeaponSlot = primaryPlan.preferredSlot;
    unit.aiDebugLeadTimeS = primaryPlan.leadTimeS;

    const slotCount = unit.weaponAttachmentIds.length;
    if (slotCount <= 0) {
      return;
    }
    const plannedSlots = new Set<number>();
    for (const plan of plans) {
      const slot = ((plan.preferredSlot % slotCount) + slotCount) % slotCount;
      if (plannedSlots.has(slot)) continue;
      plannedSlots.add(slot);
      if (suppressedAutoSlots?.has(slot)) continue;
      if (!unit.weaponAutoFire[slot]) continue;
      if ((unit.weaponFireTimers[slot] ?? 0) > 0) continue;
      fire.push({
        slot,
        angleRad: plan.angleRad,
        intendedTargetId: plan.intendedTargetId,
        intendedTargetY: plan.intendedTargetY,
        manual: false,
      });
    }
  }

  private airDropReturnToCommand(unit: UnitInstance, _dt: number): UnitCommand {
    const fire: FireRequest[] = [];

    // Set debug info
    unit.aiState = "evade";
    unit.aiDebugShouldEvade = true;
    unit.aiDebugDecisionPath = unit.aiDebugDecisionPath || "air-drop";

    // Try to fire at closest enemy while dropping
    if (canOperate(unit) && this.hasAvailableWeapons(unit)) {
      const target = this.pickTarget(unit);
      if (target) {
        unit.aiDebugTargetId = target.id;
        const slotCount = unit.weaponAttachmentIds.length;
        for (let offset = 0; offset < slotCount; offset += 1) {
          const slot = (unit.aiWeaponCycleIndex + offset) % slotCount;
          if (!unit.weaponAutoFire[slot]) continue;
          if ((unit.weaponFireTimers[slot] ?? 0) > 0) continue;
          fire.push({
            slot,
            angleRad: Math.atan2(target.y - unit.y, target.x - unit.x),
            intendedTargetId: target.id,
            intendedTargetY: target.y,
            manual: false,
          });
          break;
        }
      }
    }

    return {
      move: { dirX: 0, dirY: 0 },
      facing: null,
      fire,
    };
  }

  private retreatToCommand(unit: UnitInstance): UnitCommand {
    const base = unit.side === "player" ? this.state.playerBase : this.state.enemyBase;
    const baseCenterX = base.x + base.w / 2;
    const baseCenterY = base.y + base.h / 2;
    const laneBounds = this.getLaneBounds();
    const retreatY = unit.type === "air"
      ? clamp(baseCenterY, laneBounds.airMinZ, laneBounds.airMaxZ)
      : clamp(baseCenterY, laneBounds.groundMinY, laneBounds.groundMaxY);

    const dx = baseCenterX - unit.x;
    const dy = retreatY - unit.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = (dy / dist) * 0.85;

    // Set debug info
    unit.aiState = "evade";
    unit.aiDebugShouldEvade = true;
    unit.aiDebugTargetId = null;
    unit.aiDebugDecisionPath = "escape-return";
    unit.aiDebugFireBlockReason = "no-available-weapons";
    unit.aiDebugPreferredWeaponSlot = -1;
    unit.aiDebugLeadTimeS = 0;

    return {
      move: { dirX: ux, dirY: uy },
      facing: unit.escapeFacingDelayS > 0 ? null : (ux < 0 ? -1 : ux > 0 ? 1 : null),
      fire: [],
    };
  }

  private onAirDropImpact(unit: UnitInstance): void {
    if (!unit.alive) {
      return;
    }
    unit.y = unit.airDropTargetY;
    unit.alive = false;
    if (unit.id === this.playerControlledId || unit.id === this.selectedUnitId) {
      this.clearControlSelection();
    }
    this.state.particles.push({
      x: unit.x,
      y: unit.y,
      life: 0.45 + Math.random() * 0.3,
      size: 14 + unit.radius * 0.55,
    });
    this.hooks.addLog(`${unit.name} crashed after losing lift`, "bad");
  }

  private canShootAtAngle(
    unit: UnitInstance,
    componentId: keyof typeof COMPONENTS,
    dx: number,
    dy: number,
    angleLimitOverride?: WeaponFireAiInput["angleLimit"],
  ): boolean {
    const stats = COMPONENTS[componentId];
    const facingAngle = angleLimitOverride?.facingAngleRad ?? (unit.facing === 1 ? 0 : Math.PI);
    const aimAngle = Math.atan2(dy, dx);
    const delta = Math.atan2(Math.sin(aimAngle - facingAngle), Math.cos(aimAngle - facingAngle));
    const limit = angleLimitOverride
      ? (() => {
          if (angleLimitOverride.hasAngleLimit === false) {
            return { enabled: false, cwRad: 0, ccwRad: 0 };
          }
          if (
            angleLimitOverride.hasAngleLimit === true
            && Number.isFinite(angleLimitOverride.cwAngle)
            && Number.isFinite(angleLimitOverride.ccwAngle)
          ) {
            return {
              enabled: true,
              cwRad: Math.max(0, angleLimitOverride.cwAngle ?? 0) * Math.PI / 180,
              ccwRad: Math.max(0, angleLimitOverride.ccwAngle ?? 0) * Math.PI / 180,
            };
          }
          return this.resolveWeaponAngleLimit(stats, null);
        })()
      : this.resolveWeaponAngleLimit(stats, null);
    if (!limit.enabled) {
      return true;
    }
    return delta <= limit.cwRad && delta >= -limit.ccwRad;
  }

  private pickTarget(unit: UnitInstance): UnitInstance | null {
    return selectBestTarget(unit, this.state);
  }

  private getEnemyBaseCenter(side: UnitInstance["side"]): { x: number; y: number } {
    const base = side === "player" ? this.state.enemyBase : this.state.playerBase;
    return {
      x: base.x + base.w * 0.5,
      y: base.y + base.h * 0.5,
    };
  }

  private updateTargetHistorySamples(dt: number): void {
    const sampleIntervalS = Math.max(1e-3, AI_TARGET_HISTORY_SAMPLE_INTERVAL_S);
    const maxSamples = Math.max(2, Math.floor(AI_TARGET_HISTORY_SAMPLES));
    for (const unit of this.state.units) {
      if (!unit.targetHistory || unit.targetHistory.length <= 0) {
        unit.targetHistory = [{ x: unit.x, y: unit.y }];
      }
      unit.targetHistorySampleTimerS += Math.max(0, dt);
      while (unit.targetHistorySampleTimerS >= sampleIntervalS) {
        unit.targetHistorySampleTimerS -= sampleIntervalS;
        unit.targetHistory.push({ x: unit.x, y: unit.y });
        while (unit.targetHistory.length > maxSamples) {
          unit.targetHistory.shift();
        }
      }
    }
  }

  private findClosestEnemyToPoint(side: UnitInstance["side"], x: number, y: number): UnitInstance | null {
    let best: UnitInstance | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const unit of this.state.units) {
      if (!unit.alive || !canOperate(unit) || unit.side === side) {
        continue;
      }
      const distance = Math.hypot(unit.x - x, unit.y - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = unit;
      }
    }
    return best;
  }

  private getControlledUnit(): UnitInstance | null {
    if (!this.playerControlledId) {
      return null;
    }
    return this.state.units.find((unit) => unit.id === this.playerControlledId && unit.alive && unit.side === "player") ?? null;
  }

  private isWeaponManualControlEnabled(unit: UnitInstance, slot: number): boolean {
    if (slot < 0 || slot >= unit.weaponAttachmentIds.length) {
      return false;
    }
    return unit.weaponManualControl[slot] !== false;
  }

  private getManualControlSuppressedSlots(unit: UnitInstance): Set<number> {
    const suppressed = new Set<number>();
    for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
      if (this.isWeaponManualControlEnabled(unit, slot)) {
        suppressed.add(slot);
      }
    }
    return suppressed;
  }

  /** Renderer-facing effective range for the unit's active/manual weapon selection. */
  public getSelectedWeaponRange(unit: UnitInstance): number {
    if (unit.id === this.playerControlledId) {
      let bestRange = 0;
      for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
        if (!this.isWeaponManualControlEnabled(unit, slot)) {
          continue;
        }
        const attachmentId = unit.weaponAttachmentIds[slot];
        const attachment = unit.attachments.find((entry) => entry.id === attachmentId && entry.alive);
        if (!attachment) {
          continue;
        }
        const stats = COMPONENTS[attachment.component];
        const range = attachment.stats?.range ?? stats.range;
        if (range === undefined) {
          continue;
        }
        bestRange = Math.max(bestRange, this.getEffectiveWeaponRange(unit, range));
      }
      if (bestRange > 0) {
        return bestRange;
      }
    }

    const slot = clamp(unit.selectedWeaponIndex, 0, Math.max(0, unit.weaponAttachmentIds.length - 1));
    const attachmentId = unit.weaponAttachmentIds[slot];
    if (attachmentId === undefined) {
      return 0;
    }
    const attachment = unit.attachments.find((entry) => entry.id === attachmentId && entry.alive);
    if (!attachment) {
      return 0;
    }
    const stats = COMPONENTS[attachment.component];
    const range = attachment.stats?.range ?? stats.range;
    if (range === undefined) {
      return 0;
    }
    return this.getEffectiveWeaponRange(unit, range);
  }

  private getDesiredEngageRange(unit: UnitInstance): number {
    const weapons = getAliveWeaponAttachments(unit);
    if (weapons.length === 0) {
      return 180;
    }
    let best = 180;
    for (const weaponAttachment of weapons) {
      const stats = COMPONENTS[weaponAttachment.component];
      const range = weaponAttachment.stats?.range ?? stats.range;
      if (range === undefined) {
        continue;
      }
      const factor = unit.type === "air" ? 0.52 : 0.62;
      best = Math.max(best, this.getEffectiveWeaponRange(unit, range) * factor);
    }
    const maxBand = unit.type === "air" ? this.canvas.width * 0.56 : this.canvas.width * 0.46;
    const minBand = unit.type === "air" ? 180 : 140;
    return clamp(best, minBand, maxBand);
  }

  private getEffectiveWeaponRange(unit: UnitInstance, baseRange: number): number {
    const globalBuff = baseRange * GLOBAL_WEAPON_RANGE_MULTIPLIER;
    if (unit.type !== "air") {
      return globalBuff;
    }
    const laneBounds = this.getLaneBounds();
    const airBonus = getAircraftAltitudeBonus(unit, laneBounds.airMinZ, laneBounds.groundMinY);
    return globalBuff * (1 + airBonus);
  }

  private hasAvailableWeapons(unit: UnitInstance): boolean {
    for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
      const attachmentId = unit.weaponAttachmentIds[slot];
      const weaponAttachment = unit.attachments.find((attachment) => attachment.id === attachmentId && attachment.alive);
      if (!weaponAttachment) continue;
      const weaponStats = COMPONENTS[weaponAttachment.component];
      if (weaponStats.type !== "weapon") continue;
      const projectileClass = this.getAttachmentProjectileClass(weaponAttachment);
      if (!this.requiresDedicatedLoaderForAttachment(weaponAttachment) || (unit.weaponReadyCharges[slot] ?? 0) > 0) {
        return true;
      }
      const canReload = unit.loaderStates.some((loaderState) => {
        const loaderAttachment = unit.attachments.find((attachment) => attachment.id === loaderState.attachmentId && attachment.alive);
        const loaderConfig = loaderAttachment ? this.getLoaderConfig(loaderAttachment) : null;
        return loaderConfig?.supports.includes(projectileClass) === true;
      });
      if (canReload) return true;
    }
    return false;
  }

  private activateEscapeIfUnavailable(unit: UnitInstance): void {
    if (unit.escapeActive || unit.returnedToBase || this.hasAvailableWeapons(unit)) {
      return;
    }
    unit.escapeActive = true;
    unit.escapeFacingDelayS = 1;
    unit.aiState = "evade";
    unit.aiDebugShouldEvade = true;
    unit.aiDebugDecisionPath = "escape-return";
    unit.aiDebugFireBlockReason = "no-available-weapons";
    if (unit.id === this.playerControlledId || unit.id === this.selectedUnitId) {
      this.clearControlSelection();
    }
    this.hooks.addLog(`${unit.name} has no available weapon and entered escape mode`, "warn");
  }

  private getAttachmentFirepointWorld(
    unit: UnitInstance,
    attachment: UnitInstance["attachments"][number],
  ): { x: number; y: number } {
    const weaponCellSize = getStructureCellSize(unit.radius);
    const weaponOffset = attachment.shootingOffset
      ? this.getCoordOffsetWorld(
          unit,
          attachment.x + attachment.shootingOffset.x,
          attachment.y + attachment.shootingOffset.y,
          weaponCellSize,
        )
      : this.getCoordOffsetWorld(unit, attachment.x, attachment.y, weaponCellSize);
    return {
      x: unit.x + weaponOffset.x,
      y: unit.y + weaponOffset.y,
    };
  }

  private getAttachmentVisualMuzzleWorld(
    unit: UnitInstance,
    attachment: UnitInstance["attachments"][number],
    angleRad: number,
  ): { x: number; y: number } {
    // Keep this geometry synchronized with structure rendering and collision.
    const visualCellSize = getStructureCellSize(unit.radius);
    const center = this.getCoordOffsetWorld(unit, attachment.x, attachment.y, visualCellSize);
    const barrelLength = (visualCellSize / 14) * 10;
    return {
      x: unit.x + center.x + Math.cos(angleRad) * barrelLength,
      y: unit.y + center.y + Math.sin(angleRad) * barrelLength,
    };
  }

  /** Shared weapon presentation geometry used by rendering and projectile spawn. */
  public getWeaponVisualState(
    unit: UnitInstance,
    attachmentId: number,
  ): { angleRad: number; firepointX: number; firepointY: number; muzzleX: number; muzzleY: number } | null {
    const slot = unit.weaponAttachmentIds.indexOf(attachmentId);
    if (slot < 0) return null;
    const attachment = unit.attachments.find((entry) => entry.id === attachmentId && entry.alive);
    if (!attachment) return null;
    const firepoint = this.getAttachmentFirepointWorld(unit, attachment);
    const requestedAngle = unit.weaponAimAngles[slot] ?? this.getAttachmentWeaponFacingAngleRad(unit, attachment);
    const angleRad = this.clampAndAdjustAngle(unit, attachment.component, requestedAngle, attachment);
    const muzzle = this.getAttachmentVisualMuzzleWorld(unit, attachment, angleRad);
    return {
      angleRad,
      firepointX: firepoint.x,
      firepointY: firepoint.y,
      muzzleX: muzzle.x,
      muzzleY: muzzle.y,
    };
  }

  /** Stable world center for a structure cell on the craft's original coordinate grid. */
  public getStructureCellWorldCenter(unit: UnitInstance, cellId: number): { x: number; y: number } | null {
    const cell = unit.structure.find((entry) => entry.id === cellId);
    if (!cell) return null;
    const offset = this.getCellOffsetWorld(unit, cell.id, getStructureCellSize(unit.radius));
    return { x: unit.x + offset.x, y: unit.y + offset.y };
  }

  private getWeaponFireInput(unit: UnitInstance, slot: number): WeaponFireAiInput | null {
    if (slot < 0 || slot >= unit.weaponAttachmentIds.length) {
      return null;
    }
    const attachmentId = unit.weaponAttachmentIds[slot];
    const attachment = unit.attachments.find((entry) => entry.id === attachmentId && entry.alive);
    if (!attachment) {
      return null;
    }
    const stats = COMPONENTS[attachment.component];
    if (stats.type !== "weapon" || stats.range === undefined || stats.damage === undefined) {
      return null;
    }
    const part = this.getAttachmentPart(attachment);
    const baseRange = attachment.stats?.range ?? stats.range;
    const firepoint = this.getAttachmentFirepointWorld(unit, attachment);
    return {
      componentId: attachment.component,
      projectileClass: attachment.stats?.projectileClass ?? part?.partProperties?.projectileClass ?? stats.projectileClass ?? "bullet",
      damage: attachment.stats?.damage ?? stats.damage,
      penetration: attachment.stats?.penetration ?? stats.penetration ?? 0,
      spreadDeg: attachment.stats?.spreadDeg ?? stats.spreadDeg ?? 0,
      explosiveBlastRadius: attachment.stats?.explosiveBlastRadius ?? stats.explosive?.blastRadius ?? 0,
      trackingTurnRateDegPerSec: attachment.stats?.trackingTurnRateDegPerSec ?? stats.tracking?.turnRateDegPerSec ?? 0,
      angleLimit: {
        hasAngleLimit: part?.partProperties?.hasAngleLimit ?? stats.hasAngleLimit,
        cwAngle: part?.partProperties?.cwAngle ?? stats.cwAngle,
        ccwAngle: part?.partProperties?.ccwAngle ?? stats.ccwAngle,
        facingAngleRad: this.getAttachmentWeaponFacingAngleRad(unit, attachment),
      },
      effectiveRange: this.getEffectiveWeaponRange(unit, baseRange),
      projectileSpeed: attachment.stats?.projectileSpeed ?? stats.projectileSpeed ?? PROJECTILE_SPEED,
      projectileGravity: attachment.stats?.projectileGravity ?? stats.projectileGravity ?? PROJECTILE_GRAVITY,
      firepointX: firepoint.x,
      firepointY: firepoint.y,
    };
  }

  private isExternalAiEnabled(side: Side): boolean {
    return this.externalAiSides[side] === true;
  }

  private noopCommandFor(): UnitCommand {
    return {
      move: { dirX: 0, dirY: 0, allowDescend: false },
      facing: null,
      fire: [],
    };
  }

  private consumeExternalCommandOrNoop(unit: UnitInstance): UnitCommand {
    const provided = this.externalCommandsByUnitId.get(unit.id) ?? null;
    if (provided) {
      this.externalCommandsByUnitId.delete(unit.id);
      unit.aiState = "engage";
      unit.aiDebugShouldEvade = false;
      unit.aiDebugTargetId = null;
      unit.aiDebugDecisionPath = "external-ai.command";
      unit.aiDebugFireBlockReason = null;
      return provided;
    }
    unit.aiState = "engage";
    unit.aiDebugShouldEvade = false;
    unit.aiDebugTargetId = null;
    unit.aiDebugDecisionPath = "external-ai.noop";
    unit.aiDebugFireBlockReason = "missing-command";
    unit.aiDebugLastRange = 0;
    unit.aiDebugLastAngleRad = 0;
    unit.aiDebugPreferredWeaponSlot = -1;
    unit.aiDebugLeadTimeS = 0;
    return this.noopCommandFor();
  }

  private isUnitInsideBase(unit: UnitInstance, base: BattleState["playerBase"]): boolean {
    const padding = unit.radius + 8;
    return unit.x > base.x - padding
      && unit.x < base.x + base.w + padding
      && unit.y > base.y - padding
      && unit.y < base.y + base.h + padding;
  }

  private onUnitReturnedToBase(unit: UnitInstance): void {
    if (unit.returnedToBase) {
      return;
    }
    unit.returnedToBase = true;
    unit.alive = false;

    if (unit.id === this.playerControlledId) {
      this.playerControlledId = null;
      this.selectedUnitId = null;
      this.manualFireHeld = false;
    } else if (unit.id === this.selectedUnitId) {
      this.selectedUnitId = this.playerControlledId;
    }

    if (unit.side !== "player") {
      this.hooks.addLog(`${unit.name} withdrew to base`, "warn");
      return;
    }

    const refund = Math.floor(unit.deploymentGasCost * BATTLE_SALVAGE_REFUND_FACTOR);
    if (refund > 0) {
      this.hooks.addPlayerGas(refund);
      this.hooks.addLog(`${unit.name} returned to base (+${refund} gas)`, "good");
    } else {
      this.hooks.addLog(`${unit.name} returned to base`, "good");
    }
  }

  private shouldIgnoreDamageForUnit(unit: UnitInstance): boolean {
    return this.controlledUnitInvincible && unit.side === "player" && unit.id === this.playerControlledId;
  }

  private endBattle(victory: boolean, reason: string): void {
    if (!this.state.active || this.state.outcome || !this.state.nodeId) {
      return;
    }
    this.state.outcome = { victory, reason };
    this.state.active = false;
    this.hooks.onBattleOver(victory, this.state.nodeId, reason);
  }

  private drawLanes(): void {
    const laneBounds = this.getLaneBounds();
    this.ctx.fillStyle = "rgba(138, 176, 216, 0.08)";
    this.ctx.fillRect(0, laneBounds.airMinZ - 20, this.canvas.width, laneBounds.airMaxZ - laneBounds.airMinZ + 40);

    this.ctx.fillStyle = "rgba(78, 122, 91, 0.17)";
    this.ctx.fillRect(0, laneBounds.groundMinY, this.canvas.width, laneBounds.groundMaxY - laneBounds.groundMinY);

    this.ctx.strokeStyle = "rgba(117, 158, 118, 0.18)";
    this.ctx.lineWidth = 1;
    for (let x = 0; x <= this.canvas.width; x += 34) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, laneBounds.groundMinY);
      this.ctx.lineTo(x, laneBounds.groundMaxY);
      this.ctx.stroke();
    }
    for (let y = laneBounds.groundMinY; y <= laneBounds.groundMaxY; y += 28) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.canvas.width, y);
      this.ctx.stroke();
    }

    this.ctx.strokeStyle = "rgba(188, 219, 255, 0.32)";
    this.ctx.beginPath();
    this.ctx.moveTo(0, laneBounds.airMaxZ + 16);
    this.ctx.lineTo(this.canvas.width, laneBounds.airMaxZ + 16);
    this.ctx.stroke();
  }

  private drawIdleMessage(): void {
    this.ctx.fillStyle = "rgba(10, 15, 24, 0.9)";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = "#d6e4f2";
    this.ctx.font = "600 28px Trebuchet MS";
    this.ctx.fillText("Map/Base Mode", this.canvas.width / 2 - 92, this.canvas.height / 2 - 10);
    this.ctx.fillStyle = "#98abc3";
    this.ctx.font = "16px Trebuchet MS";
    this.ctx.fillText("Select a map node and launch battle.", this.canvas.width / 2 - 128, this.canvas.height / 2 + 24);
  }

  private drawBase(base: BattleState["playerBase"], color: string, label: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(base.x, base.y, base.w, base.h);
    if (this.debugDrawEnabled) {
      this.ctx.strokeStyle = "rgba(141, 228, 169, 0.9)";
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(base.x, base.y, base.w, base.h);
    }
    this.ctx.fillStyle = "rgba(0,0,0,0.35)";
    this.ctx.fillRect(base.x, base.y + base.h + 6, 100, 8);
    const hpRatio = clamp(base.hp / base.maxHp, 0, 1);
    this.ctx.fillStyle = hpRatio > 0.5 ? "#67d39b" : hpRatio > 0.25 ? "#efc16a" : "#ee6f6f";
    this.ctx.fillRect(base.x, base.y + base.h + 6, 100 * hpRatio, 8);
    this.ctx.fillStyle = "#d7e3f0";
    this.ctx.font = "12px Trebuchet MS";
    this.ctx.fillText(label, base.x - 2, base.y - 8);
  }

  private drawTargetLines(): void {
    this.ctx.save();
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([5, 4]);

    for (const unit of this.state.units) {
      if (!unit.alive || !canOperate(unit)) {
        continue;
      }

      const targetUnit = unit.aiDebugTargetId
        ? this.state.units.find((entry) => entry.id === unit.aiDebugTargetId && entry.alive) ?? null
        : null;
      const targetPoint = targetUnit ?? this.getEnemyBaseCenter(unit.side);

      this.ctx.strokeStyle = unit.side === "player" ? "rgba(155, 213, 255, 0.75)" : "rgba(255, 177, 154, 0.75)";
      this.ctx.beginPath();
      this.ctx.moveTo(unit.x, unit.y);
      this.ctx.lineTo(targetPoint.x, targetPoint.y);
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  private drawUnit(unit: UnitInstance, now: number): void {
    const shakeX = Math.sin(now * 28) * unit.vibrate * 2.2;
    const shakeY = Math.cos(now * 21) * unit.vibrate * 1.8;

    this.ctx.save();
    this.ctx.translate(unit.x + shakeX, unit.y + shakeY);

    const sideSign = unit.facing;
    const w = unit.radius * 1.7;
    const h = unit.type === "ground" ? unit.radius * 0.95 : unit.radius * 0.7;
    const template = this.templates.find((entry) => entry.id === unit.templateId) ?? null;

    this.ctx.scale(sideSign, 1);

    this.drawStructureAndFunctionalLayer(unit);

    if (this.displayEnabled) {
      this.drawDisplayLayer(unit, w, h, template);
    }

    if (unit.id === this.playerControlledId) {
      this.drawOuterStructureHighlight(unit, "#8de4a9", 2.1);
    }
    if (unit.id === this.selectedUnitId) {
      this.drawOuterStructureHighlight(unit, "#ffd37f", 1.6);
    }
    this.ctx.restore();

  }

  private drawOuterStructureHighlight(unit: UnitInstance, stroke: string, width: number): void {
    const aliveCells = unit.structure.filter((cell) => !cell.destroyed);
    if (aliveCells.length === 0) {
      return;
    }
    const cellSize = getStructureCellSize(unit.radius);
    const pad = 1.5;
    const key = (x: number, y: number): string => `${x},${y}`;
    const aliveSet = new Set(aliveCells.map((cell) => key(cell.x, cell.y)));

    this.ctx.strokeStyle = stroke;
    this.ctx.lineWidth = width;
    this.ctx.beginPath();

    for (const cell of aliveCells) {
      const offset = this.getCellOffsetLocal(unit, cell.id, cellSize);
      const left = offset.x - cellSize / 2 - pad;
      const right = offset.x + cellSize / 2 + pad;
      const top = offset.y - cellSize / 2 - pad;
      const bottom = offset.y + cellSize / 2 + pad;

      if (!aliveSet.has(key(cell.x - 1, cell.y))) {
        this.ctx.moveTo(left, top);
        this.ctx.lineTo(left, bottom);
      }
      if (!aliveSet.has(key(cell.x + 1, cell.y))) {
        this.ctx.moveTo(right, top);
        this.ctx.lineTo(right, bottom);
      }
      if (!aliveSet.has(key(cell.x, cell.y - 1))) {
        this.ctx.moveTo(left, top);
        this.ctx.lineTo(right, top);
      }
      if (!aliveSet.has(key(cell.x, cell.y + 1))) {
        this.ctx.moveTo(left, bottom);
        this.ctx.lineTo(right, bottom);
      }
    }

    this.ctx.stroke();
  }

  private drawDisplayLayer(unit: UnitInstance, w: number, h: number, template: UnitTemplate | null): void {
    const items = template?.display ?? [];
    if (items.length === 0 && (!template || template.display === undefined)) {
      const liveCell = unit.structure.find((cell) => !cell.destroyed);
      this.ctx.globalAlpha = 0.58;
      this.ctx.fillStyle = liveCell ? "#7f95ad" : "#5f6671";
      this.ctx.fillRect(-w * 0.58, -h * 0.56, w * 1.16, h * 1.12);
      this.ctx.globalAlpha = 1;

      if (unit.type === "ground") {
        this.ctx.fillStyle = "#2b3746";
        this.ctx.fillRect(-w * 0.46, h * 0.36, w * 0.92, 4);
        this.ctx.fillStyle = "#1d2632";
        this.ctx.fillRect(-w * 0.42, h * 0.23, w * 0.84, 5);
      } else {
        this.ctx.strokeStyle = "rgba(203, 229, 255, 0.65)";
        this.ctx.beginPath();
        this.ctx.moveTo(-w * 0.46, h * 0.45);
        this.ctx.lineTo(-w * 0.12, h * 0.86);
        this.ctx.lineTo(w * 0.33, h * 0.45);
        this.ctx.stroke();
      }
      return;
    }
    if (items.length === 0) {
      return;
    }

    const cellSize = getStructureCellSize(unit.radius);
    for (const item of items) {
      const cell = unit.structure.find((entry) => entry.id === item.cell);
      if (!cell || cell.destroyed) {
        continue;
      }
      const offset = this.getCoordOffsetLocal(unit, item.x ?? cell.x, item.y ?? cell.y, cellSize);
      if (item.kind === "panel") {
        this.ctx.fillStyle = "rgba(134, 158, 183, 0.72)";
        this.ctx.fillRect(offset.x - cellSize * 0.4, offset.y - cellSize * 0.4, cellSize * 0.8, cellSize * 0.8);
      } else if (item.kind === "stripe") {
        this.ctx.fillStyle = "rgba(215, 231, 250, 0.74)";
        this.ctx.fillRect(offset.x - cellSize * 0.42, offset.y - 1.5, cellSize * 0.84, 3);
      } else {
        this.ctx.strokeStyle = "rgba(149, 205, 255, 0.86)";
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(offset.x - cellSize * 0.25, offset.y - cellSize * 0.25, cellSize * 0.5, cellSize * 0.5);
      }
    }
  }

  private drawStructureAndFunctionalLayer(unit: UnitInstance): void {
    const cellSize = getStructureCellSize(unit.radius);

    if (this.debugPartHpEnabled) {
      this.ctx.font = "9px Trebuchet MS";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
    }

    for (const cell of unit.structure) {
      const offset = this.getCellOffsetLocal(unit, cell.id, cellSize);
      this.ctx.strokeStyle = cell.destroyed ? "rgba(160, 94, 94, 0.55)" : "rgba(184, 202, 224, 0.9)";
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(offset.x - cellSize / 2, offset.y - cellSize / 2, cellSize, cellSize);
      if (!cell.destroyed) {
        this.ctx.fillStyle = "rgba(130, 158, 186, 0.22)";
        this.ctx.fillRect(offset.x - cellSize / 2 + 1, offset.y - cellSize / 2 + 1, cellSize - 2, cellSize - 2);
        if (this.debugPartHpEnabled) {
          const hpRatio = clamp((cell.breakThreshold - cell.strain) / Math.max(1, cell.breakThreshold), 0, 1);
          const damageRatio = 1 - hpRatio;
          if (damageRatio > 0.001) {
            this.ctx.fillStyle = `rgba(232, 58, 58, ${Math.min(0.8, 0.12 + damageRatio * 0.72)})`;
            this.ctx.fillRect(offset.x - cellSize / 2 + 1, offset.y - cellSize / 2 + 1, cellSize - 2, cellSize - 2);
          }
          const hpText = `${Math.round(Math.max(0, cell.breakThreshold - cell.strain))}`;
          this.ctx.fillStyle = hpRatio > 0.35 ? "#deebf7" : "#ffe5e5";
          this.ctx.fillText(hpText, offset.x, offset.y);
        }
      }
    }

    for (const attachment of unit.attachments) {
      if (!attachment.alive) {
        continue;
      }
      const offset = this.getCoordOffsetLocal(unit, attachment.x, attachment.y, cellSize);
      const component = COMPONENTS[attachment.component];
      this.ctx.fillStyle = component.type === "weapon" ? "#f0b39f" : component.type === "control" ? "#9dd7ff" : "#a7c9a3";
      this.ctx.fillRect(offset.x - 2, offset.y - 2, 4, 4);
    }

    for (const weapon of getAliveWeaponAttachments(unit)) {
      const slot = unit.weaponAttachmentIds.indexOf(weapon.id);
      if (slot < 0) continue;
      const anchor = this.getCoordOffsetLocal(unit, weapon.x, weapon.y, cellSize);
      const worldAngle = unit.weaponAimAngles[slot] ?? (unit.facing === 1 ? 0 : Math.PI);
      const localAngle = unit.facing === 1 ? worldAngle : Math.PI - worldAngle;
      const length = cellSize * 0.82;
      const muzzleX = anchor.x + Math.cos(localAngle) * length;
      const muzzleY = anchor.y + Math.sin(localAngle) * length;
      this.ctx.strokeStyle = unit.side === "player" ? "#a7d9ff" : "#f4b09d";
      this.ctx.lineWidth = Math.max(3, cellSize * 0.24);
      this.ctx.lineCap = "round";
      this.ctx.beginPath();
      this.ctx.moveTo(anchor.x, anchor.y);
      this.ctx.lineTo(muzzleX, muzzleY);
      this.ctx.stroke();
      this.ctx.fillStyle = this.ctx.strokeStyle;
      this.ctx.beginPath();
      this.ctx.arc(anchor.x, anchor.y, Math.max(2.5, cellSize * 0.22), 0, Math.PI * 2);
      this.ctx.fill();
    }

    if (!this.displayEnabled) {
      const bounds = this.getUnitLayoutBounds(unit);
      const layoutWidth = (bounds.maxX - bounds.minX + 1) * cellSize;
      const layoutHeight = (bounds.maxY - bounds.minY + 1) * cellSize;
      this.ctx.strokeStyle = "rgba(210, 228, 246, 0.5)";
      this.ctx.strokeRect(-layoutWidth / 2, -layoutHeight / 2, layoutWidth, layoutHeight);
    }

    if (this.debugPartHpEnabled) {
      this.ctx.textAlign = "start";
      this.ctx.textBaseline = "alphabetic";
    }
  }

  private getUnitLayoutBounds(unit: UnitInstance): { minX: number; maxX: number; minY: number; maxY: number } {
    const minX = Math.min(...unit.structure.map((cell) => cell.x));
    const maxX = Math.max(...unit.structure.map((cell) => cell.x));
    const minY = Math.min(...unit.structure.map((cell) => cell.y));
    const maxY = Math.max(...unit.structure.map((cell) => cell.y));
    return { minX, maxX, minY, maxY };
  }

  private getCellOffsetLocal(unit: UnitInstance, cellId: number, cellSize: number): { x: number; y: number } {
    const cell = unit.structure.find((entry) => entry.id === cellId);
    if (!cell) {
      return { x: 0, y: 0 };
    }
    return this.getCoordOffsetLocal(unit, cell.x, cell.y, cellSize);
  }

  private getCoordOffsetLocal(unit: UnitInstance, coordX: number, coordY: number, cellSize: number): { x: number; y: number } {
    const bounds = this.getUnitLayoutBounds(unit);
    const width = (bounds.maxX - bounds.minX + 1) * cellSize;
    const height = (bounds.maxY - bounds.minY + 1) * cellSize;
    return {
      x: (coordX - bounds.minX) * cellSize - width / 2 + cellSize / 2,
      y: (coordY - bounds.minY) * cellSize - height / 2 + cellSize / 2,
    };
  }

  private getCellOffsetWorld(unit: UnitInstance, cellId: number, cellSize: number): { x: number; y: number } {
    const cell = unit.structure.find((entry) => entry.id === cellId);
    if (!cell) {
      return { x: 0, y: 0 };
    }
    return this.getCoordOffsetWorld(unit, cell.x, cell.y, cellSize);
  }

  private getCoordOffsetWorld(unit: UnitInstance, coordX: number, coordY: number, cellSize: number): { x: number; y: number } {
    const local = this.getCoordOffsetLocal(unit, coordX, coordY, cellSize);
    const facing = unit.facing === -1 ? -1 : 1;
    return {
      x: local.x * facing,
      y: local.y,
    };
  }

  private getLiveCellRects(unit: UnitInstance): Array<{ id: number; x: number; y: number; w: number; h: number }> {
    const cellSize = getStructureCellSize(unit.radius);
    const rects: Array<{ id: number; x: number; y: number; w: number; h: number }> = [];
    for (const cell of unit.structure) {
      if (cell.destroyed) {
        continue;
      }
      const offset = this.getCellOffsetWorld(unit, cell.id, cellSize);
      rects.push({
        id: cell.id,
        x: unit.x + offset.x - cellSize / 2,
        y: unit.y + offset.y - cellSize / 2,
        w: cellSize,
        h: cellSize,
      });
    }
    return rects;
  }

  private projectileHitsUnitPart(projectile: BattleState["projectiles"][number], unit: UnitInstance, isAir: boolean): UnitProjectileHit | null {
    const laneBounds = this.getLaneBounds();
    const rects = this.getLiveCellRects(unit);
    let bestHit: UnitProjectileHit | null = null;
    let bestEntryTime = Number.POSITIVE_INFINITY;
    for (const rect of rects) {
      const entryTime = this.projectileAabbEntryTime(projectile, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
      if (entryTime === null) {
        continue;
      }
      const entryY = projectile.prevY + (projectile.y - projectile.prevY) * entryTime;
      if (isAir && Math.abs(unit.y - entryY) > laneBounds.airTargetTolerance + projectile.r) {
        continue;
      }
      if (entryTime < bestEntryTime) {
        bestEntryTime = entryTime;
        bestHit = { structureCellId: rect.id, ignoreArmor: false };
      }
    }

    const cellSize = getStructureCellSize(unit.radius);
    const liveStructureByCoord = new Map(
      unit.structure
        .filter((cell) => !cell.destroyed)
        .map((cell) => [`${cell.x},${cell.y}`, cell] as const),
    );
    for (const attachment of unit.attachments) {
      if (!attachment.alive) continue;
      const attachedCells = attachment.attachedStructureCellIds
        .map((cellId) => unit.structure.find((cell) => cell.id === cellId && !cell.destroyed) ?? null)
        .filter((cell): cell is UnitInstance["structure"][number] => cell !== null);
      if (attachedCells.length <= 0) continue;
      for (const offset of attachment.occupiedOffsets ?? []) {
        if (!offset.takesDamage || (!offset.occupiesFunctionalSpace && !offset.occupiesStructureSpace)) continue;
        const coordX = attachment.x + offset.x;
        const coordY = attachment.y + offset.y;
        // A functional box over structure is hit as structure, including normal armor.
        if (liveStructureByCoord.has(`${coordX},${coordY}`)) continue;
        const worldOffset = this.getCoordOffsetWorld(unit, coordX, coordY, cellSize);
        const entryTime = this.projectileAabbEntryTime(
          projectile,
          unit.x + worldOffset.x - cellSize / 2,
          unit.y + worldOffset.y - cellSize / 2,
          unit.x + worldOffset.x + cellSize / 2,
          unit.y + worldOffset.y + cellSize / 2,
        );
        if (entryTime === null || entryTime >= bestEntryTime) continue;
        const entryY = projectile.prevY + (projectile.y - projectile.prevY) * entryTime;
        if (isAir && Math.abs(unit.y + worldOffset.y - entryY) > laneBounds.airTargetTolerance + projectile.r) continue;
        const closestAttachedCell = attachedCells.reduce((closest, cell) => {
          const closestDistance = Math.hypot(closest.x - coordX, closest.y - coordY);
          const cellDistance = Math.hypot(cell.x - coordX, cell.y - coordY);
          return cellDistance < closestDistance ? cell : closest;
        });
        bestEntryTime = entryTime;
        bestHit = { structureCellId: closestAttachedCell.id, ignoreArmor: true };
      }
    }
    return bestHit;
  }

  private projectileAabbEntryTime(
    projectile: BattleState["projectiles"][number],
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): number | null {
    const dx = projectile.x - projectile.prevX;
    const dy = projectile.y - projectile.prevY;
    const distance = Math.hypot(dx, dy);
    const ux = distance > 1e-6 ? dx / distance : Math.cos(Math.atan2(projectile.vy, projectile.vx));
    const uy = distance > 1e-6 ? dy / distance : Math.sin(Math.atan2(projectile.vy, projectile.vx));
    const px = -uy;
    const py = ux;
    const centerOffsetX = ux * projectile.capsuleCenterX + px * projectile.capsuleCenterY;
    const centerOffsetY = uy * projectile.capsuleCenterX + py * projectile.capsuleCenterY;
    if (projectile.projectileClass === "laser") {
      return this.orientedBeamAabbEntryTime(
        projectile.prevX + centerOffsetX,
        projectile.prevY + centerOffsetY,
        projectile.x + centerOffsetX,
        projectile.y + centerOffsetY,
        projectile.capsuleRadius,
        left,
        top,
        right,
        bottom,
      );
    }
    const startX = projectile.prevX + centerOffsetX - ux * projectile.capsuleHalfLength;
    const startY = projectile.prevY + centerOffsetY - uy * projectile.capsuleHalfLength;
    const endX = projectile.x + centerOffsetX + ux * projectile.capsuleHalfLength;
    const endY = projectile.y + centerOffsetY + uy * projectile.capsuleHalfLength;
    return this.segmentRoundedAabbEntryTime(
      startX,
      startY,
      endX,
      endY,
      left,
      top,
      right,
      bottom,
      projectile.capsuleRadius,
    );
  }

  private orientedBeamAabbEntryTime(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): number | null {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-6) return null;
    const ux = dx / length;
    const uy = dy / length;
    const px = -uy;
    const py = ux;
    const corners = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
    const along = corners.map((point) => (point.x - x0) * ux + (point.y - y0) * uy);
    const across = corners.map((point) => (point.x - x0) * px + (point.y - y0) * py);
    const alongMin = Math.min(...along);
    const alongMax = Math.max(...along);
    const acrossMin = Math.min(...across);
    const acrossMax = Math.max(...across);
    if (alongMax < 0 || alongMin > length || acrossMax < -halfWidth || acrossMin > halfWidth) return null;

    const beamCorners = [
      { x: x0 + px * halfWidth, y: y0 + py * halfWidth },
      { x: x0 - px * halfWidth, y: y0 - py * halfWidth },
      { x: x1 + px * halfWidth, y: y1 + py * halfWidth },
      { x: x1 - px * halfWidth, y: y1 - py * halfWidth },
    ];
    if (
      Math.max(...beamCorners.map((point) => point.x)) < left
      || Math.min(...beamCorners.map((point) => point.x)) > right
      || Math.max(...beamCorners.map((point) => point.y)) < top
      || Math.min(...beamCorners.map((point) => point.y)) > bottom
    ) return null;
    return clamp(Math.max(0, alongMin) / length, 0, 1);
  }

  private segmentRoundedAabbEntryTime(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    radius: number,
  ): number | null {
    const pointDistanceSquared = (x: number, y: number): number => {
      const cx = clamp(x, left, right);
      const cy = clamp(y, top, bottom);
      return (x - cx) ** 2 + (y - cy) ** 2;
    };
    if (pointDistanceSquared(x0, y0) <= radius * radius) return 0;
    const candidates: number[] = [];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const addAtX = (x: number): void => {
      if (Math.abs(dx) < 1e-9) return;
      const t = (x - x0) / dx;
      const y = y0 + dy * t;
      if (t >= 0 && t <= 1 && y >= top && y <= bottom) candidates.push(t);
    };
    const addAtY = (y: number): void => {
      if (Math.abs(dy) < 1e-9) return;
      const t = (y - y0) / dy;
      const x = x0 + dx * t;
      if (t >= 0 && t <= 1 && x >= left && x <= right) candidates.push(t);
    };
    addAtX(left - radius);
    addAtX(right + radius);
    addAtY(top - radius);
    addAtY(bottom + radius);
    const a = dx * dx + dy * dy;
    if (a > 1e-9) {
      for (const corner of [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]) {
        const ox = x0 - corner.x;
        const oy = y0 - corner.y;
        const b = 2 * (ox * dx + oy * dy);
        const c = ox * ox + oy * oy - radius * radius;
        const discriminant = b * b - 4 * a * c;
        if (discriminant < 0) continue;
        const root = Math.sqrt(discriminant);
        for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
          if (t >= 0 && t <= 1) candidates.push(t);
        }
      }
    }
    candidates.sort((aValue, bValue) => aValue - bValue);
    for (const t of candidates) {
      const x = x0 + dx * t;
      const y = y0 + dy * t;
      if (pointDistanceSquared(x, y) <= radius * radius + 1e-6) return t;
    }
    return null;
  }

  private spawnBreakDebris(
    unit: UnitInstance,
    beforeDestroyed: Set<number>,
    beforeAliveAttachments: Set<number>,
    wasAlive: boolean,
  ): void {
    const cellSize = getStructureCellSize(unit.radius);

    for (const cell of unit.structure) {
      if (!cell.destroyed || beforeDestroyed.has(cell.id)) {
        continue;
      }
      const offset = this.getCellOffsetWorld(unit, cell.id, cellSize);
      const materialColor = cell.color;
      const seed = Math.floor(this.stableUnitCellRandom(unit.id, cell.id) * 0x7fffffff);
      this.state.blockExplosions.push({
        x: unit.x + offset.x,
        y: unit.y + offset.y,
        age: 0,
        life: 0.55 + (seed % 13) / 100,
        size: cellSize,
        variant: (seed % 3) as 0 | 1 | 2,
        seed,
        color: materialColor,
      });
      this.state.debris.push({
        x: unit.x + offset.x,
        y: unit.y + offset.y,
        vx: unit.type === "air" ? (Math.random() - 0.5) * 90 : 0,
        vy: unit.type === "air" ? 40 + Math.random() * 80 : 0,
        size: cellSize * (0.75 + Math.random() * 0.4),
        color: materialColor,
        kind: "structure",
        life: 24 + Math.random() * 18,
        grounded: unit.type === "ground",
      });
    }

    for (const attachment of unit.attachments) {
      if (attachment.alive || !beforeAliveAttachments.has(attachment.id)) {
        continue;
      }
      const offset = this.getCellOffsetWorld(unit, attachment.cell, cellSize);
      const component = COMPONENTS[attachment.component];
      const color = component.type === "weapon"
        ? "#f0b39f"
        : component.type === "control"
        ? "#9dd7ff"
        : "#a7c9a3";
      this.state.debris.push({
        x: unit.x + offset.x + (Math.random() - 0.5) * 6,
        y: unit.y + offset.y + (Math.random() - 0.5) * 6,
        vx: unit.type === "air" ? (Math.random() - 0.5) * 120 : 0,
        vy: unit.type === "air" ? 60 + Math.random() * 110 : 0,
        size: 3 + Math.random() * 3,
        color,
        kind: "functional",
        life: 22 + Math.random() * 16,
        grounded: unit.type === "ground",
      });
    }

    if (wasAlive && !unit.alive && unit.type === "air") {
      for (let i = 0; i < 6; i += 1) {
        this.state.debris.push({
          x: unit.x + (Math.random() - 0.5) * 24,
          y: unit.y + (Math.random() - 0.5) * 14,
          vx: (Math.random() - 0.5) * 130,
          vy: 80 + Math.random() * 120,
          size: 5 + Math.random() * 6,
          color: "#8fa6bf",
          kind: "structure",
          life: 26 + Math.random() * 14,
          grounded: false,
        });
      }
    }
  }
}
