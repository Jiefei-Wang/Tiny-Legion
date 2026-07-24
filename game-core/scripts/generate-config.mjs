import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const gameCoreDir = resolve(scriptDir, "..");
export const repositoryDir = resolve(gameCoreDir, "..");
export const configDir = resolve(gameCoreDir, "src", "config");
export const audioDir = resolve(gameCoreDir, "assets", "audio");
export const generatedConfigPath = resolve(configDir, "generated", "game-config.generated.ts");

export const CONFIG_FILES = {
  balance: {
    battlefield: "balance/battlefield.yaml",
    range: "balance/range.yaml",
    commander: "balance/commander.yaml",
    economy: "balance/economy.yaml",
    materials: "balance/materials.yaml",
    units: "balance/units.yaml",
    weapons: "balance/weapons.yaml",
    campaign: "balance/campaign.yaml",
  },
  ai: {
    shooting: "ai/shooting.yaml",
    levels: "ai/levels.yaml",
  },
  display: {
    battle: "display/battle.yaml",
  },
  editor: {
    editor: "editor/editor.yaml",
  },
  sound: {
    battle: "sound/battle.yaml",
  },
};

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"]);
const IGNORED_SCAN_DIRS = new Set([".git", "node_modules", "dist", "build", ".dist", ".headless-dist", ".tmp"]);
const DESCRIPTIONS_KEY = "_descriptions";

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function objectAt(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  return value;
}

function exactKeys(value, expected, path) {
  const object = objectAt(value, path);
  const actual = Object.keys(object);
  const missing = expected.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length) fail(path, `missing keys: ${missing.join(", ")}`);
  if (unknown.length) fail(path, `unknown keys: ${unknown.join(", ")}`);
  return object;
}

function finiteNumbers(value, path) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "expected a finite number");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => finiteNumbers(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) finiteNumbers(item, `${path}.${key}`);
  }
}

function numberAt(object, key, path) {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path}.${key}`, "expected a finite number");
  return value;
}

function stringAt(object, key, path) {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) fail(`${path}.${key}`, "expected a non-empty string");
  return value;
}

function booleanAt(object, key, path) {
  if (typeof object[key] !== "boolean") fail(`${path}.${key}`, "expected a boolean");
}

function validateScalarObject(value, keys, path) {
  const object = exactKeys(value, keys, path);
  finiteNumbers(object, path);
  return object;
}

export function validateGameConfig(config) {
  exactKeys(config, ["balance", "ai", "display", "editor", "sound"], "config");
  exactKeys(config.balance, ["battlefield", "range", "commander", "economy", "materials", "units", "weapons", "campaign"], "config.balance");
  exactKeys(config.ai, ["shooting", "levels"], "config.ai");
  exactKeys(config.display, ["battle"], "config.display");
  exactKeys(config.editor, ["editor"], "config.editor");
  exactKeys(config.sound, ["battle"], "config.sound");
  const battlefield = config.balance.battlefield;
  validateScalarObject(battlefield, ["battlefield", "movement", "air", "combat", "wreck", "structure", "separation"], "balance/battlefield.yaml");
  validateScalarObject(battlefield.battlefield, ["width", "height", "groundHeightRatio", "airMinZRatio", "airGroundGapRatio", "airTargetZToleranceRatio"], "balance/battlefield.yaml.battlefield");
  validateScalarObject(battlefield.movement, ["defaultMultiplier"], "balance/battlefield.yaml.movement");
  const air = validateScalarObject(
    battlefield.air,
    ["holdGravity", "dropGravity", "dropSpeedCap", "powerToSpeedScale", "aircraft_acceleration_ratio"],
    "balance/battlefield.yaml.air",
  );
  if (!(numberAt(air, "aircraft_acceleration_ratio", "balance/battlefield.yaml.air") >= 0)) {
    fail("balance/battlefield.yaml.air.aircraft_acceleration_ratio", "expected a non-negative number");
  }
  validateScalarObject(battlefield.combat, ["groundProjectileMaxDropBelowFireY", "salvageRefundFactor", "penetrationArmorScaler"], "balance/battlefield.yaml.combat");
  const wreck = validateScalarObject(battlefield.wreck, ["groundLifetimeSeconds", "minInitialHpLossRatio", "maxInitialHpLossRatio"], "balance/battlefield.yaml.wreck");
  if (!(numberAt(wreck, "groundLifetimeSeconds", "balance/battlefield.yaml.wreck") > 0)) fail("balance/battlefield.yaml.wreck.groundLifetimeSeconds", "expected a positive number");
  if (!(numberAt(wreck, "minInitialHpLossRatio", "balance/battlefield.yaml.wreck") > 0
    && numberAt(wreck, "minInitialHpLossRatio", "balance/battlefield.yaml.wreck") <= numberAt(wreck, "maxInitialHpLossRatio", "balance/battlefield.yaml.wreck")
    && numberAt(wreck, "maxInitialHpLossRatio", "balance/battlefield.yaml.wreck") < 1)) {
    fail("balance/battlefield.yaml.wreck", "expected 0 < minInitialHpLossRatio <= maxInitialHpLossRatio < 1");
  }
  validateScalarObject(battlefield.structure, ["minCellSize", "maxCellSize"], "balance/battlefield.yaml.structure");
  const separation = validateScalarObject(battlefield.separation, ["enabled", "overlapAllowanceRatio", "positionFactor", "velocityDamping", "gridSize", "spawnPlacementAttempts"], "balance/battlefield.yaml.separation");
  booleanAt(separation, "enabled", "balance/battlefield.yaml.separation");

  const range = validateScalarObject(config.balance.range, ["weaponRangeMultiplier", "aircraftRangeBonusMax", "projectileSpeed", "projectileGravity", "groundFireYTolerance", "targetHistory"], "balance/range.yaml");
  validateScalarObject(range.targetHistory, ["windowSeconds", "samples"], "balance/range.yaml.targetHistory");
  const commander = exactKeys(config.balance.commander, ["armyCap"], "balance/commander.yaml");
  validateScalarObject(commander.armyCap, ["base", "skillPerAdditionalUnit"], "balance/commander.yaml.armyCap");
  validateScalarObject(config.balance.economy, ["baseIncome", "refineryIncome", "garrisonUpkeep"], "balance/economy.yaml");

  const materials = exactKeys(config.balance.materials, ["materials"], "balance/materials.yaml");
  const materialMap = exactKeys(materials.materials, ["basic", "reinforced", "ceramic", "reactive", "combined"], "balance/materials.yaml.materials");
  for (const [id, material] of Object.entries(materialMap)) {
    const item = exactKeys(material, ["label", "mass", "armor", "hp", "recoverPerSecond", "color"], `balance/materials.yaml.materials.${id}`);
    stringAt(item, "label", `materials.${id}`);
    stringAt(item, "color", `materials.${id}`);
    for (const key of ["mass", "armor", "hp", "recoverPerSecond"]) numberAt(item, key, `materials.${id}`);
  }

  const unitComponents = exactKeys(
    exactKeys(config.balance.units, ["components"], "balance/units.yaml").components,
    ["control", "engineS", "engineM", "jetEngine", "cannonLoader", "missileLoader"],
    "balance/units.yaml.components",
  );
  const weaponComponents = exactKeys(
    exactKeys(config.balance.weapons, ["components"], "balance/weapons.yaml").components,
    ["rapidGun", "heavyCannon", "explosiveShell", "trackingMissile", "precisionBeam"],
    "balance/weapons.yaml.components",
  );
  for (const [id, component] of Object.entries({ ...unitComponents, ...weaponComponents })) {
    const path = `components.${id}`;
    const commonKeys = ["mass", "hpMul", "gasCost", "type"];
    const engineKeys = [...commonKeys, "power", "maxSpeed", "propulsion"];
    const loaderKeys = [...commonKeys, "loader"];
    const weaponKeys = [
      ...commonKeys,
      "directional",
      "projectileClass",
      "projectileShape",
      "projectileSizeRatio",
      "maxLoadedAmmo",
      "recoil",
      "hitImpulse",
      "damage",
      "range",
      "cooldown",
      "hasAngleLimit",
      ...(id === "rapidGun" ? [] : ["cwAngle", "ccwAngle"]),
      "projectileSpeed",
      "projectileGravity",
      "penetration",
      ...(id === "rapidGun" || id === "heavyCannon" ? ["spreadDeg"] : []),
      ...(id === "explosiveShell" ? ["explosive"] : []),
      ...(id === "trackingMissile" ? ["tracking"] : []),
    ];
    const raw = objectAt(component, path);
    const item = exactKeys(
      raw,
      raw.type === "engine" ? engineKeys : raw.type === "loader" ? loaderKeys : raw.type === "weapon" ? weaponKeys : commonKeys,
      path,
    );
    for (const key of ["mass", "hpMul", "gasCost"]) numberAt(item, key, `components.${id}`);
    stringAt(item, "type", `components.${id}`);
    if (item.type === "engine") {
      numberAt(item, "power", path);
      numberAt(item, "maxSpeed", path);
      const propulsion = exactKeys(item.propulsion, ["platform", "mode"], `${path}.propulsion`);
      stringAt(propulsion, "platform", `${path}.propulsion`);
      stringAt(propulsion, "mode", `${path}.propulsion`);
    } else if (item.type === "loader") {
      const loader = exactKeys(item.loader, ["supports", "loadMultiplier", "fastOperation", "minLoadTime", "minBurstInterval"], `${path}.loader`);
      if (!Array.isArray(loader.supports) || loader.supports.some((entry) => typeof entry !== "string")) fail(`${path}.loader.supports`, "expected a string array");
      numberAt(loader, "loadMultiplier", `${path}.loader`);
      numberAt(loader, "minLoadTime", `${path}.loader`);
      numberAt(loader, "minBurstInterval", `${path}.loader`);
      booleanAt(loader, "fastOperation", `${path}.loader`);
    } else if (item.type === "weapon") {
      booleanAt(item, "directional", path);
      stringAt(item, "projectileClass", path);
      stringAt(item, "projectileShape", path);
      numberAt(item, "projectileSizeRatio", path);
      for (const key of ["maxLoadedAmmo", "recoil", "hitImpulse", "damage", "range", "cooldown", "projectileSpeed", "projectileGravity", "penetration"]) {
        numberAt(item, key, path);
      }
      booleanAt(item, "hasAngleLimit", path);
      if (item.hasAngleLimit) {
        numberAt(item, "cwAngle", path);
        numberAt(item, "ccwAngle", path);
      }
      if ("spreadDeg" in item) numberAt(item, "spreadDeg", path);
      if ("explosive" in item) validateScalarObject(item.explosive, ["blastRadius", "blastDamage", "falloffPower"], `${path}.explosive`);
      if ("tracking" in item) validateScalarObject(item.tracking, ["turnRateDegPerSec"], `${path}.tracking`);
    }
    finiteNumbers(item, `components.${id}`);
  }

  const campaign = exactKeys(config.balance.campaign, ["buildings", "research", "simulation", "logistics"], "balance/campaign.yaml");
  const buildings = exactKeys(campaign.buildings, ["refinery", "research-lab", "workshop", "delivery-center"], "balance/campaign.yaml.buildings");
  for (const [id, building] of Object.entries(buildings)) {
    const item = exactKeys(building, ["name", "size", "gasCost", "buildSeconds", "description"], `campaign.buildings.${id}`);
    stringAt(item, "name", `campaign.buildings.${id}`);
    stringAt(item, "size", `campaign.buildings.${id}`);
    stringAt(item, "description", `campaign.buildings.${id}`);
    numberAt(item, "gasCost", `campaign.buildings.${id}`);
    numberAt(item, "buildSeconds", `campaign.buildings.${id}`);
  }
  const research = exactKeys(campaign.research, ["reinforced", "combined", "mediumWeapons"], "balance/campaign.yaml.research");
  for (const [id, researchItem] of Object.entries(research)) {
    const item = exactKeys(researchItem, ["name", "gasCost", "durationSeconds"], `campaign.research.${id}`);
    stringAt(item, "name", `campaign.research.${id}`);
    numberAt(item, "gasCost", `campaign.research.${id}`);
    numberAt(item, "durationSeconds", `campaign.research.${id}`);
  }
  validateScalarObject(campaign.simulation, ["maxUpdateSeconds", "refineryIncomePerSecond", "baseDeliveryCapacity", "deliveryCenterCapacity"], "balance/campaign.yaml.simulation");
  validateScalarObject(campaign.logistics, ["defaultDistance", "outpostTravelSeconds", "minTravelSeconds", "distanceSecondsFactor", "minUnitSpeed", "maxDistanceCost", "distanceCostDivisor"], "balance/campaign.yaml.logistics");

  const shooting = exactKeys(config.ai.shooting, ["baseline", "ballisticSolver"], "ai/shooting.yaml");
  validateScalarObject(shooting.baseline, ["velocityFilterRatePerSecond", "leadGainNear", "leadGainFar", "accelerationSoftCap", "accelerationHardCap", "accelerationMinGain", "aimSlewDegreesPerSecond", "aimDeadbandDegrees"], "ai/shooting.yaml.baseline");
  validateScalarObject(shooting.ballisticSolver, ["minTimeSeconds", "horizonRangeScale", "minHorizonSeconds", "maxHorizonSeconds", "bracketSteps", "bisectionSteps", "speedErrorTolerance", "directRangeTolerance", "travelRangeTolerance", "minimumDivisor"], "ai/shooting.yaml.ballisticSolver");
  validateScalarObject(config.ai.levels, ["maxCertifiedLevel"], "ai/levels.yaml");

  const display = exactKeys(config.display.battle, ["view"], "display/battle.yaml");
  validateScalarObject(display.view, ["minScale", "maxScale", "verticalPadding", "cameraMargin", "designerBorderMargin"], "display/battle.yaml.view");
  const editor = exactKeys(config.editor.editor, ["grid", "displayKinds", "gameLoop"], "editor/editor.yaml");
  validateScalarObject(editor.grid, ["maxColumns", "maxRows"], "editor/editor.yaml.grid");
  if (!Array.isArray(editor.displayKinds) || editor.displayKinds.some((item) => typeof item !== "string")) fail("editor/editor.yaml.displayKinds", "expected a string array");
  validateScalarObject(editor.gameLoop, ["stepsPerSecond", "maxFrameSeconds", "minTimeScale", "maxTimeScale"], "editor/editor.yaml.gameLoop");

  const sound = exactKeys(config.sound.battle, ["volume", "samples", "firePools", "firePlaybackRates", "spatial", "synth"], "sound/battle.yaml");
  const volume = validateScalarObject(sound.volume, ["default", "min", "max"], "sound/battle.yaml.volume");
  if (!(numberAt(volume, "min", "sound.volume") <= numberAt(volume, "default", "sound.volume")
    && numberAt(volume, "default", "sound.volume") <= numberAt(volume, "max", "sound.volume"))) {
    fail("sound/battle.yaml.volume", "expected min <= default <= max");
  }
  const samples = objectAt(sound.samples, "sound/battle.yaml.samples");
  if (Object.keys(samples).length !== new Set(Object.keys(samples)).size) fail("sound/battle.yaml.samples", "duplicate sample keys");
  for (const [key, rawPath] of Object.entries(samples)) {
    if (typeof rawPath !== "string" || !rawPath) fail(`sound/battle.yaml.samples.${key}`, "expected a relative file path");
    const fullPath = resolve(audioDir, rawPath);
    if (fullPath !== audioDir && !fullPath.startsWith(`${audioDir}${sep}`)) fail(`sound/battle.yaml.samples.${key}`, "path escapes game-core/assets/audio");
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) fail(`sound/battle.yaml.samples.${key}`, `missing audio file ${rawPath}`);
  }
  const pools = exactKeys(sound.firePools, ["rapid-fire", "heavy-shot", "explosive", "tracking", "beam-precision"], "sound/battle.yaml.firePools");
  for (const [weaponClass, keys] of Object.entries(pools)) {
    if (!Array.isArray(keys) || keys.length === 0) fail(`sound.firePools.${weaponClass}`, "expected a non-empty sample-key array");
    for (const key of keys) if (typeof key !== "string" || !(key in samples)) fail(`sound.firePools.${weaponClass}`, `unknown sample key ${String(key)}`);
  }
  validateScalarObject(sound.firePlaybackRates, ["rapid-fire", "heavy-shot", "explosive", "tracking", "beam-precision"], "sound/battle.yaml.firePlaybackRates");
  validateScalarObject(sound.spatial, ["maxPan", "attenuationStart", "attenuationFactor", "muffleStart", "muffleSpan", "lowpassNearHz", "lowpassFarHz", "lowpassQ"], "sound/battle.yaml.spatial");
  const synth = exactKeys(sound.synth, ["envelopeFloor", "samplePlayback", "noiseBuffer", "fire", "cannonTail", "impact", "explosion", "spawn", "engine"], "sound/battle.yaml.synth");
  finiteNumbers(synth, "sound/battle.yaml.synth");
}

function parseYaml(relativePath) {
  const fullPath = resolve(configDir, relativePath);
  const document = parseDocument(readFileSync(fullPath, "utf8"), { uniqueKeys: true, strict: true });
  if (document.errors.length) fail(relativePath, document.errors.map((error) => error.message).join("; "));
  const parsed = objectAt(document.toJS({ maxAliasCount: 0 }), relativePath);
  const rawDescriptions = parsed[DESCRIPTIONS_KEY];
  if (!rawDescriptions || typeof rawDescriptions !== "object" || Array.isArray(rawDescriptions)) {
    fail(relativePath, `expected a ${DESCRIPTIONS_KEY} map`);
  }
  const config = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== DESCRIPTIONS_KEY));
  return { config, descriptionPatterns: rawDescriptions };
}

function loadConfigTree(tree) {
  const config = {};
  const descriptionPatterns = {};
  for (const [key, value] of Object.entries(tree)) {
    const loaded = typeof value === "string" ? parseYaml(value) : loadConfigTree(value);
    config[key] = loaded.config;
    descriptionPatterns[key] = loaded.descriptionPatterns;
  }
  return { config, descriptionPatterns };
}

function collectEditableLeaves(value, path = [], leaves = []) {
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    leaves.push(path.join("."));
    return leaves;
  }
  for (const [key, child] of Object.entries(value)) collectEditableLeaves(child, [...path, key], leaves);
  return leaves;
}

function patternMatches(pattern, path) {
  const patternParts = pattern.split(".");
  const pathParts = path.split(".");
  return patternParts.length === pathParts.length
    && patternParts.every((part, index) => part === "*" || part === pathParts[index]);
}

function resolveDescriptions(config, patterns, relativePath) {
  const entries = Object.entries(objectAt(patterns, `${relativePath}.${DESCRIPTIONS_KEY}`));
  for (const [pattern, description] of entries) {
    if (!pattern || typeof description !== "string" || !description.trim()) {
      fail(`${relativePath}.${DESCRIPTIONS_KEY}.${pattern}`, "expected a non-empty description");
    }
  }
  const leaves = collectEditableLeaves(config);
  const resolved = {};
  for (const leaf of leaves) {
    const matches = entries
      .filter(([pattern]) => patternMatches(pattern, leaf))
      .sort(([left], [right]) => right.split(".").filter((part) => part !== "*").length
        - left.split(".").filter((part) => part !== "*").length);
    if (!matches.length) fail(`${relativePath}.${DESCRIPTIONS_KEY}`, `missing description for ${leaf}`);
    const bestSpecificity = matches[0][0].split(".").filter((part) => part !== "*").length;
    const bestMatches = matches.filter(([pattern]) => pattern.split(".").filter((part) => part !== "*").length === bestSpecificity);
    if (bestMatches.length > 1) fail(`${relativePath}.${DESCRIPTIONS_KEY}`, `ambiguous descriptions for ${leaf}`);
    resolved[leaf] = bestMatches[0][1].trim();
  }
  const stale = entries.map(([pattern]) => pattern).filter((pattern) => !leaves.some((leaf) => patternMatches(pattern, leaf)));
  if (stale.length) fail(`${relativePath}.${DESCRIPTIONS_KEY}`, `unused description patterns: ${stale.join(", ")}`);
  return resolved;
}

function resolveDescriptionTree(configTree, patternTree, fileTree) {
  const descriptions = {};
  for (const [key, value] of Object.entries(fileTree)) {
    descriptions[key] = typeof value === "string"
      ? resolveDescriptions(configTree[key], patternTree[key], value)
      : resolveDescriptionTree(configTree[key], patternTree[key], value);
  }
  return descriptions;
}

function scanForExternalAudio(directory = repositoryDir) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_SCAN_DIRS.has(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      scanForExternalAudio(fullPath);
    } else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase()) && !fullPath.startsWith(`${audioDir}${sep}`)) {
      fail(relative(repositoryDir, fullPath), "audio source files must live under game-core/assets/audio");
    }
  }
}

function renderGenerated(config, descriptions) {
  return [
    "/* Generated from the YAML files under game-core/src/config. Do not edit directly. */",
    `export const GAME_CONFIG = ${JSON.stringify(config, null, 2)} as const;`,
    "",
    `export const GAME_CONFIG_DESCRIPTIONS = ${JSON.stringify(descriptions, null, 2)} as const;`,
    "",
    "export type GameConfig = typeof GAME_CONFIG;",
    "export type GameConfigDescriptions = typeof GAME_CONFIG_DESCRIPTIONS;",
    "",
  ].join("\n");
}

export function generateGameConfig({ check = false } = {}) {
  const { config, descriptionPatterns } = loadConfigTree(CONFIG_FILES);
  validateGameConfig(config);
  const descriptions = resolveDescriptionTree(config, descriptionPatterns, CONFIG_FILES);
  scanForExternalAudio();
  const output = renderGenerated(config, descriptions);
  const current = existsSync(generatedConfigPath) ? readFileSync(generatedConfigPath, "utf8") : "";
  if (check) {
    if (current !== output) throw new Error(`Generated config is stale: ${relative(repositoryDir, generatedConfigPath)}`);
    return { changed: false, config, descriptions, descriptionPatterns };
  }
  if (current !== output) {
    mkdirSync(dirname(generatedConfigPath), { recursive: true });
    writeFileSync(generatedConfigPath, output, "utf8");
  }
  return { changed: current !== output, config, descriptions, descriptionPatterns };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    const result = generateGameConfig({ check: process.argv.includes("--check") });
    process.stdout.write(`${result.changed ? "generated" : "verified"} ${relative(repositoryDir, generatedConfigPath)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
