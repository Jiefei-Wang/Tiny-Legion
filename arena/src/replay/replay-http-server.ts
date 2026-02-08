import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, extname } from "node:path";

function send(res: ServerResponse, status: number, contentType: string, body: string | Uint8Array): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  send(res, status, "application/json", JSON.stringify(payload));
}

function contentTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function safePathJoin(root: string, reqPath: string): string {
  const withoutQuery = reqPath.split("?")[0] ?? "";
  const cleaned = withoutQuery.replace(/\\/g, "/");
  const joined = resolve(root, "." + cleaned);
  if (!joined.startsWith(root)) {
    throw new Error("path traversal");
  }
  return joined;
}

function readTemplates(dirPath: string): unknown[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const files = readdirSync(dirPath).filter((n) => n.endsWith(".json"));
  const out: unknown[] = [];
  for (const name of files) {
    try {
      const raw = readFileSync(resolve(dirPath, name), "utf8");
      out.push(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  return out;
}

export function startReplayServer(opts: { port: number }): { baseUrl: string } {
  const distRoot = resolve(process.cwd(), "..", "arena-ui", "dist");
  const gameDefaultTemplates = resolve(process.cwd(), "..", "game", "templates", "default");
  const gameUserTemplates = resolve(process.cwd(), "..", "game", "templates", "user");

  if (!existsSync(distRoot)) {
    throw new Error(`arena-ui is not built: missing ${distRoot}`);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

      if (req.method === "GET" && url.pathname === "/__arena/replay-server") {
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/__templates/default") {
        json(res, 200, { templates: readTemplates(gameDefaultTemplates) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/__templates/user") {
        json(res, 200, { templates: readTemplates(gameUserTemplates) });
        return;
      }

      let reqPath = url.pathname;
      if (reqPath === "/") {
        reqPath = "/index.html";
      }
      const fullPath = safePathJoin(distRoot, reqPath);
      if (!existsSync(fullPath)) {
        send(res, 404, "text/plain; charset=utf-8", "not found");
        return;
      }
      const body = readFileSync(fullPath);
      send(res, 200, contentTypeForPath(fullPath), body);
    } catch (err) {
      send(res, 500, "text/plain; charset=utf-8", err instanceof Error ? err.message : String(err));
    }
  });

  server.listen(opts.port, "127.0.0.1");
  return { baseUrl: `http://127.0.0.1:${opts.port}` };
}
