import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInitialTemplates } from "../../../packages/game-core/src/simulation/units/unit-builder.ts";
import { mergeTemplates, parseTemplate } from "../../../packages/game-core/src/templates/template-schema.ts";

function locateGameTemplatesDir(): { defaultDir: string; userDir: string } {
  const rootDir = resolve(process.cwd(), "..");
  return {
    defaultDir: resolve(rootDir, "game", "templates", "default"),
    userDir: resolve(rootDir, "game", "templates", "user"),
  };
}

export async function loadRuntimeMergedTemplates(): Promise<any[]> {
  const baseTemplates = createInitialTemplates();
  const { defaultDir, userDir } = locateGameTemplatesDir();

  const readDir = (dirPath: string): any[] => {
    if (!existsSync(dirPath)) {
      return [];
    }
    const files = readdirSync(dirPath).filter((name: string) => name.endsWith(".json"));
    const results: any[] = [];
    for (const fileName of files) {
      try {
        const raw = readFileSync(`${dirPath}/${fileName}`, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        const template = parseTemplate(parsed);
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
