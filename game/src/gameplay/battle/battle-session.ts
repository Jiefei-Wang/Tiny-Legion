import { armyCap } from "../../config/balance/commander.ts";
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
import { evaluateCombatDecisionTree } from "../../ai/decision-tree/combat-decision-tree.ts";
import type { CombatDecision } from "../../ai/decision-tree/combat-decision-tree.ts";
import type { BattleState, KeyState, MapNode, Side, UnitInstance, UnitTemplate } from "../../types.ts";

const GROUND_MIN_Y = 250;
const GROUND_MAX_Y = 485;
const AIR_MIN_Z = 70;
const AIR_MAX_Z = 220;
const AIR_TARGET_Z_TOLERANCE = 22;

export const BATTLE_SALVAGE_REFUND_FACTOR = 0.6;
const AIR_MIN_REACHABLE_SPEED = 100;
const AIR_DROP_GRAVITY = 210;

export interface BattleHooks {
  addLog: (text: string, tone?: "good" | "warn" | "bad" | "") => void;
  getCommanderSkill: () => number;
  getPlayerGas: () => number;
  spendPlayerGas: (amount: number) => boolean;
  addPlayerGas: (amount: number) => void;
  onBattleOver: (victory: boolean, nodeId: string, reason: string) => void;
}

export interface BattleAiInput {
  unit: UnitInstance;
  state: BattleState;
  dt: number;
  desiredRange: number;
  baseTarget: { x: number; y: number };
  canShootAtAngle: (componentId: keyof typeof COMPONENTS, dx: number, dy: number) => boolean;
  getEffectiveWeaponRange: (baseRange: number) => number;
}

export interface BattleAiController {
  decide: (input: BattleAiInput) => CombatDecision;
}

export interface BattleSessionOptions {
  aiControllers?: Partial<Record<Side, BattleAiController>>;
  autoEnableAiWeaponAutoFire?: boolean;
}

export class BattleSession {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hooks: BattleHooks;
  private readonly templates: UnitTemplate[];
  private readonly aiControllers: Partial<Record<Side, BattleAiController>>;
  private readonly autoEnableAiWeaponAutoFire: boolean;
  private state: BattleState;
  private selectedUnitId: string | null;
  private playerControlledId: string | null;
  private aimX: number;
  private aimY: number;
  private manualFireHeld: boolean;
  private displayEnabled: boolean;
  private debugDrawEnabled: boolean;
  private debugTargetLineEnabled: boolean;

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
    this.state = this.createEmptyBattle();
    this.selectedUnitId = null;
    this.playerControlledId = null;
    this.aimX = canvas.width * 0.7;
    this.aimY = canvas.height * 0.5;
    this.manualFireHeld = false;
    this.displayEnabled = true;
    this.debugDrawEnabled = false;
    this.debugTargetLineEnabled = false;
  }

  public getState(): BattleState {
    return this.state;
  }

  public getSelection(): { selectedUnitId: string | null; playerControlledId: string | null } {
    return { selectedUnitId: this.selectedUnitId, playerControlledId: this.playerControlledId };
  }

  public isDisplayEnabled(): boolean {
    return this.displayEnabled;
  }

  public toggleDisplayLayer(): void {
    this.displayEnabled = !this.displayEnabled;
    this.hooks.addLog(this.displayEnabled ? "Display layer ON" : "Display layer OFF", "warn");
  }

  public setDebugDrawEnabled(enabled: boolean): void {
    this.debugDrawEnabled = enabled;
  }

  public setDebugTargetLineEnabled(enabled: boolean): void {
    this.debugTargetLineEnabled = enabled;
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
    this.fireUnit(controlled, true, { x: this.aimX, y: this.aimY });
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

  public selectControlledWeapon(slotIndex: number): void {
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
    controlled.selectedWeaponIndex = slotIndex;
    this.hooks.addLog(`${controlled.name} selected weapon #${slotIndex + 1}`);
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

    const starterA = instantiateUnit(this.templates, "scout-ground", "player", 140, 300, { deploymentGasCost: 0 });
    const starterB = instantiateUnit(this.templates, "tank-ground", "player", 150, 430, { deploymentGasCost: 0 });
    if (starterA) {
      this.state.units.push(starterA);
    }
    if (starterB) {
      this.state.units.push(starterB);
    }
    for (let i = 0; i < 2; i += 1) {
      this.maybeSpawnEnemy();
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
    if (!this.hooks.spendPlayerGas(template.gasCost)) {
      this.hooks.addLog("Not enough gas for deployment", "warn");
      return;
    }

    const y = template.type === "air"
      ? AIR_MIN_Z + Math.random() * (AIR_MAX_Z - AIR_MIN_Z)
      : GROUND_MIN_Y + Math.random() * (GROUND_MAX_Y - GROUND_MIN_Y);
    const unit = instantiateUnit(this.templates, templateId, "player", 120, y);
    if (unit) {
      this.state.units.push(unit);
      this.hooks.addLog(`Deployed ${template.name} (-${template.gasCost} gas)`);
    }
  }

  public update(dt: number, keys: KeyState): void {
    if (!this.state.active || this.state.outcome) {
      return;
    }

    this.state.enemySpawnTimer -= dt;
    if (this.state.enemySpawnTimer <= 0) {
      this.state.enemySpawnTimer = 4.2 + Math.random() * 2.8;
      this.maybeSpawnEnemy();
    }
    this.ensureEnemyMinimumPresence();

    for (const unit of this.state.units) {
      if (!unit.alive || !canOperate(unit)) {
        continue;
      }
      this.refreshUnitMobility(unit);
      this.updateAirDropState(unit, dt);
      if (unit.controlImpairTimer > 0) {
        unit.controlImpairTimer = Math.max(0, unit.controlImpairTimer - dt);
        if (unit.controlImpairTimer <= 0) {
          unit.controlImpairFactor = 1;
        }
      }
      const isControlled = unit.side === "player" && unit.id === this.playerControlledId;
      if (!unit.airDropActive) {
        if (isControlled) {
          this.updateControlledUnit(unit, dt, keys);
        } else {
          this.updateUnitAI(unit, dt);
        }
      }

      if (unit.controlImpairFactor < 1) {
        unit.vx *= unit.controlImpairFactor;
        unit.vy *= unit.controlImpairFactor;
      }

      unit.vx = clamp(unit.vx, -unit.maxSpeed, unit.maxSpeed);
      unit.vy = clamp(unit.vy, -unit.maxSpeed * 0.75, unit.maxSpeed * 0.75);
      unit.x += unit.vx * dt;
      unit.y += unit.vy * dt;

      if (!unit.airDropActive) {
        unit.vx *= unit.turnDrag;
        unit.vy *= unit.type === "air" ? 0.9 : 0.83;
      }
      for (let i = 0; i < unit.weaponFireTimers.length; i += 1) {
        unit.weaponFireTimers[i] = Math.max(0, unit.weaponFireTimers[i] - dt);
      }
      this.updateWeaponLoaders(unit, dt, isControlled);
      unit.vibrate *= 0.85;
      applyStructureRecovery(unit, dt);

      if (unit.type === "ground") {
        unit.y = clamp(unit.y, GROUND_MIN_Y, GROUND_MAX_Y);
      } else {
        if (unit.airDropActive) {
          unit.y = clamp(unit.y, AIR_MIN_Z, unit.airDropTargetY);
        } else {
          unit.y = clamp(unit.y, AIR_MIN_Z, AIR_MAX_Z);
        }
      }
      unit.x = clamp(unit.x, 44, this.canvas.width - 44);

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
            applyHitToUnit(target, projectile.damage, projectile.hitImpulse, impactSide, hitCellId);
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
          applyHitToUnit(target, projectile.damage, projectile.hitImpulse, impactSide, hitCellId);
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
        if (chunk.y >= GROUND_MAX_Y + 4) {
          chunk.y = GROUND_MIN_Y + Math.random() * (GROUND_MAX_Y - GROUND_MIN_Y);
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
    return {
      active: false,
      nodeId: null,
      units: [],
      projectiles: [],
      particles: [],
      debris: [],
      playerBase: { hp: 1300, maxHp: 1300, x: 18, y: 180, w: 38, h: 160 },
      enemyBase: { hp: 1300, maxHp: 1300, x: this.canvas.width - 56, y: 180, w: 38, h: 160 },
      enemyGas: 220,
      enemyCap: 3,
      enemyMinActive: 0,
      enemyInfiniteGas: false,
      enemySpawnTimer: 0,
      outcome: null,
    };
  }

  private maybeSpawnEnemy(): boolean {
    const aliveEnemy = this.state.units.filter((unit) => unit.side === "enemy" && unit.alive).length;
    if (aliveEnemy >= this.state.enemyCap) {
      return false;
    }
    const pickList = ["scout-ground", "tank-ground", "air-light"];
    const pick = pickList[Math.floor(Math.random() * pickList.length)];
    const template = this.templates.find((entry) => entry.id === pick);
    if (!template) {
      return false;
    }
    const hasGas = this.state.enemyGas >= template.gasCost;
    if (!this.state.enemyInfiniteGas && (!hasGas || this.state.enemyGas < 20)) {
      return false;
    }

    if (!this.state.enemyInfiniteGas) {
      this.state.enemyGas -= template.gasCost;
    }
    const y = template.type === "air"
      ? AIR_MIN_Z + Math.random() * (AIR_MAX_Z - AIR_MIN_Z)
      : GROUND_MIN_Y + Math.random() * (GROUND_MAX_Y - GROUND_MIN_Y);
    const enemy = instantiateUnit(this.templates, template.id, "enemy", this.canvas.width - 120, y);
    if (enemy) {
      this.state.units.push(enemy);
      return true;
    }
    return false;
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
      applyHitToUnit(target, splashDamage, projectile.hitImpulse * 0.45, impactSide, hitCellId);
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

  private fireUnit(
    unit: UnitInstance,
    manual: boolean,
    target: { x: number; y: number } | null = null,
    intendedTargetId: string | null = null,
    intendedTargetY: number | null = null,
  ): void {
    if (!canOperate(unit)) {
      return;
    }
    if (manual) {
      this.fireSelectedWeapon(unit, target, intendedTargetId, intendedTargetY);
      return;
    }
    this.fireAutoWeapons(unit, target, intendedTargetId, intendedTargetY);
  }

  private fireSelectedWeapon(
    unit: UnitInstance,
    target: { x: number; y: number } | null,
    intendedTargetId: string | null,
    intendedTargetY: number | null,
  ): boolean {
    const slot = clamp(unit.selectedWeaponIndex, 0, Math.max(0, unit.weaponAttachmentIds.length - 1));
    return this.fireWeaponSlot(unit, slot, true, target, intendedTargetId, intendedTargetY);
  }

  private fireAutoWeapons(
    unit: UnitInstance,
    target: { x: number; y: number } | null,
    intendedTargetId: string | null,
    intendedTargetY: number | null,
    excludeSlot: number | null = null,
  ): void {
    const slotCount = unit.weaponAttachmentIds.length;
    if (slotCount === 0) {
      return;
    }
    for (let offset = 0; offset < slotCount; offset += 1) {
      const slot = (unit.aiWeaponCycleIndex + offset) % slotCount;
      if (excludeSlot !== null && slot === excludeSlot) {
        continue;
      }
      if (!unit.weaponAutoFire[slot]) {
        continue;
      }
      if ((unit.weaponFireTimers[slot] ?? 0) > 0) {
        continue;
      }
      const fired = this.fireWeaponSlot(unit, slot, false, target, intendedTargetId, intendedTargetY);
      if (fired) {
        unit.aiWeaponCycleIndex = (slot + 1) % slotCount;
        break;
      }
    }
  }

  private fireAutoWeaponsWithPriority(
    unit: UnitInstance,
    target: { x: number; y: number } | null,
    intendedTargetId: string | null,
    intendedTargetY: number | null,
    preferredSlot: number,
  ): boolean {
    const slotCount = unit.weaponAttachmentIds.length;
    if (slotCount <= 0) {
      return false;
    }
    const start = ((preferredSlot % slotCount) + slotCount) % slotCount;
    for (let offset = 0; offset < slotCount; offset += 1) {
      const slot = (start + offset) % slotCount;
      if (!unit.weaponAutoFire[slot]) {
        continue;
      }
      if ((unit.weaponFireTimers[slot] ?? 0) > 0) {
        continue;
      }
      const fired = this.fireWeaponSlot(unit, slot, false, target, intendedTargetId, intendedTargetY);
      if (fired) {
        unit.aiWeaponCycleIndex = (slot + 1) % slotCount;
        return true;
      }
    }
    return false;
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
    const shot = applyRecoilForAttachment(unit, attachmentId);
    if (!shot) {
      return false;
    }
    const attachment = unit.attachments.find((entry) => entry.id === attachmentId);
    if (!attachment) {
      return false;
    }
    if (this.requiresDedicatedLoader(shot.weaponClass)) {
      const charges = unit.weaponReadyCharges[slot] ?? 0;
      if (charges <= 0) {
        return false;
      }
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
    const weaponOffset = this.getCellOffset(unit, attachment.cell, weaponCellSize);
    const weaponOriginX = unit.x + weaponOffset.x;
    const weaponOriginY = unit.y + weaponOffset.y;
    const dx = targetX - weaponOriginX;
    const dy = targetY - weaponOriginY;
    const clampedAim = this.clampAimVectorToWeaponAngle(unit, attachment.component, dx, dy);
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
      sourceWeaponAttachmentId: attachmentId,
      damage: shot.damage,
      hitImpulse: shot.impulse,
      r: Math.max(2, Math.sqrt(shot.damage) * 0.35),
    });
    if (this.requiresDedicatedLoader(shot.weaponClass)) {
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
  ): { dx: number; dy: number } {
    const stats = COMPONENTS[componentId];
    const shootAngleDeg = stats.shootAngleDeg ?? 120;
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

      loaderState.targetWeaponSlot = nextSlot;
      loaderState.remaining = this.computeLoaderDuration(loaderStats, weaponStats.cooldown ?? 1);
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
      const enginePower = Math.max(0, stats.power ?? 0);
      const engineSpeedCap = Math.max(1, stats.maxSpeed ?? 90);
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

  private shouldAirUnitDrop(unit: UnitInstance): boolean {
    return unit.type === "air" && unit.maxSpeed < AIR_MIN_REACHABLE_SPEED;
  }

  private beginAirDrop(unit: UnitInstance): void {
    if (unit.airDropActive) {
      return;
    }
    unit.airDropActive = true;
    unit.airDropTargetY = GROUND_MIN_Y + Math.random() * (GROUND_MAX_Y - GROUND_MIN_Y);
    unit.vy = 0;
    unit.aiDebugDecisionPath = "air-stall-drop";
    unit.aiDebugFireBlockReason = "insufficient-reachable-speed";
    if (unit.id === this.playerControlledId || unit.id === this.selectedUnitId) {
      this.clearControlSelection();
    }
    this.hooks.addLog(`${unit.name} lost lift and is falling`, "warn");
  }

  private updateAirDropState(unit: UnitInstance, dt: number): void {
    if (this.shouldAirUnitDrop(unit)) {
      this.beginAirDrop(unit);
    }
    if (!unit.airDropActive) {
      return;
    }
    unit.vy += AIR_DROP_GRAVITY * dt;
    if (unit.y >= unit.airDropTargetY - 2) {
      this.onAirDropImpact(unit);
    }
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

  private canShootAtAngle(unit: UnitInstance, componentId: keyof typeof COMPONENTS, dx: number, dy: number): boolean {
    const stats = COMPONENTS[componentId];
    const shootAngleDeg = stats.shootAngleDeg ?? 120;
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

  private getSelectedWeaponRange(unit: UnitInstance): number {
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
    if (stats.range === undefined) {
      return 0;
    }
    return this.getEffectiveWeaponRange(unit, stats.range);
  }

  private getDesiredEngageRange(unit: UnitInstance): number {
    const weapons = getAliveWeaponAttachments(unit);
    if (weapons.length === 0) {
      return 180;
    }
    let best = 180;
    for (const weaponAttachment of weapons) {
      const stats = COMPONENTS[weaponAttachment.component];
      if (stats.range === undefined) {
        continue;
      }
      const factor = unit.type === "air" ? 0.52 : 0.62;
      best = Math.max(best, this.getEffectiveWeaponRange(unit, stats.range) * factor);
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
    const airBonus = getAircraftAltitudeBonus(unit, AIR_MIN_Z, GROUND_MIN_Y);
    return globalBuff * (1 + airBonus);
  }

  private updateUnitAI(unit: UnitInstance, dt: number): void {
    if (this.autoEnableAiWeaponAutoFire) {
      for (let i = 0; i < unit.weaponAutoFire.length; i += 1) {
        unit.weaponAutoFire[i] = true;
      }
    }
    if (!this.hasAliveWeapons(unit)) {
      this.updateWeaponlessUnit(unit, dt);
      return;
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
          canShootAtAngle: (componentId, dx, dy) => this.canShootAtAngle(unit, componentId, dx, dy),
          getEffectiveWeaponRange: (baseRange) => this.getEffectiveWeaponRange(unit, baseRange),
        })
      : evaluateCombatDecisionTree(
          unit,
          this.state,
          dt,
          desiredRange,
          baseTarget,
          (componentId, dx, dy) => this.canShootAtAngle(unit, componentId, dx, dy),
          (baseRange) => this.getEffectiveWeaponRange(unit, baseRange),
        );

    unit.facing = decision.facing;
    unit.aiState = decision.state;
    unit.aiDebugShouldEvade = decision.movement.shouldEvade;
    unit.aiDebugTargetId = decision.debug.targetId;
    unit.aiDebugDecisionPath = decision.debug.decisionPath;
    unit.aiDebugFireBlockReason = decision.debug.fireBlockedReason;

    unit.vx += decision.movement.ax * unit.accel * dt;
    unit.vy += decision.movement.ay * unit.accel * dt;

    if (!decision.firePlan) {
      unit.aiDebugLastRange = 0;
      unit.aiDebugLastAngleRad = 0;
      unit.aiDebugPreferredWeaponSlot = -1;
      unit.aiDebugLeadTimeS = 0;
      return;
    }

    unit.aiDebugLastRange = decision.firePlan.effectiveRange;
    unit.aiDebugLastAngleRad = decision.firePlan.angleRad;
    unit.aiDebugPreferredWeaponSlot = decision.firePlan.preferredSlot;
    unit.aiDebugLeadTimeS = decision.firePlan.leadTimeS;

    this.fireAutoWeaponsWithPriority(
      unit,
      decision.firePlan.aim,
      decision.firePlan.intendedTargetId,
      decision.firePlan.intendedTargetY,
      decision.firePlan.preferredSlot,
    );
  }

  private updateControlledUnit(unit: UnitInstance, dt: number, keys: KeyState): void {
    if (!this.hasAliveWeapons(unit)) {
      this.updateWeaponlessUnit(unit, dt);
      return;
    }
    let dx = 0;
    let dy = 0;
    if (keys.a) {
      dx -= 1;
    }
    if (keys.d) {
      dx += 1;
    }
    if (keys.w) {
      dy -= 1;
    }
    if (keys.s) {
      dy += 1;
    }

    unit.vx += dx * unit.accel * dt;
    unit.vy += dy * unit.accel * dt;

    const slotCount = unit.weaponAttachmentIds.length;
    if (slotCount > 0) {
      const excludeSlot = clamp(unit.selectedWeaponIndex, 0, Math.max(0, slotCount - 1));
      const target = this.pickTarget(unit);
      const baseTarget = this.getEnemyBaseCenter(unit.side);
      const attackTarget = target ?? baseTarget;
      unit.aiDebugTargetId = target?.id ?? null;

      let bestRange = 0;
      for (let slot = 0; slot < slotCount; slot += 1) {
        if (slot === excludeSlot) {
          continue;
        }
        if (!unit.weaponAutoFire[slot]) {
          continue;
        }
        const attachmentId = unit.weaponAttachmentIds[slot];
        const attachment = unit.attachments.find((entry) => entry.id === attachmentId && entry.alive) ?? null;
        if (!attachment) {
          continue;
        }
        const stats = COMPONENTS[attachment.component];
        if (stats.range === undefined) {
          continue;
        }
        bestRange = Math.max(bestRange, this.getEffectiveWeaponRange(unit, stats.range));
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

          this.fireAutoWeapons(unit, aim, target ? target.id : null, intendedY, excludeSlot);
        }
      }
    }

    if (this.manualFireHeld) {
      this.fireUnit(unit, true, { x: this.aimX, y: this.aimY }, null);
    }

  }

  private hasAliveWeapons(unit: UnitInstance): boolean {
    return getAliveWeaponAttachments(unit).length > 0;
  }

  private updateWeaponlessUnit(unit: UnitInstance, dt: number): void {
    if (unit.returnedToBase) {
      return;
    }

    if (unit.id === this.playerControlledId || unit.id === this.selectedUnitId) {
      this.clearControlSelection();
      this.hooks.addLog(`${unit.name} has no weapon and is returning to base`, "warn");
    }

    const base = unit.side === "player" ? this.state.playerBase : this.state.enemyBase;
    const baseCenterX = base.x + base.w / 2;
    const baseCenterY = base.y + base.h / 2;
    const retreatY = unit.type === "air"
      ? clamp(baseCenterY, AIR_MIN_Z, AIR_MAX_Z)
      : clamp(baseCenterY, GROUND_MIN_Y, GROUND_MAX_Y);

    unit.facing = unit.side === "player" ? 1 : -1;
    unit.aiState = "evade";
    unit.aiDebugShouldEvade = true;
    unit.aiDebugTargetId = null;
    unit.aiDebugDecisionPath = "weaponless-retreat";
    unit.aiDebugFireBlockReason = "no-weapons";
    unit.aiDebugPreferredWeaponSlot = -1;
    unit.aiDebugLeadTimeS = 0;

    const dx = baseCenterX - unit.x;
    const dy = retreatY - unit.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;

    unit.vx += ux * unit.accel * dt;
    unit.vy += uy * unit.accel * dt * 0.85;

    if (this.isUnitInsideBase(unit, base)) {
      this.onUnitReturnedToBase(unit);
    }
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

  private endBattle(victory: boolean, reason: string): void {
    if (!this.state.active || this.state.outcome || !this.state.nodeId) {
      return;
    }
    this.state.outcome = { victory, reason };
    this.state.active = false;
    this.hooks.onBattleOver(victory, this.state.nodeId, reason);
  }

  private drawLanes(): void {
    this.ctx.fillStyle = "rgba(138, 176, 216, 0.08)";
    this.ctx.fillRect(0, AIR_MIN_Z - 20, this.canvas.width, AIR_MAX_Z - AIR_MIN_Z + 40);

    this.ctx.fillStyle = "rgba(78, 122, 91, 0.17)";
    this.ctx.fillRect(0, GROUND_MIN_Y, this.canvas.width, GROUND_MAX_Y - GROUND_MIN_Y);

    this.ctx.strokeStyle = "rgba(117, 158, 118, 0.18)";
    this.ctx.lineWidth = 1;
    for (let x = 0; x <= this.canvas.width; x += 34) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, GROUND_MIN_Y);
      this.ctx.lineTo(x, GROUND_MAX_Y);
      this.ctx.stroke();
    }
    for (let y = GROUND_MIN_Y; y <= GROUND_MAX_Y; y += 28) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.canvas.width, y);
      this.ctx.stroke();
    }

    this.ctx.strokeStyle = "rgba(188, 219, 255, 0.32)";
    this.ctx.beginPath();
    this.ctx.moveTo(0, AIR_MAX_Z + 16);
    this.ctx.lineTo(this.canvas.width, AIR_MAX_Z + 16);
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
      const offset = this.getCellOffset(unit, cell.id, cellSize);
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
      const offset = this.getCellOffset(unit, item.cell, cellSize);
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

    for (const cell of unit.structure) {
      const offset = this.getCellOffset(unit, cell.id, cellSize);
      this.ctx.strokeStyle = cell.destroyed ? "rgba(160, 94, 94, 0.55)" : "rgba(184, 202, 224, 0.9)";
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(offset.x - cellSize / 2, offset.y - cellSize / 2, cellSize, cellSize);
      if (!cell.destroyed) {
        this.ctx.fillStyle = "rgba(130, 158, 186, 0.22)";
        this.ctx.fillRect(offset.x - cellSize / 2 + 1, offset.y - cellSize / 2 + 1, cellSize - 2, cellSize - 2);
      }
    }

    for (const attachment of unit.attachments) {
      if (!attachment.alive) {
        continue;
      }
      const offset = this.getCellOffset(unit, attachment.cell, cellSize);
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
  }

  private getUnitLayoutBounds(unit: UnitInstance): { minX: number; maxX: number; minY: number; maxY: number } {
    const minX = Math.min(...unit.structure.map((cell) => cell.x));
    const maxX = Math.max(...unit.structure.map((cell) => cell.x));
    const minY = Math.min(...unit.structure.map((cell) => cell.y));
    const maxY = Math.max(...unit.structure.map((cell) => cell.y));
    return { minX, maxX, minY, maxY };
  }

  private getCellOffset(unit: UnitInstance, cellId: number, cellSize: number): { x: number; y: number } {
    const cell = unit.structure.find((entry) => entry.id === cellId);
    if (!cell) {
      return { x: 0, y: 0 };
    }
    const bounds = this.getUnitLayoutBounds(unit);
    const width = (bounds.maxX - bounds.minX + 1) * cellSize;
    const height = (bounds.maxY - bounds.minY + 1) * cellSize;
    return {
      x: (cell.x - bounds.minX) * cellSize - width / 2 + cellSize / 2,
      y: (cell.y - bounds.minY) * cellSize - height / 2 + cellSize / 2,
    };
  }

  private getLiveCellRects(unit: UnitInstance): Array<{ id: number; x: number; y: number; w: number; h: number }> {
    const cellSize = Math.max(8, Math.min(14, unit.radius * 1.7 * 0.24));
    const rects: Array<{ id: number; x: number; y: number; w: number; h: number }> = [];
    for (const cell of unit.structure) {
      if (cell.destroyed) {
        continue;
      }
      const offset = this.getCellOffset(unit, cell.id, cellSize);
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
    const rects = this.getLiveCellRects(unit);
    for (const rect of rects) {
      const expandedLeft = rect.x - projectile.r;
      const expandedTop = rect.y - projectile.r;
      const expandedRight = rect.x + rect.w + projectile.r;
      const expandedBottom = rect.y + rect.h + projectile.r;
      const hitNow =
        projectile.x >= expandedLeft &&
        projectile.x <= expandedRight &&
        projectile.y >= expandedTop &&
        projectile.y <= expandedBottom;
      const hitSweep = this.segmentIntersectsAabb(
        projectile.prevX,
        projectile.prevY,
        projectile.x,
        projectile.y,
        expandedLeft,
        expandedTop,
        expandedRight,
        expandedBottom,
      );
      if (hitNow || hitSweep) {
        if (isAir && Math.abs(unit.y - projectile.y) > AIR_TARGET_Z_TOLERANCE + projectile.r) {
          continue;
        }
        return rect.id;
      }
    }
    return null;
  }

  private segmentIntersectsAabb(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    let tMin = 0;
    let tMax = 1;

    if (Math.abs(dx) < 1e-6) {
      if (x0 < left || x0 > right) {
        return false;
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
        return false;
      }
    }

    if (Math.abs(dy) < 1e-6) {
      if (y0 < top || y0 > bottom) {
        return false;
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
        return false;
      }
    }

    return tMax >= 0 && tMin <= 1;
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
      const offset = this.getCellOffset(unit, cell.id, cellSize);
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
      const offset = this.getCellOffset(unit, attachment.cell, cellSize);
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
