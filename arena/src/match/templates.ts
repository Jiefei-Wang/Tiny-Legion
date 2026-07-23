import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInitialTemplates } from "../../../game-core/src/simulation/units/unit-builder.ts";
import {
  mergePartCatalogs,
  parsePartDefinition,
} from "../../../game-core/src/parts/part-schema.ts";
import { mergeTemplates, parseTemplate } from "../../../game-core/src/templates/template-schema.ts";
import type { PartDefinition, UnitTemplate } from "../../../game-core/src/types.ts";

function locateVipDir(): string {
  const candidates = [
    resolve(process.cwd(), "vip"),
    resolve(process.cwd(), "..", "vip"),
  ];
  return candidates.find((candidate) => existsSync(resolve(candidate, "templates"))) ?? candidates[0]!;
}

function readPartDir(dirPath: string): PartDefinition[] {
  if (!existsSync(dirPath)) return [];
  const results: PartDefinition[] = [];
  for (const fileName of readdirSync(dirPath).filter((name) => name.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(dirPath, fileName), "utf8")) as unknown;
      const part = parsePartDefinition(parsed);
      if (part) results.push(part);
    } catch {
      // A malformed authoring file must not hide the rest of the runtime catalog.
    }
  }
  return results;
}

export function loadRuntimeMergedParts(): PartDefinition[] {
  const vipDir = locateVipDir();
  return mergePartCatalogs(
    readPartDir(resolve(vipDir, "parts", "default")),
    readPartDir(resolve(vipDir, "parts", "user")),
  );
}

function locateGameTemplatesDir(): { defaultDir: string; userDir: string } {
  const vipDir = locateVipDir();
  return {
    defaultDir: resolve(vipDir, "templates", "default"),
    userDir: resolve(vipDir, "templates", "user"),
  };
}

export async function loadRuntimeMergedTemplates(partCatalog: ReadonlyArray<PartDefinition> = loadRuntimeMergedParts()): Promise<UnitTemplate[]> {
  const baseTemplates = createInitialTemplates();
  const { defaultDir, userDir } = locateGameTemplatesDir();

  const readDir = (dirPath: string): UnitTemplate[] => {
    if (!existsSync(dirPath)) {
      return [];
    }
    const files = readdirSync(dirPath).filter((name: string) => name.endsWith(".json"));
    const results: UnitTemplate[] = [];
    for (const fileName of files) {
      try {
        const raw = readFileSync(`${dirPath}/${fileName}`, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        const template = parseTemplate(parsed, {
          injectLoaders: true,
          sanitizePlacement: true,
          partCatalog,
        });
        if (template) {
          results.push(template);
        }
      } catch {
        continue;
      }
    }
    return results;
  };

  const defaults = readDir(defaultDir);
  const users = readDir(userDir);
  return mergeTemplates(baseTemplates, mergeTemplates(defaults, users));
}
