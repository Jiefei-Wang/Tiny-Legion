import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function findRepoRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidateGameDir = resolve(current, "game");
    const candidateGamePkg = resolve(candidateGameDir, "package.json");
    const candidateGameSrc = resolve(candidateGameDir, "src");
    if (existsSync(candidateGamePkg) && existsSync(candidateGameSrc)) {
      return current;
    }
    const next = resolve(current, "..");
    if (next === current) {
      break;
    }
    current = next;
  }
  throw new Error(`Failed to locate repo root from ${startDir}`);
}

function gameHeadlessSrcDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  return resolve(repoRoot, "game", ".headless-dist", "src");
}

async function importGameModule(relativeJsPath: string): Promise<any> {
  const srcDir = gameHeadlessSrcDir();
  const fullPath = resolve(srcDir, relativeJsPath);
  const url = pathToFileURL(fullPath).href;
  return import(url);
}

export async function loadBattleSessionModule(): Promise<any> {
  return importGameModule("gameplay/battle/battle-session.js");
}

export async function loadUnitBuilderModule(): Promise<any> {
  return importGameModule("simulation/units/unit-builder.js");
}

export async function loadTemplateStoreModule(): Promise<any> {
  return importGameModule("app/template-store.js");
}

export async function loadWeaponsModule(): Promise<any> {
  return importGameModule("config/balance/weapons.js");
}

export async function loadDecisionTreeModule(): Promise<any> {
  return importGameModule("ai/decision-tree/combat-decision-tree.js");
}

export async function loadStructureGridModule(): Promise<any> {
  return importGameModule("simulation/units/structure-grid.js");
}

export function locateGameTemplatesDir(): { defaultDir: string; userDir: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  return {
    defaultDir: resolve(repoRoot, "game", "templates", "default"),
    userDir: resolve(repoRoot, "game", "templates", "user"),
  };
}
