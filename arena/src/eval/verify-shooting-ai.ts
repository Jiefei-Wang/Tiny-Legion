import { createCompositeAiController, type BattleAiController, type ShootAiModule } from "../../../game-core/src/ai/composite/composite-ai.ts";
import { createUnifiedTargetShootAi } from "../../../game-core/src/ai/shooting/unified-target-shoot.ts";
import { createUnifiedLevelShootAi, UNIFIED_LEVEL_ACCURACY } from "../../../game-core/src/ai/shooting/unified-level-shoot.ts";
import { solveBallisticAim } from "../../../game-core/src/ai/shooting/ballistic-aim.ts";
import { BattleSession, type BattleHooks } from "../../../game-core/src/gameplay/battle/battle-session.ts";
import { instantiateUnit } from "../../../game-core/src/simulation/units/unit-builder.ts";
import { COMPONENTS } from "../../../game-core/src/config/balance/weapons.ts";
import type { KeyState, MapNode, PartDefinition, UnitInstance, UnitTemplate } from "../../../game-core/src/types.ts";
import { mulberry32, setMathRandomSeed } from "../lib/seeded-rng.ts";
import { loadRuntimeMergedParts, loadRuntimeMergedTemplates } from "../match/templates.ts";

const DT = 1 / 60;
const BATTLEFIELD_SIZE = 30_000;
const MAX_RANGE = 2_000;
const MAX_TARGET_SPEED = 100;
const IDLE_KEYS: KeyState = { a: false, d: false, w: false, s: false, space: false };

type TrialSpec = {
  seed: number;
  distance: number;
  bearing: number;
  targetSpeed: number;
  targetDirection: number;
};

type TrialResult = {
  hit: boolean;
  fireCount: number;
  reason: string;
  closestApproach: number;
  leadTimeS: number;
  spec: TrialSpec;
};

function createMockCanvas(): HTMLCanvasElement {
  return {
    width: BATTLEFIELD_SIZE,
    height: BATTLEFIELD_SIZE,
    getContext: (type: string) => type === "2d" ? ({} as CanvasRenderingContext2D) : null,
  } as HTMLCanvasElement;
}

function createHooks(): BattleHooks {
  return {
    addLog: () => {},
    getCommanderSkill: () => 99,
    getPlayerGas: () => 1_000_000,
    spendPlayerGas: () => true,
    addPlayerGas: () => {},
    onBattleOver: () => {},
  };
}

function makeShooterTemplate(base: UnitTemplate, weapon: PartDefinition): UnitTemplate {
  let replaced = false;
  const attachments = base.attachments.flatMap((attachment) => {
    const componentStats = COMPONENTS[attachment.component];
    const isWeapon = componentStats.type === "weapon";
    if (!isWeapon) return [attachment];
    if (replaced) return [];
    replaced = true;
    return [{
      ...attachment,
      component: weapon.baseComponent,
      partId: weapon.id,
      rotateQuarter: 0,
    }];
  });
  if (!replaced) throw new Error(`Shooter fixture ${base.name} has no replaceable weapon attachment`);
  return {
    ...base,
    id: 900_000 + weapon.id,
    name: `shoot-verification-${weapon.name}`,
    attachments,
  };
}

function createMovingTargetController(direction: number): BattleAiController {
  return {
    decide: () => ({
      facing: Math.cos(direction) >= 0 ? 1 : -1,
      state: "engage",
      movement: { ax: Math.cos(direction), ay: Math.sin(direction), shouldEvade: false },
      firePlan: null,
      firePlans: [],
      debug: { targetId: null, decisionPath: "verify.constant-velocity", fireBlockedReason: "verify-target" },
    }),
  };
}

function createOneShotController(targetId: string, shootModule: ShootAiModule): BattleAiController {
  let attempted = false;
  const oneShot: ShootAiModule = {
    decideShoot: (input, target, movement) => {
      if (attempted) {
        return { firePlan: null, firePlans: [], fireBlockedReason: "one-shot-complete", debugTag: "shoot.verify.complete" };
      }
      attempted = true;
      return shootModule.decideShoot(input, target, movement);
    },
  };
  return createCompositeAiController({
    target: {
      decideTarget: (input) => {
        const target = input.state.units.find((unit) => unit.id === targetId && unit.alive) ?? null;
        if (!target) return { rankedTargets: [], attackPoint: input.baseTarget, debugTag: "target.verify.missing" };
        return {
          rankedTargets: [{
            targetId: target.id,
            score: 1,
            x: target.x,
            y: target.y,
            vx: target.vx,
            vy: target.vy,
            type: target.type,
          }],
          attackPoint: { x: target.x, y: target.y },
          debugTag: "target.verify.given",
        };
      },
    },
    movement: {
      decideMovement: () => ({ ax: 0, ay: 0, shouldEvade: false, state: "engage", debugTag: "movement.verify.stationary" }),
    },
    shoot: oneShot,
  });
}

function hardenTarget(target: UnitInstance): void {
  for (const cell of target.structure) {
    cell.breakThreshold = 1_000_000_000;
    cell.recoverPerSecond = 0;
    cell.armor = 0;
    cell.strain = 0;
    cell.destroyed = false;
  }
  target.weaponAutoFire.fill(false);
}

function runTrial(
  templates: ReadonlyArray<UnitTemplate>,
  parts: ReadonlyArray<PartDefinition>,
  fixtureTemplate: UnitTemplate,
  weapon: PartDefinition,
  spec: TrialSpec,
  shootFactory: () => ShootAiModule = createUnifiedTargetShootAi,
): TrialResult {
  setMathRandomSeed(spec.seed);
  const shooterTemplate = makeShooterTemplate(fixtureTemplate, weapon);
  const battleTemplates = [...templates.filter((template) => template.id !== shooterTemplate.id), shooterTemplate];
  const battle = new BattleSession(createMockCanvas(), createHooks(), battleTemplates, {
    disableAutoEnemySpawns: true,
    disableEnemyMinimumPresence: true,
    disableDefaultStarters: true,
    spawnBattleBases: false,
    autoEnableAiWeaponAutoFire: true,
    battlefieldWidth: BATTLEFIELD_SIZE,
    battlefieldHeight: BATTLEFIELD_SIZE,
    partCatalog: parts,
    weaponVerificationOverrides: {
      unlimitedRange: true,
      disableAngleLimits: true,
      disableUnitSeparation: true,
      spreadDeg: 0,
    },
  });
  const node: MapNode = { id: "shoot-verification", name: "Shoot Verification", owner: "neutral", garrison: false, reward: 0, defense: 1 };
  battle.start(node);

  const shooterX = 8_000 + mulberry32(spec.seed ^ 0x91e10da5)() * 14_000;
  const shooterY = 7_000 + mulberry32(spec.seed ^ 0x4f1bbcdc)() * 4_000;
  const target = instantiateUnit(battleTemplates, fixtureTemplate.id, "player", shooterX + 500, shooterY, { partCatalog: parts });
  const shooter = instantiateUnit(battleTemplates, shooterTemplate.id, "enemy", shooterX, shooterY, { partCatalog: parts });
  if (!target || !shooter) throw new Error(`Could not instantiate verification fixtures for ${weapon.name}`);
  hardenTarget(target);
  shooter.weaponAttachmentIds = shooter.weaponAttachmentIds.slice(0, 1);
  shooter.weaponAutoFire = [true];
  shooter.weaponManualControl = [false];
  shooter.weaponFireTimers = [0];
  shooter.weaponReadyCharges = [1];
  shooter.weaponAimAngles = [0];
  battle.getState().units.push(target);
  battle.setAiControllers({ player: createMovingTargetController(spec.targetDirection) });
  battle.update(DT, IDLE_KEYS);

  const targetMaxSpeed = Math.max(1e-6, target.maxSpeed);
  battle.setMovementSpeedMultiplier(spec.targetSpeed / targetMaxSpeed);
  const targetVx = Math.cos(spec.targetDirection) * spec.targetSpeed;
  const targetVy = Math.sin(spec.targetDirection) * spec.targetSpeed;
  target.vx = targetVx;
  target.vy = targetVy;
  shooter.vx = 0;
  shooter.vy = 0;
  battle.getState().units.push(shooter);
  const visual = battle.getWeaponVisualState(shooter, shooter.weaponAttachmentIds[0] ?? -1);
  if (!visual) throw new Error(`Could not resolve firepoint for ${weapon.name}`);
  target.x = visual.firepointX + Math.cos(spec.bearing) * spec.distance;
  target.y = visual.firepointY + Math.sin(spec.bearing) * spec.distance;
  battle.consumeBattleAudioEvents();
  battle.consumeProjectileHitEvents();
  battle.setAiControllers({
    player: createMovingTargetController(spec.targetDirection),
    enemy: createOneShotController(target.id, shootFactory()),
  });

  let fireCount = 0;
  let closestApproach = Number.POSITIVE_INFINITY;
  let leadTimeS = 0;
  let reason = "timeout";
  for (let tick = 0; tick < 30 / DT; tick += 1) {
    battle.update(DT, IDLE_KEYS);
    const state = battle.getState();
    const liveShooter = state.units.find((unit) => unit.id === shooter.id);
    const liveTarget = state.units.find((unit) => unit.id === target.id);
    if (liveShooter) leadTimeS = Math.max(leadTimeS, liveShooter.aiDebugLeadTimeS);
    for (const event of battle.consumeBattleAudioEvents()) {
      if (event.kind === "fire") fireCount += 1;
    }
    const directHit = battle.consumeProjectileHitEvents().some((event) => (
      event.direct && event.sourceUnitId === shooter.id && event.targetUnitId === target.id
    ));
    if (directHit) {
      reason = fireCount === 1 ? "hit" : "extra-shot";
      return { hit: fireCount === 1, fireCount, reason, closestApproach: 0, leadTimeS, spec };
    }
    if (liveTarget) {
      for (const projectile of state.projectiles.filter((entry) => entry.sourceId === shooter.id)) {
        closestApproach = Math.min(closestApproach, Math.hypot(projectile.x - liveTarget.x, projectile.y - liveTarget.y));
      }
    }
    if (tick > 2 && fireCount === 0 && liveShooter?.aiDebugFireBlockReason) {
      reason = liveShooter.aiDebugFireBlockReason;
      break;
    }
    if (fireCount > 1) {
      reason = "extra-shot";
      break;
    }
    // Once the exact intercept time and a short collision margin have passed,
    // a non-homing biased shot cannot become a direct hit against the verified
    // constant-velocity target. This still bases the result on runtime hit
    // telemetry instead of trusting the AI's accurate/miss debug classification.
    if (fireCount === 1 && (tick + 1) * DT > Math.max(0.75, leadTimeS + 0.75)) {
      reason = liveShooter?.aiDebugDecisionPath.includes("stable-near-miss")
        ? "stable-near-miss"
        : "passed-intercept-without-direct-hit";
      break;
    }
    if (fireCount === 1 && !state.projectiles.some((entry) => entry.sourceId === shooter.id)) {
      reason = "projectile-expired-without-direct-hit";
      break;
    }
  }
  return { hit: false, fireCount, reason, closestApproach, leadTimeS, spec };
}

function createRandomTrialSpecs(seed: number, weaponId: number, trials: number): TrialSpec[] {
  const rng = mulberry32((seed ^ Math.imul(weaponId, 0x9e3779b1)) >>> 0);
  return Array.from({ length: trials }, () => ({
    seed: Math.floor(rng() * 0x1_0000_0000) >>> 0,
    distance: rng() * MAX_RANGE,
    bearing: rng() * Math.PI * 2,
    targetSpeed: rng() * MAX_TARGET_SPEED,
    targetDirection: rng() * Math.PI * 2,
  }));
}

function runSolverChecks(): void {
  const checks = [
    solveBallisticAim(0, 0, 1_000, 0, 0, 0, 5_000, 500, 0),
    solveBallisticAim(0, 0, 1_000, 200, 30, -10, 5_000, 600, 20),
    solveBallisticAim(0, 0, 0, -1_000, 10, 20, 5_000, 700, 65),
  ];
  if (checks.some((solution) => solution === null)) throw new Error("Ballistic solver failed a reachable focused check");
  if (solveBallisticAim(0, 0, 1_000, 0, 800, 0, 10_000, 200, 0) !== null) {
    throw new Error("Ballistic solver accepted an unreachable receding target");
  }
  for (const solution of checks) {
    if (!solution || !Number.isFinite(solution.firingAngleRad) || solution.leadTimeS <= 0) {
      throw new Error("Ballistic solver produced a non-finite focused-check result");
    }
  }
}

function parseArg(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  runSolverChecks();
  const seed = Number.parseInt(parseArg("seed") ?? "20260727", 10) >>> 0;
  const trials = Math.max(1, Number.parseInt(parseArg("trials") ?? "1000", 10));
  const weaponFilter = (parseArg("weapon") ?? "").trim().toLowerCase();
  const parts = loadRuntimeMergedParts();
  const templates = await loadRuntimeMergedTemplates(parts);
  const fixtureTemplate = templates.find((template) => (
    template.type === "air" && template.attachments.some((attachment) => COMPONENTS[attachment.component].type === "weapon")
  ));
  if (!fixtureTemplate) throw new Error("No armed air template is available for shooting verification");
  const weapons = parts
    .filter((part) => part.partType === "weapon")
    .filter((part) => !weaponFilter || part.name.toLowerCase().includes(weaponFilter))
    .sort((a, b) => a.id - b.id);
  if (weapons.length === 0) throw new Error(`No weapon matched filter '${weaponFilter}'`);

  const edgeCases: TrialSpec[] = [
    { seed: seed ^ 1, distance: 1, bearing: 0, targetSpeed: 0, targetDirection: 0 },
    { seed: seed ^ 2, distance: MAX_RANGE, bearing: 0, targetSpeed: MAX_TARGET_SPEED, targetDirection: 0 },
    { seed: seed ^ 3, distance: MAX_RANGE, bearing: Math.PI, targetSpeed: MAX_TARGET_SPEED, targetDirection: Math.PI },
    { seed: seed ^ 4, distance: MAX_RANGE, bearing: Math.PI / 2, targetSpeed: MAX_TARGET_SPEED, targetDirection: Math.PI / 2 },
    { seed: seed ^ 5, distance: MAX_RANGE, bearing: -Math.PI / 2, targetSpeed: MAX_TARGET_SPEED, targetDirection: -Math.PI / 2 },
    { seed: seed ^ 6, distance: MAX_RANGE, bearing: Math.PI / 4, targetSpeed: MAX_TARGET_SPEED, targetDirection: 3 * Math.PI / 4 },
  ];
  let failed = false;
  for (const weapon of weapons) {
    const edgeFailures = edgeCases.map((spec) => runTrial(templates, parts, fixtureTemplate, weapon, spec)).filter((result) => !result.hit);
    const misses: TrialResult[] = [];
    let hits = 0;
    for (const spec of createRandomTrialSpecs(seed, weapon.id, trials)) {
      const result = runTrial(templates, parts, fixtureTemplate, weapon, spec);
      if (result.hit) hits += 1;
      else if (misses.length < 8) misses.push(result);
    }
    const required = Math.ceil(trials * 0.999);
    const passed = hits >= required && edgeFailures.length === 0;
    failed ||= !passed;
    console.log(`${passed ? "PASS" : "FAIL"} ${weapon.name}: random=${hits}/${trials} required=${required} edge=${edgeCases.length - edgeFailures.length}/${edgeCases.length}`);
    for (const miss of [...edgeFailures, ...misses].slice(0, 8)) {
      console.log(`  seed=${miss.spec.seed} reason=${miss.reason} fired=${miss.fireCount} range=${miss.spec.distance.toFixed(3)} bearing=${miss.spec.bearing.toFixed(6)} speed=${miss.spec.targetSpeed.toFixed(3)} direction=${miss.spec.targetDirection.toFixed(6)} lead=${miss.leadTimeS.toFixed(6)} closest=${Number.isFinite(miss.closestApproach) ? miss.closestApproach.toFixed(3) : "inf"}`);
    }
  }

  for (let level = 1; level <= 5; level += 1) {
    const perWeapon: Array<{ name: string; hits: number }> = [];
    let aggregateHits = 0;
    for (const weapon of weapons) {
      let weaponHits = 0;
      for (const spec of createRandomTrialSpecs(seed, weapon.id, trials)) {
        const result = runTrial(
          templates,
          parts,
          fixtureTemplate,
          weapon,
          spec,
          () => createUnifiedLevelShootAi(level),
        );
        if (result.hit) weaponHits += 1;
      }
      aggregateHits += weaponHits;
      perWeapon.push({ name: weapon.name, hits: weaponHits });
    }
    const total = trials * weapons.length;
    const measured = aggregateHits / Math.max(1, total);
    const expected = UNIFIED_LEVEL_ACCURACY[level] ?? 1;
    const samplingSigma = Math.sqrt(expected * (1 - expected) / Math.max(1, total));
    const accuracyTolerance = trials >= 1_000 ? 0.015 : Math.max(0.015, samplingSigma * 3.5);
    const passed = Math.abs(measured - expected) <= accuracyTolerance;
    failed ||= !passed;
    console.log(
      `${passed ? "PASS" : "FAIL"} unified L${level}: aggregate=${(measured * 100).toFixed(2)}% `
      + `target=${(expected * 100).toFixed(0)}% tolerance=±${(accuracyTolerance * 100).toFixed(1)}% `
      + `weapons=[${perWeapon.map((entry) => `${entry.name}:${entry.hits}/${trials}`).join(", ")}]`,
    );
  }
  if (failed) process.exitCode = 1;
}

await main();
