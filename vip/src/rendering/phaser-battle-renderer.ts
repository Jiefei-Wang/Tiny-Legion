import Phaser from "phaser";
import { COMPONENTS } from "../config/balance/weapons.ts";
import { getStructureCellSize } from "../config/balance/battlefield.ts";
import type { BattleState, UnitInstance, UnitTemplate, WeaponClass } from "../types.ts";
import type { BattleAudioEvent, BattleSession } from "../gameplay/battle/battle-session.ts";

export interface BattleViewAudioContext {
  centerX: number;
  worldWidth: number;
}

export const DEFAULT_BATTLE_SOUND_VOLUME = 3;
export const MIN_BATTLE_SOUND_VOLUME = 0;
export const MAX_BATTLE_SOUND_VOLUME = 5;

const BATTLE_SAMPLE_URLS = {
  "fire-rapid-1": "/assets/audio/battle/fire-rapid-1.mp3",
  "fire-rapid-2": "/assets/audio/battle/fire-rapid-2.mp3",
  "fire-heavy-1": "/assets/audio/battle/fire-heavy-1.mp3",
  "fire-heavy-2": "/assets/audio/battle/fire-heavy-2.mp3",
  "fire-explosive-1": "/assets/audio/battle/fire-explosive-1.mp3",
  "fire-explosive-2": "/assets/audio/battle/fire-explosive-2.mp3",
  "fire-tracking-1": "/assets/audio/battle/fire-tracking-1.mp3",
  "fire-tracking-2": "/assets/audio/battle/fire-tracking-2.mp3",
  "fire-beam-1": "/assets/audio/battle/fire-beam-1.mp3",
  "fire-beam-2": "/assets/audio/battle/fire-beam-2.mp3",
  "impact-light-1": "/assets/audio/battle/impact-light-1.mp3",
  "impact-light-2": "/assets/audio/battle/impact-light-2.mp3",
  "impact-light-3": "/assets/audio/battle/impact-light-3.mp3",
  "impact-light-4": "/assets/audio/battle/impact-light-4.mp3",
  "impact-heavy-1": "/assets/audio/battle/impact-heavy-1.mp3",
  "impact-heavy-2": "/assets/audio/battle/impact-heavy-2.mp3",
} as const;

type BattleSampleKey = keyof typeof BATTLE_SAMPLE_URLS;

const FIRE_SAMPLE_KEYS: Record<WeaponClass, readonly BattleSampleKey[]> = {
  "rapid-fire": ["fire-rapid-1", "fire-rapid-2"],
  "heavy-shot": ["fire-heavy-1", "fire-heavy-2"],
  explosive: ["fire-explosive-1", "fire-explosive-2"],
  tracking: ["fire-tracking-1", "fire-tracking-2"],
  "beam-precision": ["fire-beam-1", "fire-beam-2"],
};

const FIRE_SAMPLE_RATE: Record<WeaponClass, number> = {
  "rapid-fire": 1.12,
  "heavy-shot": 0.96,
  explosive: 0.7,
  tracking: 1,
  "beam-precision": 1.42,
};

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

  public constructor(
    battle: BattleSession,
    templates: ReadonlyArray<UnitTemplate>,
    getViewAudioContext: () => BattleViewAudioContext,
    getSoundVolume: () => number,
  ) {
    super({ key: "battle" });
    this.battle = battle;
    this.templates = templates;
    this.getViewAudioContext = getViewAudioContext;
    this.getSoundVolume = getSoundVolume;
  }

  public preload(): void {
    this.load.image("battle-air-layer", "/assets/campaign/battle-air-layer.webp");
    this.load.image("battle-ground-layer", "/assets/campaign/battle-ground-layer.webp");
    this.load.image("battle-command-base", "/assets/campaign/battle-base.png");
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
    }).setDepth(1000);
    document.addEventListener("pointerdown", this.unlockAudioOnGesture, { capture: true });
    document.addEventListener("keydown", this.unlockAudioOnGesture, { capture: true });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      document.removeEventListener("pointerdown", this.unlockAudioOnGesture, { capture: true });
      document.removeEventListener("keydown", this.unlockAudioOnGesture, { capture: true });
    });
  }

  public update(): void {
    const info = this.battle.getBattlefieldInfo();
    if (this.scale.width !== info.width || this.scale.height !== info.height) {
      this.scale.resize(info.width, info.height);
    }
    this.draw(this.battle.getState());
    // Do not discard transient combat sounds while browser autoplay policy still
    // has Web Audio suspended. The next user gesture unlocks the shared context.
    if (this.getAudioContext()) {
      for (const event of this.battle.consumeBattleAudioEvents()) this.playBattleEvent(event);
    }
    this.updateUnitAudio(this.battle.getState());
  }

  private draw(state: BattleState): void {
    const g = this.graphics;
    const options = this.battle.getRenderOptions();
    const selection = this.battle.getSelection();
    const { width, height, laneBounds } = this.battle.getBattlefieldInfo();
    const groundY = laneBounds.groundMinY;
    this.airBackground.setPosition(0, 0).setDisplaySize(width, groundY);
    this.groundBackground.setPosition(0, groundY).setDisplaySize(width, Math.max(1, height - groundY));
    g.clear();
    g.fillStyle(0x06101a, 0.08).fillRect(0, 0, width, groundY);
    g.fillStyle(0x06130f, 0.08).fillRect(0, groundY, width, height - groundY);
    g.fillStyle(0xb5eff4, 0.14).fillRect(0, groundY - 2, width, 4);
    this.playerBaseSprite.setVisible(false);
    this.enemyBaseSprite.setVisible(false);
    if (!state.active && !state.outcome) {
      this.status.setText("Map/Base Mode\nSelect a map node and launch battle.").setVisible(true);
      return;
    }

    this.drawBase(state.playerBase, 0x5d8bb3);
    this.drawBase(state.enemyBase, 0xb36b63);
    if (options.debugDraw) {
      for (const unit of state.units) {
        if (!unit.alive) continue;
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
    for (const p of state.particles) g.fillStyle(0xf5c07a, Math.min(1, p.life / 0.4)).fillCircle(p.x, p.y, Math.max(1, p.size * (1 - p.life * 0.8)));
    for (const beam of state.beamEffects) {
      const alpha = Math.max(0, Math.min(1, beam.life / beam.maxLife));
      const beamColor = beam.side === "player" ? 0x8ff6ff : 0xff8fa8;
      g.lineStyle(7, beamColor, alpha * 0.18).lineBetween(beam.x1, beam.y1, beam.x2, beam.y2);
      g.lineStyle(2, 0xffffff, alpha * 0.92).lineBetween(beam.x1, beam.y1, beam.x2, beam.y2);
    }
    for (const p of state.projectiles) {
      const projectileColor = p.side === "player" ? 0x9bd5ff : 0xff9d81;
      g.lineStyle(Math.max(1.5, p.r * 0.8), projectileColor, 0.42).lineBetween(p.prevX, p.prevY, p.x, p.y);
      g.fillStyle(projectileColor, 0.18).fillCircle(p.x, p.y, p.r * 3.2);
      g.fillStyle(projectileColor, 1).fillCircle(p.x, p.y, Math.max(1.5, p.r));
      if (options.debugDraw) g.lineStyle(1, 0xffeb96, 0.8).lineBetween(p.prevX, p.prevY, p.x, p.y);
    }
    for (const d of state.debris) g.fillStyle(color(d.color), 1).fillRect(d.x - d.size / 2, d.y - d.size / 2, d.size, d.size);
    for (const unit of state.units) this.drawUnit(unit, options, selection, state.projectiles);

    if (options.debugTargetLines) {
      for (const unit of state.units) {
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
      g.lineStyle(1, cell.destroyed ? 0xa05e5e : unit.side === "player" ? 0x9fdcdf : 0xe2a29a, cell.destroyed ? 0.55 : 0.28)
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
        g.lineStyle(1.25, hitboxColor, 0.88).strokeRect(p.x - size / 2, p.y - size / 2, size, size);
      }
      g.lineStyle(1, hitboxColor, 0.34).strokeCircle(unit.x, unit.y, unit.radius);
      g.lineStyle(1, 0xffffff, 0.35).lineBetween(unit.x, unit.y, unit.x + unit.vx * 0.25, unit.y + unit.vy * 0.25);
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
    const pan = Math.max(-1, Math.min(1, relative));
    const attenuation = 1 / (1 + Math.max(0, Math.abs(relative) - 0.25) * 0.75);
    const input = context.createGain();
    const soundVolume = Math.max(MIN_BATTLE_SOUND_VOLUME, Math.min(MAX_BATTLE_SOUND_VOLUME, this.getSoundVolume()));
    input.gain.value = volume * soundVolume * attenuation;
    let output: AudioNode = input;
    if (muffleWithDistance) {
      // Air and terrain absorb the crisp upper frequencies first. Keep shots near
      // the listener unchanged, then roll the cutoff down smoothly past the
      // middle of the visible battlefield and for off-screen fire.
      const distanceMuffle = Math.max(0, Math.min(1, (Math.abs(relative) - 0.3) / 1.2));
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 18_000 * Math.pow(900 / 18_000, distanceMuffle);
      lowpass.Q.value = 0.7;
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
    const pan = Math.max(-1, Math.min(1, relative));
    const attenuation = 1 / (1 + Math.max(0, Math.abs(relative) - 0.25) * 0.75);
    const soundVolume = Math.max(MIN_BATTLE_SOUND_VOLUME, Math.min(MAX_BATTLE_SOUND_VOLUME, this.getSoundVolume()));
    const adjustedVolume = Math.max(0, Math.min(1, volume * soundVolume * attenuation));
    const rate = Math.max(0.5, Math.min(2, baseRate * (0.96 + Math.random() * 0.08)));
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
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.45), context.sampleRate);
    const channel = buffer.getChannelData(0);
    let prior = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const white = Math.random() * 2 - 1;
      prior = prior * 0.72 + white * 0.28;
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
    const partVolume = Math.max(0, Math.min(2, event.volume));
    if (partVolume <= 0) return;
    const strength = Math.max(0, Math.min(1, event.damage / 80));
    const samplePlayed = this.playSpatialSample(
      `fire:${event.weaponClass}`,
      FIRE_SAMPLE_KEYS[event.weaponClass],
      event.x,
      (0.13 + strength * 0.1) * partVolume,
      FIRE_SAMPLE_RATE[event.weaponClass],
      true,
    );
    if (samplePlayed) {
      if (event.weaponClass === "heavy-shot") this.playCannonRecoilTail(context, event.x, strength);
      return;
    }
    const profiles: Record<WeaponClass, { frequency: number; duration: number; wave: OscillatorType; noise: number }> = {
      "rapid-fire": { frequency: 520, duration: 0.045, wave: "square", noise: 0.24 },
      "heavy-shot": { frequency: 145, duration: 0.16, wave: "sawtooth", noise: 0.5 },
      explosive: { frequency: 105, duration: 0.2, wave: "sawtooth", noise: 0.65 },
      tracking: { frequency: 260, duration: 0.13, wave: "triangle", noise: 0.36 },
      "beam-precision": { frequency: 980, duration: 0.12, wave: "sine", noise: 0.08 },
    };
    const profile = profiles[event.weaponClass];
    const bus = this.createSpatialBus(context, event.x, (0.035 + strength * 0.085) * partVolume, true);
    const oscillator = context.createOscillator();
    const toneGain = context.createGain();
    oscillator.type = profile.wave;
    oscillator.frequency.setValueAtTime(profile.frequency + Math.min(280, event.projectileSpeed * 0.12), context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(45, profile.frequency * 0.38), context.currentTime + profile.duration);
    toneGain.gain.setValueAtTime(0.8, context.currentTime);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + profile.duration);
    oscillator.connect(toneGain).connect(bus);
    oscillator.start();
    oscillator.stop(context.currentTime + profile.duration);

    const noise = context.createBufferSource();
    noise.buffer = this.getNoiseBuffer(context);
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = event.weaponClass === "rapid-fire" ? "highpass" : "bandpass";
    noiseFilter.frequency.value = event.weaponClass === "rapid-fire" ? 1500 : 520;
    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(profile.noise, context.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + profile.duration);
    noise.connect(noiseFilter).connect(noiseGain).connect(bus);
    noise.start();
    noise.stop(context.currentTime + profile.duration);
  }

  private playCannonRecoilTail(context: AudioContext, worldX: number, strength: number): void {
    const duration = 0.34 + strength * 0.12;
    const bus = this.createSpatialBus(context, worldX, 0.045 + strength * 0.055, true);
    const boom = context.createOscillator();
    const gain = context.createGain();
    boom.type = "sine";
    boom.frequency.setValueAtTime(82, context.currentTime);
    boom.frequency.exponentialRampToValueAtTime(31, context.currentTime + duration);
    gain.gain.setValueAtTime(0.85, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    boom.connect(gain).connect(bus);
    boom.start();
    boom.stop(context.currentTime + duration);
  }

  private playImpact(event: Extract<BattleAudioEvent, { kind: "impact" }>): void {
    const context = this.getAudioContext();
    if (!context) return;
    const damage = Math.max(0, event.deliveredDamage);
    const severity = Math.max(0, Math.min(1, damage / 140));
    const material = materialAcoustics(event.materialColor);
    const heavyImpact = event.weaponClass === "heavy-shot" || event.weaponClass === "explosive" || event.weaponClass === "tracking";
    const impactKeys: readonly BattleSampleKey[] = heavyImpact
      ? ["impact-heavy-1", "impact-heavy-2"]
      : ["impact-light-1", "impact-light-2", "impact-light-3", "impact-light-4"];
    const impactVolume = heavyImpact ? 0.12 + severity * 0.16 : 0.075 + severity * 0.1;
    if (this.playSpatialSample(
      heavyImpact ? "impact:heavy" : "impact:light",
      impactKeys,
      event.x,
      impactVolume,
      material.resonance,
    )) return;
    const duration = 0.055 + severity * 0.2;
    const volume = 0.018 + severity * 0.085;
    const bus = this.createSpatialBus(context, event.x, volume);
    const oscillator = context.createOscillator();
    const tone: Record<WeaponClass, { frequency: number; wave: OscillatorType; noise: number }> = {
      "rapid-fire": { frequency: 920, wave: "square", noise: 0.45 },
      "heavy-shot": { frequency: 230, wave: "sawtooth", noise: 0.72 },
      explosive: { frequency: 120, wave: "sawtooth", noise: 1 },
      tracking: { frequency: 330, wave: "triangle", noise: 0.65 },
      "beam-precision": { frequency: 1280, wave: "sine", noise: 0.18 },
    };
    const profile = tone[event.weaponClass];
    oscillator.type = profile.wave;
    oscillator.frequency.setValueAtTime((profile.frequency + event.armor * 2.5) * material.resonance, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(45, profile.frequency * 0.22), context.currentTime + duration);
    const distortion = context.createWaveShaper();
    const amount = 4 + severity * 75;
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i += 1) {
      const x = i * 2 / (curve.length - 1) - 1;
      curve[i] = ((3 + amount) * x * 20 * Math.PI / 180) / (Math.PI + amount * Math.abs(x));
    }
    distortion.curve = curve;
    const toneGain = context.createGain();
    toneGain.gain.setValueAtTime(0.8, context.currentTime);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    oscillator.connect(distortion).connect(toneGain).connect(bus);
    oscillator.start();
    oscillator.stop(context.currentTime + duration);

    const noise = context.createBufferSource();
    noise.buffer = this.getNoiseBuffer(context);
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = event.weaponClass === "beam-precision" ? "highpass" : "bandpass";
    noiseFilter.frequency.value = (event.weaponClass === "rapid-fire" ? 2100 : 650 + severity * 900) * material.resonance;
    noiseFilter.Q.value = Math.max(0.25, (1.8 - severity) / material.roughness);
    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(profile.noise * material.roughness * (0.018 + severity * 0.14), context.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration * 1.25);
    noise.connect(noiseFilter).connect(noiseGain).connect(bus);
    noise.start();
    noise.stop(context.currentTime + duration * 1.3);
  }

  private playExplosion(event: Extract<BattleAudioEvent, { kind: "explosion" }>): void {
    const context = this.getAudioContext();
    if (!context) return;
    const severity = Math.max(0.15, Math.min(1, event.intensity / 180));
    const duration = 0.22 + severity * 0.38;
    const bus = this.createSpatialBus(context, event.x, 0.08 + severity * 0.16);
    const noise = context.createBufferSource();
    noise.buffer = this.getNoiseBuffer(context);
    const lowpass = context.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(1600 + severity * 900, context.currentTime);
    lowpass.frequency.exponentialRampToValueAtTime(90, context.currentTime + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.7, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    noise.connect(lowpass).connect(gain).connect(bus);
    noise.start();
    noise.stop(context.currentTime + duration);
    const boom = context.createOscillator();
    boom.type = "sine";
    boom.frequency.setValueAtTime(95, context.currentTime);
    boom.frequency.exponentialRampToValueAtTime(32, context.currentTime + duration);
    boom.connect(bus);
    boom.start();
    boom.stop(context.currentTime + duration);
  }

  private playSpawn(unit: UnitInstance): void {
    const context = this.getAudioContext();
    if (!context) return;
    const bus = this.createSpatialBus(context, unit.x, 0.038);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = unit.type === "air" ? "sine" : "triangle";
    const start = unit.side === "player" ? 180 : 140;
    oscillator.frequency.setValueAtTime(start, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(unit.type === "air" ? 720 : 410, context.currentTime + 0.18);
    gain.gain.setValueAtTime(0.7, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
    oscillator.connect(gain).connect(bus);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.23);
  }

  private playEnginePulse(unit: UnitInstance, speed: number): void {
    const context = this.getAudioContext();
    if (!context) return;
    const speedRatio = Math.max(0, Math.min(1, speed / Math.max(1, unit.maxSpeed)));
    const bus = this.createSpatialBus(context, unit.x, 0.007 + speedRatio * 0.014);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = unit.type === "air" ? "sawtooth" : "square";
    oscillator.frequency.value = unit.type === "air" ? 72 + speedRatio * 90 : 38 + speedRatio * 42;
    gain.gain.setValueAtTime(0.55, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2);
    oscillator.connect(gain).connect(bus);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.21);
  }

  private updateUnitAudio(state: BattleState): void {
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
      .filter((entry) => entry.unit.alive && entry.speed > 8)
      .sort((a, b) => Math.abs(a.unit.x - this.getViewAudioContext().centerX) - Math.abs(b.unit.x - this.getViewAudioContext().centerX))
      .slice(0, 5);
    for (const entry of moving) {
      if ((this.nextEnginePulseByUnitId.get(entry.unit.id) ?? 0) > now) continue;
      this.nextEnginePulseByUnitId.set(entry.unit.id, now + 0.16 + (1 - Math.min(1, entry.speed / Math.max(1, entry.unit.maxSpeed))) * 0.12);
      this.playEnginePulse(entry.unit, entry.speed);
    }
  }
}

export class PhaserBattleRenderer {
  public readonly game: Phaser.Game;

  public constructor(
    canvas: HTMLCanvasElement,
    battle: BattleSession,
    templates: ReadonlyArray<UnitTemplate>,
    getViewAudioContext: () => BattleViewAudioContext,
    getSoundVolume: () => number,
  ) {
    this.game = new Phaser.Game({
      type: Phaser.CANVAS,
      canvas,
      width: canvas.width,
      height: canvas.height,
      backgroundColor: "#09111d",
      transparent: false,
      banner: false,
      audio: { disableWebAudio: false },
      scene: [new BattleScene(battle, templates, getViewAudioContext, getSoundVolume)],
      render: { antialias: true, roundPixels: false },
    });
  }
}
