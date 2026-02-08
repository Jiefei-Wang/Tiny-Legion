import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { startReplayServer } from "./replay-http-server.ts";

function b64urlEncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  const b64 = Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function ensureBuiltArenaUi(): { indexHtmlPath: string } {
  const uiDir = resolve(process.cwd(), "..", "arena-ui");
  const distDir = resolve(uiDir, "dist");
  const indexHtmlPath = resolve(distDir, "index.html");

  const sourcesNewerThanDist = (): boolean => {
    if (!existsSync(indexHtmlPath)) {
      return true;
    }
    const distMtime = statSync(indexHtmlPath).mtimeMs;
    const watch = [
      resolve(uiDir, "index.html"),
      resolve(uiDir, "src", "main.ts"),
      resolve(process.cwd(), "..", "game", "src", "app", "bootstrap.ts"),
      resolve(process.cwd(), "..", "game", "src", "style.css"),
    ];
    for (const p of watch) {
      if (existsSync(p) && statSync(p).mtimeMs > distMtime + 1) {
        return true;
      }
    }
    return false;
  };
  const needsRebuild = (): boolean => {
    if (!existsSync(indexHtmlPath)) {
      return true;
    }
    if (sourcesNewerThanDist()) {
      return true;
    }
    try {
      const html = readFileSync(indexHtmlPath, "utf8");
      // If assets are rooted at /assets, file:// will render a blank page.
      if (html.includes('src="/assets/') || html.includes("href=\"/assets/")) {
        return true;
      }
      // Ensure replay payload hook is present.
      return !html.includes("replay-data.js");
    } catch {
      return true;
    }
  };

  if (needsRebuild()) {
    execSync("npm install", { cwd: uiDir, stdio: "inherit" });
    execSync("npm run build", { cwd: uiDir, stdio: "inherit" });
  }

  if (!existsSync(indexHtmlPath)) {
    throw new Error(`arena-ui build did not produce ${indexHtmlPath}`);
  }
  return { indexHtmlPath };
}

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body = (await res.json()) as any;
          if (body && body.ok === true) {
            return true;
          }
        }
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

async function ensureReplayServer(): Promise<{ baseUrl: string }> {
  const ports = [8790, 8791, 8792, 8793];
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    if (await waitForServer(`${baseUrl}/__arena/replay-server`, 120)) {
      return { baseUrl };
    }
  }

  // Start a detached server process so it stays alive.
  const here = resolve(fileURLToPath(import.meta.url), "..");
  const serverScript = resolve(here, "replay-server-main.js");
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [serverScript], {
      env: { ...process.env, ARENA_REPLAY_PORT: String(port) },
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    if (await waitForServer(`${baseUrl}/__arena/replay-server`, 4000)) {
      return { baseUrl };
    }
  }

  throw new Error("Failed to start arena replay server (ports 8790-8793). Close any existing server and retry.");
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("explorer.exe", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  if (platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

export async function openReplayUiFromFile(replayPath: string): Promise<void> {
  const full = resolve(process.cwd(), replayPath);
  const raw = readFileSync(full, "utf8");
  let payload = raw;
  try {
    const parsed = JSON.parse(raw) as any;
    if (parsed && typeof parsed === "object" && parsed.spec) {
      const expected = {
        simSecondsElapsed: parsed.simSecondsElapsed,
        outcome: parsed.outcome,
        sides: parsed.sides,
      };
      payload = JSON.stringify({ spec: parsed.spec, expected });
    }
  } catch {
    // keep raw
  }
  const { indexHtmlPath } = ensureBuiltArenaUi();

  // Write the replay payload into dist so we don't need huge URLs.
  const replayDataPath = resolve(indexHtmlPath, "..", "replay-data.js");
  writeFileSync(replayDataPath, `window.__ARENA_REPLAY__ = ${payload};\n`, "utf8");

  // Prefer HTTP: most browsers block ES modules over file://.
  const { baseUrl } = await ensureReplayServer();
  const url = `${baseUrl}/`;
  // eslint-disable-next-line no-console
  console.log(`[arena-replay] opening ${url} (payload written to arena-ui/dist/replay-data.js)`);
  openInBrowser(url);

  // Keep file:// as a fallback debug hint (not opened automatically).
  void pathToFileURL(indexHtmlPath).href;
}
