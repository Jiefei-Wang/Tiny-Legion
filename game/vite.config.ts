import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vite";
import { parseTemplate } from "../packages/game-core/src/templates/template-schema.ts";
import {
  mergePartCatalogs,
  parsePartDefinition,
} from "../packages/game-core/src/parts/part-schema.ts";
import { runMatch } from "../arena/src/match/run-match.ts";
import type { MatchAiSpec, MatchResult, MatchSpec } from "../arena/src/match/match-types.ts";

function debugLogPlugin() {
  const logDir = resolve(process.cwd(), ".debug");
  const logFile = resolve(logDir, "runtime.log");
  let enabled = process.env.DEBUG_LOG === "1";

  const writeLog = (line: string): void => {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf8");
  };

  return {
    name: "local-debug-log",
    configureServer(server: import("vite").ViteDevServer) {
      if (enabled) {
        writeLog("[server] debug logging enabled via DEBUG_LOG=1");
      }

      server.middlewares.use("/__debug/toggle", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            enabled = Boolean(parsed.enabled);
            writeLog(`[client] debug logging ${enabled ? "enabled" : "disabled"}`);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, enabled }));
          } catch {
            res.statusCode = 400;
            res.end("bad request");
          }
        });
      });

      server.middlewares.use("/__debug/log", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            if (enabled) {
              const level = typeof parsed.level === "string" ? parsed.level : "info";
              const message = typeof parsed.message === "string" ? parsed.message : "(no message)";
              writeLog(`[${level}] ${message}`);
            }
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, enabled }));
          } catch {
            res.statusCode = 400;
            res.end("bad request");
          }
        });
      });
    },
  };
}

function debugProbePlugin() {
  type DebugProbeQuery = Record<string, unknown>;
  type DebugProbeRequest = {
    id: string;
    clientId: string;
    createdAtMs: number;
    queries: DebugProbeQuery[];
  };
  type DebugProbeResult = {
    ok: boolean;
    results?: unknown[];
    errors?: string[];
  };

  const pendingByClientId = new Map<string, DebugProbeRequest[]>();
  const requestsById = new Map<string, DebugProbeRequest>();
  const resultsById = new Map<string, { completedAtMs: number; result: DebugProbeResult }>();
  let seq = 1;

  const json = (res: any, status: number, payload: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  };

  const readBody = (req: any, cb: (raw: string) => void): void => {
    let body = "";
    req.on("data", (chunk: any) => {
      body += String(chunk);
    });
    req.on("end", () => cb(body));
  };

  const parseJsonBody = (req: any, res: any, cb: (parsed: any) => void): void => {
    readBody(req, (raw) => {
      try {
        cb(JSON.parse(raw || "{}"));
      } catch {
        json(res, 400, { ok: false, reason: "bad_json" });
      }
    });
  };

  const getUrl = (req: any): URL => {
    return new URL(req.url ?? "", "http://localhost");
  };

  const getPathSegments = (req: any): string[] => {
    const rawUrl = req.url ?? "";
    const path = rawUrl.split("?")[0] ?? "";
    return path.split("/").filter(Boolean);
  };

  const allocateId = (): string => {
    const ts = Date.now().toString(36);
    const n = (seq++).toString(36);
    return `p_${ts}_${n}`;
  };

  return {
    name: "debug-probe",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use("/__debug/probe", (req, res) => {
        const method = req.method ?? "GET";
        const segments = getPathSegments(req);

        // POST /__debug/probe
        if (segments.length === 0) {
          if (method !== "POST") {
            return json(res, 405, { ok: false, reason: "method_not_allowed" });
          }
          return parseJsonBody(req, res, (parsed) => {
            const clientId = typeof parsed.clientId === "string" ? parsed.clientId.trim() : "";
            const queries = Array.isArray(parsed.queries) ? parsed.queries : null;
            if (!clientId || !queries) {
              return json(res, 400, { ok: false, reason: "invalid_request" });
            }
            if (queries.length > 100) {
              return json(res, 400, { ok: false, reason: "too_many_queries" });
            }

            const id = allocateId();
            const probe: DebugProbeRequest = {
              id,
              clientId,
              createdAtMs: Date.now(),
              queries: queries as DebugProbeQuery[],
            };
            requestsById.set(id, probe);
            const queue = pendingByClientId.get(clientId) ?? [];
            queue.push(probe);
            pendingByClientId.set(clientId, queue);
            return json(res, 200, { ok: true, probeId: id });
          });
        }

        // GET /__debug/probe/next?clientId=...
        if (segments.length === 1 && segments[0] === "next") {
          if (method !== "GET") {
            return json(res, 405, { ok: false, reason: "method_not_allowed" });
          }
          const url = getUrl(req);
          const clientId = url.searchParams.get("clientId")?.trim() ?? "";
          if (!clientId) {
            return json(res, 400, { ok: false, reason: "missing_clientId" });
          }
          const queue = pendingByClientId.get(clientId) ?? [];
          const probe = queue.shift() ?? null;
          pendingByClientId.set(clientId, queue);
          return json(res, 200, { ok: true, probe });
        }

        // GET /__debug/probe/:probeId
        // POST /__debug/probe/:probeId/response
        if (segments.length >= 1) {
          const probeId = segments[0] ?? "";
          if (!probeId) {
            return json(res, 400, { ok: false, reason: "missing_probeId" });
          }

          if (segments.length === 1) {
            if (method !== "GET") {
              return json(res, 405, { ok: false, reason: "method_not_allowed" });
            }
            const probe = requestsById.get(probeId) ?? null;
            if (!probe) {
              return json(res, 404, { ok: false, reason: "probe_not_found" });
            }
            const done = resultsById.get(probeId);
            if (!done) {
              return json(res, 200, { ok: true, status: "pending" });
            }
            return json(res, 200, { ok: true, status: "done", result: done.result, completedAtMs: done.completedAtMs });
          }

          if (segments.length === 2 && segments[1] === "response") {
            if (method !== "POST") {
              return json(res, 405, { ok: false, reason: "method_not_allowed" });
            }
            const probe = requestsById.get(probeId) ?? null;
            if (!probe) {
              return json(res, 404, { ok: false, reason: "probe_not_found" });
            }
            return parseJsonBody(req, res, (parsed) => {
              const ok = Boolean(parsed.ok);
              const results = Array.isArray(parsed.results) ? parsed.results : undefined;
              const errors = Array.isArray(parsed.errors) ? parsed.errors.map((e) => String(e)) : undefined;
              resultsById.set(probeId, { completedAtMs: Date.now(), result: { ok, results, errors } });
              return json(res, 200, { ok: true });
            });
          }
        }

        return json(res, 404, { ok: false, reason: "not_found" });
      });
    },
  };
}

function templateStorePlugin() {
  const rootDir = process.cwd();
  const defaultDir = resolve(rootDir, "templates", "default");
  const userDir = resolve(rootDir, "templates", "user");
  const partDefaultDir = resolve(rootDir, "parts", "default");
  const partUserDir = resolve(rootDir, "parts", "user");

  const ensureDir = (dirPath: string): void => {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  };

  const safeId = (raw: string): string | null => {
    const id = raw.trim();
    return /^[a-z0-9-]+$/.test(id) ? id : null;
  };

  const readPartsInDir = (dirPath: string): Array<NonNullable<ReturnType<typeof parsePartDefinition>>> => {
    ensureDir(dirPath);
    const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
    const results: Array<NonNullable<ReturnType<typeof parsePartDefinition>>> = [];
    for (const fileName of files) {
      const filePath = resolve(dirPath, fileName);
      try {
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const normalized = parsePartDefinition(parsed);
        if (!normalized) {
          continue;
        }
        const normalizedRaw = `${JSON.stringify(normalized, null, 2)}\n`;
        if (raw !== normalizedRaw) {
          writeFileSync(filePath, normalizedRaw, "utf8");
        }
        results.push(normalized);
      } catch {
        continue;
      }
    }
    return results;
  };

  const loadPartCatalog = (): Array<NonNullable<ReturnType<typeof parsePartDefinition>>> => {
    const fromDefault = readPartsInDir(partDefaultDir);
    const fromUser = readPartsInDir(partUserDir);
    return mergePartCatalogs(fromDefault, fromUser);
  };

  const readTemplatesInDir = (dirPath: string): unknown[] => {
    ensureDir(dirPath);
    const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
    const results: unknown[] = [];
    const partCatalog = loadPartCatalog();
    for (const fileName of files) {
      const filePath = resolve(dirPath, fileName);
      try {
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const normalized = parseTemplate(parsed, {
          injectLoaders: true,
          sanitizePlacement: true,
          partCatalog,
        });
        if (!normalized) {
          continue;
        }
        const normalizedRaw = `${JSON.stringify(normalized, null, 2)}\n`;
        if (raw !== normalizedRaw) {
          writeFileSync(filePath, normalizedRaw, "utf8");
        }
        results.push(normalized);
      } catch {
        continue;
      }
    }
    return results;
  };

  return {
    name: "template-store",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use("/__templates/default", (req, res) => {
        if (req.method === "GET") {
          const templates = readTemplatesInDir(defaultDir);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ templates }));
          return;
        }
        if (req.method !== "PUT" && req.method !== "DELETE") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const rawUrl = req.url ?? "";
        const idSegment = rawUrl.split("/").filter(Boolean).at(-1) ?? "";
        const id = safeId(idSegment);
        if (!id) {
          res.statusCode = 400;
          res.end("invalid template id");
          return;
        }
        ensureDir(defaultDir);

        if (req.method === "DELETE") {
          const filePath = resolve(defaultDir, `${id}.json`);
          if (existsSync(filePath)) {
            unlinkSync(filePath);
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const normalized = parseTemplate(parsed, {
              injectLoaders: true,
              sanitizePlacement: true,
              partCatalog: loadPartCatalog(),
            });
            if (!normalized) {
              res.statusCode = 400;
              res.end("invalid template payload");
              return;
            }
            const filePath = resolve(defaultDir, `${id}.json`);
            writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.statusCode = 400;
            res.end("bad request");
          }
        });
      });

      server.middlewares.use("/__templates/user", (req, res) => {
        if (req.method === "GET") {
          const templates = readTemplatesInDir(userDir);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ templates }));
          return;
        }
        if (req.method !== "PUT" && req.method !== "DELETE") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const rawUrl = req.url ?? "";
        const idSegment = rawUrl.split("/").filter(Boolean).at(-1) ?? "";
        const id = safeId(idSegment);
        if (!id) {
          res.statusCode = 400;
          res.end("invalid template id");
          return;
        }
        ensureDir(userDir);

        if (req.method === "DELETE") {
          const filePath = resolve(userDir, `${id}.json`);
          if (existsSync(filePath)) {
            unlinkSync(filePath);
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const normalized = parseTemplate(parsed, {
              injectLoaders: true,
              sanitizePlacement: true,
              partCatalog: loadPartCatalog(),
            });
            if (!normalized) {
              res.statusCode = 400;
              res.end("invalid template payload");
              return;
            }
            const filePath = resolve(userDir, `${id}.json`);
            writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.statusCode = 400;
            res.end("bad request");
          }
        });
      });
    },
  };
}

function partStorePlugin() {
  const rootDir = process.cwd();
  const defaultDir = resolve(rootDir, "parts", "default");
  const userDir = resolve(rootDir, "parts", "user");

  const ensureDir = (dirPath: string): void => {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  };

  const safeId = (raw: string): string | null => {
    const id = raw.trim();
    return /^[a-z0-9-]+$/.test(id) ? id : null;
  };

  const readPartsInDir = (dirPath: string): Array<NonNullable<ReturnType<typeof parsePartDefinition>>> => {
    ensureDir(dirPath);
    const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
    const results: Array<NonNullable<ReturnType<typeof parsePartDefinition>>> = [];
    for (const fileName of files) {
      const filePath = resolve(dirPath, fileName);
      try {
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const normalized = parsePartDefinition(parsed);
        if (!normalized) {
          continue;
        }
        const normalizedRaw = `${JSON.stringify(normalized, null, 2)}\n`;
        if (raw !== normalizedRaw) {
          writeFileSync(filePath, normalizedRaw, "utf8");
        }
        results.push(normalized);
      } catch {
        continue;
      }
    }
    return results;
  };

  const readDefaultParts = (): Array<NonNullable<ReturnType<typeof parsePartDefinition>>> => {
    const fileBacked = readPartsInDir(defaultDir);
    return fileBacked;
  };

  return {
    name: "part-store",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use("/__parts/default", (req, res) => {
        if (req.method === "GET") {
          const parts = readDefaultParts();
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ parts }));
          return;
        }
        if (req.method !== "PUT" && req.method !== "DELETE") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const rawUrl = req.url ?? "";
        const idSegment = rawUrl.split("/").filter(Boolean).at(-1) ?? "";
        const id = safeId(idSegment);
        if (!id) {
          res.statusCode = 400;
          res.end("invalid part id");
          return;
        }
        ensureDir(defaultDir);

        if (req.method === "DELETE") {
          const filePath = resolve(defaultDir, `${id}.json`);
          if (existsSync(filePath)) {
            unlinkSync(filePath);
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const normalized = parsePartDefinition({ ...parsed, id });
            if (!normalized) {
              res.statusCode = 400;
              res.end("invalid part payload");
              return;
            }
            const filePath = resolve(defaultDir, `${id}.json`);
            writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.statusCode = 400;
            res.end("bad request");
          }
        });
      });

      server.middlewares.use("/__parts/user", (req, res) => {
        if (req.method === "GET") {
          const parts = readPartsInDir(userDir);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ parts }));
          return;
        }
        if (req.method !== "PUT" && req.method !== "DELETE") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const rawUrl = req.url ?? "";
        const idSegment = rawUrl.split("/").filter(Boolean).at(-1) ?? "";
        const id = safeId(idSegment);
        if (!id) {
          res.statusCode = 400;
          res.end("invalid part id");
          return;
        }
        ensureDir(userDir);

        if (req.method === "DELETE") {
          const filePath = resolve(userDir, `${id}.json`);
          if (existsSync(filePath)) {
            unlinkSync(filePath);
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const normalized = parsePartDefinition({ ...parsed, id });
            if (!normalized) {
              res.statusCode = 400;
              res.end("invalid part payload");
              return;
            }
            const filePath = resolve(userDir, `${id}.json`);
            writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.statusCode = 400;
            res.end("bad request");
          }
        });
      });
    },
  };
}

function arenaModelPlugin() {
  const arenaDataDir = resolve(process.cwd(), "..", "arena", ".arena-data");
  const runsDir = resolve(arenaDataDir, "runs");
  const leaderboardDir = resolve(arenaDataDir, "leaderboard");
  const leaderboardFile = resolve(leaderboardDir, "composite-elo.json");
  const phaseConfigFile = resolve(process.cwd(), "..", "arena", "composite-training.phases.json");
  const BASELINE_MODEL_ID = "baseline-game-ai";
  let leaderboardCompeteBusy = false;
  const leaderboardParallelWorkers = Math.max(
    1,
    typeof availableParallelism === "function" ? availableParallelism() : cpus().length,
  );
  const workerPoolModuleFile = resolve(process.cwd(), "..", "arena", ".dist", "arena", "src", "lib", "worker-pool.js");
  let workerPoolPromise: Promise<{ run: (payload: unknown) => Promise<unknown>; close: () => Promise<void> } | null> | null = null;

  type ModuleEntry = {
    id: string;
    label: string;
    spec?: { familyId: string; params: Record<string, number | boolean> };
    compatible?: boolean;
    reason?: string;
  };
  type CompositeRun = {
    runId: string;
    spec: MatchAiSpec;
    mtimeMs: number;
  };
  type RatingEntry = {
    score: number;
    rounds: number;
    games: number;
    wins: number;
    losses: number;
    ties: number;
    updatedAtMs: number;
  };
  type RatingStore = {
    version: 1;
    updatedAt: string;
    ratings: Record<string, RatingEntry>;
    matchupRounds: Record<string, number>;
  };
  type LeaderboardEntry = {
    runId: string;
    score: number;
    rounds: number;
    games: number;
    wins: number;
    losses: number;
    ties: number;
    isUnranked: boolean;
    mtimeMs: number;
    spec: MatchAiSpec;
  };
  type LeaderboardPhaseScenario = {
    withBase: boolean;
    initialUnitsPerSide: number;
    templateNames: string[];
    battlefield?: {
      width?: number;
      height?: number;
      groundHeight?: number;
    };
  };

  const round2 = (value: number): number => Math.round(value * 100) / 100;
  const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(min, Math.min(max, n));
  };
  const randomIndex = (length: number): number => Math.max(0, Math.min(length - 1, Math.floor(Math.random() * length)));
  const matchupKey = (a: string, b: string): string => (a < b ? `${a}__${b}` : `${b}__${a}`);
  const defaultRatingEntry = (): RatingEntry => ({
    score: 100,
    rounds: 0,
    games: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    updatedAtMs: Date.now(),
  });
  const baselineCompositeSpec = (): MatchAiSpec => ({
    familyId: "composite",
    params: {},
    composite: {
      target: { familyId: "baseline-target", params: {} },
      movement: { familyId: "baseline-movement", params: {} },
      shoot: { familyId: "baseline-shoot", params: {} },
    },
  });
  const getWorkerPool = async (): Promise<{ run: (payload: unknown) => Promise<unknown>; close: () => Promise<void> } | null> => {
    if (!workerPoolPromise) {
      workerPoolPromise = (async () => {
        if (!existsSync(workerPoolModuleFile)) {
          return null;
        }
        try {
          const workerPoolModule = await import(pathToFileURL(workerPoolModuleFile).href) as {
            WorkerPool?: {
              new (workerFileUrl: string, size: number): {
                run: (payload: unknown) => Promise<unknown>;
                close: () => Promise<void>;
              };
              matchWorkerUrl: () => string;
            };
          };
          const WorkerPoolCtor = workerPoolModule.WorkerPool;
          if (!WorkerPoolCtor) {
            return null;
          }
          return new WorkerPoolCtor(WorkerPoolCtor.matchWorkerUrl(), leaderboardParallelWorkers);
        } catch {
          return null;
        }
      })();
    }
    return workerPoolPromise;
  };

  const isCompositeSpec = (value: unknown): value is MatchAiSpec => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const obj = value as Record<string, unknown>;
    if (obj.familyId !== "composite") {
      return false;
    }
    const composite = obj.composite;
    if (!composite || typeof composite !== "object") {
      return false;
    }
    const c = composite as Record<string, unknown>;
    const hasModule = (kind: "target" | "movement" | "shoot"): boolean => {
      const module = c[kind];
      if (!module || typeof module !== "object") {
        return false;
      }
      const mod = module as Record<string, unknown>;
      return typeof mod.familyId === "string";
    };
    return hasModule("target") && hasModule("movement") && hasModule("shoot");
  };

  const collectCompositeRuns = (): CompositeRun[] => {
    const out: CompositeRun[] = [];
    if (!existsSync(runsDir)) {
      return out;
    }
    const runIds = readdirSync(runsDir);
    for (const runId of runIds) {
      const filePath = resolve(runsDir, runId, "best-composite.json");
      if (!existsSync(filePath)) {
        continue;
      }
      try {
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!isCompositeSpec(parsed)) {
          continue;
        }
        const stat = statSync(filePath);
        out.push({
          runId,
          spec: parsed,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
    return out;
  };

  const collectLeaderboardModels = (): CompositeRun[] => {
    const models = collectCompositeRuns();
    models.push({
      runId: BASELINE_MODEL_ID,
      spec: baselineCompositeSpec(),
      mtimeMs: 0,
    });
    return models;
  };

  const loadLeaderboardPhaseScenario = (): LeaderboardPhaseScenario => {
    const fallback: LeaderboardPhaseScenario = {
      withBase: true,
      initialUnitsPerSide: 4,
      templateNames: ["*"],
      battlefield: { width: 2000, height: 1000 },
    };
    if (!existsSync(phaseConfigFile)) {
      return fallback;
    }
    try {
      const raw = readFileSync(phaseConfigFile, "utf8");
      const parsed = JSON.parse(raw) as {
        phases?: Array<Record<string, unknown>>;
        byComponent?: Record<string, Array<Record<string, unknown>>>;
      };
      const fromGlobal = Array.isArray(parsed?.phases)
        ? parsed.phases.find((phase) => phase && phase.id === "p4-leaderboard")
        : null;
      const fromByComponent = parsed?.byComponent && typeof parsed.byComponent === "object"
        ? (["shoot", "movement", "target"] as const)
          .flatMap((kind) => Array.isArray(parsed.byComponent?.[kind]) ? parsed.byComponent[kind] : [])
          .find((phase) => phase && phase.id === "p4-leaderboard")
        : null;
      const source = (fromGlobal ?? fromByComponent) as Record<string, unknown> | null;
      if (!source) {
        return fallback;
      }
      const withBase = Boolean(source.withBase);
      const initialUnitsPerSide = Math.max(1, Math.floor(typeof source.initialUnitsPerSide === "number" ? source.initialUnitsPerSide : fallback.initialUnitsPerSide));
      const templateNames = Array.isArray(source.templateNames) && source.templateNames.length > 0
        ? source.templateNames.map((v) => String(v)).filter((v) => v.trim().length > 0)
        : fallback.templateNames;
      const bf = source.battlefield && typeof source.battlefield === "object" ? source.battlefield as Record<string, unknown> : null;
      const battlefield = bf
        ? {
          ...(typeof bf.width === "number" ? { width: Math.max(640, Math.min(4096, Math.floor(bf.width))) } : {}),
          ...(typeof bf.height === "number" ? { height: Math.max(360, Math.min(2160, Math.floor(bf.height))) } : {}),
          ...(typeof bf.groundHeight === "number" ? { groundHeight: Math.max(80, Math.floor(bf.groundHeight)) } : {}),
        }
        : fallback.battlefield;
      return {
        withBase,
        initialUnitsPerSide,
        templateNames,
        ...(battlefield ? { battlefield } : {}),
      };
    } catch {
      return fallback;
    }
  };

  const loadRatingStore = (): RatingStore => {
    if (!existsSync(leaderboardFile)) {
      return { version: 1, updatedAt: new Date().toISOString(), ratings: {}, matchupRounds: {} };
    }
    try {
      const raw = readFileSync(leaderboardFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return { version: 1, updatedAt: new Date().toISOString(), ratings: {}, matchupRounds: {} };
      }
      const obj = parsed as Record<string, unknown>;
      const ratingsRaw = (obj.ratings && typeof obj.ratings === "object") ? obj.ratings as Record<string, unknown> : {};
      const matchupRaw = (obj.matchupRounds && typeof obj.matchupRounds === "object")
        ? obj.matchupRounds as Record<string, unknown>
        : {};
      const ratings: Record<string, RatingEntry> = {};
      const matchupRounds: Record<string, number> = {};
      for (const [runId, entryRaw] of Object.entries(ratingsRaw)) {
        if (!entryRaw || typeof entryRaw !== "object") {
          continue;
        }
        const e = entryRaw as Record<string, unknown>;
        ratings[runId] = {
          score: Number.isFinite(e.score) ? Number(e.score) : 100,
          rounds: clampInt((Number.isFinite(e.rounds) ? e.rounds : e.games), 0, 1_000_000, 0),
          games: clampInt(e.games, 0, 1_000_000, 0),
          wins: clampInt(e.wins, 0, 1_000_000, 0),
          losses: clampInt(e.losses, 0, 1_000_000, 0),
          ties: clampInt(e.ties, 0, 1_000_000, 0),
          updatedAtMs: Number.isFinite(e.updatedAtMs) ? Number(e.updatedAtMs) : Date.now(),
        };
      }
      for (const [key, value] of Object.entries(matchupRaw)) {
        matchupRounds[key] = clampInt(value, 0, 1_000_000_000, 0);
      }
      return {
        version: 1,
        updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
        ratings,
        matchupRounds,
      };
    } catch {
      return { version: 1, updatedAt: new Date().toISOString(), ratings: {}, matchupRounds: {} };
    }
  };

  const saveRatingStore = (store: RatingStore): void => {
    mkdirSync(leaderboardDir, { recursive: true });
    store.updatedAt = new Date().toISOString();
    writeFileSync(leaderboardFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  };

  const ensureRatingsForRuns = (store: RatingStore, runs: CompositeRun[]): boolean => {
    let changed = false;
    for (const run of runs) {
      if (!store.ratings[run.runId]) {
        store.ratings[run.runId] = defaultRatingEntry();
        changed = true;
      }
    }
    return changed;
  };

  const buildLeaderboardEntries = (): LeaderboardEntry[] => {
    const runs = collectLeaderboardModels();
    const store = loadRatingStore();
    const changed = ensureRatingsForRuns(store, runs);
    if (changed) {
      saveRatingStore(store);
    }
    const entries = runs.map((run) => {
      const rating = store.ratings[run.runId] ?? defaultRatingEntry();
      return {
        runId: run.runId,
        score: round2(Math.max(1, rating.score)),
        rounds: rating.rounds,
        games: rating.games,
        wins: rating.wins,
        losses: rating.losses,
        ties: rating.ties,
        isUnranked: rating.rounds <= 0,
        mtimeMs: run.mtimeMs,
        spec: run.spec,
      };
    });
    entries.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.rounds !== a.rounds) {
        return b.rounds - a.rounds;
      }
      return b.mtimeMs - a.mtimeMs;
    });
    return entries;
  };

  const expectedScore = (scoreA: number, scoreB: number): number => {
    const scale = 80;
    return 1 / (1 + 10 ** ((scoreB - scoreA) / scale));
  };

  const applyLeaderboardMatch = (
    store: RatingStore,
    runA: string,
    runB: string,
    outcomeA: 0 | 0.5 | 1,
  ): { deltaA: number; deltaB: number } => {
    const a = store.ratings[runA] ?? (store.ratings[runA] = defaultRatingEntry());
    const b = store.ratings[runB] ?? (store.ratings[runB] = defaultRatingEntry());
    const pairKey = matchupKey(runA, runB);
    const pairRounds = Math.max(0, Math.floor(store.matchupRounds[pairKey] ?? 0));
    const kBase = 24;
    const k = kBase / Math.pow(1 + pairRounds, 1.15);
    const ea = expectedScore(a.score, b.score);
    const deltaA = k * (outcomeA - ea);
    const deltaB = -deltaA;
    a.score = round2(a.score + deltaA);
    b.score = round2(b.score + deltaB);
    store.matchupRounds[pairKey] = pairRounds + 1;
    a.rounds += 1;
    b.rounds += 1;
    a.games += 1;
    b.games += 1;
    if (outcomeA >= 0.99) {
      a.wins += 1;
      b.losses += 1;
    } else if (outcomeA <= 0.01) {
      a.losses += 1;
      b.wins += 1;
    } else {
      a.ties += 1;
      b.ties += 1;
    }
    const now = Date.now();
    a.updatedAtMs = now;
    b.updatedAtMs = now;
    return { deltaA: round2(deltaA), deltaB: round2(deltaB) };
  };

  const json = (res: any, statusCode: number, payload: unknown): void => {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  };

  return {
    name: "arena-models",
    configureServer(server: import("vite").ViteDevServer) {
      const onClose = (): void => {
        if (!workerPoolPromise) {
          return;
        }
        void workerPoolPromise.then((pool) => pool?.close()).catch(() => undefined);
      };
      server.httpServer?.once("close", onClose);

      server.middlewares.use("/__arena/composite/modules", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const modules: { target: ModuleEntry[]; movement: ModuleEntry[]; shoot: ModuleEntry[] } = {
          target: [],
          movement: [],
          shoot: [],
        };
        const runs = collectCompositeRuns();
        for (const run of runs) {
          const parsed = run.spec;
          const pushModule = (kind: "target" | "movement" | "shoot"): void => {
            const module = parsed.composite?.[kind];
            const familyId = typeof module?.familyId === "string" ? module.familyId : "";
            if (!familyId) {
              return;
            }
            modules[kind].push({
              id: `${run.runId}:${kind}:${familyId}`,
              label: `saved:${run.runId}:${kind}:${familyId}`,
              spec: {
                familyId,
                params: module?.params ?? {},
              },
            });
          };
          pushModule("target");
          pushModule("movement");
          pushModule("shoot");
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, modules }));
      });

      server.middlewares.use("/__arena/composite/models", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const entries = buildLeaderboardEntries().map((entry) => ({
          runId: entry.runId,
          label: `${entry.runId}${entry.runId === BASELINE_MODEL_ID ? " (default baseline AI)" : ""} (score ${entry.score.toFixed(2)}, rounds ${entry.rounds})`,
          score: entry.score,
          rounds: entry.rounds,
          games: entry.games,
          wins: entry.wins,
          losses: entry.losses,
          ties: entry.ties,
          isUnranked: entry.isUnranked,
          mtimeMs: entry.mtimeMs,
          spec: entry.spec,
        }));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, entries }));
      });

      server.middlewares.use("/__arena/composite/leaderboard/compete", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        if (leaderboardCompeteBusy) {
          json(res, 409, { ok: false, reason: "busy" });
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", async () => {
          let payload: { mode?: string; runs?: number; runAId?: string; runBId?: string } = {};
          try {
            payload = JSON.parse(body || "{}") as { mode?: string; runs?: number; runAId?: string; runBId?: string };
          } catch {
            json(res, 400, { ok: false, reason: "bad_json" });
            return;
          }
          const mode = payload.mode === "unranked-vs-random"
            ? "unranked-vs-random"
            : payload.mode === "manual-pair"
              ? "manual-pair"
              : "random-pair";
          const runsRequested = clampInt(payload.runs, 1, 200, 10);
          const runAId = typeof payload.runAId === "string" ? payload.runAId.trim() : "";
          const runBId = typeof payload.runBId === "string" ? payload.runBId.trim() : "";

          const allRuns = collectLeaderboardModels();
          if (allRuns.length < 2) {
            json(res, 400, { ok: false, reason: "need_at_least_two_models" });
            return;
          }
          const runById = new Map<string, CompositeRun>(allRuns.map((run) => [run.runId, run] as const));
          const store = loadRatingStore();
          ensureRatingsForRuns(store, allRuns);

          const choosePair = (): { a: LeaderboardEntry; b: LeaderboardEntry } | null => {
            const entries = buildLeaderboardEntries();
            if (entries.length < 2) {
              return null;
            }
            if (mode === "manual-pair") {
              const a = entries.find((entry) => entry.runId === runAId) ?? null;
              const b = entries.find((entry) => entry.runId === runBId) ?? null;
              if (!a || !b || a.runId === b.runId) {
                return null;
              }
              return { a, b };
            }
            if (mode === "unranked-vs-random") {
              const unranked = entries.filter((entry) => entry.isUnranked);
              if (unranked.length <= 0) {
                return null;
              }
              const a = unranked[randomIndex(unranked.length)] ?? null;
              if (!a) {
                return null;
              }
              const opponents = entries.filter((entry) => entry.runId !== a.runId);
              if (opponents.length <= 0) {
                return null;
              }
              const b = opponents[randomIndex(opponents.length)] ?? null;
              return b ? { a, b } : null;
            }
            const aIdx = randomIndex(entries.length);
            let bIdx = randomIndex(entries.length);
            if (entries.length > 1) {
              while (bIdx === aIdx) {
                bIdx = randomIndex(entries.length);
              }
            }
            const a = entries[aIdx];
            const b = entries[bIdx];
            return a && b && a.runId !== b.runId ? { a, b } : null;
          };

          leaderboardCompeteBusy = true;
          try {
            const phaseScenario = loadLeaderboardPhaseScenario();
            const jobs: Array<{
              modelA: CompositeRun;
              modelB: CompositeRun;
              spec: MatchSpec;
            }> = [];
            const updates: Array<{
              runA: string;
              runB: string;
              outcome: "A" | "B" | "T";
              deltaA: number;
              deltaB: number;
            }> = [];
            for (let i = 0; i < runsRequested; i += 1) {
              const pair = choosePair();
              if (!pair) {
                if (mode === "manual-pair") {
                  json(res, 400, { ok: false, reason: "invalid_manual_pair" });
                  return;
                }
                break;
              }
              const modelA = runById.get(pair.a.runId);
              const modelB = runById.get(pair.b.runId);
              if (!modelA || !modelB) {
                continue;
              }
              jobs.push({
                modelA,
                modelB,
                spec: {
                seed: Date.now() + i * 9973 + Math.floor(Math.random() * 1000),
                maxSimSeconds: 180,
                nodeDefense: 1,
                baseHp: 1200,
                playerGas: 10000,
                enemyGas: 10000,
                spawnBurst: 1,
                spawnMaxActive: 5,
                aiPlayer: modelA.spec,
                aiEnemy: modelB.spec,
                scenario: {
                  withBase: phaseScenario.withBase,
                  initialUnitsPerSide: phaseScenario.initialUnitsPerSide,
                },
                templateNames: phaseScenario.templateNames,
                ...(phaseScenario.battlefield ? { battlefield: phaseScenario.battlefield } : {}),
                },
              });
            }

            const pool = await getWorkerPool();
            const settledResults = await Promise.allSettled(
              jobs.map((job) => (
                pool
                  ? pool.run(job.spec).then((result) => result as MatchResult)
                  : runMatch(job.spec)
              )),
            );
            let completed = 0;
            for (let i = 0; i < settledResults.length; i += 1) {
              const settled = settledResults[i];
              if (settled.status !== "fulfilled") {
                continue;
              }
              const result = settled.value;
              const job = jobs[i];
              if (!job) {
                continue;
              }
              const outcomeA: 0 | 0.5 | 1 = result.sides.player.tie ? 0.5 : (result.sides.player.win ? 1 : 0);
              const ratingDelta = applyLeaderboardMatch(store, job.modelA.runId, job.modelB.runId, outcomeA);
              updates.push({
                runA: job.modelA.runId,
                runB: job.modelB.runId,
                outcome: outcomeA >= 0.99 ? "A" : outcomeA <= 0.01 ? "B" : "T",
                deltaA: ratingDelta.deltaA,
                deltaB: ratingDelta.deltaB,
              });
              completed += 1;
            }
            if (completed <= 0 && jobs.length > 0) {
              throw new Error("No competition rounds completed.");
            }
            saveRatingStore(store);
            json(res, 200, {
              ok: true,
              mode,
              runsRequested,
              completed,
              parallelWorkers: pool ? leaderboardParallelWorkers : 1,
              parallelMode: pool ? "worker-threads" : "single-thread-fallback",
              updates: updates.slice(-30),
              leaderboard: buildLeaderboardEntries(),
            });
          } catch (error) {
            json(res, 500, {
              ok: false,
              reason: "compete_failed",
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            leaderboardCompeteBusy = false;
          }
        });
      });

      server.middlewares.use("/__arena/composite/leaderboard/reset", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        try {
          const store: RatingStore = { version: 1, updatedAt: new Date().toISOString(), ratings: {}, matchupRounds: {} };
          saveRatingStore(store);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, message: "Leaderboard scores reset" }));
        } catch (error) {
          json(res, 500, {
            ok: false,
            reason: "reset_failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.middlewares.use("/__arena/composite/latest", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const runs = collectCompositeRuns();
        if (runs.length <= 0) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, found: false }));
          return;
        }
        runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const latest = runs[0];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, found: true, runId: latest.runId, spec: latest.spec }));
      });

      server.middlewares.use("/__arena/composite/leaderboard", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const entries = buildLeaderboardEntries().map((entry) => ({
          runId: entry.runId,
          score: entry.score,
          rounds: entry.rounds,
          games: entry.games,
          wins: entry.wins,
          losses: entry.losses,
          ties: entry.ties,
          winRate: entry.games > 0 ? entry.wins / entry.games : 0,
          leaderboardScore: entry.score,
          isUnranked: entry.isUnranked,
          mtimeMs: entry.mtimeMs,
          spec: entry.spec,
        }));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, entries }));
      });
    },
  };
}

export default defineConfig({
  plugins: [debugLogPlugin(), templateStorePlugin(), partStorePlugin(), debugProbePlugin(), arenaModelPlugin()],
});
