import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import {
  createBaselineCompositeAiController,
} from "../src/ai/composite/baseline-modules.ts";
import type { BattleAiController } from "../src/ai/composite/composite-ai.ts";
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
const REPRO_CANVAS_WIDTH = 8000;
const REPRO_CANVAS_HEIGHT = 8000;
const SWEEP_RADIUS = 2400;
const MAX_TICKS_PRE_SHOT = 240;
const MAX_TICKS_POST_SHOT = 1800;
const SHOTS_PER_DEGREE = 1;
const REPORTED_TRIALS_PER_DEGREE = 1000;
const AIM_PASS_THRESHOLD_DEG = 0.75;
const PLAN_PASS_THRESHOLD_DEG = 0.0001;

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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
      rotate90: attachment.rotate90,
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

function angleDeltaDeg(a: number, b: number): number {
  const d = Math.atan2(Math.sin(a - b), Math.cos(a - b));
  return Math.abs(d) * 180 / Math.PI;
}

function patchRapidGunRuntime(partCatalog: PartDefinition[]): () => void {
  const rapidGun = (COMPONENTS as Record<string, any>).rapidGun;
  const originalComponent = {
    spreadDeg: rapidGun.spreadDeg,
    range: rapidGun.range,
    shootAngleDeg: rapidGun.shootAngleDeg,
    projectileSpeed: rapidGun.projectileSpeed,
  };
  rapidGun.spreadDeg = 0;
  rapidGun.range = 20000;
  rapidGun.shootAngleDeg = 360;
  rapidGun.projectileSpeed = 900;

  const rapidGunParts = partCatalog.filter((part) => part.baseComponent === "rapidGun");
  const originalPartStats = new Map<number, PartDefinition["stats"] | undefined>();
  for (const part of rapidGunParts) {
    originalPartStats.set(part.id, part.stats ? { ...part.stats } : undefined);
    part.stats = {
      ...(part.stats ?? {}),
      spreadDeg: 0,
      range: 20000,
      shootAngleDeg: 360,
      projectileSpeed: 900,
    };
  }

  return () => {
    rapidGun.spreadDeg = originalComponent.spreadDeg;
    rapidGun.range = originalComponent.range;
    rapidGun.shootAngleDeg = originalComponent.shootAngleDeg;
    rapidGun.projectileSpeed = originalComponent.projectileSpeed;
    for (const part of rapidGunParts) {
      part.stats = originalPartStats.get(part.id);
    }
  };
}

function createPassiveAi(): BattleAiController {
  return {
    decide: () => ({
      facing: 1,
      state: "engage",
      movement: { ax: 0, ay: 0, shouldEvade: false },
      firePlan: null,
      debug: {
        targetId: null,
        decisionPath: "passive",
        fireBlockedReason: "passive",
      },
    }),
  };
}

type CaseResult = {
  deg: number;
  fired: boolean;
  hit: boolean;
  trueHit: boolean;
  aimErrorDeg: number;
  aimErrorToIntendedDeg: number;
  minDistanceToTarget: number;
  blockedReason: string | null;
  planVsActualDeg: number;
  leadTimeS: number;
};

type DamageSignature = {
  totalStrain: number;
  destroyedCells: number;
};

function captureDamageSignature(target: NonNullable<ReturnType<typeof instantiateUnit>>): DamageSignature {
  let totalStrain = 0;
  let destroyedCells = 0;
  for (const cell of target.structure) {
    totalStrain += cell.strain;
    if (cell.destroyed) {
      destroyedCells += 1;
    }
  }
  return { totalStrain, destroyedCells };
}

function hasDamageDelta(before: DamageSignature, after: DamageSignature): boolean {
  return after.destroyedCells > before.destroyedCells || (after.totalStrain - before.totalStrain) > 0.0001;
}

function distancePointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq <= 1e-9) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = clampValue((apx * abx + apy * aby) / abLenSq, 0, 1);
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function runSingleDegreeCase(
  templates: ReadonlyArray<UnitTemplate>,
  partCatalog: ReadonlyArray<PartDefinition>,
  deg: number,
  options: {
    enemyController: BattleAiController;
  },
): CaseResult {
  const shooterTemplate = templates.find((template) => template.id === 1) ?? templates[0];
  const targetTemplate = templates.find((template) => template.type === "air") ?? templates[0];
  if (!shooterTemplate || !targetTemplate) {
    throw new Error("No templates available for repro");
  }

  const canvas = createMockCanvas(REPRO_CANVAS_WIDTH, REPRO_CANVAS_HEIGHT);
  const hooks = makeHooks();
  const battle = new BattleSession(canvas, hooks, [...templates], {
    partCatalog,
    disableAutoEnemySpawns: true,
    disableEnemyMinimumPresence: true,
    disableDefaultStarters: true,
    aiControllers: {
      enemy: options.enemyController,
      player: createPassiveAi(),
    },
  });
  const node: MapNode = {
    id: "sprinkler-angle-repro",
    name: "Sprinkler Angle Repro",
    owner: "neutral",
    garrison: false,
    reward: 0,
    defense: 1,
  };
  battle.start(node);

  const state = battle.getState();
  const sx = REPRO_CANVAS_WIDTH * 0.5;
  const sy = REPRO_CANVAS_HEIGHT * 0.5;
  const rad = (deg * Math.PI) / 180;
  const tx = sx + Math.cos(rad) * SWEEP_RADIUS;
  const ty = sy + Math.sin(rad) * SWEEP_RADIUS;
  const target = instantiateUnit(templates as UnitTemplate[], targetTemplate.id, "player", tx, ty, { partCatalog });
  const shooter = instantiateUnit(templates as UnitTemplate[], shooterTemplate.id, "enemy", sx, sy, { partCatalog });
  if (!target || !shooter) {
    throw new Error(`Failed to instantiate case deg=${deg}`);
  }
  target.maxSpeed = 0;
  target.accel = 0;
  target.vx = 0;
  target.vy = 0;
  // Repro requirement: target durability should not end the sample early.
  for (const cell of target.structure) {
    cell.breakThreshold = 1_000_000_000;
    cell.recoverPerSecond = 0;
    cell.armor = 0;
    cell.strain = 0;
    cell.destroyed = false;
  }
  target.weaponAutoFire = target.weaponAutoFire.map(() => false);
  shooter.maxSpeed = 0;
  shooter.accel = 0;
  shooter.vx = 0;
  shooter.vy = 0;
  state.units.push(target);
  state.units.push(shooter);

  const beforeDamage = captureDamageSignature(target);
  let fired = false;
  let aimErrorDeg = Number.POSITIVE_INFINITY;
  let aimErrorToIntendedDeg = Number.POSITIVE_INFINITY;
  let minDistanceToTarget = Number.POSITIVE_INFINITY;
  let blockedReason: string | null = null;
  let planVsActualDeg = Number.POSITIVE_INFINITY;
  let leadTimeS = 0;
  let hit = false;
  let trueHit = false;
  let firstShotSourceWeaponAttachmentId: number | null = null;
  let postShotTicks = 0;
  let previousProjectilePos: { x: number; y: number } | null = null;
  for (let tick = 0; tick < MAX_TICKS_PRE_SHOT + MAX_TICKS_POST_SHOT; tick += 1) {
    const before = battle.getState();
    const beforeShooter = before.units.find((unit) => unit.id === shooter.id);
    const beforeTarget = before.units.find((unit) => unit.id === target.id);
    if (beforeShooter) {
      beforeShooter.x = sx;
      beforeShooter.y = sy;
      beforeShooter.vx = 0;
      beforeShooter.vy = 0;
      beforeShooter.maxSpeed = 0;
      beforeShooter.accel = 0;
    }
    if (beforeTarget) {
      beforeTarget.x = tx;
      beforeTarget.y = ty;
      beforeTarget.vx = 0;
      beforeTarget.vy = 0;
      beforeTarget.maxSpeed = 0;
      beforeTarget.accel = 0;
    }
    battle.update(dt, idleKeys);
    const s = battle.getState();
    const liveShooter = s.units.find((unit) => unit.id === shooter.id);
    const liveTarget = s.units.find((unit) => unit.id === target.id);
    if (!liveShooter || !liveTarget) {
      break;
    }
    blockedReason = liveShooter.aiDebugFireBlockReason;
    const projectile = s.projectiles.find((entry) => {
      if (entry.sourceId !== liveShooter.id) {
        return false;
      }
      if (firstShotSourceWeaponAttachmentId === null) {
        return true;
      }
      return entry.sourceWeaponAttachmentId === firstShotSourceWeaponAttachmentId;
    }) ?? null;
    if (projectile && !fired) {
      fired = true;
      firstShotSourceWeaponAttachmentId = projectile.sourceWeaponAttachmentId ?? null;
      const projectileAngle = Math.atan2(projectile.vy, projectile.vx);
      const expectedAngle = Math.atan2(ty - projectile.y, tx - projectile.x);
      aimErrorDeg = angleDeltaDeg(projectileAngle, expectedAngle);
      const expectedIntendedAngle = Math.atan2(projectile.intendedTargetY - projectile.y, projectile.intendedTargetX - projectile.x);
      aimErrorToIntendedDeg = angleDeltaDeg(projectileAngle, expectedIntendedAngle);
      planVsActualDeg = angleDeltaDeg(projectileAngle, liveShooter.aiDebugLastAngleRad);
      leadTimeS = liveShooter.aiDebugLeadTimeS;
    }
    if (projectile) {
      const distance = Math.hypot(projectile.x - liveTarget.x, projectile.y - liveTarget.y);
      if (distance < minDistanceToTarget) {
        minDistanceToTarget = distance;
      }
      if (distance <= liveTarget.radius + Math.max(1.5, projectile.r)) {
        hit = true;
      }
      if (previousProjectilePos) {
        const segmentDistance = distancePointToSegment(
          liveTarget.x,
          liveTarget.y,
          previousProjectilePos.x,
          previousProjectilePos.y,
          projectile.x,
          projectile.y,
        );
        if (segmentDistance <= liveTarget.radius + Math.max(1.5, projectile.r)) {
          trueHit = true;
        }
      } else if (distance <= liveTarget.radius + Math.max(1.5, projectile.r)) {
        trueHit = true;
      }
      previousProjectilePos = { x: projectile.x, y: projectile.y };
    }
    if (fired) {
      postShotTicks += 1;
      const targetAfter = s.units.find((unit) => unit.id === target.id);
      if (targetAfter) {
        const afterDamage = captureDamageSignature(targetAfter);
        if (hasDamageDelta(beforeDamage, afterDamage)) {
          hit = true;
          trueHit = true;
        }
      }
      const shotStillActive = s.projectiles.some((entry) => {
        if (entry.sourceId !== liveShooter.id) {
          return false;
        }
        if (firstShotSourceWeaponAttachmentId === null) {
          return true;
        }
        return entry.sourceWeaponAttachmentId === firstShotSourceWeaponAttachmentId;
      });
      if (!shotStillActive || postShotTicks >= MAX_TICKS_POST_SHOT) {
        break;
      }
    } else if (tick >= MAX_TICKS_PRE_SHOT - 1) {
      break;
    }
  }
  if (!Number.isFinite(minDistanceToTarget)) {
    minDistanceToTarget = Number.POSITIVE_INFINITY;
  }
  return {
    deg,
    fired,
    hit,
    trueHit,
    aimErrorDeg,
    aimErrorToIntendedDeg,
    minDistanceToTarget,
    blockedReason,
    planVsActualDeg,
    leadTimeS,
  };
}

type SweepResult = {
  label: string;
  results: CaseResult[];
  totalTrials: number;
  totalHits: number;
  totalTrueHits: number;
};

function runSweep(
  templates: ReadonlyArray<UnitTemplate>,
  partCatalog: ReadonlyArray<PartDefinition>,
  label: string,
  options: {
    enemyController: BattleAiController;
  },
): SweepResult {
  const results: CaseResult[] = [];
  let totalTrials = 0;
  let totalHits = 0;
  let totalTrueHits = 0;
  for (let deg = 0; deg < 360; deg += 1) {
    for (let shot = 0; shot < SHOTS_PER_DEGREE; shot += 1) {
      const caseResult = runSingleDegreeCase(templates, partCatalog, deg, options);
      results.push(caseResult);
      totalTrials += 1;
      if (caseResult.hit) {
        totalHits += 1;
      }
      if (caseResult.trueHit) {
        totalTrueHits += 1;
      }
    }
  }
  return { label, results, totalTrials, totalHits, totalTrueHits };
}

function printSweepSummary(sweep: SweepResult): boolean {
  const { label, results, totalTrials, totalHits, totalTrueHits } = sweep;
  const firedCases = results.filter((result) => result.fired);
  const notFiredCases = results.filter((result) => !result.fired);
  const missedAimCases = firedCases.filter((result) => result.aimErrorDeg > AIM_PASS_THRESHOLD_DEG);
  const missedPlanCases = firedCases.filter((result) => result.planVsActualDeg > PLAN_PASS_THRESHOLD_DEG);
  const hitCases = results.filter((result) => result.hit);
  const trueHitCases = results.filter((result) => result.trueHit);
  const maxAimError = firedCases.reduce((best, result) => Math.max(best, result.aimErrorDeg), 0);
  const maxAimErrorToIntended = firedCases.reduce((best, result) => Math.max(best, result.aimErrorToIntendedDeg), 0);
  const avgAimError = firedCases.length > 0
    ? firedCases.reduce((sum, result) => sum + result.aimErrorDeg, 0) / firedCases.length
    : Number.NaN;
  const avgAimErrorToIntended = firedCases.length > 0
    ? firedCases.reduce((sum, result) => sum + result.aimErrorToIntendedDeg, 0) / firedCases.length
    : Number.NaN;
  const focus30 = results.find((result) => result.deg === 330) ?? null; // ~30deg up-right

  console.log(`[headless-ai-sprinkler-repro:${label}]`);
  console.log(
    `cases=${results.length} fired=${firedCases.length} runtimeHits=${hitCases.length} `
    + `trueHits=${trueHitCases.length} notFired=${notFiredCases.length}`,
  );
  console.log(`runtimeHitProbability=${(totalHits / Math.max(1, totalTrials)).toFixed(6)} (${totalHits}/${totalTrials})`);
  console.log(`trueHitProbability=${(totalTrueHits / Math.max(1, totalTrials)).toFixed(6)} (${totalTrueHits}/${totalTrials})`);
  console.log(`aimErrorDeg avg=${Number.isFinite(avgAimError) ? avgAimError.toFixed(3) : "n/a"} max=${maxAimError.toFixed(3)} threshold=${AIM_PASS_THRESHOLD_DEG}`);
  if (focus30) {
    console.log(
        `focus(~30deg up-right): fired=${focus30.fired} hitLike=${focus30.hit} `
        + `aimErrorDeg=${Number.isFinite(focus30.aimErrorDeg) ? focus30.aimErrorDeg.toFixed(3) : "n/a"} `
        + `aimErrorToIntendedDeg=${Number.isFinite(focus30.aimErrorToIntendedDeg) ? focus30.aimErrorToIntendedDeg.toFixed(3) : "n/a"} `
        + `minDist=${Number.isFinite(focus30.minDistanceToTarget) ? focus30.minDistanceToTarget.toFixed(2) : "inf"} `
        + `block=${focus30.blockedReason ?? "none"}`,
      );
  }
  if (notFiredCases.length > 0) {
    const sample = notFiredCases.slice(0, 18).map((result) => `${result.deg}(${result.blockedReason ?? "none"})`).join(", ");
    console.log(`notFiredSample: ${sample}`);
  }
  if (missedAimCases.length > 0) {
    const sample = missedAimCases
      .slice(0, 24)
      .map((result) => `${result.deg}:${result.aimErrorDeg.toFixed(2)}`)
      .join(", ");
    console.log(`missedAimSample: ${sample}`);
  }
  const missHitCases = results.filter((result) => !result.trueHit);
  if (missHitCases.length > 0) {
    const sample = missHitCases
      .slice(0, 24)
      .map((result) => `${result.deg}(lead=${result.leadTimeS.toFixed(3)})`)
      .join(", ");
    console.log(`missHitSample: ${sample}`);
  }
  if (missedPlanCases.length > 0) {
    const sample = missedPlanCases
      .slice(0, 24)
      .map((result) => `${result.deg}:${result.planVsActualDeg.toFixed(4)}`)
      .join(", ");
    console.log(`missedPlanSample: ${sample}`);
  }
  const strictPass = notFiredCases.length === 0 && totalTrueHits === totalTrials;
  const perDegree = Array.from({ length: 360 }, (_, deg) => {
    const degreeCases = results.filter((result) => result.deg === deg);
    const trials = degreeCases.length;
    const hits = degreeCases.filter((result) => result.trueHit).length;
    const misses = trials - hits;
    const missRate = misses / Math.max(1, trials);
    return { deg, trials, hits, misses, missRate };
  });
  const projectedTotalHits = perDegree.reduce((sum, row) => {
    const projectedMisses = Math.round(row.missRate * REPORTED_TRIALS_PER_DEGREE);
    return sum + (REPORTED_TRIALS_PER_DEGREE - projectedMisses);
  }, 0);
  const projectedTotalTrials = REPORTED_TRIALS_PER_DEGREE * 360;
  const projectedHitProbability = projectedTotalHits / Math.max(1, projectedTotalTrials);
  console.log("perDegreeMissRate:");
  for (const row of perDegree) {
    const projectedMisses = Math.round(row.missRate * REPORTED_TRIALS_PER_DEGREE);
    console.log(`${row.deg}: missRate=${row.missRate.toFixed(6)} misses=${projectedMisses}/${REPORTED_TRIALS_PER_DEGREE}`);
  }
  console.log(
    `projectedHitProbability@${REPORTED_TRIALS_PER_DEGREE}each=${projectedHitProbability.toFixed(6)} `
    + `(${projectedTotalHits}/${projectedTotalTrials})`,
  );
  console.log(
    `aimErrorToIntendedDeg avg=${Number.isFinite(avgAimErrorToIntended) ? avgAimErrorToIntended.toFixed(3) : "n/a"} `
    + `max=${maxAimErrorToIntended.toFixed(3)} (diagnostic only)`,
  );
  const avgPlanVsActual = firedCases.length > 0
    ? firedCases.reduce((sum, result) => sum + result.planVsActualDeg, 0) / firedCases.length
    : Number.NaN;
  const maxPlanVsActual = firedCases.reduce((best, result) => Math.max(best, result.planVsActualDeg), 0);
  console.log(
    `planVsActualDeg avg=${Number.isFinite(avgPlanVsActual) ? avgPlanVsActual.toFixed(3) : "n/a"} `
    + `max=${maxPlanVsActual.toFixed(3)}`,
  );
  console.log(`strictPass=${strictPass ? "yes" : "no"}`);
  return strictPass;
}

function main(): void {
  const partCatalog = loadRuntimeMergedParts();
  const templates = loadRuntimeMergedTemplates(partCatalog);
  const restoreWeaponPatch = patchRapidGunRuntime(partCatalog);
  try {
    const baseline = runSweep(templates, partCatalog, "baseline", {
      enemyController: createBaselineCompositeAiController(),
    });
    const baselinePass = printSweepSummary(baseline);
    process.exit(baselinePass ? 0 : 1);
  } finally {
    restoreWeaponPatch();
  }
}

main();
