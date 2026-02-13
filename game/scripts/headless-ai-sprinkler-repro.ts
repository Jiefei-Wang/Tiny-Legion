import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createBaselineCompositeAiController } from "../src/ai/composite/baseline-modules.ts";
import type { BattleAiController } from "../src/ai/composite/composite-ai.ts";
import { BATTLEFIELD_HEIGHT, BATTLEFIELD_WIDTH } from "../src/config/balance/battlefield.ts";
import { COMPONENTS } from "../src/config/balance/weapons.ts";
import { BattleSession } from "../src/gameplay/battle/battle-session.ts";
import { mergePartCatalogs, parsePartDefinition } from "../src/app/part-store.ts";
import { mergeTemplates, parseTemplate } from "../src/app/template-store.ts";
import { createInitialTemplates, instantiateUnit } from "../src/simulation/units/unit-builder.ts";
import type { BattleHooks } from "../src/gameplay/battle/battle-session.ts";
import type { KeyState, MapNode, PartDefinition, UnitTemplate } from "../src/types.ts";

declare const process: { exit: (code?: number) => void; cwd: () => string };

const dt = 1 / 60;
const idleKeys: KeyState = { a: false, d: false, w: false, s: false, space: false };

function createMockCanvas(width: number, height: number): HTMLCanvasElement {
  const contextStub = {} as CanvasRenderingContext2D;
  return {
    width,
    height,
    getContext: (type: string) => (type === "2d" ? contextStub : null),
  } as unknown as HTMLCanvasElement;
}

function makeHooks(): BattleHooks {
  let gas = 10000;
  return {
    addLog: () => {},
    getCommanderSkill: () => 10,
    getPlayerGas: () => gas,
    spendPlayerGas: (amount: number) => {
      if (gas < amount) {
        return false;
      }
      gas -= amount;
      return true;
    },
    addPlayerGas: (amount: number) => {
      gas += amount;
    },
    onBattleOver: () => {},
  };
}

function readPartDir(dirPath: string): PartDefinition[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
  const parts: PartDefinition[] = [];
  for (const fileName of files) {
    try {
      const filePath = `${dirPath}/${fileName}`;
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const normalized = parsePartDefinition(parsed);
      if (!normalized) {
        continue;
      }
      const normalizedRaw = `${JSON.stringify(normalized, null, 2)}\n`;
      if (raw !== normalizedRaw) {
        writeFileSync(filePath, normalizedRaw, "utf8");
      }
      parts.push(normalized);
    } catch {
      continue;
    }
  }
  return parts;
}

function loadRuntimeMergedParts(): PartDefinition[] {
  const root = process.cwd().replace(/\\/g, "/");
  const defaults = readPartDir(`${root}/parts/default`);
  const users = readPartDir(`${root}/parts/user`);
  return mergePartCatalogs(defaults, users);
}

function readTemplateDir(dirPath: string, partCatalog: ReadonlyArray<PartDefinition>): UnitTemplate[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
  const templates: UnitTemplate[] = [];
  for (const fileName of files) {
    try {
      const filePath = `${dirPath}/${fileName}`;
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const normalized = parseTemplate(parsed, { injectLoaders: true, sanitizePlacement: true, partCatalog });
      if (!normalized) {
        continue;
      }
      const normalizedRaw = `${JSON.stringify(normalized, null, 2)}\n`;
      if (raw !== normalizedRaw) {
        writeFileSync(filePath, normalizedRaw, "utf8");
      }
      templates.push(normalized);
    } catch {
      continue;
    }
  }
  return templates;
}

function loadRuntimeMergedTemplates(partCatalog: ReadonlyArray<PartDefinition>): UnitTemplate[] {
  const baseTemplates = createInitialTemplates();
  const root = process.cwd().replace(/\\/g, "/");
  const defaults = readTemplateDir(`${root}/templates/default`, partCatalog);
  const users = readTemplateDir(`${root}/templates/user`, partCatalog);
  return mergeTemplates(baseTemplates, mergeTemplates(defaults, users));
}

function countAliveWeapons(template: UnitTemplate): number {
  let count = 0;
  for (const attachment of template.attachments) {
    const stats = COMPONENTS[attachment.component];
    if (stats.type === "weapon") {
      count += 1;
    }
  }
  return count;
}

function pickTemplate(templates: ReadonlyArray<UnitTemplate>, preferredType: "air" | "ground"): UnitTemplate {
  const byType = templates
    .filter((template) => template.type === preferredType)
    .filter((template) => countAliveWeapons(template) > 0)
    .sort((a, b) => countAliveWeapons(b) - countAliveWeapons(a));
  if (byType.length > 0) {
    return byType[0]!;
  }
  const fallback = templates
    .filter((template) => countAliveWeapons(template) > 0)
    .sort((a, b) => countAliveWeapons(b) - countAliveWeapons(a))[0];
  if (!fallback) {
    throw new Error("No weaponized template found");
  }
  return fallback;
}

function pickTemplateById(templates: ReadonlyArray<UnitTemplate>, id: number): UnitTemplate | null {
  return templates.find((template) => template.id === id) ?? null;
}

type ScenarioResult = {
  label: string;
  totalShots: number;
  facingFlips: number;
  shotSideFlips: number;
  sampleShotDirections: string;
  blockedNoPlanTicks: number;
};

function makePatchedController(deadZonePx: number): BattleAiController {
  const base = createBaselineCompositeAiController();
  const stickyFacing = new Map<string, 1 | -1>();
  return {
    decide: (input) => {
      const decision = base.decide(input);
      const remembered = stickyFacing.get(input.unit.id) ?? decision.facing;
      const target = decision.debug.targetId
        ? input.state.units.find((unit) => unit.id === decision.debug.targetId && unit.alive)
        : null;
      const dx = target ? target.x - input.unit.x : 0;
      if (Math.abs(dx) <= deadZonePx) {
        stickyFacing.set(input.unit.id, remembered);
        return { ...decision, facing: remembered };
      }
      const nextFacing: 1 | -1 = dx >= 0 ? 1 : -1;
      stickyFacing.set(input.unit.id, nextFacing);
      return { ...decision, facing: nextFacing };
    },
  };
}

function runScenario(
  label: string,
  enemyController: BattleAiController | undefined,
  epsilon: number,
  verticalOffset: number,
): ScenarioResult {
  const partCatalog = loadRuntimeMergedParts();
  const templates = loadRuntimeMergedTemplates(partCatalog);
  const shooterTemplate = pickTemplateById(templates, 1) ?? pickTemplate(templates, "ground");
  const targetTemplate = pickTemplateById(templates, 5) ?? pickTemplate(templates, "air");
  const canvas = createMockCanvas(BATTLEFIELD_WIDTH, BATTLEFIELD_HEIGHT);
  const hooks = makeHooks();
  const battle = new BattleSession(canvas, hooks, templates, {
    partCatalog,
    disableAutoEnemySpawns: true,
    disableEnemyMinimumPresence: true,
    disableDefaultStarters: true,
    aiControllers: enemyController ? { enemy: enemyController } : undefined,
  });

  const node: MapNode = {
    id: "sprinkler-repro",
    name: "Sprinkler Repro",
    owner: "neutral",
    garrison: false,
    reward: 0,
    defense: 1,
  };
  battle.start(node);
  const state = battle.getState();
  const spawnedTarget = instantiateUnit(templates, targetTemplate.id, "player", BATTLEFIELD_WIDTH * 0.52, BATTLEFIELD_HEIGHT * 0.35, { partCatalog });
  const spawnedShooter = instantiateUnit(templates, shooterTemplate.id, "enemy", BATTLEFIELD_WIDTH * 0.52, BATTLEFIELD_HEIGHT * 0.55, { partCatalog });
  if (!spawnedTarget || !spawnedShooter) {
    throw new Error("Failed to instantiate player target or enemy shooter");
  }
  state.units.push(spawnedTarget);
  state.units.push(spawnedShooter);
  const targetId = spawnedTarget.id;
  const shooterId = spawnedShooter.id;

  const shotSigns: number[] = [];
  const facingHistory: Array<1 | -1> = [];
  let blockedNoPlanTicks = 0;
  const ticks = 180;

  for (let tick = 0; tick < ticks; tick += 1) {
    const state = battle.getState();
    const shooter = state.units.find((unit) => unit.id === shooterId);
    const target = state.units.find((unit) => unit.id === targetId);
    if (!shooter || !target) {
      break;
    }

    shooter.maxSpeed = 0;
    shooter.accel = 0;
    shooter.vx = 0;
    shooter.vy = 0;
    shooter.aiAimCorrectionX = 0;
    shooter.aiAimCorrectionY = 0;
    for (let i = 0; i < shooter.weaponFireTimers.length; i += 1) {
      shooter.weaponFireTimers[i] = 0;
    }
    for (let i = 0; i < shooter.weaponAutoFire.length; i += 1) {
      shooter.weaponAutoFire[i] = true;
    }

    target.maxSpeed = 0;
    target.accel = 0;
    target.vx = 0;
    target.vy = 0;

    shooter.x = BATTLEFIELD_WIDTH * 0.52;
    shooter.y = BATTLEFIELD_HEIGHT * 0.55;
    target.x = shooter.x + (tick % 2 === 0 ? epsilon : -epsilon);
    target.y = shooter.y - verticalOffset;

    battle.update(dt, idleKeys);

    const after = battle.getState();
    const afterShooter = after.units.find((unit) => unit.id === shooterId);
    if (!afterShooter) {
      break;
    }
    facingHistory.push(afterShooter.facing);

    const fired = afterShooter.weaponFireTimers.some((timer) => timer > 0);
    if (fired) {
      const aimSign = Math.cos(afterShooter.aiDebugLastAngleRad) > 0 ? 1 : -1;
      shotSigns.push(aimSign);
    } else if (afterShooter.aiDebugFireBlockReason === "angle-locked" || afterShooter.aiDebugFireBlockReason === "no-ready-weapon") {
      blockedNoPlanTicks += 1;
    }
  }

  let facingFlips = 0;
  for (let i = 1; i < facingHistory.length; i += 1) {
    if (facingHistory[i] !== facingHistory[i - 1]) {
      facingFlips += 1;
    }
  }
  let shotSideFlips = 0;
  for (let i = 1; i < shotSigns.length; i += 1) {
    if (shotSigns[i] !== shotSigns[i - 1]) {
      shotSideFlips += 1;
    }
  }

  return {
    label,
    totalShots: shotSigns.length,
    facingFlips,
    shotSideFlips,
    sampleShotDirections: shotSigns.slice(0, 18).map((v) => (v > 0 ? "R" : "L")).join(""),
    blockedNoPlanTicks,
  };
}

function main(): void {
  const epsilon = 170;
  const verticalOffset = 60;
  const baseline = runScenario("baseline", undefined, epsilon, verticalOffset);
  const patched = runScenario("patched(dead-zone=180px)", makePatchedController(180), epsilon, verticalOffset);
  console.log("[headless-ai-sprinkler-repro]");
  console.log(`baseline shots=${baseline.totalShots} facingFlips=${baseline.facingFlips} shotSideFlips=${baseline.shotSideFlips} blocked=${baseline.blockedNoPlanTicks} sample=${baseline.sampleShotDirections}`);
  console.log(`patched  shots=${patched.totalShots} facingFlips=${patched.facingFlips} shotSideFlips=${patched.shotSideFlips} blocked=${patched.blockedNoPlanTicks} sample=${patched.sampleShotDirections}`);
}

main();
