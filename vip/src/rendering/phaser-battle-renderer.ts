import Phaser from "phaser";
import { COMPONENTS } from "../config/balance/weapons.ts";
import { getStructureCellSize } from "../config/balance/battlefield.ts";
import { PROJECTILE_ASSETS } from "../../../game-core/src/projectiles/generated/projectile-assets.generated.ts";
import type { BattleState, FireSoundPool, UnitInstance, UnitTemplate } from "../types.ts";
import type { BattleAudioEvent, BattleSession } from "../gameplay/battle/battle-session.ts";
import {
  BATTLE_SAMPLE_URLS,
  BATTLE_SPATIAL_AUDIO_CONFIG,
  BATTLE_SYNTH_AUDIO_CONFIG,
  DEFAULT_BATTLE_SOUND_VOLUME,
  FIRE_SAMPLE_KEYS,
  FIRE_SAMPLE_RATE,
  MAX_BATTLE_SOUND_VOLUME,
  MIN_BATTLE_SOUND_VOLUME,
  type BattleSampleKey,
} from "../../../game-core/src/config/sound/battle.ts";
import { BATTLE_CANVAS_RESOLUTION_SCALE } from "../../../game-core/src/config/display/battle.ts";

export { DEFAULT_BATTLE_SOUND_VOLUME, MAX_BATTLE_SOUND_VOLUME, MIN_BATTLE_SOUND_VOLUME };

export interface BattleViewAudioContext {
  centerX: number;
  worldWidth: number;
}

const color = (value: string, fallback = 0x829eba): number => {
  try {
    return Phaser.Display.Color.HexStringToColor(value).color;
  } catch {
    return fallback;
  }
};

const materialAcoustics = (materialColor: string): { resonance: number; roughness: number } => {
  const match = /^#?([0-9a-f]{6})$/i.exec(materialColor.trim());
  if (!match) return { resonance: 1, roughness: 1 };
  const value = Number.parseInt(match[1], 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  const brightness = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
  const saturation = (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
  return {
    resonance: 0.78 + brightness * 0.44,
    roughness: 0.82 + saturation * 0.46,
  };
};

/** Phaser presentation scene. Game rules remain in BattleSession for browser/headless parity. */
class BattleScene extends Phaser.Scene {
  private airBackground!: Phaser.GameObjects.Image;
  private groundBackground!: Phaser.GameObjects.Image;
  private playerBaseSprite!: Phaser.GameObjects.Image;
  private enemyBaseSprite!: Phaser.GameObjects.Image;
  private graphics!: Phaser.GameObjects.Graphics;
  private status!: Phaser.GameObjects.Text;
  private readonly battle: BattleSession;
  private readonly templates: ReadonlyArray<UnitTemplate>;
  private readonly getViewAudioContext: () => BattleViewAudioContext;
  private readonly getSoundVolume: () => number;
  private readonly knownUnitIds = new Set<string>();
  private readonly nextEnginePulseByUnitId = new Map<string, number>();
  private noiseBuffer: AudioBuffer | null = null;
  private audioResumePending = false;
  private readonly lastSampleByGroup = new Map<string, BattleSampleKey>();
  private projectileSprites: Phaser.GameObjects.Image[] = [];
  private viewOffsetX = 0;
  private viewOffsetY = 0;
  private viewScale = 1;
  private readonly canvasResolutionScale: number;

  public constructor(
    battle: BattleSession,
    templates: ReadonlyArray<UnitTemplate>,
    getViewAudioContext: () => BattleViewAudioContext,
    getSoundVolume: () => number,
    canvasResolutionScale: number,
  ) {
    super({ key: "battle" });
    this.battle = battle;
    this.templates = templates;
    this.getViewAudioContext = getViewAudioContext;
    this.getSoundVolume = getSoundVolume;
    this.canvasResolutionScale = canvasResolutionScale;
  }

  public preload(): void {
    this.load.image("battle-air-layer", "/assets/campaign/battle-air-layer.webp");
    this.load.image("battle-ground-layer", "/assets/campaign/battle-ground-layer.webp");
    this.load.image("battle-command-base", "/assets/campaign/battle-base.png");
    for (const [shape, asset] of Object.entries(PROJECTILE_ASSETS)) this.load.svg(`projectile:${shape}`, asset.url);
    for (const [key, url] of Object.entries(BATTLE_SAMPLE_URLS)) this.load.audio(key, url);
  }

  public create(): void {
    this.airBackground = this.add.image(0, 0, "battle-air-layer").setOrigin(0, 0).setDepth(-10);
    this.groundBackground = this.add.image(0, 0, "battle-ground-layer").setOrigin(0, 0).setDepth(-9);
    this.playerBaseSprite = this.add.image(0, 0, "battle-command-base").setOrigin(0, 1).setDepth(0).setVisible(false);
    this.enemyBaseSprite = this.add.image(0, 0, "battle-command-base").setOrigin(1, 1).setDepth(0).setTint(0xffa095).setVisible(false);
    this.graphics = this.add.graphics().setDepth(1);
    this.status = this.add.text(16, 14, "", {
      color: "#dce8f5",
      fontFamily: "Trebuchet MS",
      fontSize: "14px",
      backgroundColor: "rgba(8, 13, 21, 0.72)",
      padding: { x: 8, y: 6 },
    }).setDepth(1000).setScrollFactor(0);
    document.addEventListener("pointerdown", this.unlockAudioOnGesture, { capture: true });
    document.addEventListener("keydown", this.unlockAudioOnGesture, { capture: true });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      document.removeEventListener("pointerdown", this.unlockAudioOnGesture, { capture: true });
      document.removeEventListener("keydown", this.unlockAudioOnGesture, { capture: true });
    });
  }

  public update(): void {
    const camera = this.cameras.main;
    const zoom = this.viewScale * this.canvasResolutionScale;
    const halfWidth = this.scale.width * 0.5;
    const halfHeight = this.scale.height * 0.5;
    const visibleLeft = -this.viewOffsetX / this.viewScale;
    const visibleTop = -this.viewOffsetY / this.viewScale;
    camera.setZoom(zoom);
    // Phaser zooms around the camera center. Convert the app's top-left world
    // offset into Phaser's center-anchored scroll coordinates.
    camera.setScroll(
      visibleLeft - halfWidth + halfWidth / zoom,
      visibleTop - halfHeight + halfHeight / zoom,
    );
    // Scroll-factor zero removes camera translation, but camera zoom still
    // applies around its center. Counter-transform the fixed debug HUD.
    this.status
      .setPosition(
        halfWidth + (16 * this.canvasResolutionScale - halfWidth) / zoom,
        halfHeight + (14 * this.canvasResolutionScale - halfHeight) / zoom,
      )
      .setScale(1 / this.viewScale);
    this.draw(this.battle.getState());
    // Do not discard transient combat sounds while browser autoplay policy still
    // has Web Audio suspended. The next user gesture unlocks the shared context.
    if (this.getAudioContext()) {
      for (const event of this.battle.consumeBattleAudioEvents()) this.playBattleEvent(event);
    }
    this.updateUnitAudio(this.battle.getState());
  }

  public setViewTransform(offsetX: number, offsetY: number, scale: number): void {
    this.viewOffsetX = offsetX;
    this.viewOffsetY = offsetY;
    this.viewScale = Math.max(0.0001, scale);
  }

  private isVisiblePoint(x: number, y: number, padding = 0): boolean {
    const view = this.getVisibleWorldRect();
    return x + padding >= view.left
      && x - padding <= view.right
      && y + padding >= view.top
      && y - padding <= view.bottom;
  }

  private getVisibleWorldRect(): { left: number; right: number; top: number; bottom: number } {
    const left = -this.viewOffsetX / this.viewScale;
    const top = -this.viewOffsetY / this.viewScale;
    return {
      left,
      right: left + this.scale.width / (this.viewScale * this.canvasResolutionScale),
      top,
      bottom: top + this.scale.height / (this.viewScale * this.canvasResolutionScale),
    };
  }

  private acquireProjectileSprite(index: number, texture: string): Phaser.GameObjects.Image {
    const existing = this.projectileSprites[index];
    if (existing) {
      return existing.setTexture(texture).setVisible(true);
    }
    const created = this.add.image(0, 0, texture);
    this.projectileSprites.push(created);
    return created;
  }

  private draw(state: BattleState): void {
    const g = this.graphics;
    const options = this.battle.getRenderOptions();
    const selection = this.battle.getSelection();
    const { width, height, laneBounds } = this.battle.getBattlefieldInfo();
    const groundY = laneBounds.groundMinY;
    const view = this.getVisibleWorldRect();
    const visibleLeft = Math.max(0, view.left);
    const visibleRight = Math.min(width, view.right);
    const visibleTop = Math.max(0, view.top);
    const visibleBottom = Math.min(height, view.bottom);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    this.airBackground.setPosition(0, 0).setDisplaySize(width, groundY);
    this.groundBackground.setPosition(0, groundY).setDisplaySize(width, Math.max(1, height - groundY));
    g.clear();
    let projectileSpriteCount = 0;
    if (visibleWidth > 0) {
      const visibleAirBottom = Math.min(visibleBottom, groundY);
      if (visibleAirBottom > visibleTop) {
        g.fillStyle(0x06101a, 0.08).fillRect(visibleLeft, visibleTop, visibleWidth, visibleAirBottom - visibleTop);
      }
      const visibleGroundTop = Math.max(visibleTop, groundY);
      if (visibleBottom > visibleGroundTop) {
        g.fillStyle(0x06130f, 0.08).fillRect(visibleLeft, visibleGroundTop, visibleWidth, visibleBottom - visibleGroundTop);
      }
      if (groundY + 2 >= visibleTop && groundY - 2 <= visibleBottom) {
        g.fillStyle(0xb5eff4, 0.14).fillRect(visibleLeft, groundY - 2, visibleWidth, 4);
      }
    }
    this.playerBaseSprite.setVisible(false);
    this.enemyBaseSprite.setVisible(false);
    if (!state.active && !state.outcome) {
      for (const sprite of this.projectileSprites) sprite.setVisible(false);
      this.status.setText("Map/Base Mode\nSelect a map node and launch battle.").setVisible(true);
      return;
    }

    this.drawBase(state.playerBase, 0x5d8bb3);
    this.drawBase(state.enemyBase, 0xb36b63);
    if (options.debugDraw) {
      for (const unit of state.units) {
        if (!unit.alive || !this.isVisiblePoint(unit.x, unit.y, unit.radius + 120)) continue;
        const range = this.battle.getSelectedWeaponRange(unit);
        if (range > 0) {
          const emphasized = unit.id === selection.playerControlledId || unit.id === selection.selectedUnitId;
          const rangeColor = unit.side === "player" ? 0x72e3c2 : 0xff8f82;
          if (emphasized) g.fillStyle(rangeColor, 0.035).fillCircle(unit.x, unit.y, range);
          g.lineStyle(emphasized ? 2 : 1.25, rangeColor, emphasized ? 0.62 : 0.2).strokeCircle(unit.x, unit.y, range);
          if (emphasized) {
            for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
              const ux = Math.cos(angle), uy = Math.sin(angle);
              g.lineStyle(2, 0xc7fff0, 0.72).lineBetween(
                unit.x + ux * (range - 8), unit.y + uy * (range - 8),
                unit.x + ux * (range + 8), unit.y + uy * (range + 8),
              );
            }
          }
        }
      }
    }
    for (const p of state.particles) {
      if (this.isVisiblePoint(p.x, p.y, p.size + 8)) {
        g.fillStyle(0xf5c07a, Math.min(1, p.life / 0.4)).fillCircle(p.x, p.y, Math.max(1, p.size * (1 - p.life * 0.8)));
      }
    }
    for (const beam of state.beamEffects) {
      const beamLeft = Math.min(beam.x1, beam.x2) - beam.halfWidth;
      const beamRight = Math.max(beam.x1, beam.x2) + beam.halfWidth;
      const beamTop = Math.min(beam.y1, beam.y2) - beam.halfWidth;
      const beamBottom = Math.max(beam.y1, beam.y2) + beam.halfWidth;
      if (beamRight < view.left || beamLeft > view.right || beamBottom < view.top || beamTop > view.bottom) continue;
      const alpha = Math.max(0, Math.min(1, beam.life / beam.maxLife));
      const beamColor = beam.side === "player" ? 0x8ff6ff : 0xff8fa8;
      const asset = PROJECTILE_ASSETS[beam.shape];
      const collider = asset.collider;
      const visualHeight = collider.kind === "beam-rect" ? beam.halfWidth / Math.max(0.001, collider.halfHeight) : beam.halfWidth * 2;
      const length = Math.hypot(beam.x2 - beam.x1, beam.y2 - beam.y1);
      this.acquireProjectileSprite(projectileSpriteCount, `projectile:${beam.shape}`)
          .setPosition((beam.x1 + beam.x2) / 2, (beam.y1 + beam.y2) / 2)
          .setDisplaySize(length, visualHeight)
          .setRotation(Math.atan2(beam.y2 - beam.y1, beam.x2 - beam.x1))
          .setTint(beamColor)
          .setAlpha(alpha)
          .setDepth(0.9);
      projectileSpriteCount += 1;
      if (options.debugDraw) {
        const px = -(beam.y2 - beam.y1) / Math.max(1, length);
        const py = (beam.x2 - beam.x1) / Math.max(1, length);
        g.lineStyle(1, 0xffeb96, 0.9)
          .lineBetween(beam.x1 + px * beam.halfWidth, beam.y1 + py * beam.halfWidth, beam.x2 + px * beam.halfWidth, beam.y2 + py * beam.halfWidth)
          .lineBetween(beam.x1 - px * beam.halfWidth, beam.y1 - py * beam.halfWidth, beam.x2 - px * beam.halfWidth, beam.y2 - py * beam.halfWidth);
      }
    }
    for (const p of state.projectiles) {
      const projectileColor = p.side === "player" ? 0x9bd5ff : 0xff9d81;
      if (p.projectileClass === "laser") continue;
      if (!this.isVisiblePoint(p.x, p.y, Math.max(24, p.visualHeight * 2))) continue;
      const asset = PROJECTILE_ASSETS[p.projectileShape];
      const angle = Math.atan2(p.vy, p.vx);
      this.acquireProjectileSprite(projectileSpriteCount, `projectile:${p.projectileShape}`)
          .setPosition(p.x, p.y)
          .setDisplaySize(p.visualHeight * asset.aspect, p.visualHeight)
          .setRotation(angle)
          .setTint(projectileColor)
          .setAlpha(1)
          .setDepth(0.9);
      projectileSpriteCount += 1;
      if (options.debugDraw) {
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const px = -uy;
        const py = ux;
        const cx = p.x + ux * p.capsuleCenterX + px * p.capsuleCenterY;
        const cy = p.y + uy * p.capsuleCenterX + py * p.capsuleCenterY;
        g.lineStyle(1, 0xffeb96, 0.9)
          .lineBetween(cx - ux * p.capsuleHalfLength, cy - uy * p.capsuleHalfLength, cx + ux * p.capsuleHalfLength, cy + uy * p.capsuleHalfLength)
          .strokeCircle(cx - ux * p.capsuleHalfLength, cy - uy * p.capsuleHalfLength, p.capsuleRadius)
          .strokeCircle(cx + ux * p.capsuleHalfLength, cy + uy * p.capsuleHalfLength, p.capsuleRadius);
      }
    }
    for (let index = projectileSpriteCount; index < this.projectileSprites.length; index += 1) {
      this.projectileSprites[index].setVisible(false);
    }
    for (const d of state.debris) {
      if (this.isVisiblePoint(d.x, d.y, d.size + 4)) {
        g.fillStyle(color(d.color), 1).fillRect(d.x - d.size / 2, d.y - d.size / 2, d.size, d.size);
      }
    }
    for (const unit of state.units) {
      if (this.isVisiblePoint(unit.x, unit.y, unit.radius + 80)) this.drawUnit(unit, options, selection, state.projectiles);
    }
    for (const effect of state.blockExplosions) {
      if (this.isVisiblePoint(effect.x, effect.y, effect.size + 24)) this.drawBlockExplosion(effect);
    }

    if (options.debugTargetLines) {
      for (const unit of state.units) {
        if (!this.isVisiblePoint(unit.x, unit.y, unit.radius + 40)) continue;
        const target = state.units.find((candidate) => candidate.id === unit.aiDebugTargetId && candidate.alive);
        const base = unit.side === "player" ? state.enemyBase : state.playerBase;
        const targetX = target?.x ?? base.x + base.w / 2;
        const targetY = target?.y ?? base.y + base.h / 2;
        const targetColor = unit.side === "player" ? 0x9bd5ff : 0xffb19a;
        g.lineStyle(1, unit.side === "player" ? 0x9bd5ff : 0xffb19a, 0.7)
          .lineBetween(unit.x, unit.y, targetX, targetY);
        g.lineStyle(1.5, targetColor, 0.9)
          .strokeCircle(targetX, targetY, 9)
          .lineBetween(targetX - 13, targetY, targetX + 13, targetY)
          .lineBetween(targetX, targetY - 13, targetX, targetY + 13);
      }
    }

    if (options.debugDraw) {
      const evading = state.units.filter((unit) => unit.aiDebugShouldEvade).length;
      this.status.setText(`PHASER DEBUG | units ${state.units.length} | shots ${state.projectiles.length} | evading ${evading}`).setVisible(true);
    } else if (state.outcome) {
      this.status.setText(`${state.outcome.victory ? "VICTORY" : "DEFEAT"}\n${state.outcome.reason}`).setVisible(true);
    } else {
      this.status.setVisible(false);
    }
  }

  private drawBase(base: BattleState["playerBase"], fill: number): void {
    const hp = Math.max(0, Math.min(1, base.hp / Math.max(1, base.maxHp)));
    const g = this.graphics;
    const friendly = fill === 0x5d8bb3;
    const glow = friendly ? 0x71dddf : 0xe47b6e;
    const centerX = base.x + base.w * 0.5;
    const visualW = Math.max(310, base.w * 6.4);
    const visualH = visualW * (929 / 1693);
    const sprite = friendly ? this.playerBaseSprite : this.enemyBaseSprite;
    sprite
      .setPosition(friendly ? Math.max(2, base.x - 4) : base.x + base.w + 4, base.y + base.h + 3)
      .setDisplaySize(visualW, visualH)
      .setVisible(true);
    g.fillStyle(0x02070b, 0.42).fillEllipse(centerX + (friendly ? 24 : -24), base.y + base.h + 7, visualW * 0.9, 20);
    g.lineStyle(2.5, glow, 0.36).strokeEllipse(centerX + (friendly ? 24 : -24), base.y + base.h - visualH * 0.28, visualW * 0.72, visualH * 0.72);
    const healthX = friendly ? Math.max(8, base.x) : base.x + base.w - visualW * 0.68;
    const healthY = base.y + base.h - visualH - 10;
    g.fillStyle(0x071017, 0.94).fillRoundedRect(healthX, healthY, visualW * 0.68, 9, 4);
    g.fillStyle(hp > 0.35 ? 0x74d8a0 : 0xf07d70, 1).fillRoundedRect(healthX + 2, healthY + 2, (visualW * 0.68 - 4) * hp, 5, 3);
  }

  private drawUnit(unit: UnitInstance, options: ReturnType<BattleSession["getRenderOptions"]>, selection: ReturnType<BattleSession["getSelection"]>, projectiles: BattleState["projectiles"]): void {
    const g = this.graphics;
    const size = getStructureCellSize(unit.radius);
    const xs = unit.structure.map((cell) => cell.x);
    const ys = unit.structure.map((cell) => cell.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const layoutW = (maxX - minX + 1) * size;
    const layoutH = (maxY - minY + 1) * size;
    const at = (x: number, y: number) => ({
      x: unit.x + (((x - minX) * size - layoutW / 2 + size / 2) * unit.facing),
      y: unit.y + (y - minY) * size - layoutH / 2 + size / 2,
    });
    for (const cell of unit.structure) {
      const p = at(cell.x, cell.y);
      const armorColor = color(cell.color);
      const left = p.x - size / 2;
      const top = p.y - size / 2;
      g.fillStyle(0x02070b, cell.destroyed ? 0.2 : 0.82).fillRoundedRect(left, top, size, size, 3);
      g.fillStyle(cell.destroyed ? 0x5b3438 : armorColor, cell.destroyed ? 0.25 : Math.max(0.35, cell.alpha))
        .fillRoundedRect(left + 1.5, top + 1.5, size - 3, size - 3, 2);
      // A single neutral armor-panel texture is shared by every block; cell.color acts as its tint.
      g.lineStyle(1, 0xffffff, cell.destroyed ? 0.08 : 0.24)
        .lineBetween(left + size * 0.17, top + size * 0.2, left + size * 0.83, top + size * 0.2);
      g.lineStyle(1, 0x061018, cell.destroyed ? 0.12 : 0.34)
        .lineBetween(left + size * 0.2, top + size * 0.82, left + size * 0.82, top + size * 0.82)
        .lineBetween(left + size * 0.82, top + size * 0.2, left + size * 0.82, top + size * 0.82);
      g.fillStyle(cell.destroyed ? 0x5b3438 : armorColor, cell.destroyed ? 0.18 : 0.72)
        .fillCircle(left + size * 0.17, top + size * 0.17, Math.max(1, size * 0.055))
        .fillCircle(left + size * 0.83, top + size * 0.83, Math.max(1, size * 0.055));
      g.lineStyle(1, cell.destroyed ? 0xa05e5e : unit.side === "player" ? 0x78bfff : 0xff8178, cell.destroyed ? 0.55 : 0.34)
        .strokeRoundedRect(left, top, size, size, 3);
      if (!cell.destroyed) {
        g.fillStyle(0x07121a, 0.34)
          .fillCircle(left + size * 0.83, top + size * 0.17, Math.max(1, size * 0.055))
          .fillCircle(left + size * 0.17, top + size * 0.83, Math.max(1, size * 0.055));
      }
      if (options.debugPartHp && !cell.destroyed) {
        const damage = Math.min(1, cell.strain / Math.max(1, cell.breakThreshold));
        if (damage > 0) g.fillStyle(0xe83a3a, Math.min(0.8, 0.12 + damage * 0.72)).fillRect(p.x - size / 2 + 1, p.y - size / 2 + 1, size - 2, size - 2);
      }
    }
    const template = this.templates.find((candidate) => candidate.id === unit.templateId);
    const paintPalettes = [
      { primary: 0x39b8a5, secondary: 0xd7fff6, glass: 0x7fdcff },
      { primary: 0x647d9e, secondary: 0xe5b95c, glass: 0x8fc9ff },
      { primary: 0x4e82c4, secondary: 0xe9f3ff, glass: 0x74e6ff },
      { primary: 0x8b68b8, secondary: 0xf0c56b, glass: 0x9eeaff },
      { primary: 0xb85f55, secondary: 0xf1d58a, glass: 0x7fdfff },
      { primary: 0x477b69, secondary: 0xe8e1b5, glass: 0x7ce5ca },
    ];
    const palette = paintPalettes[Math.abs(unit.templateId - 1) % paintPalettes.length];
    for (const item of template?.display ?? []) {
      const cell = unit.structure.find((candidate) => candidate.id === item.cell);
      if (!cell || cell.destroyed) continue;
      const p = at(item.x ?? cell.x, item.y ?? cell.y);
      if (item.kind === "panel") {
        g.fillStyle(palette.primary, unit.side === "player" ? 0.82 : 0.62).fillRoundedRect(p.x - size * 0.41, p.y - size * 0.41, size * 0.82, size * 0.82, 2);
        g.lineStyle(1, palette.secondary, 0.42).strokeRoundedRect(p.x - size * 0.34, p.y - size * 0.34, size * 0.68, size * 0.68, 1);
      } else if (item.kind === "stripe") {
        g.fillStyle(palette.secondary, 0.88).fillRect(p.x - size * 0.42, p.y - size * 0.12, size * 0.84, size * 0.24);
      } else {
        g.fillStyle(palette.glass, 0.62).fillCircle(p.x, p.y, size * 0.28);
        g.lineStyle(1, 0xeaffff, 0.72).strokeCircle(p.x - size * 0.06, p.y - size * 0.06, size * 0.18);
      }
    }
    for (const cell of unit.structure) {
      if (cell.destroyed) continue;
      const p = at(cell.x, cell.y);
      this.drawCellDamage(unit, cell, p.x, p.y, size);
    }
    this.drawUnitAffiliationBorder(unit, size, at);
    for (const part of unit.attachments) {
      if (!part.alive) continue;
      const p = at(part.x, part.y);
      const type = COMPONENTS[part.component].type;
      const weaponVisual = type === "weapon" ? this.battle.getWeaponVisualState(unit, part.id) : null;
      const muzzleFlash = weaponVisual ? projectiles.some((projectile) => projectile.sourceId === unit.id && projectile.sourceWeaponAttachmentId === part.id && Math.hypot(projectile.x - weaponVisual.muzzleX, projectile.y - weaponVisual.muzzleY) < 55) : false;
      this.drawFunctionalGlyph(g, p.x, p.y, size, part.component, type, unit.facing, weaponVisual, muzzleFlash);
    }
    if (unit.id === selection.playerControlledId) g.lineStyle(2, 0x8de4a9, 1).strokeCircle(unit.x, unit.y, unit.radius + 6);
    if (unit.id === selection.selectedUnitId) g.lineStyle(2, 0xffd37f, 1).strokeCircle(unit.x, unit.y, unit.radius + 3);
    if (options.debugDraw) {
      const hitboxColor = unit.aiDebugShouldEvade ? 0xffcf5c : unit.type === "air" ? 0x78d4ff : 0x8de4a9;
      for (const cell of unit.structure) {
        if (cell.destroyed) continue;
        const p = at(cell.x, cell.y);
        // Keep the debug hitbox inside the cell so it cannot paint over the
        // faction-colored silhouette border drawn on the exact cell edge.
        const inset = Math.max(1.5, size * 0.07);
        g.lineStyle(1.25, hitboxColor, 0.88)
          .strokeRect(p.x - size / 2 + inset, p.y - size / 2 + inset, size - inset * 2, size - inset * 2);
      }
      g.lineStyle(1, hitboxColor, 0.34).strokeCircle(unit.x, unit.y, unit.radius);
      g.lineStyle(1, 0xffffff, 0.35).lineBetween(unit.x, unit.y, unit.x + unit.vx * 0.25, unit.y + unit.vy * 0.25);
    }
  }

  private drawCellDamage(
    unit: UnitInstance,
    cell: UnitInstance["structure"][number],
    x: number,
    y: number,
    size: number,
  ): void {
    const g = this.graphics;
    const hpRatio = Math.max(0, Math.min(1, (cell.breakThreshold - cell.strain) / Math.max(1, cell.breakThreshold)));
    const damage = 1 - hpRatio;
    if (damage < 0.18) return;

    const left = x - size / 2;
    const top = y - size / 2;
    const crackCount = damage >= 0.72 ? 3 : damage >= 0.43 ? 2 : 1;
    const mirror = ((cell.id + unit.templateId) & 1) === 0 ? 1 : -1;
    g.lineStyle(Math.max(1, size * 0.055), 0x11171a, 0.48 + damage * 0.28);
    for (let i = 0; i < crackCount; i += 1) {
      const anchorX = left + size * (0.3 + i * 0.2);
      const anchorY = top + size * (0.24 + ((cell.id + i) % 3) * 0.16);
      const dx = size * (0.1 + i * 0.025) * mirror;
      g.lineBetween(anchorX, anchorY, anchorX + dx, anchorY + size * 0.14)
        .lineBetween(anchorX + dx, anchorY + size * 0.14, anchorX - dx * 0.35, anchorY + size * 0.29);
      if (i > 0) {
        g.lineBetween(anchorX + dx * 0.45, anchorY + size * 0.2, anchorX + dx * 1.4, anchorY + size * 0.24);
      }
    }

    if (hpRatio >= 0.2) return;
    const now = this.time.now / 1000;
    for (let puff = 0; puff < 2; puff += 1) {
      const phase = (now * 0.42 + puff * 0.47 + (cell.id % 7) * 0.11) % 1;
      const drift = (((cell.id * 13 + puff * 5) % 9) - 4) * size * 0.018;
      const puffX = Math.round(x + drift + Math.sin(phase * Math.PI * 2) * size * 0.045);
      const puffY = Math.round(top - phase * size * 0.72);
      const puffSize = Math.max(2, Math.round(size * (0.12 + phase * 0.055)));
      const shade = puff === 0 ? 0x343b3d : 0x515858;
      g.fillStyle(shade, (1 - phase) * 0.3)
        .fillRect(puffX - puffSize / 2, puffY - puffSize / 2, puffSize, puffSize)
        .fillRect(puffX + puffSize * 0.35, puffY - puffSize * 0.25, puffSize * 0.7, puffSize * 0.7);
    }
  }

  private drawBlockExplosion(effect: BattleState["blockExplosions"][number]): void {
    const g = this.graphics;
    const t = Math.max(0, Math.min(1, effect.age / Math.max(0.001, effect.life)));
    const fade = 1 - t;
    const pixel = Math.max(2, Math.round(effect.size * 0.13));
    const extent = effect.size * (0.18 + t * 0.78);
    const hot = t < 0.28 ? 0xfff0a8 : 0xf29a55;
    const warm = t < 0.62 ? 0xe9653f : color(effect.color);

    if (t < 0.34) {
      const core = Math.max(pixel, Math.round(effect.size * (0.28 - t * 0.18)));
      g.fillStyle(0xffd06b, 0.68 * fade).fillRect(effect.x - core / 2, effect.y - core / 2, core, core);
    }

    const count = effect.variant === 2 ? 8 : 6;
    const angleOffset = ((effect.seed % 628) / 100) + (effect.variant === 1 ? Math.PI / 4 : 0);
    for (let i = 0; i < count; i += 1) {
      let angle = angleOffset + (i / count) * Math.PI * 2;
      if (effect.variant === 1) angle += (i % 2 === 0 ? -1 : 1) * 0.16;
      const distanceScale = effect.variant === 0
        ? (i % 2 === 0 ? 1 : 0.62)
        : effect.variant === 1
        ? (0.55 + ((i * 7 + effect.seed) % 5) * 0.11)
        : 0.82;
      const distance = extent * distanceScale;
      const px = Math.round(effect.x + Math.cos(angle) * distance);
      const py = Math.round(effect.y + Math.sin(angle) * distance);
      const shard = Math.max(2, pixel - (effect.variant === 2 && i % 2 ? 1 : 0));
      g.fillStyle(i % 3 === 0 ? hot : warm, fade * (effect.variant === 2 ? 0.72 : 0.84))
        .fillRect(px - shard / 2, py - shard / 2, shard, shard);
    }

    if (effect.variant === 0 && t < 0.45) {
      const arm = Math.max(pixel, Math.round(effect.size * 0.24 * (1 - t)));
      g.fillStyle(0xffe49a, fade * 0.48)
        .fillRect(effect.x - arm - pixel / 2, effect.y - pixel / 2, arm * 2 + pixel, pixel)
        .fillRect(effect.x - pixel / 2, effect.y - arm - pixel / 2, pixel, arm * 2 + pixel);
    } else if (effect.variant === 2 && t > 0.12 && t < 0.68) {
      const ring = Math.max(pixel * 2, Math.round(extent * 0.72));
      g.lineStyle(pixel, 0xe97845, fade * 0.24).strokeRect(effect.x - ring / 2, effect.y - ring / 2, ring, ring);
    }
  }

  private drawUnitAffiliationBorder(
    unit: UnitInstance,
    size: number,
    at: (x: number, y: number) => { x: number; y: number },
  ): void {
    if (!unit.alive || unit.groundWreckTimerS !== null) return;
    const g = this.graphics;
    const borderColor = unit.side === "player" ? 0x63b5ff : 0xff7068;
    const aliveCells = unit.structure.filter((cell) => !cell.destroyed);
    const occupied = new Set(aliveCells.map((cell) => `${cell.x},${cell.y}`));
    const drawEdge = (x1: number, y1: number, x2: number, y2: number): void => {
      g.lineStyle(Math.max(2.5, size * 0.18), borderColor, 0.13).lineBetween(x1, y1, x2, y2);
      g.lineStyle(Math.max(1, size * 0.065), borderColor, 0.78).lineBetween(x1, y1, x2, y2);
    };

    for (const cell of aliveCells) {
      const p = at(cell.x, cell.y);
      const half = size / 2;
      if (!occupied.has(`${cell.x - 1},${cell.y}`)) {
        const edgeX = p.x - half * unit.facing;
        drawEdge(edgeX, p.y - half, edgeX, p.y + half);
      }
      if (!occupied.has(`${cell.x + 1},${cell.y}`)) {
        const edgeX = p.x + half * unit.facing;
        drawEdge(edgeX, p.y - half, edgeX, p.y + half);
      }
      if (!occupied.has(`${cell.x},${cell.y - 1}`)) {
        drawEdge(p.x - half, p.y - half, p.x + half, p.y - half);
      }
      if (!occupied.has(`${cell.x},${cell.y + 1}`)) {
        drawEdge(p.x - half, p.y + half, p.x + half, p.y + half);
      }
    }
  }

  private drawFunctionalGlyph(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    size: number,
    component: UnitInstance["attachments"][number]["component"],
    type: string,
    facing: 1 | -1,
    weaponVisual: ReturnType<BattleSession["getWeaponVisualState"]> = null,
    muzzleFlash = false,
  ): void {
    const scale = size / 14;
    if (type === "control") {
      g.fillStyle(0x86d9ff, 0.95).fillCircle(x, y, 4.2 * scale);
      g.lineStyle(1.2, 0xe4f8ff, 0.9).strokeCircle(x, y, 3 * scale).lineBetween(x - 2 * scale, y, x + 2 * scale, y).lineBetween(x, y - 2 * scale, x, y + 2 * scale);
      return;
    }
    if (type === "engine") {
      g.fillStyle(0x74d9a3, 0.92).fillRoundedRect(x - 4 * scale, y - 3.5 * scale, 8 * scale, 7 * scale, 2 * scale);
      g.lineStyle(1.3, 0xd9ffe7, 0.9).lineBetween(x - 2 * facing * scale, y - 2 * scale, x + 2 * facing * scale, y).lineBetween(x + 2 * facing * scale, y, x - 2 * facing * scale, y + 2 * scale);
      g.fillStyle(0x73cfff, 0.65).fillTriangle(x - 4 * facing * scale, y - 2 * scale, x - 7 * facing * scale, y, x - 4 * facing * scale, y + 2 * scale);
      return;
    }
    if (type === "loader") {
      g.fillStyle(0xf0c66f, 0.92).fillRoundedRect(x - 4 * scale, y - 4 * scale, 8 * scale, 8 * scale, 1.5 * scale);
      g.fillStyle(0x4b3e25, 0.85).fillRect(x - 2.8 * scale, y - 2.5 * scale, 5.6 * scale, 1.2 * scale).fillRect(x - 2.8 * scale, y + 0.4 * scale, 5.6 * scale, 1.2 * scale);
      return;
    }
    const direction = facing;
    if (weaponVisual) {
      const barrelColor = component === "explosiveShell" ? 0xf0a26f : component === "precisionBeam" ? 0x9beeff : 0xd9b29c;
      const ux = Math.cos(weaponVisual.angleRad);
      const uy = Math.sin(weaponVisual.angleRad);
      // The functional attachment position is the gun's fixed visual pivot. The
      // simulation firepoint uses a smaller physics-cell coordinate system, so
      // deriving the pivot from it makes the barrel orbit around the craft as it
      // aims instead of rotating in place around the gun center.
      const baseX = x;
      const baseY = y;
      const muzzleX = weaponVisual.muzzleX;
      const muzzleY = weaponVisual.muzzleY;
      g.fillStyle(0x101820, 0.98).fillCircle(baseX, baseY, 5.4 * scale);
      g.lineStyle(6 * scale, 0x101820, 1).lineBetween(baseX, baseY, muzzleX, muzzleY);
      g.lineStyle(2.5 * scale, barrelColor, 0.98).lineBetween(baseX, baseY, muzzleX, muzzleY);
      g.fillStyle(barrelColor, 0.96).fillCircle(baseX, baseY, 3.45 * scale);
      g.lineStyle(1, 0xffffff, 0.42).strokeCircle(baseX - 0.7 * scale, baseY - 0.7 * scale, 2.2 * scale);
      g.fillStyle(0xeafaff, 0.65).fillCircle(muzzleX, muzzleY, 1.4 * scale);
      if (muzzleFlash) {
        g.fillStyle(0xffd98a, 0.22).fillCircle(muzzleX, muzzleY, 10 * scale);
        g.fillStyle(0xfff1bd, 0.95).fillTriangle(muzzleX, muzzleY, muzzleX + ux * 10 * scale - uy * 4 * scale, muzzleY + uy * 10 * scale + ux * 4 * scale, muzzleX + ux * 10 * scale + uy * 4 * scale, muzzleY + uy * 10 * scale - ux * 4 * scale);
      }
      if (component === "trackingMissile") {
        const px = -uy * 3.1 * scale;
        const py = ux * 3.1 * scale;
        g.lineStyle(2.2 * scale, 0xf4a77d, 0.95)
          .lineBetween(baseX + px, baseY + py, muzzleX + px, muzzleY + py)
          .lineBetween(baseX - px, baseY - py, muzzleX - px, muzzleY - py);
      }
      return;
    }
    if (component === "trackingMissile") {
      g.fillStyle(0xf4a77d, 0.95).fillTriangle(x + 5 * direction * scale, y - 2.5 * scale, x - 4 * direction * scale, y - 3 * scale, x - 1 * direction * scale, y).fillTriangle(x + 5 * direction * scale, y + 2.5 * scale, x - 4 * direction * scale, y + 3 * scale, x - 1 * direction * scale, y);
    } else if (component === "precisionBeam") {
      g.fillStyle(0x9beeff, 0.95).fillCircle(x, y, 3.5 * scale);
      g.lineStyle(1.8, 0xe3fbff, 0.9).strokeCircle(x, y, 2.3 * scale).lineBetween(x, y, x + 7 * direction * scale, y);
    } else if (component === "heavyCannon" || component === "explosiveShell") {
      g.fillStyle(component === "explosiveShell" ? 0xff9b68 : 0xdca68d, 0.96).fillCircle(x, y, 3.6 * scale).fillRect(direction > 0 ? x : x - 8 * scale, y - 1.8 * scale, 8 * scale, 3.6 * scale);
    } else {
      g.fillStyle(0xf0b39f, 0.96).fillRoundedRect(x - 3 * scale, y - 3 * scale, 6 * scale, 6 * scale, 2 * scale);
      g.lineStyle(1.2, 0xffdfd3, 0.9).lineBetween(x, y - 1.5 * scale, x + 7 * direction * scale, y - 1.5 * scale).lineBetween(x, y + 1.5 * scale, x + 7 * direction * scale, y + 1.5 * scale);
    }
  }

  private getRawAudioContext(): AudioContext | null {
    const context = (this.sound as unknown as { context?: AudioContext }).context;
    return context ?? null;
  }

  private readonly unlockAudioOnGesture = (): void => {
    const context = this.getRawAudioContext();
    if (!context || context.state === "running" || context.state === "closed" || this.audioResumePending) return;
    this.audioResumePending = true;
    void context.resume().finally(() => {
      this.audioResumePending = false;
    });
  };

  private getAudioContext(): AudioContext | null {
    const context = this.getRawAudioContext();
    return context?.state === "running" ? context : null;
  }

  private createSpatialBus(
    context: AudioContext,
    worldX: number,
    volume: number,
    muffleWithDistance = false,
  ): GainNode {
    const view = this.getViewAudioContext();
    const halfWidth = Math.max(1, view.worldWidth * 0.5);
    const relative = (worldX - view.centerX) / halfWidth;
    const pan = Math.max(
      -BATTLE_SPATIAL_AUDIO_CONFIG.maxPan,
      Math.min(BATTLE_SPATIAL_AUDIO_CONFIG.maxPan, relative),
    );
    const attenuation = 1 / (
      1
      + Math.max(0, Math.abs(relative) - BATTLE_SPATIAL_AUDIO_CONFIG.attenuationStart)
      * BATTLE_SPATIAL_AUDIO_CONFIG.attenuationFactor
    );
    const input = context.createGain();
    const soundVolume = Math.max(MIN_BATTLE_SOUND_VOLUME, Math.min(MAX_BATTLE_SOUND_VOLUME, this.getSoundVolume()));
    input.gain.value = volume * soundVolume * attenuation;
    let output: AudioNode = input;
    if (muffleWithDistance) {
      // Air and terrain absorb the crisp upper frequencies first. Keep shots near
      // the listener unchanged, then roll the cutoff down smoothly past the
      // middle of the visible battlefield and for off-screen fire.
      const distanceMuffle = Math.max(
        0,
        Math.min(
          1,
          (Math.abs(relative) - BATTLE_SPATIAL_AUDIO_CONFIG.muffleStart) / BATTLE_SPATIAL_AUDIO_CONFIG.muffleSpan,
        ),
      );
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = BATTLE_SPATIAL_AUDIO_CONFIG.lowpassNearHz * Math.pow(
        BATTLE_SPATIAL_AUDIO_CONFIG.lowpassFarHz / BATTLE_SPATIAL_AUDIO_CONFIG.lowpassNearHz,
        distanceMuffle,
      );
      lowpass.Q.value = BATTLE_SPATIAL_AUDIO_CONFIG.lowpassQ;
      input.connect(lowpass);
      output = lowpass;
    }
    if (typeof context.createStereoPanner === "function") {
      const panner = context.createStereoPanner();
      panner.pan.value = pan;
      output.connect(panner).connect(context.destination);
    } else {
      output.connect(context.destination);
    }
    return input;
  }

  private playSpatialSample(
    group: string,
    keys: readonly BattleSampleKey[],
    worldX: number,
    volume: number,
    baseRate = 1,
    muffleWithDistance = false,
  ): boolean {
    const available = keys.filter((key) => this.cache.audio.exists(key));
    if (available.length <= 0) return false;
    const previous = this.lastSampleByGroup.get(group);
    const choices = available.length > 1 ? available.filter((key) => key !== previous) : available;
    const key = choices[Math.floor(Math.random() * choices.length)] ?? available[0];
    if (!key) return false;
    this.lastSampleByGroup.set(group, key);

    const view = this.getViewAudioContext();
    const halfWidth = Math.max(1, view.worldWidth * 0.5);
    const relative = (worldX - view.centerX) / halfWidth;
    const pan = Math.max(
      -BATTLE_SPATIAL_AUDIO_CONFIG.maxPan,
      Math.min(BATTLE_SPATIAL_AUDIO_CONFIG.maxPan, relative),
    );
    const attenuation = 1 / (
      1
      + Math.max(0, Math.abs(relative) - BATTLE_SPATIAL_AUDIO_CONFIG.attenuationStart)
      * BATTLE_SPATIAL_AUDIO_CONFIG.attenuationFactor
    );
    const soundVolume = Math.max(MIN_BATTLE_SOUND_VOLUME, Math.min(MAX_BATTLE_SOUND_VOLUME, this.getSoundVolume()));
    const adjustedVolume = Math.max(0, Math.min(1, volume * soundVolume * attenuation));
    const sampleConfig = BATTLE_SYNTH_AUDIO_CONFIG.samplePlayback;
    const rate = Math.max(
      sampleConfig.minRate,
      Math.min(sampleConfig.maxRate, baseRate * (sampleConfig.jitterBase + Math.random() * sampleConfig.jitterRange)),
    );
    if (muffleWithDistance) {
      const context = this.getAudioContext();
      const buffer = this.cache.audio.get(key) as AudioBuffer | undefined;
      if (context && buffer) {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.connect(this.createSpatialBus(context, worldX, volume, true));
        source.start();
        return true;
      }
    }
    return this.sound.play(key, { volume: adjustedVolume, pan, rate });
  }

  private getNoiseBuffer(context: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === context.sampleRate) return this.noiseBuffer;
    const noiseConfig = BATTLE_SYNTH_AUDIO_CONFIG.noiseBuffer;
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * noiseConfig.durationSeconds), context.sampleRate);
    const channel = buffer.getChannelData(0);
    let prior = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const white = Math.random() * 2 - 1;
      prior = prior * noiseConfig.priorMix + white * noiseConfig.whiteMix;
      channel[i] = prior;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  private playBattleEvent(event: BattleAudioEvent): void {
    if (event.kind === "fire") this.playFire(event);
    else if (event.kind === "explosion") this.playExplosion(event);
    else this.playImpact(event);
  }

  private playFire(event: Extract<BattleAudioEvent, { kind: "fire" }>): void {
    const context = this.getAudioContext();
    if (!context) return;
    const fireConfig = BATTLE_SYNTH_AUDIO_CONFIG.fire;
    const partVolume = Math.max(0, Math.min(fireConfig.partMaxVolume, event.volume));
    if (partVolume <= 0) return;
    const strength = Math.max(0, Math.min(1, event.damage / fireConfig.strengthDamageScale));
    const fireSoundPool = event.fireSoundPool;
    const samplePlayed = this.playSpatialSample(
      `fire:${fireSoundPool}`,
      FIRE_SAMPLE_KEYS[fireSoundPool],
      event.x,
      (fireConfig.sampleBaseVolume + strength * fireConfig.sampleStrengthVolume) * partVolume,
      FIRE_SAMPLE_RATE[fireSoundPool],
      true,
    );
    if (samplePlayed) {
      if (fireSoundPool === "heavy-shot") this.playCannonRecoilTail(context, event.x, strength);
      return;
    }
    const profiles = fireConfig.profiles as Record<FireSoundPool, { frequency: number; duration: number; wave: OscillatorType; noise: number }>;
    const profile = profiles[fireSoundPool];
    const bus = this.createSpatialBus(
      context,
      event.x,
      (fireConfig.fallbackBaseVolume + strength * fireConfig.fallbackStrengthVolume) * partVolume,
      true,
    );
    const oscillator = context.createOscillator();
    const toneGain = context.createGain();
    oscillator.type = profile.wave;
    oscillator.frequency.setValueAtTime(
      profile.frequency + Math.min(fireConfig.projectileFrequencyMax, event.projectileSpeed * fireConfig.projectileFrequencyScale),
      context.currentTime,
    );
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(fireConfig.endingFrequencyMin, profile.frequency * fireConfig.endingFrequencyRatio),
      context.currentTime + profile.duration,
    );
    toneGain.gain.setValueAtTime(fireConfig.envelopeStart, context.currentTime);
    toneGain.gain.exponentialRampToValueAtTime(BATTLE_SYNTH_AUDIO_CONFIG.envelopeFloor, context.currentTime + profile.duration);
    oscillator.connect(toneGain).connect(bus);
    oscillator.start();
    oscillator.stop(context.currentTime + profile.duration);

    const noise = context.createBufferSource();
    noise.buffer = this.getNoiseBuffer(context);
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = fireSoundPool === "rapid-fire" ? "highpass" : "bandpass";
    noiseFilter.frequency.value = fireSoundPool === "rapid-fire"
      ? fireConfig.rapidNoiseFilterHz
      : fireConfig.otherNoiseFilterHz;
    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(profile.noise, context.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(BATTLE_SYNTH_AUDIO_CONFIG.envelopeFloor, context.currentTime + profile.duration);
    noise.connect(noiseFilter).connect(noiseGain).connect(bus);
    noise.start();
    noise.stop(context.currentTime + profile.duration);
  }

  private playCannonRecoilTail(context: AudioContext, worldX: number, strength: number): void {
    const tailConfig = BATTLE_SYNTH_AUDIO_CONFIG.cannonTail;
    const duration = tailConfig.baseDuration + strength * tailConfig.strengthDuration;
    const bus = this.createSpatialBus(context, worldX, tailConfig.baseVolume + strength * tailConfig.strengthVolume, true);
    const boom = context.createOscillator();
    const gain = context.createGain();
    boom.type = "sine";
    boom.frequency.setValueAtTime(tailConfig.startFrequency, context.currentTime);
    boom.frequency.exponentialRampToValueAtTime(tailConfig.endFrequency, context.currentTime + duration);
    gain.gain.setValueAtTime(tailConfig.envelopeStart, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(BATTLE_SYNTH_AUDIO_CONFIG.envelopeFloor, context.currentTime + duration);
    boom.connect(gain).connect(bus);
    boom.start();
    boom.stop(context.currentTime + duration);
  }

  private playImpact(event: Extract<BattleAudioEvent, { kind: "impact" }>): void {
    const context = this.getAudioContext();
    if (!context) return;
    const damage = Math.max(0, event.deliveredDamage);
    const impactConfig = BATTLE_SYNTH_AUDIO_CONFIG.impact;
    const severity = Math.max(0, Math.min(1, damage / impactConfig.severityDamageScale));
    const material = materialAcoustics(event.materialColor);
    const heavyImpact = event.impactSoundPool === "heavy-shot" || event.impactSoundPool === "explosive" || event.impactSoundPool === "tracking";
    const impactKeys = (heavyImpact ? impactConfig.heavySamples : impactConfig.lightSamples) as readonly BattleSampleKey[];
    const impactVolume = heavyImpact
      ? impactConfig.heavyBaseVolume + severity * impactConfig.heavySeverityVolume
      : impactConfig.lightBaseVolume + severity * impactConfig.lightSeverityVolume;
    if (this.playSpatialSample(
      heavyImpact ? "impact:heavy" : "impact:light",
      impactKeys,
      event.x,
      impactVolume,
      material.resonance,
    )) return;
    const duration = impactConfig.baseDuration + severity * impactConfig.severityDuration;
    const volume = impactConfig.baseVolume + severity * impactConfig.severityVolume;
    const bus = this.createSpatialBus(context, event.x, volume);
    const oscillator = context.createOscillator();
    const tone = impactConfig.profiles as Record<FireSoundPool, { frequency: number; wave: OscillatorType; noise: number }>;
    const profile = tone[event.impactSoundPool];
    oscillator.type = profile.wave;
    oscillator.frequency.setValueAtTime(
      (profile.frequency + event.armor * impactConfig.armorFrequencyScale) * material.resonance,
      context.currentTime,
    );
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(impactConfig.endingFrequencyMin, profile.frequency * impactConfig.endingFrequencyRatio),
      context.currentTime + duration,
    );
    const distortion = context.createWaveShaper();
    const amount = 4 + severity * 75;
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i += 1) {
      const x = i * 2 / (curve.length - 1) - 1;
      curve[i] = ((3 + amount) * x * 20 * Math.PI / 180) / (Math.PI + amount * Math.abs(x));
    }
    distortion.curve = curve;
    const toneGain = context.createGain();
    toneGain.gain.setValueAtTime(impactConfig.envelopeStart, context.currentTime);
    toneGain.gain.exponentialRampToValueAtTime(BATTLE_SYNTH_AUDIO_CONFIG.envelopeFloor, context.currentTime + duration);
    oscillator.connect(distortion).connect(toneGain).connect(bus);
    oscillator.start();
    oscillator.stop(context.currentTime + duration);

    const noise = context.createBufferSource();
    noise.buffer = this.getNoiseBuffer(context);
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = event.impactSoundPool === "beam-precision" ? "highpass" : "bandpass";
    noiseFilter.frequency.value = (event.impactSoundPool === "rapid-fire" ? 2100 : 650 + severity * 900) * material.resonance;
    noiseFilter.Q.value = Math.max(0.25, (1.8 - severity) / material.roughness);
    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(profile.noise * material.roughness * (0.018 + severity * 0.14), context.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(BATTLE_SYNTH_AUDIO_CONFIG.envelopeFloor, context.currentTime + duration * 1.25);
    noise.connect(noiseFilter).connect(noiseGain).connect(bus);
    noise.start();
    noise.stop(context.currentTime + duration * 1.3);
  }

  private playExplosion(event: Extract<BattleAudioEvent, { kind: "explosion" }>): void {
    const context = this.getAudioContext();
    if (!context) return;
    const explosionConfig = BATTLE_SYNTH_AUDIO_CONFIG.explosion;
    const severity = Math.max(explosionConfig.minimumSeverity, Math.min(1, event.intensity / explosionConfig.intensityScale));
    const duration = explosionConfig.baseDuration + severity * explosionConfig.severityDuration;
    const bus = this.createSpatialBus(context, event.x, explosionConfig.baseVolume + severity * explosionConfig.severityVolume);
    const noise = context.createBufferSource();
    noise.buffer = this.getNoiseBuffer(context);
    const lowpass = context.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(
      explosionConfig.lowpassBaseFrequency + severity * explosionConfig.lowpassSeverityFrequency,
      context.currentTime,
    );
    lowpass.frequency.exponentialRampToValueAtTime(explosionConfig.lowpassEndFrequency, context.currentTime + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(explosionConfig.envelopeStart, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(BATTLE_SYNTH_AUDIO_CONFIG.envelopeFloor, context.currentTime + duration);
    noise.connect(lowpass).connect(gain).connect(bus);
    noise.start();
    noise.stop(context.currentTime + duration);
    const boom = context.createOscillator();
    boom.type = "sine";
    boom.frequency.setValueAtTime(explosionConfig.boomStartFrequency, context.currentTime);
    boom.frequency.exponentialRampToValueAtTime(explosionConfig.boomEndFrequency, context.currentTime + duration);
    boom.connect(bus);
    boom.start();
    boom.stop(context.currentTime + duration);
  }

  private playSpawn(unit: UnitInstance): void {
    const context = this.getAudioContext();
    if (!context) return;
    const spawnConfig = BATTLE_SYNTH_AUDIO_CONFIG.spawn;
    const bus = this.createSpatialBus(context, unit.x, spawnConfig.volume);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = unit.type === "air" ? "sine" : "triangle";
    const start = unit.side === "player" ? spawnConfig.playerStartFrequency : spawnConfig.enemyStartFrequency;
    oscillator.frequency.setValueAtTime(start, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      unit.type === "air" ? spawnConfig.airEndFrequency : spawnConfig.groundEndFrequency,
      context.currentTime + spawnConfig.rampDuration,
    );
    gain.gain.setValueAtTime(spawnConfig.envelopeStart, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(BATTLE_SYNTH_AUDIO_CONFIG.envelopeFloor, context.currentTime + spawnConfig.envelopeDuration);
    oscillator.connect(gain).connect(bus);
    oscillator.start();
    oscillator.stop(context.currentTime + spawnConfig.stopDuration);
  }

  private playEnginePulse(unit: UnitInstance, speed: number): void {
    const context = this.getAudioContext();
    if (!context) return;
    const speedRatio = Math.max(0, Math.min(1, speed / Math.max(1, unit.maxSpeed)));
    const engineConfig = BATTLE_SYNTH_AUDIO_CONFIG.engine;
    const bus = this.createSpatialBus(context, unit.x, engineConfig.baseVolume + speedRatio * engineConfig.speedVolume);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = unit.type === "air" ? "sawtooth" : "square";
    oscillator.frequency.value = unit.type === "air"
      ? engineConfig.airBaseFrequency + speedRatio * engineConfig.airSpeedFrequency
      : engineConfig.groundBaseFrequency + speedRatio * engineConfig.groundSpeedFrequency;
    gain.gain.setValueAtTime(engineConfig.envelopeStart, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(BATTLE_SYNTH_AUDIO_CONFIG.envelopeFloor, context.currentTime + engineConfig.envelopeDuration);
    oscillator.connect(gain).connect(bus);
    oscillator.start();
    oscillator.stop(context.currentTime + engineConfig.stopDuration);
  }

  private updateUnitAudio(state: BattleState): void {
    const engineConfig = BATTLE_SYNTH_AUDIO_CONFIG.engine;
    const now = this.time.now / 1000;
    const aliveIds = new Set(state.units.filter((unit) => unit.alive).map((unit) => unit.id));
    for (const unit of state.units) {
      if (!unit.alive) continue;
      if (!this.knownUnitIds.has(unit.id)) {
        this.knownUnitIds.add(unit.id);
        this.playSpawn(unit);
      }
    }
    for (const id of this.knownUnitIds) if (!aliveIds.has(id)) this.knownUnitIds.delete(id);
    const moving = state.units
      .map((unit) => ({ unit, speed: Math.hypot(unit.vx, unit.vy) }))
      .filter((entry) => entry.unit.alive && entry.speed > engineConfig.minimumMovingSpeed)
      .sort((a, b) => Math.abs(a.unit.x - this.getViewAudioContext().centerX) - Math.abs(b.unit.x - this.getViewAudioContext().centerX))
      .slice(0, engineConfig.maxAudibleUnits);
    for (const entry of moving) {
      if ((this.nextEnginePulseByUnitId.get(entry.unit.id) ?? 0) > now) continue;
      this.nextEnginePulseByUnitId.set(
        entry.unit.id,
        now
          + engineConfig.basePulseInterval
          + (1 - Math.min(1, entry.speed / Math.max(1, entry.unit.maxSpeed))) * engineConfig.speedPulseInterval,
      );
      this.playEnginePulse(entry.unit, entry.speed);
    }
  }
}

export class PhaserBattleRenderer {
  public readonly game: Phaser.Game;
  private readonly scene: BattleScene;

  public constructor(
    canvas: HTMLCanvasElement,
    battle: BattleSession,
    templates: ReadonlyArray<UnitTemplate>,
    getViewAudioContext: () => BattleViewAudioContext,
    getSoundVolume: () => number,
  ) {
    const resolutionScale = Math.max(0.1, BATTLE_CANVAS_RESOLUTION_SCALE);
    const cssWidth = Math.max(1, canvas.clientWidth || canvas.width);
    const cssHeight = Math.max(1, canvas.clientHeight || canvas.height);
    this.scene = new BattleScene(battle, templates, getViewAudioContext, getSoundVolume, resolutionScale);
    this.game = new Phaser.Game({
      type: Phaser.CANVAS,
      canvas,
      width: Math.max(1, Math.floor(cssWidth * resolutionScale)),
      height: Math.max(1, Math.floor(cssHeight * resolutionScale)),
      backgroundColor: "#09111d",
      transparent: false,
      banner: false,
      audio: { disableWebAudio: false },
      scene: [this.scene],
      render: { antialias: true, roundPixels: false },
    });
  }

  public resizeViewport(width: number, height: number): void {
    const normalizedWidth = Math.max(1, Math.floor(width));
    const normalizedHeight = Math.max(1, Math.floor(height));
    const resolutionScale = Math.max(0.1, BATTLE_CANVAS_RESOLUTION_SCALE);
    this.game.scale.resize(
      Math.max(1, Math.floor(normalizedWidth * resolutionScale)),
      Math.max(1, Math.floor(normalizedHeight * resolutionScale)),
    );
    this.game.canvas.style.width = `${normalizedWidth}px`;
    this.game.canvas.style.height = `${normalizedHeight}px`;
  }

  public setViewTransform(offsetX: number, offsetY: number, scale: number): void {
    this.scene.setViewTransform(offsetX, offsetY, scale);
  }
}
