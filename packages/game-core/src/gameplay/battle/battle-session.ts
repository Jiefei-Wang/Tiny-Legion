import { armyCap } from "../../config/balance/commander.ts";
import {
  DEFAULT_GROUND_HEIGHT_RATIO,
  AIR_MIN_Z_RATIO,
  AIR_GROUND_GAP_RATIO,
  AIR_TARGET_Z_TOLERANCE_RATIO,
  AIR_MIN_LIFT_SPEED,
  AIR_HOLD_GRAVITY,
  AIR_DROP_GRAVITY,
  AIR_DROP_SPEED_CAP,
  AIR_THRUST_ACCEL_SCALE,
  GROUND_PROJECTILE_MAX_DROP_BELOW_FIRE_Y,
  BATTLE_SALVAGE_REFUND_FACTOR,
} from "../../config/balance/battlefield.ts";
import { COMPONENTS } from "../../config/balance/weapons.ts";
import { MATERIALS } from "../../config/balance/materials.ts";
import {
  AI_GRAVITY_CORRECTION_CLAMP,
  AI_GRAVITY_CORRECTION_STEP,
  AI_MISS_VERTICAL_TOLERANCE,
  GLOBAL_WEAPON_RANGE_MULTIPLIER,
  GROUND_FIRE_Y_TOLERANCE,
  PROJECTILE_SPEED,
  getAircraftAltitudeBonus,
} from "../../config/balance/range.ts";
import { applyHitToUnit, applyStructureRecovery } from "../../simulation/combat/damage-model.ts";
import { applyRecoilForAttachment, firstAliveWeaponAttachment, getAliveWeaponAttachments } from "../../simulation/combat/recoil.ts";
import { clamp } from "../../simulation/physics/impulse-model.ts";
import { canOperate } from "../../simulation/units/control-unit-rules.ts";
import { instantiateUnit } from "../../simulation/units/unit-builder.ts";
import { selectBestTarget } from "../../ai/targeting/target-selector.ts";
import { solveBallisticAim } from "../../ai/shooting/ballistic-aim.ts";
import { adjustAimForWeaponPolicy } from "../../ai/shooting/weapon-ai-policy.ts";
import { createBaselineCompositeAiController } from "../../ai/composite/baseline-modules.ts";
import { validateTemplateDetailed } from "../../templates/template-validation.ts";
import { createDefaultPartDefinitions, mergePartCatalogs } from "../../parts/part-schema.ts";
import type { BattleAiController, CombatDecision } from "../../ai/composite/composite-ai.ts";
import type { BattleState, CommandResult, FireBlockDetail, FireRequest, KeyState, MapNode, PartDefinition, Side, UnitCommand, UnitInstance, UnitTemplate } from "../../types.ts";

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
  partCatalog?: ReadonlyArray<PartDefinition>;
}

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
  private partCatalog: PartDefinition[];
  private state: BattleState;
  private selectedUnitId: string | null;
  private playerControlledId: string | null;
  private aimX: number;
  private aimY: number;
  private manualFireHeld: boolean;
  private displayEnabled: boolean;
  private debugDrawEnabled: boolean;
  private debugTargetLineEnabled: boolean;
  private debugPartHpEnabled: boolean;
  private controlledUnitInvincible: boolean;
  private groundHeightPx: number;
  private readonly baselineController: BattleAiController;

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
    this.partCatalog = options.partCatalog && options.partCatalog.length > 0
      ? mergePartCatalogs(createDefaultPartDefinitions(), options.partCatalog)
      : createDefaultPartDefinitions();
    this.state = this.createEmptyBattle();
    this.selectedUnitId = null;
    this.playerControlledId = null;
    this.aimX = canvas.width * 0.7;
    this.aimY = canvas.height * 0.5;
    this.manualFireHeld = false;
    this.displayEnabled = false;
    this.debugDrawEnabled = false;
    this.debugTargetLineEnabled = false;
    this.debugPartHpEnabled = false;
    this.controlledUnitInvincible = false;
    this.groundHeightPx = Math.max(80, canvas.height * DEFAULT_GROUND_HEIGHT_RATIO);
    this.baselineController = createBaselineCompositeAiController();
  }

  public getState(): BattleState {
    return this.state;
  }

  public getSelection(): { selectedUnitId: string | null; playerControlledId: string | null } {
    return { selectedUnitId: this.selectedUnitId, playerControlledId: this.playerControlledId };
  }

  public setAiControllers(aiControllers: Partial<Record<Side, BattleAiController>>): void {
    this.aiControllers = aiControllers;
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
    return this.state.units.filter((unit) => unit.side === "enemy" && unit.alive).length;
  }

  public setEnemyActiveCount(targetCount: number): number {
    const normalizedTarget = clamp(Math.floor(targetCount), 0, 40);
    this.state.enemyMinActive = normalizedTarget;
    this.state.enemyCap = normalizedTarget;
    if (!this.state.active || this.state.outcome) {
      return this.getAliveEnemyCount();
    }

    const aliveEnemies = this.state.units.filter((unit) => unit.side === "enemy" && unit.alive);
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

  public spawnEnemyTemplate(templateId: string): boolean {
    return this.arenaDeploy("enemy", templateId, { chargeGas: false, ignoreCap: true, ignoreLowGasThreshold: true });
  }

  public setBattlefieldSize(width: number, height: number): { width: number; height: number } {
    const normalizedWidth = clamp(Math.floor(width), 640, 4096);
    const normalizedHeight = clamp(Math.floor(height), 360, 2160);
    this.canvas.width = normalizedWidth;
    this.canvas.height = normalizedHeight;
    this.groundHeightPx = clamp(this.groundHeightPx, 80, Math.max(120, this.canvas.height - 40));

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

    this.aimX = clamp(this.aimX, 0, this.canvas.width);
    this.aimY = clamp(this.aimY, 0, this.canvas.height);
    this.clampEntitiesToBattlefield();
    return { width: this.canvas.width, height: this.canvas.height };
  }

  public setGroundHeight(height: number): number {
    const normalized = clamp(Math.floor(height), 80, Math.max(120, this.canvas.height - 40));
    this.groundHeightPx = normalized;
    this.clampEntitiesToBattlefield();
    return this.groundHeightPx;
  }

  public getGroundHeight(): number {
    return Math.floor(this.groundHeightPx);
  }

  public setAim(mouseX: number, mouseY: number): void {
    this.aimX = clamp(mouseX, 0, this.canvas.width);
    this.aimY = clamp(mouseY, 0, this.canvas.height);
  }

  public setControlByClick(mouseX: number, mouseY: number): void {
    if (!this.state.active) {
      return;
    }
    const lockedControlled = this.getControlledUnit();
    if (lockedControlled?.airDropActive) {
      this.clearControlSelection();
    }
    if (lockedControlled && this.hasAliveWeapons(lockedControlled)) {
      this.setAim(mouseX, mouseY);
      return;
    }
    if (lockedControlled && !this.hasAliveWeapons(lockedControlled)) {
      this.clearControlSelection();
    }
    let picked: UnitInstance | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const unit of this.state.units) {
      if (!unit.alive || unit.side !== "player") {
        continue;
      }
      if (unit.returnedToBase || unit.airDropActive || !this.hasAliveWeapons(unit)) {
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
        fireReqs.push({
          slot,
          aimX: this.aimX,
          aimY: this.aimY,
          intendedTargetId: null,
          intendedTargetY: null,
          manual: true,
        });
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
      const starterA = instantiateUnit(this.templates, "scout-ground", "player", 140, 300, {
        deploymentGasCost: 0,
        partCatalog: this.partCatalog,
      });
      const starterB = instantiateUnit(this.templates, "tank-ground", "player", 150, 430, {
        deploymentGasCost: 0,
        partCatalog: this.partCatalog,
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
    this.selectedUnitId = null;
    this.playerControlledId = null;
    this.manualFireHeld = false;
    this.aimX = this.canvas.width * 0.7;
    this.aimY = this.canvas.height * 0.5;
  }

  public deployUnit(templateId: string): void {
    if (!this.state.active || this.state.outcome) {
      return;
    }
    const template = this.templates.find((entry) => entry.id === templateId);
    if (!template) {
      return;
    }

    const friendlyActive = this.state.units.filter((unit) => unit.side === "player" && unit.alive).length;
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
    const y = template.type === "air"
      ? laneBounds.airMinZ + Math.random() * (laneBounds.airMaxZ - laneBounds.airMinZ)
      : laneBounds.groundMinY + Math.random() * (laneBounds.groundMaxY - laneBounds.groundMinY);
    const unit = instantiateUnit(this.templates, templateId, "player", 120, y, {
      partCatalog: this.partCatalog,
    });
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

    const laneBounds = this.getLaneBounds();
    for (const unit of this.state.units) {
      if (!unit.alive || !canOperate(unit)) {
        continue;
      }
      this.refreshUnitMobility(unit);

      if (unit.type === "air" && !unit.airDropActive && unit.maxSpeed < AIR_MIN_LIFT_SPEED) {
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

      const isControlled = unit.side === "player" && unit.id === this.playerControlledId;
      let command: UnitCommand;

      if (isControlled && !unit.airDropActive) {
        command = this.playerInputToCommand(unit, dt, keys);
      } else if (unit.airDropActive) {
        command = this.airDropReturnToCommand(unit, dt);
      } else if (this.hasAliveWeapons(unit)) {
        if (this.autoEnableAiWeaponAutoFire) {
          for (let i = 0; i < unit.weaponAutoFire.length; i += 1) {
            unit.weaponAutoFire[i] = true;
          }
        }
        unit.aiStateTimer += dt;
        unit.aiDodgeCooldown = Math.max(0, unit.aiDodgeCooldown - dt);

        const desiredRange = this.getDesiredEngageRange(unit);
        const baseTarget = this.getEnemyBaseCenter(unit.side);
        const controller = this.aiControllers[unit.side] ?? null;
        const decision = controller
          ? controller.decide({
              unit,
              state: this.state,
              dt,
              desiredRange,
              baseTarget,
              canShootAtAngle: (componentId, dx, dy, shootAngleDegOverride) => this.canShootAtAngle(unit, componentId, dx, dy, shootAngleDegOverride),
              getEffectiveWeaponRange: (baseRange) => this.getEffectiveWeaponRange(unit, baseRange),
            })
          : this.baselineController.decide({
              unit,
              state: this.state,
              dt,
              desiredRange,
              baseTarget,
              canShootAtAngle: (componentId, dx, dy, shootAngleDegOverride) => this.canShootAtAngle(unit, componentId, dx, dy, shootAngleDegOverride),
              getEffectiveWeaponRange: (baseRange) => this.getEffectiveWeaponRange(unit, baseRange),
            });
        command = this.aiDecisionToCommand(unit, decision);
      } else if (unit.type === "air") {
        if (!unit.airDropActive) {
          unit.airDropActive = true;
          unit.airDropTargetY = laneBounds.groundMinY + Math.random() * (laneBounds.groundMaxY - laneBounds.groundMinY);
          unit.aiDebugDecisionPath = "weaponless-air-drop";
        }
        if (unit.id === this.playerControlledId || unit.id === this.selectedUnitId) {
          this.clearControlSelection();
          this.hooks.addLog(`${unit.name} has no weapon and is returning to base`, "warn");
        }
        command = this.airDropReturnToCommand(unit, dt);
      } else {
        if (unit.returnedToBase) continue;
        if (unit.id === this.playerControlledId || unit.id === this.selectedUnitId) {
          this.clearControlSelection();
          this.hooks.addLog(`${unit.name} has no weapon and is returning to base`, "warn");
        }
        unit.facing = unit.side === "player" ? 1 : -1;
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

      const speedCap = unit.airDropActive ? Math.max(unit.maxSpeed, AIR_DROP_SPEED_CAP) : unit.maxSpeed;
      unit.vx = clamp(unit.vx, -speedCap, speedCap);
      unit.vy = clamp(unit.vy, -speedCap * 0.75, speedCap * 0.75);
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
      unit.vibrate *= 0.85;
      applyStructureRecovery(unit, dt);

      if (unit.type === "ground") {
        unit.y = clamp(unit.y, laneBounds.groundMinY, laneBounds.groundMaxY);
      } else {
        if (unit.airDropActive) {
          unit.y = clamp(unit.y, laneBounds.airMinZ, unit.airDropTargetY);
        } else {
          unit.y = clamp(unit.y, laneBounds.airMinZ, laneBounds.groundMinY);
        }
      }
      unit.x = clamp(unit.x, 44, this.canvas.width - 44);

      if (unit.airDropActive) {
        const base = unit.side === "player" ? this.state.playerBase : this.state.enemyBase;
        if (this.isUnitInsideBase(unit, base)) {
          this.onUnitReturnedToBase(unit);
          continue;
        }
        if (unit.y >= unit.airDropTargetY - 2) {
          this.onAirDropImpact(unit);
        }
      }

      if (!this.hasAliveWeapons(unit) && unit.type === "ground" && !unit.returnedToBase) {
        const base = unit.side === "player" ? this.state.playerBase : this.state.enemyBase;
        if (this.isUnitInsideBase(unit, base)) {
          this.onUnitReturnedToBase(unit);
        }
      }
    }

    for (const projectile of this.state.projectiles) {
      projectile.ttl -= dt;
      projectile.prevX = projectile.x;
      projectile.prevY = projectile.y;
      if (projectile.homingTurnRateDegPerSec > 0) {
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
      const stepX = projectile.vx * dt;
      projectile.vy += projectile.gravity * dt;
      const stepY = projectile.vy * dt;
      projectile.x += stepX;
      projectile.y += stepY;
      projectile.traveledDistance += Math.hypot(stepX, stepY);
      if (projectile.traveledDistance >= projectile.maxDistance) {
        projectile.ttl = -1;
      }
      const exceededGroundDropLimit = projectile.sourceUnitType === "ground" &&
        projectile.weaponClass !== "tracking" &&
        projectile.initialVy < 0 &&
        projectile.y >= projectile.fireOriginY + GROUND_PROJECTILE_MAX_DROP_BELOW_FIRE_Y;
      if (exceededGroundDropLimit) {
        if (projectile.explosiveBlastRadius > 0) {
          this.applyExplosiveBlast(projectile, null);
        }
        projectile.ttl = -1;
        continue;
      }
      if (projectile.ttl <= 0 && projectile.explosiveFuse === "timed" && projectile.explosiveBlastRadius > 0) {
        this.applyExplosiveBlast(projectile, null);
      }
      if (projectile.ttl <= 0) {
        continue;
      }

      for (const target of this.state.units) {
        if (!target.alive || !canOperate(target) || target.side === projectile.side) {
          continue;
        }
        if (projectile.hitUnitIds.includes(target.id)) {
          continue;
        }
        if (target.type === "air") {
          const hitCellId = this.projectileHitsLiveCell(projectile, target, true);
          if (hitCellId !== null) {
            const beforeDestroyed = new Set(target.structure.filter((cell) => cell.destroyed).map((cell) => cell.id));
            const beforeAliveAttachments = new Set(target.attachments.filter((attachment) => attachment.alive).map((attachment) => attachment.id));
            const wasAlive = target.alive;
            const impactSide = projectile.vx >= 0 ? -1 : 1;
            if (!this.shouldIgnoreDamageForUnit(target)) {
              applyHitToUnit(target, projectile.damage, projectile.hitImpulse, impactSide, hitCellId);
            }
            projectile.hitUnitIds.push(target.id);
            if (projectile.intendedTargetId === target.id) {
              projectile.hitIntendedTarget = true;
            }
            this.hooks.addLog(`Hit ${target.name} (air) by projectile from ${projectile.sourceId}`, "warn");
            this.spawnBreakDebris(target, beforeDestroyed, beforeAliveAttachments, wasAlive);
            this.state.particles.push({
              x: projectile.x,
              y: target.y,
              life: 0.23 + Math.random() * 0.2,
              size: 6 + projectile.damage * 0.05,
            });
            if (projectile.controlImpairDuration > 0) {
              this.applyControlImpair(target, projectile.controlImpairFactor, projectile.controlImpairDuration);
            }
            if (projectile.explosiveFuse === "impact" && projectile.explosiveBlastRadius > 0) {
              this.applyExplosiveBlast(projectile, target.id);
              projectile.ttl = -1;
              break;
            }
            if (!projectile.allowAirPierce) {
              projectile.ttl = -1;
              break;
            }
          }
          continue;
        }

        const hitCellId = this.projectileHitsLiveCell(projectile, target, false);
        if (hitCellId !== null) {
          const beforeDestroyed = new Set(target.structure.filter((cell) => cell.destroyed).map((cell) => cell.id));
          const beforeAliveAttachments = new Set(target.attachments.filter((attachment) => attachment.alive).map((attachment) => attachment.id));
          const wasAlive = target.alive;
          const impactSide = projectile.vx >= 0 ? -1 : 1;
          if (!this.shouldIgnoreDamageForUnit(target)) {
            applyHitToUnit(target, projectile.damage, projectile.hitImpulse, impactSide, hitCellId);
          }
          projectile.hitUnitIds.push(target.id);
          if (projectile.intendedTargetId === target.id) {
            projectile.hitIntendedTarget = true;
          }
          this.hooks.addLog(`Hit ${target.name} (ground) by projectile from ${projectile.sourceId}`, "warn");
          this.spawnBreakDebris(target, beforeDestroyed, beforeAliveAttachments, wasAlive);
          projectile.ttl = -1;
          this.state.particles.push({
            x: projectile.x,
            y: target.y,
            life: 0.23 + Math.random() * 0.2,
            size: 6 + projectile.damage * 0.05,
          });
          if (projectile.controlImpairDuration > 0) {
            this.applyControlImpair(target, projectile.controlImpairFactor, projectile.controlImpairDuration);
          }
          if (projectile.explosiveFuse === "impact" && projectile.explosiveBlastRadius > 0) {
            this.applyExplosiveBlast(projectile, target.id);
          }
          break;
        }
      }

      if (projectile.ttl > 0) {
        this.applyBaseDamage(projectile);
      }
    }

    this.state.projectiles = this.state.projectiles.filter((projectile) => {
      const keep = projectile.ttl > 0 && projectile.x > 0 && projectile.x < this.canvas.width;
      if (!keep) {
        this.applyAiShotFeedback(projectile);
      }
      return keep;
    });
    for (const effect of this.state.particles) {
      effect.life -= dt;
    }
    this.state.particles = this.state.particles.filter((effect) => effect.life > 0);

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
    const y = clamp(Math.round(this.canvas.height * (300 / 1000)), 18, Math.max(18, this.canvas.height - h - 18));
    const x = side === "player" ? 18 : this.canvas.width - w - 18;
    return { x, y, w, h };
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
  }

  private maybeSpawnEnemy(): boolean {
    const aliveEnemy = this.state.units.filter((unit) => unit.side === "enemy" && unit.alive).length;
    if (aliveEnemy >= this.state.enemyCap) {
      return false;
    }
    const candidates = this.templates.filter((template) => {
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
    const y = template.type === "air"
      ? bounds.airMinZ + Math.random() * (bounds.airMaxZ - bounds.airMinZ)
      : bounds.groundMinY + Math.random() * (bounds.groundMaxY - bounds.groundMinY);
    const enemy = instantiateUnit(this.templates, template.id, "enemy", this.canvas.width - 120, y, {
      partCatalog: this.partCatalog,
    });
    if (!enemy) {
      return false;
    }
    if (!this.state.enemyInfiniteGas) {
      this.state.enemyGas -= template.gasCost;
    }
    this.state.units.push(enemy);
    return true;
  }

  public arenaDeploy(
    side: Side,
    templateId: string,
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
      const friendlyActive = this.state.units.filter((unit) => unit.side === "player" && unit.alive).length;
      if (!ignoreCap && friendlyActive >= armyCap(this.hooks.getCommanderSkill())) {
        return false;
      }
      const bounds = this.getLaneBounds();
      const y = typeof opts.y === "number" && Number.isFinite(opts.y)
        ? opts.y
        : template.type === "air"
            ? bounds.airMinZ + Math.random() * (bounds.airMaxZ - bounds.airMinZ)
            : bounds.groundMinY + Math.random() * (bounds.groundMaxY - bounds.groundMinY);
      const unit = instantiateUnit(this.templates, templateId, "player", 120, y, {
        deploymentGasCost: typeof opts.deploymentGasCost === "number" && Number.isFinite(opts.deploymentGasCost) ? opts.deploymentGasCost : undefined,
        partCatalog: this.partCatalog,
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

    const aliveEnemy = this.state.units.filter((unit) => unit.side === "enemy" && unit.alive).length;
    if (!ignoreCap && aliveEnemy >= this.state.enemyCap) {
      return false;
    }
    const hasGas = this.state.enemyGas >= template.gasCost;
    const ignoreLowGasThreshold = opts.ignoreLowGasThreshold ?? false;
    if (chargeGas && !this.state.enemyInfiniteGas && (!hasGas || (!ignoreLowGasThreshold && this.state.enemyGas < 20))) {
      return false;
    }
    const bounds = this.getLaneBounds();
    const y = typeof opts.y === "number" && Number.isFinite(opts.y)
      ? opts.y
      : template.type === "air"
          ? bounds.airMinZ + Math.random() * (bounds.airMaxZ - bounds.airMinZ)
          : bounds.groundMinY + Math.random() * (bounds.groundMaxY - bounds.groundMinY);
    const enemy = instantiateUnit(this.templates, templateId, "enemy", this.canvas.width - 120, y, {
      deploymentGasCost: typeof opts.deploymentGasCost === "number" && Number.isFinite(opts.deploymentGasCost) ? opts.deploymentGasCost : undefined,
      partCatalog: this.partCatalog,
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
    let aliveEnemy = this.state.units.filter((unit) => unit.side === "enemy" && unit.alive).length;
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
      return unit.alive && unit.side === "player" && canOperate(unit) && this.hasAliveWeapons(unit);
    });
    const enemyHasDefenders = this.state.units.some((unit) => {
      return unit.alive && unit.side === "enemy" && canOperate(unit) && this.hasAliveWeapons(unit);
    });

    if (projectile.side === "player") {
      if (enemyHasDefenders) {
        return;
      }
      if (
        projectile.x > this.state.enemyBase.x &&
        projectile.x < this.state.enemyBase.x + this.state.enemyBase.w &&
        projectile.y > this.state.enemyBase.y &&
        projectile.y < this.state.enemyBase.y + this.state.enemyBase.h
      ) {
        this.state.enemyBase.hp -= projectile.damage * 0.5;
        projectile.ttl = -1;
      }
      return;
    }

    if (playerHasDefenders) {
      return;
    }
    if (
      projectile.x > this.state.playerBase.x &&
      projectile.x < this.state.playerBase.x + this.state.playerBase.w &&
      projectile.y > this.state.playerBase.y &&
      projectile.y < this.state.playerBase.y + this.state.playerBase.h
    ) {
      this.state.playerBase.hp -= projectile.damage * 0.5;
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

    for (const target of this.state.units) {
      if (!target.alive || !canOperate(target) || target.side === projectile.side) {
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
      const hitCellId = this.projectileHitsLiveCell(projectile, target, target.type === "air");
      const impactSide = dx >= 0 ? 1 : -1;
      if (!this.shouldIgnoreDamageForUnit(target)) {
        applyHitToUnit(target, splashDamage, projectile.hitImpulse * 0.45, impactSide, hitCellId);
      }
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
    target: { x: number; y: number } | null,
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
    const attachmentWeaponClass = attachmentStats.weaponClass ?? "rapid-fire";
    const requiresDedicatedLoader = this.requiresDedicatedLoader(attachmentWeaponClass);
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
    const effectiveRange = this.getEffectiveWeaponRange(unit, shot.range);
    const fallbackX = unit.x + unit.facing * 400;
    const baseAim = {
      x: target?.x ?? fallbackX,
      y: target?.y ?? unit.y,
    };
    const adjustedAim = adjustAimForWeaponPolicy(attachment.component, baseAim);
    const targetX = adjustedAim.x;
    const targetY = adjustedAim.y;
    const finalIntendedTargetY = intendedTargetY ?? targetY;
    const finalIntendedTargetX = targetX;
    const resolvedHomingTargetId = shot.weaponClass === "tracking"
      ? (intendedTargetId ?? this.findClosestEnemyToPoint(unit.side, finalIntendedTargetX, finalIntendedTargetY)?.id ?? null)
      : null;
    const weaponCellSize = Math.max(8, Math.min(14, unit.radius * 1.7 * 0.24));
    const weaponOffset = attachment.shootingOffset
      ? this.getCoordOffsetWorld(
          unit,
          attachment.x + attachment.shootingOffset.x,
          attachment.y + attachment.shootingOffset.y,
          weaponCellSize,
        )
      : this.getCellOffsetWorld(unit, attachment.cell, weaponCellSize);
    const weaponOriginX = unit.x + weaponOffset.x;
    const weaponOriginY = unit.y + weaponOffset.y;
    const dx = targetX - weaponOriginX;
    const dy = targetY - weaponOriginY;
    const clampedAim = this.clampAimVectorToWeaponAngle(unit, attachment.component, dx, dy, attachment.stats?.shootAngleDeg);
    const spreadRad = (((Math.random() * 2) - 1) * shot.spreadDeg * Math.PI) / 180;
    const baseAngle = Math.atan2(clampedAim.dy, clampedAim.dx);
    const fireAngle = baseAngle + spreadRad;
    const ux = Math.cos(fireAngle);
    const uy = Math.sin(fireAngle);
    const muzzleDistance = weaponCellSize * 0.55 + 2;
    const explosiveFuse = shot.explosive?.fuse ?? "impact";
    const explosiveIsBomb = shot.explosive?.deliveryMode === "bomb";
    const projectileSpeed = explosiveIsBomb ? Math.max(120, shot.projectileSpeed * 0.52) : shot.projectileSpeed;
    const gravity = explosiveIsBomb ? Math.max(240, shot.projectileGravity * 1.35) : shot.projectileGravity;
    const ttl = explosiveFuse === "timed"
      ? Math.max(0.2, shot.explosive?.fuseTime ?? 1.1)
      : Math.max(2.0, effectiveRange / Math.max(120, projectileSpeed));
    this.state.projectiles.push({
      x: weaponOriginX + ux * muzzleDistance,
      y: weaponOriginY + uy * muzzleDistance,
      prevX: weaponOriginX + ux * muzzleDistance,
      prevY: weaponOriginY + uy * muzzleDistance,
      vx: ux * projectileSpeed,
      vy: uy * projectileSpeed,
      traveledDistance: 0,
      maxDistance: effectiveRange,
      hitUnitIds: [],
      shooterWasAI: !manual,
      intendedTargetId,
      intendedTargetX: finalIntendedTargetX,
      intendedTargetY: finalIntendedTargetY,
      hitIntendedTarget: false,
      axisY: finalIntendedTargetY,
      allowAirPierce: unit.type === "ground",
      gravity,
      weaponClass: shot.weaponClass,
      explosiveBlastRadius: shot.explosive?.blastRadius ?? 0,
      explosiveBlastDamage: shot.explosive?.blastDamage ?? 0,
      explosiveFalloffPower: shot.explosive?.falloffPower ?? 1,
      explosiveFuse,
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
      fireOriginY: weaponOriginY,
      initialVy: uy * projectileSpeed,
      sourceWeaponAttachmentId: attachmentId,
      damage: shot.damage,
      hitImpulse: shot.impulse,
      r: Math.max(2, Math.sqrt(shot.damage) * 0.35),
    });
    if (requiresDedicatedLoader) {
      unit.weaponReadyCharges[slot] = Math.max(0, (unit.weaponReadyCharges[slot] ?? 0) - 1);
      unit.weaponFireTimers[slot] = this.getLoaderMinBurstInterval(unit, slot);
    } else {
      unit.weaponFireTimers[slot] = shot.cooldown;
    }
    if (manual) {
      this.hooks.addLog(`${unit.name} fired weapon #${slot + 1}`, "warn");
    }
    return true;
  }

  private clampAimVectorToWeaponAngle(
    unit: UnitInstance,
    componentId: keyof typeof COMPONENTS,
    dx: number,
    dy: number,
    shootAngleDegOverride?: number,
  ): { dx: number; dy: number } {
    const stats = COMPONENTS[componentId];
    const shootAngleDeg = shootAngleDegOverride ?? stats.shootAngleDeg ?? 120;
    const halfAngleRad = (shootAngleDeg * Math.PI / 180) * 0.5;
    const facingAngle = unit.facing === 1 ? 0 : Math.PI;
    const aimAngle = Math.atan2(dy, dx);
    const delta = Math.atan2(Math.sin(aimAngle - facingAngle), Math.cos(aimAngle - facingAngle));
    const clampedDelta = clamp(delta, -halfAngleRad, halfAngleRad);
    const clampedAngle = facingAngle + clampedDelta;
    const length = Math.max(1, Math.hypot(dx, dy));
    return {
      dx: Math.cos(clampedAngle) * length,
      dy: Math.sin(clampedAngle) * length,
    };
  }

  private requiresDedicatedLoader(weaponClass: BattleState["projectiles"][number]["weaponClass"]): boolean {
    return weaponClass === "heavy-shot" || weaponClass === "explosive" || weaponClass === "tracking";
  }

  private getLoaderMinBurstInterval(unit: UnitInstance, slot: number): number {
    const weaponAttachmentId = unit.weaponAttachmentIds[slot];
    const weaponAttachment = unit.attachments.find((entry) => entry.id === weaponAttachmentId && entry.alive);
    if (!weaponAttachment) {
      return 0.5;
    }
    const weaponStats = COMPONENTS[weaponAttachment.component];
    if (weaponStats.type !== "weapon") {
      return 0.5;
    }
    let best = Number.POSITIVE_INFINITY;
    for (const loaderState of unit.loaderStates) {
      const loaderAttachment = unit.attachments.find((entry) => entry.id === loaderState.attachmentId && entry.alive);
      if (!loaderAttachment) {
        continue;
      }
      const loaderStats = COMPONENTS[loaderAttachment.component];
      if (loaderStats.type !== "loader") {
        continue;
      }
      const loader = loaderStats.loader;
      if (!loader || !loader.supports.includes(weaponStats.weaponClass ?? "rapid-fire")) {
        continue;
      }
      best = Math.min(best, Math.max(0.5, loader.minBurstInterval));
    }
    return Number.isFinite(best) ? Math.max(0.5, best) : 0.5;
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
    if (!this.requiresDedicatedLoader(weaponStats.weaponClass ?? "rapid-fire")) {
      return 1;
    }
    let capacity = 0;
    for (const loaderState of unit.loaderStates) {
      const loaderAttachment = unit.attachments.find((entry) => entry.id === loaderState.attachmentId && entry.alive);
      if (!loaderAttachment) {
        continue;
      }
      const loaderStats = COMPONENTS[loaderAttachment.component];
      if (loaderStats.type !== "loader") {
        continue;
      }
      const loader = loaderStats.loader;
      if (!loader || !loader.supports.includes(weaponStats.weaponClass ?? "rapid-fire")) {
        continue;
      }
      capacity += 1 + Math.max(0, loader.storeCapacity);
    }
    return Math.max(0, capacity);
  }

  private computeLoaderDuration(loaderStats: (typeof COMPONENTS)[keyof typeof COMPONENTS], weaponCooldown: number): number {
    const loader = loaderStats.loader;
    if (!loader) {
      return weaponCooldown;
    }
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
      const loaderStats = COMPONENTS[loaderAttachment.component];
      if (loaderStats.type !== "loader" || !loaderStats.loader) {
        loaderState.targetWeaponSlot = null;
        loaderState.remaining = 0;
        continue;
      }
      const loaderConfig = loaderStats.loader;

      if (loaderState.targetWeaponSlot !== null) {
        const targetSlot = loaderState.targetWeaponSlot;
        const weaponAttachmentId = unit.weaponAttachmentIds[targetSlot];
        const weaponAttachment = unit.attachments.find((entry) => entry.id === weaponAttachmentId && entry.alive);
        const weaponStats = weaponAttachment ? COMPONENTS[weaponAttachment.component] : null;
        const weaponClass = weaponStats?.type === "weapon" ? (weaponStats.weaponClass ?? "rapid-fire") : null;
        if (
          weaponClass === null ||
          !loaderConfig.supports.includes(weaponClass) ||
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
      const loaderStats = COMPONENTS[loaderAttachment.component];
      if (loaderStats.type !== "loader" || !loaderStats.loader) {
        continue;
      }
      const loaderConfig = loaderStats.loader;

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
        const weaponClass = weaponStats.weaponClass ?? "rapid-fire";
        if (!loaderConfig.supports.includes(weaponClass)) {
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
      loaderState.remaining = this.computeLoaderDuration(loaderStats, weaponCooldown);
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
      const propulsion = stats.propulsion;
      if (unit.type === "air") {
        if (propulsion?.platform !== "air") {
          continue;
        }
      } else if (propulsion?.platform === "air") {
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
    const speedScale = unit.type === "ground" ? 74 : 82;
    const rawSpeed = powerToMass * speedScale;
    unit.maxSpeed = clamp(Math.min(rawSpeed, speedCap), 0, speedCap);
    unit.accel = clamp(rawSpeed * 0.92, 0, Math.max(16, unit.maxSpeed * 1.6));
    const speedRatio = unit.maxSpeed / Math.max(1, speedCap);
    unit.turnDrag = clamp(0.8 + speedRatio * 0.14, 0.8, 0.94);
  }

  private getPropellerDirection(unit: UnitInstance, rotateQuarter: number): { x: number; y: number } {
    const q = ((rotateQuarter % 4) + 4) % 4;
    if (q === 0) {
      return { x: unit.facing, y: 0 };
    }
    if (q === 1) {
      return { x: 0, y: 1 };
    }
    if (q === 2) {
      return { x: -unit.facing, y: 0 };
    }
    return { x: 0, y: -1 };
  }

  private computeDirectedAirAccel(unit: UnitInstance, dirX: number, dirY: number): number {
    const len = Math.hypot(dirX, dirY);
    if (len <= 1e-6) {
      return 0;
    }
    const ux = dirX / len;
    const uy = dirY / len;
    let accel = 0;
    for (const attachment of unit.attachments) {
      if (!attachment.alive) {
        continue;
      }
      const stats = COMPONENTS[attachment.component];
      if (stats.type !== "engine" || stats.propulsion?.platform !== "air") {
        continue;
      }
      const enginePower = Math.max(0, attachment.stats?.power ?? stats.power ?? 0);
      const baseAccel = (enginePower / Math.max(16, unit.mass)) * AIR_THRUST_ACCEL_SCALE;
      if (stats.propulsion.mode === "omni") {
        accel += baseAccel;
        continue;
      }
      const propDir = this.getPropellerDirection(unit, attachment.rotateQuarter);
      const dot = ux * propDir.x + uy * propDir.y;
      const angleLimitDeg = stats.propulsion.thrustAngleDeg ?? 25;
      const cosLimit = Math.cos((angleLimitDeg * Math.PI) / 180);
      if (dot < cosLimit) {
        continue;
      }
      const inConeScale = clamp((dot - cosLimit) / Math.max(1e-6, 1 - cosLimit), 0, 1);
      const sideBleed = clamp((1 - Math.abs(dot)) * 0.18, 0, 0.18);
      accel += baseAccel * Math.max(inConeScale, sideBleed);
    }
    return accel;
  }

  private applyAirThrustMovement(unit: UnitInstance, dt: number, inputX: number, inputY: number, allowDescend: boolean): void {
    const clampedX = clamp(inputX, -1.4, 1.4);
    const clampedY = clamp(inputY, -1.4, 1.4);
    const wantsDescend = allowDescend && clampedY > 0.06;

    const liftAccel = this.computeDirectedAirAccel(unit, 0, -1);
    const descendFactor = wantsDescend ? clamp(clampedY, 0, 1) : 0;
    const reservedLift = wantsDescend ? AIR_HOLD_GRAVITY * (1 - descendFactor) : AIR_HOLD_GRAVITY;
    const spareLiftRatio = liftAccel > 0
      ? clamp((liftAccel - reservedLift) / Math.max(1, liftAccel), 0, 1)
      : 0;

    let moveDirX = clampedX;
    let moveDirY = 0;
    if (!wantsDescend && clampedY < -0.06) {
      moveDirY = clampedY;
    }
    const moveLen = Math.hypot(moveDirX, moveDirY);
    const ux = moveLen > 1e-6 ? moveDirX / moveLen : 0;
    const uy = moveLen > 1e-6 ? moveDirY / moveLen : 0;
    const directedAccel = moveLen > 1e-6 ? this.computeDirectedAirAccel(unit, ux, uy) : 0;
    const effectiveMoveAccel = directedAccel * (wantsDescend ? 1 : spareLiftRatio);
    const moveSpeedRatio = clamp(effectiveMoveAccel / Math.max(1, AIR_HOLD_GRAVITY), 0, 1);
    const moveSpeed = unit.maxSpeed * moveSpeedRatio;

    unit.vx = ux * moveSpeed;
    unit.vy = uy * moveSpeed;

    const fallAccel = Math.max(0, AIR_HOLD_GRAVITY - liftAccel);
    if (fallAccel > 0) {
      unit.vy += fallAccel * dt;
      unit.aiDebugFireBlockReason = "low-lift";
    } else if (wantsDescend) {
      unit.vy += unit.maxSpeed * 0.45 * descendFactor;
    } else if (Math.abs(unit.vy) < 1.2) {
      unit.vy = 0;
    }

      if (liftAccel <= 1) {
        if (!unit.airDropActive) {
          unit.airDropActive = true;
          const laneBounds = this.getLaneBounds();
          unit.airDropTargetY = laneBounds.groundMinY + Math.random() * (laneBounds.groundMaxY - laneBounds.groundMinY);
          unit.aiDebugDecisionPath = "air-no-lift-drop";
        }
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
      // AIR-DROP 50/50 thrust split
      const dirX = command.move.dirX;

      // 50% of thrust for horizontal
      const horizontalAccel = dirX !== 0 ? this.computeDirectedAirAccel(unit, Math.sign(dirX), 0) : 0;
      const effectiveHorizontal = horizontalAccel * 0.5;
      const horizontalSpeedRatio = clamp(effectiveHorizontal / Math.max(1, AIR_HOLD_GRAVITY), 0, 1);
      unit.vx = Math.sign(dirX) * unit.maxSpeed * horizontalSpeedRatio;

      // 50% of thrust for vertical (fighting gravity)
      unit.vy = Math.max(0, unit.vy);
      const liftAccel = this.computeDirectedAirAccel(unit, 0, -1);
      const effectiveVertical = liftAccel * 0.5;
      const fallAccel = Math.max(0, AIR_DROP_GRAVITY - effectiveVertical);
      unit.vy += fallAccel * dt;
    } else if (unit.type === "air") {
      this.applyAirThrustMovement(unit, dt, command.move.dirX, command.move.dirY, command.move.allowDescend ?? false);
    } else {
      // Ground movement
      unit.vx += command.move.dirX * unit.accel * dt;
      unit.vy += command.move.dirY * unit.accel * dt;
    }

    // --- Fire ---
    if (!canOperate(unit)) {
      for (const req of command.fire) {
        result.fireBlocked.push({ slot: req.slot, reason: "cannot-operate" });
      }
      return result;
    }
    for (const req of command.fire) {
      const target = { x: req.aimX, y: req.aimY };
      const fired = this.fireWeaponSlot(unit, req.slot, req.manual, target, req.intendedTargetId, req.intendedTargetY);
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
              const weaponClass = stats.weaponClass ?? "rapid-fire";
              if (this.requiresDedicatedLoader(weaponClass)) {
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
    let dx = 0;
    let dy = 0;
    if (keys.a) dx -= 1;
    if (keys.d) dx += 1;
    if (keys.w) dy -= 1;
    if (keys.s) dy += 1;

    const fire: FireRequest[] = [];

    if (!this.hasAliveWeapons(unit)) {
      // Weaponless player unit — no fire, just movement
      return { move: { dirX: dx, dirY: dy, allowDescend: keys.s }, facing: null, fire };
    }

    // Manual fire from mouse hold
    if (this.manualFireHeld) {
      for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
        if (this.isWeaponManualControlEnabled(unit, slot)) {
          fire.push({
            slot,
            aimX: this.aimX,
            aimY: this.aimY,
            intendedTargetId: null,
            intendedTargetY: null,
            manual: true,
          });
        }
      }
    }

    // Auto-fire for non-suppressed slots
    const suppressedAutoSlots = this.getManualControlSuppressedSlots(unit);
    const target = this.pickTarget(unit);
    const baseTarget = this.getEnemyBaseCenter(unit.side);
    const attackTarget = target ?? baseTarget;
    unit.aiDebugTargetId = target?.id ?? null;

    let bestRange = 0;
    const slotCount = unit.weaponAttachmentIds.length;
    for (let slot = 0; slot < slotCount; slot += 1) {
      if (!unit.weaponAutoFire[slot]) continue;
      if (suppressedAutoSlots.has(slot)) continue;
      const attachmentId = unit.weaponAttachmentIds[slot];
      const attachment = unit.attachments.find((a) => a.id === attachmentId && a.alive) ?? null;
      if (!attachment) continue;
      const stats = COMPONENTS[attachment.component];
      const range = attachment.stats?.range ?? stats.range;
      if (range === undefined) continue;
      bestRange = Math.max(bestRange, this.getEffectiveWeaponRange(unit, range));
    }

    if (bestRange > 0) {
      unit.aiDebugLastRange = bestRange;
      const dxToTarget = Math.abs(attackTarget.x - unit.x);
      const canHitByAxis = !target || unit.type === "air" || target.type === "air" || Math.abs(target.y - unit.y) <= GROUND_FIRE_Y_TOLERANCE;
      if (dxToTarget < bestRange && canHitByAxis) {
        const targetVx = target?.vx ?? 0;
        const targetVy = target?.vy ?? 0;
        const solved = solveBallisticAim(unit.x, unit.y, attackTarget.x, attackTarget.y, targetVx, targetVy, bestRange);

        let aim = { x: attackTarget.x, y: attackTarget.y + unit.aiAimCorrectionY };
        let intendedY: number | null = target ? attackTarget.y : null;
        if (solved) {
          unit.aiDebugLastAngleRad = solved.firingAngleRad;
          intendedY = solved.y;
          const aimDistance = Math.max(90, Math.min(bestRange, PROJECTILE_SPEED * solved.leadTimeS));
          aim = {
            x: unit.x + Math.cos(solved.firingAngleRad) * aimDistance,
            y: unit.y + Math.sin(solved.firingAngleRad) * aimDistance,
          };
        } else {
          unit.aiDebugLastAngleRad = Math.atan2(aim.y - unit.y, aim.x - unit.x);
        }

        // Add auto-fire request using round-robin
        for (let offset = 0; offset < slotCount; offset += 1) {
          const slot = (unit.aiWeaponCycleIndex + offset) % slotCount;
          if (suppressedAutoSlots.has(slot)) continue;
          if (!unit.weaponAutoFire[slot]) continue;
          if ((unit.weaponFireTimers[slot] ?? 0) > 0) continue;
          fire.push({
            slot,
            aimX: aim.x,
            aimY: aim.y,
            intendedTargetId: target ? target.id : null,
            intendedTargetY: intendedY,
            manual: false,
          });
          break; // Only one auto slot per tick
        }
      }
    }

    return { move: { dirX: dx, dirY: dy, allowDescend: keys.s }, facing: null, fire };
  }

  private aiDecisionToCommand(unit: UnitInstance, decision: CombatDecision): UnitCommand {
    const fire: FireRequest[] = [];

    // Debug fields
    unit.aiState = decision.state;
    unit.aiDebugShouldEvade = decision.movement.shouldEvade;
    unit.aiDebugTargetId = decision.debug.targetId;
    unit.aiDebugDecisionPath = decision.debug.decisionPath;
    unit.aiDebugFireBlockReason = decision.debug.fireBlockedReason;

    if (!decision.firePlan) {
      unit.aiDebugLastRange = 0;
      unit.aiDebugLastAngleRad = 0;
      unit.aiDebugPreferredWeaponSlot = -1;
      unit.aiDebugLeadTimeS = 0;
    } else {
      unit.aiDebugLastRange = decision.firePlan.effectiveRange;
      unit.aiDebugLastAngleRad = decision.firePlan.angleRad;
      unit.aiDebugPreferredWeaponSlot = decision.firePlan.preferredSlot;
      unit.aiDebugLeadTimeS = decision.firePlan.leadTimeS;

      // Build fire request using priority cycling
      const slotCount = unit.weaponAttachmentIds.length;
      if (slotCount > 0) {
        const start = ((decision.firePlan.preferredSlot % slotCount) + slotCount) % slotCount;
        for (let offset = 0; offset < slotCount; offset += 1) {
          const slot = (start + offset) % slotCount;
          if (!unit.weaponAutoFire[slot]) continue;
          if ((unit.weaponFireTimers[slot] ?? 0) > 0) continue;
          fire.push({
            slot,
            aimX: decision.firePlan.aim.x,
            aimY: decision.firePlan.aim.y,
            intendedTargetId: decision.firePlan.intendedTargetId,
            intendedTargetY: decision.firePlan.intendedTargetY,
            manual: false,
          });
          break; // Only one slot per tick
        }
      }
    }

    return {
      move: { dirX: decision.movement.ax, dirY: decision.movement.ay },
      facing: decision.facing,
      fire,
    };
  }

  private airDropReturnToCommand(unit: UnitInstance, _dt: number): UnitCommand {
    const fire: FireRequest[] = [];
    const base = unit.side === "player" ? this.state.playerBase : this.state.enemyBase;
    const baseCenterX = base.x + base.w / 2;
    const dx = baseCenterX - unit.x;
    const dirX = Math.abs(dx) < 1 ? 0 : Math.sign(dx);

    // Set debug info
    unit.aiState = "evade";
    unit.aiDebugShouldEvade = true;
    unit.aiDebugDecisionPath = unit.aiDebugDecisionPath || "air-drop-return";

    // Try to fire at closest enemy while dropping
    if (this.hasAliveWeapons(unit)) {
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
            aimX: target.x,
            aimY: target.y,
            intendedTargetId: target.id,
            intendedTargetY: target.y,
            manual: false,
          });
          break;
        }
      }
    }

    return {
      move: { dirX, dirY: 0 },
      facing: dirX < 0 ? -1 : dirX > 0 ? 1 : null,
      fire,
    };
  }

  private retreatToCommand(unit: UnitInstance): UnitCommand {
    const base = unit.side === "player" ? this.state.playerBase : this.state.enemyBase;
    const baseCenterX = base.x + base.w / 2;
    const baseCenterY = base.y + base.h / 2;
    const laneBounds = this.getLaneBounds();
    const retreatY = clamp(baseCenterY, laneBounds.groundMinY, laneBounds.groundMaxY);

    const dx = baseCenterX - unit.x;
    const dy = retreatY - unit.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = (dy / dist) * 0.85;

    // Set debug info
    unit.aiState = "evade";
    unit.aiDebugShouldEvade = true;
    unit.aiDebugTargetId = null;
    unit.aiDebugDecisionPath = "weaponless-retreat";
    unit.aiDebugFireBlockReason = "no-weapons";
    unit.aiDebugPreferredWeaponSlot = -1;
    unit.aiDebugLeadTimeS = 0;

    return {
      move: { dirX: ux, dirY: uy },
      facing: unit.side === "player" ? 1 : -1,
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

  private canShootAtAngle(unit: UnitInstance, componentId: keyof typeof COMPONENTS, dx: number, dy: number, shootAngleDegOverride?: number): boolean {
    const stats = COMPONENTS[componentId];
    const shootAngleDeg = shootAngleDegOverride ?? stats.shootAngleDeg ?? 120;
    const halfAngleRad = (shootAngleDeg * Math.PI / 180) * 0.5;
    const facingAngle = unit.facing === 1 ? 0 : Math.PI;
    const aimAngle = Math.atan2(dy, dx);
    const delta = Math.atan2(Math.sin(aimAngle - facingAngle), Math.cos(aimAngle - facingAngle));
    return Math.abs(delta) <= halfAngleRad;
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

  private getSelectedWeaponRange(unit: UnitInstance): number {
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

  private hasAliveWeapons(unit: UnitInstance): boolean {
    return getAliveWeaponAttachments(unit).length > 0;
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

  private applyAiShotFeedback(projectile: BattleState["projectiles"][number]): void {
    if (!projectile.shooterWasAI || projectile.intendedTargetId === null || projectile.hitIntendedTarget) {
      return;
    }
    const shooter = this.state.units.find((unit) => unit.id === projectile.sourceId && unit.alive);
    if (!shooter) {
      return;
    }
    const verticalMiss = projectile.y - projectile.intendedTargetY;
    if (Math.abs(verticalMiss) <= AI_MISS_VERTICAL_TOLERANCE) {
      return;
    }

    if (verticalMiss > 0) {
      shooter.aiAimCorrectionY -= AI_GRAVITY_CORRECTION_STEP;
    } else {
      shooter.aiAimCorrectionY += AI_GRAVITY_CORRECTION_STEP;
    }
    shooter.aiAimCorrectionY = clamp(shooter.aiAimCorrectionY, -AI_GRAVITY_CORRECTION_CLAMP, AI_GRAVITY_CORRECTION_CLAMP);
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

    this.drawStructureAndFunctionalLayer(unit, 1, w, h);

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
    const cellSize = Math.max(8, Math.min(14, unit.radius * 1.7 * 0.24));
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

    const cellSize = Math.max(8, Math.min(14, w * 0.24));
    for (const item of items) {
      if (item.cell < 0 || item.cell >= unit.structure.length) {
        continue;
      }
      const cell = unit.structure[item.cell];
      if (!cell || cell.destroyed) {
        continue;
      }
      const offset = this.getCellOffsetLocal(unit, item.cell, cellSize);
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

  private drawStructureAndFunctionalLayer(unit: UnitInstance, sideSign: number, w: number, h: number): void {
    const cellSize = Math.max(8, Math.min(14, w * 0.24));

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
      const offset = this.getCellOffsetLocal(unit, attachment.cell, cellSize);
      const component = COMPONENTS[attachment.component];
      this.ctx.fillStyle = component.type === "weapon" ? "#f0b39f" : component.type === "control" ? "#9dd7ff" : "#a7c9a3";
      this.ctx.fillRect(offset.x - 2, offset.y - 2, 4, 4);
    }

    const weapon = firstAliveWeaponAttachment(unit);
    if (weapon) {
      this.ctx.fillStyle = unit.side === "player" ? "#a7d9ff" : "#f4b09d";
      this.ctx.fillRect(0, -2, sideSign * 16, 4);
    }

    if (!this.displayEnabled) {
      this.ctx.strokeStyle = "rgba(210, 228, 246, 0.5)";
      this.ctx.strokeRect(-w * 0.55, -h * 0.5, w * 1.1, h);
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
    const cellSize = Math.max(8, Math.min(14, unit.radius * 1.7 * 0.24));
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

  private projectileHitsLiveCell(projectile: BattleState["projectiles"][number], unit: UnitInstance, isAir: boolean): number | null {
    const laneBounds = this.getLaneBounds();
    const rects = this.getLiveCellRects(unit);
    let bestCellId: number | null = null;
    let bestEntryTime = Number.POSITIVE_INFINITY;
    for (const rect of rects) {
      const expandedLeft = rect.x - projectile.r;
      const expandedTop = rect.y - projectile.r;
      const expandedRight = rect.x + rect.w + projectile.r;
      const expandedBottom = rect.y + rect.h + projectile.r;
      const entryTime = this.segmentAabbEntryTime(
        projectile.prevX,
        projectile.prevY,
        projectile.x,
        projectile.y,
        expandedLeft,
        expandedTop,
        expandedRight,
        expandedBottom,
      );
      if (entryTime === null) {
        continue;
      }
      if (isAir && Math.abs(unit.y - projectile.y) > laneBounds.airTargetTolerance + projectile.r) {
        continue;
      }
      if (entryTime < bestEntryTime) {
        bestEntryTime = entryTime;
        bestCellId = rect.id;
      }
    }
    return bestCellId;
  }

  private segmentAabbEntryTime(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): number | null {
    const dx = x1 - x0;
    const dy = y1 - y0;
    let tMin = 0;
    let tMax = 1;

    if (Math.abs(dx) < 1e-6) {
      if (x0 < left || x0 > right) {
        return null;
      }
    } else {
      const invDx = 1 / dx;
      let tx1 = (left - x0) * invDx;
      let tx2 = (right - x0) * invDx;
      if (tx1 > tx2) {
        const swap = tx1;
        tx1 = tx2;
        tx2 = swap;
      }
      tMin = Math.max(tMin, tx1);
      tMax = Math.min(tMax, tx2);
      if (tMin > tMax) {
        return null;
      }
    }

    if (Math.abs(dy) < 1e-6) {
      if (y0 < top || y0 > bottom) {
        return null;
      }
    } else {
      const invDy = 1 / dy;
      let ty1 = (top - y0) * invDy;
      let ty2 = (bottom - y0) * invDy;
      if (ty1 > ty2) {
        const swap = ty1;
        ty1 = ty2;
        ty2 = swap;
      }
      tMin = Math.max(tMin, ty1);
      tMax = Math.min(tMax, ty2);
      if (tMin > tMax) {
        return null;
      }
    }

    if (tMax < 0 || tMin > 1) {
      return null;
    }
    return Math.max(0, tMin);
  }

  private spawnBreakDebris(
    unit: UnitInstance,
    beforeDestroyed: Set<number>,
    beforeAliveAttachments: Set<number>,
    wasAlive: boolean,
  ): void {
    const cellSize = Math.max(8, Math.min(14, unit.radius * 1.7 * 0.24));

    for (const cell of unit.structure) {
      if (!cell.destroyed || beforeDestroyed.has(cell.id)) {
        continue;
      }
      const offset = this.getCellOffsetWorld(unit, cell.id, cellSize);
      const materialColor = MATERIALS[cell.material].color;
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
