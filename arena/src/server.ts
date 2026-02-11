import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runMatch } from "./match/run-match.ts";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: any) => {
      data += String(chunk);
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "POST" && url.pathname === "/match") {
      const body = await readBody(req);
      const spec = JSON.parse(body || "{}") as any;
      const result = await runMatch(spec);
      json(res, 200, result);
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

const port = Number(process.env.ARENA_PORT ?? 8787);
server.listen(port);
// eslint-disable-next-line no-console
console.log(`[arena] listening on http://localhost:${port}`);
