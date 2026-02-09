import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { parseTemplate } from "../packages/game-core/src/templates/template-schema.ts";
import {
  createDefaultPartDefinitions,
  mergePartCatalogs,
  parsePartDefinition,
} from "../packages/game-core/src/parts/part-schema.ts";

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

  const readPartsInDir = (dirPath: string): ReturnType<typeof createDefaultPartDefinitions> => {
    ensureDir(dirPath);
    const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
    const results = createDefaultPartDefinitions().slice(0, 0);
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

  const loadPartCatalog = (): ReturnType<typeof createDefaultPartDefinitions> => {
    const builtIn = createDefaultPartDefinitions();
    const fromDefault = readPartsInDir(partDefaultDir);
    const fromUser = readPartsInDir(partUserDir);
    return mergePartCatalogs(builtIn, mergePartCatalogs(fromDefault, fromUser));
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
        if (req.method !== "PUT") {
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

  const readPartsInDir = (dirPath: string): ReturnType<typeof createDefaultPartDefinitions> => {
    ensureDir(dirPath);
    const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
    const results = createDefaultPartDefinitions().slice(0, 0);
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

  const readDefaultParts = (): ReturnType<typeof createDefaultPartDefinitions> => {
    const builtIn = createDefaultPartDefinitions();
    const fileBacked = readPartsInDir(defaultDir);
    return mergePartCatalogs(builtIn, fileBacked);
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
        if (req.method !== "PUT") {
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
  const runsDir = resolve(process.cwd(), "..", "arena", ".arena-data", "runs");

  return {
    name: "arena-models",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use("/__arena/composite/latest", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        if (!existsSync(runsDir)) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, found: false }));
          return;
        }
        const runIds = readdirSync(runsDir);
        let bestPath: string | null = null;
        let bestMtime = 0;
        for (const runId of runIds) {
          const filePath = resolve(runsDir, runId, "best-composite.json");
          if (!existsSync(filePath)) {
            continue;
          }
          const stat = statSync(filePath);
          const mtime = stat.mtimeMs;
          if (mtime > bestMtime) {
            bestMtime = mtime;
            bestPath = filePath;
          }
        }
        if (!bestPath) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, found: false }));
          return;
        }
        try {
          const raw = readFileSync(bestPath, "utf8");
          const spec = JSON.parse(raw);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, found: true, path: bestPath, spec }));
        } catch {
          res.statusCode = 500;
          res.end("failed to read latest model");
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [debugLogPlugin(), templateStorePlugin(), partStorePlugin(), debugProbePlugin(), arenaModelPlugin()],
});
