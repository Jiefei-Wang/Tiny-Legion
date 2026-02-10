import {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
} from "../../../packages/game-core/src/config/balance/battlefield.ts";
import { GROUND_FIRE_Y_TOLERANCE, PROJECTILE_SPEED } from "../../../packages/game-core/src/config/balance/range.ts";
import { COMPONENTS } from "../../../packages/game-core/src/config/balance/weapons.ts";
import {
  createBaselineMovementAi,
  createBaselineShootAi,
  createBaselineTargetAi,
} from "../../../packages/game-core/src/ai/composite/baseline-modules.ts";
import { solveBallisticAim } from "../../../packages/game-core/src/ai/shooting/ballistic-aim.ts";
import { adjustAimForWeaponPolicy } from "../../../packages/game-core/src/ai/shooting/weapon-ai-policy.ts";
import { clamp } from "../../../packages/game-core/src/simulation/physics/impulse-model.ts";
import { structureIntegrity } from "../../../packages/game-core/src/simulation/units/structure-grid.ts";
import {
  createCompositeAiController,
  type BattleAiController,
  type BattleAiInput,
  type MovementAiModule,
  type ShootAiModule,
  type TargetAiModule,
} from "../../../packages/game-core/src/ai/composite/composite-ai.ts";
import type { Params, ParamSchema } from "./ai-schema.ts";
import type { MatchAiSpec } from "../match/match-types.ts";

const MAX_HIDDEN = 24;

type NeuralModuleKind = "target" | "movement" | "shoot";

type FeatureVector = number[];

type NeuralOutput = number[];

type NeuralHyper = {
  layers: number;
  hidden: number;
  featureMask: boolean[];
};

type OrtTensorLike = {
  data: Float32Array | number[] | ArrayLike<number>;
};

type OrtSessionLike = {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, OrtTensorLike>>;
};

let ortModulePromise: Promise<any> | null = null;
const onnxShootSessionCache = new Map<string, Promise<OrtSessionLike>>();

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function parsePythonOnnxShootFileName(familyId: string): string | null {
  const prefix = "python-onnx-shoot:";
  if (!familyId.startsWith(prefix)) {
    return null;
  }
  const fileName = familyId.slice(prefix.length).trim();
  if (!/^[a-zA-Z0-9._-]+\.onnx$/.test(fileName)) {
    return null;
  }
  return fileName;
}

async function loadOrtModule(): Promise<any> {
  if (!ortModulePromise) {
    ortModulePromise = import("onnxruntime-web");
  }
  return ortModulePromise;
}

function getOnnxShootSession(fileName: string): Promise<OrtSessionLike> {
  const cached = onnxShootSessionCache.get(fileName);
  if (cached) {
    return cached;
  }
  const modelUrl = `/__arena/python-models/${encodeURIComponent(fileName)}`;
  const promise = (async () => {
    const ort = await loadOrtModule();
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
    });
    return session as OrtSessionLike;
  })();
  onnxShootSessionCache.set(fileName, promise);
  return promise;
}

export type CompositeModuleSpec = {
  familyId: string;
  params: Params;
};

export type CompositeConfig = {
  target: CompositeModuleSpec;
  movement: CompositeModuleSpec;
  shoot: CompositeModuleSpec;
};

function pickNumber(params: Params, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pickBoolean(params: Params, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

function decodeNeuralHyper(params: Params, prefix: string, featureCount: number): NeuralHyper {
  const layers = Math.max(1, Math.min(2, Math.floor(pickNumber(params, `${prefix}layers`, 1))));
  const hidden = Math.max(4, Math.min(MAX_HIDDEN, Math.floor(pickNumber(params, `${prefix}hidden`, 12))));
  const featureMask: boolean[] = [];
  for (let i = 0; i < featureCount; i += 1) {
    featureMask.push(pickBoolean(params, `${prefix}useF${i}`, true));
  }
  return { layers, hidden, featureMask };
}

function tanh(x: number): number {
  if (x > 7) return 0.999998;
  if (x < -7) return -0.999998;
  return Math.tanh(x);
}

function runNeural(params: Params, prefix: string, input: FeatureVector, outputSize: number): NeuralOutput {
  const hyper = decodeNeuralHyper(params, prefix, input.length);
  const masked: number[] = input.map((value, idx) => (hyper.featureMask[idx] ? value : 0));
  const h1: number[] = new Array(hyper.hidden).fill(0);
  for (let h = 0; h < hyper.hidden; h += 1) {
    let sum = pickNumber(params, `${prefix}b1_${h}`, 0);
    for (let i = 0; i < masked.length; i += 1) {
      sum += masked[i] * pickNumber(params, `${prefix}w_ih_${i}_${h}`, 0);
    }
    h1[h] = tanh(sum);
  }

  const last = h1;
  if (hyper.layers > 1) {
    const h2: number[] = new Array(hyper.hidden).fill(0);
    for (let h = 0; h < hyper.hidden; h += 1) {
      let sum = pickNumber(params, `${prefix}b2_${h}`, 0);
      for (let j = 0; j < hyper.hidden; j += 1) {
        sum += h1[j] * pickNumber(params, `${prefix}w_hh_${j}_${h}`, 0);
      }
      h2[h] = tanh(sum);
    }
    return Array.from({ length: outputSize }, (_, o) => {
      let sum = pickNumber(params, `${prefix}bo_${o}`, 0);
      for (let h = 0; h < hyper.hidden; h += 1) {
        sum += h2[h] * pickNumber(params, `${prefix}w_ho_${h}_${o}`, 0);
      }
      return sum;
    });
  }

  return Array.from({ length: outputSize }, (_, o) => {
    let sum = pickNumber(params, `${prefix}bo_${o}`, 0);
    for (let h = 0; h < hyper.hidden; h += 1) {
      sum += last[h] * pickNumber(params, `${prefix}w_ho_${h}_${o}`, 0);
    }
    return sum;
  });
}

function canHitByAxis(unit: BattleAiInput["unit"], targetY: number, targetType: BattleAiInput["unit"]["type"]): boolean {
  if (unit.type === "air" || targetType === "air") {
    return true;
  }
  return Math.abs(targetY - unit.y) <= GROUND_FIRE_Y_TOLERANCE;
}

function nearestThreat(input: BattleAiInput): number {
  let best = 0;
  for (const projectile of input.state.projectiles) {
    if (projectile.side === input.unit.side) continue;
    const d = Math.hypot(projectile.x - input.unit.x, projectile.y - input.unit.y);
    best = Math.max(best, 1 / Math.max(30, d));
  }
  return clamp(best * 220, 0, 1);
}

function buildTargetFeatures(input: BattleAiInput, enemy: BattleAiInput["state"]["units"][number]): FeatureVector {
  const dx = enemy.x - input.unit.x;
  const dy = enemy.y - input.unit.y;
  const distance = Math.hypot(dx, dy);
  const base = input.unit.side === "player" ? input.state.playerBase : input.state.enemyBase;
  const baseCenterX = base.x + base.w * 0.5;
  const baseCenterY = base.y + base.h * 0.5;
  const pressure = 1 - clamp(Math.hypot(enemy.x - baseCenterX, enemy.y - baseCenterY) / 900, 0, 1);
  const enemyWeapons = Math.max(0, enemy.weaponAttachmentIds.length / 8);
  const speed = Math.hypot(enemy.vx, enemy.vy);
  return [
    1,
    clamp(distance / 900, 0, 2),
    clamp(Math.abs(dy) / 360, 0, 2),
    clamp(speed / 300, 0, 2),
    clamp(structureIntegrity(enemy), 0, 1),
    enemyWeapons,
    enemy.type === "air" ? 1 : 0,
    clamp(structureIntegrity(input.unit), 0, 1),
    pressure,
    clamp((enemy.vx * Math.sign(dx)) / 180, -2, 2),
  ];
}

function createNeuralTargetAi(params: Params): TargetAiModule {
  return {
    decideTarget: (input) => {
      const rankedTargets = input.state.units
        .filter((unit) => unit.alive && unit.side !== input.unit.side)
        .map((enemy) => {
          const features = buildTargetFeatures(input, enemy);
          const [score] = runNeural(params, "target.", features, 1);
          return {
            targetId: enemy.id,
            score: -score,
            x: enemy.x,
            y: enemy.y,
            vx: enemy.vx,
            vy: enemy.vy,
            type: enemy.type,
          };
        })
        .sort((a, b) => a.score - b.score);
      const top = rankedTargets[0];
      return {
        rankedTargets,
        attackPoint: top ? { x: top.x, y: top.y } : { x: input.baseTarget.x, y: input.baseTarget.y },
        debugTag: top ? "target.neural-ranked" : "target.base-fallback",
      };
    },
  };
}

function createNeuralMovementAi(params: Params): MovementAiModule {
  return {
    decideMovement: (input, target) => {
      const dx = target.attackPoint.x - input.unit.x;
      const dy = target.attackPoint.y - input.unit.y;
      const distance = Math.hypot(dx, dy);
      const baseDx = input.baseTarget.x - input.unit.x;
      const baseDy = input.baseTarget.y - input.unit.y;
      const features: FeatureVector = [
        1,
        clamp(dx / BATTLEFIELD_WIDTH, -2, 2),
        clamp(dy / BATTLEFIELD_HEIGHT, -2, 2),
        clamp(distance / 850, 0, 2),
        clamp(input.desiredRange / 600, 0, 2),
        clamp(structureIntegrity(input.unit), 0, 1),
        nearestThreat(input),
        clamp(Math.hypot(input.unit.vx, input.unit.vy) / Math.max(1, input.unit.maxSpeed), 0, 2),
        clamp(target.rankedTargets.length / 8, 0, 2),
        input.unit.type === "air" ? 1 : 0,
        clamp(baseDx / BATTLEFIELD_WIDTH, -2, 2),
        clamp(baseDy / BATTLEFIELD_HEIGHT, -2, 2),
      ];
      const [axRaw, ayRaw, evadeRaw] = runNeural(params, "movement.", features, 3);
      const ax = clamp(tanh(axRaw) * 1.4, -1.4, 1.4);
      const ay = clamp(tanh(ayRaw) * 1.4, -1.4, 1.4);
      const shouldEvade = evadeRaw > 0;
      return {
        ax,
        ay,
        shouldEvade,
        state: shouldEvade ? "evade" : "engage",
        debugTag: "movement.neural",
      };
    },
  };
}

function buildShootFeatures(
  input: BattleAiInput,
  target: ReturnType<TargetAiModule["decideTarget"]>,
  slot: number,
): { features: FeatureVector; plan: ReturnType<ShootAiModule["decideShoot"]>["firePlan"] } {
  const unit = input.unit;
  const attachmentId = unit.weaponAttachmentIds[slot];
  const attachment = unit.attachments.find((entry) => entry.id === attachmentId && entry.alive) ?? null;
  if (!attachment) {
    return {
      features: [1, 2, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      plan: null,
    };
  }
  const stats = COMPONENTS[attachment.component];
  if (stats.type !== "weapon" || stats.range === undefined || stats.damage === undefined) {
    return {
      features: [1, 2, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      plan: null,
    };
  }
  const attack = target.rankedTargets[0];
  const tx = attack?.x ?? target.attackPoint.x;
  const ty = attack?.y ?? target.attackPoint.y;
  const tvx = attack?.vx ?? 0;
  const tvy = attack?.vy ?? 0;
  const effectiveRange = input.getEffectiveWeaponRange(attachment.stats?.range ?? stats.range);
  const distance = Math.hypot(tx - unit.x, ty - unit.y);
  const solved = solveBallisticAim(unit.x, unit.y, tx, ty, tvx, tvy, effectiveRange);
  const angleRad = solved?.firingAngleRad ?? Math.atan2(ty - unit.y, tx - unit.x);
  const aimDistance = solved
    ? Math.max(90, Math.min(effectiveRange, PROJECTILE_SPEED * solved.leadTimeS))
    : Math.min(effectiveRange, Math.max(90, distance));
  const baseAim = {
    x: unit.x + Math.cos(angleRad) * aimDistance,
    y: unit.y + Math.sin(angleRad) * aimDistance + unit.aiAimCorrectionY,
  };
  const aim = adjustAimForWeaponPolicy(attachment.component, baseAim);
  const angleOk = input.canShootAtAngle(attachment.component, aim.x - unit.x, aim.y - unit.y, attachment.stats?.shootAngleDeg);
  const axisOk = canHitByAxis(unit, ty, attack?.type ?? unit.type);
  const features: FeatureVector = [
    1,
    clamp(distance / Math.max(1, effectiveRange), 0, 2),
    clamp((effectiveRange - distance) / Math.max(1, effectiveRange), -2, 2),
    clamp(Math.hypot(tvx, tvy) / 320, 0, 2),
    clamp((ty - unit.y) / 300, -2, 2),
    clamp(stats.damage / 85, 0, 2),
    (unit.weaponFireTimers[slot] ?? 0) <= 0 ? 1 : 0,
    angleOk ? 1 : 0,
    clamp(structureIntegrity(unit), 0, 1),
    solved ? 1 : 0,
    axisOk ? 1 : 0,
    input.unit.type === "air" ? 1 : 0,
  ];
  const plan = !angleOk || !axisOk
    ? null
    : {
        preferredSlot: slot,
        aim,
        intendedTargetId: attack?.targetId ?? null,
        intendedTargetY: solved?.y ?? (attack ? ty : null),
        angleRad,
        leadTimeS: solved?.leadTimeS ?? 0,
        effectiveRange,
      };
  return { features, plan };
}

function createNeuralShootAi(params: Params): ShootAiModule {
  return {
    decideShoot: (input, target, movement) => {
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestPlan: ReturnType<ShootAiModule["decideShoot"]>["firePlan"] = null;
      for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
        const { features, plan } = buildShootFeatures(input, target, slot);
        features[9] = movement.shouldEvade ? 1 : 0;
        const [score] = runNeural(params, "shoot.", features, 1);
        if (plan && score > bestScore) {
          bestScore = score;
          bestPlan = plan;
        }
      }
      if (!bestPlan) {
        return {
          firePlan: null,
          fireBlockedReason: "no-shot-plan",
          debugTag: "shoot.neural-no-plan",
        };
      }
      return {
        firePlan: bestPlan,
        fireBlockedReason: null,
        debugTag: "shoot.neural-plan",
      };
    },
  };
}

function createPythonOnnxShootAi(fileName: string): ShootAiModule {
  const outputByKey = new Map<string, [number, number]>();
  const pendingByKey = new Map<string, Promise<void>>();

  const makeFeatureKey = (slot: number, features: FeatureVector): string => {
    const rounded = features.map((v) => Math.round(v * 1000) / 1000);
    return `${slot}:${rounded.join(",")}`;
  };

  const inferAsync = (key: string, features: FeatureVector): void => {
    if (outputByKey.has(key) || pendingByKey.has(key)) {
      return;
    }
    const job = (async () => {
      try {
        const ort = await loadOrtModule();
        const session = await getOnnxShootSession(fileName);
        const input = new ort.Tensor("float32", Float32Array.from(features), [1, features.length]);
        const outputs = await session.run({ x: input });
        const first = Object.values(outputs)[0] as OrtTensorLike | undefined;
        const raw = first?.data;
        const v0 = Number(raw && raw[0] !== undefined ? raw[0] : 0);
        const v1 = Number(raw && raw[1] !== undefined ? raw[1] : 0);
        outputByKey.set(key, [v0, v1]);
        if (outputByKey.size > 2048) {
          outputByKey.clear();
        }
      } catch {
        // Keep silent here; caller falls back to no-shot on missing output.
      } finally {
        pendingByKey.delete(key);
      }
    })();
    pendingByKey.set(key, job);
  };

  return {
    decideShoot: (input, target, movement) => {
      let bestProb = -1;
      let bestPlan: ReturnType<ShootAiModule["decideShoot"]>["firePlan"] = null;
      const motionX = clamp(movement.ax, -1, 1);
      const motionY = clamp(movement.ay, -1, 1);
      for (let slot = 0; slot < input.unit.weaponAttachmentIds.length; slot += 1) {
        const base = buildShootFeatures(input, target, slot);
        if (!base.plan) {
          continue;
        }
        const attack = target.rankedTargets[0];
        const dx = base.plan.aim.x - input.unit.x;
        const dy = base.plan.aim.y - input.unit.y;
        const distance = Math.hypot(dx, dy);
        const cooldownReady = (input.unit.weaponFireTimers[slot] ?? 0) <= 0 ? 1 : 0;
        const readyChargeNorm = clamp((input.unit.weaponReadyCharges[slot] ?? 0) / 4, 0, 4);
        const targetDx = clamp(dx / Math.max(1, BATTLEFIELD_WIDTH), -2, 2);
        const targetDy = clamp(dy / Math.max(1, BATTLEFIELD_HEIGHT), -2, 2);
        const targetDist = clamp(distance / Math.hypot(BATTLEFIELD_WIDTH, BATTLEFIELD_HEIGHT), 0, 2);
        const targetVx = clamp((attack?.vx ?? 0) / 320, -3, 3);
        const targetVy = clamp((attack?.vy ?? 0) / 320, -3, 3);
        const threat = nearestThreat(input);
        const features: FeatureVector = [
          1,
          clamp(slot / Math.max(1, input.unit.weaponAttachmentIds.length), 0, 1),
          cooldownReady,
          readyChargeNorm,
          targetDx,
          targetDy,
          targetDist,
          targetVx,
          targetVy,
          motionX,
          motionY,
          clamp(threat, 0, 1),
        ];
        const key = makeFeatureKey(slot, features);
        inferAsync(key, features);
        const out = outputByKey.get(key);
        if (!out) {
          continue;
        }
        const fireProb = sigmoid(out[0]);
        const shootSample = Math.random() < fireProb;
        if (!shootSample) {
          continue;
        }
        const angleDelta = tanh(out[1]) * 0.45;
        const angle = Math.atan2(dy, dx) + angleDelta;
        const aimDistance = Math.max(1, distance);
        const adjustedAim = {
          x: input.unit.x + Math.cos(angle) * aimDistance,
          y: input.unit.y + Math.sin(angle) * aimDistance,
        };
        const plan = {
          ...base.plan,
          aim: adjustedAim,
        };
        if (fireProb > bestProb) {
          bestProb = fireProb;
          bestPlan = plan;
        }
      }
      if (!bestPlan) {
        return {
          firePlan: null,
          fireBlockedReason: "onnx-pending-or-no-shot",
          debugTag: "shoot.python-onnx-no-plan",
        };
      }
      return {
        firePlan: bestPlan,
        fireBlockedReason: null,
        debugTag: "shoot.python-onnx",
      };
    },
  };
}

function makeNeuralSchema(prefix: string, featureCount: number, outputCount: number): ParamSchema {
  const schema: ParamSchema = {
    [`${prefix}layers`]: { kind: "int", min: 1, max: 2, def: 1, step: 1, mutateRate: 0.2 },
    [`${prefix}hidden`]: { kind: "int", min: 4, max: MAX_HIDDEN, def: 12, step: 1, mutateRate: 0.35 },
  };
  for (let i = 0; i < featureCount; i += 1) {
    schema[`${prefix}useF${i}`] = { kind: "boolean", def: true, mutateRate: 0.1 };
  }
  for (let i = 0; i < featureCount; i += 1) {
    for (let h = 0; h < MAX_HIDDEN; h += 1) {
      schema[`${prefix}w_ih_${i}_${h}`] = { kind: "number", min: -2, max: 2, def: 0, sigma: 0.22 };
    }
  }
  for (let h = 0; h < MAX_HIDDEN; h += 1) {
    schema[`${prefix}b1_${h}`] = { kind: "number", min: -2, max: 2, def: 0, sigma: 0.2 };
    schema[`${prefix}b2_${h}`] = { kind: "number", min: -2, max: 2, def: 0, sigma: 0.2 };
    for (let j = 0; j < MAX_HIDDEN; j += 1) {
      schema[`${prefix}w_hh_${h}_${j}`] = { kind: "number", min: -2, max: 2, def: 0, sigma: 0.2 };
    }
    for (let o = 0; o < outputCount; o += 1) {
      schema[`${prefix}w_ho_${h}_${o}`] = { kind: "number", min: -2, max: 2, def: 0, sigma: 0.22 };
    }
  }
  for (let o = 0; o < outputCount; o += 1) {
    schema[`${prefix}bo_${o}`] = { kind: "number", min: -2, max: 2, def: 0, sigma: 0.2 };
  }
  return schema;
}

export const NEURAL_SCHEMA_TARGET = makeNeuralSchema("target.", 10, 1);
export const NEURAL_SCHEMA_MOVEMENT = makeNeuralSchema("movement.", 12, 3);
export const NEURAL_SCHEMA_SHOOT = makeNeuralSchema("shoot.", 12, 1);

export function getModuleSchema(kind: NeuralModuleKind): ParamSchema {
  if (kind === "target") return NEURAL_SCHEMA_TARGET;
  if (kind === "movement") return NEURAL_SCHEMA_MOVEMENT;
  return NEURAL_SCHEMA_SHOOT;
}

function createTargetModule(spec: CompositeModuleSpec): TargetAiModule {
  if (spec.familyId === "baseline-target") {
    return createBaselineTargetAi();
  }
  if (spec.familyId === "neural-target") {
    return createNeuralTargetAi(spec.params);
  }
  throw new Error(`Unsupported target AI family: ${spec.familyId}`);
}

function createMovementModule(spec: CompositeModuleSpec): MovementAiModule {
  if (spec.familyId === "baseline-movement") {
    return createBaselineMovementAi();
  }
  if (spec.familyId === "neural-movement") {
    return createNeuralMovementAi(spec.params);
  }
  throw new Error(`Unsupported movement AI family: ${spec.familyId}`);
}

function createShootModule(spec: CompositeModuleSpec): ShootAiModule {
  if (spec.familyId === "baseline-shoot") {
    return createBaselineShootAi();
  }
  if (spec.familyId === "neural-shoot") {
    return createNeuralShootAi(spec.params);
  }
  const onnxFile = parsePythonOnnxShootFileName(spec.familyId);
  if (onnxFile) {
    return createPythonOnnxShootAi(onnxFile);
  }
  throw new Error(`Unsupported shoot AI family: ${spec.familyId}`);
}

export function baselineCompositeConfig(): CompositeConfig {
  return {
    target: { familyId: "baseline-target", params: {} },
    movement: { familyId: "baseline-movement", params: {} },
    shoot: { familyId: "baseline-shoot", params: {} },
  };
}

export function makeCompositeAiController(spec: MatchAiSpec): BattleAiController | null {
  if (spec.familyId !== "composite" || !spec.composite) {
    return null;
  }
  const modules = spec.composite;
  return createCompositeAiController({
    target: createTargetModule(modules.target),
    movement: createMovementModule(modules.movement),
    shoot: createShootModule(modules.shoot),
  });
}
