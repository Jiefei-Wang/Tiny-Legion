import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

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

function templateStorePlugin() {
  const rootDir = process.cwd();
  const defaultDir = resolve(rootDir, "templates", "default");
  const userDir = resolve(rootDir, "templates", "user");

  const ensureDir = (dirPath: string): void => {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  };

  const safeId = (raw: string): string | null => {
    const id = raw.trim();
    return /^[a-z0-9-]+$/.test(id) ? id : null;
  };

  const readTemplatesInDir = (dirPath: string): unknown[] => {
    ensureDir(dirPath);
    const files = readdirSync(dirPath).filter((name) => name.endsWith(".json"));
    const results: unknown[] = [];
    for (const fileName of files) {
      try {
        const raw = readFileSync(resolve(dirPath, fileName), "utf8");
        const parsed = JSON.parse(raw);
        results.push(parsed);
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
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        const templates = readTemplatesInDir(defaultDir);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ templates }));
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
            const filePath = resolve(userDir, `${id}.json`);
            writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf8");
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

export default defineConfig({
  plugins: [debugLogPlugin(), templateStorePlugin()],
});
