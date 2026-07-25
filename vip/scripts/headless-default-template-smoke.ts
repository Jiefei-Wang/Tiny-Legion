import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { BattleSession } from "../src/gameplay/battle/battle-session.ts";
import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  GROUND_WRECK_LIFETIME_SECONDS,
  GROUND_WRECK_MAX_INITIAL_HP_LOSS_RATIO,
  GROUND_WRECK_MIN_INITIAL_HP_LOSS_RATIO,
  UNIT_OVERLAP_ALLOWANCE_RATIO,
} from "../src/config/balance/battlefield.ts";
import { COMPONENTS } from "../src/config/balance/weapons.ts";
import { createInitialTemplates } from "../src/simulation/units/unit-builder.ts";
import { instantiateUnit } from "../src/simulation/units/unit-builder.ts";
import { applyHitToUnit, scaleDamageByRemainingPenetration } from "../src/simulation/combat/damage-model.ts";
import { orientedBeamAabbEntryTime, segmentRoundedAabbEntryTime } from "../../game-core/src/simulation/combat/projectile-collision.ts";
import { PROJECTILE_ASSETS } from "../../game-core/src/projectiles/generated/projectile-assets.generated.ts";
import { destroyCell } from "../src/simulation/units/structure-grid.ts";
import { canOperate } from "../src/simulation/units/control-unit-rules.ts";
import { mergeTemplates, parseTemplate, validateTemplateDetailed } from "../src/app/template-store.ts";
import { mergePartCatalogs, parsePartDefinition } from "../src/app/part-store.ts";
import {
  calculateDestroyTimeSeconds,
  calculateHitsToDestroy,
  type StructureComparisonValues,
  type WeaponComparisonValues,
} from "../src/app/part-comparison.ts";
import type { BattleHooks } from "../src/gameplay/battle/battle-session.ts";
import type { KeyState, MapNode, PartDefinition, UnitInstance, UnitTemplate } from "../src/types.ts";

declare const process: { exit: (code?: number) => void; cwd: () => string };

type Failure = {
  templateId: number;
  templateName: string;
  check: "validation" | "movement" | "firing" | "overlap" | "functional-support" | "weapon-capacity" | "air-isotropic" | "air-inertia" | "escape-mode" | "control-loss-crash" | "structure-origin" | "penetration-scaling" | "wreck-damage" | "wreck-lifecycle" | "projectile-collision" | "part-comparison";
  detail: string;
};

const dt = 1 / 60;
const idleKeys: KeyState = { a: false, d: false, w: false, s: false, space: false };
const moveRightKeys: KeyState = { a: false, d: true, w: false, s: false, space: false };
const moveUpKeys: KeyState = { a: false, d: false, w: true, s: false, space: false };
const moveUpRightKeys: KeyState = { a: false, d: true, w: true, s: false, space: false };

function verifyPartComparisonCalculations(failures: Failure[]): void {
  const weapon = (
    damage: number,
    cooldown = 2,
    maxCapacity = 3,
    minFireInterval = 0.25,
  ): WeaponComparisonValues => ({
    gasCost: 0,
    mass: 0,
    damage,
    penetration: 0,
    cooldown,
    maxCapacity,
    minFireInterval,
  });
  const structure = (armor: number, hp: number): StructureComparisonValues => ({
    gasCost: 0,
    mass: 0,
    armor,
    hp,
  });
  const checks: Array<{ label: string; actual: number; expected: number }> = [
    { label: "damage above armor rounds hits up", actual: calculateHitsToDestroy(weapon(10), structure(3, 15)), expected: 3 },
    { label: "damage equal to armor floors to one", actual: calculateHitsToDestroy(weapon(10), structure(10, 4)), expected: 4 },
    { label: "damage below armor floors to one", actual: calculateHitsToDestroy(weapon(2), structure(10, 4)), expected: 4 },
    { label: "zero hp requires zero hits", actual: calculateHitsToDestroy(weapon(10), structure(0, 0)), expected: 0 },
    { label: "one hit occurs at zero seconds", actual: calculateDestroyTimeSeconds(1, weapon(10)), expected: 0 },
    { label: "capacity one uses cooldown per additional hit", actual: calculateDestroyTimeSeconds(4, weapon(10, 2, 1, 0.25)), expected: 6 },
    { label: "within-magazine shots use interval", actual: calculateDestroyTimeSeconds(3, weapon(10, 2, 3, 0.25)), expected: 0.5 },
    { label: "magazine boundary uses cooldown", actual: calculateDestroyTimeSeconds(4, weapon(10, 2, 3, 0.25)), expected: 2.5 },
    { label: "multiple magazines repeat burst cycle", actual: calculateDestroyTimeSeconds(7, weapon(10, 2, 3, 0.25)), expected: 5 },
    { label: "zero timing values remain zero", actual: calculateDestroyTimeSeconds(8, weapon(10, 0, 2, 0)), expected: 0 },
  ];
  for (const check of checks) {
    if (Math.abs(check.actual - check.expected) > 1e-9) {
      failures.push({
        templateId: 0,
        templateName: "Part comparison",
        check: "part-comparison",
        detail: `${check.label}: expected ${check.expected}, got ${check.actual}`,
      });
    }
  }
}

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

function findNewUnit(beforeIds: Set<string>, units: UnitInstance[], templateId: number): UnitInstance | null {
  for (const unit of units) {
    if (unit.side === "player" && unit.templateId === templateId && !beforeIds.has(unit.id)) {
      return unit;
    }
  }
  return null;
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

function serializeTemplateForFile(template: UnitTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    type: template.type,
    structure: template.structure.map((cell) => ({ partId: cell.partId, x: cell.x, y: cell.y })),
    attachments: template.attachments.map((attachment) => ({
      component: attachment.component,
      partId: attachment.partId,
      cell: attachment.cell,
      x: attachment.x,
      y: attachment.y,
      rotateQuarter: attachment.rotateQuarter,
    })),
    display: template.display?.map((item) => ({ kind: item.kind, cell: item.cell, x: item.x, y: item.y })) ?? [],
  };
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
      const normalizedRaw = `${JSON.stringify(serializeTemplateForFile(normalized), null, 2)}\n`;
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

function getMissingLoaderClasses(template: UnitTemplate): string[] {
  const projectileClasses = template.attachments
    .filter((attachment) => attachment.component === "trackingMissile" || attachment.component === "heavyCannon" || attachment.component === "explosiveShell")
    .map((attachment) => COMPONENTS[attachment.component].projectileClass ?? "bullet");
  if (projectileClasses.length === 0) {
    return [];
  }
  const supported = new Set<string>();
  for (const attachment of template.attachments) {
    const stats = COMPONENTS[attachment.component];
    if (stats.type !== "loader" || !stats.loader) {
      continue;
    }
    for (const projectileClass of stats.loader.supports) {
      supported.add(projectileClass);
    }
  }
  return Array.from(new Set(projectileClasses.filter((projectileClass) => !supported.has(projectileClass))));
}

function runSmoke(): Failure[] {
  const failures: Failure[] = [];
  verifyPartComparisonCalculations(failures);
  const halfPenetrationDamage = scaleDamageByRemainingPenetration(220, 250, 125);
  if (halfPenetrationDamage !== 110) {
    failures.push({ templateId: 0, templateName: "penetration model", check: "penetration-scaling", detail: `expected 110 residual damage, got ${halfPenetrationDamage}` });
  }
  const requiredTemplateIds = [1, 2, 5, 3, 4];
  const partCatalog = loadRuntimeMergedParts();
  const cannonGeometrySource = partCatalog.find((part) => part.name === "cannons");
  const cannonGeometrySeed = cannonGeometrySource?.boxes[0];
  if (cannonGeometrySource && cannonGeometrySeed) {
    const expandedBoxes = [
      ...cannonGeometrySource.boxes,
      { ...cannonGeometrySeed, x: 2, y: 0, isAnchorPoint: false, isShootingPoint: false },
      { ...cannonGeometrySeed, x: 3, y: 0, isAnchorPoint: false, isShootingPoint: false },
    ];
    const reparsed = parsePartDefinition({
      ...cannonGeometrySource,
      cells: cannonGeometrySource.cells?.slice(0, 2),
      boxes: expandedBoxes,
    });
    if (!reparsed || reparsed.boxes.length !== 5 || reparsed.cells?.length !== 5) {
      failures.push({ templateId: 0, templateName: "cannons", check: "validation", detail: "saved editor boxes were overwritten by stale legacy cells" });
    }
  }
  const canonicalPartTypes: Record<string, PartDefinition["partType"]> = {
    "light steel": "structure",
    "normal steel": "structure",
    "heavy steel": "structure",
    "small control unit": "control",
    "medium control unit": "control",
    "large control unit": "control",
    "light tank engine": "engine",
    "heavy tank engine": "engine",
    "light aircraft engine": "engine",
    "heavy aircraft engine": "engine",
    firearm: "weapon",
    cannons: "weapon",
    "anti-tank gun": "weapon",
    laser: "weapon",
    "cannons reloader": "loader",
    "anti-tank gun reloader": "loader",
  };
  for (const [name, expectedType] of Object.entries(canonicalPartTypes)) {
    const part = partCatalog.find((entry) => entry.name === name);
    if (!part || part.partType !== expectedType) {
      failures.push({ templateId: 0, templateName: name, check: "validation", detail: `canonical Part Editor category missing or wrong type (expected ${expectedType})` });
    }
  }
  const canonicalWeaponComponents = new Map<string, PartDefinition["baseComponent"]>([
    ["firearm", "rapidGun"],
    ["cannons", "explosiveShell"],
    ["anti-tank gun", "heavyCannon"],
    ["laser", "precisionBeam"],
  ]);
  for (const [name, expectedComponent] of canonicalWeaponComponents) {
    const part = partCatalog.find((entry) => entry.name === name);
    if (!part || part.baseComponent !== expectedComponent) {
      failures.push({ templateId: 0, templateName: name, check: "validation", detail: `canonical weapon is disconnected from ${expectedComponent}` });
    }
  }
  const firearmPart = partCatalog.find((part) => part.name === "firearm");
  if (!firearmPart || firearmPart.partProperties?.hasAngleLimit !== false || firearmPart.directional !== false) {
    failures.push({ templateId: 0, templateName: "firearm", check: "validation", detail: "firearm must be omnidirectional with hasAngleLimit=false in the editor/runtime catalog" });
  }
  const explosiveCannonPart = partCatalog.find((part) => part.name === "cannons");
  const antiTankCannonPart = partCatalog.find((part) => part.name === "anti-tank gun");
  if (
    explosiveCannonPart?.properties?.subcategory !== "cannon"
    || antiTankCannonPart?.properties?.subcategory !== "cannon"
  ) {
    failures.push({ templateId: 0, templateName: "cannon", check: "validation", detail: "explosive and anti-tank variants must share the cannon category" });
  }
  if (
    !antiTankCannonPart
    || antiTankCannonPart.partProperties?.explodeOnHit !== false
    || (antiTankCannonPart.stats?.explosiveBlastRadius ?? 0) !== 0
    || (antiTankCannonPart.stats?.explosiveBlastDamage ?? 0) !== 0
  ) {
    failures.push({ templateId: 0, templateName: "anti-tank gun", check: "validation", detail: "anti-tank cannon must not apply area/blast damage" });
  }
  if (
    explosiveCannonPart?.partProperties?.fireSoundPool !== "explosive"
    || antiTankCannonPart?.partProperties?.fireSoundPool !== "heavy-shot"
  ) {
    failures.push({ templateId: 0, templateName: "cannon", check: "validation", detail: "cannon variants must preserve independent per-part fire sound pools" });
  }
  const expectedProjectileAssets = [
    "bullet-round", "bullet-slug", "bullet-tracer",
    "missile-missile", "missile-heavy-rocket", "missile-energy-orb",
    "laser-thin", "laser-pulse", "laser-wide",
  ];
  if (expectedProjectileAssets.some((shape) => !(shape in PROJECTILE_ASSETS))) {
    failures.push({ templateId: 0, templateName: "projectile assets", check: "validation", detail: "generated nine-shape projectile manifest is incomplete" });
  }
  if (
    firearmPart?.partProperties?.projectileClass !== "bullet"
    || firearmPart.partProperties.projectileShape !== "bullet-tracer"
    || explosiveCannonPart?.partProperties?.projectileShape !== "bullet-round"
    || antiTankCannonPart?.partProperties?.projectileShape !== "bullet-slug"
  ) {
    failures.push({ templateId: 0, templateName: "projectile defaults", check: "validation", detail: "default weapon projectile class/shape migration is incorrect" });
  }
  const fastCapsuleHit = segmentRoundedAabbEntryTime(0, 50, 1000, 50, 490, 40, 510, 60, 3);
  const roundedCornerMiss = segmentRoundedAabbEntryTime(0, 35, 500, 35, 490, 40, 510, 60, 3);
  const beamHit = orientedBeamAabbEntryTime(0, 50, 1000, 50, 4, 490, 48, 510, 52);
  const beamMiss = orientedBeamAabbEntryTime(0, 50, 1000, 50, 4, 490, 60, 510, 70);
  if (fastCapsuleHit === null || roundedCornerMiss !== null || beamHit === null || beamMiss !== null) {
    failures.push({ templateId: 0, templateName: "projectile geometry", check: "projectile-collision", detail: "swept capsule or oriented beam collision regression" });
  }
  const templates = loadRuntimeMergedTemplates(partCatalog);
  const defaultTemplateIds = new Set(readTemplateDir(`${process.cwd().replace(/\\/g, "/")}/templates/default`, partCatalog).map((template) => template.id));
  const magazineWeaponSource = partCatalog.find((part) => part.name === "firearm");
  const magazineTemplateSource = templates.find((template) => template.id === 5);
  if (magazineWeaponSource && magazineTemplateSource) {
    const magazineWeapon: PartDefinition = {
      ...magazineWeaponSource,
      id: 999_013,
      name: "Headless Magazine Weapon",
      stats: {
        ...magazineWeaponSource.stats,
        cooldown: 0.5,
      },
      partProperties: {
        ...magazineWeaponSource.partProperties,
        needLoader: false,
        maxCapacity: 3,
        minFireInterval: 0.05,
      },
    };
    const magazineTemplate: UnitTemplate = {
      ...magazineTemplateSource,
      id: 999_013,
      name: "Headless Magazine Craft",
      attachments: magazineTemplateSource.attachments.map((attachment) => (
        COMPONENTS[attachment.component].type === "weapon"
          ? { ...attachment, partId: magazineWeapon.id }
          : { ...attachment }
      )),
    };
    const magazineCatalog = [...partCatalog, magazineWeapon];
    const magazineUnit = instantiateUnit(
      [magazineTemplate],
      magazineTemplate.id,
      "player",
      200,
      700,
      { partCatalog: magazineCatalog },
    );
    if ((magazineUnit?.weaponReadyCharges[0] ?? 0) !== 3) {
      failures.push({
        templateId: magazineTemplate.id,
        templateName: magazineTemplate.name,
        check: "weapon-capacity",
        detail: `expected 3 initially loaded rounds, got ${magazineUnit?.weaponReadyCharges[0] ?? 0}`,
      });
    }

    const magazineLogs: string[] = [];
    const magazineBattle = new BattleSession(
      createMockCanvas(BATTLEFIELD_WIDTH, BATTLEFIELD_HEIGHT),
      makeHooks(magazineLogs),
      [magazineTemplate],
      {
        partCatalog: magazineCatalog,
        disableAutoEnemySpawns: true,
        disableEnemyMinimumPresence: true,
        disableDefaultStarters: true,
      },
    );
    magazineBattle.start({
      id: "headless-magazine-test",
      name: "Headless Magazine Test",
      owner: "neutral",
      garrison: false,
      reward: 0,
      defense: 1,
    });
    magazineBattle.deployUnit(magazineTemplate.id);
    const deployedMagazineUnit = magazineBattle.getState().units.find((unit) => unit.templateId === magazineTemplate.id);
    if (deployedMagazineUnit) {
      magazineBattle.setControlByClick(deployedMagazineUnit.x, deployedMagazineUnit.y);
      magazineBattle.handleLeftPointerDown(deployedMagazineUnit.x, deployedMagazineUnit.y);
      for (let i = 0; i < 15; i += 1) {
        magazineBattle.update(dt, idleKeys);
      }
      magazineBattle.handlePointerUp();
      const burstShots = magazineLogs.filter((line) => line.includes(`${magazineTemplate.name} fired weapon #`)).length;
      if (burstShots !== 3 || (deployedMagazineUnit.weaponReadyCharges[0] ?? -1) !== 0) {
        failures.push({
          templateId: magazineTemplate.id,
          templateName: magazineTemplate.name,
          check: "weapon-capacity",
          detail: `expected a 3-shot magazine before cooldown; fired=${burstShots}, remaining=${deployedMagazineUnit.weaponReadyCharges[0] ?? -1}`,
        });
      }
      if (deployedMagazineUnit.loaderStates.some((loader) => loader.targetWeaponSlot !== null)) {
        failures.push({
          templateId: magazineTemplate.id,
          templateName: magazineTemplate.name,
          check: "weapon-capacity",
          detail: "a dedicated loader targeted a self-reloading weapon",
        });
      }
      for (let i = 0; i < 30; i += 1) {
        magazineBattle.update(dt, idleKeys);
      }
      if ((deployedMagazineUnit.weaponReadyCharges[0] ?? 0) !== 1) {
        failures.push({
          templateId: magazineTemplate.id,
          templateName: magazineTemplate.name,
          check: "weapon-capacity",
          detail: `one cooldown cycle should reload exactly one round; got ${deployedMagazineUnit.weaponReadyCharges[0] ?? 0}`,
        });
      }
      for (let i = 0; i < 60; i += 1) {
        magazineBattle.update(dt, idleKeys);
      }
      if ((deployedMagazineUnit.weaponReadyCharges[0] ?? 0) !== 3) {
        failures.push({
          templateId: magazineTemplate.id,
          templateName: magazineTemplate.name,
          check: "weapon-capacity",
          detail: `three cooldown cycles should restore the 3-round capacity; got ${deployedMagazineUnit.weaponReadyCharges[0] ?? 0}`,
        });
      }
    } else {
      failures.push({
        templateId: magazineTemplate.id,
        templateName: magazineTemplate.name,
        check: "weapon-capacity",
        detail: "failed to deploy magazine behavior fixture",
      });
    }
  }

  const tankTemplate = templates.find((template) => template.id === 1);
  if (tankTemplate) {
    const duplicateControlTemplate: UnitTemplate = {
      ...tankTemplate,
      id: 999_010,
      name: "duplicate control fixture",
      attachments: [...tankTemplate.attachments, { component: "control", partId: 3, cell: 9, x: 2, y: 1 }],
    };
    const duplicateControlValidation = validateTemplateDetailed(duplicateControlTemplate, { partCatalog });
    if (!duplicateControlValidation.errors.includes("exactly one control unit is required")) {
      failures.push({ templateId: duplicateControlTemplate.id, templateName: duplicateControlTemplate.name, check: "validation", detail: "multiple controls were not rejected" });
    }

    const zeroUseTemplate: UnitTemplate = {
      ...tankTemplate,
      id: 999_011,
      name: "zero computing use fixture",
      attachments: tankTemplate.attachments.map((attachment) => attachment.component === "control"
        ? { ...attachment, partId: 3 }
        : { ...attachment }),
    };
    const zeroUseValidation = validateTemplateDetailed(zeroUseTemplate, { partCatalog });
    if (zeroUseValidation.errors.some((error) => error.startsWith("control unit capacity exceeded"))) {
      failures.push({ templateId: zeroUseTemplate.id, templateName: zeroUseTemplate.name, check: "validation", detail: "zero-use parts were charged by functional footprint" });
    }
    if (instantiateUnit([zeroUseTemplate], zeroUseTemplate.id, "player", 0, 0, { partCatalog }) === null) {
      failures.push({ templateId: zeroUseTemplate.id, templateName: zeroUseTemplate.name, check: "validation", detail: "runtime rejected zero-use parts because of their functional footprint" });
    }

    const capacityWeaponSource = partCatalog.find((part) => part.id === 7);
    if (capacityWeaponSource) {
      const capacityWeaponPart: PartDefinition = {
        ...capacityWeaponSource,
        id: 999_012,
        name: "Headless High Computing Use Weapon",
        partProperties: {
          ...capacityWeaponSource.partProperties,
          computingConsumption: 9,
        },
      };
      const capacityPartCatalog = [...partCatalog, capacityWeaponPart];
      const overCapacityTemplate: UnitTemplate = {
        ...tankTemplate,
        id: 999_012,
        name: "control capacity fixture",
        attachments: tankTemplate.attachments.map((attachment) => {
          if (attachment.component === "control") {
            return { ...attachment, partId: 3 };
          }
          if (attachment.partId === capacityWeaponSource.id) {
            return { ...attachment, partId: capacityWeaponPart.id };
          }
          return { ...attachment };
        }),
      };
      const overCapacityValidation = validateTemplateDetailed(overCapacityTemplate, { partCatalog: capacityPartCatalog });
      if (!overCapacityValidation.errors.some((error) => error.startsWith("control unit capacity exceeded"))) {
        failures.push({ templateId: overCapacityTemplate.id, templateName: overCapacityTemplate.name, check: "validation", detail: "part computing-use capacity overflow was not rejected" });
      }
      if (instantiateUnit([overCapacityTemplate], overCapacityTemplate.id, "player", 0, 0, { partCatalog: capacityPartCatalog }) !== null) {
        failures.push({ templateId: overCapacityTemplate.id, templateName: overCapacityTemplate.name, check: "validation", detail: "runtime instantiated a craft exceeding authored part computing use" });
      }
    }
  }

  const supportPart: PartDefinition = {
    id: 999_001,
    name: "Headless Multi Support Control",
    layer: "functional",
    partType: "control",
    baseComponent: "control",
    anchor: { x: 0, y: 0 },
    boxes: [
      { x: 0, y: 0, isAttachPoint: true, occupiesFunctionalSpace: false, takesDamage: false },
      { x: 1, y: 0, isAttachPoint: true, occupiesFunctionalSpace: false, takesDamage: false },
    ],
  };
  const supportTemplate: UnitTemplate = {
    id: 999_001,
    name: "Headless Functional Support Test",
    type: "ground",
    gasCost: 0,
    structure: [
      { partId: 11, x: 0, y: 0 },
      { partId: 11, x: 1, y: 0 },
    ],
    attachments: [{ component: "control", partId: supportPart.id, cell: 0, x: 0, y: 0 }],
  };
  const supportUnit = instantiateUnit([supportTemplate], supportTemplate.id, "player", 0, 0, {
    partCatalog: [...partCatalog, supportPart],
  });
  const supportAttachment = supportUnit?.attachments[0];
  if (!supportUnit || !supportAttachment) {
    failures.push({ templateId: supportTemplate.id, templateName: supportTemplate.name, check: "functional-support", detail: "failed to instantiate support-link fixture" });
  } else {
    if ("hp" in supportAttachment || "maxHp" in supportAttachment) {
      failures.push({ templateId: supportTemplate.id, templateName: supportTemplate.name, check: "functional-support", detail: "functional attachment still exposes an HP pool" });
    }
    if (supportAttachment.attachedStructureCellIds.join(",") !== "0,1") {
      failures.push({ templateId: supportTemplate.id, templateName: supportTemplate.name, check: "functional-support", detail: `expected support links 0,1; got ${supportAttachment.attachedStructureCellIds.join(",")}` });
    }
    const armorBypassResult = applyHitToUnit(supportUnit, 10, 0, 1, 0, true);
    if (armorBypassResult.armorDeducted !== 0 || armorBypassResult.structureDamage !== 10) {
      failures.push({ templateId: supportTemplate.id, templateName: supportTemplate.name, check: "functional-support", detail: `armor bypass relayed ${armorBypassResult.structureDamage} damage with ${armorBypassResult.armorDeducted} armor deducted` });
    }
    destroyCell(supportUnit, 1);
    if (supportAttachment.alive) {
      failures.push({ templateId: supportTemplate.id, templateName: supportTemplate.name, check: "functional-support", detail: "functional attachment survived destruction of one of multiple supports" });
    }
    if (!supportUnit.alive || canOperate(supportUnit) || supportUnit.vx !== 0 || supportUnit.vy !== 0) {
      failures.push({ templateId: supportTemplate.id, templateName: supportTemplate.name, check: "functional-support", detail: "controller loss did not leave a persistent, stationary, inoperable wreck" });
    }
    const wreckHitResult = applyHitToUnit(supportUnit, 1000, 0, 1, 0, true);
    if (wreckHitResult.structureDamage <= 0 || supportUnit.alive) {
      failures.push({ templateId: supportTemplate.id, templateName: supportTemplate.name, check: "wreck-damage", detail: "inoperable wreck did not continue taking structure damage until fully destroyed" });
    }
  }

  for (const template of templates) {
    if (!defaultTemplateIds.has(template.id)) {
      continue;
    }
    const validation = validateTemplateDetailed(template, { partCatalog });
    if (validation.errors.length > 0 || validation.warnings.length > 0) {
      failures.push({
        templateId: template.id,
        templateName: template.name,
        check: "validation",
        detail: `errors=${validation.errors.join(" | ") || "none"}; warnings=${validation.warnings.join(" | ") || "none"}`,
      });
    }
  }
  if (failures.length > 0) {
    return failures;
  }

  const testTemplates: UnitTemplate[] = [];
  for (const requiredTemplateId of requiredTemplateIds) {
    const matched = templates.find((template) => template.id === requiredTemplateId);
    if (!matched) {
      failures.push({
        templateId: requiredTemplateId,
        templateName: String(requiredTemplateId),
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
  const canvas = createMockCanvas(BATTLEFIELD_WIDTH, BATTLEFIELD_HEIGHT);
  const hooks = makeHooks(logs);
  const battle = new BattleSession(canvas, hooks, templates, {
    partCatalog,
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

  const groundWreckTemplate = testTemplates.find((template) => template.type === "ground") ?? null;
  if (groundWreckTemplate) {
    const wreckBattle = new BattleSession(canvas, makeHooks([]), templates, {
      partCatalog,
      disableAutoEnemySpawns: true,
      disableEnemyMinimumPresence: true,
      disableDefaultStarters: true,
    });
    wreckBattle.start(node);
    wreckBattle.arenaDeploy("player", groundWreckTemplate.id, { chargeGas: false, ignoreCap: true });
    const wreckUnit = wreckBattle.getState().units.find((unit) => unit.templateId === groundWreckTemplate.id && unit.side === "player");
    const control = wreckUnit?.attachments.find((attachment) => COMPONENTS[attachment.component].type === "control");
    if (!wreckUnit || !control) {
      failures.push({ templateId: groundWreckTemplate.id, templateName: groundWreckTemplate.name, check: "wreck-lifecycle", detail: "failed to create ground wreck fixture" });
    } else {
      const startX = wreckUnit.x;
      const startY = wreckUnit.y;
      control.alive = false;
      wreckBattle.update(dt, idleKeys);
      const initialRatios = wreckUnit.structure
        .filter((cell) => !cell.destroyed)
        .map((cell) => (wreckUnit.groundWreckInitialCellHp[cell.id] ?? 0) / Math.max(1, cell.breakThreshold));
      const hpRangeValid = initialRatios.length > 0 && initialRatios.every((ratio) =>
        ratio >= 1 - GROUND_WRECK_MAX_INITIAL_HP_LOSS_RATIO - 1e-6
        && ratio <= 1 - GROUND_WRECK_MIN_INITIAL_HP_LOSS_RATIO + 1e-6
      );
      if (wreckUnit.groundWreckTimerS === null || !hpRangeValid || wreckUnit.x !== startX || wreckUnit.y !== startY) {
        failures.push({
          templateId: groundWreckTemplate.id,
          templateName: groundWreckTemplate.name,
          check: "wreck-lifecycle",
          detail: `wreck initialization invalid: timer=${wreckUnit.groundWreckTimerS}, hpRangeValid=${hpRangeValid}, position=${wreckUnit.x},${wreckUnit.y}`,
        });
      }
      const halfFrames = Math.floor((GROUND_WRECK_LIFETIME_SECONDS * 0.5 - dt) / dt);
      for (let frame = 0; frame < halfFrames; frame += 1) wreckBattle.update(dt, idleKeys);
      const expectedLifetimeRatio = (wreckUnit.groundWreckTimerS ?? 0) / GROUND_WRECK_LIFETIME_SECONDS;
      const linearDecayValid = wreckUnit.structure
        .filter((cell) => !cell.destroyed)
        .every((cell) => {
          const initialHp = wreckUnit.groundWreckInitialCellHp[cell.id] ?? 0;
          const remainingHp = Math.max(0, cell.breakThreshold - cell.strain);
          return Math.abs(remainingHp - initialHp * expectedLifetimeRatio) <= 1e-4;
        });
      if (!linearDecayValid) {
        failures.push({ templateId: groundWreckTemplate.id, templateName: groundWreckTemplate.name, check: "wreck-lifecycle", detail: "ground wreck cell HP did not follow the configured linear decay curve" });
      }
      const framesBeforeDetonation = Math.floor(((wreckUnit.groundWreckTimerS ?? 0) - dt * 2) / dt);
      for (let frame = 0; frame < framesBeforeDetonation; frame += 1) wreckBattle.update(dt, idleKeys);
      if (!wreckUnit.alive || !wreckBattle.getState().units.includes(wreckUnit)) {
        failures.push({ templateId: groundWreckTemplate.id, templateName: groundWreckTemplate.name, check: "wreck-lifecycle", detail: "ground wreck disappeared before its configured lifetime elapsed" });
      }
      for (let frame = 0; frame < 4; frame += 1) wreckBattle.update(dt, idleKeys);
      const wreckExplosionVariants = new Set(wreckBattle.getState().blockExplosions.map((effect) => effect.variant));
      if (
        wreckUnit.alive
        || wreckBattle.getState().units.includes(wreckUnit)
        || wreckBattle.getState().blockExplosions.length < initialRatios.length
        || (initialRatios.length > 1 && wreckExplosionVariants.size < 2)
      ) {
        failures.push({
          templateId: groundWreckTemplate.id,
          templateName: groundWreckTemplate.name,
          check: "wreck-lifecycle",
          detail: `wreck did not finish with varied per-block explosions: alive=${wreckUnit.alive}, present=${wreckBattle.getState().units.includes(wreckUnit)}, explosions=${wreckBattle.getState().blockExplosions.length}, variants=${wreckExplosionVariants.size}`,
        });
      }
    }

    for (const missingCapability of ["engine", "weapon"] as const) {
      const capabilityBattle = new BattleSession(canvas, makeHooks([]), templates, {
        partCatalog,
        disableAutoEnemySpawns: true,
        disableEnemyMinimumPresence: true,
        disableDefaultStarters: true,
      });
      capabilityBattle.start(node);
      capabilityBattle.arenaDeploy("player", groundWreckTemplate.id, { chargeGas: false, ignoreCap: true });
      const capabilityUnit = capabilityBattle.getState().units.find((unit) => unit.templateId === groundWreckTemplate.id && unit.side === "player");
      if (!capabilityUnit) {
        failures.push({ templateId: groundWreckTemplate.id, templateName: groundWreckTemplate.name, check: "wreck-lifecycle", detail: `failed to create missing-${missingCapability} wreck fixture` });
        continue;
      }
      for (const attachment of capabilityUnit.attachments) {
        if (COMPONENTS[attachment.component].type === missingCapability) {
          attachment.alive = false;
        }
      }
      capabilityBattle.update(dt, idleKeys);
      if (capabilityUnit.groundWreckTimerS === null || canOperate(capabilityUnit)) {
        failures.push({
          templateId: groundWreckTemplate.id,
          templateName: groundWreckTemplate.name,
          check: "wreck-lifecycle",
          detail: `ground craft missing its ${missingCapability} did not enter the non-operational wreck countdown`,
        });
      }
    }
  }

  const bastionTemplate = templates.find((template) => template.id === 1);
  const bastion = bastionTemplate
    ? instantiateUnit(templates, bastionTemplate.id, "player", 640, 500, { partCatalog })
    : null;
  const bastionFrontSecondRow = bastion
    ? bastion.structure
      .filter((cell) => cell.y === 0)
      .sort((left, right) => right.x - left.x)[0] ?? null
    : null;
  if (!bastionTemplate || !bastion || !bastionFrontSecondRow) {
    failures.push({
      templateId: 1,
      templateName: bastionTemplate?.name ?? "tank",
      check: "structure-origin",
      detail: "failed to create tank second-row origin fixture",
    });
  } else {
    const beforePosition = { x: bastion.x, y: bastion.y };
    const beforeCoordinates = new Map(bastion.structure.map((cell) => [cell.id, `${cell.x},${cell.y}`]));
    const survivingSecondRow = bastion.structure.filter((cell) => cell.y === 0 && cell.id !== bastionFrontSecondRow.id);
    const beforeWorldCenters = new Map(
      survivingSecondRow.map((cell) => [cell.id, battle.getStructureCellWorldCenter(bastion, cell.id)]),
    );
    destroyCell(bastion, bastionFrontSecondRow.id);
    const coordinatesChanged = bastion.structure.some((cell) => beforeCoordinates.get(cell.id) !== `${cell.x},${cell.y}`);
    const rowShifted = survivingSecondRow.some((cell) => {
      const before = beforeWorldCenters.get(cell.id);
      const after = battle.getStructureCellWorldCenter(bastion, cell.id);
      return !before || !after || Math.abs(before.x - after.x) > 1e-6 || Math.abs(before.y - after.y) > 1e-6;
    });
    if (bastion.x !== beforePosition.x || bastion.y !== beforePosition.y || coordinatesChanged || rowShifted) {
      failures.push({
        templateId: bastionTemplate.id,
        templateName: bastionTemplate.name,
        check: "structure-origin",
        detail: "destroying the front cell of the second row changed the craft position, local coordinates, or surviving weapon geometry",
      });
    }
    // The canonical tank now has more than one weapon. Disable every surviving
    // weapon explicitly so this fixture tests escape-facing behavior rather
    // than depending on which structure cell happens to support the last gun.
    for (const weaponAttachmentId of bastion.weaponAttachmentIds) {
      const weaponAttachment = bastion.attachments.find((attachment) => attachment.id === weaponAttachmentId);
      if (weaponAttachment) weaponAttachment.alive = false;
    }
    const facingBeforeWreck = bastion.facing;
    battle.getState().units.push(bastion);
    battle.update(dt, idleKeys);
    if (bastion.groundWreckTimerS === null || bastion.escapeActive || bastion.facing !== facingBeforeWreck) {
      failures.push({
        templateId: bastionTemplate.id,
        templateName: bastionTemplate.name,
        check: "structure-origin",
        detail: "weapon-loss wreck transition changed facing, started escape, or failed to begin its destruction countdown",
      });
    }
  }

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
    let firstMovementSpeed = 0;
    for (let i = 0; i < 120; i += 1) {
      battle.update(dt, moveRightKeys);
      if (i === 0) {
        firstMovementSpeed = Math.hypot(unit.vx, unit.vy);
      }
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
    if (unit.type === "air") {
      const rightSpeed = Math.hypot(unit.vx, unit.vy);
      const commandedSpeed = unit.maxSpeed * battle.getMovementSpeedMultiplier();
      battle.update(dt, idleKeys);
      const deceleratedSpeed = Math.hypot(unit.vx, unit.vy);
      if (
        firstMovementSpeed <= 0
        || firstMovementSpeed >= commandedSpeed
        || deceleratedSpeed >= rightSpeed
        || deceleratedSpeed <= 0
      ) {
        failures.push({
          templateId: template.id,
          templateName: template.name,
          check: "air-inertia",
          detail: `expected gradual acceleration and idle deceleration: first=${firstMovementSpeed.toFixed(2)}, commanded=${commandedSpeed.toFixed(2)}, cruising=${rightSpeed.toFixed(2)}, decelerated=${deceleratedSpeed.toFixed(2)}, accel=${unit.accel.toFixed(2)}`,
        });
      }
      battle.update(dt, moveUpKeys);
      const upUnit = battle.getState().units.find((entry) => entry.id === unitId);
      const upSpeed = upUnit ? Math.hypot(upUnit.vx, upUnit.vy) : 0;
      battle.update(dt, moveUpRightKeys);
      const diagonalUnit = battle.getState().units.find((entry) => entry.id === unitId);
      const diagonalSpeed = diagonalUnit ? Math.hypot(diagonalUnit.vx, diagonalUnit.vy) : 0;
      // Direction changes now rotate the velocity vector through finite thrust,
      // so compare magnitudes with enough tolerance for the brief turn transient.
      const tolerance = Math.max(0.1, rightSpeed * 0.08);
      if (Math.abs(rightSpeed - upSpeed) > tolerance || Math.abs(rightSpeed - diagonalSpeed) > tolerance) {
        failures.push({
          templateId: template.id,
          templateName: template.name,
          check: "air-isotropic",
          detail: `directional speeds differ: right=${rightSpeed.toFixed(2)}, up=${upSpeed.toFixed(2)}, diagonal=${diagonalSpeed.toFixed(2)}`,
        });
      }
    }
    for (let slot = 0; slot < unit.weaponAttachmentIds.length; slot += 1) {
      const attachment = unit.attachments.find((entry) => entry.id === unit.weaponAttachmentIds[slot]);
      const weaponPart = partCatalog.find((part) => part.id === attachment?.partId);
      const capacity = weaponPart?.partProperties?.maxCapacity ?? (attachment ? COMPONENTS[attachment.component].maxLoadedAmmo : undefined);
      if (capacity !== undefined && (unit.weaponReadyCharges[slot] ?? 0) !== capacity) {
        failures.push({
          templateId: template.id,
          templateName: template.name,
          check: "weapon-capacity",
          detail: `slot ${slot + 1} starts with ${unit.weaponReadyCharges[slot]} loaded rounds instead of weapon capacity ${capacity}`,
        });
      }
    }
    const movedDistance = unit.x - startX;
    const movementThreshold = Math.max(2.5, unit.maxSpeed * 0.08);
    if (movedDistance < movementThreshold) {
      failures.push({
        templateId: template.id,
        templateName: template.name,
        check: "movement",
        detail: `moved too little: ${movedDistance.toFixed(2)} (min=${movementThreshold.toFixed(2)}, startX=${startX.toFixed(2)}, endX=${unit.x.toFixed(2)}, mass=${unit.mass.toFixed(2)}, maxSpeed=${unit.maxSpeed.toFixed(2)})`,
      });
    }

    const fireLogNeedle = `${unit.name} fired weapon #`;
    const logCountBefore = logs.filter((line) => line.includes(fireLogNeedle)).length;
    let projectileSeen = false;
    const base = battle.getState().enemyBase;
    const aimX = base.x + base.w * 0.5;
    const aimY = base.y + base.h * 0.5;
    battle.clearControlSelection();
    battle.setControlByClick(unit.x, unit.y);
    battle.setAim(aimX, aimY);
    battle.handleLeftPointerDown(unit.x, unit.y);
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

  const overlapTemplate = testTemplates.find((template) => template.type === "ground") ?? testTemplates[0] ?? null;
  if (overlapTemplate) {
    const overlapLogs: string[] = [];
    const overlapBattle = new BattleSession(canvas, makeHooks(overlapLogs), templates, {
      partCatalog,
      disableAutoEnemySpawns: true,
      disableEnemyMinimumPresence: true,
      disableDefaultStarters: true,
    });
    overlapBattle.start(node);

    const deployA = overlapBattle.arenaDeploy("player", overlapTemplate.id, {
      chargeGas: false,
      deploymentGasCost: 0,
      ignoreCap: true,
      y: overlapBattle.getBattlefieldInfo().laneBounds.groundMinY + 20,
    });
    const deployB = overlapBattle.arenaDeploy("player", overlapTemplate.id, {
      chargeGas: false,
      deploymentGasCost: 0,
      ignoreCap: true,
      y: overlapBattle.getBattlefieldInfo().laneBounds.groundMinY + 20,
    });
    if (!deployA || !deployB) {
      failures.push({
        templateId: overlapTemplate.id,
        templateName: overlapTemplate.name,
        check: "overlap",
        detail: "failed to deploy overlap test units",
      });
    } else {
      const stacked = overlapBattle.getState().units
        .filter((unit) => unit.side === "player" && unit.templateId === overlapTemplate.id)
        .slice(-2);
      if (stacked.length < 2) {
        failures.push({
          templateId: overlapTemplate.id,
          templateName: overlapTemplate.name,
          check: "overlap",
          detail: "could not identify two spawned units for overlap test",
        });
      } else {
        const [a, b] = stacked;
        const forcedX = 320;
        const forcedY = overlapBattle.getBattlefieldInfo().laneBounds.groundMinY + 24;
        a.x = forcedX;
        a.y = forcedY;
        b.x = forcedX;
        b.y = forcedY;
        a.vx = 0;
        a.vy = 0;
        b.vx = 0;
        b.vy = 0;

        for (let i = 0; i < 20; i += 1) {
          overlapBattle.update(dt, idleKeys);
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const finalDistance = Math.hypot(dx, dy);
        const minAllowed = (a.radius + b.radius) - Math.min(a.radius, b.radius) * UNIT_OVERLAP_ALLOWANCE_RATIO;
        if (finalDistance < minAllowed * 0.92) {
          failures.push({
            templateId: overlapTemplate.id,
            templateName: overlapTemplate.name,
            check: "overlap",
            detail: `units stayed too overlapped after resolution: distance=${finalDistance.toFixed(2)}, minAllowed=${minAllowed.toFixed(2)}`,
          });
        }
      }
    }
  }

  const loaderTemplateSource = templates.find((template) => template.id === 5);
  const loaderWeaponPart = partCatalog.find((part) => part.name === "cannons");
  const matchingLoaderPart = partCatalog.find((part) => part.name === "cannons reloader");
  const loaderTemplate = loaderTemplateSource && loaderWeaponPart && matchingLoaderPart
    ? {
        ...loaderTemplateSource,
        id: 999_014,
        name: "Headless Loader Escape Craft",
        // Keep this loader-specific fixture independent from later edits to the
        // compact default attack-aircraft footprint.
        structure: [
          { partId: 10, x: -1, y: -1 },
          { partId: 10, x: 0, y: -1 },
          { partId: 10, x: -2, y: 0 },
          { partId: 10, x: -1, y: 0 },
          { partId: 10, x: 0, y: 0 },
          { partId: 10, x: 1, y: 0 },
          { partId: 10, x: 2, y: 0 },
          { partId: 10, x: -2, y: 1 },
          { partId: 10, x: -1, y: 1 },
          { partId: 10, x: 0, y: 1 },
          { partId: 10, x: 1, y: 1 },
          { partId: 10, x: 2, y: 1 },
        ],
        attachments: [
          { component: "jetEngine", partId: 14, cell: 2, x: -2, y: 0, rotateQuarter: 0 },
          { component: "control", partId: 3, cell: 4, x: 0, y: 0, rotateQuarter: 0 },
          { component: matchingLoaderPart.baseComponent, partId: matchingLoaderPart.id, cell: 1, x: 0, y: -1, rotateQuarter: 0 },
          { component: loaderWeaponPart.baseComponent, partId: loaderWeaponPart.id, cell: 10, x: 1, y: 1, rotateQuarter: 0 },
        ],
      } satisfies UnitTemplate
    : undefined;
  const airTemplate = templates.find((template) => template.id === 4);
  if (loaderTemplate && airTemplate) {
    const escapeBattle = new BattleSession(canvas, makeHooks([]), [...templates, loaderTemplate], {
      partCatalog,
      disableAutoEnemySpawns: true,
      disableEnemyMinimumPresence: true,
      disableDefaultStarters: true,
    });
    escapeBattle.start(node);
    escapeBattle.arenaDeploy("player", loaderTemplate.id, { chargeGas: false, ignoreCap: true });
    const loaderUnit = escapeBattle.getState().units.find((unit) => unit.templateId === loaderTemplate.id && unit.side === "player");
    if (!loaderUnit) {
      failures.push({ templateId: loaderTemplate.id, templateName: loaderTemplate.name, check: "escape-mode", detail: "failed to deploy loader-loss fixture" });
    } else {
      escapeBattle.setControlByClick(loaderUnit.x, loaderUnit.y);
      loaderUnit.weaponReadyCharges.fill(0);
      escapeBattle.update(dt, idleKeys);
      if (!loaderUnit.loaderStates.some((loader) => loader.targetWeaponSlot !== null)) {
        failures.push({ templateId: loaderTemplate.id, templateName: loaderTemplate.name, check: "weapon-capacity", detail: "matching weapon and loader bulletName did not start loading" });
      }
      const mismatchedLoaderPart = partCatalog.find((part) => part.name === "anti-tank gun reloader");
      for (const loader of loaderUnit.attachments.filter((attachment) => COMPONENTS[attachment.component].type === "loader")) {
        if (mismatchedLoaderPart) {
          loader.partId = mismatchedLoaderPart.id;
        }
      }
      escapeBattle.update(dt, idleKeys);
      if (!loaderUnit.escapeActive || escapeBattle.getSelection().playerControlledId === loaderUnit.id) {
        failures.push({ templateId: loaderTemplate.id, templateName: loaderTemplate.name, check: "escape-mode", detail: "exhausted weapon with a mismatched loader bulletName did not enter uncontrollable escape mode" });
      }
    }

    const weaponLossBattle = new BattleSession(canvas, makeHooks([]), templates, {
      partCatalog,
      disableAutoEnemySpawns: true,
      disableEnemyMinimumPresence: true,
      disableDefaultStarters: true,
    });
    weaponLossBattle.start(node);
    weaponLossBattle.arenaDeploy("player", airTemplate.id, { chargeGas: false, ignoreCap: true });
    const airUnit = weaponLossBattle.getState().units.find((unit) => unit.templateId === airTemplate.id && unit.side === "player");
    if (!airUnit) {
      failures.push({ templateId: airTemplate.id, templateName: airTemplate.name, check: "escape-mode", detail: "failed to deploy destroyed-weapon fixture" });
    } else {
      weaponLossBattle.setControlByClick(airUnit.x, airUnit.y);
      for (const weapon of airUnit.attachments.filter((attachment) => COMPONENTS[attachment.component].type === "weapon")) weapon.alive = false;
      weaponLossBattle.update(dt, idleKeys);
      if (!airUnit.escapeActive || airUnit.airDropActive || weaponLossBattle.getSelection().playerControlledId === airUnit.id) {
        failures.push({ templateId: airTemplate.id, templateName: airTemplate.name, check: "escape-mode", detail: "aircraft with destroyed weapons did not enter non-crashing, uncontrollable escape mode" });
      }
    }

    const controlLossBattle = new BattleSession(canvas, makeHooks([]), templates, {
      partCatalog,
      disableAutoEnemySpawns: true,
      disableEnemyMinimumPresence: true,
      disableDefaultStarters: true,
    });
    controlLossBattle.start(node);
    controlLossBattle.arenaDeploy("player", airTemplate.id, { chargeGas: false, ignoreCap: true });
    const controlLossUnit = controlLossBattle.getState().units.find((unit) => unit.templateId === airTemplate.id && unit.side === "player");
    if (!controlLossUnit) {
      failures.push({ templateId: airTemplate.id, templateName: airTemplate.name, check: "control-loss-crash", detail: "failed to deploy aircraft control-loss fixture" });
    } else {
      const control = controlLossUnit.attachments.find((attachment) => COMPONENTS[attachment.component].type === "control");
      if (!control) {
        failures.push({ templateId: airTemplate.id, templateName: airTemplate.name, check: "control-loss-crash", detail: "aircraft fixture has no control attachment" });
      } else {
        controlLossBattle.setControlByClick(controlLossUnit.x, controlLossUnit.y);
        const startX = controlLossUnit.x;
        const startY = controlLossUnit.y;
        control.alive = false;
        controlLossBattle.update(dt, idleKeys);
        const beganVerticalDrop = controlLossUnit.airDropActive
          && controlLossUnit.y > startY
          && Math.abs(controlLossUnit.x - startX) < 1e-6
          && controlLossBattle.getSelection().playerControlledId !== controlLossUnit.id;
        for (let frame = 0; frame < 600 && controlLossUnit.alive; frame += 1) {
          controlLossBattle.update(dt, idleKeys);
        }
        if (!beganVerticalDrop || controlLossUnit.alive) {
          failures.push({
            templateId: airTemplate.id,
            templateName: airTemplate.name,
            check: "control-loss-crash",
            detail: `controller loss did not produce a direct destructive fall: beganVerticalDrop=${beganVerticalDrop}, alive=${controlLossUnit.alive}`,
          });
        }
      }
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
