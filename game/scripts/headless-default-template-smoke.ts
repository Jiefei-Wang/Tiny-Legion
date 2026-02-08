import { existsSync, readFileSync, readdirSync } from "node:fs";
import { BattleSession } from "../src/gameplay/battle/battle-session.ts";
import { COMPONENTS } from "../src/config/balance/weapons.ts";
import { createInitialTemplates } from "../src/simulation/units/unit-builder.ts";
import { mergeTemplates, parseTemplate } from "../src/app/template-store.ts";
import type { BattleHooks } from "../src/gameplay/battle/battle-session.ts";
import type { KeyState, MapNode, UnitInstance, UnitTemplate } from "../src/types.ts";

declare const process: { exit: (code?: number) => void; cwd: () => string };

type Failure = {
  templateId: string;
  templateName: string;
  check: "movement" | "firing";
  detail: string;
};

const dt = 1 / 60;
const idleKeys: KeyState = { a: false, d: false, w: false, s: false, space: false };
const moveRightKeys: KeyState = { a: false, d: true, w: false, s: false, space: false };

function createMockCanvas(width: number, height: number): HTMLCanvasElement {
  const contextStub = {} as CanvasRenderingContext2D;
  return {
    width,
    height,
    getContext: (type: string) => (type === "2d" ? contextStub : null),
  } as unknown as HTMLCanvasElement;
}

function makeHooks(logs: string[]): BattleHooks {
  let gas = 10000;
  return {
    addLog: (text: string) => {
      logs.push(text);
    },
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
    onBattleOver: () => {
      logs.push("battle-over");
    },
  };
}

function findNewUnit(beforeIds: Set<string>, units: UnitInstance[], templateId: string): UnitInstance | null {
  for (const unit of units) {
    if (unit.side === "player" && unit.templateId === templateId && !beforeIds.has(unit.id)) {
      return unit;
    }
  }
  return null;
}

function waitForUnitReadyForControl(battle: BattleSession, unitId: string, maxFrames: number): UnitInstance | null {
  for (let i = 0; i < maxFrames; i += 1) {
    const unit = battle.getState().units.find((entry) => entry.id === unitId);
    if (!unit) {
      return null;
    }
    if (!unit.airDropActive) {
      return unit;
    }
    battle.update(dt, idleKeys);
  }
  return battle.getState().units.find((entry) => entry.id === unitId) ?? null;
}

function readTemplateDir(dirPath: string): UnitTemplate[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
  const templates: UnitTemplate[] = [];
  for (const fileName of files) {
    try {
      const raw = readFileSync(`${dirPath}/${fileName}`, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const template = parseTemplate(parsed);
      if (template) {
        templates.push(template);
      }
    } catch {
      continue;
    }
  }
  return templates;
}

function loadRuntimeMergedTemplates(): UnitTemplate[] {
  const baseTemplates = createInitialTemplates();
  const root = process.cwd().replace(/\\/g, "/");
  const defaults = readTemplateDir(`${root}/templates/default`);
  const users = readTemplateDir(`${root}/templates/user`);
  return mergeTemplates(baseTemplates, mergeTemplates(defaults, users));
}

function getMissingLoaderClasses(template: UnitTemplate): string[] {
  const weaponClasses = template.attachments
    .map((attachment) => COMPONENTS[attachment.component])
    .filter((stats) => stats.type === "weapon")
    .map((stats) => stats.weaponClass ?? "rapid-fire")
    .filter((weaponClass) => weaponClass === "tracking" || weaponClass === "heavy-shot" || weaponClass === "explosive");
  if (weaponClasses.length === 0) {
    return [];
  }
  const supported = new Set<string>();
  for (const attachment of template.attachments) {
    const stats = COMPONENTS[attachment.component];
    if (stats.type !== "loader" || !stats.loader) {
      continue;
    }
    for (const weaponClass of stats.loader.supports) {
      supported.add(weaponClass);
    }
  }
  return Array.from(new Set(weaponClasses.filter((weaponClass) => !supported.has(weaponClass))));
}

function runSmoke(): Failure[] {
  const failures: Failure[] = [];
  const requiredTemplateIds = ["scout-ground", "tank-ground"];
  const templates = loadRuntimeMergedTemplates();
  const testTemplates: UnitTemplate[] = [];
  for (const requiredTemplateId of requiredTemplateIds) {
    const matched = templates.find((template) => template.id === requiredTemplateId);
    if (!matched) {
      failures.push({
        templateId: requiredTemplateId,
        templateName: requiredTemplateId,
        check: "movement",
        detail: "required template missing from runtime merged templates",
      });
      continue;
    }
    testTemplates.push(matched);
  }
  if (failures.length > 0) {
    return failures;
  }
  const logs: string[] = [];
  const canvas = createMockCanvas(1280, 720);
  const hooks = makeHooks(logs);
  const battle = new BattleSession(canvas, hooks, templates, {
    disableAutoEnemySpawns: true,
    disableEnemyMinimumPresence: true,
    disableDefaultStarters: true,
  });

  const node: MapNode = {
    id: "headless-test",
    name: "Headless Test",
    owner: "neutral",
    garrison: false,
    reward: 0,
    defense: 1,
  };
  battle.start(node);

  for (const template of testTemplates) {
    const beforeIds = new Set(battle.getState().units.map((unit) => unit.id));
    battle.deployUnit(template.id);
    const deployedUnit = findNewUnit(beforeIds, battle.getState().units, template.id);
    if (!deployedUnit) {
      failures.push({
        templateId: template.id,
        templateName: template.name,
        check: "movement",
        detail: "unit failed to deploy in battle state",
      });
      continue;
    }

    let unit = deployedUnit;
    const unitId = unit.id;
    const startX = unit.x;
    battle.clearControlSelection();
    battle.setControlByClick(unit.x, unit.y);
    for (let i = 0; i < 120; i += 1) {
      battle.update(dt, moveRightKeys);
    }
    const movedUnit = battle.getState().units.find((entry) => entry.id === unitId);
    if (!movedUnit) {
      failures.push({
        templateId: template.id,
        templateName: template.name,
        check: "movement",
        detail: "unit disappeared from battle state during movement check",
      });
      continue;
    }
    unit = movedUnit;
    const readyUnit = waitForUnitReadyForControl(battle, unitId, 480);
    if (!readyUnit) {
      failures.push({
        templateId: template.id,
        templateName: template.name,
        check: "movement",
        detail: "unit disappeared from battle state while waiting for control readiness",
      });
      continue;
    }
    unit = readyUnit;
    const readyStartX = unit.x;
    const movedDistance = unit.x - startX;
    const settledMovedDistance = unit.x - readyStartX;
    const movementThreshold = Math.max(2.5, unit.maxSpeed * 0.08);
    if (movedDistance < movementThreshold && settledMovedDistance < movementThreshold) {
      failures.push({
        templateId: template.id,
        templateName: template.name,
        check: "movement",
        detail: `moved too little: ${movedDistance.toFixed(2)} (settled=${settledMovedDistance.toFixed(2)}, min=${movementThreshold.toFixed(2)}, startX=${startX.toFixed(2)}, readyX=${readyStartX.toFixed(2)}, endX=${unit.x.toFixed(2)}, mass=${unit.mass.toFixed(2)}, maxSpeed=${unit.maxSpeed.toFixed(2)})`,
      });
    }

    const fireLogNeedle = `${unit.name} fired weapon #`;
    const logCountBefore = logs.filter((line) => line.includes(fireLogNeedle)).length;
    let projectileSeen = false;
    const base = battle.getState().enemyBase;
    const aimX = base.x + base.w * 0.5;
    const aimY = base.y + base.h * 0.5;
    const fireReadyUnit = waitForUnitReadyForControl(battle, unit.id, 480);
    if (!fireReadyUnit) {
      failures.push({
        templateId: template.id,
        templateName: template.name,
        check: "firing",
        detail: "unit disappeared from battle state while waiting for firing readiness",
      });
      continue;
    }
    battle.clearControlSelection();
    battle.setControlByClick(fireReadyUnit.x, fireReadyUnit.y);
    battle.setAim(aimX, aimY);
    battle.handleLeftPointerDown(fireReadyUnit.x, fireReadyUnit.y);
    for (let i = 0; i < 300; i += 1) {
      battle.update(dt, idleKeys);
      if (battle.getState().projectiles.some((projectile) => projectile.sourceId === unit.id)) {
        projectileSeen = true;
      }
      if (projectileSeen) {
        break;
      }
    }
    battle.handlePointerUp();

    const logCountAfter = logs.filter((line) => line.includes(fireLogNeedle)).length;
    if (!projectileSeen && logCountAfter <= logCountBefore) {
      const missingLoaders = getMissingLoaderClasses(template);
      const blocker = missingLoaders.length > 0
        ? `possible blocker: missing compatible loader for ${missingLoaders.join(", ")}`
        : "possible blocker: weapon produced no projectile";
      failures.push({
        templateId: template.id,
        templateName: template.name,
        check: "firing",
        detail: `no projectile observed and no manual fire log emitted within 5.0s simulation window; ${blocker}`,
      });
    }
  }

  return failures;
}

const failures = runSmoke();
if (failures.length > 0) {
  console.error("[headless-default-template-smoke] FAILED");
  for (const failure of failures) {
    console.error(`- ${failure.templateId} (${failure.templateName}) :: ${failure.check} :: ${failure.detail}`);
  }
  process.exit(1);
}

console.log("[headless-default-template-smoke] PASS: runtime-merged default templates moved and fired.");
