import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Params } from "../ai/ai-schema.ts";

export type StoredModel = {
  id: string;
  aiFamilyId: string;
  params: Params;
  score: number;
  winRate: number;
  winRateLowerBound: number;
  avgGasWorthDelta: number;
  createdAt: string;
  generation: number;
  runId: string;
};

export class ModelStore {
  private readonly dir: string;
  private readonly maxModels: number;

  constructor(rootDir: string, aiFamilyId: string, maxModels: number) {
    this.dir = resolve(rootDir, "models", aiFamilyId);
    this.maxModels = Math.max(1, Math.floor(maxModels));
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private indexPath(): string {
    return resolve(this.dir, "index.json");
  }

  public load(): StoredModel[] {
    const path = this.indexPath();
    if (!existsSync(path)) {
      return [];
    }
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as StoredModel[]) : [];
    } catch {
      return [];
    }
  }

  public save(models: StoredModel[]): void {
    const sorted = [...models].sort((a, b) => b.score - a.score).slice(0, this.maxModels);
    writeFileSync(this.indexPath(), JSON.stringify(sorted, null, 2), "utf8");
  }
}
