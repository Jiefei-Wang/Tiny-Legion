import { existsSync, readFileSync, readdirSync } from "node:fs";
import { locateGameTemplatesDir, loadTemplateStoreModule, loadUnitBuilderModule } from "../game/game-loader.ts";

export async function loadRuntimeMergedTemplates(): Promise<any[]> {
  const { createInitialTemplates } = await loadUnitBuilderModule();
  const { mergeTemplates, parseTemplate } = await loadTemplateStoreModule();
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
