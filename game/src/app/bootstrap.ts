import { armyCap } from "../config/balance/commander.ts";
import { applyStrategicEconomyTick } from "../gameplay/map/garrison-upkeep.ts";
import { createMapNodes } from "../gameplay/map/node-graph.ts";
import { settleGarrison as settleNodeGarrison, setNodeOwner } from "../gameplay/map/occupation.ts";
import { GameLoop } from "./game-loop.ts";
import { createInitialTemplates } from "../simulation/units/unit-builder.ts";
import { canOperate } from "../simulation/units/control-unit-rules.ts";
import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import { BattleSession } from "../gameplay/battle/battle-session.ts";
import type { BattleSessionOptions } from "../gameplay/battle/battle-session.ts";
import { BATTLE_SALVAGE_REFUND_FACTOR } from "../gameplay/battle/battle-session.ts";
import { cloneTemplate, fetchDefaultTemplatesFromStore, fetchUserTemplatesFromStore, mergeTemplates, saveUserTemplateToStore, validateTemplateDetailed } from "./template-store.ts";
import type { ComponentId, DisplayAttachmentTemplate, GameBase, KeyState, MapNode, MaterialId, ScreenMode, TechState, UnitTemplate } from "../types.ts";

export type ArenaReplaySpec = {
  seed: number;
  maxSimSeconds: number;
  nodeDefense: number;
  baseHp?: number;
  playerGas: number;
  enemyGas: number;
  spawnBurst?: number;
  spawnMaxActive?: number;
  aiPlayer: { familyId: string; params: Record<string, number | boolean> };
  aiEnemy: { familyId: string; params: Record<string, number | boolean> };
  spawnMode?: "mirrored-random" | "ai";
  spawnPlayer?: { familyId: string; params: Record<string, number | boolean> };
  spawnEnemy?: { familyId: string; params: Record<string, number | boolean> };
};

export type ArenaReplayDeciderCtx = {
  side: "player" | "enemy";
  gas: number;
  capRemaining: number;
  roster: string[];
};

export type ArenaReplayDecider = (ctx: ArenaReplayDeciderCtx) => { templateId: string | null; intervalS: number };

export type BootstrapOptions = {
  arenaReplay?: { spec: ArenaReplaySpec; deciders?: { player?: ArenaReplayDecider; enemy?: ArenaReplayDecider }; expected?: unknown };
  battleSessionOptions?: BattleSessionOptions;
};

export function bootstrap(options: BootstrapOptions = {}): void {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    throw new Error("App root not found");
  }

  const replay = options.arenaReplay ?? null;
  const replayMode = Boolean(replay);
  const replayExpected = replay?.expected ?? null;

  const battleSessionOptions: BattleSessionOptions | undefined = replayMode
    ? {
      ...(options.battleSessionOptions ?? {}),
      // Arena replay should not inherit any default battle randomness.
      disableAutoEnemySpawns: true,
      disableEnemyMinimumPresence: true,
      disableDefaultStarters: true,
    }
    : options.battleSessionOptions;

  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="title">Modular Army 2D - MVP</div>
        <details id="debugMenu" class="debug-menu">
          <summary>Debug Options</summary>
          <label><input id="debugResourcesChk" type="checkbox" /> Unlimited Resources</label>
          <label><input id="debugVisualChk" type="checkbox" /> Draw Path + Hitbox</label>
          <label><input id="debugTargetLineChk" type="checkbox" /> Draw Target Lines</label>
        </details>
        <div class="topbar-status">
          <div id="metaBar" class="meta"></div>
          <div id="arenaReplayStats" class="meta small"></div>
          <div class="meta" style="display:flex; align-items:center; gap:8px;">
            <label class="small" style="display:flex; align-items:center; gap:6px;">Speed
              <input id="timeScale" type="range" min="0.5" max="5" step="0.1" value="1" />
            </label>
            <span id="timeScaleLabel" class="small">1.0x</span>
          </div>
        </div>
      </header>

      <main class="layout">
        <section class="left-panel">
          <div class="card">
            <h3>Mode</h3>
            <div class="tabs">
              <button id="tabBase">Base</button>
              <button id="tabMap">Map</button>
              <button id="tabBattle">Battle</button>
              <button id="tabEditor">Editor</button>
            </div>
          </div>

          <div id="basePanel" class="card panel"></div>
          <div id="mapPanel" class="card panel hidden"></div>
          <div id="battlePanel" class="card panel hidden"></div>
          <div id="editorPanel" class="card panel hidden"></div>
        </section>

        <section class="center-panel card">
          <canvas id="battleCanvas" width="980" height="520"></canvas>
          <div id="weaponHud" class="weapon-hud small"></div>
        </section>

        <section class="right-panel">
          <div class="card">
            <h3>Selected Unit</h3>
            <div id="selectedInfo" class="small"></div>
          </div>
          <div class="card">
            <h3>Log</h3>
            <div id="logBox" class="log"></div>
          </div>
          <div class="card">
            <h3>Controls</h3>
            <div class="small">
              - Click a friendly unit to control it<br />
              - Move mouse to aim selected unit<br />
              - Hold left click: keep firing selected weapon<br />
              - WASD: move selected unit<br />
              - Space: flip selected unit direction<br />
              - 1..9: select weapon slot<br />
              - Shift+1..9: toggle auto fire for that slot<br />
              - Ground units move freely on X/Y<br />
              - Air units move on X/Z (same screen Y axis)
            </div>
          </div>
        </section>
      </main>
    </div>
  `;

  root.querySelector<HTMLElement>(".app-shell")?.classList.toggle("arena-replay", replayMode);

  const basePanel = getElement<HTMLDivElement>("#basePanel");
  const mapPanel = getElement<HTMLDivElement>("#mapPanel");
  const battlePanel = getElement<HTMLDivElement>("#battlePanel");
  const editorPanel = getElement<HTMLDivElement>("#editorPanel");
  const selectedInfo = getElement<HTMLDivElement>("#selectedInfo");
  const weaponHud = getElement<HTMLDivElement>("#weaponHud");
  const logBox = getElement<HTMLDivElement>("#logBox");
  const debugResourcesChk = getElement<HTMLInputElement>("#debugResourcesChk");
  const debugVisualChk = getElement<HTMLInputElement>("#debugVisualChk");
  const debugTargetLineChk = getElement<HTMLInputElement>("#debugTargetLineChk");
  const debugMenu = getElement<HTMLElement>("#debugMenu");
  const metaBar = getElement<HTMLDivElement>("#metaBar");
  const arenaReplayStats = getElement<HTMLDivElement>("#arenaReplayStats");
  const timeScale = getElement<HTMLInputElement>("#timeScale");
  const timeScaleLabel = getElement<HTMLSpanElement>("#timeScaleLabel");
  const canvas = getElement<HTMLCanvasElement>("#battleCanvas");

  if (replayMode) {
    // Match arena headless runner simulation dimensions for deterministic parity.
    canvas.width = 1280;
    canvas.height = 720;
    debugMenu.style.display = "none";
    metaBar.style.display = "none";
  }

  const tabs = {
    base: getElement<HTMLButtonElement>("#tabBase"),
    map: getElement<HTMLButtonElement>("#tabMap"),
    battle: getElement<HTMLButtonElement>("#tabBattle"),
    editor: getElement<HTMLButtonElement>("#tabEditor"),
  };

  const templates: UnitTemplate[] = createInitialTemplates();
  const keys: KeyState = { a: false, d: false, w: false, s: false, space: false };
  const base: GameBase = { areaLevel: 1, refineries: 1, workshops: 1, labs: 0 };
  const tech: TechState = {
    reinforced: false,
    ceramic: false,
    combined: false,
    reactive: false,
    mediumWeapons: false,
  };

  const mapNodes: MapNode[] = createMapNodes();
  let screen: ScreenMode = "base";
  let running = true;
  let round = 1;
  let gas = replay?.spec.playerGas ?? 250;
  let commanderSkill = 1;
  let pendingOccupation: string | null = null;
  let debugUnlimitedResources = replayMode ? false : true;
  let debugVisual = replayMode ? false : true;
  let debugTargetLines = replayMode ? false : true;
  let debugServerEnabled = false;
  const EDITOR_GRID_MAX_COLS = 10;
  const EDITOR_GRID_MAX_ROWS = 10;
  const EDITOR_GRID_MAX_SIZE = EDITOR_GRID_MAX_COLS * EDITOR_GRID_MAX_ROWS;
  const EDITOR_DISPLAY_KINDS: DisplayAttachmentTemplate["kind"][] = ["panel", "stripe", "glass"];
  type EditorFunctionalSlot = {
    component: ComponentId;
    rotateQuarter: 0 | 1 | 2 | 3;
    groupId: number;
    isAnchor: boolean;
  } | null;
  let editorLayer: "structure" | "functional" | "display" = "structure";
  let editorDeleteMode = false;
  let editorSelection = "basic";
  let editorGridCols = 10;
  let editorGridRows = 10;
  let editorWeaponRotateQuarter: 0 | 1 | 2 | 3 = 0;
  let editorFunctionalGroupSeq = 1;
  let editorGridPanX = 0;
  let editorGridPanY = 0;
  let editorDragActive = false;
  let editorDragMoved = false;
  let editorDragStartClientX = 0;
  let editorDragStartClientY = 0;
  let editorDragLastClientX = 0;
  let editorDragLastClientY = 0;
  let editorPendingClickX = 0;
  let editorPendingClickY = 0;
  let editorStructureSlots: Array<MaterialId | null> = new Array<MaterialId | null>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorFunctionalSlots: EditorFunctionalSlot[] = new Array<EditorFunctionalSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorDisplaySlots: Array<DisplayAttachmentTemplate["kind"] | null> = new Array<DisplayAttachmentTemplate["kind"] | null>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorTemplateDialogOpen = false;
  let editorTemplateDialogSelectedId: string | null = null;
  let editorDraft: UnitTemplate = {
    id: "custom-1",
    name: "Custom Unit",
    type: "ground",
    gasCost: 0,
    structure: [{ material: "basic" }, { material: "basic" }, { material: "basic" }],
    attachments: [
      { component: "control", cell: 1 },
      { component: "engineS", cell: 0 },
    ],
    display: [{ kind: "panel", cell: 1 }],
  };

  const isUnlimitedResources = (): boolean => debugUnlimitedResources;
  const isDebugVisual = (): boolean => debugVisual;
  const isDebugTargetLines = (): boolean => debugTargetLines;
  const getCommanderSkillForCap = (): number => (isUnlimitedResources() ? 999 : commanderSkill);
  const editorTooltip = document.createElement("div");
  editorTooltip.className = "editor-tooltip hidden";
  editorTooltip.style.pointerEvents = "none";
  document.body.appendChild(editorTooltip);

  const isTypingInFormField = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  };

  const showEditorTooltip = (text: string, x: number, y: number): void => {
    editorTooltip.textContent = text;
    editorTooltip.classList.remove("hidden");
    editorTooltip.style.left = `${x + 14}px`;
    editorTooltip.style.top = `${y + 14}px`;
  };

  const hideEditorTooltip = (): void => {
    editorTooltip.classList.add("hidden");
  };

  const postDebugEvent = (path: string, payload: Record<string, unknown>): void => {
    void fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      return;
    });
  };

  const debugProbeClientId = (() => {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    return `client_${ts}_${rand}`;
  })();

  type DebugProbePathQuery = {
    type: "path";
    root: "app" | "battle";
    path?: string;
    options?: { maxDepth?: number; maxItems?: number; maxString?: number };
  };
  type DebugProbeDumpQuery = {
    type: "dump";
    root: "app" | "battle";
    path?: string;
    options?: { maxDepth?: number; maxItems?: number; maxString?: number };
  };
  type DebugProbeDomQuery = {
    type: "dom";
    selector: string;
    options?: { maxNodes?: number; maxString?: number; fields?: Array<"rect" | "text" | "html" | "classes" | "attrs"> };
  };
  type DebugProbeQuery = DebugProbePathQuery | DebugProbeDumpQuery | DebugProbeDomQuery;

  const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, Math.floor(value)));
  };

  const getPathValue = (rootObj: unknown, rawPath: unknown): unknown => {
    const path = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!path) {
      return rootObj;
    }
    let cursor: any = rootObj;
    let i = 0;

    const readIdentifier = (): string | null => {
      const start = i;
      const first = path[i] ?? "";
      if (!/[A-Za-z_$]/.test(first)) {
        return null;
      }
      i += 1;
      while (i < path.length && /[A-Za-z0-9_$]/.test(path[i] ?? "")) {
        i += 1;
      }
      return path.slice(start, i);
    };

    const readBracket = (): string | number | null => {
      // supports [0], ["key"], ['key']
      if (path[i] !== "[") {
        return null;
      }
      i += 1;
      while (i < path.length && /\s/.test(path[i] ?? "")) {
        i += 1;
      }
      const quote = path[i];
      if (quote === "\"" || quote === "'") {
        i += 1;
        const start = i;
        while (i < path.length && path[i] !== quote) {
          i += 1;
        }
        if (path[i] !== quote) {
          return null;
        }
        const key = path.slice(start, i);
        i += 1;
        while (i < path.length && /\s/.test(path[i] ?? "")) {
          i += 1;
        }
        if (path[i] !== "]") {
          return null;
        }
        i += 1;
        return key;
      }

      const start = i;
      while (i < path.length && /[0-9]/.test(path[i] ?? "")) {
        i += 1;
      }
      const raw = path.slice(start, i);
      while (i < path.length && /\s/.test(path[i] ?? "")) {
        i += 1;
      }
      if (path[i] !== "]") {
        return null;
      }
      i += 1;
      const num = Number(raw);
      if (!raw || !Number.isFinite(num)) {
        return null;
      }
      return num;
    };

    while (i < path.length) {
      while (i < path.length && /\s/.test(path[i] ?? "")) {
        i += 1;
      }
      if (path[i] === ".") {
        i += 1;
        continue;
      }

      const bracketKey = readBracket();
      if (bracketKey !== null) {
        if (cursor == null) {
          return undefined;
        }
        cursor = cursor[bracketKey as any];
        continue;
      }

      const ident = readIdentifier();
      if (!ident) {
        return undefined;
      }
      if (cursor == null) {
        return undefined;
      }
      cursor = cursor[ident];
    }

    return cursor;
  };

  const safeDump = (
    value: unknown,
    options: { maxDepth: number; maxItems: number; maxString: number },
  ): unknown => {
    const seen = new WeakSet<object>();

    const dumpInner = (v: unknown, depth: number): unknown => {
      if (v === null || v === undefined) {
        return v;
      }
      if (typeof v === "string") {
        return v.length > options.maxString ? `${v.slice(0, options.maxString)}…` : v;
      }
      if (typeof v === "number" || typeof v === "boolean") {
        return v;
      }
      if (typeof v === "bigint") {
        return `[bigint ${String(v)}]`;
      }
      if (typeof v === "function") {
        return "[function]";
      }
      if (typeof v === "symbol") {
        return "[symbol]";
      }
      if (depth >= options.maxDepth) {
        return "[maxDepth]";
      }
      if (typeof v !== "object") {
        return String(v);
      }

      const obj = v as object;
      if (seen.has(obj)) {
        return "[circular]";
      }
      seen.add(obj);

      if (Array.isArray(v)) {
        const out: unknown[] = [];
        const max = Math.min(v.length, options.maxItems);
        for (let i = 0; i < max; i += 1) {
          out.push(dumpInner(v[i], depth + 1));
        }
        if (v.length > max) {
          out.push(`[+${v.length - max} more]`);
        }
        return out;
      }

      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        const name = (v as any)?.constructor?.name;
        return `[${typeof name === "string" && name ? name : "Object"}]`;
      }

      const keys = Object.keys(v as Record<string, unknown>);
      const out: Record<string, unknown> = {};
      const max = Math.min(keys.length, options.maxItems);
      for (let i = 0; i < max; i += 1) {
        const k = keys[i] ?? "";
        out[k] = dumpInner((v as any)[k], depth + 1);
      }
      if (keys.length > max) {
        out.__moreKeys = keys.length - max;
      }
      return out;
    };

    return dumpInner(value, 0);
  };

  const syncDebugServerState = (): void => {
    if (replayMode) {
      return;
    }
    const shouldEnable = debugUnlimitedResources || debugVisual;
    if (shouldEnable === debugServerEnabled) {
      return;
    }
    debugServerEnabled = shouldEnable;
    postDebugEvent("/__debug/toggle", { enabled: shouldEnable });
  };

  let suppressWarnLogs = false;
  const addLog = (text: string, tone: "good" | "warn" | "bad" | "" = ""): void => {
    if (suppressWarnLogs && tone === "warn") {
      return;
    }
    const item = document.createElement("div");
    item.className = tone;
    item.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logBox.prepend(item);
    while (logBox.children.length > 140) {
      logBox.removeChild(logBox.lastChild as Node);
    }
    if (debugServerEnabled) {
      postDebugEvent("/__debug/log", {
        level: tone || "info",
        message: text,
      });
    }
  };

  const battle = new BattleSession(
    canvas,
    {
      addLog,
      getCommanderSkill: () => getCommanderSkillForCap(),
      getPlayerGas: () => gas,
      spendPlayerGas: (amount) => {
        if (isUnlimitedResources()) {
          return true;
        }
        if (gas < amount) {
          return false;
        }
        gas -= amount;
        return true;
      },
      addPlayerGas: (amount) => {
        if (isUnlimitedResources()) {
          return;
        }
        gas += amount;
      },
      onBattleOver: (victory, nodeId) => {
        if (victory) {
          const node = mapNodes.find((entry) => entry.id === nodeId);
          if (!node) {
            return;
          }
          setNodeOwner(mapNodes, nodeId, "player");
          gas += node.reward;
          commanderSkill += nodeId === "core" ? 2 : 1;
          pendingOccupation = nodeId;
          addLog(`Victory at ${node.name}. +${node.reward} gas, commander skill up`, "good");
        } else {
          addLog("Defeat in battle.", "bad");
        }
        renderPanels();
      },
    },
    templates,
    battleSessionOptions,
  );

  const startDebugProbeLoop = (): void => {
    const pollEveryMs = 250;
    let timer: number | null = null;
    let inFlight = false;

    const buildAppRoot = (): Record<string, unknown> => {
      return {
        screen,
        running,
        round,
        gas,
        commanderSkill,
        debugUnlimitedResources,
        debugVisual,
        debugTargetLines,
        replayMode,
      };
    };

    const buildBattleRoot = (): Record<string, unknown> => {
      return {
        state: battle.getState(),
        selection: battle.getSelection(),
        displayEnabled: battle.isDisplayEnabled(),
      };
    };

    const executeQuery = (query: DebugProbeQuery): unknown => {
      if (query.type === "dom") {
        const selector = typeof query.selector === "string" ? query.selector : "";
        if (!selector) {
          return { ok: false, reason: "missing_selector" };
        }
        const maxNodes = clampInt(query.options?.maxNodes, 1, 200, 40);
        const maxString = clampInt(query.options?.maxString, 50, 50_000, 2_000);
        const fields = Array.isArray(query.options?.fields) && query.options?.fields.length > 0
          ? query.options?.fields
          : ["rect", "text", "classes"];

        const nodes = Array.from(document.querySelectorAll(selector)).slice(0, maxNodes);
        return nodes.map((node) => {
          const el = node as HTMLElement;
          const out: Record<string, unknown> = { tag: el.tagName.toLowerCase() };
          if (fields.includes("rect")) {
            const r = el.getBoundingClientRect();
            out.rect = { x: r.x, y: r.y, w: r.width, h: r.height };
          }
          if (fields.includes("classes")) {
            out.classes = Array.from(el.classList);
          }
          if (fields.includes("text")) {
            const text = (el.innerText ?? "").trim();
            out.text = text.length > maxString ? `${text.slice(0, maxString)}…` : text;
          }
          if (fields.includes("html")) {
            const html = (el.innerHTML ?? "").trim();
            out.html = html.length > maxString ? `${html.slice(0, maxString)}…` : html;
          }
          if (fields.includes("attrs")) {
            const attrs: Record<string, string> = {};
            for (const attr of Array.from(el.attributes)) {
              attrs[attr.name] = attr.value;
            }
            out.attrs = attrs;
          }
          return out;
        });
      }

      const rootName = (query as DebugProbePathQuery | DebugProbeDumpQuery).root;
      const rootObj = rootName === "battle" ? buildBattleRoot() : buildAppRoot();
      const resolved = getPathValue(rootObj, (query as any).path);
      const maxDepth = clampInt((query as any).options?.maxDepth, 1, 20, query.type === "path" ? 3 : 6);
      const maxItems = clampInt((query as any).options?.maxItems, 1, 5_000, query.type === "path" ? 120 : 400);
      const maxString = clampInt((query as any).options?.maxString, 50, 200_000, 5_000);
      return safeDump(resolved, { maxDepth, maxItems, maxString });
    };

    const pollOnce = async (): Promise<void> => {
      if (inFlight) {
        return;
      }
      if (!debugServerEnabled || replayMode) {
        return;
      }
      inFlight = true;
      try {
        const nextRes = await fetch(`/__debug/probe/next?clientId=${encodeURIComponent(debugProbeClientId)}`, {
          method: "GET",
          headers: { "accept": "application/json" },
        });
        const nextJson = await nextRes.json().catch(() => null);
        const probe = nextJson && typeof nextJson === "object" ? (nextJson as any).probe : null;
        if (!probe || typeof probe.id !== "string" || !Array.isArray(probe.queries)) {
          return;
        }

        const results: unknown[] = [];
        const errors: string[] = [];
        for (let i = 0; i < probe.queries.length; i += 1) {
          const raw = probe.queries[i];
          try {
            if (!raw || typeof raw !== "object") {
              results.push(null);
              errors.push(`query[${i}] invalid`);
              continue;
            }
            const q = raw as Partial<DebugProbeQuery>;
            const type = (q as any).type;
            if (type !== "path" && type !== "dump" && type !== "dom") {
              results.push(null);
              errors.push(`query[${i}] unknown type`);
              continue;
            }
            if (type !== "dom") {
              const rootName = (q as any).root;
              if (rootName !== "app" && rootName !== "battle") {
                results.push(null);
                errors.push(`query[${i}] invalid root`);
                continue;
              }
            }
            results.push(executeQuery(q as DebugProbeQuery));
          } catch (e) {
            results.push(null);
            errors.push(`query[${i}] error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        await fetch(`/__debug/probe/${encodeURIComponent(probe.id)}/response`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, results, errors: errors.length > 0 ? errors : undefined }),
        }).catch(() => {
          return;
        });
      } catch {
        return;
      } finally {
        inFlight = false;
      }
    };

    if (timer !== null) {
      return;
    }
    timer = window.setInterval(() => {
      void pollOnce();
    }, pollEveryMs);
  };

  startDebugProbeLoop();

  const refundFactor = BATTLE_SALVAGE_REFUND_FACTOR;
  const computeOnFieldGasValue = (side: "player" | "enemy"): number => {
    const s = battle.getState();
    let sum = 0;
    for (const unit of s.units) {
      if (!unit || !unit.alive || unit.side !== side) {
        continue;
      }
      const cost = typeof unit.deploymentGasCost === "number" ? unit.deploymentGasCost : 0;
      const refundable = Math.floor(cost * refundFactor);
      if (refundable > 0) {
        sum += refundable;
      }
    }
    return sum;
  };

  let gasStartPlayer = 0;
  let gasStartEnemy = 0;
  let onFieldStartPlayer = 0;
  let onFieldStartEnemy = 0;

  const blockUserInputForReplay = (): void => {
    const stopAll = (event: Event): void => {
      const target = event.target;
      if (target instanceof HTMLElement && target.id === "timeScale") {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const targets: Array<[EventTarget, string]> = [
      [document, "keydown"],
      [document, "keyup"],
      [document, "keypress"],
      [document, "mousedown"],
      [document, "mouseup"],
      [document, "click"],
      [document, "contextmenu"],
      [canvas, "mousedown"],
      [canvas, "mouseup"],
      [canvas, "mousemove"],
      [canvas, "click"],
      [canvas, "contextmenu"],
    ];
    for (const [target, name] of targets) {
      target.addEventListener(name, stopAll, { capture: true });
    }
    const interactive = root.querySelectorAll("button, input, select, textarea");
    interactive.forEach((node) => {
      if (node instanceof HTMLInputElement && node.id === "timeScale") {
        return;
      }
      (node as HTMLButtonElement).disabled = true;
    });
    canvas.style.cursor = "default";
  };

  const startArenaReplay = (): void => {
    if (!replay) {
      return;
    }
    const spec = replay.spec;

    // Replay determinism (browser):
    // - route all randomness through a seeded PRNG during replay
    // - advance the sim using fixed timesteps (not frame dt)
    const makeSeededRng = (seed: number): (() => number) => {
      let t = seed >>> 0;
      return () => {
        t += 0x6d2b79f5;
        let x = t;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    };
    const math = Math as unknown as { random: () => number };
    const originalMathRandom = math.random;
    let restoredMathRandom = false;
    const restoreMathRandom = (): void => {
      if (restoredMathRandom) {
        return;
      }
      restoredMathRandom = true;
      math.random = originalMathRandom;
    };
    math.random = makeSeededRng(spec.seed);

    const node: MapNode = {
      id: "arena-replay",
      name: "Arena Replay",
      owner: "neutral",
      garrison: false,
      reward: 0,
      defense: spec.nodeDefense,
      ...(typeof spec.baseHp === "number" && Number.isFinite(spec.baseHp) && spec.baseHp > 0 ? { testBaseHpOverride: spec.baseHp } : {}),
    };
    battle.start(node);
    battle.clearControlSelection();
    battle.getState().enemyGas = spec.enemyGas;

    // Symmetric starters.
    const starters = ["scout-ground", "tank-ground"].filter((id) => templates.some((t) => t.id === id));
    for (const id of starters) {
      battle.arenaDeploy("player", id, { chargeGas: false, deploymentGasCost: 0, y: 300 });
      battle.arenaDeploy("enemy", id, { chargeGas: false, deploymentGasCost: 0, y: 300 });
    }

    setScreen("battle");
    renderPanels();
    addLog(`Arena replay started (seed=${spec.seed})`, "good");

    // Replay macro loop state.
    const rosterPreference = ["scout-ground", "tank-ground", "air-jet", "air-propeller", "air-light"];
    const availableTemplateIds = new Set<string>(templates.map((t) => t.id));
    let roster = rosterPreference.filter((id) => availableTemplateIds.has(id));
    if (roster.length === 0) {
      roster = templates.slice(0, 6).map((t) => t.id);
    }

    const spawnRng = makeSeededRng((spec.seed ^ 0x2f7a1d) >>> 0);

    let simT = 0;
    let spawnTimer = 0;
    let spawnIntervalS = 1.8;
    const spawnBurst = Math.max(1, Math.floor(spec.spawnBurst ?? 1));
    const spawnMaxActive = Math.max(1, Math.floor(spec.spawnMaxActive ?? 5));

    gasStartPlayer = gas;
    gasStartEnemy = battle.getState().enemyGas;
    onFieldStartPlayer = computeOnFieldGasValue("player");
    onFieldStartEnemy = computeOnFieldGasValue("enemy");

    const pickMirrored = (): { templateId: string | null; y: number } => {
      if (roster.length === 0) {
        return { templateId: null, y: 0 };
      }
      const idx = Math.floor(spawnRng() * roster.length);
      const templateId = roster[Math.max(0, Math.min(roster.length - 1, idx))] ?? null;
      const y = 220 + spawnRng() * 260;
      return { templateId, y };
    };

    const decide = (side: "player" | "enemy"): { templateId: string | null; intervalS: number; y?: number } => {
      const s = battle.getState();
      const alive = s.units.filter((u) => u.alive && u.side === side).length;
      const capRemaining = side === "enemy"
        ? Math.max(0, Math.min(s.enemyCap, spawnMaxActive) - alive)
        : Math.max(0, spawnMaxActive - alive);
      const ctx: ArenaReplayDeciderCtx = { side, gas: side === "enemy" ? s.enemyGas : gas, capRemaining, roster };
      const fn = replay.deciders?.[side];
      if (fn) {
        const d = fn(ctx);
        return { templateId: d.templateId, intervalS: d.intervalS };
      }
      return { templateId: null, intervalS: spawnIntervalS };
    };

    let previousUpdate: ((dt: number) => void) | null = null;
    let restoredLoopUpdate = false;
    const restoreLoopUpdate = (): void => {
      if (restoredLoopUpdate) {
        return;
      }
      restoredLoopUpdate = true;
      if (previousUpdate) {
        loopUpdate = previousUpdate;
      }
    };

    const fixedDt = 1 / 60;
    const noKeys: KeyState = { a: false, d: false, w: false, s: false, space: false };

    const stepReplay = (): void => {
      if (battle.getState().outcome) {
        restoreMathRandom();
        restoreLoopUpdate();
        return;
      }
      if (!battle.getState().active) {
        return;
      }
      simT += fixedDt;
      spawnTimer += fixedDt;
      if (spawnTimer >= spawnIntervalS) {
        spawnTimer = 0;
        if ((spec.spawnMode ?? "mirrored-random") === "mirrored-random") {
          const s = battle.getState();
          const alivePlayer = s.units.filter((u) => u.alive && u.side === "player").length;
          const aliveEnemy = s.units.filter((u) => u.alive && u.side === "enemy").length;
          let capRemainingPlayer = Math.max(0, spawnMaxActive - alivePlayer);
          let capRemainingEnemy = Math.max(0, Math.min(s.enemyCap, spawnMaxActive) - aliveEnemy);
          for (let i = 0; i < spawnBurst; i += 1) {
            const { templateId, y } = pickMirrored();
            if (templateId) {
              const template = templates.find((t) => t.id === templateId);
              const cost = template ? template.gasCost : 0;
              if (capRemainingPlayer <= 0 || capRemainingEnemy <= 0) {
                continue;
              }
              if (gas < cost || s.enemyGas < cost) {
                continue;
              }
              const a = battle.arenaDeploy("player", templateId, { chargeGas: true, y, ignoreCap: true });
              const b = battle.arenaDeploy("enemy", templateId, { chargeGas: true, y, ignoreCap: true, ignoreLowGasThreshold: true });
              if (a && b) {
                capRemainingPlayer -= 1;
                capRemainingEnemy -= 1;
              }
            }
          }
        } else {
          let minInterval = spawnIntervalS;
          for (let i = 0; i < spawnBurst; i += 1) {
            const p = decide("player");
            const e = decide("enemy");
            minInterval = Math.min(minInterval, p.intervalS, e.intervalS);
            if (p.templateId) {
              battle.arenaDeploy("player", p.templateId, { chargeGas: true, ignoreCap: true });
            }
            if (e.templateId) {
              battle.arenaDeploy("enemy", e.templateId, { chargeGas: true, ignoreCap: true, ignoreLowGasThreshold: true });
            }
          }
          spawnIntervalS = Math.max(0.5, Math.min(6.0, minInterval));
        }
      }

      battle.update(fixedDt, noKeys);

      if (simT >= spec.maxSimSeconds && battle.getState().active && !battle.getState().outcome) {
        const state = battle.getState();
        const victory = state.enemyBase.hp <= state.playerBase.hp;
        battle.forceEnd(victory, "Arena deadline reached");
      }

      if (battle.getState().outcome) {
        // Verify replay stats against expected.
        const final = battle.getState();
        const gasEndPlayer = gas;
        const gasEndEnemy = final.enemyGas;
        const onFieldEndPlayer = computeOnFieldGasValue("player");
        const onFieldEndEnemy = computeOnFieldGasValue("enemy");
        const worthDeltaPlayer = (gasEndPlayer + onFieldEndPlayer) - (gasStartPlayer + onFieldStartPlayer);
        const worthDeltaEnemy = (gasEndEnemy + onFieldEndEnemy) - (gasStartEnemy + onFieldStartEnemy);
        const tie = String(final.outcome?.reason ?? "").toLowerCase().includes("deadline");
        const playerOutcome: "win" | "tie" | "loss" = tie ? "tie" : Boolean(final.outcome?.victory) ? "win" : "loss";
        const enemyOutcome: "win" | "tie" | "loss" = tie ? "tie" : Boolean(final.outcome?.victory) ? "loss" : "win";
        const playerScore = (playerOutcome === "win" ? 2 : playerOutcome === "tie" ? 1 : 0) * 1_000_000 + worthDeltaPlayer;
        const enemyScore = (enemyOutcome === "win" ? 2 : enemyOutcome === "tie" ? 1 : 0) * 1_000_000 + worthDeltaEnemy;
        const actual = {
          simSecondsElapsed: simT,
          outcome: { playerVictory: Boolean(final.outcome?.victory), reason: String(final.outcome?.reason ?? "") },
          sides: {
            player: {
              gasStart: gasStartPlayer,
              gasEnd: gasEndPlayer,
              onFieldGasValueStart: onFieldStartPlayer,
              onFieldGasValueEnd: onFieldEndPlayer,
              gasWorthDelta: worthDeltaPlayer,
              score: playerScore,
            },
            enemy: {
              gasStart: gasStartEnemy,
              gasEnd: gasEndEnemy,
              onFieldGasValueStart: onFieldStartEnemy,
              onFieldGasValueEnd: onFieldEndEnemy,
              gasWorthDelta: worthDeltaEnemy,
              score: enemyScore,
            },
          },
        };

        const expected = replayExpected as any;
        if (expected && expected.outcome && expected.sides) {
          const epsT = 1e-6;
          const tOk = Math.abs((expected.simSecondsElapsed ?? 0) - actual.simSecondsElapsed) < epsT;
          const outcomeOk = Boolean(expected.outcome.playerVictory) === actual.outcome.playerVictory && String(expected.outcome.reason ?? "") === actual.outcome.reason;
          const sidesOk = (side: "player" | "enemy"): boolean => {
            const e = expected.sides?.[side];
            const a = (actual as any).sides?.[side];
            if (!e || !a) return false;
            return (
              e.gasStart === a.gasStart &&
              e.gasEnd === a.gasEnd &&
              e.onFieldGasValueStart === a.onFieldGasValueStart &&
              e.onFieldGasValueEnd === a.onFieldGasValueEnd &&
              e.gasWorthDelta === a.gasWorthDelta &&
              e.score === a.score
            );
          };
          const ok = tOk && outcomeOk && sidesOk("player") && sidesOk("enemy");
          addLog(`[replay-verify] ${ok ? "PASS" : "FAIL"} | outcome=${outcomeOk} time=${tOk} sides=${sidesOk("player") && sidesOk("enemy")}`, ok ? "good" : "bad");
        } else {
          addLog("[replay-verify] No expected stats in artifact", "warn");
        }
        restoreMathRandom();
        restoreLoopUpdate();
      }
    };

    // Hook into main loop by overriding keys and injecting macro decisions.
    const originalRunning = running;
    running = true;
    previousUpdate = loopUpdate;
    loopUpdate = (_dt: number) => {
      // Deterministic: fixed ticks per rendered frame. Speed slider controls wall-clock speed only.
      const speedValue = Number(timeScale.value);
      const speed = Number.isFinite(speedValue) ? speedValue : 1;
      const ticksPerFrame = Math.max(1, Math.round(speed * 2));
      for (let i = 0; i < ticksPerFrame; i += 1) {
        stepReplay();
      }
      void previousUpdate;
    };
    void originalRunning;
  };


  const refreshTemplatesFromStore = async (): Promise<void> => {
    const defaultTemplates = await fetchDefaultTemplatesFromStore();
    const userTemplates = await fetchUserTemplatesFromStore();
    const merged = mergeTemplates(templates, mergeTemplates(defaultTemplates, userTemplates));
    templates.splice(0, templates.length, ...merged);
  };

  type BuildKind = "refinery" | "expand" | "lab";
  type BuildJob = { kind: BuildKind; remainingRounds: number };
  const buildQueue: BuildJob[] = [];
  const buildRounds: Record<BuildKind, number> = {
    refinery: 1,
    expand: 2,
    lab: 2,
  };

  const formatBuildJob = (job: BuildJob): string => {
    const label = job.kind === "refinery" ? "Refinery" : job.kind === "expand" ? "Base Expansion" : "Research Lab";
    const r = Math.max(0, Math.floor(job.remainingRounds));
    return `${label} (${r} round${r === 1 ? "" : "s"})`;
  };

  const endRound = (): void => {
    if (!running) {
      return;
    }

    gas = isUnlimitedResources() ? gas : applyStrategicEconomyTick(gas, base, mapNodes);

    if (battle.getState().active && !battle.getState().outcome) {
      suppressWarnLogs = true;
      const noKeys: KeyState = { a: false, d: false, w: false, s: false, space: false };
      const step = 1 / 60;
      const maxSimSeconds = 240;
      let t = 0;
      while (battle.getState().active && !battle.getState().outcome && t < maxSimSeconds) {
        battle.update(step, noKeys);
        t += step;
      }
      suppressWarnLogs = false;

      if (battle.getState().active && !battle.getState().outcome) {
        const state = battle.getState();
        const victory = state.enemyBase.hp <= state.playerBase.hp;
        battle.forceEnd(victory, "Round deadline reached");
      }
    }

    for (const job of buildQueue) {
      job.remainingRounds -= 1;
    }
    for (let i = buildQueue.length - 1; i >= 0; i -= 1) {
      const job = buildQueue[i];
      if (!job || job.remainingRounds > 0) {
        continue;
      }
      if (job.kind === "refinery") {
        base.refineries += 1;
        addLog("Construction complete: Refinery", "good");
      } else if (job.kind === "expand") {
        base.areaLevel += 1;
        addLog("Construction complete: Base expanded", "good");
      } else {
        base.labs += 1;
        addLog("Construction complete: Research Lab", "good");
      }
      buildQueue.splice(i, 1);
    }

    round += 1;
    renderPanels();
  };

  const updateMetaBar = (): void => {
    const gasLabel = isUnlimitedResources() ? "INF" : `${Math.floor(gas)}`;
    const capLabel = isUnlimitedResources() ? "INF" : `${armyCap(getCommanderSkillForCap())}`;
    const battleLabel = battle.getState().active && !battle.getState().outcome ? " | Battle: active" : "";
    if (!replayMode) {
      metaBar.innerHTML = `Round: ${round} | Gas: ${gasLabel} | Commander Skill: ${commanderSkill} | Army Cap: ${capLabel}${battleLabel} <button id="btnNextRound">Next Round</button>`;
      getOptionalElement<HTMLButtonElement>("#btnNextRound")?.addEventListener("click", () => endRound());
    }

    if (!replayMode) {
      arenaReplayStats.textContent = "";
      return;
    }
    const state = battle.getState();
    const onFieldPlayer = computeOnFieldGasValue("player");
    const onFieldEnemy = computeOnFieldGasValue("enemy");
    const worthDeltaPlayer = (gas + onFieldPlayer) - (gasStartPlayer + onFieldStartPlayer);
    const worthDeltaEnemy = (state.enemyGas + onFieldEnemy) - (gasStartEnemy + onFieldStartEnemy);
    const tie = state.outcome?.reason?.toLowerCase().includes("deadline") ?? false;
    const playerOutcome: "win" | "tie" | "loss" = !state.outcome ? "loss" : tie ? "tie" : state.outcome.victory ? "win" : "loss";
    const enemyOutcome: "win" | "tie" | "loss" = !state.outcome ? "loss" : tie ? "tie" : state.outcome.victory ? "loss" : "win";
    const playerScore = (playerOutcome === "win" ? 2 : playerOutcome === "tie" ? 1 : 0) * 1_000_000 + worthDeltaPlayer;
    const enemyScore = (enemyOutcome === "win" ? 2 : enemyOutcome === "tie" ? 1 : 0) * 1_000_000 + worthDeltaEnemy;
    arenaReplayStats.textContent = `Replay | P gas=${Math.floor(gas)} field=${Math.floor(onFieldPlayer)} dWorth=${Math.floor(worthDeltaPlayer)} score=${Math.floor(playerScore)} | E gas=${Math.floor(state.enemyGas)} field=${Math.floor(onFieldEnemy)} dWorth=${Math.floor(worthDeltaEnemy)} score=${Math.floor(enemyScore)}`;
  };

  const setScreen = (next: ScreenMode): void => {
    screen = next;
    basePanel.classList.toggle("hidden", next !== "base");
    mapPanel.classList.toggle("hidden", next !== "map");
    battlePanel.classList.toggle("hidden", next !== "battle");
    editorPanel.classList.toggle("hidden", next !== "editor");
    tabs.base.classList.toggle("active", next === "base");
    tabs.map.classList.toggle("active", next === "map");
    tabs.battle.classList.toggle("active", next === "battle");
    tabs.editor.classList.toggle("active", next === "editor");
    if (next !== "editor") {
      hideEditorTooltip();
    }
  };

  const slugifyTemplateId = (rawName: string): string => {
    const base = rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");
    return base || "custom-unit";
  };

  const makeUniqueTemplateId = (baseId: string): string => {
    const used = new Set<string>(templates.map((template) => template.id));
    used.delete(editorDraft.id);
    let next = baseId;
    let index = 2;
    while (used.has(next)) {
      next = `${baseId}-${index}`;
      index += 1;
    }
    return next;
  };

  const makeCopyTemplate = (source: UnitTemplate): UnitTemplate => {
    const copy = cloneTemplate(source);
    copy.name = `${source.name}-copy`;
    copy.id = makeUniqueTemplateId(slugifyTemplateId(copy.name));
    return copy;
  };

  const updateSelectedInfo = (): void => {
    if (screen === "editor") {
      ensureEditorSelectionForLayer();
      const catalog = getEditorCatalogItems();
      const validation = validateTemplateDetailed(editorDraft);
      const controlCount = editorDraft.attachments.filter((attachment) => attachment.component === "control").length;
      const displayCount = (editorDraft.display ?? []).length;
      const materialUsage = getEditorMaterialBreakdown();
      const functionalUsage = editorDraft.attachments.length;
      const errorSummary = validation.errors.length > 0 ? validation.errors.join(" | ") : "none";
      const warningSummary = validation.warnings.length > 0 ? validation.warnings.join(" | ") : "none";
      const paletteCards = Array.from({ length: 30 }, (_, index) => {
        const item = catalog[index];
        if (!item) {
          return `<div class="editor-comp-card empty"></div>`;
        }
        const selectedClass = item.value === editorSelection ? "selected" : "";
        return `<button class="editor-comp-card ${selectedClass}" data-comp-value="${item.value}" data-comp-detail="${item.detail}" data-comp-title="${item.title}" title="${item.title}">
          <span class="editor-thumb">${item.thumb}</span>
          <span class="editor-comp-name">${item.title}</span>
          <span class="editor-comp-sub">${item.subtitle}</span>
        </button>`;
      }).join("");
      selectedInfo.innerHTML = `
        <div><strong>${editorDraft.name}</strong> (${editorDraft.type})</div>
        <div class="row">
          <button id="editorLayerStructureRight" class="${editorLayer === "structure" ? "active" : ""}">Structure</button>
          <button id="editorLayerFunctionalRight" class="${editorLayer === "functional" ? "active" : ""}">Functional</button>
          <button id="editorLayerDisplayRight" class="${editorLayer === "display" ? "active" : ""}">Display</button>
        </div>
        <div class="row">
          <label class="small">W
            <select id="editorGridCols">
              ${Array.from({ length: EDITOR_GRID_MAX_COLS - 3 }, (_, i) => i + 4).map((v) => `<option value="${v}" ${v === editorGridCols ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </label>
          <label class="small">H
            <select id="editorGridRows">
              ${Array.from({ length: EDITOR_GRID_MAX_ROWS - 3 }, (_, i) => i + 4).map((v) => `<option value="${v}" ${v === editorGridRows ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="small">Structure: ${editorDraft.structure.length} | Functional: ${functionalUsage} | Display: ${displayCount}</div>
        <div class="small">Control Units: ${controlCount}</div>
        <div class="small">${isCurrentEditorSelectionDirectional() ? `Weapon direction: ${getRotationSymbol()} (${editorWeaponRotateQuarter * 90}deg)` : "Weapon direction: n/a"}</div>
        <div class="small">Material usage: ${materialUsage}</div>
        <div class="small bad">Errors (${validation.errors.length}): ${errorSummary}</div>
        <div class="small warn">Warnings (${validation.warnings.length}): ${warningSummary}</div>
        <div class="editor-comp-grid">${paletteCards}</div>
      `;
      return;
    }
    if (screen !== "battle") {
      selectedInfo.innerHTML = `<span class="small">No unit selected.</span>`;
      return;
    }
    const selection = battle.getSelection();
    const selected = battle.getState().units.find((unit) => unit.id === selection.selectedUnitId);
    if (!selected) {
      selectedInfo.innerHTML = `<span class="small">No unit selected.</span>`;
      return;
    }

    const weaponNames = selected.weaponAttachmentIds.map((weaponId, index) => {
      const attachment = selected.attachments.find((entry) => entry.id === weaponId && entry.alive) ?? null;
      if (!attachment) {
        return `#${index + 1}: destroyed`;
      }
      const weaponType = COMPONENTS[attachment.component].type;
      const mode = selected.weaponAutoFire[index] ? "auto" : "manual";
      const selectedMark = index === selected.selectedWeaponIndex ? "*" : "";
      return `${selectedMark}#${index + 1}: ${attachment.component} (${weaponType}, ${mode})`;
    }).join(" | ");
    const structureAlive = selected.structure.filter((cell) => !cell.destroyed).length;
    const functionalAlive = selected.attachments.filter((attachment) => attachment.alive).length;
    const recoverPerSecond = selected.structure
      .filter((cell) => !cell.destroyed)
      .reduce((sum, cell) => sum + cell.recoverPerSecond, 0);
    selectedInfo.innerHTML = `
      <div><strong>${selected.name}</strong> (${selected.side})</div>
      <div class="small">Type: ${selected.type} | Mass: ${selected.mass.toFixed(1)} | Speed: ${selected.vx.toFixed(1)}</div>
      <div class="small">Structure cells: ${structureAlive}/${selected.structure.length} | Functional: ${functionalAlive}/${selected.attachments.length}</div>
      <div class="small">Structure recover: ${recoverPerSecond.toFixed(1)} hp/s</div>
      <div class="small">Weapons: ${weaponNames || "none"} | Display Layer: ${battle.isDisplayEnabled() ? "ON" : "OFF"}</div>
      <div class="small">Control Unit: ${canOperate(selected) ? "online" : "offline"}</div>
    `;
  };

  const updateWeaponHud = (): void => {
    if (screen === "editor") {
      weaponHud.innerHTML = `<div><strong>Object Editor</strong></div><div class="small">Layer=${editorLayer} | Mode=${editorDeleteMode ? "delete" : "place"}. Right-click = delete. Q/E = weapon rotate 90deg (ccw/cw). Display items attach to structure cells only.</div>`;
      return;
    }
    if (screen !== "battle") {
      weaponHud.innerHTML = `<div class="small">Weapon Control - enter battle to activate.</div>`;
      return;
    }
    const selection = battle.getSelection();
    const controlled = battle.getState().units.find((unit) => unit.id === selection.playerControlledId && unit.alive && unit.side === "player");
    if (!controlled || controlled.weaponAttachmentIds.length === 0) {
      weaponHud.innerHTML = `<div><strong>Weapon Control</strong> - Press 1..9 to select weapon, Shift+1..9 to toggle auto fire</div><div class="small">No controlled weapon system.</div>`;
      return;
    }

    const chips = controlled.weaponAttachmentIds.map((weaponId, index) => {
      const attachment = controlled.attachments.find((entry) => entry.id === weaponId && entry.alive) ?? null;
      const selectedMark = index === controlled.selectedWeaponIndex ? "selected" : "";
      const auto = controlled.weaponAutoFire[index] ? "AUTO" : "MANUAL";
      const label = attachment ? attachment.component : "destroyed";
      const timer = controlled.weaponFireTimers[index] ?? 0;
      const cooldown = attachment ? (COMPONENTS[attachment.component].cooldown ?? 0) : 0;
      const cooldownPct = cooldown > 0 ? Math.max(0, Math.min(100, ((cooldown - timer) / cooldown) * 100)) : 100;
      const cooldownText = timer > 0.01 ? `${timer.toFixed(2)}s` : "ready";
      const weaponClass = attachment ? COMPONENTS[attachment.component].weaponClass : undefined;
      const loaderManaged = weaponClass === "heavy-shot" || weaponClass === "explosive" || weaponClass === "tracking";
      const charges = controlled.weaponReadyCharges[index] ?? 0;
      const loadTimer = controlled.weaponLoadTimers[index] ?? 0;
      const loaderText = loaderManaged ? ` | load ${loadTimer > 0.01 ? `${loadTimer.toFixed(2)}s` : "idle"} | chg ${charges}` : "";
      return `<span class="weapon-chip ${selectedMark}">[${index + 1}] ${label} ${auto} | ${cooldownText} (${cooldownPct.toFixed(0)}%)${loaderText}</span>`;
    }).join("");

    weaponHud.innerHTML = `
      <div><strong>Weapon Control</strong> - Press 1..9 to select weapon, Shift+1..9 to toggle auto fire</div>
      <div class="weapon-row">${chips}</div>
    `;

    if (debugVisual) {
      const aiRows = battle.getState().units
        .filter((unit) => unit.side === "enemy" && unit.alive)
        .slice(0, 6)
        .map((unit) => {
          const angleDeg = (unit.aiDebugLastAngleRad * 180 / Math.PI).toFixed(1);
          const target = unit.aiDebugTargetId ?? "base";
          const slot = unit.aiDebugPreferredWeaponSlot >= 0 ? `${unit.aiDebugPreferredWeaponSlot + 1}` : "-";
          const lead = unit.aiDebugLeadTimeS > 0 ? `${unit.aiDebugLeadTimeS.toFixed(2)}s` : "-";
          const blocked = unit.aiDebugFireBlockReason ?? "none";
          return `<div class="small">${unit.name}: ${unit.aiState}${unit.aiDebugShouldEvade ? "(evade)" : ""}, target=${target}, slot=${slot}, angle=${angleDeg}deg, range=${unit.aiDebugLastRange.toFixed(0)}, lead=${lead}, block=${blocked}, v=(${unit.vx.toFixed(1)},${unit.vy.toFixed(1)}), tree=${unit.aiDebugDecisionPath}</div>`;
        }).join("");
      weaponHud.innerHTML += `<div class="ai-debug"><strong>AI Live Debug</strong>${aiRows || `<div class="small">No active enemy units.</div>`}</div>`;
    }
  };

  const updateBattleOpsInfo = (): void => {
    const activeInfo = getOptionalElement<HTMLDivElement>("#friendlyActive");
    if (!activeInfo) {
      return;
    }
    const activeFriendly = battle.getState().units.filter((unit) => unit.side === "player" && unit.alive).length;
    const capText = isUnlimitedResources() ? "INF" : `${armyCap(getCommanderSkillForCap())}`;
    activeInfo.textContent = `Friendly active: ${activeFriendly} / ${capText}`;
  };

  type EditorCatalogItem = {
    value: string;
    title: string;
    subtitle: string;
    detail: string;
    thumb: string;
  };

  const getEditorGridRect = (): { x: number; y: number; cell: number } => {
    const cell = 32;
    const x = Math.floor(canvas.width * 0.5 - (editorGridCols * cell) / 2 + editorGridPanX);
    const y = Math.floor(canvas.height * 0.54 - (editorGridRows * cell) / 2 + editorGridPanY);
    return { x, y, cell };
  };

  const slotToCoord = (slot: number): { x: number; y: number } => {
    const col = slot % editorGridCols;
    const row = Math.floor(slot / editorGridCols);
    const originCol = Math.floor(editorGridCols / 2);
    const originRow = Math.floor(editorGridRows / 2);
    return {
      x: col - originCol,
      y: row - originRow,
    };
  };

  const coordToSlot = (x: number, y: number): number | null => {
    const originCol = Math.floor(editorGridCols / 2);
    const originRow = Math.floor(editorGridRows / 2);
    const col = x + originCol;
    const row = y + originRow;
    if (col < 0 || col >= editorGridCols || row < 0 || row >= editorGridRows) {
      return null;
    }
    return row * editorGridCols + col;
  };

  const rotateOffsetByQuarter = (offsetX: number, offsetY: number, rotateQuarter: 0 | 1 | 2 | 3): { x: number; y: number } => {
    if (rotateQuarter === 0) {
      return { x: offsetX, y: offsetY };
    }
    if (rotateQuarter === 1) {
      return { x: -offsetY, y: offsetX };
    }
    if (rotateQuarter === 2) {
      return { x: -offsetX, y: -offsetY };
    }
    return { x: offsetY, y: -offsetX };
  };

  const getComponentFootprintOffsets = (component: ComponentId, rotateQuarter: 0 | 1 | 2 | 3): Array<{ x: number; y: number }> => {
    const stats = COMPONENTS[component];
    const placementOffsets = stats.placement?.footprintOffsets;
    if (placementOffsets && placementOffsets.length > 0) {
      return placementOffsets.map((offset) => rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter));
    }
    if (stats.type === "weapon" && stats.weaponClass === "heavy-shot") {
      return [{ x: 0, y: 0 }, { x: 1, y: 0 }].map((offset) => rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter));
    }
    return [{ x: 0, y: 0 }];
  };

  const getFootprintSlots = (anchorSlot: number, component: ComponentId, rotateQuarter: 0 | 1 | 2 | 3): { slots: number[]; anchorCoord: { x: number; y: number } } | null => {
    const anchor = slotToCoord(anchorSlot);
    const offsets = getComponentFootprintOffsets(component, rotateQuarter);
    const slots: number[] = [];
    for (const offset of offsets) {
      const slot = coordToSlot(anchor.x + offset.x, anchor.y + offset.y);
      if (slot === null) {
        return null;
      }
      slots.push(slot);
    }
    return { slots, anchorCoord: anchor };
  };

  const getPlacementOffsets = (component: ComponentId, rotateQuarter: 0 | 1 | 2 | 3): Array<{ x: number; y: number }> => {
    return (COMPONENTS[component].placement?.requireEmptyOffsets ?? []).map((offset) => rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter));
  };

  const validateFunctionalPlacement = (
    component: ComponentId,
    rotateQuarter: 0 | 1 | 2 | 3,
    anchorSlot: number,
    footprintSlots: number[],
    anchorCoord: { x: number; y: number },
  ): { ok: boolean; reason: string | null } => {
    const stats = COMPONENTS[component];
    const placement = stats.placement;
    const requireStructureOnFootprint = placement?.requireStructureOnFootprint ?? true;
    if (requireStructureOnFootprint && footprintSlots.some((occupiedSlot) => !editorStructureSlots[occupiedSlot])) {
      return { ok: false, reason: "All occupied blocks must sit on structure cells" };
    }

    if (placement?.requireStructureBelowAnchor) {
      const supportSlot = coordToSlot(anchorCoord.x, anchorCoord.y + 1);
      if (supportSlot === null || !editorStructureSlots[supportSlot]) {
        return { ok: false, reason: "Component requires structure support directly below anchor" };
      }
    }

    const requiredEmptyOffsets = getPlacementOffsets(component, rotateQuarter);
    for (const offset of requiredEmptyOffsets) {
      const requiredSlot = coordToSlot(anchorCoord.x + offset.x, anchorCoord.y + offset.y);
      if (requiredSlot === null) {
        return { ok: false, reason: "Component clearance extends beyond editor bounds" };
      }
      if (editorStructureSlots[requiredSlot]) {
        return { ok: false, reason: "Required clearance area must be empty of structure" };
      }
      if (editorFunctionalSlots[requiredSlot] && editorFunctionalSlots[requiredSlot]?.groupId !== (editorFunctionalSlots[anchorSlot]?.groupId ?? -1)) {
        return { ok: false, reason: "Required clearance area is occupied by another functional component" };
      }
    }

    return { ok: true, reason: null };
  };

  const clearFunctionalGroupAtSlot = (slot: number): boolean => {
    const entry = editorFunctionalSlots[slot];
    if (!entry) {
      return false;
    }
    const groupId = entry.groupId;
    editorFunctionalSlots = editorFunctionalSlots.map((item) => (item?.groupId === groupId ? null : item));
    return true;
  };

  const resizeEditorGrid = (nextCols: number, nextRows: number): void => {
    const clampedCols = Math.max(4, Math.min(EDITOR_GRID_MAX_COLS, Math.floor(nextCols)));
    const clampedRows = Math.max(4, Math.min(EDITOR_GRID_MAX_ROWS, Math.floor(nextRows)));
    if (clampedCols === editorGridCols && clampedRows === editorGridRows) {
      return;
    }

    const oldCols = editorGridCols;
    const oldRows = editorGridRows;
    const oldOriginCol = Math.floor(oldCols / 2);
    const oldOriginRow = Math.floor(oldRows / 2);
    const nextOriginCol = Math.floor(clampedCols / 2);
    const nextOriginRow = Math.floor(clampedRows / 2);

    const oldStructure = editorStructureSlots.slice();
    const oldFunctional = editorFunctionalSlots.slice();
    const oldDisplay = editorDisplaySlots.slice();

    const nextStructure = new Array<MaterialId | null>(EDITOR_GRID_MAX_SIZE).fill(null);
    const nextFunctional = new Array<EditorFunctionalSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
    const nextDisplay = new Array<DisplayAttachmentTemplate["kind"] | null>(EDITOR_GRID_MAX_SIZE).fill(null);

    for (let row = 0; row < oldRows; row += 1) {
      for (let col = 0; col < oldCols; col += 1) {
        const oldSlot = row * oldCols + col;
        const coordX = col - oldOriginCol;
        const coordY = row - oldOriginRow;
        const nextCol = coordX + nextOriginCol;
        const nextRow = coordY + nextOriginRow;
        if (nextCol < 0 || nextCol >= clampedCols || nextRow < 0 || nextRow >= clampedRows) {
          continue;
        }
        const newSlot = nextRow * clampedCols + nextCol;
        nextStructure[newSlot] = oldStructure[oldSlot] ?? null;
        nextFunctional[newSlot] = oldFunctional[oldSlot] ?? null;
        nextDisplay[newSlot] = oldDisplay[oldSlot] ?? null;
      }
    }

    editorGridCols = clampedCols;
    editorGridRows = clampedRows;
    editorStructureSlots = nextStructure;
    editorFunctionalSlots = nextFunctional;
    editorDisplaySlots = nextDisplay;
    recalcEditorDraftFromSlots();
  };

  const getRotationSymbol = (): string => {
    if (editorWeaponRotateQuarter === 0) {
      return "->";
    }
    if (editorWeaponRotateQuarter === 1) {
      return "v";
    }
    if (editorWeaponRotateQuarter === 2) {
      return "<-";
    }
    return "^";
  };

  const isDirectionalComponent = (component: ComponentId): boolean => {
    return COMPONENTS[component].directional === true;
  };

  const isCurrentEditorSelectionDirectional = (): boolean => {
    if (editorLayer !== "functional" || !(editorSelection in COMPONENTS)) {
      return false;
    }
    return isDirectionalComponent(editorSelection as ComponentId);
  };

  const getEditorCatalogItems = (): EditorCatalogItem[] => {
    if (editorLayer === "structure") {
      return Object.entries(MATERIALS).map(([id, stats]) => {
        const materialId = id as MaterialId;
        return {
          value: materialId,
          title: stats.label,
          subtitle: materialId,
          detail: `Mass ${stats.mass.toFixed(2)} | Armor ${stats.armor.toFixed(2)} | HP ${stats.hp.toFixed(0)} | Recover ${stats.recoverPerSecond.toFixed(1)}/s`,
          thumb: materialId.slice(0, 2).toUpperCase(),
        };
      });
    }
    if (editorLayer === "functional") {
      return Object.entries(COMPONENTS).map(([id, stats]) => {
        const rotateHint = stats.directional ? " | Supports 90deg rotate" : "";
        return {
          value: id,
          title: id,
          subtitle: stats.type,
          detail: `Type ${stats.type} | Mass ${stats.mass.toFixed(2)} | HPx ${stats.hpMul.toFixed(2)}${rotateHint}`,
          thumb: id.slice(0, 2).toUpperCase(),
        };
      });
    }
    return EDITOR_DISPLAY_KINDS.map((kind) => ({
      value: kind,
      title: kind,
      subtitle: "display",
      detail: "Visual-only attachment. Must sit on a structure cell.",
      thumb: kind.slice(0, 2).toUpperCase(),
    }));
  };

  const ensureEditorSelectionForLayer = (): void => {
    const items = getEditorCatalogItems();
    if (!items.some((item) => item.value === editorSelection)) {
      editorSelection = items[0]?.value ?? "";
    }
  };

  const recalcEditorDraftFromSlots = (): void => {
    const slotToCell = new Map<number, number>();
    const structure = editorStructureSlots
      .map((material, slotIndex) => ({ material, slotIndex }))
      .filter((entry): entry is { material: MaterialId; slotIndex: number } => entry.material !== null)
      .sort((a, b) => a.slotIndex - b.slotIndex);

    editorDraft.structure = structure.map((entry, index) => {
      slotToCell.set(entry.slotIndex, index);
      const coord = slotToCoord(entry.slotIndex);
      return { material: entry.material, x: coord.x, y: coord.y };
    });

    editorDraft.attachments = editorFunctionalSlots
      .map((entry, slotIndex) => ({ entry, slotIndex }))
      .filter((item): item is {
        entry: { component: ComponentId; rotateQuarter: 0 | 1 | 2 | 3; groupId: number; isAnchor: boolean };
        slotIndex: number;
      } => item.entry !== null && item.entry.isAnchor && slotToCell.has(item.slotIndex))
      .map((entry) => ({
        component: entry.entry.component,
        cell: slotToCell.get(entry.slotIndex) ?? 0,
        x: slotToCoord(entry.slotIndex).x,
        y: slotToCoord(entry.slotIndex).y,
        rotateQuarter: entry.entry.rotateQuarter,
      }));

    editorDraft.display = editorDisplaySlots
      .map((kind, slotIndex) => ({ kind, slotIndex }))
      .filter((entry): entry is { kind: DisplayAttachmentTemplate["kind"]; slotIndex: number } => entry.kind !== null && slotToCell.has(entry.slotIndex))
      .map((entry) => ({
        kind: entry.kind,
        cell: slotToCell.get(entry.slotIndex) ?? 0,
        x: slotToCoord(entry.slotIndex).x,
        y: slotToCoord(entry.slotIndex).y,
      }));

    // Gas is currently not derived from parts in editor mode.
  };

  const loadTemplateIntoEditorSlots = (template: UnitTemplate): void => {
    editorStructureSlots = new Array<MaterialId | null>(EDITOR_GRID_MAX_SIZE).fill(null);
    editorFunctionalSlots = new Array<EditorFunctionalSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
    editorDisplaySlots = new Array<DisplayAttachmentTemplate["kind"] | null>(EDITOR_GRID_MAX_SIZE).fill(null);

    const startCoordX = -Math.floor(template.structure.length / 2);
    const cellToSlot = new Map<number, number>();

    for (let cellIndex = 0; cellIndex < template.structure.length; cellIndex += 1) {
      const byCoord = template.structure[cellIndex]?.x !== undefined && template.structure[cellIndex]?.y !== undefined
        ? coordToSlot(template.structure[cellIndex]?.x ?? 0, template.structure[cellIndex]?.y ?? 0)
        : null;
      const slot = byCoord ?? coordToSlot(startCoordX + cellIndex, 0);
      if (slot === undefined || slot === null) {
        continue;
      }
      editorStructureSlots[slot] = template.structure[cellIndex]?.material ?? "basic";
      cellToSlot.set(cellIndex, slot);
    }

    for (const attachment of template.attachments) {
      const slot = attachment.x !== undefined && attachment.y !== undefined
        ? coordToSlot(attachment.x, attachment.y)
        : cellToSlot.get(attachment.cell);
      if (slot !== undefined && slot !== null) {
        const rotateQuarter = typeof attachment.rotateQuarter === "number"
          ? ((attachment.rotateQuarter % 4 + 4) % 4) as 0 | 1 | 2 | 3
          : (attachment.rotate90 ? 1 : 0);
        const normalizedRotate = isDirectionalComponent(attachment.component) ? rotateQuarter : 0;
        const placement = getFootprintSlots(slot, attachment.component, normalizedRotate);
        if (!placement || placement.slots.length <= 0) {
          continue;
        }
        const check = validateFunctionalPlacement(attachment.component, normalizedRotate, slot, placement.slots, placement.anchorCoord);
        if (!check.ok) {
          continue;
        }
        const groupId = editorFunctionalGroupSeq;
        editorFunctionalGroupSeq += 1;
        for (const occupiedSlot of placement.slots) {
          editorFunctionalSlots[occupiedSlot] = {
            component: attachment.component,
            rotateQuarter: normalizedRotate,
            groupId,
            isAnchor: occupiedSlot === slot,
          };
        }
      }
    }
    for (const item of template.display ?? []) {
      const slot = item.x !== undefined && item.y !== undefined
        ? coordToSlot(item.x, item.y)
        : cellToSlot.get(item.cell);
      if (slot !== undefined && slot !== null) {
        editorDisplaySlots[slot] = item.kind;
      }
    }
    recalcEditorDraftFromSlots();
  };

  const getEditorMaterialBreakdown = (): string => {
    const counts = new Map<MaterialId, number>();
    for (const cell of editorDraft.structure) {
      counts.set(cell.material, (counts.get(cell.material) ?? 0) + 1);
    }
    const tags = Array.from(counts.entries()).map(([material, count]) => `${material} x${count}`);
    return tags.length > 0 ? tags.join(", ") : "none";
  };

  const getEditorCombatPreview = (): {
    achievableSpeed: number;
    weaponCounts: Record<"rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" | "control-utility", number>;
  } => {
    let totalMass = 0;
    for (const cell of editorDraft.structure) {
      totalMass += MATERIALS[cell.material].mass;
    }
    let totalPower = 0;
    let weightedSpeedCap = 0;
    let capWeight = 0;
    const weaponCounts: Record<"rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" | "control-utility", number> = {
      "rapid-fire": 0,
      "heavy-shot": 0,
      explosive: 0,
      tracking: 0,
      "beam-precision": 0,
      "control-utility": 0,
    };

    for (const attachment of editorDraft.attachments) {
      const stats = COMPONENTS[attachment.component];
      totalMass += stats.mass;
      if (stats.type === "engine") {
        const enginePower = Math.max(0, stats.power ?? 0);
        const engineSpeedCap = Math.max(1, stats.maxSpeed ?? 90);
        totalPower += enginePower;
        weightedSpeedCap += engineSpeedCap * Math.max(1, enginePower);
        capWeight += Math.max(1, enginePower);
      }
      if (stats.type === "weapon") {
        const weaponClass = stats.weaponClass ?? "rapid-fire";
        weaponCounts[weaponClass] += 1;
      }
    }

    totalMass = Math.max(14, totalMass);
    let achievableSpeed = 0;
    if (totalPower > 0) {
      const speedCap = Math.max(1, weightedSpeedCap / Math.max(1, capWeight));
      const speedScale = editorDraft.type === "ground" ? 74 : 82;
      const rawSpeed = (totalPower / Math.max(16, totalMass)) * speedScale;
      achievableSpeed = Math.max(0, Math.min(speedCap, rawSpeed));
    }

    return {
      achievableSpeed,
      weaponCounts,
    };
  };

  const drawEditorCanvas = (): void => {
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(13, 21, 31, 0.98)";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const grid = getEditorGridRect();
    context.fillStyle = "#dbe8f6";
    context.font = "14px Trebuchet MS";
    context.fillText(`Grid ${editorGridCols}x${editorGridRows} | Layer ${editorLayer.toUpperCase()} ${editorDeleteMode ? "| DELETE" : "| PLACE"}`, 18, 26);
    context.fillText("Left-click: place | Left-drag: pan grid | Right-click: delete | Origin: (0,0).", 18, 46);

    if (isCurrentEditorSelectionDirectional()) {
      context.fillStyle = "rgba(28, 43, 61, 0.92)";
      context.fillRect(canvas.width - 170, 14, 154, 40);
      context.strokeStyle = "rgba(139, 172, 206, 0.8)";
      context.strokeRect(canvas.width - 170, 14, 154, 40);
      context.fillStyle = "#dbe8f6";
      context.font = "12px Trebuchet MS";
      context.fillText(`Dir: ${getRotationSymbol()}`, canvas.width - 160, 31);
      context.fillText(`Q ccw | E cw`, canvas.width - 160, 47);
    }

    const validation = validateTemplateDetailed(editorDraft);
    const lineCount = validation.errors.length + validation.warnings.length + 2;
    const issuesHeight = Math.max(34, 16 + Math.min(10, lineCount) * 14);
    const issuesWidth = 360;
    const issuesX = canvas.width - issuesWidth - 16;
    const issuesY = canvas.height - issuesHeight - 14;
    context.fillStyle = "rgba(21, 31, 45, 0.94)";
    context.fillRect(issuesX, issuesY, issuesWidth, issuesHeight);
    context.strokeStyle = validation.errors.length > 0 ? "rgba(224, 145, 111, 0.96)" : "rgba(151, 214, 165, 0.92)";
    context.lineWidth = 1;
    context.strokeRect(issuesX, issuesY, issuesWidth, issuesHeight);
    context.fillStyle = validation.errors.length > 0 ? "#ffd1c1" : "#bde6c6";
    context.font = "12px Trebuchet MS";
    context.fillText(`Errors (${validation.errors.length})`, issuesX + 8, issuesY + 16);
    const shownErrors = validation.errors.slice(0, 4);
    for (let i = 0; i < shownErrors.length; i += 1) {
      context.fillText(`- ${shownErrors[i]}`, issuesX + 8, issuesY + 30 + i * 14);
    }
    const warningHeaderY = issuesY + 30 + shownErrors.length * 14;
    context.fillStyle = "#ffd58c";
    context.fillText(`Warnings (${validation.warnings.length})`, issuesX + 8, warningHeaderY);
    context.fillStyle = "#ffe7b8";
    const shownWarnings = validation.warnings.slice(0, Math.max(0, 8 - shownErrors.length));
    for (let i = 0; i < shownWarnings.length; i += 1) {
      context.fillText(`- ${shownWarnings[i]}`, issuesX + 8, warningHeaderY + 14 + i * 14);
    }

    for (let row = 0; row < editorGridRows; row += 1) {
      for (let col = 0; col < editorGridCols; col += 1) {
        const slot = row * editorGridCols + col;
        const x = grid.x + col * grid.cell;
        const y = grid.y + row * grid.cell;
        const material = editorStructureSlots[slot];

        context.fillStyle = material ? MATERIALS[material].color : "rgba(39, 56, 76, 0.42)";
        context.globalAlpha = material ? 0.82 : 1;
        context.fillRect(x + 2, y + 2, grid.cell - 4, grid.cell - 4);
        context.globalAlpha = 1;
        context.strokeStyle = material ? "rgba(224, 236, 251, 0.72)" : "rgba(121, 148, 180, 0.35)";
        context.lineWidth = 1;
        context.strokeRect(x + 1, y + 1, grid.cell - 2, grid.cell - 2);

        const functional = editorFunctionalSlots[slot];
        if (functional) {
          context.fillStyle = "#f0b39f";
          context.fillRect(x + 6, y + 6, 12, 12);
          if (functional.isAnchor) {
            context.fillStyle = "#fff5ef";
            context.font = "9px Trebuchet MS";
            context.fillText(functional.component.slice(0, 2).toUpperCase(), x + 6, y + 30);
          }
          if (functional.isAnchor && COMPONENTS[functional.component].directional) {
            context.strokeStyle = "#ffe1d4";
            context.lineWidth = 1.5;
            context.beginPath();
            if (functional.rotateQuarter === 0) {
              context.moveTo(x + 18, y + 24);
              context.lineTo(x + 34, y + 24);
              context.lineTo(x + 30, y + 20);
              context.moveTo(x + 34, y + 24);
              context.lineTo(x + 30, y + 28);
            } else if (functional.rotateQuarter === 1) {
              context.moveTo(x + 24, y + 18);
              context.lineTo(x + 24, y + 34);
              context.lineTo(x + 20, y + 30);
              context.moveTo(x + 24, y + 34);
              context.lineTo(x + 28, y + 30);
            } else if (functional.rotateQuarter === 2) {
              context.moveTo(x + 34, y + 24);
              context.lineTo(x + 18, y + 24);
              context.lineTo(x + 22, y + 20);
              context.moveTo(x + 18, y + 24);
              context.lineTo(x + 22, y + 28);
            } else {
              context.moveTo(x + 24, y + 34);
              context.lineTo(x + 24, y + 18);
              context.lineTo(x + 20, y + 22);
              context.moveTo(x + 24, y + 18);
              context.lineTo(x + 28, y + 22);
            }
            context.stroke();
          }
        }

        const display = editorDisplaySlots[slot];
        if (display) {
          context.fillStyle = "#98c8ff";
          context.fillRect(x + grid.cell - 16, y + 6, 10, 10);
          context.fillStyle = "#e6f2ff";
          context.font = "8px Trebuchet MS";
          context.fillText(display.slice(0, 1).toUpperCase(), x + grid.cell - 14, y + 24);
        }

        const coord = slotToCoord(slot);
        context.fillStyle = "rgba(206, 220, 237, 0.55)";
        context.font = "8px Trebuchet MS";
        context.fillText(`(${coord.x},${coord.y})`, x + 4, y + grid.cell - 4);
      }
    }

    const preview = getEditorCombatPreview();
    const legend = `Wpn by class R:${preview.weaponCounts["rapid-fire"]} H:${preview.weaponCounts["heavy-shot"]} E:${preview.weaponCounts.explosive} T:${preview.weaponCounts.tracking} B:${preview.weaponCounts["beam-precision"]} C:${preview.weaponCounts["control-utility"]}`;
    const speedText = `Achievable speed: ${preview.achievableSpeed.toFixed(1)}`;
    const panelX = 16;
    const panelY = canvas.height - 54;
    context.fillStyle = "rgba(19, 30, 44, 0.94)";
    context.fillRect(panelX, panelY, 530, 38);
    context.strokeStyle = "rgba(128, 172, 206, 0.7)";
    context.strokeRect(panelX, panelY, 530, 38);
    context.fillStyle = "#dbe8f6";
    context.font = "12px Trebuchet MS";
    context.fillText(speedText, panelX + 8, panelY + 15);
    context.fillText(legend, panelX + 8, panelY + 31);
  };

  const applyEditorCellAction = (mouseX: number, mouseY: number, forceDelete = false): void => {
    const grid = getEditorGridRect();
    const relX = mouseX - grid.x;
    const relY = mouseY - grid.y;
    if (relX < 0 || relY < 0 || relX >= grid.cell * editorGridCols || relY >= grid.cell * editorGridRows) {
      return;
    }
    const col = Math.floor(relX / grid.cell);
    const row = Math.floor(relY / grid.cell);
    const slot = row * editorGridCols + col;
    const deleteRequested = forceDelete || editorDeleteMode;

    if (editorLayer === "structure") {
      if (deleteRequested) {
        const hadStructure = editorStructureSlots[slot] !== null;
        clearFunctionalGroupAtSlot(slot);
        editorStructureSlots[slot] = null;
        editorDisplaySlots[slot] = null;
        if (!hadStructure) {
          addLog(`No structure cell at row ${row + 1}, col ${col + 1}`, "warn");
        }
      } else if (editorSelection in MATERIALS) {
        editorStructureSlots[slot] = editorSelection as MaterialId;
      }
      recalcEditorDraftFromSlots();
      return;
    }

    if (!editorStructureSlots[slot]) {
      addLog("Select a structure cell first", "warn");
      return;
    }

    if (editorLayer === "functional") {
      if (deleteRequested) {
        const hadFunctional = clearFunctionalGroupAtSlot(slot);
        if (!hadFunctional) {
          addLog(`No functional component at row ${row + 1}, col ${col + 1}`, "warn");
        }
      } else if (editorSelection in COMPONENTS) {
        const component = editorSelection as ComponentId;
        const rotateQuarter = COMPONENTS[component].directional ? editorWeaponRotateQuarter : 0;
        const placement = getFootprintSlots(slot, component, rotateQuarter);
        if (!placement || placement.slots.length <= 0) {
          addLog("Component footprint out of editor bounds", "warn");
          return;
        }
        const check = validateFunctionalPlacement(component, rotateQuarter, slot, placement.slots, placement.anchorCoord);
        if (!check.ok) {
          addLog(check.reason ?? "Invalid component placement", "warn");
          return;
        }
        if (component === "control") {
          editorFunctionalSlots = editorFunctionalSlots.map((entry) => (entry?.component === "control" ? null : entry));
        }
        const occupiedGroupIds = new Set(
          placement.slots
            .map((occupiedSlot) => editorFunctionalSlots[occupiedSlot]?.groupId ?? null)
            .filter((groupId): groupId is number => groupId !== null),
        );
        if (occupiedGroupIds.size > 0) {
          editorFunctionalSlots = editorFunctionalSlots.map((entry) => {
            if (!entry) {
              return null;
            }
            return occupiedGroupIds.has(entry.groupId) ? null : entry;
          });
        }
        const groupId = editorFunctionalGroupSeq;
        editorFunctionalGroupSeq += 1;
        for (const occupiedSlot of placement.slots) {
          editorFunctionalSlots[occupiedSlot] = {
            component,
            rotateQuarter,
            groupId,
            isAnchor: occupiedSlot === slot,
          };
        }
      }
      recalcEditorDraftFromSlots();
      return;
    }

    if (deleteRequested) {
      const hadDisplay = editorDisplaySlots[slot] !== null;
      editorDisplaySlots[slot] = null;
      if (!hadDisplay) {
        addLog(`No display component at row ${row + 1}, col ${col + 1}`, "warn");
      }
    } else if (EDITOR_DISPLAY_KINDS.includes(editorSelection as DisplayAttachmentTemplate["kind"])) {
      editorDisplaySlots[slot] = editorSelection as DisplayAttachmentTemplate["kind"];
    }
    recalcEditorDraftFromSlots();
  };

  const renderPanels = (): void => {
    updateMetaBar();

    const buildQueueText = buildQueue.length > 0
      ? buildQueue.map((job) => `<span class="tag">${formatBuildJob(job)}</span>`).join(" ")
      : "None";

    basePanel.innerHTML = `
      <h3>Base</h3>
      <div class="small">Area Lv.${base.areaLevel} | Refineries: ${base.refineries} | Workshops: ${base.workshops} | Labs: ${base.labs}</div>
      <div class="small">Construction queue: ${buildQueueText}</div>
      <div class="row">
        <button id="btnBuildRefinery">Build Refinery (90 gas, ${buildRounds.refinery} round)</button>
        <button id="btnExpandBase">Expand Base (120 gas, ${buildRounds.expand} rounds)</button>
        <button id="btnBuildLab">Build Lab (110 gas, ${buildRounds.lab} rounds)</button>
      </div>
      <div class="small">Tech unlocks: ${Object.entries(tech).filter((entry) => entry[1]).map((entry) => `<span class="tag">${entry[0]}</span>`).join("") || "None"}</div>
      <div class="row" style="margin-top:8px;">
        <button id="btnUnlockReinforced">Unlock Reinforced (130 gas)</button>
        <button id="btnUnlockCombined">Unlock Combined Box (180 gas)</button>
        <button id="btnUnlockMediumWeapon">Unlock Explosive Cannon (170 gas)</button>
      </div>
    `;

    mapPanel.innerHTML = `
      <h3>Map</h3>
      <div class="small">Choose where to fight from your base.</div>
      ${battle.getState().active && !battle.getState().outcome ? `<div class="small warn">Battle resolves when you press Next Round.</div>` : ""}
      ${mapNodes
        .map((node) => {
          const ownerClass = node.owner === "player" ? "good" : node.owner === "enemy" ? "bad" : "warn";
          return `<div class="node-card">
            <div><strong>${node.name}</strong> <span class="${ownerClass}">(${node.owner})</span></div>
            <div class="small">Defense: ${node.defense.toFixed(2)} | Reward: ${node.reward} gas ${node.garrison ? "| Garrisoned" : ""}</div>
            <div class="row"><button data-attack="${node.id}" class="nodeAttack">Launch Battle</button></div>
          </div>`;
        })
        .join("")}
      ${pendingOccupation ? `<div class="row"><button id="btnSettle">Station Garrison (upkeep 4 gas/round)</button></div>` : ""}
    `;

    battlePanel.innerHTML = `
      <h3>Battle Ops</h3>
      <div class="small">Call reinforcements using global gas. Active cap from commander skill.</div>
      <div class="small">Turn-based: battle ends at end of round (press Next Round to resolve).</div>
      <div class="row">${templates.map((template) => `<button data-deploy="${template.id}">${template.name} (${template.gasCost} gas)</button>`).join("")}</div>
      <div class="row"><button id="btnToggleDisplay">Toggle Display Layer (${battle.isDisplayEnabled() ? "ON" : "OFF"})</button></div>
      <div id="friendlyActive" class="small"></div>
      ${battle.getState().outcome ? `<div class="row"><button id="btnBackToMap">Return to Map</button></div>` : ""}
    `;

    ensureEditorSelectionForLayer();
    if (editorTemplateDialogSelectedId === null || !templates.some((template) => template.id === editorTemplateDialogSelectedId)) {
      editorTemplateDialogSelectedId = templates[0]?.id ?? null;
    }
    const templateOpenRows = templates
      .map((template) => {
        const selectedClass = template.id === editorTemplateDialogSelectedId ? "active" : "";
        return `<div class="row" style="justify-content:space-between; gap:8px;">
          <button data-editor-open-select="${template.id}" class="${selectedClass}" style="flex:1; text-align:left;">${template.name} (${template.type})</button>
          <button data-editor-open-copy="${template.id}">Copy</button>
        </div>`;
      })
      .join("");
    editorPanel.innerHTML = `
      <h3>Object Editor</h3>
      <div class="small">Choose a layer, pick a component card on the right panel, then click the ${editorGridCols}x${editorGridRows} grid on canvas. Drag with left mouse to move the grid. Origin is (0,0), negative coordinates supported.</div>
      <div class="row">
        <button id="btnOpenTemplateWindow">Open</button>
        <span class="small">Current object: ${editorDraft.name}</span>
      </div>
      ${editorTemplateDialogOpen ? `<div class="node-card">
        <div><strong>Open Template</strong></div>
        <div class="small">Select one template to open directly, or use Copy to create an editable copy with "-copy" suffix.</div>
        <div style="display:flex; flex-direction:column; gap:6px; margin-top:8px; max-height:220px; overflow:auto;">
          ${templateOpenRows || `<div class="small">No template available.</div>`}
        </div>
        <div class="row" style="margin-top:8px;">
          <button id="btnOpenTemplateApply" ${editorTemplateDialogSelectedId ? "" : "disabled"}>Open Selected</button>
          <button id="btnOpenTemplateClose">Close</button>
        </div>
      </div>` : ""}
      <div class="row">
        <label class="small">Name <input id="editorName" value="${editorDraft.name}" /></label>
      </div>
      <div class="row">
        <label class="small">Type
          <select id="editorType">
            <option value="ground" ${editorDraft.type === "ground" ? "selected" : ""}>Ground</option>
            <option value="air" ${editorDraft.type === "air" ? "selected" : ""}>Air</option>
          </select>
        </label>
        <span class="small">Template cost is configured outside part composition.</span>
      </div>
      <div class="row">
        <label class="small"><input id="editorDeleteMode" type="checkbox" ${editorDeleteMode ? "checked" : ""} /> Delete mode</label>
        <span class="small">Selected: ${editorSelection || "none"}</span>
      </div>
      <div class="row">
        <span class="small">${isCurrentEditorSelectionDirectional() ? `Direction: ${editorWeaponRotateQuarter * 90}deg (${getRotationSymbol()})` : "Direction: n/a (undirectional component)"}</span>
      </div>
      <div class="row">
        <button id="btnNewDraft">New Draft</button>
        <button id="btnClearGrid">Clear Grid</button>
      </div>
      <div class="row">
        <button id="btnSaveDraft">Save User Object</button>
      </div>
    `;

    updateBattleOpsInfo();
    updateSelectedInfo();
    updateWeaponHud();
    bindPanelActions();
  };

  const spendGas = (amount: number): boolean => {
    if (isUnlimitedResources()) {
      return true;
    }
    if (gas < amount) {
      return false;
    }
    gas -= amount;
    return true;
  };

  const upgradeTemplateMaterials = (material: "reinforced" | "combined"): void => {
    for (const template of templates) {
      for (const cell of template.structure) {
        cell.material = material;
      }
      template.gasCost += material === "combined" ? 8 : 4;
    }
  };

  const bindPanelActions = (): void => {
    getOptionalElement<HTMLButtonElement>("#btnBuildRefinery")?.addEventListener("click", () => {
      if (!spendGas(90)) {
        return;
      }
      buildQueue.push({ kind: "refinery", remainingRounds: buildRounds.refinery });
      addLog(`Construction started: Refinery (${buildRounds.refinery} round${buildRounds.refinery === 1 ? "" : "s"})`, "good");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnExpandBase")?.addEventListener("click", () => {
      if (!spendGas(120)) {
        return;
      }
      buildQueue.push({ kind: "expand", remainingRounds: buildRounds.expand });
      addLog(`Construction started: Base Expansion (${buildRounds.expand} rounds)`, "good");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnBuildLab")?.addEventListener("click", () => {
      if (!spendGas(110)) {
        return;
      }
      buildQueue.push({ kind: "lab", remainingRounds: buildRounds.lab });
      addLog(`Construction started: Research Lab (${buildRounds.lab} rounds)`, "good");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnUnlockReinforced")?.addEventListener("click", () => {
      if (tech.reinforced || base.labs < 1 || !spendGas(130)) {
        return;
      }
      tech.reinforced = true;
      upgradeTemplateMaterials("reinforced");
      addLog("Unlocked Reinforced structure boxes", "good");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnUnlockCombined")?.addEventListener("click", () => {
      if (tech.combined || base.labs < 1 || !spendGas(180)) {
        return;
      }
      tech.combined = true;
      upgradeTemplateMaterials("combined");
      addLog("Unlocked Combined box material", "good");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnUnlockMediumWeapon")?.addEventListener("click", () => {
      if (tech.mediumWeapons || base.labs < 1 || !spendGas(170)) {
        return;
      }
      tech.mediumWeapons = true;
      const tankTemplate = templates.find((template) => template.id === "tank-ground");
      const weapon = tankTemplate?.attachments.find((attachment) => attachment.component === "heavyCannon");
      if (weapon && tankTemplate) {
        weapon.component = "explosiveShell";
        tankTemplate.gasCost += 9;
      }
      addLog("Unlocked explosive cannon option", "good");
      renderPanels();
    });

    document.querySelectorAll<HTMLButtonElement>("button.nodeAttack").forEach((button) => {
      button.addEventListener("click", () => {
        if (battle.getState().active && !battle.getState().outcome) {
          addLog("Battle already active. Press Next Round to resolve.", "warn");
          return;
        }
        const nodeId = button.getAttribute("data-attack");
        if (!nodeId) {
          return;
        }
        const node = mapNodes.find((entry) => entry.id === nodeId);
        if (!node) {
          return;
        }
        battle.start(node);
        addLog(`Battle started at ${node.name}`);
        setScreen("battle");
        renderPanels();
      });
    });

    getOptionalElement<HTMLButtonElement>("#btnSettle")?.addEventListener("click", () => {
      if (!pendingOccupation) {
        return;
      }
      if (settleNodeGarrison(mapNodes, pendingOccupation)) {
        const settledNode = mapNodes.find((entry) => entry.id === pendingOccupation);
        if (settledNode) {
          addLog(`Garrison established at ${settledNode.name} (upkeep active)`);
        }
        pendingOccupation = null;
      }
      renderPanels();
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-deploy]").forEach((button) => {
      button.addEventListener("click", () => {
        const templateId = button.getAttribute("data-deploy");
        if (!templateId) {
          return;
        }
        battle.deployUnit(templateId);
        renderPanels();
      });
    });

    getOptionalElement<HTMLButtonElement>("#btnBackToMap")?.addEventListener("click", () => {
      battle.resetToMapMode();
      setScreen("map");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnToggleDisplay")?.addEventListener("click", () => {
      battle.toggleDisplayLayer();
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#editorLayerStructureRight")?.addEventListener("click", () => {
      editorLayer = "structure";
      hideEditorTooltip();
      ensureEditorSelectionForLayer();
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnOpenTemplateWindow")?.addEventListener("click", () => {
      editorTemplateDialogOpen = !editorTemplateDialogOpen;
      if (editorTemplateDialogOpen && !editorTemplateDialogSelectedId) {
        editorTemplateDialogSelectedId = templates[0]?.id ?? null;
      }
      renderPanels();
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-editor-open-select]").forEach((button) => {
      button.addEventListener("click", () => {
        const templateId = button.getAttribute("data-editor-open-select");
        if (!templateId) {
          return;
        }
        editorTemplateDialogSelectedId = templateId;
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-editor-open-copy]").forEach((button) => {
      button.addEventListener("click", () => {
        const templateId = button.getAttribute("data-editor-open-copy");
        if (!templateId) {
          return;
        }
        const source = templates.find((template) => template.id === templateId);
        if (!source) {
          return;
        }
        editorDraft = makeCopyTemplate(source);
        loadTemplateIntoEditorSlots(editorDraft);
        editorDeleteMode = false;
        editorWeaponRotateQuarter = 0;
        editorTemplateDialogOpen = false;
        editorTemplateDialogSelectedId = editorDraft.id;
        ensureEditorSelectionForLayer();
        addLog(`Created template copy: ${editorDraft.name}`, "good");
        renderPanels();
      });
    });

    getOptionalElement<HTMLButtonElement>("#btnOpenTemplateApply")?.addEventListener("click", () => {
      const templateId = editorTemplateDialogSelectedId;
      if (!templateId) {
        return;
      }
      const source = templates.find((template) => template.id === templateId);
      if (!source) {
        return;
      }
      editorDraft = cloneTemplate(source);
      loadTemplateIntoEditorSlots(editorDraft);
      editorDeleteMode = false;
      editorWeaponRotateQuarter = 0;
      editorTemplateDialogOpen = false;
      ensureEditorSelectionForLayer();
      renderPanels();
    });
    getOptionalElement<HTMLButtonElement>("#btnOpenTemplateClose")?.addEventListener("click", () => {
      editorTemplateDialogOpen = false;
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#editorLayerFunctionalRight")?.addEventListener("click", () => {
      editorLayer = "functional";
      hideEditorTooltip();
      ensureEditorSelectionForLayer();
      renderPanels();
    });
    getOptionalElement<HTMLButtonElement>("#editorLayerDisplayRight")?.addEventListener("click", () => {
      editorLayer = "display";
      hideEditorTooltip();
      ensureEditorSelectionForLayer();
      renderPanels();
    });

    getOptionalElement<HTMLInputElement>("#editorDeleteMode")?.addEventListener("change", (event) => {
      editorDeleteMode = (event.currentTarget as HTMLInputElement).checked;
      renderPanels();
    });
    getOptionalElement<HTMLSelectElement>("#editorGridCols")?.addEventListener("change", (event) => {
      const value = Number.parseInt((event.currentTarget as HTMLSelectElement).value, 10);
      if (Number.isFinite(value)) {
        resizeEditorGrid(value, editorGridRows);
      }
      renderPanels();
    });
    getOptionalElement<HTMLSelectElement>("#editorGridRows")?.addEventListener("change", (event) => {
      const value = Number.parseInt((event.currentTarget as HTMLSelectElement).value, 10);
      if (Number.isFinite(value)) {
        resizeEditorGrid(editorGridCols, value);
      }
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#editorName")?.addEventListener("input", (event) => {
      editorDraft.name = (event.currentTarget as HTMLInputElement).value.trim() || "Custom Unit";
      updateSelectedInfo();
    });
    getOptionalElement<HTMLSelectElement>("#editorType")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      editorDraft.type = value === "air" ? "air" : "ground";
      updateSelectedInfo();
    });

    getOptionalElement<HTMLButtonElement>("#btnClearGrid")?.addEventListener("click", () => {
      editorStructureSlots = new Array<MaterialId | null>(EDITOR_GRID_MAX_SIZE).fill(null);
      editorFunctionalSlots = new Array<EditorFunctionalSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
      editorDisplaySlots = new Array<DisplayAttachmentTemplate["kind"] | null>(EDITOR_GRID_MAX_SIZE).fill(null);
      recalcEditorDraftFromSlots();
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnNewDraft")?.addEventListener("click", () => {
      const newName = "Custom Unit";
      editorDraft = {
        id: makeUniqueTemplateId(slugifyTemplateId(newName)),
        name: newName,
        type: "ground",
        gasCost: 0,
        structure: [],
        attachments: [],
        display: [],
      };
      editorDeleteMode = false;
      editorLayer = "structure";
      editorWeaponRotateQuarter = 0;
      editorTemplateDialogOpen = false;
      editorTemplateDialogSelectedId = editorDraft.id;
      loadTemplateIntoEditorSlots({
        ...editorDraft,
        structure: [{ material: "basic" }, { material: "basic" }, { material: "basic" }],
      });
      ensureEditorSelectionForLayer();
      renderPanels();
    });
    getOptionalElement<HTMLButtonElement>("#btnSaveDraft")?.addEventListener("click", async () => {
      const snapshot = cloneTemplate(editorDraft);
      const validation = validateTemplateDetailed(snapshot);
      if (validation.errors.length > 0) {
        for (const issue of validation.errors) {
          addLog(`Error: ${issue}`, "bad");
        }
      }
      if (validation.warnings.length > 0) {
        for (const issue of validation.warnings) {
          addLog(`Warning: ${issue}`, "warn");
        }
      }
      const saved = await saveUserTemplateToStore(snapshot);
      if (!saved) {
        addLog("Failed to save user object", "bad");
        return;
      }
      const existingIndex = templates.findIndex((template) => template.id === snapshot.id);
      if (existingIndex >= 0) {
        templates[existingIndex] = snapshot;
      } else {
        templates.push(snapshot);
      }
      addLog(`Saved user object: ${snapshot.name}`, "good");
      renderPanels();
    });
  };

  tabs.base.addEventListener("click", () => setScreen("base"));
  tabs.map.addEventListener("click", () => setScreen("map"));
  tabs.battle.addEventListener("click", () => setScreen("battle"));
  tabs.editor.addEventListener("click", () => setScreen("editor"));

  selectedInfo.addEventListener("mouseover", (event) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLButtonElement>("button.editor-comp-card[data-comp-value]");
    if (!card) {
      return;
    }
    const title = card.getAttribute("data-comp-title") ?? "";
    const detail = card.getAttribute("data-comp-detail") ?? "";
    const info = `${title}: ${detail}`;
    const mouseEvent = event as MouseEvent;
    showEditorTooltip(info, mouseEvent.clientX, mouseEvent.clientY);
  });

  selectedInfo.addEventListener("mousemove", (event) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLButtonElement>("button.editor-comp-card[data-comp-value]");
    if (!card || editorTooltip.classList.contains("hidden")) {
      return;
    }
    const mouseEvent = event as MouseEvent;
    editorTooltip.style.left = `${mouseEvent.clientX + 14}px`;
    editorTooltip.style.top = `${mouseEvent.clientY + 14}px`;
  });

  selectedInfo.addEventListener("mouseout", (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest("button.editor-comp-card[data-comp-value]")) {
      return;
    }
    const related = event.relatedTarget as HTMLElement | null;
    if (related?.closest("button.editor-comp-card[data-comp-value]")) {
      return;
    }
    hideEditorTooltip();
  });

  const selectEditorCard = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLButtonElement>("button.editor-comp-card[data-comp-value]");
    if (!card) {
      return;
    }
    const value = card.getAttribute("data-comp-value") ?? "";
    if (!value) {
      return;
    }
    editorSelection = value;
    hideEditorTooltip();
    ensureEditorSelectionForLayer();
    renderPanels();
  };

  selectedInfo.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    selectEditorCard(event);
  });

  const applyDebugFlags = (): void => {
    if (replayMode) {
      debugUnlimitedResources = false;
      debugVisual = false;
      debugTargetLines = false;
      battle.setDebugDrawEnabled(false);
      battle.setDebugTargetLineEnabled(false);
      return;
    }
    debugUnlimitedResources = debugResourcesChk.checked;
    debugVisual = debugVisualChk.checked;
    debugTargetLines = debugTargetLineChk.checked;
    syncDebugServerState();
    battle.setDebugDrawEnabled(isDebugVisual());
    battle.setDebugTargetLineEnabled(isDebugTargetLines());
    addLog(`Debug options: resources=${debugUnlimitedResources ? "on" : "off"}, visual=${debugVisual ? "on" : "off"}, targetLines=${debugTargetLines ? "on" : "off"}`, "warn");
    renderPanels();
  };

  debugResourcesChk.addEventListener("change", applyDebugFlags);
  debugVisualChk.addEventListener("change", applyDebugFlags);
  debugTargetLineChk.addEventListener("change", applyDebugFlags);
  debugResourcesChk.checked = replayMode ? false : true;
  debugVisualChk.checked = replayMode ? false : true;
  debugTargetLineChk.checked = replayMode ? false : true;
  applyDebugFlags();

  window.addEventListener("keydown", (event) => {
    if (isTypingInFormField(event.target)) {
      return;
    }

    if (screen === "editor") {
      if (event.key === "q" || event.key === "Q") {
        event.preventDefault();
        editorWeaponRotateQuarter = ((editorWeaponRotateQuarter + 3) % 4) as 0 | 1 | 2 | 3;
        renderPanels();
        return;
      }
      if (event.key === "e" || event.key === "E") {
        event.preventDefault();
        editorWeaponRotateQuarter = ((editorWeaponRotateQuarter + 1) % 4) as 0 | 1 | 2 | 3;
        renderPanels();
        return;
      }
    }

    if (screen !== "battle") {
      return;
    }

    if (event.key === "a" || event.key === "A") keys.a = true;
    if (event.key === "d" || event.key === "D") keys.d = true;
    if (event.key === "w" || event.key === "W") keys.w = true;
    if (event.key === "s" || event.key === "S") keys.s = true;
    if (event.code === "Space") {
      event.preventDefault();
      battle.flipControlledDirection();
      renderPanels();
    }
    if (event.code.startsWith("Digit")) {
      const slot = Number.parseInt(event.code.replace("Digit", ""), 10) - 1;
      if (!Number.isNaN(slot) && slot >= 0) {
        if (event.shiftKey) {
          event.preventDefault();
          battle.toggleControlledWeaponAutoFire(slot);
        } else {
          battle.selectControlledWeapon(slot);
        }
        renderPanels();
      }
    }
  });

  window.addEventListener("keyup", (event) => {
    if (isTypingInFormField(event.target) || screen !== "battle") {
      return;
    }
    if (event.key === "a" || event.key === "A") keys.a = false;
    if (event.key === "d" || event.key === "D") keys.d = false;
    if (event.key === "w" || event.key === "W") keys.w = false;
    if (event.key === "s" || event.key === "S") keys.s = false;
  });

  canvas.addEventListener("mousedown", (event) => {
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    if (screen === "editor") {
      const rightClickDelete = event.button === 2;
      if (rightClickDelete) {
        event.preventDefault();
        applyEditorCellAction(x, y, true);
        renderPanels();
        return;
      }
      editorDragActive = true;
      editorDragMoved = false;
      editorDragStartClientX = event.clientX;
      editorDragStartClientY = event.clientY;
      editorDragLastClientX = event.clientX;
      editorDragLastClientY = event.clientY;
      editorPendingClickX = x;
      editorPendingClickY = y;
      return;
    }
    if (event.button === 2) {
      battle.clearControlSelection();
      renderPanels();
      return;
    }
    battle.handleLeftPointerDown(x, y);
    renderPanels();
  });

  canvas.addEventListener("contextmenu", (event) => {
    if (screen === "editor" || screen === "battle") {
      event.preventDefault();
    }
  });

  window.addEventListener("mouseup", () => {
    if (screen === "editor" && editorDragActive) {
      if (!editorDragMoved) {
        applyEditorCellAction(editorPendingClickX, editorPendingClickY);
        renderPanels();
      }
      editorDragActive = false;
      editorDragMoved = false;
    }
    battle.handlePointerUp();
  });

  canvas.addEventListener("mouseleave", () => {
    if (screen === "editor") {
      editorDragActive = false;
      editorDragMoved = false;
    }
    battle.handlePointerUp();
  });

  canvas.addEventListener("mousemove", (event) => {
    if (screen === "editor") {
      if (editorDragActive) {
        const dx = event.clientX - editorDragLastClientX;
        const dy = event.clientY - editorDragLastClientY;
        editorDragLastClientX = event.clientX;
        editorDragLastClientY = event.clientY;
        const movedDistance = Math.hypot(event.clientX - editorDragStartClientX, event.clientY - editorDragStartClientY);
        if (movedDistance > 4) {
          editorDragMoved = true;
        }
        if (editorDragMoved) {
          editorGridPanX += dx * (canvas.width / canvas.getBoundingClientRect().width);
          editorGridPanY += dy * (canvas.height / canvas.getBoundingClientRect().height);
        }
      }
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    battle.setAim(x, y);
  });

  loadTemplateIntoEditorSlots(editorDraft);
  ensureEditorSelectionForLayer();
  setScreen("base");
  addLog("Campaign initialized");
  renderPanels();
  void refreshTemplatesFromStore().then(() => {
    addLog("Loaded default and user object templates", "good");
    renderPanels();
  });
  let panelBucket = -1;

  let loopUpdate = (dt: number): void => {
      if (!running) {
        return;
      }
      if (screen === "battle" && battle.getState().active) {
        battle.update(dt, keys);
      }
    };

  const loop = new GameLoop(
    (dt) => {
      loopUpdate(dt);
    },
    (_alpha, now) => {
      if (screen === "editor") {
        drawEditorCanvas();
      } else {
        battle.draw(now);
      }
      const nextBucket = Math.floor(now * 4);
      if (nextBucket !== panelBucket) {
        panelBucket = nextBucket;
        updateMetaBar();
        updateBattleOpsInfo();
        updateSelectedInfo();
        updateWeaponHud();
      }
    },
  );
  const applyTimeScale = (): void => {
    const value = Number(timeScale.value);
    const next = Number.isFinite(value) ? value : 1;
    timeScaleLabel.textContent = `${next.toFixed(1)}x`;
    loop.setTimeScale(next);
  };
  timeScale.addEventListener("input", () => applyTimeScale());
  applyTimeScale();
  loop.start();

  if (replayMode) {
    blockUserInputForReplay();
    // Ensure we use MVP templates from the server endpoints before starting replay.
    void refreshTemplatesFromStore().then(() => {
      startArenaReplay();
    });
  }
}

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function getOptionalElement<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}
