import { armyCap } from "../config/balance/commander.ts";
import { getIncomeAndUpkeep } from "../config/balance/economy.ts";
import {
  AIR_HOLD_GRAVITY,
  AIR_POWER_TO_SPEED_SCALE,
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  DEFAULT_UNIT_MOVEMENT_SPEED_MULTIPLIER,
  DEFAULT_GROUND_HEIGHT_RATIO,
  BATTLE_SALVAGE_REFUND_FACTOR,
} from "../config/balance/battlefield.ts";
import { createMapNodes } from "../gameplay/map/node-graph.ts";
import {
  BUILDING_CATALOG,
  RealTimeCampaign,
  RESEARCH_CATALOG,
  quoteBattleLogistics,
  type BaseBuildingSlot,
  type BuildingKind,
  type ResearchKind,
} from "../gameplay/campaign/real-time-campaign.ts";
import { settleGarrison as settleNodeGarrison, setNodeOwner } from "../gameplay/map/occupation.ts";
import { GameLoop } from "./game-loop.ts";
import { createInitialTemplates } from "../simulation/units/unit-builder.ts";
import { canOperate } from "../simulation/units/control-unit-rules.ts";
import { COMPONENTS } from "../config/balance/weapons.ts";
import { MATERIALS } from "../config/balance/materials.ts";
import { BattleSession } from "../gameplay/battle/battle-session.ts";
import type { BattleSessionOptions } from "../gameplay/battle/battle-session.ts";
import {
  DEFAULT_BATTLE_SOUND_VOLUME,
  PhaserBattleRenderer,
} from "../rendering/phaser-battle-renderer.ts";
import type { BattleAiController } from "../gameplay/battle/battle-session.ts";
import { createBaselineCompositeAiController } from "../ai/composite/baseline-modules.ts";
import {
  cloneTemplate,
  computeTemplateGasCost,
  deleteDefaultTemplateFromStore,
  deleteUserTemplateFromStore,
  fetchDefaultTemplatesFromStore,
  fetchUserTemplatesFromStore,
  isDeployableTemplate,
  mergeTemplates,
  saveDefaultTemplateToStore,
  validateTemplateDetailed,
} from "./template-store.ts";
import {
  clonePartDefinition,
  deleteDefaultPartFromStore,
  fetchDefaultPartsFromStore,
  getPartFootprintOffsets,
  isPartCompatibleWithUnitType,
  mergePartCatalogs,
  normalizePartAttachmentRotate,
  resolvePartDefinitionForAttachment,
  saveDefaultPartsToStore,
  saveDefaultPartToStore,
  validatePartDefinitionDetailed,
} from "./part-store.ts";
import {
  calculateDestroyTimeSeconds,
  calculateHitsToDestroy,
  formatDestroyTime,
  resolvePartGasCost,
  resolveStructureComparisonValues,
  resolveWeaponComparisonValues,
} from "./part-comparison.ts";
import {
  createDefaultPartDraft,
  getComponentFromProjectileClass,
  getComponentFromPartTypeAndCategory,
  getPartCategoryFromComponent,
  getPartDirectionDefault,
  getPartMetadataDefaultsForLayer as getConfiguredPartMetadataDefaultsForLayer,
  getPartPropertiesDefaultsByType,
  getPartPropertyDefaults,
  getPartTypeFromComponent,
  getStructureMaterialDefaults,
} from "./part-default-config.ts";
import { levelCompositeConfig, makeCompositeAiController, type CompositeModuleSpec } from "../../../arena/src/ai/composite-controller.ts";
import { MAX_CERTIFIED_AI_LEVEL } from "../../../game-core/src/ai/composite/level-modules.ts";
import {
  TEST_ARENA_BASE_HP,
  TEST_ARENA_NODE_DEFENSE,
} from "../../../game-core/src/config/ai/arena-comparison.ts";
import {
  DEFAULT_BATTLE_VERTICAL_PADDING,
  MAX_BATTLE_VIEW_SCALE,
  MIN_BATTLE_VIEW_SCALE,
  BATTLE_DISPLAY_CONFIG,
} from "../../../game-core/src/config/display/battle.ts";
import {
  EDITOR_CONFIG,
  EDITOR_GRID_MAX_COLS,
  EDITOR_GRID_MAX_ROWS,
} from "../../../game-core/src/config/editor/editor.ts";
import type { MatchAiSpec } from "../../../arena/src/match/match-types.ts";
import type {
  ComponentId,
  DisplayAttachmentTemplate,
  GameBase,
  KeyState,
  MapNode,
  MaterialId,
  MaterialStats,
  PartCategory,
  PartDirection,
  PartDefinition,
  PartType,
  ScreenMode,
  TechState,
  UnitTemplate,
  FireSoundPool,
  ProjectileClass,
  ProjectileShape,
} from "../types.ts";

export type ArenaReplaySpec = {
  seed: number;
  maxSimSeconds: number;
  nodeDefense: number;
  baseHp?: number;
  playerGas: number;
  enemyGas: number;
  spawnBurst?: number;
  spawnMaxActive?: number;
  aiPlayer: MatchAiSpec;
  aiEnemy: MatchAiSpec;
  spawnMode?: "mirrored-random" | "ai";
  spawnPlayer?: { familyId: string; params: Record<string, number | boolean> };
  spawnEnemy?: { familyId: string; params: Record<string, number | boolean> };
};

export type ArenaReplayDeciderCtx = {
  side: "player" | "enemy";
  gas: number;
  capRemaining: number;
  roster: number[];
};

export type ArenaReplayDecider = (ctx: ArenaReplayDeciderCtx) => { templateId: number | null; intervalS: number };

export type BootstrapOptions = {
  arenaReplay?: { spec: ArenaReplaySpec; deciders?: { player?: ArenaReplayDecider; enemy?: ArenaReplayDecider }; expected?: unknown };
  battleSessionOptions?: BattleSessionOptions;
};

export function bootstrap(options: BootstrapOptions = {}): void {
  const isViteDevelopment = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    throw new Error("App root not found");
  }

  const replay = options.arenaReplay ?? null;
  const replayMode = Boolean(replay);
  const replayExpected = replay?.expected ?? null;

  // Suppress browser-native mouse gestures within the app shell.
  // This keeps right-click and double-click available for game interactions.
  const suppressBrowserMouseDefaults = (event: MouseEvent): void => {
    if (!(event.target instanceof Node) || !root.contains(event.target)) {
      return;
    }
    if (event.type === "contextmenu" || event.type === "dblclick") {
      event.preventDefault();
    }
  };
  root.addEventListener("contextmenu", suppressBrowserMouseDefaults, { capture: true });
  root.addEventListener("dblclick", suppressBrowserMouseDefaults, { capture: true });

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
        <div class="brand-lockup">
          <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
          <div><div class="title">FORGE COMMAND</div><div class="brand-subtitle">Modular combat development suite</div></div>
        </div>
        <details id="debugMenu" class="developer-menu debug-menu">
          <summary><span class="status-dot"></span> Runtime Debug</summary>
          <div class="developer-menu-popover debug-menu-popover">
            <label><input id="debugResourcesChk" type="checkbox" /><span>R</span><strong>Unlimited Resources</strong><small>Ignore resource limits</small></label>
            <label><input id="debugVisualChk" type="checkbox" /><span>V</span><strong>Hitboxes + Weapon Range</strong><small>Show tactical geometry</small></label>
            <label><input id="debugTargetLineChk" type="checkbox" /><span>A</span><strong>AI Aimed Targets</strong><small>Show target lines</small></label>
            <label><input id="debugPartHpChk" type="checkbox" /><span>H</span><strong>Part HP Overlay</strong><small>Show per-part health</small></label>
            <button id="btnOpenPartDesigner" type="button"><span>P</span><strong>Part Designer</strong><small>Author components</small></button>
          </div>
        </details>
        <details id="developerMenu" class="developer-menu">
          <summary>Developer Tools</summary>
          <div class="developer-menu-popover">
            <button id="tabTestArena"><span>T</span><strong>Test Arena</strong><small>Scenario lab</small></button>
            <button id="tabCraftArena"><span>C</span><strong>Craft Arena</strong><small>Headless matchups</small></button>
            <button id="tabLeaderboard"><span>L</span><strong>Leaderboard</strong><small>AI evaluation</small></button>
            <button id="tabTemplateEditor"><span>O</span><strong>Craft Designer</strong><small>Assemble objects</small></button>
            <button id="tabPartEditor"><span>P</span><strong>Part Designer</strong><small>Author components</small></button>
            <button id="btnOpenGlobalSettings" ${isViteDevelopment ? "" : "hidden"}><span>G</span><strong>Global Settings</strong><small>YAML runtime defaults</small></button>
          </div>
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
          <div class="card nav-card">
            <div class="nav-section-label">Campaign</div>
            <div class="tabs nav-primary">
              <button id="tabBase"><span class="nav-icon">B</span><span><strong>Base</strong><small>Build & research</small></span></button>
              <button id="tabMap"><span class="nav-icon">M</span><span><strong>Map</strong><small>Territory control</small></span></button>
              <button id="tabBattle"><span class="nav-icon">C</span><span><strong>Battle</strong><small>Live command</small></span></button>
            </div>
          </div>

          <div id="leftPanelResizer" class="left-panel-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize campaign navigation and active panel"><i></i></div>

          <div id="basePanel" class="card panel"></div>
          <div id="mapPanel" class="card panel hidden"></div>
          <div id="battlePanel" class="card panel hidden"></div>
          <div id="testArenaPanel" class="card panel hidden"></div>
          <div id="craftArenaPanel" class="card panel hidden"></div>
          <div id="leaderboardPanel" class="card panel hidden"></div>
          <div id="editorPanel" class="card panel hidden"></div>
        </section>

        <section class="center-panel card">
          <div id="managementCenter" class="management-center hidden"></div>
          <div id="battleCanvasViewport" class="battle-canvas-viewport">
            <canvas id="battleCanvas" width="1" height="1"></canvas>
            <canvas id="templateEditorCanvas" class="hidden"></canvas>
            <canvas id="partEditorCanvas" class="hidden"></canvas>
            <div id="testArenaLossStats" class="test-arena-loss-stats hidden" aria-live="polite"></div>
          </div>
          <div id="craftArenaCenter" class="craft-arena-center hidden"></div>
          <div id="leaderboardCenter" class="panel hidden"></div>
          <div id="weaponHud" class="weapon-hud small"></div>
        </section>

        <section class="right-panel">
          <div class="card context-inspector-card">
            <h3 id="contextInspectorTitle">Inspector</h3>
            <div id="selectedInfo" class="small"></div>
          </div>
          <details class="card utility-drawer">
            <summary>Mission Log</summary>
            <div id="logBox" class="log"></div>
          </details>
          <details class="card utility-drawer">
            <summary>Controls</summary>
            <div class="small">
              - Click a friendly unit to control it<br />
              - Move mouse to aim selected unit<br />
              - Hold left click: fire all manually controlled weapons<br />
              - Arrow keys: pan battlefield viewport<br />
              - Right-click drag: pan viewport (battle/editor)<br />
              - Mouse wheel: zoom viewport (battle/editor, wheel up=in, down=out)<br />
              - WASD: move selected unit<br />
              - Controller left stick: move selected unit<br />
              - Controller right stick: aim; right trigger or bumper: fire<br />
              - Target-dependent weapons (such as missiles) lock near the aim direction<br />
              - Space: flip selected unit direction<br />
              - 1..9: toggle manual control for that weapon slot<br />
              - Shift+1..9: toggle auto fire for that slot<br />
              - Manual-controlled slots temporarily suppress auto fire<br />
              - Ground units move freely on X/Y<br />
              - Air units move on X/Z (same screen Y axis)
            </div>
          </details>
        </section>
      </main>
      <div id="globalModalRoot"></div>
      <div id="globalSettingsOverlay" class="global-settings-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="globalSettingsTitle">
        <section class="card global-settings-modal">
          <div class="panel-heading">
            <div><span class="eyebrow">Developer tools</span><h2 id="globalSettingsTitle">Global Settings</h2></div>
          </div>
          <p class="small">Developer YAML authoring tool. Movement and master sound apply live; other settings take effect after restarting the affected runtime.</p>
          <div id="globalSettingsTabs" class="global-settings-tabs" role="tablist" aria-label="Configuration categories"></div>
          <div id="globalSettingsContent" class="global-settings-content"></div>
          <div id="globalSettingsError" class="small global-settings-error" aria-live="polite"></div>
          <div class="row global-settings-actions">
            <button id="btnResetGlobalSettings" type="button">Reload YAML</button>
            <button id="btnCancelGlobalSettings" type="button">Cancel</button>
            <button id="btnSaveGlobalSettings" class="button-primary" type="button">Save & Apply</button>
          </div>
        </section>
      </div>
    </div>
  `;

  const appShell = getElement<HTMLDivElement>(".app-shell");
  appShell.classList.toggle("arena-replay", replayMode);

  const basePanel = getElement<HTMLDivElement>("#basePanel");
  const leftPanel = getElement<HTMLElement>(".left-panel");
  const leftPanelResizer = getElement<HTMLDivElement>("#leftPanelResizer");
  const mapPanel = getElement<HTMLDivElement>("#mapPanel");
  const battlePanel = getElement<HTMLDivElement>("#battlePanel");
  const testArenaPanel = getElement<HTMLDivElement>("#testArenaPanel");
  const craftArenaPanel = getElement<HTMLDivElement>("#craftArenaPanel");
  const craftArenaCenter = getElement<HTMLDivElement>("#craftArenaCenter");
  const leaderboardPanel = getElement<HTMLDivElement>("#leaderboardPanel");
  const leaderboardCenter = getElement<HTMLDivElement>("#leaderboardCenter");
  const managementCenter = getElement<HTMLDivElement>("#managementCenter");
  const editorPanel = getElement<HTMLDivElement>("#editorPanel");
  const globalModalRoot = getElement<HTMLDivElement>("#globalModalRoot");
  const selectedInfo = getElement<HTMLDivElement>("#selectedInfo");
  const contextInspectorTitle = getElement<HTMLHeadingElement>("#contextInspectorTitle");
  const weaponHud = getElement<HTMLDivElement>("#weaponHud");
  const logBox = getElement<HTMLDivElement>("#logBox");
  const debugResourcesChk = getElement<HTMLInputElement>("#debugResourcesChk");
  const debugVisualChk = getElement<HTMLInputElement>("#debugVisualChk");
  const debugTargetLineChk = getElement<HTMLInputElement>("#debugTargetLineChk");
  const debugPartHpChk = getElement<HTMLInputElement>("#debugPartHpChk");
  const btnOpenPartDesigner = getElement<HTMLButtonElement>("#btnOpenPartDesigner");
  const debugMenu = getElement<HTMLDetailsElement>("#debugMenu");
  const developerMenu = getElement<HTMLDetailsElement>("#developerMenu");
  const btnOpenGlobalSettings = getElement<HTMLButtonElement>("#btnOpenGlobalSettings");
  const globalSettingsOverlay = getElement<HTMLDivElement>("#globalSettingsOverlay");
  const globalSettingsTabs = getElement<HTMLDivElement>("#globalSettingsTabs");
  const globalSettingsContent = getElement<HTMLDivElement>("#globalSettingsContent");
  const globalSettingsError = getElement<HTMLDivElement>("#globalSettingsError");
  const btnResetGlobalSettings = getElement<HTMLButtonElement>("#btnResetGlobalSettings");
  const btnCancelGlobalSettings = getElement<HTMLButtonElement>("#btnCancelGlobalSettings");
  const btnSaveGlobalSettings = getElement<HTMLButtonElement>("#btnSaveGlobalSettings");
  const metaBar = getElement<HTMLDivElement>("#metaBar");
  const arenaReplayStats = getElement<HTMLDivElement>("#arenaReplayStats");
  const timeScale = getElement<HTMLInputElement>("#timeScale");
  const timeScaleLabel = getElement<HTMLSpanElement>("#timeScaleLabel");
  const canvasViewport = getElement<HTMLDivElement>("#battleCanvasViewport");
  const canvas = getElement<HTMLCanvasElement>("#battleCanvas");
  const templateEditorCanvas = getElement<HTMLCanvasElement>("#templateEditorCanvas");
  const partEditorCanvas = getElement<HTMLCanvasElement>("#partEditorCanvas");
  const testArenaLossStats = getElement<HTMLDivElement>("#testArenaLossStats");

  debugMenu.addEventListener("toggle", () => {
    if (debugMenu.open) developerMenu.open = false;
  });
  developerMenu.addEventListener("toggle", () => {
    if (developerMenu.open) debugMenu.open = false;
  });

  const SIDEBAR_SPLIT_STORAGE_KEY = "forge-command.sidebar-nav-height";
  const TEST_ARENA_SETTINGS_STORAGE_KEY = "forge-command.test-arena-settings.v1";
  interface GlobalSettingsValues {
    movementSpeedMultiplier: number;
    battleSoundVolume: number;
  }
  type ConfigTree = Record<string, Record<string, unknown>>;
  type ConfigDescriptionTree = Record<string, Record<string, Record<string, string>>>;
  let globalSettingsConfig: ConfigTree | null = null;
  let globalSettingsDescriptions: ConfigDescriptionTree | null = null;
  let globalSettingsCategory = "balance";
  let activeGlobalSettingsPreview: { audio: HTMLAudioElement; button: HTMLButtonElement } | null = null;
  const fetchGlobalSettingsFromYaml = async (): Promise<GlobalSettingsValues> => {
    const response = await fetch("/__config/global-settings");
    if (!response.ok) throw new Error(`Global settings request failed (${response.status}).`);
    const payload = await response.json() as { ok?: boolean; settings?: Partial<GlobalSettingsValues> };
    const movementSpeedMultiplier = payload.settings?.movementSpeedMultiplier;
    const battleSoundVolume = payload.settings?.battleSoundVolume;
    if (!payload.ok || typeof movementSpeedMultiplier !== "number" || typeof battleSoundVolume !== "number") {
      throw new Error("Global settings response was invalid.");
    }
    return { movementSpeedMultiplier, battleSoundVolume };
  };
  let globalMovementSpeedMultiplier: number = DEFAULT_UNIT_MOVEMENT_SPEED_MULTIPLIER;
  let globalBattleSoundVolume: number = DEFAULT_BATTLE_SOUND_VOLUME;
  const setSidebarNavHeight = (height: number): number => {
    const maxHeight = Math.max(150, leftPanel.clientHeight - 180);
    const normalized = Math.max(128, Math.min(maxHeight, Math.round(height)));
    leftPanel.style.setProperty("--sidebar-nav-height", `${normalized}px`);
    return normalized;
  };
  const storedSidebarHeight = Number.parseInt(localStorage.getItem(SIDEBAR_SPLIT_STORAGE_KEY) ?? "202", 10);
  setSidebarNavHeight(Number.isFinite(storedSidebarHeight) ? storedSidebarHeight : 202);
  let sidebarResizePointerId: number | null = null;
  leftPanelResizer.addEventListener("pointerdown", (event) => {
    sidebarResizePointerId = event.pointerId;
    leftPanelResizer.setPointerCapture(event.pointerId);
    leftPanel.classList.add("resizing");
    event.preventDefault();
  });
  leftPanelResizer.addEventListener("pointermove", (event) => {
    if (sidebarResizePointerId !== event.pointerId) return;
    const top = leftPanel.getBoundingClientRect().top;
    setSidebarNavHeight(event.clientY - top);
  });
  const finishSidebarResize = (event: PointerEvent): void => {
    if (sidebarResizePointerId !== event.pointerId) return;
    sidebarResizePointerId = null;
    leftPanel.classList.remove("resizing");
    const height = Number.parseInt(getComputedStyle(leftPanel).getPropertyValue("--sidebar-nav-height"), 10);
    if (Number.isFinite(height)) localStorage.setItem(SIDEBAR_SPLIT_STORAGE_KEY, `${height}`);
  };
  leftPanelResizer.addEventListener("pointerup", finishSidebarResize);
  leftPanelResizer.addEventListener("pointercancel", finishSidebarResize);
  leftPanelResizer.addEventListener("dblclick", () => {
    const height = setSidebarNavHeight(202);
    localStorage.setItem(SIDEBAR_SPLIT_STORAGE_KEY, `${height}`);
  });

  // Simulation dimensions live on a non-presented logical surface. Phaser's
  // visible canvas is viewport-sized and never inherits battlefield dimensions.
  const simulationCanvas = document.createElement("canvas");
  simulationCanvas.width = 1;
  simulationCanvas.height = 1;
  const initialViewportWidth = Math.max(1, Math.floor(canvasViewport.clientWidth));
  const initialViewportHeight = Math.max(1, Math.floor(canvasViewport.clientHeight));
  canvas.width = initialViewportWidth;
  canvas.height = initialViewportHeight;
  canvas.style.width = `${initialViewportWidth}px`;
  canvas.style.height = `${initialViewportHeight}px`;

  const syncEditorCanvasSizes = (): void => {
    const width = Math.max(1, Math.floor(canvasViewport.clientWidth));
    const height = Math.max(1, Math.floor(canvasViewport.clientHeight));
    if (templateEditorCanvas.width !== width || templateEditorCanvas.height !== height) {
      templateEditorCanvas.width = width;
      templateEditorCanvas.height = height;
    }
    if (partEditorCanvas.width !== width || partEditorCanvas.height !== height) {
      partEditorCanvas.width = width;
      partEditorCanvas.height = height;
    }
  };
  const activeEditorCanvas = (): HTMLCanvasElement => (isPartEditorScreen() ? partEditorCanvas : templateEditorCanvas);

  if (replayMode) {
    debugMenu.style.display = "none";
    metaBar.style.display = "none";
  }

  const tabs = {
    base: getElement<HTMLButtonElement>("#tabBase"),
    map: getElement<HTMLButtonElement>("#tabMap"),
    battle: getElement<HTMLButtonElement>("#tabBattle"),
    testArena: getElement<HTMLButtonElement>("#tabTestArena"),
    craftArena: getElement<HTMLButtonElement>("#tabCraftArena"),
    leaderboard: getElement<HTMLButtonElement>("#tabLeaderboard"),
    templateEditor: getElement<HTMLButtonElement>("#tabTemplateEditor"),
    partEditor: getElement<HTMLButtonElement>("#tabPartEditor"),
  };

  const templates: UnitTemplate[] = createInitialTemplates();
  const getDeployableTemplates = (): UnitTemplate[] => templates.filter(isDeployableTemplate);
  const parts: PartDefinition[] = [];
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
  const campaign = new RealTimeCampaign();
  let screen: ScreenMode = "base";
  let selectedBaseBuildSlotId: BaseBuildingSlot["id"] | null = null;
  const testArenaNode: MapNode = {
    id: "test-arena",
    name: "Test Arena",
    owner: "enemy",
    garrison: false,
    reward: 0,
    defense: TEST_ARENA_NODE_DEFENSE,
    testEnemyMinActive: 4,
    testEnemyInfiniteGas: true,
    testBaseHpOverride: TEST_ARENA_BASE_HP,
  };
  let testArenaEnemyCount = 4;
  let testArenaPlayerCount = 4;
  let testArenaBaseHp = TEST_ARENA_BASE_HP;
  let testArenaBattlefieldWidth = BATTLEFIELD_WIDTH;
  let testArenaBattlefieldHeight = BATTLEFIELD_HEIGHT;
  let testArenaGroundHeight = Math.floor(BATTLEFIELD_HEIGHT * DEFAULT_GROUND_HEIGHT_RATIO);
  let testArenaBattlefieldUsesGlobalDefaults = true;
  let testArenaEnemySpawnTemplateIds: number[] = getDeployableTemplates().map((template) => template.id);
  let testArenaPlayerSpawnTemplateIds: number[] = getDeployableTemplates().map((template) => template.id);
  let testArenaSpawnTemplateDropdownOpen = false;
  let testArenaAutoSpawnOnEnemySide = true;
  let testArenaAutoSpawnOnPlayerSide = true;
  let battleDeploySide: "player" | "enemy" = "player";
  let testArenaInvinciblePlayer = false;
  type TestArenaAiPreset =
    | "baseline"
    | "composite-baseline"
    | "composite-decision-default"
    | "component-config";
  type TestArenaAiModuleKind = "target" | "movement" | "shoot";
  type TestArenaSide = "player" | "enemy";
  type TestArenaPanelSection = "unit" | "manual" | "ai" | "ui";
  type TestArenaAiOption = {
    id: string;
    label: string;
    spec?: CompositeModuleSpec;
    compatible?: boolean;
    reason?: string;
  };
  type TestArenaAiSelectionGrid = Record<TestArenaSide, Record<TestArenaAiModuleKind, string>>;
  type TestArenaCompositeModelOption = {
    id: string;
    label: string;
    spec?: MatchAiSpec;
    score?: number;
    rounds?: number;
    games?: number;
    compatible?: boolean;
    reason?: string;
  };
  type TestArenaLeaderboardEntry = {
    runId: string;
    score?: number;
    rounds?: number;
    games?: number;
    losses?: number;
    ties?: number;
    isUnranked?: boolean;
    winRate?: number;
    leaderboardScore?: number;
    destroyedUnits?: number;
    lostUnits?: number;
    averageRatio?: number;
    previousLevelWinRate?: number;
    previousLevelRounds?: number;
    previousLevelCertified?: boolean;
    wins?: number;
    spec?: MatchAiSpec;
    mtimeMs: number;
  };
  const createLevelSpec = (level: number): MatchAiSpec => ({
    familyId: "composite",
    params: {},
    composite: levelCompositeConfig(level),
  });
  let testArenaPlayerAiPreset: TestArenaAiPreset = "component-config";
  let testArenaEnemyAiPreset: TestArenaAiPreset = "component-config";
  let latestCompositeSpec: MatchAiSpec | null = null;
  let testArenaCompositeModelOptions: TestArenaCompositeModelOption[] = [
    { id: "custom-components", label: "Custom components (target/movement/shoot)" },
    ...Array.from({ length: MAX_CERTIFIED_AI_LEVEL }, (_, index) => {
      const level = index + 1;
      return {
        id: `builtin-level-${level}-composite`,
        label: `builtin: L${level}`,
        spec: createLevelSpec(level),
      };
    }),
  ];
  let testArenaCompositeModelSelections: Record<TestArenaSide, string> = {
    player: "custom-components",
    enemy: "custom-components",
  };
  const defaultAiOptions: Record<TestArenaAiModuleKind, TestArenaAiOption[]> = {
    target: [
      { id: "baseline-target", label: "builtin: baseline-target", spec: { familyId: "baseline-target", params: {} } },
      { id: "skill-low-target", label: "builtin: low target", spec: { familyId: "skill-low-target", params: {} } },
      { id: "skill-medium-target", label: "builtin: medium target", spec: { familyId: "skill-medium-target", params: {} } },
      { id: "skill-high-target", label: "builtin: high target", spec: { familyId: "skill-high-target", params: {} } },
      { id: "dt-target-default", label: "builtin: dt-target (default)", spec: { familyId: "dt-target", params: {} } },
    ],
    movement: [
      { id: "baseline-movement", label: "builtin: baseline-movement", spec: { familyId: "baseline-movement", params: {} } },
      { id: "skill-low-movement", label: "builtin: low movement", spec: { familyId: "skill-low-movement", params: {} } },
      { id: "skill-medium-movement", label: "builtin: medium movement", spec: { familyId: "skill-medium-movement", params: {} } },
      { id: "skill-high-movement", label: "builtin: high movement", spec: { familyId: "skill-high-movement", params: {} } },
      { id: "dt-movement-default", label: "builtin: dt-movement (default)", spec: { familyId: "dt-movement", params: {} } },
    ],
    shoot: [
      { id: "baseline-shoot", label: "builtin: baseline-shoot", spec: { familyId: "baseline-shoot", params: {} } },
      { id: "skill-low-shoot", label: "builtin: low shoot", spec: { familyId: "skill-low-shoot", params: {} } },
      { id: "skill-medium-shoot", label: "builtin: medium shoot", spec: { familyId: "skill-medium-shoot", params: {} } },
      { id: "skill-high-shoot", label: "builtin: high shoot", spec: { familyId: "skill-high-shoot", params: {} } },
      { id: "history-shoot", label: "builtin: history-shoot", spec: { familyId: "history-shoot", params: {} } },
      { id: "dt-shoot-default", label: "builtin: dt-shoot (default)", spec: { familyId: "dt-shoot", params: {} } },
      { id: "dt-shoot-atan-default", label: "builtin: dt-shoot-atan (default)", spec: { familyId: "dt-shoot-atan", params: {} } },
    ],
  };
  let testArenaAiOptions: Record<TestArenaAiModuleKind, TestArenaAiOption[]> = {
    target: [...defaultAiOptions.target],
    movement: [...defaultAiOptions.movement],
    shoot: [...defaultAiOptions.shoot],
  };
  let testArenaAiSelections: TestArenaAiSelectionGrid = {
    player: {
      target: "baseline-target",
      movement: "baseline-movement",
      shoot: "baseline-shoot",
    },
    enemy: {
      target: "baseline-target",
      movement: "baseline-movement",
      shoot: "baseline-shoot",
    },
  };
  let testArenaResolvedCompositeModules: Record<TestArenaSide, MatchAiSpec["composite"] | null> = {
    player: {
      target: { familyId: "baseline-target", params: {} },
      movement: { familyId: "baseline-movement", params: {} },
      shoot: { familyId: "baseline-shoot", params: {} },
    },
    enemy: {
      target: { familyId: "baseline-target", params: {} },
      movement: { familyId: "baseline-movement", params: {} },
      shoot: { familyId: "baseline-shoot", params: {} },
    },
  };
  let testArenaLeaderboardLoading = false;
  let testArenaLeaderboardEntries: TestArenaLeaderboardEntry[] = [];
  let testArenaLeaderboardCompeteMode: "random-pair" | "unranked-vs-random" | "manual-pair" | "manual-vs-random" = "random-pair";
  let testArenaLeaderboardCompeteRuns = 100;
  let testArenaLeaderboardCompeteBusy = false;
  let testArenaLeaderboardCompeteStatus = "";
  type LeaderboardCompeteMatchProgress = {
    index: number;
    runA: string;
    runB: string;
    status: "queued" | "running" | "completed" | "failed";
    startedAtMs?: number;
    finishedAtMs?: number;
    simSecondsElapsed: number;
    maxSimSeconds: number;
    units: number;
    projectiles: number;
    error?: string;
  };
  let testArenaLeaderboardCompeteProgress: LeaderboardCompeteMatchProgress[] = [];
  let testArenaLeaderboardManualPairA = "";
  let testArenaLeaderboardManualPairB = "";
  let testArenaLeaderboardManualVsRandom = "";
  let testArenaPanelSections: Record<TestArenaPanelSection, boolean> = {
    unit: true,
    manual: false,
    ai: false,
    ui: false,
  };
  let testArenaManualSpawnSide: TestArenaSide = "player";
  let testArenaManualSpawnTemplateId = getDeployableTemplates()[0]?.id ?? 0;
  let testArenaHasStoredPlayerCraftSelection = false;
  let testArenaHasStoredEnemyCraftSelection = false;
  let testArenaTemplateStoreReady = false;
  type CraftArenaSideResult = {
    destroyed: number;
    gasWasted: number;
  };
  type CraftArenaResult = {
    durationMinutes: number;
    simSecondsElapsed: number;
    parallelWorkers: number;
    parallelMode: string;
    craftA: CraftArenaSideResult;
    craftB: CraftArenaSideResult;
    completedAt: string;
  };
  type CraftArenaSettings = {
    quantity: number;
    durationMinutes: number;
    aiModelId: string;
    battlefieldWidth: number;
    battlefieldHeight: number;
    groundHeight: number;
  };
  type CraftArenaScenario = {
    id: string;
    name: string;
    craftAId: number;
    craftBId: number;
    result?: CraftArenaResult;
    error?: string;
    busy?: boolean;
  };
  let craftArenaSettings: CraftArenaSettings = {
    quantity: 6,
    durationMinutes: 4,
    aiModelId: `builtin-level-${MAX_CERTIFIED_AI_LEVEL}-composite`,
    battlefieldWidth: BATTLEFIELD_WIDTH,
    battlefieldHeight: BATTLEFIELD_HEIGHT,
    groundHeight: Math.floor(BATTLEFIELD_HEIGHT * DEFAULT_GROUND_HEIGHT_RATIO),
  };
  let craftArenaScenarios: CraftArenaScenario[] = [];
  let craftArenaMetric: "destroyed" | "gasWasted" = "destroyed";
  let craftArenaSelectedScenarioId: string | null = null;
  const craftArenaPairKey = (craftAId: number, craftBId: number): string => (
    craftAId < craftBId ? `${craftAId}:${craftBId}` : `${craftBId}:${craftAId}`
  );
  const ensureCraftArenaPairScenarios = (): void => {
    craftArenaScenarios = craftArenaScenarios.filter((scenario) => {
      const craftA = templates.find((template) => template.id === scenario.craftAId);
      const craftB = templates.find((template) => template.id === scenario.craftBId);
      return Boolean(craftA && craftB && isDeployableTemplate(craftA) && isDeployableTemplate(craftB));
    });
    const existingPairs = new Set(craftArenaScenarios.map((scenario) => craftArenaPairKey(scenario.craftAId, scenario.craftBId)));
    const deployableTemplates = getDeployableTemplates();
    for (let indexA = 0; indexA < deployableTemplates.length; indexA += 1) {
      const craftA = deployableTemplates[indexA];
      if (!craftA) continue;
      for (let indexB = indexA + 1; indexB < deployableTemplates.length; indexB += 1) {
        const craftB = deployableTemplates[indexB];
        if (!craftB) continue;
        const pairKey = craftArenaPairKey(craftA.id, craftB.id);
        if (existingPairs.has(pairKey)) continue;
        craftArenaScenarios.push({
          id: `craft-pair-${craftA.id}-${craftB.id}`,
          name: `${craftA.name} vs ${craftB.name}`,
          craftAId: craftA.id,
          craftBId: craftB.id,
        });
        existingPairs.add(pairKey);
      }
    }
  };
  const parseCraftArenaScenario = (value: unknown): CraftArenaScenario | null => {
    if (!value || typeof value !== "object") return null;
    const scenario = value as Partial<CraftArenaScenario>;
    if (
      typeof scenario.id !== "string"
      || typeof scenario.craftAId !== "number"
      || !Number.isInteger(scenario.craftAId)
      || typeof scenario.craftBId !== "number"
      || !Number.isInteger(scenario.craftBId)
    ) return null;
    return {
      id: scenario.id,
      name: typeof scenario.name === "string" ? scenario.name : "Craft matchup",
      craftAId: scenario.craftAId,
      craftBId: scenario.craftBId,
      ...(scenario.result && typeof scenario.result === "object" && "durationMinutes" in scenario.result ? { result: scenario.result } : {}),
      ...(typeof scenario.error === "string" ? { error: scenario.error } : {}),
    };
  };
  const loadCraftArenaScenarios = (): void => {
    try {
      const parsed = JSON.parse(localStorage.getItem("forge-command.craft-arena-scenarios.v4") ?? "null") as {
        version?: unknown;
        settings?: Partial<CraftArenaSettings>;
        scenarios?: unknown;
      } | null;
      if (parsed?.version !== 4 || !Array.isArray(parsed.scenarios)) {
        const previous = JSON.parse(localStorage.getItem("forge-command.craft-arena-scenarios.v3") ?? "null") as {
          settings?: { durationMinutes?: unknown; aiModelId?: unknown; battlefieldWidth?: unknown; battlefieldHeight?: unknown; groundHeight?: unknown };
          scenarios?: unknown[];
        } | null;
        if (Array.isArray(previous?.scenarios)) {
          const firstScenario = previous.scenarios[0] as { craftACount?: unknown; craftBCount?: unknown } | undefined;
          const migratedQuantity = typeof firstScenario?.craftACount === "number"
            ? firstScenario.craftACount
            : typeof firstScenario?.craftBCount === "number"
              ? firstScenario.craftBCount
              : craftArenaSettings.quantity;
          craftArenaScenarios = previous.scenarios.flatMap((value): CraftArenaScenario[] => {
            const scenario = parseCraftArenaScenario(value);
            return scenario ? [scenario] : [];
          });
          craftArenaSettings = {
            ...craftArenaSettings,
            quantity: Math.max(1, Math.min(40, Math.floor(migratedQuantity))),
            durationMinutes: typeof previous.settings?.durationMinutes === "number" ? previous.settings.durationMinutes : craftArenaSettings.durationMinutes,
            aiModelId: typeof previous.settings?.aiModelId === "string" ? previous.settings.aiModelId : craftArenaSettings.aiModelId,
            battlefieldWidth: typeof previous.settings?.battlefieldWidth === "number" ? previous.settings.battlefieldWidth : craftArenaSettings.battlefieldWidth,
            battlefieldHeight: typeof previous.settings?.battlefieldHeight === "number" ? previous.settings.battlefieldHeight : craftArenaSettings.battlefieldHeight,
            groundHeight: typeof previous.settings?.groundHeight === "number" ? previous.settings.groundHeight : craftArenaSettings.groundHeight,
          };
        }
        return;
      }
      const storedSettings = parsed.settings;
      if (storedSettings && typeof storedSettings === "object") {
        craftArenaSettings = {
          quantity: typeof storedSettings.quantity === "number" ? Math.max(1, Math.min(40, Math.floor(storedSettings.quantity))) : craftArenaSettings.quantity,
          durationMinutes: typeof storedSettings.durationMinutes === "number" ? Math.max(1, Math.min(60, Math.floor(storedSettings.durationMinutes))) : craftArenaSettings.durationMinutes,
          aiModelId: typeof storedSettings.aiModelId === "string" ? storedSettings.aiModelId : craftArenaSettings.aiModelId,
          battlefieldWidth: typeof storedSettings.battlefieldWidth === "number" ? Math.max(640, Math.floor(storedSettings.battlefieldWidth)) : craftArenaSettings.battlefieldWidth,
          battlefieldHeight: typeof storedSettings.battlefieldHeight === "number" ? Math.max(360, Math.floor(storedSettings.battlefieldHeight)) : craftArenaSettings.battlefieldHeight,
          groundHeight: typeof storedSettings.groundHeight === "number" ? Math.max(80, Math.floor(storedSettings.groundHeight)) : craftArenaSettings.groundHeight,
        };
      }
      craftArenaScenarios = parsed.scenarios.flatMap((value): CraftArenaScenario[] => {
        const scenario = parseCraftArenaScenario(value);
        return scenario ? [scenario] : [];
      });
    } catch {
      // Retain an empty scenario list when local storage is malformed or unavailable.
    }
  };
  const saveCraftArenaScenarios = (): void => {
    try {
      localStorage.setItem("forge-command.craft-arena-scenarios.v4", JSON.stringify({
        version: 4,
        settings: craftArenaSettings,
        scenarios: craftArenaScenarios.map(({ busy: _busy, ...scenario }) => scenario),
      }));
    } catch {
      // Scenarios remain usable for the current session when storage is unavailable.
    }
  };
  const importCraftArenaSeed = async (): Promise<boolean> => {
    try {
      const response = await fetch("/__arena/craft-arena/seed", { method: "GET" });
      if (!response.ok) return false;
      const payload = await response.json().catch(() => null) as {
        found?: boolean;
        revision?: unknown;
        settings?: Partial<CraftArenaSettings>;
        scenarios?: unknown;
      } | null;
      if (!payload?.found || typeof payload.revision !== "string" || !Array.isArray(payload.scenarios)) return false;
      const markerKey = "forge-command.craft-arena-imported-seeds.v1";
      const imported = JSON.parse(localStorage.getItem(markerKey) ?? "[]") as unknown;
      const revisions = Array.isArray(imported) ? imported.filter((value): value is string => typeof value === "string") : [];
      if (revisions.includes(payload.revision)) return false;
      const seeded = payload.scenarios.flatMap((value): CraftArenaScenario[] => {
        const scenario = parseCraftArenaScenario(value);
        return scenario ? [scenario] : [];
      });
      if (seeded.length <= 0) return false;
      if (payload.settings && typeof payload.settings === "object") {
        const settings = payload.settings;
        const height = typeof settings.battlefieldHeight === "number"
          ? Math.max(360, Math.floor(settings.battlefieldHeight))
          : craftArenaSettings.battlefieldHeight;
        craftArenaSettings = {
          quantity: typeof settings.quantity === "number" ? Math.max(1, Math.min(40, Math.floor(settings.quantity))) : craftArenaSettings.quantity,
          durationMinutes: typeof settings.durationMinutes === "number" ? Math.max(1, Math.min(60, Math.floor(settings.durationMinutes))) : craftArenaSettings.durationMinutes,
          aiModelId: typeof settings.aiModelId === "string" ? settings.aiModelId : craftArenaSettings.aiModelId,
          battlefieldWidth: typeof settings.battlefieldWidth === "number" ? Math.max(640, Math.floor(settings.battlefieldWidth)) : craftArenaSettings.battlefieldWidth,
          battlefieldHeight: height,
          groundHeight: typeof settings.groundHeight === "number"
            ? Math.max(80, Math.min(height - 40, Math.floor(settings.groundHeight)))
            : craftArenaSettings.groundHeight,
        };
      }
      const seedIds = new Set(seeded.map((scenario) => scenario.id));
      const seedPairs = new Set(seeded.map((scenario) => craftArenaPairKey(scenario.craftAId, scenario.craftBId)));
      craftArenaScenarios = [
        ...craftArenaScenarios.filter((scenario) => (
          !seedIds.has(scenario.id)
          && !seedPairs.has(craftArenaPairKey(scenario.craftAId, scenario.craftBId))
        )),
        ...seeded,
      ];
      ensureCraftArenaPairScenarios();
      saveCraftArenaScenarios();
      localStorage.setItem(markerKey, JSON.stringify([...revisions, payload.revision]));
      return true;
    } catch {
      return false;
    }
  };
  loadCraftArenaScenarios();
  ensureCraftArenaPairScenarios();

  interface StoredTestArenaSettings {
    playerCount?: unknown;
    enemyCount?: unknown;
    baseHp?: unknown;
    battlefieldWidth?: unknown;
    battlefieldHeight?: unknown;
    groundHeight?: unknown;
    battlefieldUsesGlobalDefaults?: unknown;
    playerSpawnTemplateIds?: unknown;
    enemySpawnTemplateIds?: unknown;
    autoSpawnOnPlayerSide?: unknown;
    autoSpawnOnEnemySide?: unknown;
    invinciblePlayer?: unknown;
    compositeModelSelections?: unknown;
    aiSelections?: unknown;
    manualSpawnSide?: unknown;
    manualSpawnTemplateId?: unknown;
  }

  const loadTestArenaSettings = (): void => {
    try {
      const stored = JSON.parse(localStorage.getItem(TEST_ARENA_SETTINGS_STORAGE_KEY) ?? "null") as StoredTestArenaSettings | null;
      if (!stored || typeof stored !== "object") return;
      const readFinite = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
      testArenaPlayerCount = Math.max(0, Math.min(40, Math.floor(readFinite(stored.playerCount, testArenaPlayerCount))));
      testArenaEnemyCount = Math.max(0, Math.min(40, Math.floor(readFinite(stored.enemyCount, testArenaEnemyCount))));
      testArenaBaseHp = Math.max(1, Math.min(1_000_000_000, Math.floor(readFinite(stored.baseHp, testArenaBaseHp))));
      const hasStoredBattlefieldSize = typeof stored.battlefieldWidth === "number"
        || typeof stored.battlefieldHeight === "number"
        || typeof stored.groundHeight === "number";
      const isLegacyCanonicalDefault = stored.battlefieldWidth === 2000
        && stored.battlefieldHeight === 1000
        && stored.groundHeight === 400;
      testArenaBattlefieldUsesGlobalDefaults = stored.battlefieldUsesGlobalDefaults === true
        || (stored.battlefieldUsesGlobalDefaults !== false && (!hasStoredBattlefieldSize || isLegacyCanonicalDefault));
      if (!testArenaBattlefieldUsesGlobalDefaults) {
        testArenaBattlefieldWidth = normalizeTestArenaBattlefieldWidth(readFinite(stored.battlefieldWidth, testArenaBattlefieldWidth));
        testArenaBattlefieldHeight = normalizeTestArenaBattlefieldHeight(readFinite(stored.battlefieldHeight, testArenaBattlefieldHeight));
        testArenaGroundHeight = normalizeTestArenaGroundHeight(readFinite(stored.groundHeight, testArenaGroundHeight));
      }
      if (Array.isArray(stored.playerSpawnTemplateIds)) {
        testArenaPlayerSpawnTemplateIds = stored.playerSpawnTemplateIds.filter((id): id is number => Number.isInteger(id) && id > 0);
        testArenaHasStoredPlayerCraftSelection = true;
      }
      if (Array.isArray(stored.enemySpawnTemplateIds)) {
        testArenaEnemySpawnTemplateIds = stored.enemySpawnTemplateIds.filter((id): id is number => Number.isInteger(id) && id > 0);
        testArenaHasStoredEnemyCraftSelection = true;
      }
      if (typeof stored.autoSpawnOnPlayerSide === "boolean") testArenaAutoSpawnOnPlayerSide = stored.autoSpawnOnPlayerSide;
      if (typeof stored.autoSpawnOnEnemySide === "boolean") testArenaAutoSpawnOnEnemySide = stored.autoSpawnOnEnemySide;
      if (typeof stored.invinciblePlayer === "boolean") testArenaInvinciblePlayer = stored.invinciblePlayer;
      const compositeSelections = stored.compositeModelSelections as Partial<Record<TestArenaSide, unknown>> | null;
      if (typeof compositeSelections?.player === "string") testArenaCompositeModelSelections.player = compositeSelections.player;
      if (typeof compositeSelections?.enemy === "string") testArenaCompositeModelSelections.enemy = compositeSelections.enemy;
      const aiSelections = stored.aiSelections as Partial<Record<TestArenaSide, Partial<Record<TestArenaAiModuleKind, unknown>>>> | null;
      for (const side of ["player", "enemy"] as const) {
        for (const kind of ["target", "movement", "shoot"] as const) {
          const selection = aiSelections?.[side]?.[kind];
          if (typeof selection === "string") testArenaAiSelections[side][kind] = selection;
        }
      }
      if (stored.manualSpawnSide === "player" || stored.manualSpawnSide === "enemy") testArenaManualSpawnSide = stored.manualSpawnSide;
      if (typeof stored.manualSpawnTemplateId === "number" && Number.isInteger(stored.manualSpawnTemplateId) && stored.manualSpawnTemplateId > 0) {
        testArenaManualSpawnTemplateId = stored.manualSpawnTemplateId;
      }
      testArenaNode.testEnemyMinActive = testArenaEnemyCount;
      testArenaNode.testBaseHpOverride = testArenaBaseHp;
    } catch {
      // Ignore malformed/blocked storage and retain Test Arena defaults.
    }
  };

  const saveTestArenaSettings = (): void => {
    try {
      localStorage.setItem(TEST_ARENA_SETTINGS_STORAGE_KEY, JSON.stringify({
        playerCount: testArenaPlayerCount,
        enemyCount: testArenaEnemyCount,
        baseHp: testArenaBaseHp,
        battlefieldWidth: testArenaBattlefieldWidth,
        battlefieldHeight: testArenaBattlefieldHeight,
        groundHeight: testArenaGroundHeight,
        battlefieldUsesGlobalDefaults: testArenaBattlefieldUsesGlobalDefaults,
        playerSpawnTemplateIds: testArenaPlayerSpawnTemplateIds,
        enemySpawnTemplateIds: testArenaEnemySpawnTemplateIds,
        autoSpawnOnPlayerSide: testArenaAutoSpawnOnPlayerSide,
        autoSpawnOnEnemySide: testArenaAutoSpawnOnEnemySide,
        invinciblePlayer: testArenaInvinciblePlayer,
        compositeModelSelections: testArenaCompositeModelSelections,
        aiSelections: testArenaAiSelections,
        manualSpawnSide: testArenaManualSpawnSide,
        manualSpawnTemplateId: testArenaManualSpawnTemplateId,
      }));
    } catch {
      // Storage can be unavailable in restricted browser contexts; settings still apply for this session.
    }
  };
  const isTemplateEditorScreen = (): boolean => screen === "templateEditor";
  const isPartEditorScreen = (): boolean => screen === "partEditor";
  const isEditorScreen = (): boolean => isTemplateEditorScreen() || isPartEditorScreen();
  const isBattleScreen = (): boolean => screen === "battle" || screen === "testArena";
  let running = true;
  let gas = replay?.spec.playerGas ?? 250;
  let commanderSkill = 1;
  let pendingOccupation: string | null = null;
  let debugUnlimitedResources = replayMode ? false : true;
  let debugVisual = replayMode ? false : true;
  let debugTargetLines = replayMode ? false : true;
  const debugDisplayLayer = true;
  let debugPartHpOverlay = false;
  let debugServerEnabled = false;
  const EDITOR_GRID_MAX_SIZE = EDITOR_GRID_MAX_COLS * EDITOR_GRID_MAX_ROWS;
  const EDITOR_DISPLAY_KINDS = [...EDITOR_CONFIG.displayKinds] as DisplayAttachmentTemplate["kind"][];
  type EditorFunctionalSlot = {
    component: ComponentId;
    partId?: number;
    rotateQuarter: 0 | 1 | 2 | 3;
    groupId: number;
    isAnchor: boolean;
  } | null;
  type PartDesignerTool =
    | "select"
    | "paintFunctional"
    | "paintStructure"
    | "paintDamage"
    | "erase"
    | "setAnchor"
    | "markSupport"
    | "markEmptyStructure"
    | "markEmptyFunctional";
  type PartOpenFilter = "all" | "structure" | "control" | "engine" | "weapon" | "loader";
  const CANONICAL_PART_CATEGORIES: Record<PartType, readonly string[]> = {
    structure: ["light steel", "normal steel", "heavy steel"],
    control: ["small control unit", "medium control unit", "large control unit"],
    engine: ["light tank engine", "heavy tank engine", "light aircraft engine", "heavy aircraft engine"],
    // "cannons" is the preset backing the single cannon category. The
    // anti-tank part shares that category through properties.subcategory.
    weapon: ["firearm", "cannons", "laser"],
    loader: ["cannons reloader", "anti-tank gun reloader"],
  };
  const FIRE_SOUND_POOL_OPTIONS: readonly { value: FireSoundPool; label: string }[] = [
    { value: "rapid-fire", label: "Rapid fire" },
    { value: "heavy-shot", label: "Heavy shot" },
    { value: "explosive", label: "Explosive cannon" },
    { value: "tracking", label: "Tracking missile" },
    { value: "beam-precision", label: "Precision beam" },
  ];
  const PROJECTILE_SHAPES: Readonly<Record<ProjectileClass, readonly { value: ProjectileShape; label: string }[]>> = {
    bullet: [
      { value: "bullet-round", label: "Round" },
      { value: "bullet-slug", label: "Slug" },
      { value: "bullet-tracer", label: "Tracer" },
    ],
    missile: [
      { value: "missile-missile", label: "Missile" },
      { value: "missile-heavy-rocket", label: "Heavy rocket" },
      { value: "missile-energy-orb", label: "Energy orb" },
    ],
    laser: [
      { value: "laser-thin", label: "Thin" },
      { value: "laser-pulse", label: "Pulse" },
      { value: "laser-wide", label: "Wide" },
    ],
  };
  type EditorScreenMode = "templateEditor" | "partEditor";
  type PartDesignerSlot = {
    occupiesFunctionalSpace: boolean;
    occupiesStructureSpace: boolean;
    needsStructureBehind: boolean;
    takesDamage: boolean;
    isAttachPoint: boolean;
    isShootingPoint: boolean;
  } | null;
  let editorLayer: "structure" | "functional" | "display" = "structure";
  let editorDeleteMode = false;
  let editorSelection: string | number = "";
  let editorPlaceByCenter = true;
  let editorGridCols = 10;
  let editorGridRows = 10;
  let editorWeaponRotateQuarter: 0 | 1 | 2 | 3 = 0;
  let editorFunctionalGroupSeq = 1;
  let templateEditorGridPanX = 0;
  let templateEditorGridPanY = 0;
  let templateEditorViewScale = 1;
  let partEditorGridPanX = 0;
  let partEditorGridPanY = 0;
  let partEditorViewScale = 1;
  let templateEditorViewVisited = false;
  let partEditorViewVisited = false;
  let editorGridPanX = 0;
  let editorGridPanY = 0;
  let editorViewScale = 1;
  let editorDragActive = false;
  let editorDragMoved = false;
  let editorDragStartClientX = 0;
  let editorDragStartClientY = 0;
  let editorDragLastClientX = 0;
  let editorDragLastClientY = 0;
  let editorRightClickDeletePending = false;
  let editorRightClickDeleteMouseX = 0;
  let editorRightClickDeleteMouseY = 0;
  let editorHoverMouseX = 0;
  let editorHoverMouseY = 0;
  let editorHoverActive = false;
  let editorStructureColor = MATERIALS.basic.color;
  let battleViewOffsetX = 0;
  let battleViewOffsetY = 0;
  let battleViewScale = 1;
  let phaserBattleRenderer: PhaserBattleRenderer | null = null;
  let battleViewDragActive = false;
  let battleViewDragMoved = false;
  let battleViewDragStartClientX = 0;
  let battleViewDragStartClientY = 0;
  let battleViewDragLastClientX = 0;
  let battleViewDragLastClientY = 0;
  let battleViewFollowSelection = true;
  let editorStructureSlots: Array<number | null> = new Array<number | null>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorStructureColorSlots: Array<string | null> = new Array<string | null>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorFunctionalSlots: EditorFunctionalSlot[] = new Array<EditorFunctionalSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorDisplaySlots: Array<DisplayAttachmentTemplate["kind"] | null> = new Array<DisplayAttachmentTemplate["kind"] | null>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorTemplateDialogOpen = false;
  let editorTemplateDialogSelectedId: number | null = null;
  let partDesignerDialogOpen = false;
  let partDesignerSelectedId: number | null = null;
  let partDesignerOpenedPartId: number | null = null;
  let partDesignerOpenFilter: PartOpenFilter = "all";
  let partDesignerTool: PartDesignerTool = "select";
  let partComparisonOpen = false;
  let partComparisonTab: "hits" | "time" = "hits";
  let partComparisonSelection: { kind: "weapon" | "structure"; id: number } | null = null;
  let partComparisonDrafts = new Map<number, PartDefinition>();
  let partComparisonDirtyIds = new Set<number>();
  let partComparisonInvalidKeys = new Set<string>();
  const STRUCTURE_LAYER_BASE_OPTION = "__structure_layer__";
  let partDesignerDraft: PartDefinition = (() => {
    const draft = clonePartDefinition(createDefaultPartDraft(1000, "Custom Part"));
    draft.anchor = { x: 0, y: 0 };
    draft.boxes = [];
    return draft;
  })();
  let partDesignerAnchorSlot: number | null = null;
  let partDesignerSelectedSlot: number | null = null;
  let partDesignerSlots: PartDesignerSlot[] = new Array<PartDesignerSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
  let partDesignerBrushSlot: NonNullable<PartDesignerSlot> = {
    occupiesFunctionalSpace: true,
    occupiesStructureSpace: false,
    needsStructureBehind: true,
    takesDamage: true,
    isAttachPoint: false,
    isShootingPoint: false,
  };
  let partDesignerSupportOffsets = new Set<number>();
  let partDesignerEmptyStructureOffsets = new Set<number>();
  let partDesignerEmptyFunctionalOffsets = new Set<number>();
  let partDesignerCategoryEdited = false;
  let partDesignerSubcategoryEdited = false;
  let partDesignerLastFunctionalBaseComponent: ComponentId = partDesignerDraft.baseComponent;
  const defaultMaterialStats: Record<MaterialId, MaterialStats> = {
    basic: { ...MATERIALS.basic },
    reinforced: { ...MATERIALS.reinforced },
    ceramic: { ...MATERIALS.ceramic },
    reactive: { ...MATERIALS.reactive },
    combined: { ...MATERIALS.combined },
  };
  let editorDraft: UnitTemplate = {
    id: 1000,
    name: "Custom Unit",
    type: "ground",
    gasCost: 0,
    structure: [],
    attachments: [],
    display: [],
  };

  const isUnlimitedResources = (): boolean => debugUnlimitedResources;
  const isDebugVisual = (): boolean => debugVisual;
  const isDebugTargetLines = (): boolean => debugTargetLines;
  const isEditorScreenMode = (mode: ScreenMode): mode is EditorScreenMode => mode === "templateEditor" || mode === "partEditor";
  const saveEditorViewForScreen = (mode: ScreenMode): void => {
    if (mode === "templateEditor") {
      templateEditorGridPanX = editorGridPanX;
      templateEditorGridPanY = editorGridPanY;
      templateEditorViewScale = editorViewScale;
      return;
    }
    if (mode === "partEditor") {
      partEditorGridPanX = editorGridPanX;
      partEditorGridPanY = editorGridPanY;
      partEditorViewScale = editorViewScale;
    }
  };
  const loadEditorViewForScreen = (mode: ScreenMode): void => {
    if (mode === "templateEditor") {
      editorGridPanX = templateEditorGridPanX;
      editorGridPanY = templateEditorGridPanY;
      editorViewScale = templateEditorViewScale;
      return;
    }
    if (mode === "partEditor") {
      editorGridPanX = partEditorGridPanX;
      editorGridPanY = partEditorGridPanY;
      editorViewScale = partEditorViewScale;
    }
  };
  const recenterEditorViewForScreen = (mode: EditorScreenMode): void => {
    if (mode === "templateEditor") {
      templateEditorGridPanX = 0;
      templateEditorGridPanY = 0;
      templateEditorViewScale = 1;
    } else {
      partEditorGridPanX = 0;
      partEditorGridPanY = 0;
      partEditorViewScale = 1;
    }
    if (screen === mode) {
      editorGridPanX = 0;
      editorGridPanY = 0;
      editorViewScale = 1;
    }
  };
  const clampBattleViewOffsets = (): void => {
    const viewportWidth = Math.max(0, canvasViewport.clientWidth);
    const viewportHeight = Math.max(0, canvasViewport.clientHeight);
    const { width: battlefieldWidth, height: battlefieldHeight } = battle.getBattlefieldInfo();
    const scaledCanvasWidth = battlefieldWidth * battleViewScale;
    const scaledCanvasHeight = battlefieldHeight * battleViewScale;
    const VIEW_MARGIN = BATTLE_DISPLAY_CONFIG.view.cameraMargin;

    let minOffsetX = 0;
    let maxOffsetX = 0;
    if (scaledCanvasWidth > viewportWidth) {
      minOffsetX = viewportWidth - scaledCanvasWidth - VIEW_MARGIN;
      maxOffsetX = VIEW_MARGIN;
    } else {
      const centered = (viewportWidth - scaledCanvasWidth) * 0.5;
      minOffsetX = centered - VIEW_MARGIN;
      maxOffsetX = centered + VIEW_MARGIN;
    }

    let minOffsetY = 0;
    let maxOffsetY = 0;
    if (scaledCanvasHeight > viewportHeight) {
      minOffsetY = viewportHeight - scaledCanvasHeight - VIEW_MARGIN;
      maxOffsetY = VIEW_MARGIN;
    } else {
      const centered = (viewportHeight - scaledCanvasHeight) * 0.5;
      minOffsetY = centered - VIEW_MARGIN;
      maxOffsetY = centered + VIEW_MARGIN;
    }

    battleViewOffsetX = Math.max(minOffsetX, Math.min(maxOffsetX, battleViewOffsetX));
    battleViewOffsetY = Math.max(minOffsetY, Math.min(maxOffsetY, battleViewOffsetY));
  };

  const updateViewportCanvasVisibility = (): void => {
    const showBattle = isBattleScreen();
    const showTemplate = isTemplateEditorScreen();
    const showPart = isPartEditorScreen();
    const applyVisibility = (target: HTMLCanvasElement, visible: boolean): void => {
      target.classList.toggle("hidden", !visible);
      target.style.display = visible ? "block" : "none";
      target.style.zIndex = visible ? "2" : "0";
    };
    applyVisibility(canvas, showBattle);
    applyVisibility(templateEditorCanvas, showTemplate);
    applyVisibility(partEditorCanvas, showPart);
  };

  const applyBattleViewTransform = (): void => {
    updateViewportCanvasVisibility();
    if (!isBattleScreen()) {
      syncEditorCanvasSizes();
      return;
    }
    clampBattleViewOffsets();
    phaserBattleRenderer?.resizeViewport(canvasViewport.clientWidth, canvasViewport.clientHeight);
    phaserBattleRenderer?.setViewTransform(battleViewOffsetX, battleViewOffsetY, battleViewScale);
  };

  const panBattleViewBy = (dx: number, dy: number): void => {
    if (!isBattleScreen()) {
      return;
    }
    battleViewOffsetX += dx;
    battleViewOffsetY += dy;
    applyBattleViewTransform();
  };

  const adjustBattleViewScaleAtClientPoint = (nextScale: number, clientX: number, clientY: number): void => {
    if (!isBattleScreen()) {
      return;
    }
    const clampedScale = Math.max(MIN_BATTLE_VIEW_SCALE, Math.min(MAX_BATTLE_VIEW_SCALE, nextScale));
    if (Math.abs(clampedScale - battleViewScale) < 0.0001) {
      return;
    }
    const rect = canvasViewport.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const worldX = (localX - battleViewOffsetX) / battleViewScale;
    const worldY = (localY - battleViewOffsetY) / battleViewScale;
    battleViewScale = clampedScale;
    battleViewOffsetX = localX - worldX * battleViewScale;
    battleViewOffsetY = localY - worldY * battleViewScale;
    applyBattleViewTransform();
    syncTestArenaZoomInput();
  };
  const adjustEditorViewScaleAtClientPoint = (nextScale: number, clientX: number, clientY: number): void => {
    if (!isEditorScreen()) {
      return;
    }
    syncEditorCanvasSizes();
    const drawCanvas = activeEditorCanvas();
    const clampedScale = Math.max(0.35, Math.min(3.2, nextScale));
    if (Math.abs(clampedScale - editorViewScale) < 0.0001) {
      return;
    }
    const rect = drawCanvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const baseX = drawCanvas.width * 0.5;
    const baseY = drawCanvas.height * 0.5;
    const prevCell = Math.max(8, 32 * editorViewScale);
    const nextCell = Math.max(8, 32 * clampedScale);
    const prevGridOriginX = baseX - (editorGridCols * prevCell) * 0.5 + editorGridPanX;
    const prevGridOriginY = baseY - (editorGridRows * prevCell) * 0.5 + editorGridPanY;
    const cellCoordX = (localX - prevGridOriginX) / prevCell;
    const cellCoordY = (localY - prevGridOriginY) / prevCell;
    editorViewScale = clampedScale;
    const nextGridOriginX = localX - cellCoordX * nextCell;
    const nextGridOriginY = localY - cellCoordY * nextCell;
    editorGridPanX = nextGridOriginX - (baseX - (editorGridCols * nextCell) * 0.5);
    editorGridPanY = nextGridOriginY - (baseY - (editorGridRows * nextCell) * 0.5);
  };
  const normalizeTestArenaBattlefieldWidth = (value: number): number => Math.max(640, Math.floor(value));
  const normalizeTestArenaBattlefieldHeight = (value: number): number => Math.max(360, Math.floor(value));
  const normalizeTestArenaZoomPercent = (value: number): number => Math.max(MIN_BATTLE_VIEW_SCALE * 100, Math.min(MAX_BATTLE_VIEW_SCALE * 100, Math.round(value)));
  const normalizeTestArenaGroundHeight = (value: number): number => Math.max(80, Math.min(Math.max(120, testArenaBattlefieldHeight - 40), Math.floor(value)));
  const normalizeTestArenaSpawnTemplateIds = (candidateIds: ReadonlyArray<number>): number[] => {
    const validIds = new Set<number>(getDeployableTemplates().map((template) => template.id));
    const normalized: number[] = [];
    for (const id of candidateIds) {
      if (!Number.isInteger(id) || id < 1 || (testArenaTemplateStoreReady && !validIds.has(id))) {
        continue;
      }
      if (normalized.includes(id)) {
        continue;
      }
      normalized.push(id);
    }
    return normalized;
  };
  let editorOpenedTemplateId: number | null = null;
  let editorOpenedTemplateName = editorDraft.name;
  const setTestArenaEnemySpawnTemplateIds = (candidateIds: ReadonlyArray<number>): number[] => {
    testArenaEnemySpawnTemplateIds = normalizeTestArenaSpawnTemplateIds(candidateIds);
    return testArenaEnemySpawnTemplateIds;
  };
  const getTestArenaEnemySpawnTemplateIds = (): number[] => {
    testArenaEnemySpawnTemplateIds = normalizeTestArenaSpawnTemplateIds(testArenaEnemySpawnTemplateIds);
    return testArenaEnemySpawnTemplateIds;
  };
  const setTestArenaPlayerSpawnTemplateIds = (candidateIds: ReadonlyArray<number>): number[] => {
    testArenaPlayerSpawnTemplateIds = normalizeTestArenaSpawnTemplateIds(candidateIds);
    return testArenaPlayerSpawnTemplateIds;
  };
  const getTestArenaPlayerSpawnTemplateIds = (): number[] => {
    testArenaPlayerSpawnTemplateIds = normalizeTestArenaSpawnTemplateIds(testArenaPlayerSpawnTemplateIds);
    return testArenaPlayerSpawnTemplateIds;
  };
  loadTestArenaSettings();
  const syncTestArenaZoomInput = (): void => {
    const zoomInput = getOptionalElement<HTMLInputElement>("#testArenaZoomPercent");
    if (zoomInput) {
      const value = String(Math.round(battleViewScale * 100));
      if (zoomInput.value !== value) {
        zoomInput.value = value;
      }
    }
  };
  const resetBattleViewToVerticalFit = (): void => {
    if (!isBattleScreen()) {
      return;
    }
    const viewportHeight = canvasViewport.clientHeight;
    if (viewportHeight <= 0) {
      return;
    }
    const { laneBounds } = battle.getBattlefieldInfo();
    const laneTop = laneBounds.airMinZ;
    const laneBottom = laneBounds.groundMaxY;
    const laneHeight = Math.max(1, laneBottom - laneTop);
    const availableHeight = Math.max(1, viewportHeight - DEFAULT_BATTLE_VERTICAL_PADDING * 2);
    battleViewScale = Math.max(
      MIN_BATTLE_VIEW_SCALE,
      Math.min(MAX_BATTLE_VIEW_SCALE, availableHeight / laneHeight),
    );
    const fittedHeight = laneHeight * battleViewScale;
    battleViewOffsetY = (viewportHeight - fittedHeight) * 0.5 - laneTop * battleViewScale;
    battleViewFollowSelection = true;
    applyBattleViewTransform();
    syncTestArenaZoomInput();
  };
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

  const fetchLatestCompositeSpec = async (): Promise<void> => {
    try {
      const res = await fetch("/__arena/composite/latest", { method: "GET" });
      if (!res.ok) {
        return;
      }
      const parsed = await res.json().catch(() => null) as { found?: boolean; spec?: MatchAiSpec } | null;
      if (parsed?.found && parsed.spec && parsed.spec.familyId === "composite") {
        latestCompositeSpec = parsed.spec;
      }
    } catch {
      // Ignore endpoint errors in environments without local arena data.
    }
  };

  const refreshTestArenaLeaderboard = async (): Promise<void> => {
    testArenaLeaderboardLoading = true;
    try {
      const res = await fetch("/__arena/composite/leaderboard", { method: "GET" });
      if (!res.ok) {
        return;
      }
      const parsed = await res.json().catch(() => null) as { entries?: TestArenaLeaderboardEntry[] } | null;
      testArenaLeaderboardEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const availableIds = testArenaLeaderboardEntries.map((entry) => entry.runId);
      if (!availableIds.includes(testArenaLeaderboardManualPairA)) {
        testArenaLeaderboardManualPairA = availableIds[0] ?? "";
      }
      if (!availableIds.includes(testArenaLeaderboardManualPairB) || testArenaLeaderboardManualPairB === testArenaLeaderboardManualPairA) {
        testArenaLeaderboardManualPairB = availableIds.find((id) => id !== testArenaLeaderboardManualPairA) ?? (availableIds[1] ?? "");
      }
      if (!availableIds.includes(testArenaLeaderboardManualVsRandom)) {
        testArenaLeaderboardManualVsRandom = availableIds[0] ?? "";
      }
    } catch {
      testArenaLeaderboardEntries = [];
      testArenaLeaderboardManualPairA = "";
      testArenaLeaderboardManualPairB = "";
      testArenaLeaderboardManualVsRandom = "";
    } finally {
      testArenaLeaderboardLoading = false;
    }
  };

  const findCompositeModelOptionById = (id: string): TestArenaCompositeModelOption | null => {
    for (const option of testArenaCompositeModelOptions) {
      if (option.id === id) {
        return option;
      }
    }
    return null;
  };

  const refreshTestArenaCompositeModelOptions = async (): Promise<void> => {
    type ModelEntry = {
      runId?: string;
      label?: string;
      score?: number;
      rounds?: number;
      games?: number;
      wins?: number;
      losses?: number;
      ties?: number;
      isUnranked?: boolean;
      spec?: MatchAiSpec;
    };
    type ResponseShape = {
      ok?: boolean;
      entries?: ModelEntry[];
    };
    const defaults: TestArenaCompositeModelOption[] = [
      testArenaCompositeModelOptions.find((entry) => entry.id === "custom-components")
        ?? { id: "custom-components", label: "Custom components (target/movement/shoot)" },
      ...Array.from({ length: MAX_CERTIFIED_AI_LEVEL }, (_, index) => {
        const level = index + 1;
        return testArenaCompositeModelOptions.find((entry) => entry.id === `builtin-level-${level}-composite`)
          ?? {
            id: `builtin-level-${level}-composite`,
            label: `builtin: L${level}`,
            spec: createLevelSpec(level),
          };
      }),
    ];
    const merged: TestArenaCompositeModelOption[] = [...defaults];
    try {
      const res = await fetch("/__arena/composite/models", { method: "GET" });
      if (res.ok) {
        const parsed = await res.json().catch(() => null) as ResponseShape | null;
        for (const entry of parsed?.entries ?? []) {
          const runId = typeof entry.runId === "string" ? entry.runId : "";
          if (!runId) {
            continue;
          }
          const scoreLabel = Number.isFinite(entry.score) ? Number(entry.score).toFixed(2) : "100.00";
          const roundsLabel = Number.isFinite(entry.rounds)
            ? Math.max(0, Number(entry.rounds))
            : (Number.isFinite(entry.games) ? Math.max(0, Number(entry.games)) : 0);
          merged.push({
            id: `saved-composite:${runId}`,
            label: `saved:${runId} (score ${scoreLabel}, rounds ${roundsLabel})`,
            score: Number.isFinite(entry.score) ? Number(entry.score) : undefined,
            rounds: Number.isFinite(entry.rounds) ? Number(entry.rounds) : undefined,
            games: Number.isFinite(entry.games) ? Number(entry.games) : undefined,
            spec: entry.spec,
            compatible: Boolean(entry.spec?.familyId === "composite" && entry.spec?.composite),
            reason: entry.spec ? undefined : "AI spec missing in run artifact.",
          });
        }
      }
    } catch {
      // Keep built-in options only.
    }
    testArenaCompositeModelOptions = merged;
    for (const side of ["player", "enemy"] as const) {
      const current = testArenaCompositeModelSelections[side];
      const selected = findCompositeModelOptionById(current);
      const isValid = Boolean(selected && selected.compatible !== false);
      if (!isValid) {
        testArenaCompositeModelSelections[side] = "custom-components";
      }
    }
  };

  const runCraftArenaScenario = async (scenarioId: string): Promise<void> => {
    const scenario = craftArenaScenarios.find((entry) => entry.id === scenarioId);
    if (!scenario || scenario.busy) return;
    const aiOption = findCompositeModelOptionById(craftArenaSettings.aiModelId);
    const craftAExists = templates.some((template) => template.id === scenario.craftAId);
    const craftBExists = templates.some((template) => template.id === scenario.craftBId);
    if (!craftAExists || !craftBExists || !aiOption?.spec || aiOption.compatible === false) {
      scenario.error = "Select two available crafts and a compatible composed AI model.";
      saveCraftArenaScenarios();
      renderPanels();
      return;
    }
    scenario.busy = true;
    scenario.error = undefined;
    renderPanels();
    try {
      const response = await fetch("/__arena/craft-arena/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          craftAId: scenario.craftAId,
          craftACount: craftArenaSettings.quantity,
          craftBId: scenario.craftBId,
          craftBCount: craftArenaSettings.quantity,
          durationMinutes: craftArenaSettings.durationMinutes,
          aiSpec: aiOption.spec,
          battlefield: {
            width: craftArenaSettings.battlefieldWidth,
            height: craftArenaSettings.battlefieldHeight,
            groundHeight: craftArenaSettings.groundHeight,
          },
        }),
      });
      const parsed = await response.json().catch(() => null) as (Partial<CraftArenaResult> & {
        ok?: boolean;
        reason?: string;
        error?: string;
      }) | null;
      if (
        !response.ok
        || !parsed?.ok
        || typeof parsed.durationMinutes !== "number"
        || typeof parsed.simSecondsElapsed !== "number"
        || !parsed.craftA
        || !parsed.craftB
      ) {
        throw new Error(parsed?.error || parsed?.reason || `Simulation request failed (${response.status}).`);
      }
      scenario.result = {
        durationMinutes: parsed.durationMinutes,
        simSecondsElapsed: parsed.simSecondsElapsed,
        parallelWorkers: Number(parsed.parallelWorkers ?? 1),
        parallelMode: String(parsed.parallelMode ?? "unknown"),
        craftA: parsed.craftA,
        craftB: parsed.craftB,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      scenario.error = error instanceof Error ? error.message : String(error);
    } finally {
      scenario.busy = false;
      saveCraftArenaScenarios();
      renderPanels();
    }
  };

  const runLeaderboardCompetition = async (
    mode: "random-pair" | "unranked-vs-random" | "manual-pair" | "manual-vs-random",
    runs: number,
    runAId?: string,
    runBId?: string,
  ): Promise<void> => {
    if (testArenaLeaderboardCompeteBusy) {
      return;
    }
    if (mode === "manual-pair") {
      if (!runAId || !runBId || runAId === runBId) {
        testArenaLeaderboardCompeteStatus = "Select two different models for manual pair mode.";
        renderPanels();
        return;
      }
    }
    if (mode === "manual-vs-random") {
      if (!runAId) {
        testArenaLeaderboardCompeteStatus = "Select a model for manual vs random mode.";
        renderPanels();
        return;
      }
    }
    testArenaLeaderboardCompeteBusy = true;
    testArenaLeaderboardCompeteProgress = [];
    const totalRuns = Math.max(1, Math.floor(runs));
    testArenaLeaderboardCompeteStatus = `Running leaderboard matches... 0/${totalRuns}`;
    renderPanels();
    try {
      const res = await fetch("/__arena/composite/leaderboard/compete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          runs: totalRuns,
          runAId: runAId ?? null,
          runBId: runBId ?? null,
        }),
      });
      const parsed = await res.json().catch(() => null) as { jobId?: string; total?: number; reason?: string } | null;
      if (!res.ok) {
        testArenaLeaderboardCompeteStatus = `Competition could not start: ${parsed?.reason ?? "request failed"}`;
        return;
      }
      const jobId = parsed?.jobId ?? "";
      const jobTotal = Math.max(0, Number(parsed?.total ?? totalRuns));
      if (!jobId) {
        testArenaLeaderboardCompeteStatus = "Competition started without a progress identifier.";
        return;
      }
      let lastCompleted = -1;
      while (true) {
        const statusRes = await fetch(`/__arena/composite/leaderboard/compete/status?jobId=${encodeURIComponent(jobId)}`);
        const statusPayload = await statusRes.json().catch(() => null) as {
          job?: {
            status?: string;
            completed?: number;
            failed?: number;
            total?: number;
            startedAtMs?: number;
            error?: string;
            matches?: Array<{
              index?: number;
              runA?: string;
              runB?: string;
              status?: string;
              startedAtMs?: number;
              finishedAtMs?: number;
              simSecondsElapsed?: number;
              maxSimSeconds?: number;
              units?: number;
              projectiles?: number;
              error?: string;
            }>;
          };
        } | null;
        if (!statusRes.ok || !statusPayload?.job) {
          testArenaLeaderboardCompeteStatus = "Competition progress is unavailable.";
          return;
        }
        const completed = Math.max(0, Number(statusPayload.job.completed ?? 0));
        const failed = Math.max(0, Number(statusPayload.job.failed ?? 0));
        const total = Math.max(0, Number(statusPayload.job.total ?? jobTotal));
        const matches = statusPayload.job.matches ?? [];
        testArenaLeaderboardCompeteProgress = matches.map((match, index) => ({
          index: Math.max(0, Math.floor(Number(match.index ?? index))),
          runA: String(match.runA ?? "-"),
          runB: String(match.runB ?? "-"),
          status: match.status === "running" || match.status === "completed" || match.status === "failed"
            ? match.status
            : "queued",
          ...(Number.isFinite(match.startedAtMs) ? { startedAtMs: Number(match.startedAtMs) } : {}),
          ...(Number.isFinite(match.finishedAtMs) ? { finishedAtMs: Number(match.finishedAtMs) } : {}),
          simSecondsElapsed: Math.max(0, Number(match.simSecondsElapsed ?? 0)),
          maxSimSeconds: Math.max(0, Number(match.maxSimSeconds ?? 0)),
          units: Math.max(0, Math.floor(Number(match.units ?? 0))),
          projectiles: Math.max(0, Math.floor(Number(match.projectiles ?? 0))),
          ...(match.error ? { error: String(match.error) } : {}),
        }));
        const active = matches.filter((match) => match.status === "running");
        const queued = matches.filter((match) => match.status === "queued").length;
        const averageSimSeconds = active.length > 0
          ? active.reduce((sum, match) => sum + Math.max(0, Number(match.simSecondsElapsed ?? 0)), 0) / active.length
          : 0;
        const maxSimSeconds = active.length > 0
          ? Math.max(...active.map((match) => Math.max(0, Number(match.maxSimSeconds ?? 0))))
          : 0;
        const activeUnits = active.reduce((sum, match) => sum + Math.max(0, Number(match.units ?? 0)), 0);
        const activeProjectiles = active.reduce((sum, match) => sum + Math.max(0, Number(match.projectiles ?? 0)), 0);
        const wallSeconds = statusPayload.job.startedAtMs
          ? Math.max(0, (Date.now() - statusPayload.job.startedAtMs) / 1000)
          : 0;
        if (completed !== lastCompleted || statusPayload.job.status === "running") {
          lastCompleted = completed;
          const progressDetail = active.length > 0
            ? ` • ${active.length} active, avg ${averageSimSeconds.toFixed(0)}/${maxSimSeconds.toFixed(0)} sim s • ${activeUnits} units, ${activeProjectiles} shots`
            : queued > 0
              ? ` • ${queued} queued`
              : "";
          testArenaLeaderboardCompeteStatus = `Running leaderboard matches... ${completed}/${total}${failed > 0 ? ` (${failed} failed)` : ""}${progressDetail} • ${wallSeconds.toFixed(0)} wall s`;
          renderPanels();
        }
        if (statusPayload.job.status !== "running") {
          testArenaLeaderboardCompeteProgress = [];
          await refreshTestArenaLeaderboard();
          await refreshTestArenaCompositeModelOptions();
          testArenaLeaderboardCompeteStatus = statusPayload.job.status === "done"
            ? `Competition completed: ${completed}/${total} matches${failed > 0 ? `, ${failed} failed` : ""}.`
            : `Competition failed: ${statusPayload.job.error ?? "no match completed"}`;
          break;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
      }
    } catch {
      testArenaLeaderboardCompeteStatus = "Competition failed due to network or server error.";
    } finally {
      testArenaLeaderboardCompeteBusy = false;
      testArenaLeaderboardCompeteProgress = [];
      renderPanels();
    }
  };

  const findAiOptionById = (kind: TestArenaAiModuleKind, id: string): TestArenaAiOption | null => {
    const options = testArenaAiOptions[kind];
    for (const option of options) {
      if (option.id === id) {
        return option;
      }
    }
    return null;
  };

  const refreshTestArenaAiOptions = async (): Promise<void> => {
    type ResponseShape = {
      ok?: boolean;
      modules?: {
        target?: Array<{ id?: string; label?: string; spec?: CompositeModuleSpec; compatible?: boolean; reason?: string }>;
        movement?: Array<{ id?: string; label?: string; spec?: CompositeModuleSpec; compatible?: boolean; reason?: string }>;
        shoot?: Array<{ id?: string; label?: string; spec?: CompositeModuleSpec; compatible?: boolean; reason?: string }>;
      };
    };
    const merged: Record<TestArenaAiModuleKind, TestArenaAiOption[]> = {
      target: [...defaultAiOptions.target],
      movement: [...defaultAiOptions.movement],
      shoot: [...defaultAiOptions.shoot],
    };
    try {
      const res = await fetch("/__arena/composite/modules", { method: "GET" });
      if (res.ok) {
        const parsed = await res.json().catch(() => null) as ResponseShape | null;
        const appendOptions = (kind: TestArenaAiModuleKind): void => {
          const list = parsed?.modules?.[kind] ?? [];
          for (const entry of list) {
            const id = typeof entry.id === "string" ? entry.id : "";
            const label = typeof entry.label === "string" ? entry.label : id;
            const spec = entry.spec;
            const compatible = entry.compatible !== false;
            const reason = typeof entry.reason === "string" ? entry.reason : undefined;
            if (!id || !spec?.familyId) {
              if (!id) {
                continue;
              }
              merged[kind].push({
                id,
                label,
                compatible: false,
                reason: reason ?? "No compatible composite spec found.",
              });
              continue;
            }
            merged[kind].push({
              id,
              label,
              spec: {
                familyId: spec.familyId,
                params: spec.params ?? {},
              },
              compatible,
              reason,
            });
          }
        };
        appendOptions("target");
        appendOptions("movement");
        appendOptions("shoot");
      }
    } catch {
      // Keep built-in options only.
    }
    testArenaAiOptions = merged;
    for (const side of ["player", "enemy"] as const) {
      for (const kind of ["target", "movement", "shoot"] as const) {
        const current = testArenaAiSelections[side][kind];
        const isSelectable = (entry: TestArenaAiOption): boolean => entry.compatible !== false && Boolean(entry.spec?.familyId);
        if (!findAiOptionById(kind, current) || !isSelectable(findAiOptionById(kind, current) as TestArenaAiOption)) {
          const fallback = merged[kind].find((entry) => isSelectable(entry));
          testArenaAiSelections[side][kind] = fallback?.id ?? current;
        }
      }
    }
  };

  const refreshTestArenaComponentGrid = async (): Promise<void> => {
    for (const side of ["player", "enemy"] as const) {
      const target = findAiOptionById("target", testArenaAiSelections[side].target);
      const movement = findAiOptionById("movement", testArenaAiSelections[side].movement);
      const shoot = findAiOptionById("shoot", testArenaAiSelections[side].shoot);
      const targetSpec = target?.compatible === false ? null : (target?.spec ?? null);
      const movementSpec = movement?.compatible === false ? null : (movement?.spec ?? null);
      const shootSpec = shoot?.compatible === false ? null : (shoot?.spec ?? null);
      if (!targetSpec || !movementSpec || !shootSpec) {
        testArenaResolvedCompositeModules[side] = null;
        continue;
      }
      testArenaResolvedCompositeModules[side] = { target: targetSpec, movement: movementSpec, shoot: shootSpec };
    }
  };

  const buildAiControllerFromPreset = (side: TestArenaSide, preset: TestArenaAiPreset): BattleAiController | null => {
    if (preset === "baseline") {
      return null;
    }
    if (preset === "composite-baseline") {
      return createBaselineCompositeAiController();
    }
    if (preset === "composite-decision-default") {
      const spec: MatchAiSpec = {
        familyId: "composite",
        params: {},
        composite: {
          target: { familyId: "dt-target", params: {} },
          movement: { familyId: "dt-movement", params: {} },
          shoot: { familyId: "dt-shoot", params: {} },
        },
      };
      return makeCompositeAiController(spec);
    }
    if (preset === "component-config") {
      const selectedModelId = testArenaCompositeModelSelections[side];
      if (selectedModelId !== "custom-components") {
        const selectedModel = findCompositeModelOptionById(selectedModelId);
        if (selectedModel?.spec?.familyId === "composite" && selectedModel.spec.composite) {
          return makeCompositeAiController(selectedModel.spec);
        }
        return null;
      }
      const modules = testArenaResolvedCompositeModules[side];
      if (!modules) {
        return null;
      }
      const spec: MatchAiSpec = {
        familyId: "composite",
        params: {},
        composite: modules,
      };
      return makeCompositeAiController(spec);
    }
    if (!latestCompositeSpec) {
      return null;
    }
    return makeCompositeAiController(latestCompositeSpec);
  };

  const applyTestArenaAiControllers = (): void => {
    const playerController = buildAiControllerFromPreset("player", testArenaPlayerAiPreset);
    const enemyController = buildAiControllerFromPreset("enemy", testArenaEnemyAiPreset);
    if (testArenaPlayerAiPreset === "component-config" && !playerController) {
      addLog("Player component config is invalid; falling back to default battle AI.", "warn");
    }
    if (testArenaEnemyAiPreset === "component-config" && !enemyController) {
      addLog("Enemy component config is invalid; falling back to default battle AI.", "warn");
    }
    const externalSides = getExternalAiSidesFromPresets();
    battle.setExternalAiSides(externalSides);
    battle.setAiControllers({
      ...(playerController ? { player: playerController } : {}),
      ...(enemyController ? { enemy: enemyController } : {}),
    });
  };

  const battle = new BattleSession(
    simulationCanvas,
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
        if (nodeId === testArenaNode.id) {
          addLog(`Test Arena ended (${victory ? "victory" : "defeat"}).`, victory ? "good" : "bad");
          renderPanels();
          return;
        }
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
        if (deploymentQueue.length > 0) {
          const refund = deploymentQueue.reduce((sum, order) => sum + order.gasCost, 0);
          if (!isUnlimitedResources()) gas += refund;
          deploymentQueue.splice(0, deploymentQueue.length);
          addLog(`Canceled en-route deliveries · ${refund} gas refunded`, "warn");
        }
        renderPanels();
      },
    },
    templates,
    {
      ...(battleSessionOptions ?? {}),
      battlefieldWidth: battleSessionOptions?.battlefieldWidth ?? BATTLEFIELD_WIDTH,
      battlefieldHeight: battleSessionOptions?.battlefieldHeight ?? BATTLEFIELD_HEIGHT,
      movementSpeedMultiplier: globalMovementSpeedMultiplier,
      partCatalog: battleSessionOptions?.partCatalog
        ? mergePartCatalogs(parts, battleSessionOptions.partCatalog)
        : parts,
    },
  );
  // Phaser owns browser battle presentation; BattleSession remains the shared/headless simulation.
  phaserBattleRenderer = new PhaserBattleRenderer(
    canvas,
    battle,
    templates,
    () => {
      const viewportWidth = Math.max(1, canvasViewport.clientWidth);
      const worldPerDisplayPixel = 1 / Math.max(0.0001, battleViewScale);
      return {
        centerX: (-battleViewOffsetX + viewportWidth * 0.5) * worldPerDisplayPixel,
        worldWidth: viewportWidth * worldPerDisplayPixel,
      };
    },
    () => globalBattleSoundVolume,
  );
  // Maintenance rule: every setting added to Global Settings must update its
  // corresponding domain YAML and add an explicit live runtime hook here.
  const applyGlobalSettingsLive = (settings: GlobalSettingsValues): void => {
    globalMovementSpeedMultiplier = battle.setMovementSpeedMultiplier(settings.movementSpeedMultiplier);
    globalBattleSoundVolume = settings.battleSoundVolume;
  };
  if (isViteDevelopment) {
    void fetchGlobalSettingsFromYaml()
      .then(applyGlobalSettingsLive)
      .catch((error) => addLog(`Could not load YAML global settings: ${error instanceof Error ? error.message : String(error)}`, "warn"));
  }
  void fetchLatestCompositeSpec()
    .then(async () => {
      await refreshTestArenaLeaderboard();
      await refreshTestArenaCompositeModelOptions();
      await refreshTestArenaAiOptions();
      await refreshTestArenaComponentGrid();
    })
    .finally(() => {
      renderPanels();
    });

  const startDebugProbeLoop = (): void => {
    const pollEveryMs = 250;
    let timer: number | null = null;
    let inFlight = false;

    const buildAppRoot = (): Record<string, unknown> => {
      return {
        screen,
        running,
        campaignSeconds: campaign.elapsedSeconds,
        gas,
        commanderSkill,
        debugUnlimitedResources,
        debugVisual,
        debugTargetLines,
        debugDisplayLayer,
        debugPartHpOverlay,
        replayMode,
      };
    };

    const buildBattleRoot = (): Record<string, unknown> => {
      return {
        state: battle.getState(),
        debug: battle.getDebugSnapshot(),
        selection: battle.getSelection(),
        displayEnabled: battle.isDisplayEnabled(),
        partHpOverlayEnabled: battle.isPartHpOverlayEnabled(),
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
      [canvasViewport, "mousedown"],
      [canvasViewport, "mouseup"],
      [canvasViewport, "mousemove"],
      [canvasViewport, "click"],
      [canvasViewport, "wheel"],
      [canvasViewport, "contextmenu"],
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
    canvasViewport.style.cursor = "default";
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
    applyBattlefieldDefaults();
    battle.setPlayerAutoSpawnEnabled(false);
    battle.setPlayerAutoSpawnTargetCount(0);
    battle.setEnemySpawnTemplateFilter(null);
    battle.start(node);
    battle.clearControlSelection();
    battle.getState().enemyGas = spec.enemyGas;

    // Symmetric starters.
    const starters = [1, 2].filter((id) => templates.some((t) => t.id === id));
    for (const id of starters) {
      battle.arenaDeploy("player", id, { chargeGas: false, deploymentGasCost: 0, y: 300 });
      battle.arenaDeploy("enemy", id, { chargeGas: false, deploymentGasCost: 0, y: 300 });
    }

    setScreen("battle");
    resetBattleViewToVerticalFit();
    renderPanels();
    addLog(`Arena replay started (seed=${spec.seed})`, "good");

    // Replay macro loop state.
    const rosterPreference = [1, 2, 3, 4, 5];
    const availableTemplateIds = new Set<number>(getDeployableTemplates().map((t) => t.id));
    let roster = rosterPreference.filter((id) => availableTemplateIds.has(id));
    if (roster.length === 0) {
      roster = getDeployableTemplates().slice(0, 6).map((t) => t.id);
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

    const pickMirrored = (): { templateId: number | null; y: number } => {
      if (roster.length === 0) {
        return { templateId: null, y: 0 };
      }
      const idx = Math.floor(spawnRng() * roster.length);
      const templateId = roster[Math.max(0, Math.min(roster.length - 1, idx))] ?? null;
      const y = 220 + spawnRng() * 260;
      return { templateId, y };
    };

    const decide = (side: "player" | "enemy"): { templateId: number | null; intervalS: number; y?: number } => {
      const s = battle.getState();
      const alive = s.units.filter((u) => u.type !== "base" && u.alive && u.side === side).length;
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
          const alivePlayer = s.units.filter((u) => u.type !== "base" && u.alive && u.side === "player").length;
          const aliveEnemy = s.units.filter((u) => u.type !== "base" && u.alive && u.side === "enemy").length;
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


  const refreshPartsFromStore = async (): Promise<void> => {
    const defaultParts = await fetchDefaultPartsFromStore();
    parts.splice(0, parts.length, ...defaultParts);
    const applyMaterialOverridesFromParts = (): void => {
      const materialIds: MaterialId[] = ["basic", "reinforced", "ceramic", "reactive", "combined"];
      for (const materialId of materialIds) {
        const baseline = defaultMaterialStats[materialId];
        MATERIALS[materialId] = { ...baseline };
      }
      for (const materialId of materialIds) {
        const materialPart = parts.find((part) => {
          if (part.layer !== "structure") {
            return false;
          }
          return part.properties?.materialId === materialId;
        });
        if (!materialPart) {
          continue;
        }
        const current = MATERIALS[materialId];
        const nextMass = materialPart.stats?.mass;
        const nextHp = materialPart.properties?.hp;
        const nextArmor = materialPart.properties?.materialArmor;
        const nextRecoverPerSecond = materialPart.properties?.materialRecoverPerSecond;
        const nextColor = materialPart.properties?.materialColor;
        MATERIALS[materialId] = {
          label: materialPart.name || current.label,
          mass: Number.isFinite(nextMass) ? Math.max(0, Number(nextMass)) : current.mass,
          armor: Number.isFinite(nextArmor) ? Math.max(0, Number(nextArmor)) : current.armor,
          hp: Number.isFinite(nextHp) ? Math.max(0, Number(nextHp)) : current.hp,
          recoverPerSecond: Number.isFinite(nextRecoverPerSecond)
            ? Math.max(0, Number(nextRecoverPerSecond))
            : current.recoverPerSecond,
          color: (typeof nextColor === "string" && /^#[0-9a-fA-F]{6}$/.test(nextColor))
            ? nextColor
            : current.color,
        };
      }
    };
    applyMaterialOverridesFromParts();
    battle.setPartCatalog(parts);
  };

  const refreshTemplatesFromStore = async (): Promise<void> => {
    const defaultTemplates = await fetchDefaultTemplatesFromStore(parts);
    const userTemplates = await fetchUserTemplatesFromStore(parts);
    const mergedStore = mergeTemplates(defaultTemplates, userTemplates);
    if (mergedStore.length > 0) {
      templates.splice(0, templates.length, ...mergedStore);
    } else {
      const merged = mergeTemplates(templates, mergeTemplates(defaultTemplates, userTemplates));
      templates.splice(0, templates.length, ...merged);
    }
    testArenaTemplateStoreReady = true;
    if (testArenaHasStoredPlayerCraftSelection) {
      setTestArenaPlayerSpawnTemplateIds(testArenaPlayerSpawnTemplateIds);
    } else {
      testArenaPlayerSpawnTemplateIds = getDeployableTemplates().map((template) => template.id);
    }
    if (testArenaHasStoredEnemyCraftSelection) {
      setTestArenaEnemySpawnTemplateIds(testArenaEnemySpawnTemplateIds);
    } else {
      testArenaEnemySpawnTemplateIds = getDeployableTemplates().map((template) => template.id);
    }
    if (testArenaTemplateStoreReady && !getDeployableTemplates().some((template) => template.id === testArenaManualSpawnTemplateId)) {
      testArenaManualSpawnTemplateId = getDeployableTemplates()[0]?.id ?? 0;
    }
    ensureCraftArenaPairScenarios();
    saveTestArenaSettings();
  };

  let activeGamepadIndex: number | null = null;
  const applyGamepadDeadzone = (value: number, deadzone = 0.18): number => {
    const magnitude = Math.abs(value);
    if (!Number.isFinite(value) || magnitude <= deadzone) return 0;
    return Math.sign(value) * Math.min(1, (magnitude - deadzone) / (1 - deadzone));
  };
  const pollGamepadInput = (): Partial<KeyState> => {
    if (replayMode || typeof navigator.getGamepads !== "function") return {};
    const pads = navigator.getGamepads();
    const gamepad = (activeGamepadIndex === null ? null : pads[activeGamepadIndex])
      ?? Array.from(pads).find((entry): entry is Gamepad => entry !== null && entry.connected)
      ?? null;
    if (!gamepad) {
      if (activeGamepadIndex !== null) addLog("Controller disconnected", "warn");
      activeGamepadIndex = null;
      return {};
    }
    if (activeGamepadIndex !== gamepad.index) {
      activeGamepadIndex = gamepad.index;
      addLog(`Controller connected: ${gamepad.id}`, "good");
    }
    const rightTrigger = gamepad.buttons[7];
    const rightBumper = gamepad.buttons[5];
    return {
      moveX: applyGamepadDeadzone(gamepad.axes[0] ?? 0),
      moveY: applyGamepadDeadzone(gamepad.axes[1] ?? 0),
      aimX: applyGamepadDeadzone(gamepad.axes[2] ?? 0),
      aimY: applyGamepadDeadzone(gamepad.axes[3] ?? 0),
      manualFire: (rightTrigger?.pressed ?? false)
        || (rightTrigger?.value ?? 0) > 0.2
        || (rightBumper?.pressed ?? false),
    };
  };

  type DeploymentOrder = {
    templateId: number;
    remainingSeconds: number;
    totalSeconds: number;
    gasCost: number;
    sourceName: string;
    autonomous: boolean;
  };
  const deploymentQueue: DeploymentOrder[] = [];
  let autonomousSpawnCooldown = 0;
  let defaultAutoTemplateIds: number[] = getDeployableTemplates().slice(0, 3).map((template) => template.id);

  const getTemplateLogisticsSpeed = (template: UnitTemplate): number => Math.max(
    20,
    ...template.attachments.map((attachment) => COMPONENTS[attachment.component].maxSpeed ?? 45),
  );

  const queueDeployment = (templateId: number, autonomous: boolean): boolean => {
    const state = battle.getState();
    if (!state.active || state.outcome || state.nodeId === testArenaNode.id) return false;
    const template = templates.find((entry) => entry.id === templateId);
    if (!template || !state.nodeId) return false;
    const friendlyActive = state.units.filter((unit) => unit.type !== "base" && unit.side === "player" && unit.alive).length;
    if (friendlyActive + deploymentQueue.length >= campaign.getDeliveryCapacity()) {
      if (!autonomous) addLog("Delivery Center capacity reached", "warn");
      return false;
    }
    const quote = quoteBattleLogistics(mapNodes, state.nodeId, getTemplateLogisticsSpeed(template), template.id);
    const cost = Math.ceil(template.gasCost * quote.gasCostMultiplier);
    if (!isUnlimitedResources() && gas < cost) {
      if (!autonomous) addLog("Not enough gas for delivery", "warn");
      return false;
    }
    if (!isUnlimitedResources()) gas -= cost;
    deploymentQueue.push({ templateId, remainingSeconds: quote.travelSeconds, totalSeconds: quote.travelSeconds, gasCost: cost, sourceName: quote.sourceName, autonomous });
    addLog(`${autonomous ? "AI ordered" : "Dispatched"} ${template.name} from ${quote.sourceName} · ETA ${Math.ceil(quote.travelSeconds)}s${quote.freeFromOutpost ? " · free outpost unit" : ` · ${cost} gas`}`, autonomous ? "warn" : "good");
    return true;
  };

  const completeResearch = (kind: ResearchKind): void => {
    if (tech[kind]) return;
    tech[kind] = true;
    if (kind === "reinforced") upgradeTemplateMaterials("reinforced");
    if (kind === "combined") upgradeTemplateMaterials("combined");
    if (kind === "mediumWeapons") {
      const tankTemplate = templates.find((template) => template.id === 2);
      const weapon = tankTemplate?.attachments.find((attachment) => attachment.component === "heavyCannon");
      if (weapon && tankTemplate) {
        weapon.component = "explosiveShell";
        tankTemplate.gasCost = computeTemplateGasCost(tankTemplate, parts);
      }
    }
  };

  const updateMetaBar = (): void => {
    const gasLabel = isUnlimitedResources() ? "INF" : `${Math.floor(gas)}`;
    const capLabel = isUnlimitedResources() ? "INF" : `${armyCap(getCommanderSkillForCap())}`;
    const battleLabel = battle.getState().active && !battle.getState().outcome ? " | Battle: active" : "";
    if (!replayMode) {
      const minutes = Math.floor(campaign.elapsedSeconds / 60);
      const seconds = Math.floor(campaign.elapsedSeconds % 60);
      metaBar.innerHTML = `Live ${minutes}:${seconds.toString().padStart(2, "0")} | Gas: ${gasLabel} | Commander Skill: ${commanderSkill} | Delivery: ${campaign.getDeliveryCapacity()}${battleLabel} | Army Cap: ${capLabel}`;
    }

    if (!replayMode) {
      arenaReplayStats.textContent = "";
      const showTestArenaStats = screen === "testArena";
      testArenaLossStats.classList.toggle("hidden", !showTestArenaStats);
      if (showTestArenaStats) {
        const losses = battle.getLossStats();
        testArenaLossStats.innerHTML = `
          <strong>Arena losses</strong>
          <span class="player"><b>Player</b><i>${losses.player.destroyedObjects} destroyed</i><i>${Math.floor(losses.player.gasWasted)} gas wasted</i></span>
          <span class="enemy"><b>Enemy</b><i>${losses.enemy.destroyedObjects} destroyed</i><i>${Math.floor(losses.enemy.gasWasted)} gas wasted</i></span>
        `;
      }
      return;
    }
    testArenaLossStats.classList.add("hidden");
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
    const prev = screen;
    if (isEditorScreenMode(prev)) {
      saveEditorViewForScreen(prev);
    }
    screen = next;
    debugMenu.open = false;
    developerMenu.open = false;
    appShell.classList.toggle("editor-mode", next === "templateEditor" || next === "partEditor");
    appShell.classList.toggle("craft-editor-mode", next === "templateEditor");
    appShell.classList.toggle("scenario-mode", next === "testArena" || next === "craftArena");
    contextInspectorTitle.textContent = next === "templateEditor"
      ? "Craft Inspector"
      : next === "partEditor"
        ? "Part Inspector"
        : next === "base"
          ? "Command Status"
          : next === "map"
            ? "Sector Intel"
            : next === "craftArena"
              ? "Matchup Details"
            : "Unit Inspector";
    if (isEditorScreenMode(next)) {
      if (next === "templateEditor" && !templateEditorViewVisited) {
        recenterEditorViewForScreen("templateEditor");
        templateEditorViewVisited = true;
      } else if (next === "partEditor" && !partEditorViewVisited) {
        recenterEditorViewForScreen("partEditor");
        partEditorViewVisited = true;
      }
      loadEditorViewForScreen(next);
    }
    basePanel.classList.toggle("hidden", next !== "base");
    mapPanel.classList.toggle("hidden", next !== "map");
    battlePanel.classList.toggle("hidden", next !== "battle");
    testArenaPanel.classList.toggle("hidden", next !== "testArena");
    craftArenaPanel.classList.toggle("hidden", next !== "craftArena");
    craftArenaCenter.classList.toggle("hidden", next !== "craftArena");
    leaderboardPanel.classList.toggle("hidden", next !== "leaderboard");
    leaderboardCenter.classList.toggle("hidden", next !== "leaderboard");
    editorPanel.classList.toggle("hidden", !isEditorScreen());
    tabs.base.classList.toggle("active", next === "base");
    tabs.map.classList.toggle("active", next === "map");
    tabs.battle.classList.toggle("active", next === "battle");
    tabs.testArena.classList.toggle("active", next === "testArena");
    tabs.craftArena.classList.toggle("active", next === "craftArena");
    tabs.leaderboard.classList.toggle("active", next === "leaderboard");
    tabs.templateEditor.classList.toggle("active", next === "templateEditor");
    tabs.partEditor.classList.toggle("active", next === "partEditor");
    if (!isEditorScreen()) {
      hideEditorTooltip();
    }
    const isManagementScreen = next === "base" || next === "map";
    managementCenter.classList.toggle("hidden", !isManagementScreen);
    canvasViewport.classList.toggle("hidden", next === "leaderboard" || next === "craftArena" || isManagementScreen);
    if (!battleViewDragActive) {
      canvasViewport.style.cursor = isBattleScreen() ? "grab" : "default";
    }
    weaponHud.classList.toggle("hidden", next === "leaderboard" || next === "craftArena" || isManagementScreen);
    applyBattleViewTransform();
  };

  const followSelectedUnitWithCamera = (): void => {
    if (!isBattleScreen() || battleViewDragActive || !battleViewFollowSelection) {
      return;
    }
    const selection = battle.getSelection();
    const trackedId = selection.playerControlledId ?? selection.selectedUnitId;
    if (!trackedId) {
      return;
    }
    const tracked = battle.getState().units.find((unit) => unit.id === trackedId && unit.alive);
    if (!tracked) {
      return;
    }
    const viewportWidth = canvasViewport.clientWidth;
    if (viewportWidth <= 0) {
      return;
    }
    const viewportHeight = canvasViewport.clientHeight;
    const BORDER_MARGIN = BATTLE_DISPLAY_CONFIG.view.designerBorderMargin;
    const screenX = battleViewOffsetX + tracked.x * battleViewScale;
    const screenY = battleViewOffsetY + tracked.y * battleViewScale;

    let dx = 0;
    let dy = 0;
    if (tracked.facing === 1) {
      const rightFacingThreshold = viewportWidth * 0.5;
      if (screenX > rightFacingThreshold) {
        dx = rightFacingThreshold - screenX;
      }
    } else {
      const leftFacingThreshold = viewportWidth * 0.5;
      if (screenX < leftFacingThreshold) {
        dx = leftFacingThreshold - screenX;
      }
    }
    if (screenX < BORDER_MARGIN) {
      dx = Math.max(dx, BORDER_MARGIN - screenX);
    } else if (screenX > viewportWidth - BORDER_MARGIN) {
      dx = Math.min(dx, (viewportWidth - BORDER_MARGIN) - screenX);
    }
    if (screenY < BORDER_MARGIN) {
      dy = BORDER_MARGIN - screenY;
    } else if (screenY > viewportHeight - BORDER_MARGIN) {
      dy = (viewportHeight - BORDER_MARGIN) - screenY;
    }
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      panBattleViewBy(dx, dy);
    }
  };

  const makeUniqueTemplateId = (): number => {
    const used = new Set<number>(templates.map((template) => template.id));
    let next = 1;
    while (used.has(next)) {
      next += 1;
    }
    return next;
  };

  const makeUniquePartId = (): number => {
    const used = new Set<number>(parts.map((part) => part.id));
    let next = 1;
    while (used.has(next)) {
      next += 1;
    }
    return next;
  };

  const makeCopyTemplate = (source: UnitTemplate): UnitTemplate => {
    const copy = cloneTemplate(source);
    copy.name = `${source.name}-copy`;
    copy.id = makeUniqueTemplateId();
    return copy;
  };

  const makeCopyPart = (source: PartDefinition): PartDefinition => {
    const copy = clonePartDefinition(source);
    copy.name = `${source.name}-copy`;
    copy.id = makeUniquePartId();
    return copy;
  };

  const parseProjectileClassList = (values: ReadonlyArray<string>): ProjectileClass[] => {
    const result: ProjectileClass[] = [];
    for (const value of values) {
      if (
        value === "bullet"
        || value === "missile"
        || value === "laser"
      ) {
        result.push(value);
      }
    }
    return result;
  };

  const resolveStructurePartById = (partId: number | null | undefined): PartDefinition | null => {
    if (!partId) {
      return null;
    }
    const part = parts.find((entry) => entry.id === partId);
    return part && part.layer === "structure" ? part : null;
  };

  const getStructurePartStats = (partId: number | null | undefined): {
    mass: number;
    armor: number;
    hp: number;
    recoverPerSecond: number;
    color: string;
    alpha: number;
  } => {
    const part = resolveStructurePartById(partId);
    return {
      mass: Math.max(0, part?.stats?.mass ?? MATERIALS.basic.mass),
      armor: Math.max(0, part?.properties?.materialArmor ?? MATERIALS.basic.armor),
      hp: Math.max(1, part?.properties?.hp ?? MATERIALS.basic.hp),
      recoverPerSecond: Math.max(0, part?.properties?.materialRecoverPerSecond ?? MATERIALS.basic.recoverPerSecond),
      color: (typeof part?.properties?.materialColor === "string" && /^#[0-9a-fA-F]{6}$/.test(part.properties.materialColor))
        ? part.properties.materialColor
        : MATERIALS.basic.color,
      alpha: Math.max(0, Math.min(1, part?.properties?.materialAlpha ?? part?.partProperties?.alpha ?? 1)),
    };
  };

  const getDefaultStructurePartId = (): number | null => {
    const first = parts.find((part) => part.layer === "structure");
    return first?.id ?? null;
  };

  const resolveMaterialIdFromStructurePart = (part: PartDefinition): MaterialId | null => {
    if (part.layer !== "structure") {
      return null;
    }
    if (part.properties?.materialId) {
      return part.properties.materialId;
    }
    return "basic";
  };

  const getMaterialDefaultsForPart = (part: PartDefinition): {
    materialArmor: number;
    materialRecoverPerSecond: number;
    materialColor: string;
    hp: number;
    mass: number;
  } => {
    const materialId: MaterialId = resolveMaterialIdFromStructurePart(part) ?? "basic";
    return getStructureMaterialDefaults(materialId);
  };

  const getResolvedPartType = (part: PartDefinition): PartType => {
    if (part.partType) {
      return part.partType;
    }
    if (part.layer === "structure") {
      return "structure";
    }
    return getPartTypeFromComponent(part.baseComponent);
  };

  const getResolvedPartCategory = (part: PartDefinition): PartCategory | undefined => {
    return part.partCategory ?? getPartCategoryFromComponent(part.baseComponent);
  };

  const syncPartTypeAndComponent = (part: PartDefinition): void => {
    const partType = getResolvedPartType(part);
    const partCategory = getResolvedPartCategory(part);
    const weaponExplosive = partType === "weapon"
      ? (part.partProperties?.explodeOnHit ?? part.baseComponent === "explosiveShell")
      : false;
    part.partType = partType;
    part.partCategory = partCategory;
    part.layer = partType === "structure" ? "structure" : "functional";
    const projectileClass = part.partProperties?.projectileClass
      ?? (partCategory === "missile" ? "missile" : partCategory === "beam" ? "laser" : "bullet");
    part.baseComponent = partType === "weapon"
      ? getComponentFromProjectileClass(projectileClass, weaponExplosive)
      : getComponentFromPartTypeAndCategory(partType, partCategory, weaponExplosive);
    if (!part.partProperties) {
      part.partProperties = getPartPropertiesDefaultsByType(partType, partCategory);
    }
    if (partType === "weapon") {
      part.partProperties.explodeOnHit = weaponExplosive;
      part.partProperties.projectileClass = projectileClass;
      part.properties = { ...(part.properties ?? {}), projectileClass };
    }
  };

  const syncPartMetaDefaultsIfNotEdited = (): void => {
    const suggested = getConfiguredPartMetadataDefaultsForLayer(partDesignerDraft.layer, partDesignerDraft.baseComponent);
    const current = partDesignerDraft.properties ?? {};
    partDesignerDraft.properties = {
      ...current,
      category: partDesignerCategoryEdited ? current.category : suggested.category,
      subcategory: partDesignerSubcategoryEdited ? current.subcategory : suggested.subcategory,
    };
  };

  const applyPartMetadataDefaults = (part: PartDefinition): PartDefinition => {
    syncPartTypeAndComponent(part);
    const defaults = getPartPropertyDefaults(part.baseComponent);
    const metaDefaults = getConfiguredPartMetadataDefaultsForLayer(part.layer, part.baseComponent);
    const materialDefaults = part.layer === "structure" ? getMaterialDefaultsForPart(part) : null;
    const hasCoreTuningOverrides = part.stats?.mass !== undefined || part.stats?.hpMul !== undefined;
    return {
      ...part,
      stats: {
        ...(part.stats ?? {}),
        ...(materialDefaults
          ? {
              mass: part.stats?.mass ?? materialDefaults.mass,
            }
          : {}),
      },
      properties: {
        category: part.properties?.category ?? metaDefaults.category,
        subcategory: part.properties?.subcategory ?? metaDefaults.subcategory,
        materialArmor: part.properties?.materialArmor ?? materialDefaults?.materialArmor,
        materialRecoverPerSecond: part.properties?.materialRecoverPerSecond ?? materialDefaults?.materialRecoverPerSecond,
        materialColor: part.properties?.materialColor ?? materialDefaults?.materialColor,
        materialAlpha: part.properties?.materialAlpha ?? 1,
        hp: part.properties?.hp ?? materialDefaults?.hp,
        isEngine: part.properties?.isEngine ?? defaults.isEngine,
        isWeapon: part.properties?.isWeapon ?? defaults.isWeapon,
        isLoader: part.properties?.isLoader ?? defaults.isLoader,
        isArmor: part.layer === "structure" ? true : (part.properties?.isArmor ?? defaults.isArmor),
        engineType: part.properties?.engineType ?? defaults.engineType,
        projectileClass: part.properties?.projectileClass ?? defaults.projectileClass,
        loaderServesTags: part.properties?.loaderServesTags ?? defaults.loaderServesTags,
        loaderCooldownMultiplier: part.properties?.loaderCooldownMultiplier ?? defaults.loaderCooldownMultiplier,
        hasCoreTuning: part.properties?.hasCoreTuning ?? hasCoreTuningOverrides,
      },
    };
  };

  const updateSelectedInfo = (): void => {
    if (isEditorScreen()) {
      if (isPartEditorScreen()) {
        const selectedSlot = partDesignerSelectedSlot;
        const selectedCoord = selectedSlot !== null ? slotToCoord(selectedSlot) : null;
        const selectedEntry = selectedSlot !== null ? partDesignerSlots[selectedSlot] : null;
        const resolvedEntry = selectedEntry ?? {
          occupiesStructureSpace: partDesignerDraft.layer === "structure",
          occupiesFunctionalSpace: partDesignerDraft.layer !== "structure",
          needsStructureBehind: partDesignerDraft.layer !== "structure",
          takesDamage: true,
          isAttachPoint: false,
          isShootingPoint: false,
        };
        const needsStructureBehindEnabled = !resolvedEntry.isAttachPoint && !resolvedEntry.occupiesStructureSpace && resolvedEntry.occupiesFunctionalSpace;
        selectedInfo.innerHTML = `
          <div><strong>Part Designer</strong></div>
          <div class="small">Part: ${partDesignerDraft.name} (${partDesignerDraft.id})</div>
          <div class="small">Layer: ${partDesignerDraft.layer} | Type: ${partDesignerDraft.partType ?? getPartTypeFromComponent(partDesignerDraft.baseComponent)} | Category: ${partDesignerDraft.partCategory ?? "n/a"} | Placement rotates facing: ${partDesignerDraft.directional ? "yes" : "no"} | Base facing: ${partDesignerDraft.direction ?? getPartDirectionDefault(partDesignerDraft.baseComponent)}</div>
          <div class="small">Cells: ${partDesignerDraft.boxes.length} | Anchor: (${partDesignerDraft.anchor.x},${partDesignerDraft.anchor.y})</div>
          <div class="row">
            <label class="small">Tool
              <select id="partToolRight">
                <option value="select" ${partDesignerTool === "select" ? "selected" : ""}>Select/Create</option>
                <option value="paintFunctional" ${partDesignerTool === "paintFunctional" ? "selected" : ""}>Paint Functional</option>
                <option value="paintStructure" ${partDesignerTool === "paintStructure" ? "selected" : ""}>Paint Structure</option>
                <option value="paintDamage" ${partDesignerTool === "paintDamage" ? "selected" : ""}>Paint Damageable</option>
                <option value="setAnchor" ${partDesignerTool === "setAnchor" ? "selected" : ""}>Set Anchor</option>
                <option value="markSupport" ${partDesignerTool === "markSupport" ? "selected" : ""}>Mark Support Offset</option>
                <option value="markEmptyStructure" ${partDesignerTool === "markEmptyStructure" ? "selected" : ""}>Mark Empty Structure</option>
                <option value="markEmptyFunctional" ${partDesignerTool === "markEmptyFunctional" ? "selected" : ""}>Mark Empty Functional</option>
                <option value="erase" ${partDesignerTool === "erase" ? "selected" : ""}>Erase</option>
              </select>
            </label>
          </div>
          <div class="small">Selected box: ${selectedCoord ? `(${selectedCoord.x},${selectedCoord.y})` : "none"}</div>
          <div class="small">${selectedEntry ? "Box exists and can be edited below." : "No box at selected cell yet."}</div>
          <div class="row">
            <label class="small"><input id="partBoxOccupiesStructure" type="checkbox" ${resolvedEntry.occupiesStructureSpace ? "checked" : ""} ${selectedSlot === null ? "disabled" : ""} /> Structure occupy</label>
            <label class="small"><input id="partBoxOccupiesFunctional" type="checkbox" ${resolvedEntry.occupiesFunctionalSpace ? "checked" : ""} ${selectedSlot === null ? "disabled" : ""} /> Functional occupy</label>
          </div>
          <div class="row">
            <label class="small"><input id="partBoxNeedsStructureBehind" type="checkbox" ${resolvedEntry.needsStructureBehind ? "checked" : ""} ${selectedSlot === null || !needsStructureBehindEnabled ? "disabled" : ""} /> Need structure behind</label>
            <label class="small"><input id="partBoxTakeDamage" type="checkbox" ${resolvedEntry.takesDamage ? "checked" : ""} ${selectedSlot === null ? "disabled" : ""} /> Take damage</label>
          </div>
          <div class="row">
            <label class="small"><input id="partBoxAttachPoint" type="checkbox" ${resolvedEntry.isAttachPoint ? "checked" : ""} ${selectedSlot === null ? "disabled" : ""} /> Attach point</label>
            <label class="small"><input id="partBoxAnchor" type="checkbox" ${selectedSlot !== null && partDesignerAnchorSlot === selectedSlot ? "checked" : ""} ${selectedSlot === null ? "disabled" : ""} /> Anchor point</label>
            ${(getResolvedPartType(partDesignerDraft) === "weapon")
              ? `<label class="small"><input id="partBoxShootingPoint" type="checkbox" ${resolvedEntry.isShootingPoint ? "checked" : ""} ${selectedSlot === null ? "disabled" : ""} /> Fire point (unique)</label>`
              : ""}
          </div>
        `;
        return;
      }
      ensureEditorSelectionForLayer();
      const catalog = getEditorCatalogItems();
      const renderPaletteCard = (item: EditorCatalogItem): string => {
        const selectedClass = item.value === editorSelection ? "selected" : "";
        return `<button class="editor-comp-card ${selectedClass}" data-comp-value="${item.value}" data-comp-detail="${item.detail}" data-comp-title="${item.title}" title="${item.title}">
          <span class="editor-thumb ${editorLayer === "functional" ? "functional" : ""}">${item.thumb}</span>
          <span class="editor-comp-name">${item.title}</span>
        </button>`;
      };
      const paletteContent = editorLayer === "functional"
        ? (["control", "engine", "weapon", "loader"] as const).map((partType) => {
            const typeItems = catalog.filter((item) => {
              if (typeof item.value !== "number") {
                return false;
              }
              const part = parts.find((candidate) => candidate.id === item.value);
              return part ? getResolvedPartType(part) === partType : false;
            });
            if (typeItems.length === 0) {
              return "";
            }
            return `<section class="editor-comp-group">
              <div class="editor-comp-group-title">${partType}</div>
              <div class="editor-comp-grid">${typeItems.map(renderPaletteCard).join("")}</div>
            </section>`;
          }).join("")
        : `<div class="editor-comp-grid">${catalog.map(renderPaletteCard).join("")}</div>`;
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
        ${editorLayer === "structure" ? `<div class="row"><label class="small">Block color <input id="editorStructureColor" type="color" value="${editorStructureColor}" title="Tint the selected structure block when placing it" /></label></div>` : ""}
        <div class="editor-comp-scroll">
          ${paletteContent}
        </div>
      `;
      return;
    }
    if (screen === "base") {
      const economy = getIncomeAndUpkeep(base, mapNodes);
      selectedInfo.innerHTML = `<div class="inspector-stack"><div class="sidebar-metric"><span>Main base</span><strong>Operational</strong></div><div class="sidebar-metric"><span>Income</span><strong class="good">+${economy.income}</strong></div><div class="sidebar-metric"><span>Delivery cap</span><strong>${campaign.getDeliveryCapacity()}</strong></div><div class="sidebar-metric"><span>Projects</span><strong>${campaign.jobs.length}</strong></div></div>`;
      return;
    }
    if (screen === "map") {
      const playerNodes = mapNodes.filter((node) => node.owner === "player").length;
      const hostileNodes = mapNodes.filter((node) => node.owner === "enemy").length;
      selectedInfo.innerHTML = `<div class="inspector-stack"><div class="sidebar-metric"><span>Controlled sectors</span><strong class="good">${playerNodes}</strong></div><div class="sidebar-metric"><span>Hostile sectors</span><strong class="bad">${hostileNodes}</strong></div><div class="sidebar-metric"><span>Neutral sectors</span><strong class="warn">${mapNodes.length - playerNodes - hostileNodes}</strong></div><div class="small" style="margin-top:10px;">Select a map node to review defense and launch an operation.</div></div>`;
      return;
    }
    if (screen === "craftArena") {
      const scenario = craftArenaScenarios.find((entry) => entry.id === craftArenaSelectedScenarioId);
      if (!scenario) {
        selectedInfo.innerHTML = `<span class="small">Select a heat-map cell to inspect both craft results.</span>`;
        return;
      }
      const craftA = templates.find((template) => template.id === scenario.craftAId);
      const craftB = templates.find((template) => template.id === scenario.craftBId);
      const result = scenario.result;
      selectedInfo.innerHTML = `
        <div class="craft-matchup-inspector">
          <div class="craft-matchup-inspector-heading"><strong>${escapeHtml(craftA?.name ?? `Missing craft ${scenario.craftAId}`)}</strong><span>vs</span><strong>${escapeHtml(craftB?.name ?? `Missing craft ${scenario.craftBId}`)}</strong></div>
          <div class="small">${craftArenaSettings.quantity} vs ${craftArenaSettings.quantity} · ${craftArenaSettings.durationMinutes} minutes · immediate replenishment</div>
          ${result ? `
            <div class="craft-matchup-side-stat"><span>Craft A · Left</span><strong>${result.craftA.destroyed} destroyed</strong><small>${result.craftA.gasWasted.toFixed(0)} gas wasted</small></div>
            <div class="craft-matchup-side-stat"><span>Craft B · Right</span><strong>${result.craftB.destroyed} destroyed</strong><small>${result.craftB.gasWasted.toFixed(0)} gas wasted</small></div>
            <div class="sidebar-metric"><span>Destroyed difference</span><strong>${Math.abs(result.craftA.destroyed - result.craftB.destroyed)}</strong></div>
            <div class="sidebar-metric"><span>Gas-waste difference</span><strong>${Math.abs(result.craftA.gasWasted - result.craftB.gasWasted).toFixed(0)}</strong></div>
            <div class="small">Completed ${escapeHtml(new Date(result.completedAt).toLocaleString())} · ${result.simSecondsElapsed.toFixed(0)} simulated seconds</div>
          ` : `<div class="small">${scenario.busy ? "Simulation running…" : "This matchup has no result for the current global settings."}</div>`}
          ${scenario.error ? `<div class="small warn">${escapeHtml(scenario.error)}</div>` : ""}
          <button id="btnRunSelectedCraftMatchup" class="button-primary" ${scenario.busy ? "disabled" : ""}>${scenario.busy ? "Running…" : "Run this matchup"}</button>
        </div>
      `;
      return;
    }
    if (!isBattleScreen()) {
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
      const weaponName = parts.find((part) => part.id === attachment.partId)?.name ?? attachment.component;
      const mode = selected.weaponAutoFire[index] ? "auto" : "manual";
      const control = selected.weaponManualControl[index] !== false ? "ctrl" : "free";
      const selectedMark = index === selected.selectedWeaponIndex ? "*" : "";
      return `${selectedMark}#${index + 1}: ${escapeHtml(weaponName)} (${weaponType}, ${mode}, ${control})`;
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
    if (isEditorScreen()) {
      if (isPartEditorScreen()) {
        weaponHud.innerHTML = `<div><strong>Part Designer</strong></div><div class="small">Tool=${partDesignerTool}. Left-click applies the selected tool, right-click erases a box, right-drag pans, and wheel zooms. Q/E rotates the functional facing or a multi-cell footprint when allowed.</div>`;
      } else {
        weaponHud.innerHTML = `<div class="small">${editorLayer} | ${editorDeleteMode ? "delete" : "place"} | Left: apply | Right: remove | Drag: pan | Wheel: zoom${isCurrentEditorSelectionRotatable() ? " | Q: rotate 90° counterclockwise | E: rotate 90° clockwise" : ""}</div>`;
      }
      return;
    }
    if (!isBattleScreen()) {
      weaponHud.innerHTML = `<div class="small">Weapon Control - enter battle or test arena to activate.</div>`;
      return;
    }
    const selection = battle.getSelection();
    const controlled = battle.getState().units.find((unit) => unit.id === selection.playerControlledId && unit.alive && unit.side === "player");
    if (!controlled || controlled.weaponAttachmentIds.length === 0) {
      weaponHud.innerHTML = `<div><strong>Weapon Control</strong> - Press 1..9 to toggle manual control, Shift+1..9 to toggle auto fire</div><div class="small">No controlled weapon system.</div>`;
      return;
    }

    const chips = controlled.weaponAttachmentIds.map((weaponId, index) => {
      const attachment = controlled.attachments.find((entry) => entry.id === weaponId && entry.alive) ?? null;
      const manualControl = controlled.weaponManualControl[index] !== false;
      const chipClass = manualControl ? "weapon-chip controlled" : "weapon-chip";
      const auto = controlled.weaponAutoFire[index] ? "AUTO" : "MANUAL";
      const control = manualControl ? "CTRL" : "FREE";
      const label = attachment
        ? escapeHtml(parts.find((part) => part.id === attachment.partId)?.name ?? attachment.component)
        : "destroyed";
      const timer = controlled.weaponFireTimers[index] ?? 0;
      const cooldown = attachment ? (attachment.stats?.cooldown ?? COMPONENTS[attachment.component].cooldown ?? 0) : 0;
      const cooldownPct = cooldown > 0 ? Math.max(0, Math.min(100, ((cooldown - timer) / cooldown) * 100)) : 100;
      const cooldownText = timer > 0.01 ? `${timer.toFixed(2)}s` : "ready";
      const part = attachment ? parts.find((entry) => entry.id === attachment.partId) : undefined;
      const loaderManaged = part?.partProperties?.needLoader
        ?? (
          attachment?.component === "heavyCannon"
          || attachment?.component === "explosiveShell"
          || attachment?.component === "trackingMissile"
        );
      const charges = controlled.weaponReadyCharges[index] ?? 0;
      const capacity = Math.max(
        1,
        Math.floor(part?.partProperties?.maxCapacity ?? (attachment ? COMPONENTS[attachment.component].maxLoadedAmmo : 1) ?? 1),
      );
      const loadTimer = controlled.weaponLoadTimers[index] ?? 0;
      const ammoText = ` | ammo ${charges}/${capacity}`;
      const loaderText = ` | load ${loadTimer > 0.01 ? `${loadTimer.toFixed(2)}s` : "idle"}${loaderManaged ? " (loader)" : ""}`;
      return `<span class="${chipClass}">[${index + 1}] ${label} ${control} | ${auto} | ${cooldownText} (${cooldownPct.toFixed(0)}%)${ammoText}${loaderText}</span>`;
    }).join("");

    weaponHud.innerHTML = `
      <div><strong>Weapon Control</strong> - Press 1..9 to toggle manual control, Shift+1..9 to toggle auto fire</div>
      <div class="small">CTRL slots suppress auto fire while control remains enabled.</div>
      <div class="weapon-row">${chips}</div>
    `;

    if (debugVisual) {
      const isTestArenaActive = battle.getState().active && battle.getState().nodeId === testArenaNode.id;
      const aiRows = battle.getState().units
        .filter((unit) => unit.alive && (isTestArenaActive ? true : unit.side === "enemy"))
        .slice(0, isTestArenaActive ? 12 : 6)
        .map((unit) => {
          const angleDeg = (unit.aiDebugLastAngleRad * 180 / Math.PI).toFixed(1);
          const target = unit.aiDebugTargetId ?? "base";
          const slot = unit.aiDebugPreferredWeaponSlot >= 0 ? `${unit.aiDebugPreferredWeaponSlot + 1}` : "-";
          const lead = unit.aiDebugLeadTimeS > 0 ? `${unit.aiDebugLeadTimeS.toFixed(2)}s` : "-";
          const blocked = unit.aiDebugFireBlockReason ?? "none";
          return `<div class="small">[${unit.side}] ${unit.name}: ${unit.aiState}${unit.aiDebugShouldEvade ? "(evade)" : ""}, target=${target}, slot=${slot}, angle=${angleDeg}deg, range=${unit.aiDebugLastRange.toFixed(0)}, lead=${lead}, block=${blocked}, v=(${unit.vx.toFixed(1)},${unit.vy.toFixed(1)}), tree=${unit.aiDebugDecisionPath}</div>`;
        }).join("");
      weaponHud.innerHTML += `<div class="ai-debug"><strong>AI Live Debug</strong>${aiRows || `<div class="small">No active units.</div>`}</div>`;
    }
  };

  const updateBattleOpsInfo = (): void => {
    const activeInfo = getOptionalElement<HTMLDivElement>("#friendlyActive");
    if (!activeInfo) {
      return;
    }
    const activeFriendly = battle.getState().units.filter((unit) => unit.type !== "base" && unit.side === "player" && unit.alive).length;
    const capText = isUnlimitedResources() ? "INF" : `${armyCap(getCommanderSkillForCap())}`;
    activeInfo.textContent = `Friendly active: ${activeFriendly} / ${capText}`;
  };

  type EditorCatalogItem = {
    value: string | number;
    title: string;
    subtitle: string;
    detail: string;
    thumb: string;
  };

  const getEditorGridRect = (): { x: number; y: number; cell: number } => {
    const drawCanvas = activeEditorCanvas();
    const cell = Math.max(8, 32 * editorViewScale);
    const halfWidth = drawCanvas.width * 0.5;
    const halfHeight = drawCanvas.height * 0.5;
    const gridHalfWidth = (editorGridCols * cell) * 0.5;
    const gridHalfHeight = (editorGridRows * cell) * 0.5;
    const keepVisibleMargin = 40;
    const minPanX = keepVisibleMargin - (halfWidth + gridHalfWidth);
    const maxPanX = (drawCanvas.width - keepVisibleMargin) - (halfWidth - gridHalfWidth);
    const minPanY = keepVisibleMargin - (halfHeight + gridHalfHeight);
    const maxPanY = (drawCanvas.height - keepVisibleMargin) - (halfHeight - gridHalfHeight);
    editorGridPanX = Math.max(minPanX, Math.min(maxPanX, editorGridPanX));
    editorGridPanY = Math.max(minPanY, Math.min(maxPanY, editorGridPanY));
    const x = Math.floor(drawCanvas.width * 0.5 - (editorGridCols * cell) / 2 + editorGridPanX);
    const y = Math.floor(drawCanvas.height * 0.5 - (editorGridRows * cell) / 2 + editorGridPanY);
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

  const getPartById = (partId: number): PartDefinition | null => {
    return parts.find((part) => part.id === partId) ?? null;
  };

  const resolvePartForSelection = (selection: string | number): PartDefinition | null => {
    if (typeof selection === "number") {
      const byId = getPartById(selection);
      if (byId) {
        return byId;
      }
      return null;
    }
    const byId = getPartById(Number.parseInt(selection, 10));
    if (byId) {
      return byId;
    }
    if (selection in COMPONENTS) {
      return resolvePartDefinitionForAttachment({ component: selection as ComponentId }, parts);
    }
    return null;
  };

  const getPartNameInitials = (name: string): string => {
    const tokens = name.match(/[A-Za-z0-9]+/g) ?? [];
    if (tokens.length <= 0) {
      return "?";
    }
    return tokens.map((token) => token.slice(0, 1).toUpperCase()).join("");
  };

  const getFunctionalShortLabel = (part: PartDefinition | null): string => {
    if (!part) {
      return "?.?";
    }
    return `${part.id}.${getPartNameInitials(part.name)}`;
  };

  const getFunctionalThumbGlyph = (part: PartDefinition): string => {
    const glyphs: Partial<Record<ComponentId, string>> = {
      control: "◇",
      engineM: "M⚙",
      engineS: "S⚙",
      jetEngine: "»",
      cannonLoader: "C≡",
      missileLoader: "M≡",
      rapidGun: part.id === 19 ? "╫" : "═",
      heavyCannon: "▰",
      explosiveShell: "✹",
      trackingMissile: "➤",
      precisionBeam: "◎",
    };
    return glyphs[part.baseComponent] ?? getPartNameInitials(part.name).slice(0, 2);
  };

  const drawFunctionalPartIcon = (
    context: CanvasRenderingContext2D,
    part: PartDefinition,
    centerX: number,
    centerY: number,
    size: number,
    facingQuarter: 0 | 1 | 2 | 3,
  ): void => {
    const component = part.baseComponent;
    const radius = size * 0.42;
    context.save();
    context.translate(centerX, centerY);
    context.rotate(facingQuarter * Math.PI / 2);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(1.2, size * 0.09);
    context.strokeStyle = "#fff0e8";
    context.fillStyle = "#d88468";
    if (component === "control") {
      context.beginPath();
      context.moveTo(0, -radius);
      context.lineTo(radius, 0);
      context.lineTo(0, radius);
      context.lineTo(-radius, 0);
      context.closePath();
      context.fill();
      context.stroke();
      context.beginPath();
      context.arc(0, 0, radius * 0.28, 0, Math.PI * 2);
      context.stroke();
    } else if (component === "engineM" || component === "engineS" || component === "jetEngine") {
      context.fillStyle = component === "jetEngine" ? "#69bde8" : "#62c491";
      context.fillRect(-radius, -radius * 0.65, radius * 1.45, radius * 1.3);
      context.strokeRect(-radius, -radius * 0.65, radius * 1.45, radius * 1.3);
      context.beginPath();
      context.moveTo(radius * 0.45, -radius * 0.5);
      context.lineTo(radius * 1.25, 0);
      context.lineTo(radius * 0.45, radius * 0.5);
      context.stroke();
    } else if (component === "cannonLoader" || component === "missileLoader") {
      context.fillStyle = "#d4a94f";
      context.fillRect(-radius, -radius, radius * 2, radius * 2);
      context.strokeRect(-radius, -radius, radius * 2, radius * 2);
      for (const y of [-0.45, 0, 0.45]) {
        context.beginPath();
        context.moveTo(-radius * 0.65, radius * y);
        context.lineTo(radius * 0.65, radius * y);
        context.stroke();
      }
    } else if (component === "trackingMissile") {
      context.fillStyle = "#ef9a69";
      context.beginPath();
      context.moveTo(radius, 0);
      context.lineTo(-radius * 0.8, -radius * 0.55);
      context.lineTo(-radius * 0.45, 0);
      context.lineTo(-radius * 0.8, radius * 0.55);
      context.closePath();
      context.fill();
      context.stroke();
    } else if (component === "precisionBeam") {
      context.fillStyle = "#79dcf5";
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.beginPath();
      context.arc(0, 0, radius * 0.42, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(radius, 0);
      context.lineTo(radius * 1.5, 0);
      context.stroke();
    } else {
      context.fillStyle = component === "explosiveShell" ? "#ef7b4e" : "#d68f77";
      context.beginPath();
      context.arc(-radius * 0.35, 0, radius * 0.55, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.fillRect(0, -radius * 0.22, radius * 1.35, radius * 0.44);
      context.strokeRect(0, -radius * 0.22, radius * 1.35, radius * 0.44);
      if (component === "rapidGun") {
        context.beginPath();
        context.moveTo(0, -radius * 0.48);
        context.lineTo(radius * 1.35, -radius * 0.48);
        context.stroke();
      }
    }
    context.restore();
  };

  const getEditorSlotFromCanvasPoint = (
    mouseX: number,
    mouseY: number,
  ): {
    slot: number;
    row: number;
    col: number;
  } | null => {
    const grid = getEditorGridRect();
    const relX = mouseX - grid.x;
    const relY = mouseY - grid.y;
    if (relX < 0 || relY < 0 || relX >= grid.cell * editorGridCols || relY >= grid.cell * editorGridRows) {
      return null;
    }
    const col = Math.floor(relX / grid.cell);
    const row = Math.floor(relY / grid.cell);
    return { slot: row * editorGridCols + col, row, col };
  };

  const resolvePlacementAnchorSlotByTargetSlot = (
    targetSlot: number,
    part: PartDefinition,
    rotateQuarter: 0 | 1 | 2 | 3,
  ): number | null => {
    if (!editorPlaceByCenter) {
      return targetSlot;
    }
    const centerCells = getPartFootprintOffsets(part, normalizePartAttachmentRotate(part, rotateQuarter));
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    if (centerCells.length > 0) {
      minX = centerCells[0]?.x ?? 0;
      maxX = centerCells[0]?.x ?? 0;
      minY = centerCells[0]?.y ?? 0;
      maxY = centerCells[0]?.y ?? 0;
    }
    for (const cell of centerCells) {
      minX = Math.min(minX, cell.x);
      maxX = Math.max(maxX, cell.x);
      minY = Math.min(minY, cell.y);
      maxY = Math.max(maxY, cell.y);
    }
    const centerOffsetX = Math.round((minX + maxX) * 0.5);
    const centerOffsetY = Math.round((minY + maxY) * 0.5);
    const clickCoord = slotToCoord(targetSlot);
    return coordToSlot(clickCoord.x - centerOffsetX, clickCoord.y - centerOffsetY);
  };

  const resolveFunctionalPlacementAttempt = (
    targetSlot: number,
    part: PartDefinition,
    rotateQuarter: 0 | 1 | 2 | 3,
  ): {
    ok: true;
    anchorSlot: number;
    placement: {
      slots: Array<{
        slot: number;
        occupiesStructureSpace: boolean;
        occupiesFunctionalSpace: boolean;
        needsStructureBehind: boolean;
        isAttachPoint: boolean;
        isShootingPoint: boolean;
        takesDamage: boolean;
        takesFunctionalDamage: boolean;
        offsetX: number;
        offsetY: number;
      }>;
      anchorCoord: { x: number; y: number };
    };
  } | {
    ok: false;
    reason: string;
  } => {
    const anchorSlot = resolvePlacementAnchorSlotByTargetSlot(targetSlot, part, rotateQuarter);
    if (anchorSlot === null) {
      return { ok: false, reason: "Centered placement is out of editor bounds" };
    }
    const placement = getFootprintSlots(anchorSlot, part, rotateQuarter);
    if (!placement || placement.slots.length <= 0) {
      return { ok: false, reason: "Part footprint out of editor bounds" };
    }
    const check = validateFunctionalPlacement(part, rotateQuarter, anchorSlot, placement.slots, placement.anchorCoord);
    if (!check.ok) {
      return { ok: false, reason: check.reason ?? "Invalid component placement" };
    }
    return { ok: true, anchorSlot, placement };
  };

  const getFootprintSlots = (
    anchorSlot: number,
    part: PartDefinition,
    rotateQuarter: 0 | 1 | 2 | 3,
  ): {
    slots: Array<{
      slot: number;
      occupiesStructureSpace: boolean;
      occupiesFunctionalSpace: boolean;
      needsStructureBehind: boolean;
      isAttachPoint: boolean;
      isShootingPoint: boolean;
      takesDamage: boolean;
      takesFunctionalDamage: boolean;
      offsetX: number;
      offsetY: number;
    }>;
    anchorCoord: { x: number; y: number };
  } | null => {
    const anchor = slotToCoord(anchorSlot);
    const normalizedRotate = normalizePartAttachmentRotate(part, rotateQuarter);
    const offsets = getPartFootprintOffsets(part, normalizedRotate);
    const slots: Array<{
      slot: number;
      occupiesStructureSpace: boolean;
      occupiesFunctionalSpace: boolean;
      needsStructureBehind: boolean;
      isAttachPoint: boolean;
      isShootingPoint: boolean;
      takesDamage: boolean;
      takesFunctionalDamage: boolean;
      offsetX: number;
      offsetY: number;
    }> = [];
    for (const offset of offsets) {
      const slot = coordToSlot(anchor.x + offset.x, anchor.y + offset.y);
      if (slot === null) {
        return null;
      }
      slots.push({
        slot,
        occupiesStructureSpace: offset.occupiesStructureSpace,
        occupiesFunctionalSpace: offset.occupiesFunctionalSpace,
        needsStructureBehind: offset.needsStructureBehind,
        isAttachPoint: offset.isAttachPoint,
        isShootingPoint: offset.isShootingPoint,
        takesDamage: offset.takesDamage,
        takesFunctionalDamage: offset.takesFunctionalDamage,
        offsetX: offset.x,
        offsetY: offset.y,
      });
    }
    return { slots, anchorCoord: anchor };
  };

  const getPlacementOffsets = (
    part: PartDefinition,
    rotateQuarter: 0 | 1 | 2 | 3,
    mode: "support" | "emptyStructure" | "emptyFunctional",
  ): Array<{ x: number; y: number }> => {
    if (mode === "support") {
      return (part.placement?.requireStructureOffsets ?? []).map((offset) => rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter));
    }
    if (mode === "emptyStructure") {
      return (part.placement?.requireEmptyStructureOffsets ?? []).map((offset) => rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter));
    }
    return (part.placement?.requireEmptyFunctionalOffsets ?? []).map((offset) => rotateOffsetByQuarter(offset.x, offset.y, rotateQuarter));
  };

  const validateFunctionalPlacement = (
    part: PartDefinition,
    rotateQuarter: 0 | 1 | 2 | 3,
    anchorSlot: number,
    footprintSlots: Array<{
      slot: number;
      occupiesStructureSpace: boolean;
      occupiesFunctionalSpace: boolean;
      needsStructureBehind: boolean;
      isAttachPoint: boolean;
      isShootingPoint: boolean;
      takesDamage: boolean;
      takesFunctionalDamage: boolean;
    }>,
    anchorCoord: { x: number; y: number },
  ): { ok: boolean; reason: string | null } => {
    const currentGroupId = editorFunctionalSlots[anchorSlot]?.groupId ?? -1;

    for (const footprint of footprintSlots) {
      if (footprint.occupiesStructureSpace && editorStructureSlots[footprint.slot]) {
        return { ok: false, reason: "Structure occupied boxes require empty structure space" };
      }
      const existing = editorFunctionalSlots[footprint.slot];
      if (footprint.occupiesFunctionalSpace && existing && existing.groupId !== currentGroupId) {
        return { ok: false, reason: "Functional occupied boxes overlap another component" };
      }
    }

    const requiredEmptyStructureOffsets = getPlacementOffsets(part, rotateQuarter, "emptyStructure");
    for (const offset of requiredEmptyStructureOffsets) {
      const requiredSlot = coordToSlot(anchorCoord.x + offset.x, anchorCoord.y + offset.y);
      if (requiredSlot === null) {
        return { ok: false, reason: "Component clearance extends beyond editor bounds" };
      }
      if (editorStructureSlots[requiredSlot]) {
        return { ok: false, reason: "Required clearance area must be empty of structure" };
      }
    }

    const requiredEmptyFunctionalOffsets = getPlacementOffsets(part, rotateQuarter, "emptyFunctional");
    for (const offset of requiredEmptyFunctionalOffsets) {
      const requiredSlot = coordToSlot(anchorCoord.x + offset.x, anchorCoord.y + offset.y);
      if (requiredSlot === null) {
        return { ok: false, reason: "Functional clearance extends beyond editor bounds" };
      }
      if (editorFunctionalSlots[requiredSlot] && editorFunctionalSlots[requiredSlot]?.groupId !== currentGroupId) {
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
    const oldStructureColors = editorStructureColorSlots.slice();
    const oldFunctional = editorFunctionalSlots.slice();
    const oldDisplay = editorDisplaySlots.slice();

    const nextStructure = new Array<number | null>(EDITOR_GRID_MAX_SIZE).fill(null);
    const nextStructureColors = new Array<string | null>(EDITOR_GRID_MAX_SIZE).fill(null);
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
        nextStructureColors[newSlot] = oldStructureColors[oldSlot] ?? null;
        nextFunctional[newSlot] = oldFunctional[oldSlot] ?? null;
        nextDisplay[newSlot] = oldDisplay[oldSlot] ?? null;
      }
    }

    editorGridCols = clampedCols;
    editorGridRows = clampedRows;
    editorStructureSlots = nextStructure;
    editorStructureColorSlots = nextStructureColors;
    editorFunctionalSlots = nextFunctional;
    editorDisplaySlots = nextDisplay;
    recalcEditorDraftFromSlots();
  };

  const getDirectionQuarter = (direction: PartDirection | undefined): 0 | 1 | 2 | 3 => {
    if (direction === "down") {
      return 1;
    }
    if (direction === "left") {
      return 2;
    }
    if (direction === "up") {
      return 3;
    }
    return 0;
  };

  const getDirectionalFacingQuarter = (
    part: PartDefinition | null,
    rotateQuarter: 0 | 1 | 2 | 3,
  ): 0 | 1 | 2 | 3 => {
    const baseQuarter = getDirectionQuarter(part?.direction ?? "right");
    return ((baseQuarter + rotateQuarter) % 4) as 0 | 1 | 2 | 3;
  };

  const getRotationSymbol = (rotateQuarter: 0 | 1 | 2 | 3): string => {
    if (rotateQuarter === 0) {
      return "->";
    }
    if (rotateQuarter === 1) {
      return "v";
    }
    if (rotateQuarter === 2) {
      return "<-";
    }
    return "^";
  };

  const isDirectionalPart = (part: PartDefinition | null): boolean => {
    if (!part) {
      return false;
    }
    return part.directional ?? COMPONENTS[part.baseComponent].directional === true;
  };

  const shouldShowTemplateDirectionForPart = (part: PartDefinition | null): boolean => {
    if (!part) {
      return false;
    }
    return isDirectionalPart(part) || COMPONENTS[part.baseComponent].type === "weapon";
  };

  const isCurrentEditorSelectionRotatable = (): boolean => {
    if (editorLayer !== "functional") {
      return false;
    }
    const part = resolvePartForSelection(editorSelection);
    return part !== null && (isDirectionalPart(part) || getPartFootprintOffsets(part, 0).length > 1);
  };

  const getEditorCatalogItems = (): EditorCatalogItem[] => {
    if (editorLayer === "structure") {
      return parts
        .filter((part) => part.layer === "structure")
        .map((part) => {
          const stats = getStructurePartStats(part.id);
          return {
            value: part.id,
            title: part.name,
            subtitle: String(part.id),
            detail: `Mass ${stats.mass.toFixed(2)} | Armor ${stats.armor.toFixed(2)} | HP ${stats.hp.toFixed(0)} | Recover ${stats.recoverPerSecond.toFixed(1)}/s`,
            thumb: String(part.id).slice(0, 2).toUpperCase(),
          };
        });
    }
    if (editorLayer === "functional") {
      const functionalParts = parts.filter((part) => part.layer === "functional" && isPartCompatibleWithUnitType(part, editorDraft.type));
      const hasExplicitByBase = new Set<ComponentId>();
      for (const part of functionalParts) {
        const isImplicitFallback = (part.tags ?? []).includes("implicit");
        if (!isImplicitFallback) {
          hasExplicitByBase.add(part.baseComponent);
        }
      }
      return functionalParts.filter((part) => {
        const isImplicitFallback = (part.tags ?? []).includes("implicit");
        if (!isImplicitFallback) {
          return true;
        }
        return !hasExplicitByBase.has(part.baseComponent);
      }).map((part) => {
        const stats = COMPONENTS[part.baseComponent];
        const rotateHint = isDirectionalPart(part) ? " | Supports 90deg rotate" : "";
        const footprint = getPartFootprintOffsets(part, 0);
        const hasStructureSpace = footprint.some((cell) => cell.occupiesStructureSpace);
        const hasDamageableBox = footprint.some((cell) => cell.takesDamage);
        return {
          value: part.id,
          title: part.name,
          subtitle: `${stats.type}/${part.baseComponent}`,
          detail: `Base ${part.baseComponent} | Boxes ${footprint.length} | StructSpace ${hasStructureSpace ? "yes" : "no"} | Damageable ${hasDamageableBox ? "yes" : "no"}${rotateHint}`,
          thumb: getFunctionalThumbGlyph(part),
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

  const recomputeEditorDraftGasCost = (): number => {
    const computed = computeTemplateGasCost(editorDraft, parts);
    editorDraft.gasCost = computed;
    return computed;
  };

  const recalcEditorDraftFromSlots = (): void => {
    const slotToCell = new Map<number, number>();
    const structure = editorStructureSlots
      .map((partId, slotIndex) => ({ partId, slotIndex }))
      .filter((entry): entry is { partId: number; slotIndex: number } => entry.partId !== null)
      .sort((a, b) => a.slotIndex - b.slotIndex);

    editorDraft.structure = structure.map((entry, index) => {
      slotToCell.set(entry.slotIndex, index);
      const coord = slotToCoord(entry.slotIndex);
      const defaultColor = getStructurePartStats(entry.partId).color;
      const selectedColor = editorStructureColorSlots[entry.slotIndex];
      return {
        partId: entry.partId,
        x: coord.x,
        y: coord.y,
        color: selectedColor && selectedColor.toLowerCase() !== defaultColor.toLowerCase() ? selectedColor : undefined,
      };
    });

    editorDraft.attachments = editorFunctionalSlots
      .map((entry, slotIndex) => ({ entry, slotIndex }))
      .filter((item): item is {
        entry: { component: ComponentId; partId?: number; rotateQuarter: 0 | 1 | 2 | 3; groupId: number; isAnchor: boolean };
        slotIndex: number;
      } => item.entry !== null && item.entry.isAnchor)
      .map((entry) => ({
        component: entry.entry.component,
        partId: entry.entry.partId,
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

    recomputeEditorDraftGasCost();
  };

  const createDefaultPartDesignerSlot = (layer: PartDefinition["layer"]): NonNullable<PartDesignerSlot> => ({
    occupiesFunctionalSpace: layer !== "structure",
    occupiesStructureSpace: layer === "structure",
    needsStructureBehind: layer !== "structure",
    takesDamage: true,
    isAttachPoint: false,
    isShootingPoint: false,
  });

  const clonePartDesignerSlot = (slot: NonNullable<PartDesignerSlot>): NonNullable<PartDesignerSlot> => ({
    occupiesFunctionalSpace: slot.occupiesFunctionalSpace,
    occupiesStructureSpace: slot.occupiesStructureSpace,
    needsStructureBehind: slot.needsStructureBehind,
    takesDamage: slot.takesDamage,
    isAttachPoint: slot.isAttachPoint,
    isShootingPoint: slot.isShootingPoint,
  });

  const normalizePartDesignerSlotForLayer = (
    slot: NonNullable<PartDesignerSlot>,
    layer: PartDefinition["layer"],
  ): NonNullable<PartDesignerSlot> => {
    const next = clonePartDesignerSlot(slot);
    if (next.isAttachPoint) {
      next.occupiesStructureSpace = false;
      next.occupiesFunctionalSpace = false;
      next.needsStructureBehind = false;
      return next;
    }
    if (layer === "structure") {
      next.occupiesStructureSpace = true;
      next.occupiesFunctionalSpace = false;
      next.needsStructureBehind = false;
      next.isShootingPoint = false;
      return next;
    }
    if (!next.occupiesStructureSpace && !next.occupiesFunctionalSpace) {
      next.occupiesFunctionalSpace = true;
    }
    next.needsStructureBehind = next.needsStructureBehind && !next.occupiesStructureSpace && next.occupiesFunctionalSpace;
    return next;
  };

  const setPartDesignerBrushFromSlot = (slot: NonNullable<PartDesignerSlot>): void => {
    partDesignerBrushSlot = normalizePartDesignerSlotForLayer(slot, partDesignerDraft.layer);
  };

  const ensurePartDesignerSlot = (slot: number): NonNullable<PartDesignerSlot> => {
    const current = partDesignerSlots[slot];
    if (current) {
      return current;
    }
    const next = normalizePartDesignerSlotForLayer(partDesignerBrushSlot, partDesignerDraft.layer);
    partDesignerSlots[slot] = next;
    return next;
  };

  const recalcPartDraftFromSlots = (): void => {
    if (partDesignerAnchorSlot === null) {
      const firstSlot = partDesignerSlots.findIndex((entry) => entry !== null);
      if (firstSlot >= 0) {
        partDesignerAnchorSlot = firstSlot;
      }
    }
    if (partDesignerSelectedSlot === null) {
      partDesignerSelectedSlot = partDesignerAnchorSlot;
    }
    const anchorCoord = partDesignerAnchorSlot !== null ? slotToCoord(partDesignerAnchorSlot) : { x: 0, y: 0 };
    const boxes = partDesignerSlots
      .map((entry, slotIndex) => ({ entry, slotIndex }))
      .filter((item): item is { entry: NonNullable<PartDesignerSlot>; slotIndex: number } => item.entry !== null)
      .map((item) => {
        const coord = slotToCoord(item.slotIndex);
        const needsStructureBehind = item.entry.needsStructureBehind
          && !item.entry.occupiesStructureSpace
          && item.entry.occupiesFunctionalSpace;
        return {
          x: coord.x,
          y: coord.y,
          occupiesFunctionalSpace: item.entry.occupiesFunctionalSpace,
          occupiesStructureSpace: item.entry.occupiesStructureSpace,
          needsStructureBehind,
          isAttachPoint: item.entry.isAttachPoint,
          isAnchorPoint: partDesignerAnchorSlot === item.slotIndex,
          isShootingPoint: item.entry.isShootingPoint,
          takesDamage: item.entry.takesDamage,
          takesFunctionalDamage: item.entry.takesDamage,
        };
      });
    if (boxes.length <= 0) {
      partDesignerAnchorSlot = null;
      partDesignerSelectedSlot = null;
    }
    const toRelativeOffsets = (slots: Set<number>): Array<{ x: number; y: number }> => {
      return Array.from(slots)
        .map((slot) => slotToCoord(slot))
        .map((coord) => ({
          x: coord.x - anchorCoord.x,
          y: coord.y - anchorCoord.y,
        }));
    };
    partDesignerDraft = {
      ...partDesignerDraft,
      anchor: { x: anchorCoord.x, y: anchorCoord.y },
      cells: boxes.map((box) => ({
        x: box.x,
        y: box.y,
        structureOccupy: box.occupiesStructureSpace,
        functionalOccupy: box.occupiesFunctionalSpace,
        needStructureBehind: box.needsStructureBehind,
        takeDamage: box.takesDamage,
        attachPoint: box.isAttachPoint,
        anchorPoint: box.isAnchorPoint,
        firePoint: box.isShootingPoint,
      })),
      boxes,
      placement: {
        requireStructureOffsets: toRelativeOffsets(partDesignerSupportOffsets),
        requireStructureOnFunctionalOccupiedBoxes: partDesignerDraft.layer === "structure"
          ? false
          : (partDesignerDraft.placement?.requireStructureOnFunctionalOccupiedBoxes ?? true),
        requireStructureOnStructureOccupiedBoxes: partDesignerDraft.layer === "structure"
          ? false
          : (partDesignerDraft.placement?.requireStructureOnStructureOccupiedBoxes ?? true),
        requireEmptyStructureOffsets: toRelativeOffsets(partDesignerEmptyStructureOffsets),
        requireEmptyFunctionalOffsets: toRelativeOffsets(partDesignerEmptyFunctionalOffsets),
      },
    };
  };

  const loadPartIntoDesignerSlots = (part: PartDefinition): void => {
    partDesignerDraft = applyPartMetadataDefaults(clonePartDefinition(part));
    if (!partDesignerDraft.direction) {
      partDesignerDraft.direction = getPartDirectionDefault(partDesignerDraft.baseComponent);
    }
    if (partDesignerDraft.layer === "functional") {
      partDesignerLastFunctionalBaseComponent = partDesignerDraft.baseComponent;
    }
    const suggestedMeta = getConfiguredPartMetadataDefaultsForLayer(partDesignerDraft.layer, partDesignerDraft.baseComponent);
    partDesignerCategoryEdited = (partDesignerDraft.properties?.category ?? "") !== (suggestedMeta.category ?? "");
    partDesignerSubcategoryEdited = (partDesignerDraft.properties?.subcategory ?? "") !== (suggestedMeta.subcategory ?? "");
    partDesignerSlots = new Array<PartDesignerSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
    partDesignerSupportOffsets = new Set<number>();
    partDesignerEmptyStructureOffsets = new Set<number>();
    partDesignerEmptyFunctionalOffsets = new Set<number>();

    for (const box of part.boxes) {
      const slot = coordToSlot(box.x, box.y);
      if (slot === null) {
        continue;
      }
      const isAttachPoint = box.isAttachPoint === true;
      const occupiesStructureSpace = isAttachPoint ? false : box.occupiesStructureSpace === true;
      const occupiesFunctionalSpace = isAttachPoint ? false : box.occupiesFunctionalSpace !== false;
      partDesignerSlots[slot] = {
        occupiesFunctionalSpace,
        occupiesStructureSpace,
        needsStructureBehind: (box.needsStructureBehind === true) && !occupiesStructureSpace && occupiesFunctionalSpace,
        takesDamage: box.takesDamage ?? box.takesFunctionalDamage ?? (occupiesStructureSpace || occupiesFunctionalSpace),
        isAttachPoint,
        isShootingPoint: box.isShootingPoint === true,
      };
    }

    const anchorBox = part.boxes.find((box) => box.isAnchorPoint === true) ?? null;
    partDesignerAnchorSlot = anchorBox ? coordToSlot(anchorBox.x, anchorBox.y) : coordToSlot(part.anchor.x, part.anchor.y);
    partDesignerSelectedSlot = partDesignerAnchorSlot ?? partDesignerSlots.findIndex((entry) => entry !== null);
    if (partDesignerSelectedSlot !== null && partDesignerSelectedSlot < 0) {
      partDesignerSelectedSlot = null;
    }
    const selectedSlotEntry = partDesignerSelectedSlot !== null ? partDesignerSlots[partDesignerSelectedSlot] : null;
    partDesignerBrushSlot = selectedSlotEntry
      ? normalizePartDesignerSlotForLayer(selectedSlotEntry, partDesignerDraft.layer)
      : createDefaultPartDesignerSlot(partDesignerDraft.layer);

    const anchorCoord = partDesignerAnchorSlot !== null ? slotToCoord(partDesignerAnchorSlot) : part.anchor;
    const loadOffsets = (
      offsets: ReadonlyArray<{ x: number; y: number }> | undefined,
      targetSet: Set<number>,
    ): void => {
      for (const offset of offsets ?? []) {
        const slot = coordToSlot(anchorCoord.x + offset.x, anchorCoord.y + offset.y);
        if (slot !== null) {
          targetSet.add(slot);
        }
      }
    };

    loadOffsets(part.placement?.requireStructureOffsets, partDesignerSupportOffsets);
    loadOffsets(part.placement?.requireEmptyStructureOffsets, partDesignerEmptyStructureOffsets);
    loadOffsets(part.placement?.requireEmptyFunctionalOffsets, partDesignerEmptyFunctionalOffsets);
    recalcPartDraftFromSlots();
  };

  const loadTemplateIntoEditorSlots = (template: UnitTemplate): void => {
    editorStructureSlots = new Array<number | null>(EDITOR_GRID_MAX_SIZE).fill(null);
    editorStructureColorSlots = new Array<string | null>(EDITOR_GRID_MAX_SIZE).fill(null);
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
      editorStructureSlots[slot] = template.structure[cellIndex]?.partId ?? getDefaultStructurePartId();
      editorStructureColorSlots[slot] = template.structure[cellIndex]?.color ?? null;
      cellToSlot.set(cellIndex, slot);
    }

    for (const attachment of template.attachments) {
      const slot = attachment.x !== undefined && attachment.y !== undefined
        ? coordToSlot(attachment.x, attachment.y)
        : cellToSlot.get(attachment.cell);
      if (slot !== undefined && slot !== null) {
        const part = resolvePartDefinitionForAttachment(
          { partId: attachment.partId, component: attachment.component },
          parts,
        );
        if (!part) {
          continue;
        }
        const rotateQuarter = typeof attachment.rotateQuarter === "number"
          ? ((attachment.rotateQuarter % 4 + 4) % 4) as 0 | 1 | 2 | 3
          : 0;
        const normalizedRotate = normalizePartAttachmentRotate(part, rotateQuarter);
        const placement = getFootprintSlots(slot, part, normalizedRotate);
        if (!placement || placement.slots.length <= 0) {
          continue;
        }
        const check = validateFunctionalPlacement(part, normalizedRotate, slot, placement.slots, placement.anchorCoord);
        if (!check.ok) {
          continue;
        }
        const groupId = editorFunctionalGroupSeq;
        editorFunctionalGroupSeq += 1;
        for (const occupiedSlot of placement.slots) {
          editorFunctionalSlots[occupiedSlot.slot] = {
            component: part.baseComponent,
            partId: part.id,
            rotateQuarter: normalizedRotate,
            groupId,
            isAnchor: occupiedSlot.slot === slot,
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
    const counts = new Map<number, number>();
    for (const cell of editorDraft.structure) {
      counts.set(cell.partId, (counts.get(cell.partId) ?? 0) + 1);
    }
    const tags = Array.from(counts.entries()).map(([partId, count]) => `${partId} x${count}`);
    return tags.length > 0 ? tags.join(", ") : "none";
  };

  const getEditorCombatPreview = (): {
    achievableSpeed: number;
    liftAccel: number | null;
    weaponCounts: Record<ProjectileClass, number>;
  } => {
    let totalMass = 0;
    for (const cell of editorDraft.structure) {
      totalMass += getStructurePartStats(cell.partId).mass;
    }
    let totalPower = 0;
    let weightedSpeedCap = 0;
    let capWeight = 0;
    const weaponCounts: Record<ProjectileClass, number> = {
      bullet: 0,
      missile: 0,
      laser: 0,
    };

    for (const attachment of editorDraft.attachments) {
      const stats = COMPONENTS[attachment.component];
      const part = resolvePartDefinitionForAttachment({ partId: attachment.partId, component: attachment.component }, parts);
      totalMass += part?.stats?.mass ?? stats.mass;
      if (stats.type === "engine") {
        const supportsTemplateType = editorDraft.type === "air"
          ? (part?.partProperties?.powerAir ?? stats.propulsion?.platform === "air")
          : (part?.partProperties?.powerGround ?? stats.propulsion?.platform === "ground");
        if (!supportsTemplateType) {
          continue;
        }
        const enginePower = Math.max(0, part?.stats?.power ?? stats.power ?? 0);
        const engineSpeedCap = Math.max(1, part?.stats?.maxSpeed ?? stats.maxSpeed ?? 90);
        totalPower += enginePower;
        weightedSpeedCap += engineSpeedCap * Math.max(1, enginePower);
        capWeight += Math.max(1, enginePower);
      }
      if (stats.type === "weapon") {
        const projectileClass = part?.partProperties?.projectileClass ?? stats.projectileClass ?? "bullet";
        weaponCounts[projectileClass] += 1;
      }
    }

    totalMass = Math.max(14, totalMass);
    let achievableSpeed = 0;
    if (totalPower > 0) {
      const speedCap = Math.max(1, weightedSpeedCap / Math.max(1, capWeight));
      const rawSpeed = editorDraft.type === "base"
        ? 0
        : editorDraft.type === "ground"
        ? (totalPower / Math.max(16, totalMass)) * 74
        : Math.max(0, (totalPower / Math.max(16, totalMass)) * AIR_POWER_TO_SPEED_SCALE - AIR_HOLD_GRAVITY);
      achievableSpeed = Math.max(0, Math.min(speedCap, rawSpeed));
    }

    let liftAccel: number | null = null;
    if (editorDraft.type === "air") {
      liftAccel = 0;
      const mass = Math.max(16, totalMass);
      for (const attachment of editorDraft.attachments) {
        const stats = COMPONENTS[attachment.component];
        if (stats.type !== "engine" || stats.propulsion?.platform !== "air") {
          continue;
        }
        const part = resolvePartDefinitionForAttachment({ partId: attachment.partId, component: attachment.component }, parts);
        const enginePower = Math.max(0, part?.stats?.power ?? stats.power ?? 0);
        liftAccel += (enginePower / mass) * AIR_POWER_TO_SPEED_SCALE;
      }
    }

    return {
      achievableSpeed,
      liftAccel,
      weaponCounts,
    };
  };

  const drawPartDesignerCanvas = (): void => {
    const drawCanvas = partEditorCanvas;
    syncEditorCanvasSizes();
    const context = drawCanvas.getContext("2d");
    if (!context) {
      return;
    }
    context.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    context.fillStyle = "rgba(13, 21, 31, 0.98)";
    context.fillRect(0, 0, drawCanvas.width, drawCanvas.height);

    const grid = getEditorGridRect();
    const validation = validatePartDefinitionDetailed(partDesignerDraft);
    context.fillStyle = "#dbe8f6";
    context.font = "14px Trebuchet MS";
    context.fillText(`Part: ${partDesignerDraft.name}`, 18, 26);
    context.fillText(`Part Designer | Grid ${editorGridCols}x${editorGridRows} | Tool ${partDesignerTool}`, 18, 46);
    context.fillText("Left-click: apply tool | Right-click: erase | Right-drag: pan | Mouse wheel: zoom.", 18, 66);
    context.fillText(`Default direction: ${partDesignerDraft.direction ?? getPartDirectionDefault(partDesignerDraft.baseComponent)} (layout follows this orientation).`, 18, 86);
    context.fillStyle = validation.errors.length > 0 ? "#ffd1c1" : "#bde6c6";
    context.fillText(`Errors ${validation.errors.length} | Warnings ${validation.warnings.length}`, 18, 106);

    const lineCount = validation.errors.length + validation.warnings.length + 2;
    const issuesHeight = Math.max(34, 16 + Math.min(10, lineCount) * 14);
    const issuesWidth = 420;
    const issuesX = drawCanvas.width - issuesWidth - 16;
    const issuesY = drawCanvas.height - issuesHeight - 14;
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
        const entry = partDesignerSlots[slot];

        context.fillStyle = "rgba(39, 56, 76, 0.42)";
        context.fillRect(x + 2, y + 2, grid.cell - 4, grid.cell - 4);
        context.strokeStyle = "rgba(121, 148, 180, 0.35)";
        context.lineWidth = 1;
        context.strokeRect(x + 1, y + 1, grid.cell - 2, grid.cell - 2);

        if (entry) {
          if (entry.occupiesFunctionalSpace && entry.occupiesStructureSpace) {
            context.fillStyle = "rgba(203, 146, 240, 0.86)";
          } else if (entry.occupiesStructureSpace) {
            context.fillStyle = "rgba(110, 185, 255, 0.86)";
          } else if (entry.occupiesFunctionalSpace) {
            context.fillStyle = "rgba(248, 179, 146, 0.88)";
          } else {
            context.fillStyle = "rgba(148, 167, 188, 0.78)";
          }
          context.fillRect(x + 4, y + 4, grid.cell - 8, grid.cell - 8);
          if (entry.takesDamage) {
            context.fillStyle = "#ff7f7f";
            context.beginPath();
            context.arc(x + grid.cell - 8, y + 8, 3, 0, Math.PI * 2);
            context.fill();
          }
          if (entry.needsStructureBehind) {
            context.fillStyle = "#8effc1";
            context.fillRect(x + 6, y + grid.cell - 10, 6, 6);
          }
          if (entry.isAttachPoint) {
            context.strokeStyle = "#8fe7ff";
            context.lineWidth = 1.5;
            context.beginPath();
            context.arc(x + grid.cell * 0.5, y + grid.cell * 0.5, 7, 0, Math.PI * 2);
            context.stroke();
          }
          if (entry.isShootingPoint) {
            context.strokeStyle = "#ffd98b";
            context.lineWidth = 1.5;
            context.beginPath();
            context.moveTo(x + grid.cell - 12, y + grid.cell - 12);
            context.lineTo(x + grid.cell - 5, y + grid.cell - 12);
            context.lineTo(x + grid.cell - 5, y + grid.cell - 5);
            context.stroke();
          }
        }

        if (partDesignerAnchorSlot === slot) {
          context.strokeStyle = "#ffffff";
          context.lineWidth = 2;
          context.beginPath();
          context.moveTo(x + grid.cell / 2 - 6, y + grid.cell / 2);
          context.lineTo(x + grid.cell / 2 + 6, y + grid.cell / 2);
          context.moveTo(x + grid.cell / 2, y + grid.cell / 2 - 6);
          context.lineTo(x + grid.cell / 2, y + grid.cell / 2 + 6);
          context.stroke();
        }
        if (partDesignerSelectedSlot === slot) {
          context.strokeStyle = "#ffe07f";
          context.lineWidth = 2;
          context.strokeRect(x + 2, y + 2, grid.cell - 4, grid.cell - 4);
        }

        if (partDesignerSupportOffsets.has(slot)) {
          context.fillStyle = "#79e296";
          context.fillRect(x + 2, y + 2, 6, 6);
        }
        if (partDesignerEmptyStructureOffsets.has(slot)) {
          context.strokeStyle = "#71d7ff";
          context.lineWidth = 1.5;
          context.strokeRect(x + 3, y + 3, grid.cell - 6, grid.cell - 6);
        }
        if (partDesignerEmptyFunctionalOffsets.has(slot)) {
          context.strokeStyle = "#ffd88c";
          context.lineWidth = 1.5;
          context.strokeRect(x + 6, y + 6, grid.cell - 12, grid.cell - 12);
        }

        const coord = slotToCoord(slot);
        context.fillStyle = "rgba(206, 220, 237, 0.55)";
        context.font = "8px Trebuchet MS";
        context.fillText(`(${coord.x},${coord.y})`, x + 4, y + grid.cell - 4);
      }
    }
  };

  const drawEditorCanvas = (): void => {
    if (isPartEditorScreen()) {
      drawPartDesignerCanvas();
      return;
    }
    const drawCanvas = templateEditorCanvas;
    syncEditorCanvasSizes();
    const context = drawCanvas.getContext("2d");
    if (!context) {
      return;
    }
    context.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    context.fillStyle = "rgba(13, 21, 31, 0.98)";
    context.fillRect(0, 0, drawCanvas.width, drawCanvas.height);

    const grid = getEditorGridRect();
    context.fillStyle = "#dbe8f6";
    context.font = "14px Trebuchet MS";
    context.fillText(`Template: ${editorDraft.name}`, 18, 26);
    context.fillText(`Grid ${editorGridCols}x${editorGridRows} | Layer ${editorLayer.toUpperCase()} ${editorDeleteMode ? "| DELETE" : "| PLACE"}`, 18, 46);

    const selectedPartForFacingUi = resolvePartForSelection(editorSelection);
    const functionalCount = editorDraft.attachments.length;
    const displayCount = editorDraft.display?.length ?? 0;
    const controlCount = editorDraft.attachments.filter((attachment) => attachment.component === "control").length;
    const infoWidth = 360;
    const infoHeight = 70;
    const infoX = drawCanvas.width - infoWidth - 16;
    const infoY = 14;
    context.fillStyle = "rgba(28, 43, 61, 0.92)";
    context.fillRect(infoX, infoY, infoWidth, infoHeight);
    context.strokeStyle = "rgba(139, 172, 206, 0.8)";
    context.strokeRect(infoX, infoY, infoWidth, infoHeight);
    context.fillStyle = "#dbe8f6";
    context.font = "12px Trebuchet MS";
    context.fillText(`Structure: ${editorDraft.structure.length} | Functional: ${functionalCount} | Display: ${displayCount}`, infoX + 10, infoY + 17);
    context.fillText(`Control Units: ${controlCount} | Material: ${getEditorMaterialBreakdown()}`, infoX + 10, infoY + 35, infoWidth - 20);
    if (isCurrentEditorSelectionRotatable() && selectedPartForFacingUi) {
      const directional = isDirectionalPart(selectedPartForFacingUi);
      const facingQuarter = directional
        ? getDirectionalFacingQuarter(selectedPartForFacingUi, editorWeaponRotateQuarter)
        : editorWeaponRotateQuarter;
      context.fillText(`${directional ? "Direction" : "Footprint rotation"}: ${getRotationSymbol(facingQuarter)} (${facingQuarter * 90}deg)`, infoX + 10, infoY + 53);
    } else {
      context.fillText("Direction: n/a", infoX + 10, infoY + 53);
    }

    const validation = validateTemplateDetailed(editorDraft, { partCatalog: parts });
    const lineCount = validation.errors.length + validation.warnings.length + 2;
    const issuesHeight = Math.max(34, 16 + Math.min(10, lineCount) * 14);
    const issuesWidth = 360;
    const issuesX = drawCanvas.width - issuesWidth - 16;
    const issuesY = drawCanvas.height - issuesHeight - 14;
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
        const structurePartId = editorStructureSlots[slot];
        const structurePart = resolveStructurePartById(structurePartId);
        const structureColor = structurePartId ? (editorStructureColorSlots[slot] ?? getStructurePartStats(structurePartId).color) : "rgba(39, 56, 76, 0.42)";

        context.fillStyle = structureColor;
        context.globalAlpha = structurePartId ? getStructurePartStats(structurePartId).alpha : 1;
        context.fillRect(x + 2, y + 2, grid.cell - 4, grid.cell - 4);
        context.globalAlpha = 1;
        context.strokeStyle = structurePartId ? "rgba(224, 236, 251, 0.72)" : "rgba(121, 148, 180, 0.35)";
        context.lineWidth = 1;
        context.strokeRect(x + 1, y + 1, grid.cell - 2, grid.cell - 2);
        if (structurePart) {
          context.strokeStyle = "rgba(255, 255, 255, 0.22)";
          context.beginPath();
          context.moveTo(x + grid.cell * 0.18, y + grid.cell * 0.22);
          context.lineTo(x + grid.cell * 0.82, y + grid.cell * 0.22);
          context.stroke();
          context.fillStyle = "rgba(5, 12, 18, 0.42)";
          context.beginPath();
          context.arc(x + grid.cell * 0.18, y + grid.cell * 0.82, Math.max(1, grid.cell * 0.035), 0, Math.PI * 2);
          context.arc(x + grid.cell * 0.82, y + grid.cell * 0.82, Math.max(1, grid.cell * 0.035), 0, Math.PI * 2);
          context.fill();
          context.fillStyle = "#f3fbff";
          context.font = "8px Trebuchet MS";
          context.fillText(structurePart.name, x + 4, y + 10, Math.max(8, grid.cell - 8));
        }

        const functional = editorFunctionalSlots[slot];
        if (functional) {
          const part = resolvePartDefinitionForAttachment(
            { partId: functional.partId, component: functional.component },
            parts,
          );
          if (functional.isAnchor && part) {
            const facingQuarter = isDirectionalPart(part)
              ? getDirectionalFacingQuarter(part, functional.rotateQuarter)
              : functional.rotateQuarter;
            drawFunctionalPartIcon(context, part, x + grid.cell * 0.5, y + grid.cell * 0.45, Math.min(22, grid.cell * 0.48), facingQuarter);
          } else {
            context.fillStyle = "#f0b39f";
            context.fillRect(x + 6, y + 6, 12, 12);
          }
          if (functional.isAnchor) {
            context.fillStyle = "#fff5ef";
            context.font = "9px Trebuchet MS";
            context.fillText(getFunctionalShortLabel(part), x + 4, y + grid.cell - 6, Math.max(12, grid.cell - 8));
          }
          if (functional.isAnchor) {
            const part = resolvePartDefinitionForAttachment(
              { partId: functional.partId, component: functional.component },
              parts,
            );
            if (shouldShowTemplateDirectionForPart(part)) {
              const facingQuarter = getDirectionalFacingQuarter(part, functional.rotateQuarter);
              context.strokeStyle = "#ffe1d4";
              context.lineWidth = 1.5;
              context.beginPath();
              if (facingQuarter === 0) {
                context.moveTo(x + 18, y + 24);
                context.lineTo(x + 34, y + 24);
                context.lineTo(x + 30, y + 20);
                context.moveTo(x + 34, y + 24);
                context.lineTo(x + 30, y + 28);
              } else if (facingQuarter === 1) {
                context.moveTo(x + 24, y + 18);
                context.lineTo(x + 24, y + 34);
                context.lineTo(x + 20, y + 30);
                context.moveTo(x + 24, y + 34);
                context.lineTo(x + 28, y + 30);
              } else if (facingQuarter === 2) {
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

    if (editorHoverActive && !editorDeleteMode) {
      const hover = getEditorSlotFromCanvasPoint(editorHoverMouseX, editorHoverMouseY);
      if (hover) {
        const slotX = grid.x + hover.col * grid.cell;
        const slotY = grid.y + hover.row * grid.cell;
        if (editorLayer === "structure") {
          const structurePart = typeof editorSelection === "number" ? resolveStructurePartById(editorSelection) : null;
          if (structurePart) {
            context.globalAlpha = getStructurePartStats(structurePart.id).alpha * 0.5;
            context.fillStyle = editorStructureColor;
            context.fillRect(slotX + 2, slotY + 2, grid.cell - 4, grid.cell - 4);
            context.globalAlpha = 1;
          }
        } else if (editorLayer === "display") {
          if (editorStructureSlots[hover.slot] && EDITOR_DISPLAY_KINDS.includes(editorSelection as DisplayAttachmentTemplate["kind"])) {
            context.globalAlpha = 0.5;
            context.fillStyle = "#98c8ff";
            context.fillRect(slotX + grid.cell - 16, slotY + 6, 10, 10);
            context.globalAlpha = 1;
          }
        } else {
          const part = resolvePartForSelection(editorSelection);
          if (part) {
            const rotateQuarter = isCurrentEditorSelectionRotatable() ? editorWeaponRotateQuarter : 0;
            const attempt = resolveFunctionalPlacementAttempt(hover.slot, part, rotateQuarter);
            if (attempt.ok) {
              context.globalAlpha = 0.5;
              context.fillStyle = "#f0b39f";
              for (const footprint of attempt.placement.slots) {
                const footprintCol = footprint.slot % editorGridCols;
                const footprintRow = Math.floor(footprint.slot / editorGridCols);
                const cellX = grid.x + footprintCol * grid.cell;
                const cellY = grid.y + footprintRow * grid.cell;
                context.fillRect(cellX + 6, cellY + 6, 12, 12);
              }
              const anchorCol = attempt.anchorSlot % editorGridCols;
              const anchorRow = Math.floor(attempt.anchorSlot / editorGridCols);
              const anchorX = grid.x + anchorCol * grid.cell;
              const anchorY = grid.y + anchorRow * grid.cell;
              const facingQuarter = isDirectionalPart(part) ? getDirectionalFacingQuarter(part, rotateQuarter) : rotateQuarter;
              drawFunctionalPartIcon(context, part, anchorX + grid.cell * 0.5, anchorY + grid.cell * 0.45, Math.min(22, grid.cell * 0.48), facingQuarter);
              context.fillStyle = "#fff5ef";
              context.font = "9px Trebuchet MS";
              context.fillText(getFunctionalShortLabel(part), anchorX + 4, anchorY + grid.cell - 6, Math.max(12, grid.cell - 8));
              context.globalAlpha = 1;
            }
          }
        }
      }
    }

    if (editorHoverActive) {
      const hover = getEditorSlotFromCanvasPoint(editorHoverMouseX, editorHoverMouseY);
      if (hover) {
        const structurePartId = editorStructureSlots[hover.slot];
        const structurePart = structurePartId === null ? null : resolveStructurePartById(structurePartId);
        const functionalSlot = editorFunctionalSlots[hover.slot];
        const functionalPart = functionalSlot
          ? resolvePartDefinitionForAttachment(
              { partId: functionalSlot.partId, component: functionalSlot.component },
              parts,
            )
          : null;
        if (structurePart || functionalPart) {
          const lines = [`Block: ${structurePart?.name ?? "empty"}`];
          if (functionalPart) {
            lines.push(`Functional: ${functionalPart.name}`);
          }

          const hoverCol = hover.slot % editorGridCols;
          const hoverRow = Math.floor(hover.slot / editorGridCols);
          const hoverX = grid.x + hoverCol * grid.cell;
          const hoverY = grid.y + hoverRow * grid.cell;
          context.globalAlpha = 1;
          context.strokeStyle = "rgba(255, 232, 154, 0.95)";
          context.lineWidth = 2;
          context.strokeRect(hoverX + 1, hoverY + 1, grid.cell - 2, grid.cell - 2);

          context.font = "12px Trebuchet MS";
          const paddingX = 8;
          const paddingY = 6;
          const lineHeight = 16;
          const tooltipWidth = Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width))) + paddingX * 2;
          const tooltipHeight = lines.length * lineHeight + paddingY * 2;
          let tooltipX = hoverX + grid.cell + 8;
          let tooltipY = hoverY + 4;
          if (tooltipX + tooltipWidth > drawCanvas.width - 4) {
            tooltipX = hoverX - tooltipWidth - 8;
          }
          if (tooltipY + tooltipHeight > drawCanvas.height - 4) {
            tooltipY = drawCanvas.height - tooltipHeight - 4;
          }
          tooltipX = Math.max(4, tooltipX);
          tooltipY = Math.max(4, tooltipY);

          context.fillStyle = "rgba(16, 27, 40, 0.96)";
          context.fillRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);
          context.strokeStyle = "rgba(255, 232, 154, 0.9)";
          context.lineWidth = 1;
          context.strokeRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);
          context.fillStyle = "#f5f0df";
          lines.forEach((line, index) => {
            context.fillText(line, tooltipX + paddingX, tooltipY + paddingY + 12 + index * lineHeight);
          });
        }
      }
    }

    const combatPreview = getEditorCombatPreview();
    const legend = `Projectile class Bullet:${combatPreview.weaponCounts.bullet} Missile:${combatPreview.weaponCounts.missile} Laser:${combatPreview.weaponCounts.laser}`;
    const speedText = `Achievable speed: ${combatPreview.achievableSpeed.toFixed(1)}`;
    const liftText = combatPreview.liftAccel === null
      ? "Lift: n/a (ground unit)"
      : `Air thrust: ${combatPreview.liftAccel.toFixed(1)} - gravity ${AIR_HOLD_GRAVITY.toFixed(1)} ${combatPreview.liftAccel > AIR_HOLD_GRAVITY ? "(flight)" : "(insufficient)"}`;
    const panelX = 16;
    const panelY = drawCanvas.height - 70;
    context.fillStyle = "rgba(19, 30, 44, 0.94)";
    context.fillRect(panelX, panelY, 530, 54);
    context.strokeStyle = "rgba(128, 172, 206, 0.7)";
    context.strokeRect(panelX, panelY, 530, 54);
    context.fillStyle = "#dbe8f6";
    context.font = "12px Trebuchet MS";
    context.fillText(speedText, panelX + 8, panelY + 15);
    context.fillText(liftText, panelX + 8, panelY + 31);
    context.fillText(legend, panelX + 8, panelY + 47);
  };

  const applyPartDesignerCellAction = (slot: number, forceDelete: boolean): void => {
    const eraseRequested = forceDelete || partDesignerTool === "erase";
    partDesignerSelectedSlot = slot;
    const toggleSet = (setRef: Set<number>): void => {
      if (setRef.has(slot)) {
        setRef.delete(slot);
      } else {
        setRef.add(slot);
      }
    };

    if (eraseRequested) {
      const removed = partDesignerSlots[slot];
      if (removed) {
        setPartDesignerBrushFromSlot(removed);
      }
      partDesignerSlots[slot] = null;
      partDesignerSupportOffsets.delete(slot);
      partDesignerEmptyStructureOffsets.delete(slot);
      partDesignerEmptyFunctionalOffsets.delete(slot);
      if (partDesignerAnchorSlot === slot) {
        partDesignerAnchorSlot = null;
      }
      recalcPartDraftFromSlots();
      return;
    }

    if (partDesignerTool === "setAnchor") {
      const next = ensurePartDesignerSlot(slot);
      setPartDesignerBrushFromSlot(next);
      partDesignerAnchorSlot = slot;
      recalcPartDraftFromSlots();
      return;
    }
    if (partDesignerTool === "markSupport") {
      toggleSet(partDesignerSupportOffsets);
      recalcPartDraftFromSlots();
      return;
    }
    if (partDesignerTool === "markEmptyStructure") {
      toggleSet(partDesignerEmptyStructureOffsets);
      recalcPartDraftFromSlots();
      return;
    }
    if (partDesignerTool === "markEmptyFunctional") {
      toggleSet(partDesignerEmptyFunctionalOffsets);
      recalcPartDraftFromSlots();
      return;
    }

    if (partDesignerTool === "select") {
      const next = ensurePartDesignerSlot(slot);
      setPartDesignerBrushFromSlot(next);
      if (partDesignerAnchorSlot === null) {
        partDesignerAnchorSlot = slot;
      }
      recalcPartDraftFromSlots();
      return;
    }

    const next = ensurePartDesignerSlot(slot);
    if (partDesignerTool === "paintFunctional") {
      next.isAttachPoint = false;
      next.occupiesFunctionalSpace = true;
      if (!next.occupiesStructureSpace) {
        next.needsStructureBehind = true;
      }
    } else if (partDesignerTool === "paintStructure") {
      next.isAttachPoint = false;
      next.occupiesStructureSpace = true;
      next.needsStructureBehind = false;
    } else if (partDesignerTool === "paintDamage") {
      next.takesDamage = true;
    }
    partDesignerSlots[slot] = next;
    setPartDesignerBrushFromSlot(next);
    if (partDesignerAnchorSlot === null) {
      partDesignerAnchorSlot = slot;
    }
    recalcPartDraftFromSlots();
  };

  const applyEditorCellAction = (mouseX: number, mouseY: number, forceDelete = false): void => {
    const hit = getEditorSlotFromCanvasPoint(mouseX, mouseY);
    if (!hit) {
      return;
    }
    const { row, col, slot } = hit;
    const deleteRequested = forceDelete || editorDeleteMode;

    if (isPartEditorScreen()) {
      applyPartDesignerCellAction(slot, forceDelete);
      return;
    }

    if (forceDelete) {
      const removedFunctional = clearFunctionalGroupAtSlot(slot);
      if (removedFunctional) {
        recalcEditorDraftFromSlots();
        return;
      }
      const hadStructure = editorStructureSlots[slot] !== null;
      if (hadStructure) {
        editorStructureSlots[slot] = null;
        editorStructureColorSlots[slot] = null;
        editorDisplaySlots[slot] = null;
        recalcEditorDraftFromSlots();
        return;
      }
      addLog(`No functional component or structure cell at row ${row + 1}, col ${col + 1}`, "warn");
      return;
    }

    if (editorLayer === "structure") {
      if (deleteRequested) {
        const hadStructure = editorStructureSlots[slot] !== null;
        clearFunctionalGroupAtSlot(slot);
        editorStructureSlots[slot] = null;
        editorStructureColorSlots[slot] = null;
        editorDisplaySlots[slot] = null;
        if (!hadStructure) {
          addLog(`No structure cell at row ${row + 1}, col ${col + 1}`, "warn");
        }
      } else {
        const structurePart = typeof editorSelection === "number" ? resolveStructurePartById(editorSelection) : null;
        if (structurePart) {
          editorStructureSlots[slot] = structurePart.id;
          editorStructureColorSlots[slot] = editorStructureColor;
        }
      }
      recalcEditorDraftFromSlots();
      return;
    }

    if (editorLayer === "functional") {
      if (deleteRequested) {
        const hadFunctional = clearFunctionalGroupAtSlot(slot);
        if (!hadFunctional) {
          addLog(`No functional component at row ${row + 1}, col ${col + 1}`, "warn");
        }
      } else {
        const part = resolvePartForSelection(editorSelection);
        if (!part) {
          addLog("Select a valid part first", "warn");
          return;
        }
        const rotateQuarter = isCurrentEditorSelectionRotatable() ? editorWeaponRotateQuarter : 0;
        const attempt = resolveFunctionalPlacementAttempt(slot, part, rotateQuarter);
        if (!attempt.ok) {
          addLog(attempt.reason, "warn");
          return;
        }
        if (part.baseComponent === "control") {
          editorFunctionalSlots = editorFunctionalSlots.map((entry) => (entry?.component === "control" ? null : entry));
        }
        const occupiedGroupIds = new Set(
          attempt.placement.slots
            .map((occupiedSlot) => editorFunctionalSlots[occupiedSlot.slot]?.groupId ?? null)
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
        for (const occupiedSlot of attempt.placement.slots) {
          editorFunctionalSlots[occupiedSlot.slot] = {
            component: part.baseComponent,
            partId: part.id,
            rotateQuarter,
            groupId,
            isAnchor: occupiedSlot.slot === attempt.anchorSlot,
          };
        }
      }
      recalcEditorDraftFromSlots();
      return;
    }

    if (!editorStructureSlots[slot]) {
      addLog("Select a structure cell first", "warn");
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

  const getPartComparisonDraft = (id: number): PartDefinition | null => (
    partComparisonDrafts.get(id) ?? null
  );

  const refreshPartComparisonMatrix = (): void => {
    document.querySelectorAll<HTMLElement>("[data-part-comparison-cell]").forEach((cell) => {
      const weaponId = Number.parseInt(cell.dataset.weaponId ?? "", 10);
      const structureId = Number.parseInt(cell.dataset.structureId ?? "", 10);
      const weapon = getPartComparisonDraft(weaponId);
      const structure = getPartComparisonDraft(structureId);
      if (!weapon || !structure) {
        cell.textContent = "—";
        return;
      }
      const weaponValues = resolveWeaponComparisonValues(weapon);
      const structureValues = resolveStructureComparisonValues(structure);
      const hits = calculateHitsToDestroy(weaponValues, structureValues);
      cell.textContent = partComparisonTab === "hits"
        ? String(hits)
        : formatDestroyTime(calculateDestroyTimeSeconds(hits, weaponValues));
    });
  };

  const renderPartComparisonModal = (): string => {
    if (!partComparisonOpen) {
      return "";
    }
    const weapons = parts
      .filter((part) => getResolvedPartType(part) === "weapon")
      .map((part) => getPartComparisonDraft(part.id))
      .filter((part): part is PartDefinition => part !== null)
      .sort((a, b) => (
        resolvePartGasCost(a) - resolvePartGasCost(b)
        || a.name.localeCompare(b.name)
        || a.id - b.id
      ));
    const structures = parts
      .filter((part) => getResolvedPartType(part) === "structure")
      .map((part) => getPartComparisonDraft(part.id))
      .filter((part): part is PartDefinition => part !== null)
      .sort((a, b) => (
        resolvePartGasCost(a) - resolvePartGasCost(b)
        || a.name.localeCompare(b.name)
        || a.id - b.id
      ));
    const selected = partComparisonSelection
      ? getPartComparisonDraft(partComparisonSelection.id)
      : null;
    const selectedKind = selected ? getResolvedPartType(selected) : null;
    const inspector = (() => {
      if (!selected || (selectedKind !== "weapon" && selectedKind !== "structure")) {
        return `<div class="small">Select a weapon row or structure column.</div>`;
      }
      if (selectedKind === "weapon") {
        const values = resolveWeaponComparisonValues(selected);
        return `
          <div class="part-comparison-inspector-title">
            <span class="eyebrow">Weapon parameters</span>
            <h3>${escapeHtml(selected.name)}</h3>
          </div>
          <label>Gas Consumption<input data-comparison-field="gasCost" type="number" min="0" step="1" value="${values.gasCost}" /></label>
          <label>Mass<input data-comparison-field="mass" type="number" min="0" step="0.1" value="${values.mass}" /></label>
          <label>Damage<input data-comparison-field="damage" type="number" min="0" step="1" value="${values.damage}" /></label>
          <label>Penetration<input data-comparison-field="penetration" type="number" min="0" step="1" value="${values.penetration}" /></label>
          <label>Cooldown (s)<input data-comparison-field="cooldown" type="number" min="0" step="0.05" value="${values.cooldown}" /></label>
          <label>Max Loaded Ammo<input data-comparison-field="maxCapacity" type="number" min="1" step="1" value="${values.maxCapacity}" /></label>
          <label>Min Fire Interval (s)<input data-comparison-field="minFireInterval" type="number" min="0" step="0.05" value="${values.minFireInterval}" /></label>
        `;
      }
      const values = resolveStructureComparisonValues(selected);
      return `
          <div class="part-comparison-inspector-title">
            <span class="eyebrow">Structure parameters</span>
            <h3>${escapeHtml(selected.name)}</h3>
          </div>
          <label>Gas Consumption<input data-comparison-field="gasCost" type="number" min="0" step="1" value="${values.gasCost}" /></label>
          <label>Mass<input data-comparison-field="mass" type="number" min="0" step="0.1" value="${values.mass}" /></label>
          <label>Armor<input data-comparison-field="armor" type="number" min="0" step="0.01" value="${values.armor}" /></label>
        <label>HP<input data-comparison-field="hp" type="number" min="0" step="1" value="${values.hp}" /></label>
      `;
    })();
    const headerCells = structures.map((structure) => `
      <th>
        <button type="button" data-comparison-select-kind="structure" data-comparison-select-id="${structure.id}" class="${partComparisonSelection?.kind === "structure" && partComparisonSelection.id === structure.id ? "active" : ""}">
          ${escapeHtml(structure.name)}
        </button>
      </th>
    `).join("");
    const rows = weapons.map((weapon) => {
      const weaponValues = resolveWeaponComparisonValues(weapon);
      const cells = structures.map((structure) => {
        const hits = calculateHitsToDestroy(weaponValues, resolveStructureComparisonValues(structure));
        const value = partComparisonTab === "hits"
          ? String(hits)
          : formatDestroyTime(calculateDestroyTimeSeconds(hits, weaponValues));
        return `<td data-part-comparison-cell data-weapon-id="${weapon.id}" data-structure-id="${structure.id}">${value}</td>`;
      }).join("");
      return `
        <tr>
          <th>
            <button type="button" data-comparison-select-kind="weapon" data-comparison-select-id="${weapon.id}" class="${partComparisonSelection?.kind === "weapon" && partComparisonSelection.id === weapon.id ? "active" : ""}">
              ${escapeHtml(weapon.name)}
            </button>
          </th>
          ${cells}
        </tr>
      `;
    }).join("");
    return `
      <div id="partComparisonOverlay" class="part-comparison-overlay" role="dialog" aria-modal="true" aria-labelledby="partComparisonTitle">
        <section class="part-comparison-modal">
          <header class="part-comparison-header">
            <div><span class="eyebrow">Weapon analysis</span><h2 id="partComparisonTitle">Weapon vs. Structure</h2></div>
            <div class="part-comparison-header-actions">
              <span id="partComparisonChangedCount" class="small">${partComparisonDirtyIds.size} changed${partComparisonInvalidKeys.size > 0 ? ` · ${partComparisonInvalidKeys.size} invalid` : ""}</span>
              <button id="btnClosePartComparison" class="part-comparison-close" type="button" aria-label="Close comparison">×</button>
            </div>
          </header>
          <div class="part-comparison-tabs" role="tablist">
            <button type="button" data-comparison-tab="hits" class="${partComparisonTab === "hits" ? "active" : ""}">Hit Number</button>
            <button type="button" data-comparison-tab="time" class="${partComparisonTab === "time" ? "active" : ""}">Destroy Time</button>
          </div>
          <div class="part-comparison-content">
            <div class="part-comparison-table-wrap">
              <table class="part-comparison-table">
                <thead><tr><th>Weapon \\ Structure</th>${headerCells}</tr></thead>
                <tbody>${rows || `<tr><td colspan="${Math.max(1, structures.length + 1)}">No default weapon parts found.</td></tr>`}</tbody>
              </table>
            </div>
            <aside class="part-comparison-inspector">${inspector}</aside>
          </div>
          <footer class="part-comparison-actions">
            <span class="small">Calculations ignore penetration, blast damage, recovery, accuracy, travel time, and loader parts.</span>
            <div>
              <button id="btnDiscardPartComparison" type="button">Discard</button>
              <button id="btnSavePartComparison" type="button" ${partComparisonDirtyIds.size === 0 || partComparisonInvalidKeys.size > 0 ? "disabled" : ""}>Save All</button>
            </div>
          </footer>
        </section>
      </div>
    `;
  };

  const renderPanels = (): void => {
    updateMetaBar();

    const economy = getIncomeAndUpkeep(base, mapNodes);
    const liveIncome = campaign.getBuildingCount("refinery") * 6
      + mapNodes.filter((node) => node.owner === "player").reduce((sum, node) => sum + (node.gasYieldPerMinute ?? node.resourceYieldPerMinute ?? 0), 0);
    const ownedNodes = mapNodes.filter((node) => node.owner === "player").length;
    const garrisonCount = mapNodes.filter((node) => node.garrison).length;
    const activeTechCount = Object.values(tech).filter(Boolean).length;
    const canSpend = (amount: number): boolean => isUnlimitedResources() || gas >= amount;
    const buildQueueCards = campaign.jobs.length > 0
      ? campaign.jobs.map((job) => {
          const progress = Math.max(4, Math.min(100, ((job.durationSeconds - job.remainingSeconds) / Math.max(1, job.durationSeconds)) * 100));
          const label = job.type === "building" ? BUILDING_CATALOG[job.target as BuildingKind].name : RESEARCH_CATALOG[job.target as ResearchKind].name;
          return `<div class="queue-item"><div><strong>${label}</strong><span>${Math.ceil(job.remainingSeconds)}s</span></div><div class="progress-track"><i style="width:${progress}%"></i></div></div>`;
        }).join("")
      : `<div class="empty-state compact"><span class="empty-state-icon">+</span><div><strong>Construction queue clear</strong><small>Select a facility to begin an upgrade.</small></div></div>`;

    basePanel.innerHTML = `
      <div class="panel-heading"><div><span class="eyebrow">Command overview</span><h2>Home Base</h2></div><span class="health-pill good"><i></i> Operational</span></div>
      <div class="sidebar-metric"><span>Gas income / min</span><strong class="good">+${liveIncome}</strong></div>
      <div class="sidebar-metric"><span>Territory secured</span><strong>${ownedNodes}/${mapNodes.length}</strong></div>
      <div class="sidebar-metric"><span>Research online</span><strong>${activeTechCount}/5</strong></div>
      <div class="section-divider"></div>
      <div class="section-label">Construction queue</div>
      <div class="queue-list">${buildQueueCards}</div>
    `;

    const isTestArenaActive = battle.getState().active && battle.getState().nodeId === testArenaNode.id;
    mapPanel.innerHTML = `
      <div class="panel-heading"><div><span class="eyebrow">Strategic network</span><h2>Territory</h2></div><span class="health-pill"><i></i> ${ownedNodes} secured</span></div>
      <div class="map-legend"><span><i class="owner-player"></i> Player</span><span><i class="owner-neutral"></i> Neutral</span><span><i class="owner-enemy"></i> Enemy</span></div>
      <div class="sidebar-metric"><span>Garrison upkeep</span><strong>${economy.upkeep}</strong></div>
      <div class="sidebar-metric"><span>Active garrisons</span><strong>${garrisonCount}</strong></div>
      ${battle.getState().active && !battle.getState().outcome && !isTestArenaActive ? `<div class="notice warn"><strong>Battle live</strong><span>Combat and AI logistics continue while you manage the map.</span></div>` : ""}
      ${pendingOccupation ? `<div class="notice good"><strong>Sector captured</strong><span>Secure it before advancing.</span><button id="btnSettle">Station garrison · 4 upkeep</button></div>` : ""}
    `;

    if (screen === "base") {
      const researchCard = (key: keyof TechState, title: string, description: string, cost: number, buttonId: string): string => {
        const unlocked = tech[key];
        const lockedByLab = campaign.getBuildingCount("research-lab") < 1;
        const inProgress = campaign.jobs.some((job) => job.type === "research" && job.target === key);
        const disabled = unlocked || inProgress || lockedByLab || !canSpend(cost);
        const seconds = RESEARCH_CATALOG[key as ResearchKind]?.durationSeconds ?? 0;
        const action = unlocked ? "Researched" : inProgress ? "Researching…" : lockedByLab ? "Lab required" : !canSpend(cost) ? "Insufficient gas" : `Research · ${cost} gas · ${seconds}s`;
        return `<article class="tech-card ${unlocked ? "unlocked" : ""}"><div class="tech-glyph">${unlocked ? "✓" : "◇"}</div><div><h3>${title}</h3><p>${description}</p></div><button id="${buttonId}" ${disabled ? "disabled" : ""}>${action}</button></article>`;
      };
      const availableBuildSlots = campaign.slots.filter((slot) => !slot.building && !campaign.jobs.some((job) => job.slotId === slot.id));
      if (!availableBuildSlots.some((slot) => slot.id === selectedBaseBuildSlotId)) {
        selectedBaseBuildSlotId = availableBuildSlots[0]?.id ?? null;
      }
      const selectedBuildSlot = availableBuildSlots.find((slot) => slot.id === selectedBaseBuildSlotId) ?? null;
      const selectedBuildOptions = selectedBuildSlot
        ? (Object.keys(BUILDING_CATALOG) as BuildingKind[]).filter((kind) => BUILDING_CATALOG[kind].size === selectedBuildSlot.size)
        : [];
      managementCenter.innerHTML = `
        <section class="base-primary-workspace" aria-label="Main Base compound">
          <div class="base-compound">
            <header class="base-scene-overlay">
              <div><span class="eyebrow">Main Base</span><strong>Command Compound</strong><small>Operational · construction continues during battle</small></div>
              <div class="base-overlay-metrics">
                <span><small>Gas</small><b>${isUnlimitedResources() ? "∞" : Math.floor(gas)}</b><i>+${liveIncome}/min</i></span>
                <span><small>Facilities</small><b>${campaign.slots.filter((slot) => slot.building).length}/4</b></span>
                <span><small>Delivery</small><b>${campaign.getDeliveryCapacity()}</b></span>
                <span><small>Projects</small><b>${campaign.jobs.length}</b></span>
              </div>
              <button class="button-quiet" data-nav="templateEditor">Craft designer</button>
            </header>
            <div class="base-command-core"><span>HQ</span><strong>Command Core</strong><small>Gas deposit online</small></div>
            ${campaign.slots.map((slot) => {
              const building = slot.building ? BUILDING_CATALOG[slot.building] : null;
              const pending = campaign.jobs.find((job) => job.slotId === slot.id);
              const isSelected = !building && !pending && selectedBaseBuildSlotId === slot.id;
              return `<article class="base-building-spot slot-${slot.id} spot-${slot.size} ${building ? "occupied" : ""} ${pending ? "building" : ""} ${isSelected ? "selected" : ""}"><span class="spot-size">${slot.size}</span>${building ? `<div class="building-graphic building-${slot.building}"><i aria-hidden="true"></i><div class="building-caption"><b>${building.name}</b><small>${building.description}</small></div></div>` : pending ? `<div class="building-under-construction"><i></i><b>Under construction</b><small>${Math.ceil(pending.remainingSeconds)}s remaining</small></div>` : `<button class="empty-building-spot" data-select-build-slot="${slot.id}" aria-pressed="${isSelected}"><span class="empty-pad-mark">+</span><b>Open ${slot.size} spot</b><small>${isSelected ? "Choose a building below" : "Select to build"}</small></button>`}</article>`;
            }).join("")}
          </div>
          <div class="base-build-dock">
            <div class="build-dock-heading"><span class="eyebrow">Construction</span><strong>${selectedBuildSlot ? `${selectedBuildSlot.size} building spot` : "All building spots assigned"}</strong><small>${selectedBuildSlot ? `Selected pad: ${selectedBuildSlot.id.replaceAll("-", " ")}` : "No empty pad is available."}</small></div>
            <div class="build-dock-options">${selectedBuildOptions.length > 0 ? selectedBuildOptions.map((kind) => {
              const item = BUILDING_CATALOG[kind];
              return `<button class="build-option building-${kind}" data-build-kind="${kind}" data-build-slot="${selectedBuildSlot?.id ?? ""}" ${!canSpend(item.gasCost) ? "disabled" : ""}><i aria-hidden="true"></i><span><b>${item.name}</b><small>${item.description}</small><em>${item.gasCost} gas · ${item.buildSeconds}s</em></span></button>`;
            }).join("") : `<div class="build-dock-empty">Select an open pad in the compound to see compatible buildings.</div>`}</div>
          </div>
        </section>
        <section class="workspace-section"><div class="section-heading"><div><span class="eyebrow">Technology</span><h2>Research matrix</h2></div><span class="section-note">Requires an operational research lab</span></div>
          <div class="tech-grid">
            ${researchCard("reinforced", "Reinforced structures", "Increase frontline durability with denser structural blocks.", 130, "btnUnlockReinforced")}
            ${researchCard("combined", "Combined composite", "Hybrid material package balancing recovery and armor.", 180, "btnUnlockCombined")}
            ${researchCard("mediumWeapons", "Explosive cannon", "Adds area denial and blast damage to heavy platforms.", 170, "btnUnlockMediumWeapon")}
          </div>
        </section>`;
    } else if (screen === "map") {
      const routeKeys = new Set<string>();
      const routeMarkup = mapNodes.flatMap((node) => (node.links ?? []).map((linkedId) => {
        const linked = mapNodes.find((entry) => entry.id === linkedId);
        if (!linked || node.x === undefined || node.y === undefined || linked.x === undefined || linked.y === undefined) return "";
        const key = [node.id, linked.id].sort().join(":");
        if (routeKeys.has(key)) return "";
        routeKeys.add(key);
        return `<line x1="${node.x * 10}" y1="${node.y * 5.2}" x2="${linked.x * 10}" y2="${linked.y * 5.2}" />`;
      })).join("");
      const nodeMarkup = mapNodes.map((node, index) => {
        const ownerLabel = node.owner.charAt(0).toUpperCase() + node.owner.slice(1);
        const kindLabel = (node.kind ?? "battlefield").replace("-", " ");
        const reachable = node.owner === "player" || node.id === "mine" || node.id === "oil"
          || (node.links ?? []).some((linkedId) => mapNodes.some((entry) => entry.id === linkedId && entry.owner === "player"));
        const benefit = node.kind === "oil" ? `+${node.gasYieldPerMinute ?? 0} gas/min` : node.kind === "resource" ? `+${node.resourceYieldPerMinute ?? 0} resources/min` : node.kind === "remote-base" ? "Forward logistics source" : node.kind === "outpost" ? "Free local craft support" : `${node.reward} gas reward`;
        return `<article class="campaign-node kind-${node.kind ?? "battlefield"} node-${node.id} owner-${node.owner} ${reachable ? "" : "route-locked"}" style="left:${node.x ?? 50}%;top:${node.y ?? 50}%"><span class="node-index">${String(index + 1).padStart(2, "0")}</span><button data-attack="${node.id}" class="nodeAttack map-node-marker" ${reachable ? "" : "disabled"}><i class="node-emblem" aria-hidden="true"></i><span><strong>${escapeHtml(node.name)}</strong><small>${ownerLabel} · ${kindLabel}</small></span></button><div class="node-tooltip"><strong>${escapeHtml(node.name)}</strong><span>${node.distanceFromHome ?? 0} km · Defense ${node.defense.toFixed(2)}</span><span>${benefit}</span><b>${node.owner === "player" ? "Run defense exercise" : reachable ? "Launch operation" : "Route locked"}</b></div></article>`;
      }).join("");
      managementCenter.innerHTML = `
        <div class="workspace-header"><div><span class="eyebrow">Campaign / Operations</span><h1>Branching Theater</h1><p>Capture fields for income, outposts for free local support, and remote bases to shorten delivery routes.</p></div><div class="workspace-actions"><span class="map-readout">${ownedNodes}/${mapNodes.length} sectors controlled</span></div></div>
        <div class="campaign-map branching-map"><div class="map-vignette"></div><svg class="map-routes" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="true">${routeMarkup}</svg><div class="home-node"><i></i><span><strong>Main Base</strong><small>Only buildable base</small></span></div>${nodeMarkup}</div>
        <div class="map-footer"><div><span class="eyebrow">Live economy</span><strong>+${liveIncome} gas/resources per minute</strong></div><div><span class="eyebrow">Remote-base doctrine</span><strong>Captured relay bases reduce reinforcement time and distance cost</strong></div></div>`;
    }

    battlePanel.innerHTML = `
      <h3>Battle Ops</h3>
      <div class="small">Reinforcements travel in real time. Faster craft and closer controlled bases arrive sooner.</div>
      <div class="small">Delivery capacity: ${campaign.getDeliveryCapacity()} · ${deploymentQueue.length} en route. Off-screen AI uses selected default craft.</div>
      <div class="deployment-roster">${getDeployableTemplates().map((template) => `<label><input class="autoCraftToggle" type="checkbox" data-template-id="${template.id}" ${defaultAutoTemplateIds.includes(template.id) ? "checked" : ""} /> AI</label><button data-deploy="${template.id}">${template.name}</button>`).join("")}</div>
      <div class="queue-list">${deploymentQueue.map((order) => { const template = templates.find((entry) => entry.id === order.templateId); const progress = 100 * (1 - order.remainingSeconds / Math.max(1, order.totalSeconds)); return `<div class="queue-item"><div><strong>${escapeHtml(template?.name ?? "Craft")}</strong><span>${Math.ceil(order.remainingSeconds)}s · ${escapeHtml(order.sourceName)}</span></div><div class="progress-track"><i style="width:${progress}%"></i></div></div>`; }).join("") || `<div class="small">No craft en route.</div>`}</div>
      <div class="row">
        <span class="small">Spawn side:</span>
        <button id="btnDeploySidePlayer" ${battleDeploySide === "player" ? "class=\"active\"" : ""}>Player Spawn</button>
        <button id="btnDeploySideEnemy" ${battleDeploySide === "enemy" ? "class=\"active\"" : ""}>Enemy Spawn</button>
      </div>
      <div id="friendlyActive" class="small"></div>
      ${battle.getState().outcome ? `<div class="row"><button id="btnBackToMap">Return to Map</button></div>` : ""}
    `;

    const playerSpawnTemplateIds = getTestArenaPlayerSpawnTemplateIds();
    const playerSpawnTemplateIdSet = new Set<number>(playerSpawnTemplateIds);
    const enemySpawnTemplateIds = getTestArenaEnemySpawnTemplateIds();
    const enemySpawnTemplateIdSet = new Set<number>(enemySpawnTemplateIds);
    const spawnTemplateOptions = getDeployableTemplates()
      .map((template) => `
        <span class="small test-arena-craft-name">${escapeHtml(template.name)}</span>
        <label class="small test-arena-spawn-option" title="Auto-spawn ${escapeHtml(template.name)} for Player">
          <input class="testArenaPlayerSpawnTemplateToggle" type="checkbox" data-template-id="${template.id}" ${playerSpawnTemplateIdSet.has(template.id) ? "checked" : ""} />
          <span>Player</span>
        </label>
        <label class="small test-arena-spawn-option" title="Auto-spawn ${escapeHtml(template.name)} for Enemy">
          <input class="testArenaEnemySpawnTemplateToggle" type="checkbox" data-template-id="${template.id}" ${enemySpawnTemplateIdSet.has(template.id) ? "checked" : ""} />
          <span>Enemy</span>
        </label>
      `)
      .join("");
    const enemySpawnSummary = enemySpawnTemplateIds.length <= 0 ? "None" : `${enemySpawnTemplateIds.length} selected`;
    const playerSpawnSummary = playerSpawnTemplateIds.length <= 0 ? "None" : `${playerSpawnTemplateIds.length} selected`;
    const spawnDropdownOpenAttr = testArenaSpawnTemplateDropdownOpen ? "open" : "";
    const manualSectionOpenAttr = testArenaPanelSections.manual ? "open" : "";
    if (testArenaTemplateStoreReady && !getDeployableTemplates().some((template) => template.id === testArenaManualSpawnTemplateId)) {
      testArenaManualSpawnTemplateId = getDeployableTemplates()[0]?.id ?? 0;
    }
    const manualSpawnTemplateOptions = getDeployableTemplates()
      .map((template) => `<option value="${template.id}" ${template.id === testArenaManualSpawnTemplateId ? "selected" : ""}>${escapeHtml(template.name)}</option>`)
      .join("");
    const renderCompositeModelOptions = (side: TestArenaSide): string => {
      const selectedId = testArenaCompositeModelSelections[side];
      return testArenaCompositeModelOptions
        .map((entry) => {
          const disabled = entry.compatible === false;
          return `<option value="${entry.id}" ${entry.id === selectedId ? "selected" : ""} ${disabled ? "disabled" : ""}>${escapeHtml(entry.label)}</option>`;
        })
        .join("");
    };
    const renderModuleCell = (side: TestArenaSide, kind: TestArenaAiModuleKind): string => {
      const selectedId = testArenaAiSelections[side][kind];
      const options = testArenaAiOptions[kind]
        .map((entry) => {
          const disabled = entry.compatible === false || !entry.spec?.familyId;
          return `<option value="${entry.id}" ${entry.id === selectedId ? "selected" : ""} ${disabled ? "disabled" : ""}>${escapeHtml(entry.label)}</option>`;
        })
        .join("");
      return `
        <select id="testArenaCompSelect_${side}_${kind}">${options}</select>
      `;
    };
    const enemyCountLabel = Math.max(0, Math.floor(testArenaEnemyCount));
    const playerCountLabel = Math.max(0, Math.floor(testArenaPlayerCount));
    const zoomPercentLabel = Math.round(battleViewScale * 100);
    const unitSectionOpenAttr = testArenaPanelSections.unit ? "open" : "";
    const aiSectionOpenAttr = testArenaPanelSections.ai ? "open" : "";
    const uiSectionOpenAttr = testArenaPanelSections.ui ? "open" : "";
    testArenaPanel.innerHTML = `
      <div class="panel-heading"><div><span class="eyebrow">Scenario laboratory</span><h2>Test Arena</h2></div><span class="health-pill ${isTestArenaActive ? "good" : ""}"><i></i>${isTestArenaActive ? " Running" : " Ready"}</span></div>
      <div class="developer-intro">Configure reproducible spawn pressure, AI policy, survivability, and battlefield geometry without campaign rewards.</div>
      <div class="row">
        <button id="btnStartTestArena" class="button-primary">${isTestArenaActive ? "Restart Test Arena" : "Start Test Arena"}</button>
        ${isTestArenaActive ? `<button id="btnEndTestArena">End Test Arena</button>` : ""}
      </div>
      <details id="testArenaSectionUnit" class="test-arena-section" ${unitSectionOpenAttr}>
        <summary><strong>Unit</strong></summary>
        <div class="test-arena-section-body">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; align-items:center;">
            <div class="small"><strong>Player</strong></div>
            <div class="small"><strong>Enemy</strong></div>
            <input id="testArenaPlayerCount" type="number" min="0" max="40" step="1" value="${playerCountLabel}" />
            <input id="testArenaEnemyCount" type="number" min="0" max="40" step="1" value="${enemyCountLabel}" />
            <details id="testArenaSpawnTemplateDropdown" class="test-arena-spawn-dropdown test-arena-spawn-dropdown-shared" ${spawnDropdownOpenAttr}>
              <summary class="small">Craft types · Player ${playerSpawnSummary} · Enemy ${enemySpawnSummary}</summary>
              <div class="test-arena-spawn-options test-arena-spawn-options-shared">
                <strong class="small">Craft</strong><strong class="small">Player</strong><strong class="small">Enemy</strong>
                ${spawnTemplateOptions}
              </div>
            </details>
            <label class="small"><input id="testArenaAutoSpawnOnPlayerSide" type="checkbox" ${testArenaAutoSpawnOnPlayerSide ? "checked" : ""} /> Auto spawn</label>
            <label class="small"><input id="testArenaAutoSpawnOnEnemySide" type="checkbox" ${testArenaAutoSpawnOnEnemySide ? "checked" : ""} /> Auto spawn</label>
          </div>
          <div class="test-arena-spawn-row">
            <button id="btnClearTestArenaUnits" class="warn">Clear all units</button>
          </div>
          <label class="small"><input id="testArenaInvinciblePlayer" type="checkbox" ${testArenaInvinciblePlayer ? "checked" : ""} /> Player controlled invincible</label>
          <div class="small">Invincible player still collides and can be targeted, but takes no damage.</div>
        </div>
      </details>
      <details id="testArenaSectionManual" class="test-arena-section" ${manualSectionOpenAttr}>
        <summary><strong>Manual Spawn</strong></summary>
        <div class="test-arena-section-body">
          <div class="small">Spawn exactly one selected craft immediately on either side of a running Test Arena.</div>
          <label class="small">Craft <select id="testArenaManualSpawnTemplate">${manualSpawnTemplateOptions}</select></label>
          <label class="small">Side
            <select id="testArenaManualSpawnSide">
              <option value="player" ${testArenaManualSpawnSide === "player" ? "selected" : ""}>Player</option>
              <option value="enemy" ${testArenaManualSpawnSide === "enemy" ? "selected" : ""}>Enemy</option>
            </select>
          </label>
          <button id="btnTestArenaManualSpawn" class="button-primary" ${isTestArenaActive && testArenaManualSpawnTemplateId > 0 ? "" : "disabled"}>Spawn one craft</button>
          ${isTestArenaActive ? "" : `<div class="small warn">Start Test Arena to enable manual spawning.</div>`}
        </div>
      </details>
      <details id="testArenaSectionAi" class="test-arena-section" ${aiSectionOpenAttr}>
        <summary><strong>AI Selection</strong></summary>
        <div class="test-arena-section-body">
          <div class="row">
            <button id="btnRefreshArenaAiModels">Refresh AI list</button>
          </div>
          <div class="small">Select composed model per side. Use Custom components if you want per-stage module control.</div>
          <div class="test-arena-ai-model-grid">
            <div class="small"></div>
            <div class="small"><strong>Player</strong></div>
            <div class="small"><strong>Enemy</strong></div>
            <div class="small">Composed model</div>
            <select id="testArenaCompositeModel_player">${renderCompositeModelOptions("player")}</select>
            <select id="testArenaCompositeModel_enemy">${renderCompositeModelOptions("enemy")}</select>
          </div>
          <div class="small">Component grid below is active only when side model is set to Custom components.</div>
          <div class="test-arena-ai-grid">
            <div class="small"></div>
            <div class="small"><strong>Player</strong></div>
            <div class="small"><strong>Enemy</strong></div>
            <div class="small">Target</div>
            ${renderModuleCell("player", "target")}
            ${renderModuleCell("enemy", "target")}
            <div class="small">Movement</div>
            ${renderModuleCell("player", "movement")}
            ${renderModuleCell("enemy", "movement")}
            <div class="small">Shoot</div>
            ${renderModuleCell("player", "shoot")}
            ${renderModuleCell("enemy", "shoot")}
          </div>
          <div class="small">AI presets apply to Test Arena only; campaign battles keep default behavior.</div>
        </div>
      </details>
      <details id="testArenaSectionUi" class="test-arena-section" ${uiSectionOpenAttr}>
        <summary><strong>UI Configuration</strong></summary>
        <div class="test-arena-section-body">
          <div class="small">Battlefield W/H and ground height update simulation size. Zoom changes display scale only.</div>
          <div class="row"><label class="small">Both base HP <input id="testArenaBaseHp" type="number" min="1" max="1000000000" step="100" value="${testArenaBaseHp}" /></label></div>
          <div class="row">
            <button id="testArenaUseGlobalBattlefield" type="button">Use Global Battlefield</button>
            <span class="small">${testArenaBattlefieldUsesGlobalDefaults ? "Following Global Settings" : "Using a Test Arena override"}</span>
          </div>
          <div class="test-arena-ui-grid">
            <span class="small">Width</span>
            <span class="small">Height</span>
            <span class="small">Zoom %</span>
            <span class="small">Ground H</span>
            <input id="testArenaBattlefieldWidth" type="number" min="640" step="10" value="${testArenaBattlefieldWidth}" />
            <input id="testArenaBattlefieldHeight" type="number" min="360" step="10" value="${testArenaBattlefieldHeight}" />
            <input id="testArenaZoomPercent" type="number" min="10" max="240" step="1" value="${zoomPercentLabel}" />
            <input id="testArenaGroundHeight" type="number" min="80" max="${Math.max(120, testArenaBattlefieldHeight - 40)}" step="10" value="${testArenaGroundHeight}" />
          </div>
        </div>
      </details>
    `;

    const craftAiOptions = (selectedId: string): string => {
      const available = testArenaCompositeModelOptions.filter((option) => option.id !== "custom-components" && option.spec);
      const selectedExists = available.some((option) => option.id === selectedId && option.compatible !== false);
      return `${selectedExists ? "" : `<option value="${escapeHtml(selectedId)}" selected>Missing or incompatible AI (${escapeHtml(selectedId)})</option>`}${available
        .map((option) => `<option value="${escapeHtml(option.id)}" ${option.id === selectedId ? "selected" : ""} ${option.compatible === false ? "disabled" : ""}>${escapeHtml(option.label)}</option>`)
        .join("")}`;
    };
    const craftArenaAnyBusy = craftArenaScenarios.some((scenario) => scenario.busy);
    const craftArenaGlobalDisabled = craftArenaAnyBusy ? "disabled" : "";
    craftArenaPanel.innerHTML = `
      <div class="panel-heading"><div><span class="eyebrow">Balance laboratory</span><h2>Craft Arena</h2></div></div>
      <div class="developer-intro">Global settings apply to every headless scenario. Craft A always starts on the left; Craft B always starts on the right.</div>
      <div class="sidebar-metric"><span>Craft pairs</span><strong>${craftArenaScenarios.length}</strong></div>
      <div class="sidebar-metric"><span>Run mode</span><strong>1 continuous battle</strong></div>
      <div class="craft-arena-global-settings">
        <label class="small">Craft quantity per side<input id="craftArenaGlobalQuantity" type="number" min="1" max="40" step="1" value="${craftArenaSettings.quantity}" ${craftArenaGlobalDisabled} /></label>
        <label class="small">Battle duration (minutes)<input id="craftArenaGlobalDuration" type="number" min="1" max="60" step="1" value="${craftArenaSettings.durationMinutes}" ${craftArenaGlobalDisabled} /></label>
        <label class="small">Shared AI<select id="craftArenaGlobalAi" ${craftArenaGlobalDisabled}>${craftAiOptions(craftArenaSettings.aiModelId)}</select></label>
        <div class="section-divider"></div>
        <div class="section-label">Battlefield</div>
        <div class="test-arena-ui-grid">
          <label class="small">Width<input id="craftArenaGlobalWidth" type="number" min="640" step="10" value="${craftArenaSettings.battlefieldWidth}" ${craftArenaGlobalDisabled} /></label>
          <label class="small">Height<input id="craftArenaGlobalHeight" type="number" min="360" step="10" value="${craftArenaSettings.battlefieldHeight}" ${craftArenaGlobalDisabled} /></label>
          <label class="small">Ground H<input id="craftArenaGlobalGroundHeight" type="number" min="80" max="${Math.max(120, craftArenaSettings.battlefieldHeight - 40)}" step="10" value="${craftArenaSettings.groundHeight}" ${craftArenaGlobalDisabled} /></label>
        </div>
        <button id="btnCraftArenaUseTestSettings" type="button" ${craftArenaGlobalDisabled}>Use Test Arena settings</button>
      </div>
      <div class="small">Destroyed craft respawn immediately, keeping both sides at ${craftArenaSettings.quantity} craft for the full duration. Changing a global setting clears prior results.</div>
      <div class="row"><button id="btnRunAllCraftArena" class="button-primary" ${craftArenaAnyBusy ? "disabled" : ""}>${craftArenaAnyBusy ? "Running matchups…" : "Run all matchups"}</button></div>
    `;
    const scenarioForPair = (craftAId: number, craftBId: number): CraftArenaScenario | undefined => craftArenaScenarios.find((scenario) => (
      (scenario.craftAId === craftAId && scenario.craftBId === craftBId)
      || (scenario.craftAId === craftBId && scenario.craftBId === craftAId)
    ));
    const heatmapTemplates = templates.filter((template) => craftArenaScenarios.some((scenario) => (
      scenario.craftAId === template.id || scenario.craftBId === template.id
    )));
    const resultSideForCraft = (scenario: CraftArenaScenario, craftId: number): CraftArenaSideResult | undefined => (
      scenario.craftAId === craftId ? scenario.result?.craftA : scenario.result?.craftB
    );
    const heatmapDifferences = craftArenaScenarios.flatMap((scenario) => {
      if (!scenario.result) return [];
      const valueA = scenario.result.craftA[craftArenaMetric];
      const valueB = scenario.result.craftB[craftArenaMetric];
      return [Math.abs(valueB - valueA)];
    });
    const heatmapMaxDifference = Math.max(1, ...heatmapDifferences);
    const heatmapRows = heatmapTemplates.map((rowCraft) => `
      <tr>
        <th scope="row">${escapeHtml(rowCraft.name)}</th>
        ${heatmapTemplates.map((columnCraft) => {
          if (rowCraft.id === columnCraft.id) {
            return `<td class="craft-heatmap-diagonal" aria-label="${escapeHtml(rowCraft.name)} versus itself">—</td>`;
          }
          const scenario = scenarioForPair(rowCraft.id, columnCraft.id);
          if (!scenario) {
            return `<td class="craft-heatmap-missing">—</td>`;
          }
          const rowResult = resultSideForCraft(scenario, rowCraft.id);
          const columnResult = resultSideForCraft(scenario, columnCraft.id);
          const rowValue = rowResult?.[craftArenaMetric];
          const columnValue = columnResult?.[craftArenaMetric];
          const difference = typeof rowValue === "number" && typeof columnValue === "number"
            ? columnValue - rowValue
            : 0;
          const intensity = Math.min(1, Math.abs(difference) / heatmapMaxDifference);
          const tone = difference > 0 ? "advantage" : difference < 0 ? "disadvantage" : "neutral";
          const displayValue = typeof rowValue === "number" ? Math.round(rowValue).toLocaleString() : "…";
          const unit = craftArenaMetric === "gasWasted" ? "gas wasted" : "destroyed";
          return `<td>
            <button
              class="craft-heatmap-cell ${tone} ${craftArenaSelectedScenarioId === scenario.id ? "selected" : ""}"
              style="--heat-strength:${intensity.toFixed(3)}"
              data-craft-arena-select="${escapeHtml(scenario.id)}"
              aria-label="${escapeHtml(rowCraft.name)} versus ${escapeHtml(columnCraft.name)}: ${displayValue} ${unit}"
            >${displayValue}</button>
          </td>`;
        }).join("")}
      </tr>
    `).join("");
    craftArenaCenter.innerHTML = `
      <div class="workspace-header"><div><span class="eyebrow">Developer Tools / Craft Arena</span><h1>Craft Comparison</h1><p>Each cell reports the row craft's result against the column craft. Cooler green means the row craft lost less; warmer red means it lost more.</p></div></div>
      <div class="craft-heatmap-tabs" role="tablist" aria-label="Heat map metric">
        <button id="craftHeatmapDestroyed" role="tab" aria-selected="${craftArenaMetric === "destroyed"}" class="${craftArenaMetric === "destroyed" ? "active" : ""}">Number destroyed</button>
        <button id="craftHeatmapGas" role="tab" aria-selected="${craftArenaMetric === "gasWasted"}" class="${craftArenaMetric === "gasWasted" ? "active" : ""}">Gas wasted</button>
      </div>
      ${heatmapTemplates.length > 1 ? `
        <div class="craft-heatmap-wrap">
          <table class="craft-heatmap" aria-label="Craft comparison heat map for ${craftArenaMetric === "gasWasted" ? "gas wasted" : "number destroyed"}">
            <thead><tr><th></th>${heatmapTemplates.map((template) => `<th scope="col">${escapeHtml(template.name)}</th>`).join("")}</tr></thead>
            <tbody>${heatmapRows}</tbody>
          </table>
        </div>
        <div class="craft-heatmap-legend"><span>Row craft performs better</span><i class="better"></i><i class="even"></i><i class="worse"></i><span>Row craft performs worse</span></div>
      ` : `<div class="empty-state"><div><strong>No matchup matrix</strong><small>Run or import craft matchup scenarios to populate the heat map.</small></div></div>`}
    `;

    const leaderboardRows = testArenaLeaderboardEntries
      .map((entry, index) => {
        const winRate = Number.isFinite(entry.winRate) ? `${(Number(entry.winRate) * 100).toFixed(1)}%` : "-";
        const score = Number.isFinite(entry.leaderboardScore) ? Number(entry.leaderboardScore).toFixed(2) : "-";
        const averageRatio = Number.isFinite(entry.averageRatio) ? Number(entry.averageRatio).toFixed(2) : "-";
        const destroyedLost = `${Math.round(Number(entry.destroyedUnits) || 0)}/${Math.round(Number(entry.lostUnits) || 0)}`;
        const previousLevelRate = Number.isFinite(entry.previousLevelWinRate)
          ? `${(Number(entry.previousLevelWinRate) * 100).toFixed(1)}% (${Number(entry.previousLevelRounds) || 0})${entry.previousLevelCertified ? " ✓" : ""}`
          : entry.runId === "level-1-ai" ? "reference" : "not tested";
        const wins = Number.isFinite(entry.wins) ? Number(entry.wins) : 0;
        const rounds = Number.isFinite(entry.rounds) ? Number(entry.rounds) : (Number.isFinite(entry.games) ? Number(entry.games) : 0);
        const losses = Number.isFinite(entry.losses) ? Number(entry.losses) : 0;
        const ties = Number.isFinite(entry.ties) ? Number(entry.ties) : 0;
        const rankTag = entry.isUnranked ? `<span class="small warn">unranked</span>` : "";
        const spec = entry.spec?.composite;
        const targetName = spec?.target?.familyId ?? "-";
        const movementName = spec?.movement?.familyId ?? "-";
        const shootName = spec?.shoot?.familyId ?? "-";
        const components = `${targetName} / ${movementName} / ${shootName}`;
        return `<tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(entry.runId)} ${rankTag}</td>
          <td>${escapeHtml(components)}</td>
          <td>${score}</td>
          <td>${averageRatio}</td>
          <td>${destroyedLost}</td>
          <td>${escapeHtml(previousLevelRate)}</td>
          <td>${winRate}</td>
          <td>${wins}/${losses}/${ties}</td>
          <td>${rounds}</td>
        </tr>`;
      })
      .join("");
    const leaderboardProgressRows = testArenaLeaderboardCompeteProgress
      .map((match) => {
        const simSeconds = Math.min(match.maxSimSeconds || match.simSecondsElapsed, match.simSecondsElapsed);
        const progressRatio = match.maxSimSeconds > 0 ? Math.min(1, simSeconds / match.maxSimSeconds) : 0;
        const progressPercent = progressRatio * 100;
        const endMs = match.finishedAtMs ?? Date.now();
        const wallSeconds = match.startedAtMs ? Math.max(0, (endMs - match.startedAtMs) / 1000) : 0;
        const statusLabel = match.status === "completed"
          ? "Completed"
          : match.status === "failed"
            ? "Failed"
            : match.status === "running"
              ? "Running"
              : "Queued";
        return `<tr>
          <td>${match.index + 1}</td>
          <td>${escapeHtml(match.runA)} vs ${escapeHtml(match.runB)}</td>
          <td><span class="leaderboard-run-status ${match.status}"${match.error ? ` title="${escapeHtml(match.error)}"` : ""}>${statusLabel}</span></td>
          <td>${simSeconds.toFixed(0)} / ${match.maxSimSeconds.toFixed(0)} s</td>
          <td>
            <div class="leaderboard-run-progress" aria-label="${progressPercent.toFixed(0)} percent complete">
              <i style="width:${progressPercent.toFixed(2)}%"></i>
            </div>
          </td>
          <td>${match.units}</td>
          <td>${match.projectiles}</td>
          <td>${match.startedAtMs ? `${wallSeconds.toFixed(1)} s` : "-"}</td>
        </tr>`;
      })
      .join("");
    const competeRunsValue = Math.max(1, Math.floor(testArenaLeaderboardCompeteRuns));
    const competeModeOptions = `
      <option value="random-pair" ${testArenaLeaderboardCompeteMode === "random-pair" ? "selected" : ""}>Random pair</option>
      <option value="unranked-vs-random" ${testArenaLeaderboardCompeteMode === "unranked-vs-random" ? "selected" : ""}>Unranked vs random</option>
      <option value="manual-vs-random" ${testArenaLeaderboardCompeteMode === "manual-vs-random" ? "selected" : ""}>Manual vs random</option>
      <option value="manual-pair" ${testArenaLeaderboardCompeteMode === "manual-pair" ? "selected" : ""}>Manual pair</option>
    `;
    const manualPairOptionsA = testArenaLeaderboardEntries
      .map((entry) => `<option value="${escapeHtml(entry.runId)}" ${entry.runId === testArenaLeaderboardManualPairA ? "selected" : ""}>${escapeHtml(entry.runId)}</option>`)
      .join("");
    const manualPairOptionsB = testArenaLeaderboardEntries
      .map((entry) => `<option value="${escapeHtml(entry.runId)}" ${entry.runId === testArenaLeaderboardManualPairB ? "selected" : ""}>${escapeHtml(entry.runId)}</option>`)
      .join("");
    const manualVsRandomOptions = testArenaLeaderboardEntries
      .map((entry) => `<option value="${escapeHtml(entry.runId)}" ${entry.runId === testArenaLeaderboardManualVsRandom ? "selected" : ""}>${escapeHtml(entry.runId)}</option>`)
      .join("");
    leaderboardPanel.innerHTML = `
      <div class="panel-heading"><div><span class="eyebrow">AI evaluation</span><h2>Leaderboard</h2></div></div>
      <div class="developer-intro">Configure and run reproducible Elo competitions between AI models.</div>
      <div class="leaderboard-actions">
        <label class="small">Mode
          <select id="leaderboardCompeteMode">
            ${competeModeOptions}
          </select>
        </label>
        <label class="small">Runs
          <input id="leaderboardCompeteRuns" type="number" min="1" step="1" value="${competeRunsValue}" />
        </label>
        ${testArenaLeaderboardCompeteMode === "manual-pair" ? `
          <label class="small">Model A
            <select id="leaderboardManualPairA">${manualPairOptionsA}</select>
          </label>
          <label class="small">Model B
            <select id="leaderboardManualPairB">${manualPairOptionsB}</select>
          </label>
        ` : ""}
        ${testArenaLeaderboardCompeteMode === "manual-vs-random" ? `
          <label class="small">Model
            <select id="leaderboardManualVsRandom">${manualVsRandomOptions}</select>
          </label>
        ` : ""}
        <div class="row">
          <button id="btnLeaderboardCompete" ${testArenaLeaderboardCompeteBusy ? "disabled" : ""}>${testArenaLeaderboardCompeteBusy ? "Running..." : "Run Competition"}</button>
          <button id="btnRefreshLeaderboard">Refresh</button>
          <button id="btnResetLeaderboard" class="warn">Reset Scores</button>
        </div>
        <div class="small">${escapeHtml(testArenaLeaderboardCompeteStatus || " ")}</div>
      </div>
    `;

    leaderboardCenter.innerHTML = `
      <h3>AI Leaderboard</h3>
      <div class="small">Persistent head-to-head ranking. “Vs previous” is certified after 16 matches and must exceed 60%.</div>
      <div class="leaderboard-table-wrap" style="margin-top:6px; border:1px solid #333; border-radius:6px; padding:6px; max-height:520px; overflow:auto;">
        ${testArenaLeaderboardLoading ? `<div class="small">Loading...</div>` : ""}
        ${!testArenaLeaderboardLoading && leaderboardRows.length <= 0 ? `<div class="small warn">No leaderboard data found. Train composite runs first.</div>` : ""}
        ${!testArenaLeaderboardLoading && leaderboardRows.length > 0 ? `<table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr>
              <th style="text-align:left;">#</th>
              <th style="text-align:left;">Run</th>
              <th style="text-align:left;">Components (Target / Move / Shoot)</th>
              <th style="text-align:left;">Score</th>
              <th style="text-align:left;">Avg. destroyed ratio</th>
              <th style="text-align:left;">Destroyed/Lost</th>
              <th style="text-align:left;">Vs previous</th>
              <th style="text-align:left;">Win Rate</th>
              <th style="text-align:left;">W/L/T</th>
              <th style="text-align:left;">Rounds</th>
            </tr>
          </thead>
          <tbody>${leaderboardRows}</tbody>
        </table>` : ""}
      </div>
      ${leaderboardProgressRows ? `
        <section class="leaderboard-runs" aria-live="polite">
          <h3>Competition Runs</h3>
          <div class="small">Live worker progress. This table is removed when the competition finishes.</div>
          <div class="leaderboard-runs-scroll">
            <table class="leaderboard-runs-table">
              <thead><tr><th>#</th><th>Match</th><th>Status</th><th>Simulation</th><th>Progress</th><th>Units</th><th>Shots</th><th>Wall time</th></tr></thead>
              <tbody>${leaderboardProgressRows}</tbody>
            </table>
          </div>
        </section>
      ` : ""}
    `;

    ensureEditorSelectionForLayer();
    if (isTemplateEditorScreen()) {
      const computedTemplateGas = computeTemplateGasCost(editorDraft, parts);
      editorDraft.gasCost = computedTemplateGas;
      if (editorTemplateDialogSelectedId === null || !templates.some((template) => template.id === editorTemplateDialogSelectedId)) {
        editorTemplateDialogSelectedId = templates[0]?.id ?? null;
      }
      const makeTemplateRows = (type: UnitTemplate["type"]): string => templates
        .filter((template) => template.type === type)
        .map((template) => ({
          template,
          gasCost: computeTemplateGasCost(template, parts),
        }))
        .sort((a, b) => (a.gasCost - b.gasCost) || a.template.name.localeCompare(b.template.name))
        .map(({ template, gasCost }) => {
          const selectedClass = template.id === editorTemplateDialogSelectedId ? "active" : "";
          return `<div class="row" style="gap:8px; flex-wrap:nowrap; align-items:center;">
            <button data-editor-open-select="${template.id}" class="${selectedClass}" style="flex:1; text-align:left;">${template.name} (${gasCost} gas)</button>
            <div style="display:flex; gap:6px; margin-left:auto;">
              <button data-editor-open-copy="${template.id}">Copy</button>
              <button data-editor-open-delete="${template.id}">Delete</button>
            </div>
          </div>`;
        })
        .join("");
      const groundTemplateRows = makeTemplateRows("ground");
      const airTemplateRows = makeTemplateRows("air");
      const baseTemplateRows = makeTemplateRows("base");
      const templateOpenRows = `
        <div><strong>Ground</strong></div>
        ${groundTemplateRows || `<div class="small">No ground template available.</div>`}
        <div style="margin-top:8px;"><strong>Air</strong></div>
        ${airTemplateRows || `<div class="small">No air template available.</div>`}
        <div style="margin-top:8px;"><strong>Base</strong></div>
        ${baseTemplateRows || `<div class="small">No base template available.</div>`}
      `;
      editorPanel.innerHTML = `
        <div class="panel-heading"><div><span class="eyebrow">Object authoring</span><h2>Craft Designer</h2></div><span class="health-pill"><i></i>${editorDraft.type}</span></div>
        <div class="developer-intro">Build a craft by layering structure, functional systems, and display treatments on the ${editorGridCols}×${editorGridRows} workspace.</div>
        <div class="row">
          <button id="btnOpenTemplateWindow">Open</button>
          <span class="small">Current object: ${editorDraft.name}</span>
        </div>
        ${editorTemplateDialogOpen ? `<div id="editorOpenTemplateOverlay" class="editor-open-overlay">
          <div class="node-card editor-open-modal">
            <div><strong>Open Template</strong></div>
            <div class="small">Click a template row to open it directly. Use Copy to clone it, or Delete to remove file-backed entries.</div>
            <div style="display:flex; flex:1; min-height:0; flex-direction:column; gap:6px; margin-top:8px; overflow:auto;">
              ${templateOpenRows || `<div class="small">No template available.</div>`}
            </div>
            <div class="row" style="margin-top:8px;">
              <button id="btnOpenTemplateClose">Close</button>
            </div>
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
              <option value="base" ${editorDraft.type === "base" ? "selected" : ""}>Base</option>
            </select>
          </label>
        </div>
        <div class="small">Gas cost = ${computedTemplateGas} (sum of part gas values).</div>
        <div class="row">
          <label class="small"><input id="editorDeleteMode" type="checkbox" ${editorDeleteMode ? "checked" : ""} /> Delete mode</label>
          <label class="small"><input id="editorPlaceByCenter" type="checkbox" ${editorPlaceByCenter ? "checked" : ""} /> Center place on click</label>
          <span class="small">Selected: ${editorSelection || "none"}</span>
        </div>
        <div class="row">
          <span class="small">${(() => {
            const selectedPart = resolvePartForSelection(editorSelection);
            if (!selectedPart || !isCurrentEditorSelectionRotatable()) {
              return "Rotation: n/a";
            }
            const directional = isDirectionalPart(selectedPart);
            const facingQuarter = directional
              ? getDirectionalFacingQuarter(selectedPart, editorWeaponRotateQuarter)
              : editorWeaponRotateQuarter;
            return `${directional ? "Direction" : "Footprint rotation"}: ${facingQuarter * 90}deg (${getRotationSymbol(facingQuarter)})`;
          })()}</span>
        </div>
        <div class="row">
          <button id="btnNewDraft">New Draft</button>
          <button id="btnClearGrid">Clear Grid</button>
        </div>
        <div class="row">
          <button id="btnSaveDraftDefault">Save</button>
        </div>
      `;
    } else {
      if (partDesignerSelectedId === null) {
        partDesignerSelectedId = partDesignerDraft.id || null;
      }
      if (partDesignerSelectedId !== partDesignerDraft.id && !parts.some((part) => part.id === partDesignerSelectedId)) {
        partDesignerSelectedId = partDesignerDraft.id || null;
      }
      const partOpenFilterOptions: Array<{ value: PartOpenFilter; label: string }> = [{ value: "all", label: "All" }];
      if (parts.some((part) => part.layer === "structure")) {
        partOpenFilterOptions.push({ value: "structure", label: "Structure" });
      }
      const functionalTypeOrder: Array<Exclude<PartOpenFilter, "all" | "structure">> = ["control", "engine", "weapon", "loader"];
      for (const type of functionalTypeOrder) {
        if (parts.some((part) => part.layer === "functional" && COMPONENTS[part.baseComponent].type === type)) {
          partOpenFilterOptions.push({ value: type, label: type });
        }
      }
      const filteredPartOpenList = parts.filter((part) => {
        if (partDesignerOpenFilter === "all") {
          return true;
        }
        if (partDesignerOpenFilter === "structure") {
          return part.layer === "structure";
        }
        return part.layer === "functional" && COMPONENTS[part.baseComponent].type === partDesignerOpenFilter;
      });
      const partOpenRows = filteredPartOpenList
        .map((part) => {
          const selectedClass = part.id === partDesignerSelectedId ? "active" : "";
          return `<div class="row" style="gap:8px; flex-wrap:nowrap; align-items:center;">
            <button data-part-open-select="${part.id}" class="${selectedClass}" style="flex:1; text-align:left;">${part.name} [${part.layer}] (${part.baseComponent})</button>
            <div style="display:flex; gap:6px; margin-left:auto;">
              <button data-part-open-copy="${part.id}">Copy</button>
              <button data-part-open-delete="${part.id}">Delete</button>
            </div>
          </div>`;
        })
        .join("");
      syncPartTypeAndComponent(partDesignerDraft);
      const resolvedPartType = getResolvedPartType(partDesignerDraft);
      const resolvedPartCategory = getResolvedPartCategory(partDesignerDraft);
      const isStructureLayerMode = resolvedPartType === "structure";
      const baseStats = COMPONENTS[partDesignerDraft.baseComponent];
      const runtimePlaceholders = {
        gasCost: baseStats.gasCost !== undefined ? String(baseStats.gasCost) : "0",
        mass: String(baseStats.mass),
        hpMul: String(baseStats.hpMul),
        power: baseStats.power !== undefined ? String(baseStats.power) : "none",
        maxSpeed: baseStats.maxSpeed !== undefined ? String(baseStats.maxSpeed) : "none",
        recoil: baseStats.recoil !== undefined ? String(baseStats.recoil) : "none",
        hitImpulse: baseStats.hitImpulse !== undefined ? String(baseStats.hitImpulse) : "none",
        damage: baseStats.damage !== undefined ? String(baseStats.damage) : "none",
        range: baseStats.range !== undefined ? String(baseStats.range) : "none",
        cooldown: baseStats.cooldown !== undefined ? String(baseStats.cooldown) : "none",
        projectileSpeed: baseStats.projectileSpeed !== undefined ? String(baseStats.projectileSpeed) : "none",
        projectileGravity: baseStats.projectileGravity !== undefined ? String(baseStats.projectileGravity) : "none",
        penetration: baseStats.penetration !== undefined ? String(baseStats.penetration) : "0",
        spreadDeg: baseStats.spreadDeg !== undefined ? String(baseStats.spreadDeg) : "none",
        explosiveBlastRadius: baseStats.explosive?.blastRadius !== undefined ? String(baseStats.explosive.blastRadius) : "none",
        explosiveBlastDamage: baseStats.explosive?.blastDamage !== undefined ? String(baseStats.explosive.blastDamage) : "none",
        explosiveFalloffPower: baseStats.explosive?.falloffPower !== undefined ? String(baseStats.explosive.falloffPower) : "none",
        trackingTurnRateDegPerSec: baseStats.tracking?.turnRateDegPerSec !== undefined ? String(baseStats.tracking.turnRateDegPerSec) : "none",
        loaderLoadMultiplier: baseStats.loader?.loadMultiplier !== undefined ? String(baseStats.loader.loadMultiplier) : "none",
        loaderMinLoadTime: baseStats.loader?.minLoadTime !== undefined ? String(baseStats.loader.minLoadTime) : "none",
        weaponMaxLoadedAmmo: String(baseStats.maxLoadedAmmo ?? 1),
        loaderMinBurstInterval: baseStats.loader?.minBurstInterval !== undefined ? String(baseStats.loader.minBurstInterval) : "none",
        cwAngle: baseStats.cwAngle !== undefined ? String(baseStats.cwAngle) : "none",
        ccwAngle: baseStats.ccwAngle !== undefined ? String(baseStats.ccwAngle) : "none",
      };

      const partProps = partDesignerDraft.properties ?? {};
      const partRuntimeProps = partDesignerDraft.partProperties ?? getPartPropertiesDefaultsByType(resolvedPartType, resolvedPartCategory);
      const partTypeOptions: PartType[] = ["structure", "control", "engine", "weapon", "loader"];
      const canonicalCategoryParts = CANONICAL_PART_CATEGORIES[resolvedPartType]
        .map((name) => ({
          name,
          label: resolvedPartType === "engine"
            ? (name.includes("aircraft") ? "aircraft engine" : "tank engine")
            : resolvedPartType === "weapon" && name === "cannons"
              ? "cannon"
              : name,
          part: parts.find((part) => part.name.trim().toLowerCase() === name),
        }))
        .filter((entry) => resolvedPartType !== "engine" || entry.name.startsWith("light "))
        .filter((entry): entry is { name: string; label: string; part: PartDefinition } => entry.part !== undefined);
      const selectedCanonicalPartId = resolvedPartType === "engine"
        ? (canonicalCategoryParts.find((entry) => (
            resolvedPartCategory === "jet"
              ? entry.name.includes("aircraft")
              : entry.name.includes("tank")
          ))?.part.id ?? null)
        : resolvedPartType === "weapon" && partDesignerDraft.properties?.subcategory === "cannon"
          ? (canonicalCategoryParts.find((entry) => entry.name === "cannons")?.part.id ?? null)
          : canonicalCategoryParts.some((entry) => entry.part.id === partDesignerDraft.id)
            ? partDesignerDraft.id
            : null;
      const propIsEngine = resolvedPartType === "engine";
      const propIsWeapon = resolvedPartType === "weapon";
      const propIsLoader = resolvedPartType === "loader";
      const showAngleLimitControls = propIsWeapon;
      const hasAngleLimitChecked = partRuntimeProps.hasAngleLimit === true;
      const weaponMaxLoadedAmmo = Math.max(
        1,
        Math.floor(partRuntimeProps.maxCapacity ?? baseStats.maxLoadedAmmo ?? 1),
      );
      const projectileClass = partRuntimeProps.projectileClass ?? baseStats.projectileClass ?? "bullet";
      const projectileShapeOptions = PROJECTILE_SHAPES[projectileClass];
      const projectileShape = projectileShapeOptions.some((option) => option.value === partRuntimeProps.projectileShape)
        ? partRuntimeProps.projectileShape
        : projectileShapeOptions[0]?.value;
      const weaponSupportsExplosive = projectileClass !== "laser"
        && (partRuntimeProps.explodeOnHit === true || baseStats.explosive !== undefined);
      const weaponSupportsTracking = projectileClass === "missile" && partRuntimeProps.tracking === true;
      const loaderSupportsPlaceholder = baseStats.loader?.supports?.join(", ") ?? "none";
      editorPanel.innerHTML = `
        <div class="panel-heading"><div><span class="eyebrow">Component authoring</span><h2>Part Designer</h2></div><span class="health-pill"><i></i>${resolvedPartType}</span></div>
        <div class="developer-intro">Define reusable geometry, structure support rules, and runtime behavior for a single component.</div>
        <div class="row">
          <button id="btnOpenPartWindow">Open</button>
          <span class="small">Current part: ${partDesignerDraft.name}</span>
        </div>
        ${partDesignerDialogOpen ? `<div id="editorOpenPartOverlay" class="editor-open-overlay">
          <div class="node-card editor-open-modal">
            <div><strong>Open Part</strong></div>
            <div class="small">Click a part row to open it. Use Copy to clone it, or Delete to remove file-backed entries.</div>
            <div class="row" style="gap:6px; margin-top:8px; flex-wrap:wrap;">
              ${partOpenFilterOptions
                .map((option) => `<button data-part-open-filter="${option.value}" class="${partDesignerOpenFilter === option.value ? "active" : ""}">${option.label}</button>`)
                .join("")}
            </div>
            <div style="display:flex; flex:1; min-height:0; flex-direction:column; gap:6px; margin-top:8px; overflow:auto;">
              ${partOpenRows || `<div class="small">No part available.</div>`}
            </div>
            <div class="row" style="margin-top:8px;">
              <button id="btnOpenPartClose">Close</button>
            </div>
          </div>
        </div>` : ""}
        <div class="row">
          <label class="small">Part Name <input id="partName" value="${partDesignerDraft.name}" /></label>
        </div>
        <div class="row">
          <label class="small">Part Type
            <select id="partTypeSelect">
              ${partTypeOptions.map((option) => `<option value="${option}" ${resolvedPartType === option ? "selected" : ""}>${option}</option>`).join("")}
            </select>
          </label>
          ${propIsWeapon ? `<label class="small">Projectile Class
            <select id="partProjectileClass">
              ${(["bullet", "missile", "laser"] as const).map((option) => `<option value="${option}" ${projectileClass === option ? "selected" : ""}>${option}</option>`).join("")}
            </select>
          </label>
          <label class="small">Projectile Shape
            <select id="partProjectileShape">
              ${projectileShapeOptions.map((option) => `<option value="${option.value}" ${projectileShape === option.value ? "selected" : ""}>${option.label}</option>`).join("")}
            </select>
          </label>
          <label class="small">Projectile Size Ratio
            <input id="partProjectileSizeRatio" type="number" min="0.1" max="10" step="0.1" value="${partRuntimeProps.projectileSizeRatio ?? 1}" />
          </label>` : canonicalCategoryParts.length > 0 ? `<label class="small">Category
            <select id="partCanonicalCategorySelect">
              ${selectedCanonicalPartId === null ? `<option value="" selected>custom / unsaved</option>` : ""}
              ${canonicalCategoryParts.map((entry) => `<option value="${entry.part.id}" ${selectedCanonicalPartId === entry.part.id ? "selected" : ""}>${entry.label}</option>`).join("")}
            </select>
          </label>` : ""}
        </div>
        ${propIsWeapon ? `<div class="row"><button id="btnShowPartComparison" type="button">Show Info</button></div>` : ""}
        ${propIsWeapon ? `<div class="row">
          <label class="small"><input id="partDirectional" type="checkbox" ${partDesignerDraft.directional ? "checked" : ""} /> Placement rotation changes weapon facing</label>
          <label class="small">Base facing
            <select id="partDirection">
              <option value="up" ${(partDesignerDraft.direction ?? getPartDirectionDefault(partDesignerDraft.baseComponent)) === "up" ? "selected" : ""}>up</option>
              <option value="right" ${(partDesignerDraft.direction ?? getPartDirectionDefault(partDesignerDraft.baseComponent)) === "right" ? "selected" : ""}>right</option>
              <option value="down" ${(partDesignerDraft.direction ?? getPartDirectionDefault(partDesignerDraft.baseComponent)) === "down" ? "selected" : ""}>down</option>
              <option value="left" ${(partDesignerDraft.direction ?? getPartDirectionDefault(partDesignerDraft.baseComponent)) === "left" ? "selected" : ""}>left</option>
            </select>
          </label>
        </div>` : ""}
        <div><strong>Part Properties</strong></div>
        <div class="row">
          <label class="small" style="flex:1;">Tags (comma separated) <input id="partTags" value="${(partDesignerDraft.tags ?? []).join(", ")}" /></label>
        </div>
        <div class="row">
          <label class="small">Gas Cost <input id="partGasCost" type="number" min="0" step="1" value="${partRuntimeProps.gasCost ?? ""}" placeholder="${runtimePlaceholders.gasCost}" /></label>
          <label class="small">Mass <input id="partMass" type="number" min="0" step="0.1" value="${partRuntimeProps.mass ?? ""}" placeholder="${runtimePlaceholders.mass}" /></label>
          <span class="small">Delete value to reset to default gas calculation.</span>
        </div>
        ${isStructureLayerMode ? `<div class="row">
          <label class="small">Armor <input id="partMaterialArmor" type="number" step="0.01" value="${partRuntimeProps.armor ?? ""}" /></label>
          <label class="small">Recover/s <input id="partMaterialRecoverPerSecond" type="number" step="0.05" value="${partRuntimeProps.recover ?? ""}" /></label>
          <label class="small">Color <input id="partMaterialColor" value="${partRuntimeProps.color ?? ""}" placeholder="#95a4b8" /></label>
          <label class="small">Transparency <input id="partMaterialAlpha" type="number" min="0" max="1" step="0.05" value="${partRuntimeProps.alpha ?? 1}" /></label>
        </div>
        <div class="row">
          <label class="small">HP <input id="partMetaHp" type="number" step="1" value="${partRuntimeProps.hp ?? ""}" /></label>
        </div>` : ""}
        ${resolvedPartType === "control" ? `<div class="row">
          <label class="small">Computing <input id="partControlComputing" type="number" step="1" min="0" value="${partRuntimeProps.computing ?? 1}" /></label>
        </div>` : ""}

        ${propIsEngine ? `<div class="row">
          <label class="small">Engine Type
            <select id="partEngineType">
              <option value="ground" ${partProps.engineType === "ground" ? "selected" : ""}>ground</option>
              <option value="air" ${partProps.engineType === "air" ? "selected" : ""}>air</option>
            </select>
          </label>
          <label class="small">Power <input id="partPower" type="number" step="1" value="${partRuntimeProps.power ?? ""}" placeholder="${runtimePlaceholders.power}" /></label>
          <label class="small">Max Speed <input id="partMaxSpeed" type="number" step="1" value="${partRuntimeProps.maxSpeed ?? ""}" placeholder="${runtimePlaceholders.maxSpeed}" /></label>
        </div>` : ""}
        ${showAngleLimitControls ? `<div class="row">
          <label class="small"><input id="partHasAngleLimit" type="checkbox" ${hasAngleLimitChecked ? "checked" : ""} /> Limit firing arc</label>
          <span class="small">This limits aiming around the weapon's facing; it does not control part placement rotation.</span>
        </div>` : ""}
        ${showAngleLimitControls && hasAngleLimitChecked ? `<div class="row">
          <label class="small">Clockwise arc (°) <input id="partCwAngle" type="number" step="0.1" min="0" value="${partRuntimeProps.cwAngle ?? ""}" placeholder="${runtimePlaceholders.cwAngle}" /></label>
          <label class="small">Counter-clockwise arc (°) <input id="partCcwAngle" type="number" step="0.1" min="0" value="${partRuntimeProps.ccwAngle ?? ""}" placeholder="${runtimePlaceholders.ccwAngle}" /></label>
        </div>` : ""}
        ${propIsWeapon ? `<div class="row">
          <label class="small">Recoil <input id="partRecoil" type="number" step="0.1" value="${partRuntimeProps.recoil ?? ""}" placeholder="${runtimePlaceholders.recoil}" /></label>
          <label class="small">Hit Impulse <input id="partHitImpulse" type="number" step="0.1" value="${partRuntimeProps.hitImpulse ?? ""}" placeholder="${runtimePlaceholders.hitImpulse}" /></label>
          <label class="small">Damage <input id="partDamage" type="number" step="1" value="${partRuntimeProps.damage ?? ""}" placeholder="${runtimePlaceholders.damage}" /></label>
        </div>
        <div class="row">
          <label class="small">Penetration <input id="partPenetration" type="number" step="1" min="0" value="${partRuntimeProps.penetration ?? ""}" placeholder="${runtimePlaceholders.penetration}" /></label>
          <label class="small">Range <input id="partRange" type="number" step="1" value="${partRuntimeProps.range ?? ""}" placeholder="${runtimePlaceholders.range}" /></label>
          <label class="small">Cooldown <input id="partCooldown" type="number" step="0.05" value="${partRuntimeProps.cooldown ?? ""}" placeholder="${runtimePlaceholders.cooldown}" /></label>
        </div>
        ${projectileClass !== "laser" ? `<div class="row">
          <label class="small">Projectile Speed <input id="partProjectileSpeed" type="number" step="1" value="${partRuntimeProps.projectileSpeed ?? ""}" placeholder="${runtimePlaceholders.projectileSpeed}" /></label>
          <label class="small">Projectile Gravity <input id="partProjectileGravity" type="number" step="1" value="${partRuntimeProps.projectileGravity ?? ""}" placeholder="${runtimePlaceholders.projectileGravity}" /></label>
        </div>` : ""}
        <div class="row">
          <label class="small">Spread <input id="partSpread" type="number" step="0.1" value="${partRuntimeProps.spreadAngleDeg ?? ""}" placeholder="${runtimePlaceholders.spreadDeg}" /></label>
          <label class="small">Max Loaded Ammo <input id="partWeaponMaxLoadedAmmo" type="number" step="1" min="1" value="${partRuntimeProps.maxCapacity ?? ""}" placeholder="${runtimePlaceholders.weaponMaxLoadedAmmo}" /></label>
          ${weaponMaxLoadedAmmo !== 1 ? `<label class="small">Min Fire Interval <input id="partWeaponMinFireInterval" type="number" step="0.05" min="0" value="${partRuntimeProps.minFireInterval ?? 0.2}" /></label>` : ""}
          <label class="small">Computing Use <input id="partWeaponComputingConsumption" type="number" step="1" min="0" value="${partRuntimeProps.computingConsumption ?? 0}" /></label>
          <label class="small">Fire Sound Volume <input id="partFireSoundVolume" type="number" step="0.05" min="0" max="2" value="${partRuntimeProps.fireSoundVolume ?? 1}" /> ×</label>
          <label class="small">Fire Sound
            <select id="partFireSoundPool">
              ${FIRE_SOUND_POOL_OPTIONS.map((option) => `<option value="${option.value}" ${(partRuntimeProps.fireSoundPool ?? "rapid-fire") === option.value ? "selected" : ""}>${option.label}</option>`).join("")}
            </select>
          </label>
          ${projectileClass === "missile" ? `<label class="small"><input id="partTracking" type="checkbox" ${partRuntimeProps.tracking === true ? "checked" : ""} /> Homing</label>` : ""}
          ${weaponSupportsTracking ? `<label class="small">Tracking Turn Rate <input id="partTrackingTurnRate" type="number" step="1" value="${partRuntimeProps.trackingTurnRate ?? ""}" placeholder="${runtimePlaceholders.trackingTurnRateDegPerSec}" /></label>` : ""}
        </div>
        <div class="row">
          <label class="small"><input id="partWeaponNeedLoader" type="checkbox" ${partRuntimeProps.needLoader === true ? "checked" : ""} /> Need Reloader</label>
          ${partRuntimeProps.needLoader === true ? `<label class="small">Bullet Name <input id="partBulletName" value="${escapeHtml(partRuntimeProps.bulletName ?? "")}" placeholder="Exact ammunition name" /></label>` : ""}
        </div>
        ${projectileClass !== "laser" ? `<div class="row">
          <label class="small"><input id="partExplodeOnHit" type="checkbox" ${weaponSupportsExplosive ? "checked" : ""} /> Explosive (explode on hit)</label>
        </div>` : ""}
        ${weaponSupportsExplosive ? `<div class="row">
          <label class="small">Blast Radius <input id="partExplosiveBlastRadius" type="number" step="1" value="${partRuntimeProps.explodeRadius ?? ""}" placeholder="${runtimePlaceholders.explosiveBlastRadius}" /></label>
          <label class="small">Blast Damage <input id="partExplosiveBlastDamage" type="number" step="1" value="${partRuntimeProps.explosionDamage ?? ""}" placeholder="${runtimePlaceholders.explosiveBlastDamage}" /></label>
          <label class="small">Falloff Power <input id="partExplosiveFalloffPower" type="number" step="0.1" value="${partDesignerDraft.stats?.explosiveFalloffPower ?? ""}" placeholder="${runtimePlaceholders.explosiveFalloffPower}" /></label>
        </div>` : ""}` : ""}
        ${propIsLoader ? `<div class="row">
          <label class="small">Bullet Name <input id="partBulletName" value="${escapeHtml(partRuntimeProps.bulletName ?? "")}" placeholder="Exact ammunition name" /></label>
          <label class="small" style="flex:1;">Loader supports (bullet, missile, laser) <input id="partLoaderSupports" value="${(partRuntimeProps.supportedWeaponTags ?? []).join(", ")}" placeholder="${loaderSupportsPlaceholder}" /></label>
          <label class="small">Load Multiplier <input id="partLoaderLoadMultiplier" type="number" step="0.01" value="${partRuntimeProps.loadMultiplier ?? ""}" placeholder="${runtimePlaceholders.loaderLoadMultiplier}" /></label>
          <label class="small"><input id="partLoaderFastOperation" type="checkbox" ${(partDesignerDraft.stats?.loaderFastOperation ?? baseStats.loader?.fastOperation ?? false) ? "checked" : ""} /> Fast Operation</label>
        </div>
        <div class="row">
          <label class="small">Min Load Time <input id="partLoaderMinLoadTime" type="number" step="0.05" value="${partRuntimeProps.minLoadTime ?? ""}" placeholder="${runtimePlaceholders.loaderMinLoadTime}" /></label>
          <label class="small">Min Burst Interval <input id="partLoaderMinBurstInterval" type="number" step="0.05" value="${partRuntimeProps.minBurstInterval ?? ""}" placeholder="${runtimePlaceholders.loaderMinBurstInterval}" /></label>
        </div>` : ""}
        ${!isStructureLayerMode ? `<div class="row">
          <label class="small"><input id="partRequireStructureOnFunctional" type="checkbox" ${(partDesignerDraft.placement?.requireStructureOnFunctionalOccupiedBoxes ?? true) ? "checked" : ""} /> Functional boxes require structure</label>
          <label class="small"><input id="partRequireStructureOnStructure" type="checkbox" ${(partDesignerDraft.placement?.requireStructureOnStructureOccupiedBoxes ?? true) ? "checked" : ""} /> Structure boxes require structure support</label>
        </div>` : ""}
        <div class="row">
          <button id="btnNewPartDraft">New Part</button>
          <button id="btnClearPartGrid">Clear Grid</button>
        </div>
        <div class="row">
          <button id="btnSavePartDraft">Save</button>
        </div>
      `;
    }

    globalModalRoot.innerHTML = renderPartComparisonModal();
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
    const upgradedPartId = material === "combined" ? 13 : 15;
    for (const template of templates) {
      for (const cell of template.structure) {
        cell.partId = upgradedPartId;
      }
      template.gasCost = computeTemplateGasCost(template, parts);
    }
  };

  const getExternalAiSidesFromPresets = (): { player: boolean; enemy: boolean } => ({
    player: false,
    enemy: false,
  });

  const applyTestArenaBattlefieldSize = (): void => {
    const width = normalizeTestArenaBattlefieldWidth(testArenaBattlefieldWidth);
    const height = normalizeTestArenaBattlefieldHeight(testArenaBattlefieldHeight);
    testArenaBattlefieldWidth = width;
    testArenaBattlefieldHeight = height;
    battle.setBattlefieldSize(width, height);
    testArenaGroundHeight = battle.setGroundHeight(normalizeTestArenaGroundHeight(testArenaGroundHeight));
    if (isBattleScreen()) {
      resetBattleViewToVerticalFit();
    } else {
      applyBattleViewTransform();
    }
  };

  const applyBattlefieldDefaults = (): void => {
    battle.setBattlefieldSize(BATTLEFIELD_WIDTH, BATTLEFIELD_HEIGHT);
    battle.setGroundHeight(Math.floor(BATTLEFIELD_HEIGHT * DEFAULT_GROUND_HEIGHT_RATIO));
    applyBattleViewTransform();
  };

  const setBattleZoomPercent = (zoomPercent: number): void => {
    const normalized = normalizeTestArenaZoomPercent(zoomPercent);
    const scale = normalized / 100;
    if (isBattleScreen()) {
      const rect = canvasViewport.getBoundingClientRect();
      const centerX = rect.left + rect.width * 0.5;
      const centerY = rect.top + rect.height * 0.5;
      adjustBattleViewScaleAtClientPoint(scale, centerX, centerY);
      return;
    }
    battleViewScale = Math.max(MIN_BATTLE_VIEW_SCALE, Math.min(MAX_BATTLE_VIEW_SCALE, scale));
    applyBattleViewTransform();
    syncTestArenaZoomInput();
  };

  const startTestArena = async (): Promise<void> => {
    applyTestArenaBattlefieldSize();
    if (battle.getState().active && !battle.getState().outcome) {
      battle.resetToMapMode();
    }
    await refreshTestArenaCompositeModelOptions();
    await refreshTestArenaAiOptions();
    await refreshTestArenaComponentGrid();
    applyTestArenaAiControllers();
    const enemyTemplateIds = getTestArenaEnemySpawnTemplateIds();
    const playerTemplateIds = getTestArenaPlayerSpawnTemplateIds();
    battle.setEnemySpawnTemplateFilter(enemyTemplateIds.length > 0 ? enemyTemplateIds : null);
    battle.setPlayerAutoSpawnEnabled(testArenaAutoSpawnOnPlayerSide);
    battle.setPlayerAutoSpawnTargetCount(testArenaPlayerCount);
    battle.setPlayerSpawnTemplateFilter(playerTemplateIds.length > 0 ? playerTemplateIds : null);
    battle.start(testArenaNode);
    battle.clearAllUnits();
    battle.setControlledUnitInvincible(testArenaInvinciblePlayer);
    battle.setEnemyActiveCount(testArenaAutoSpawnOnEnemySide ? testArenaEnemyCount : 0);
    battle.syncAutoSpawnTargets();
    const playerModel = findCompositeModelOptionById(testArenaCompositeModelSelections.player)?.label ?? testArenaCompositeModelSelections.player;
    const enemyModel = findCompositeModelOptionById(testArenaCompositeModelSelections.enemy)?.label ?? testArenaCompositeModelSelections.enemy;
    addLog(`Test Arena started. P model=${playerModel} | E model=${enemyModel}.`);
    setScreen("testArena");
    resetBattleViewToVerticalFit();
    renderPanels();
  };

  const bindPanelActions = (): void => {
    document.querySelectorAll<HTMLButtonElement>("button[data-select-build-slot]").forEach((button) => {
      button.addEventListener("click", () => {
        const slotId = button.getAttribute("data-select-build-slot") as BaseBuildingSlot["id"] | null;
        if (!slotId) return;
        selectedBaseBuildSlotId = slotId;
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-build-kind][data-build-slot]").forEach((button) => {
      button.addEventListener("click", () => {
        const kind = button.getAttribute("data-build-kind") as BuildingKind | null;
        const slotId = button.getAttribute("data-build-slot") as BaseBuildingSlot["id"] | null;
        if (!kind || !slotId) return;
        const definition = BUILDING_CATALOG[kind];
        if (!definition || !spendGas(definition.gasCost)) return;
        const result = campaign.queueBuilding(kind, slotId, true);
        if (!result.ok) {
          if (!isUnlimitedResources()) gas += definition.gasCost;
          addLog(result.reason ?? "Construction could not start.", "warn");
        } else {
          addLog(`Construction started: ${definition.name} (${definition.buildSeconds}s)`, "good");
        }
        renderPanels();
      });
    });

    getOptionalElement<HTMLButtonElement>("#btnUnlockReinforced")?.addEventListener("click", () => {
      if (tech.reinforced) return;
      const definition = RESEARCH_CATALOG.reinforced;
      if (!spendGas(definition.gasCost)) return;
      const result = campaign.queueResearch("reinforced");
      if (!result.ok) { if (!isUnlimitedResources()) gas += definition.gasCost; addLog(result.reason ?? "Research could not start.", "warn"); }
      else addLog(`Research started: ${definition.name} (${definition.durationSeconds}s)`, "good");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnUnlockCombined")?.addEventListener("click", () => {
      if (tech.combined) return;
      const definition = RESEARCH_CATALOG.combined;
      if (!spendGas(definition.gasCost)) return;
      const result = campaign.queueResearch("combined");
      if (!result.ok) { if (!isUnlimitedResources()) gas += definition.gasCost; addLog(result.reason ?? "Research could not start.", "warn"); }
      else addLog(`Research started: ${definition.name} (${definition.durationSeconds}s)`, "good");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnUnlockMediumWeapon")?.addEventListener("click", () => {
      if (tech.mediumWeapons) return;
      const definition = RESEARCH_CATALOG.mediumWeapons;
      if (!spendGas(definition.gasCost)) return;
      const result = campaign.queueResearch("mediumWeapons");
      if (!result.ok) { if (!isUnlimitedResources()) gas += definition.gasCost; addLog(result.reason ?? "Research could not start.", "warn"); }
      else addLog(`Research started: ${definition.name} (${definition.durationSeconds}s)`, "good");
      renderPanels();
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-nav]").forEach((button) => {
      button.addEventListener("click", () => {
        const destination = button.getAttribute("data-nav");
        if (destination === "templateEditor") {
          setScreen("templateEditor");
        } else if (destination === "partEditor") {
          setScreen("partEditor");
        }
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLButtonElement>("button.nodeAttack").forEach((button) => {
      button.addEventListener("click", () => {
        if (battle.getState().active && !battle.getState().outcome) {
          addLog("An operation is already live. Return to Battle to command it.", "warn");
          setScreen("battle");
          renderPanels();
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
        applyBattlefieldDefaults();
        battle.setAiControllers({});
        battle.setExternalAiSides({ player: false, enemy: false });
        battle.setPlayerAutoSpawnEnabled(false);
        battle.setPlayerAutoSpawnTargetCount(0);
        battle.setEnemySpawnTemplateFilter(null);
        battle.start(node);
        addLog(`Battle started at ${node.name}`);
        setScreen("battle");
        resetBattleViewToVerticalFit();
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
        const rawTemplateId = button.getAttribute("data-deploy");
        const templateId = rawTemplateId ? Number.parseInt(rawTemplateId, 10) : Number.NaN;
        if (!Number.isInteger(templateId) || templateId < 1) {
          return;
        }
        if (battleDeploySide === "enemy") {
          if (!(battle.getState().active && battle.getState().nodeId === testArenaNode.id)) {
            addLog("Enemy spawn from Battle Ops is only available in Test Arena.", "warn");
            renderPanels();
            return;
          }
          const spawned = battle.arenaDeploy("enemy", templateId, { chargeGas: false, deploymentGasCost: 0, ignoreCap: true, ignoreLowGasThreshold: true });
          addLog(
            spawned ? `Spawned enemy unit: ${templateId}.` : `Failed to spawn enemy unit: ${templateId}.`,
            spawned ? "good" : "bad",
          );
        } else {
          queueDeployment(templateId, false);
        }
        renderPanels();
      });
    });

    getOptionalElement<HTMLButtonElement>("#btnDeploySidePlayer")?.addEventListener("click", () => {
      battleDeploySide = "player";
      renderPanels();
    });
    getOptionalElement<HTMLButtonElement>("#btnDeploySideEnemy")?.addEventListener("click", () => {
      battleDeploySide = "enemy";
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnBackToMap")?.addEventListener("click", () => {
      if (battle.getState().outcome) battle.resetToMapMode();
      setScreen("map");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnStartTestArena")?.addEventListener("click", () => {
      void startTestArena();
    });

    const commitCraftArenaGlobalSettings = (update: () => void): void => {
      if (craftArenaScenarios.some((scenario) => scenario.busy)) return;
      update();
      for (const scenario of craftArenaScenarios) {
        scenario.result = undefined;
        scenario.error = undefined;
      }
      saveCraftArenaScenarios();
      renderPanels();
    };
    const bindCraftArenaNumber = (
      selector: string,
      min: number,
      max: number,
      apply: (value: number) => void,
    ): void => {
      const input = getOptionalElement<HTMLInputElement>(selector);
      input?.addEventListener("change", () => {
        const parsed = Number.parseInt(input.value, 10);
        commitCraftArenaGlobalSettings(() => apply(Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min))));
      });
    };
    bindCraftArenaNumber("#craftArenaGlobalQuantity", 1, 40, (value) => { craftArenaSettings.quantity = value; });
    bindCraftArenaNumber("#craftArenaGlobalDuration", 1, 60, (value) => { craftArenaSettings.durationMinutes = value; });
    bindCraftArenaNumber("#craftArenaGlobalWidth", 640, 100_000, (value) => { craftArenaSettings.battlefieldWidth = value; });
    bindCraftArenaNumber("#craftArenaGlobalHeight", 360, 100_000, (value) => {
      craftArenaSettings.battlefieldHeight = value;
      craftArenaSettings.groundHeight = Math.min(craftArenaSettings.groundHeight, Math.max(80, value - 40));
    });
    bindCraftArenaNumber("#craftArenaGlobalGroundHeight", 80, Math.max(80, craftArenaSettings.battlefieldHeight - 40), (value) => {
      craftArenaSettings.groundHeight = value;
    });
    getOptionalElement<HTMLSelectElement>("#craftArenaGlobalAi")?.addEventListener("change", (event) => {
      commitCraftArenaGlobalSettings(() => {
        craftArenaSettings.aiModelId = (event.currentTarget as HTMLSelectElement).value;
      });
    });
    getOptionalElement<HTMLButtonElement>("#btnCraftArenaUseTestSettings")?.addEventListener("click", () => {
      commitCraftArenaGlobalSettings(() => {
        craftArenaSettings.battlefieldWidth = testArenaBattlefieldWidth;
        craftArenaSettings.battlefieldHeight = testArenaBattlefieldHeight;
        craftArenaSettings.groundHeight = testArenaGroundHeight;
        if (
          testArenaCompositeModelSelections.player === testArenaCompositeModelSelections.enemy
          && testArenaCompositeModelSelections.player !== "custom-components"
        ) {
          craftArenaSettings.aiModelId = testArenaCompositeModelSelections.player;
        }
      });
    });
    getOptionalElement<HTMLButtonElement>("#btnRunAllCraftArena")?.addEventListener("click", () => {
      void Promise.all(craftArenaScenarios.map((scenario) => runCraftArenaScenario(scenario.id)));
    });
    getOptionalElement<HTMLButtonElement>("#craftHeatmapDestroyed")?.addEventListener("click", () => {
      craftArenaMetric = "destroyed";
      renderPanels();
    });
    getOptionalElement<HTMLButtonElement>("#craftHeatmapGas")?.addEventListener("click", () => {
      craftArenaMetric = "gasWasted";
      renderPanels();
    });
    craftArenaCenter.querySelectorAll<HTMLButtonElement>("[data-craft-arena-select]").forEach((cell) => {
      cell.addEventListener("click", () => {
        craftArenaSelectedScenarioId = cell.dataset.craftArenaSelect ?? null;
        renderPanels();
      });
    });
    getOptionalElement<HTMLButtonElement>("#btnRunSelectedCraftMatchup")?.addEventListener("click", () => {
      if (craftArenaSelectedScenarioId) void runCraftArenaScenario(craftArenaSelectedScenarioId);
    });

    getOptionalElement<HTMLButtonElement>("#btnRefreshLeaderboard")?.addEventListener("click", async () => {
      renderPanels();
      await refreshTestArenaLeaderboard();
      await refreshTestArenaCompositeModelOptions();
      renderPanels();
    });

    getOptionalElement<HTMLSelectElement>("#leaderboardCompeteMode")?.addEventListener("change", (event) => {
      const next = (event.currentTarget as HTMLSelectElement).value;
      testArenaLeaderboardCompeteMode = next === "unranked-vs-random"
        ? "unranked-vs-random"
        : next === "manual-pair"
          ? "manual-pair"
          : next === "manual-vs-random"
            ? "manual-vs-random"
            : "random-pair";
      renderPanels();
    });

    getOptionalElement<HTMLSelectElement>("#leaderboardManualPairA")?.addEventListener("change", (event) => {
      testArenaLeaderboardManualPairA = (event.currentTarget as HTMLSelectElement).value;
      renderPanels();
    });
    getOptionalElement<HTMLSelectElement>("#leaderboardManualPairB")?.addEventListener("change", (event) => {
      testArenaLeaderboardManualPairB = (event.currentTarget as HTMLSelectElement).value;
      renderPanels();
    });
    getOptionalElement<HTMLSelectElement>("#leaderboardManualVsRandom")?.addEventListener("change", (event) => {
      testArenaLeaderboardManualVsRandom = (event.currentTarget as HTMLSelectElement).value;
      renderPanels();
    });

    const leaderboardCompeteRunsInput = getOptionalElement<HTMLInputElement>("#leaderboardCompeteRuns");
    const commitLeaderboardCompeteRuns = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#leaderboardCompeteRuns")?.value ?? "";
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        testArenaLeaderboardCompeteRuns = 100;
      } else {
        testArenaLeaderboardCompeteRuns = Math.max(1, parsed);
      }
      renderPanels();
    };
    leaderboardCompeteRunsInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      leaderboardCompeteRunsInput.blur();
    });
    leaderboardCompeteRunsInput?.addEventListener("blur", () => {
      commitLeaderboardCompeteRuns();
    });

    getOptionalElement<HTMLButtonElement>("#btnLeaderboardCompete")?.addEventListener("click", async () => {
      const runA = testArenaLeaderboardCompeteMode === "manual-vs-random"
        ? testArenaLeaderboardManualVsRandom
        : testArenaLeaderboardManualPairA;
      await runLeaderboardCompetition(
        testArenaLeaderboardCompeteMode,
        testArenaLeaderboardCompeteRuns,
        runA,
        testArenaLeaderboardManualPairB,
      );
    });

    getOptionalElement<HTMLButtonElement>("#btnResetLeaderboard")?.addEventListener("click", async () => {
      if (!window.confirm("Reset all leaderboard scores, win rates, and rounds? This cannot be undone.")) {
        return;
      }
      try {
        const res = await fetch("/__arena/composite/leaderboard/reset", { method: "POST" });
        if (!res.ok) {
          addLog("Failed to reset leaderboard scores.", "bad");
          return;
        }
        addLog("Leaderboard scores reset successfully.", "good");
        await refreshTestArenaLeaderboard();
        renderPanels();
      } catch {
        addLog("Failed to reset leaderboard scores due to network error.", "bad");
      }
    });

    getOptionalElement<HTMLButtonElement>("#btnEndTestArena")?.addEventListener("click", () => {
      battle.setExternalAiSides({ player: false, enemy: false });
      battle.setPlayerAutoSpawnEnabled(false);
      battle.setPlayerAutoSpawnTargetCount(0);
      battle.resetToMapMode();
      setScreen("testArena");
      renderPanels();
    });

    const bindTestArenaSectionToggle = (selector: string, section: TestArenaPanelSection): void => {
      const element = getOptionalElement<HTMLDetailsElement>(selector);
      if (!element) {
        return;
      }
      testArenaPanelSections[section] = element.open;
      element.addEventListener("toggle", () => {
        testArenaPanelSections[section] = element.open;
      });
    };
    bindTestArenaSectionToggle("#testArenaSectionUnit", "unit");
    bindTestArenaSectionToggle("#testArenaSectionManual", "manual");
    bindTestArenaSectionToggle("#testArenaSectionAi", "ai");
    bindTestArenaSectionToggle("#testArenaSectionUi", "ui");
    const spawnTemplateDropdown = getOptionalElement<HTMLDetailsElement>("#testArenaSpawnTemplateDropdown");
    if (spawnTemplateDropdown) {
      testArenaSpawnTemplateDropdownOpen = spawnTemplateDropdown.open;
      spawnTemplateDropdown.addEventListener("toggle", () => {
        testArenaSpawnTemplateDropdownOpen = spawnTemplateDropdown.open;
      });
    }
    const bindCommitOnEnterOrBlur = (input: HTMLInputElement | null, onCommit: () => void): void => {
      if (!input) {
        return;
      }
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
          return;
        }
        event.preventDefault();
        input.blur();
      });
      input.addEventListener("blur", () => {
        onCommit();
      });
    };

    const commitTestArenaEnemyCount = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#testArenaEnemyCount")?.value ?? "";
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) {
        addLog("Enemy count must be a number.", "warn");
        renderPanels();
        return;
      }
      testArenaEnemyCount = Math.max(0, Math.min(40, value));
      testArenaNode.testEnemyMinActive = testArenaEnemyCount;
      saveTestArenaSettings();
      if (battle.getState().active && battle.getState().nodeId === testArenaNode.id) {
        const updated = battle.setEnemyActiveCount(testArenaAutoSpawnOnEnemySide ? testArenaEnemyCount : 0);
        addLog(`Test Arena enemy count set to ${testArenaAutoSpawnOnEnemySide ? updated : 0}.`, "good");
      } else {
        addLog(`Test Arena enemy count queued: ${testArenaEnemyCount}.`, "warn");
      }
      renderPanels();
    };
    bindCommitOnEnterOrBlur(getOptionalElement<HTMLInputElement>("#testArenaEnemyCount"), commitTestArenaEnemyCount);

    const commitTestArenaPlayerCount = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#testArenaPlayerCount")?.value ?? "";
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) {
        addLog("Player count must be a number.", "warn");
        renderPanels();
        return;
      }
      testArenaPlayerCount = Math.max(0, Math.min(40, value));
      saveTestArenaSettings();
      const applied = battle.setPlayerAutoSpawnTargetCount(testArenaPlayerCount);
      if (battle.getState().active && battle.getState().nodeId === testArenaNode.id) {
        addLog(`Test Arena player count set to ${applied}.`, "good");
      } else {
        addLog(`Test Arena player count queued: ${applied}.`, "warn");
      }
      renderPanels();
    };
    bindCommitOnEnterOrBlur(getOptionalElement<HTMLInputElement>("#testArenaPlayerCount"), commitTestArenaPlayerCount);

    const commitTestArenaBaseHp = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#testArenaBaseHp")?.value ?? "";
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) {
        addLog("Base HP must be a number.", "warn");
        renderPanels();
        return;
      }
      testArenaBaseHp = Math.max(1, Math.min(1_000_000_000, value));
      testArenaNode.testBaseHpOverride = testArenaBaseHp;
      saveTestArenaSettings();
      if (battle.getState().active && battle.getState().nodeId === testArenaNode.id) {
        battle.setBaseHp("both", testArenaBaseHp, true);
        addLog(`Test Arena bases refilled to ${testArenaBaseHp} HP.`, "good");
      } else {
        addLog(`Test Arena base HP queued: ${testArenaBaseHp}.`, "warn");
      }
      renderPanels();
    };
    bindCommitOnEnterOrBlur(getOptionalElement<HTMLInputElement>("#testArenaBaseHp"), commitTestArenaBaseHp);

    const commitTestArenaBattlefieldWidth = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#testArenaBattlefieldWidth")?.value ?? "";
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) {
        addLog("Battlefield width must be a number.", "warn");
        renderPanels();
        return;
      }
      testArenaBattlefieldWidth = normalizeTestArenaBattlefieldWidth(value);
      testArenaBattlefieldUsesGlobalDefaults = false;
      saveTestArenaSettings();
      if (battle.getState().active && battle.getState().nodeId !== testArenaNode.id) {
        addLog(`Test Arena battlefield width queued: ${testArenaBattlefieldWidth}.`, "warn");
      } else {
        applyTestArenaBattlefieldSize();
        addLog(`Test Arena battlefield size set to ${testArenaBattlefieldWidth}x${testArenaBattlefieldHeight}.`, "good");
      }
      renderPanels();
    };
    bindCommitOnEnterOrBlur(getOptionalElement<HTMLInputElement>("#testArenaBattlefieldWidth"), commitTestArenaBattlefieldWidth);

    const commitTestArenaBattlefieldHeight = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#testArenaBattlefieldHeight")?.value ?? "";
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) {
        addLog("Battlefield height must be a number.", "warn");
        renderPanels();
        return;
      }
      testArenaBattlefieldHeight = normalizeTestArenaBattlefieldHeight(value);
      testArenaGroundHeight = normalizeTestArenaGroundHeight(testArenaGroundHeight);
      testArenaBattlefieldUsesGlobalDefaults = false;
      saveTestArenaSettings();
      if (battle.getState().active && battle.getState().nodeId !== testArenaNode.id) {
        addLog(`Test Arena battlefield height queued: ${testArenaBattlefieldHeight}.`, "warn");
      } else {
        applyTestArenaBattlefieldSize();
        addLog(`Test Arena battlefield size set to ${testArenaBattlefieldWidth}x${testArenaBattlefieldHeight}.`, "good");
      }
      renderPanels();
    };
    bindCommitOnEnterOrBlur(getOptionalElement<HTMLInputElement>("#testArenaBattlefieldHeight"), commitTestArenaBattlefieldHeight);

    const commitTestArenaZoomPercent = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#testArenaZoomPercent")?.value ?? "";
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) {
        addLog("Zoom percentage must be a number.", "warn");
        renderPanels();
        return;
      }
      setBattleZoomPercent(value);
      addLog(`Battlefield zoom set to ${Math.round(battleViewScale * 100)}%.`, "good");
      renderPanels();
    };
    bindCommitOnEnterOrBlur(getOptionalElement<HTMLInputElement>("#testArenaZoomPercent"), commitTestArenaZoomPercent);

    const commitTestArenaGroundHeight = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#testArenaGroundHeight")?.value ?? "";
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) {
        addLog("Ground height must be a number.", "warn");
        renderPanels();
        return;
      }
      testArenaGroundHeight = normalizeTestArenaGroundHeight(value);
      testArenaBattlefieldUsesGlobalDefaults = false;
      saveTestArenaSettings();
      if (battle.getState().active && battle.getState().nodeId !== testArenaNode.id) {
        addLog(`Test Arena ground height queued: ${testArenaGroundHeight}.`, "warn");
      } else {
        testArenaGroundHeight = battle.setGroundHeight(testArenaGroundHeight);
        addLog(`Test Arena ground height set to ${testArenaGroundHeight}.`, "good");
      }
      renderPanels();
    };
    bindCommitOnEnterOrBlur(getOptionalElement<HTMLInputElement>("#testArenaGroundHeight"), commitTestArenaGroundHeight);

    getOptionalElement<HTMLButtonElement>("#testArenaUseGlobalBattlefield")?.addEventListener("click", () => {
      testArenaBattlefieldUsesGlobalDefaults = true;
      testArenaBattlefieldWidth = normalizeTestArenaBattlefieldWidth(BATTLEFIELD_WIDTH);
      testArenaBattlefieldHeight = normalizeTestArenaBattlefieldHeight(BATTLEFIELD_HEIGHT);
      testArenaGroundHeight = normalizeTestArenaGroundHeight(Math.floor(BATTLEFIELD_HEIGHT * DEFAULT_GROUND_HEIGHT_RATIO));
      saveTestArenaSettings();
      if (battle.getState().active && battle.getState().nodeId !== testArenaNode.id) {
        addLog(`Global battlefield ${testArenaBattlefieldWidth}x${testArenaBattlefieldHeight} queued for Test Arena.`, "warn");
      } else {
        applyTestArenaBattlefieldSize();
        addLog(`Test Arena now follows Global Settings: ${testArenaBattlefieldWidth}x${testArenaBattlefieldHeight}.`, "good");
      }
      renderPanels();
    });

    document.querySelectorAll<HTMLInputElement>("input.testArenaEnemySpawnTemplateToggle").forEach((input) => {
      input.addEventListener("change", (event) => {
        const checkbox = event.currentTarget as HTMLInputElement;
        const rawTemplateId = checkbox.getAttribute("data-template-id") ?? "";
        const templateId = Number.parseInt(rawTemplateId, 10);
        if (!Number.isInteger(templateId) || templateId < 1) {
          return;
        }
        const nextSelection = new Set<number>(getTestArenaEnemySpawnTemplateIds());
        if (checkbox.checked) {
          nextSelection.add(templateId);
        } else {
          nextSelection.delete(templateId);
        }
        const selected = setTestArenaEnemySpawnTemplateIds(Array.from(nextSelection));
        testArenaHasStoredEnemyCraftSelection = true;
        saveTestArenaSettings();
        battle.setEnemySpawnTemplateFilter(selected.length > 0 ? selected : null);
        addLog(`Enemy auto-spawn templates: ${selected.length} selected.`, selected.length > 0 ? "good" : "warn");
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLInputElement>("input.testArenaPlayerSpawnTemplateToggle").forEach((input) => {
      input.addEventListener("change", (event) => {
        const checkbox = event.currentTarget as HTMLInputElement;
        const rawTemplateId = checkbox.getAttribute("data-template-id") ?? "";
        const templateId = Number.parseInt(rawTemplateId, 10);
        if (!Number.isInteger(templateId) || templateId < 1) {
          return;
        }
        const nextSelection = new Set<number>(getTestArenaPlayerSpawnTemplateIds());
        if (checkbox.checked) {
          nextSelection.add(templateId);
        } else {
          nextSelection.delete(templateId);
        }
        const selected = setTestArenaPlayerSpawnTemplateIds(Array.from(nextSelection));
        testArenaHasStoredPlayerCraftSelection = true;
        saveTestArenaSettings();
        battle.setPlayerSpawnTemplateFilter(selected.length > 0 ? selected : null);
        addLog(`Player auto-spawn templates: ${selected.length} selected.`, selected.length > 0 ? "good" : "warn");
        renderPanels();
      });
    });

    getOptionalElement<HTMLSelectElement>("#testArenaManualSpawnTemplate")?.addEventListener("change", (event) => {
      const templateId = Number.parseInt((event.currentTarget as HTMLSelectElement).value, 10);
      if (Number.isInteger(templateId) && templates.some((template) => template.id === templateId)) {
        testArenaManualSpawnTemplateId = templateId;
        saveTestArenaSettings();
      }
    });

    getOptionalElement<HTMLSelectElement>("#testArenaManualSpawnSide")?.addEventListener("change", (event) => {
      const side = (event.currentTarget as HTMLSelectElement).value;
      if (side === "player" || side === "enemy") {
        testArenaManualSpawnSide = side;
        saveTestArenaSettings();
      }
    });

    getOptionalElement<HTMLButtonElement>("#btnTestArenaManualSpawn")?.addEventListener("click", () => {
      const state = battle.getState();
      if (!state.active || state.outcome || state.nodeId !== testArenaNode.id) {
        addLog("Start Test Arena before manually spawning a craft.", "warn");
        renderPanels();
        return;
      }
      const template = templates.find((entry) => entry.id === testArenaManualSpawnTemplateId);
      const spawned = template
        ? battle.arenaDeploy(testArenaManualSpawnSide, template.id, {
          chargeGas: false,
          deploymentGasCost: 0,
          ignoreCap: true,
          ignoreLowGasThreshold: true,
        })
        : false;
      addLog(
        spawned
          ? `Manually spawned one ${template?.name ?? "craft"} for ${testArenaManualSpawnSide}.`
          : `Could not manually spawn ${template?.name ?? "the selected craft"}.`,
        spawned ? "good" : "bad",
      );
      renderPanels();
    });

    getOptionalElement<HTMLInputElement>("#testArenaAutoSpawnOnPlayerSide")?.addEventListener("change", (event) => {
      testArenaAutoSpawnOnPlayerSide = (event.currentTarget as HTMLInputElement).checked;
      saveTestArenaSettings();
      battle.setPlayerAutoSpawnEnabled(testArenaAutoSpawnOnPlayerSide);
      addLog(
        testArenaAutoSpawnOnPlayerSide
          ? "Auto spawn on player side enabled."
          : "Auto spawn on player side disabled.",
        "warn",
      );
      renderPanels();
    });

    getOptionalElement<HTMLInputElement>("#testArenaAutoSpawnOnEnemySide")?.addEventListener("change", (event) => {
      testArenaAutoSpawnOnEnemySide = (event.currentTarget as HTMLInputElement).checked;
      saveTestArenaSettings();
      if (battle.getState().active && battle.getState().nodeId === testArenaNode.id) {
        const updated = battle.setEnemyActiveCount(testArenaAutoSpawnOnEnemySide ? testArenaEnemyCount : 0);
        addLog(
          testArenaAutoSpawnOnEnemySide
            ? `Auto spawn on enemy side enabled (active target ${updated}).`
            : "Auto spawn on enemy side disabled.",
          "warn",
        );
      } else {
        addLog(
          testArenaAutoSpawnOnEnemySide
            ? "Auto spawn on enemy side enabled."
            : "Auto spawn on enemy side disabled.",
          "warn",
        );
      }
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnClearTestArenaUnits")?.addEventListener("click", async () => {
      if (!battle.getState().active || battle.getState().nodeId !== testArenaNode.id) {
        await startTestArena();
      }
      const cleared = battle.clearAllUnits();
      addLog(
        cleared > 0 ? `Cleared ${cleared} unit(s) from Test Arena.` : "No units to clear in Test Arena.",
        cleared > 0 ? "good" : "warn",
      );
      renderPanels();
    });

    getOptionalElement<HTMLInputElement>("#testArenaInvinciblePlayer")?.addEventListener("change", (event) => {
      testArenaInvinciblePlayer = (event.currentTarget as HTMLInputElement).checked;
      saveTestArenaSettings();
      battle.setControlledUnitInvincible(testArenaInvinciblePlayer);
      addLog(`Controlled unit invincibility ${testArenaInvinciblePlayer ? "ON" : "OFF"}.`, "warn");
      renderPanels();
    });

    const bindComponentSelect = (side: TestArenaSide, kind: TestArenaAiModuleKind): void => {
      getOptionalElement<HTMLSelectElement>(`#testArenaCompSelect_${side}_${kind}`)?.addEventListener("change", async (event) => {
        const nextId = (event.currentTarget as HTMLSelectElement).value;
        const option = findAiOptionById(kind, nextId);
        if (!option || option.compatible === false || !option.spec?.familyId) {
          if (option?.reason) {
            addLog(`${side}.${kind}: ${option.reason}`, "warn");
          }
          renderPanels();
          return;
        }
        testArenaAiSelections[side][kind] = nextId;
        saveTestArenaSettings();
        await refreshTestArenaComponentGrid();
        if (battle.getState().active && battle.getState().nodeId === testArenaNode.id) {
          applyTestArenaAiControllers();
        }
        addLog(`Test Arena AI set: ${side}.${kind} -> ${nextId}`, "good");
        renderPanels();
      });
    };
    bindComponentSelect("player", "target");
    bindComponentSelect("player", "movement");
    bindComponentSelect("player", "shoot");
    bindComponentSelect("enemy", "target");
    bindComponentSelect("enemy", "movement");
    bindComponentSelect("enemy", "shoot");

    const bindCompositeModelSelect = (side: TestArenaSide): void => {
      getOptionalElement<HTMLSelectElement>(`#testArenaCompositeModel_${side}`)?.addEventListener("change", async (event) => {
        const nextId = (event.currentTarget as HTMLSelectElement).value;
        const option = findCompositeModelOptionById(nextId);
        if (!option || option.compatible === false) {
          addLog(`${side} composed model is not selectable.`, "warn");
          renderPanels();
          return;
        }
        testArenaCompositeModelSelections[side] = nextId;
        saveTestArenaSettings();
        if (battle.getState().active && battle.getState().nodeId === testArenaNode.id) {
          applyTestArenaAiControllers();
        }
        addLog(`Test Arena ${side} model -> ${option.label}`, "good");
        renderPanels();
      });
    };
    bindCompositeModelSelect("player");
    bindCompositeModelSelect("enemy");

    getOptionalElement<HTMLButtonElement>("#btnRefreshArenaAiModels")?.addEventListener("click", async () => {
      await fetchLatestCompositeSpec();
      await refreshTestArenaCompositeModelOptions();
      await refreshTestArenaAiOptions();
      await refreshTestArenaComponentGrid();
      if (battle.getState().active && battle.getState().nodeId === testArenaNode.id) {
        applyTestArenaAiControllers();
      }
      addLog("Refreshed available AI models and modules.", "good");
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
        const rawTemplateId = button.getAttribute("data-editor-open-select");
        const templateId = rawTemplateId ? Number.parseInt(rawTemplateId, 10) : Number.NaN;
        if (!Number.isInteger(templateId) || templateId < 1) {
          return;
        }
        const source = templates.find((template) => template.id === templateId);
        if (!source) {
          return;
        }
        if (templateId !== editorDraft.id) {
          recenterEditorViewForScreen("templateEditor");
        }
        editorDraft = cloneTemplate(source);
        editorOpenedTemplateId = source.id;
        editorOpenedTemplateName = source.name;
        loadTemplateIntoEditorSlots(editorDraft);
        editorDeleteMode = false;
        editorWeaponRotateQuarter = 0;
        editorTemplateDialogOpen = false;
        editorTemplateDialogSelectedId = templateId;
        ensureEditorSelectionForLayer();
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-editor-open-copy]").forEach((button) => {
      button.addEventListener("click", () => {
        const rawTemplateId = button.getAttribute("data-editor-open-copy");
        const templateId = rawTemplateId ? Number.parseInt(rawTemplateId, 10) : Number.NaN;
        if (!Number.isInteger(templateId) || templateId < 1) {
          return;
        }
        const source = templates.find((template) => template.id === templateId);
        if (!source) {
          return;
        }
        recenterEditorViewForScreen("templateEditor");
        editorDraft = makeCopyTemplate(source);
        editorOpenedTemplateId = null;
        editorOpenedTemplateName = editorDraft.name;
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
    document.querySelectorAll<HTMLButtonElement>("button[data-editor-open-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        const rawTemplateId = button.getAttribute("data-editor-open-delete");
        const templateId = rawTemplateId ? Number.parseInt(rawTemplateId, 10) : Number.NaN;
        if (!Number.isInteger(templateId) || templateId < 1) {
          return;
        }
        const source = templates.find((template) => template.id === templateId);
        if (!source) {
          return;
        }
        if (!window.confirm(`Delete template "${source.name}" (${source.id})?`)) {
          return;
        }
        const deletedUser = await deleteUserTemplateFromStore(templateId);
        const deletedDefault = await deleteDefaultTemplateFromStore(templateId);
        if (!deletedUser && !deletedDefault) {
          addLog(`Failed to delete template: ${source.name}`, "bad");
          return;
        }
        await refreshTemplatesFromStore();
        const stillExists = templates.some((template) => template.id === templateId);
        if (stillExists) {
          addLog(`Cannot delete built-in template: ${source.name}`, "warn");
        } else {
          addLog(`Deleted template: ${source.name}`, "good");
        }
        if (editorDraft.id === templateId) {
          const fallback = templates[0];
          if (fallback) {
            if (fallback.id !== templateId) {
              recenterEditorViewForScreen("templateEditor");
            }
            editorDraft = cloneTemplate(fallback);
            editorOpenedTemplateId = fallback.id;
            editorOpenedTemplateName = fallback.name;
            loadTemplateIntoEditorSlots(editorDraft);
            editorTemplateDialogSelectedId = fallback.id;
            editorDeleteMode = false;
            editorWeaponRotateQuarter = 0;
            ensureEditorSelectionForLayer();
          }
        } else if (editorTemplateDialogSelectedId === templateId) {
          editorTemplateDialogSelectedId = templates[0]?.id ?? null;
        }
        renderPanels();
      });
    });

    getOptionalElement<HTMLButtonElement>("#btnOpenTemplateClose")?.addEventListener("click", () => {
      editorTemplateDialogOpen = false;
      renderPanels();
    });
    getOptionalElement<HTMLDivElement>("#editorOpenTemplateOverlay")?.addEventListener("click", (event) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      editorTemplateDialogOpen = false;
      renderPanels();
    });

    getOptionalElement<HTMLInputElement>("#editorDeleteMode")?.addEventListener("change", (event) => {
      editorDeleteMode = (event.currentTarget as HTMLInputElement).checked;
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#editorName")?.addEventListener("input", (event) => {
      editorDraft.name = (event.currentTarget as HTMLInputElement).value.trim() || "Custom Unit";
      updateSelectedInfo();
    });
    getOptionalElement<HTMLSelectElement>("#editorType")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      editorDraft.type = value === "air" ? "air" : value === "base" ? "base" : "ground";
      recomputeEditorDraftGasCost();
      updateSelectedInfo();
    });
    getOptionalElement<HTMLButtonElement>("#btnClearGrid")?.addEventListener("click", () => {
      editorStructureSlots = new Array<number | null>(EDITOR_GRID_MAX_SIZE).fill(null);
      editorStructureColorSlots = new Array<string | null>(EDITOR_GRID_MAX_SIZE).fill(null);
      editorFunctionalSlots = new Array<EditorFunctionalSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
      editorDisplaySlots = new Array<DisplayAttachmentTemplate["kind"] | null>(EDITOR_GRID_MAX_SIZE).fill(null);
      recalcEditorDraftFromSlots();
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnNewDraft")?.addEventListener("click", () => {
      const newName = "Custom Unit";
      editorDraft = {
        id: makeUniqueTemplateId(),
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
      editorOpenedTemplateId = null;
      editorOpenedTemplateName = editorDraft.name;
      recenterEditorViewForScreen("templateEditor");
      loadTemplateIntoEditorSlots(editorDraft);
      ensureEditorSelectionForLayer();
      renderPanels();
    });
    const saveEditorDraft = async (): Promise<void> => {
      const snapshot = cloneTemplate(editorDraft);
      const normalizedName = snapshot.name.trim().toLowerCase();
      const openedNameNormalized = editorOpenedTemplateName.trim().toLowerCase();
      const isRenameOfOpenedTemplate = editorOpenedTemplateId !== null
        && normalizedName.length > 0
        && normalizedName !== openedNameNormalized;
      const oldTemplateIdToDelete = isRenameOfOpenedTemplate ? editorOpenedTemplateId : null;
      if (isRenameOfOpenedTemplate) {
        snapshot.id = makeUniqueTemplateId();
      }
      if (normalizedName.length > 0) {
        const userTemplates = await fetchUserTemplatesFromStore(parts);
        const sameNameUserTemplates = userTemplates.filter((template) => template.name.trim().toLowerCase() === normalizedName);
        for (const userTemplate of sameNameUserTemplates) {
          const deleted = await deleteUserTemplateFromStore(userTemplate.id);
          if (!deleted) {
            addLog(`Failed to remove user template during default save: ${userTemplate.name} (${userTemplate.id})`, "bad");
            return;
          }
          addLog(`Removed user template shadowed by default save: ${userTemplate.name} (${userTemplate.id})`, "warn");
        }
      }
      const validation = validateTemplateDetailed(snapshot, { partCatalog: parts });
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
      const saved = await saveDefaultTemplateToStore(snapshot);
      if (!saved) {
        addLog("Failed to save default object", "bad");
        return;
      }
      if (oldTemplateIdToDelete !== null) {
        const deletedUserOld = await deleteUserTemplateFromStore(oldTemplateIdToDelete);
        const deletedDefaultOld = await deleteDefaultTemplateFromStore(oldTemplateIdToDelete);
        if (!deletedUserOld && !deletedDefaultOld) {
          addLog(`Failed to delete renamed old template id=${oldTemplateIdToDelete}`, "warn");
        }
      }
      editorDraft = cloneTemplate(snapshot);
      editorOpenedTemplateId = snapshot.id;
      editorOpenedTemplateName = snapshot.name;
      editorTemplateDialogSelectedId = snapshot.id;
      await refreshTemplatesFromStore();
      addLog(`Saved default object: ${snapshot.name}`, "good");
      renderPanels();
    };

    getOptionalElement<HTMLButtonElement>("#btnSaveDraftDefault")?.addEventListener("click", async () => {
      await saveEditorDraft();
    });

    getOptionalElement<HTMLInputElement>("#editorPlaceByCenter")?.addEventListener("change", (event) => {
      editorPlaceByCenter = (event.currentTarget as HTMLInputElement).checked;
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnShowPartComparison")?.addEventListener("click", () => {
      const comparableParts = parts.filter((part) => {
        const type = getResolvedPartType(part);
        return type === "weapon" || type === "structure";
      });
      partComparisonDrafts = new Map(comparableParts.map((part) => [part.id, clonePartDefinition(part)]));
      partComparisonDirtyIds = new Set<number>();
      partComparisonInvalidKeys = new Set<string>();
      const currentWeapon = comparableParts.find((part) => (
        part.id === partDesignerOpenedPartId && getResolvedPartType(part) === "weapon"
      ));
      const firstWeapon = comparableParts.find((part) => getResolvedPartType(part) === "weapon");
      const initial = currentWeapon ?? firstWeapon ?? comparableParts[0] ?? null;
      partComparisonSelection = initial
        ? { kind: getResolvedPartType(initial) === "structure" ? "structure" : "weapon", id: initial.id }
        : null;
      partComparisonTab = "hits";
      partComparisonOpen = true;
      renderPanels();
    });

    document.querySelectorAll<HTMLButtonElement>("[data-comparison-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        partComparisonTab = button.dataset.comparisonTab === "time" ? "time" : "hits";
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLButtonElement>("[data-comparison-select-kind][data-comparison-select-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const invalidInput = [...document.querySelectorAll<HTMLInputElement>("[data-comparison-field]")]
          .find((input) => !input.checkValidity());
        if (invalidInput) {
          invalidInput.reportValidity();
          return;
        }
        const id = Number.parseInt(button.dataset.comparisonSelectId ?? "", 10);
        const kind = button.dataset.comparisonSelectKind;
        if (!Number.isInteger(id) || (kind !== "weapon" && kind !== "structure")) {
          return;
        }
        partComparisonSelection = { kind, id };
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLInputElement>("[data-comparison-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const selection = partComparisonSelection;
        const draft = selection ? getPartComparisonDraft(selection.id) : null;
        const raw = input.value.trim();
        const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
        const field = input.dataset.comparisonField;
        const integerRequired = field === "maxCapacity";
        const minimum = integerRequired ? 1 : 0;
        const valid = Number.isFinite(numeric)
          && numeric >= minimum
          && (!integerRequired || Number.isInteger(numeric));
        const invalidKey = `${selection?.id ?? "none"}:${field ?? "unknown"}`;
        input.setCustomValidity(valid ? "" : integerRequired ? "Enter an integer of at least 1." : "Enter a non-negative number.");
        if (valid) {
          partComparisonInvalidKeys.delete(invalidKey);
        } else {
          partComparisonInvalidKeys.add(invalidKey);
        }
        const changedCount = getOptionalElement<HTMLElement>("#partComparisonChangedCount");
        if (changedCount) {
          changedCount.textContent = `${partComparisonDirtyIds.size} changed${partComparisonInvalidKeys.size > 0 ? ` · ${partComparisonInvalidKeys.size} invalid` : ""}`;
        }
        const saveButton = getOptionalElement<HTMLButtonElement>("#btnSavePartComparison");
        if (saveButton) {
          saveButton.disabled = partComparisonDirtyIds.size === 0 || partComparisonInvalidKeys.size > 0;
        }
        if (!draft || !valid || !field) {
          return;
        }
        if (selection?.kind === "weapon") {
          if (field === "gasCost" || field === "mass" || field === "damage" || field === "penetration" || field === "cooldown") {
            draft.stats = { ...(draft.stats ?? {}), [field]: numeric };
            draft.partProperties = { ...(draft.partProperties ?? {}), [field]: numeric };
          } else if (field === "maxCapacity" || field === "minFireInterval") {
            draft.partProperties = { ...(draft.partProperties ?? {}), [field]: numeric };
          }
        } else if (selection?.kind === "structure" && (field === "gasCost" || field === "mass" || field === "armor" || field === "hp")) {
          if (field === "gasCost" || field === "mass") {
            draft.stats = { ...(draft.stats ?? {}), [field]: numeric };
          } else {
            draft.properties = {
              ...(draft.properties ?? {}),
              [field === "armor" ? "materialArmor" : "hp"]: numeric,
            };
          }
          draft.partProperties = { ...(draft.partProperties ?? {}), [field]: numeric };
        }
        partComparisonDirtyIds.add(draft.id);
        if (changedCount) {
          changedCount.textContent = `${partComparisonDirtyIds.size} changed`;
        }
        if (saveButton) {
          saveButton.disabled = partComparisonInvalidKeys.size > 0;
        }
        refreshPartComparisonMatrix();
      });
      if (input.dataset.comparisonField === "gasCost") {
        input.addEventListener("change", () => {
          if (input.checkValidity()) {
            renderPanels();
          }
        });
      }
    });

    const closePartComparison = (): void => {
      partComparisonOpen = false;
      partComparisonSelection = null;
      partComparisonDrafts.clear();
      partComparisonDirtyIds.clear();
      partComparisonInvalidKeys.clear();
      renderPanels();
    };

    getOptionalElement<HTMLButtonElement>("#btnDiscardPartComparison")?.addEventListener("click", closePartComparison);
    getOptionalElement<HTMLButtonElement>("#btnClosePartComparison")?.addEventListener("click", closePartComparison);
    getOptionalElement<HTMLDivElement>("#partComparisonOverlay")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closePartComparison();
      }
    });

    getOptionalElement<HTMLButtonElement>("#btnSavePartComparison")?.addEventListener("click", async () => {
      const inputs = [...document.querySelectorAll<HTMLInputElement>("[data-comparison-field]")];
      const invalidInput = inputs.find((input) => !input.checkValidity());
      if (invalidInput) {
        invalidInput.reportValidity();
        return;
      }
      const changed = [...partComparisonDirtyIds]
        .map((id) => getPartComparisonDraft(id))
        .filter((part): part is PartDefinition => part !== null);
      if (changed.length === 0) {
        return;
      }
      for (const part of changed) {
        const validation = validatePartDefinitionDetailed(part);
        if (validation.errors.length > 0) {
          for (const issue of validation.errors) {
            addLog(`Part Error: ${issue}`, "bad");
          }
          return;
        }
      }
      const saveButton = getOptionalElement<HTMLButtonElement>("#btnSavePartComparison");
      if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = "Saving…";
      }
      const saved = await saveDefaultPartsToStore(changed);
      if (!saved) {
        addLog("Failed to save comparison changes; no staged values were applied.", "bad");
        if (saveButton) {
          saveButton.disabled = false;
          saveButton.textContent = "Save All";
        }
        return;
      }
      const savedCurrent = partDesignerOpenedPartId === null
        ? null
        : saved.find((part) => part.id === partDesignerOpenedPartId) ?? null;
      if (savedCurrent) {
        const type = getResolvedPartType(savedCurrent);
        if (type === "weapon") {
          const values = resolveWeaponComparisonValues(savedCurrent);
          partDesignerDraft.stats = {
            ...(partDesignerDraft.stats ?? {}),
            gasCost: values.gasCost,
            mass: values.mass,
            damage: values.damage,
            penetration: values.penetration,
            cooldown: values.cooldown,
          };
          partDesignerDraft.partProperties = {
            ...(partDesignerDraft.partProperties ?? {}),
            gasCost: values.gasCost,
            mass: values.mass,
            damage: values.damage,
            penetration: values.penetration,
            cooldown: values.cooldown,
            maxCapacity: values.maxCapacity,
            minFireInterval: values.minFireInterval,
          };
        } else if (type === "structure") {
          const values = resolveStructureComparisonValues(savedCurrent);
          partDesignerDraft.properties = {
            ...(partDesignerDraft.properties ?? {}),
            materialArmor: values.armor,
            hp: values.hp,
          };
          partDesignerDraft.stats = {
            ...(partDesignerDraft.stats ?? {}),
            gasCost: values.gasCost,
            mass: values.mass,
          };
          partDesignerDraft.partProperties = {
            ...(partDesignerDraft.partProperties ?? {}),
            gasCost: values.gasCost,
            mass: values.mass,
            armor: values.armor,
            hp: values.hp,
          };
        }
      }
      await refreshPartsFromStore();
      await refreshTemplatesFromStore();
      const savedSelection = partComparisonSelection;
      const comparableParts = parts.filter((part) => {
        const type = getResolvedPartType(part);
        return type === "weapon" || type === "structure";
      });
      partComparisonDrafts = new Map(comparableParts.map((part) => [part.id, clonePartDefinition(part)]));
      partComparisonDirtyIds.clear();
      partComparisonInvalidKeys.clear();
      if (savedSelection && partComparisonDrafts.has(savedSelection.id)) {
        partComparisonSelection = savedSelection;
      } else {
        const fallback = comparableParts[0] ?? null;
        partComparisonSelection = fallback
          ? { kind: getResolvedPartType(fallback) === "structure" ? "structure" : "weapon", id: fallback.id }
          : null;
      }
      addLog(`Saved comparison settings for ${saved.length} part${saved.length === 1 ? "" : "s"}.`, "good");
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnOpenPartWindow")?.addEventListener("click", () => {
      partDesignerDialogOpen = !partDesignerDialogOpen;
      if (partDesignerDialogOpen && !partDesignerSelectedId) {
        partDesignerSelectedId = parts[0]?.id ?? null;
      }
      renderPanels();
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-part-open-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextFilter = button.getAttribute("data-part-open-filter") as PartOpenFilter | null;
        if (!nextFilter) {
          return;
        }
        partDesignerOpenFilter = nextFilter;
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-part-open-select]").forEach((button) => {
      button.addEventListener("click", () => {
        const partIdRaw = button.getAttribute("data-part-open-select");
        const partId = partIdRaw ? Number.parseInt(partIdRaw, 10) : Number.NaN;
        if (!Number.isInteger(partId)) {
          return;
        }
        const source = parts.find((part) => part.id === partId);
        if (!source) {
          return;
        }
        if (partId !== partDesignerDraft.id) {
          recenterEditorViewForScreen("partEditor");
        }
        partDesignerSelectedId = partId;
        partDesignerOpenedPartId = source.id;
        partDesignerDialogOpen = false;
        loadPartIntoDesignerSlots(source);
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-part-open-copy]").forEach((button) => {
      button.addEventListener("click", () => {
        const partIdRaw = button.getAttribute("data-part-open-copy");
        const partId = partIdRaw ? Number.parseInt(partIdRaw, 10) : Number.NaN;
        if (!Number.isInteger(partId)) {
          return;
        }
        const source = parts.find((part) => part.id === partId);
        if (!source) {
          return;
        }
        recenterEditorViewForScreen("partEditor");
        const copy = makeCopyPart(source);
        partDesignerSelectedId = copy.id;
        partDesignerOpenedPartId = null;
        partDesignerDialogOpen = false;
        loadPartIntoDesignerSlots(copy);
        addLog(`Created part copy: ${copy.name}`, "good");
        renderPanels();
      });
    });
    document.querySelectorAll<HTMLButtonElement>("button[data-part-open-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        const partIdRaw = button.getAttribute("data-part-open-delete");
        const partId = partIdRaw ? Number.parseInt(partIdRaw, 10) : Number.NaN;
        if (!Number.isInteger(partId)) {
          return;
        }
        const source = parts.find((part) => part.id === partId);
        if (!source) {
          return;
        }
        if (!window.confirm(`Delete part "${source.name}" (${source.id})?`)) {
          return;
        }
        const deletedDefault = await deleteDefaultPartFromStore(partId);
        if (!deletedDefault) {
          addLog(`Failed to delete part: ${source.name}`, "bad");
          return;
        }
        await refreshPartsFromStore();
        await refreshTemplatesFromStore();
        const stillExists = parts.some((part) => part.id === partId);
        if (stillExists) {
          addLog(`Cannot delete built-in part: ${source.name}`, "warn");
        } else {
          addLog(`Deleted part: ${source.name}`, "good");
        }
        if (partDesignerDraft.id === partId) {
          const fallback = parts[0];
          if (fallback) {
            if (fallback.id !== partId) {
              recenterEditorViewForScreen("partEditor");
            }
            partDesignerSelectedId = fallback.id;
            partDesignerOpenedPartId = fallback.id;
            loadPartIntoDesignerSlots(fallback);
          }
        } else if (partDesignerSelectedId === partId) {
          partDesignerSelectedId = parts[0]?.id ?? null;
        }
        renderPanels();
      });
    });

    getOptionalElement<HTMLButtonElement>("#btnOpenPartClose")?.addEventListener("click", () => {
      partDesignerDialogOpen = false;
      renderPanels();
    });
    getOptionalElement<HTMLDivElement>("#editorOpenPartOverlay")?.addEventListener("click", (event) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      partDesignerDialogOpen = false;
      renderPanels();
    });

    getOptionalElement<HTMLInputElement>("#partName")?.addEventListener("input", (event) => {
      partDesignerDraft.name = (event.currentTarget as HTMLInputElement).value.trim() || "Custom Part";
      updateSelectedInfo();
    });

    getOptionalElement<HTMLSelectElement>("#partTypeSelect")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      if (value !== "structure" && value !== "control" && value !== "engine" && value !== "weapon" && value !== "loader") {
        return;
      }
      const nextPartType = value as PartType;
      const firstCanonicalName = CANONICAL_PART_CATEGORIES[nextPartType][0];
      const firstCanonicalPart = parts.find((part) => part.name.trim().toLowerCase() === firstCanonicalName);
      if (firstCanonicalPart) {
        if (partDesignerOpenedPartId === null) {
          const draftId = partDesignerDraft.id;
          const presetDraft = clonePartDefinition(firstCanonicalPart);
          presetDraft.id = draftId;
          presetDraft.name = `Custom ${firstCanonicalPart.name}`;
          loadPartIntoDesignerSlots(presetDraft);
          partDesignerOpenedPartId = null;
          partDesignerSelectedId = draftId;
        } else {
          partDesignerSelectedId = firstCanonicalPart.id;
          partDesignerOpenedPartId = firstCanonicalPart.id;
          loadPartIntoDesignerSlots(firstCanonicalPart);
        }
        renderPanels();
        return;
      }
      partDesignerDraft.partType = value as PartType;
      partDesignerDraft.partCategory = value === "engine"
        ? "vehicle"
        : value === "weapon"
          ? "bullet"
          : undefined;
      const nextWeaponExplosive = value === "weapon"
        ? (partDesignerDraft.partProperties?.explodeOnHit === true)
        : false;
      partDesignerDraft.baseComponent = getComponentFromPartTypeAndCategory(
        partDesignerDraft.partType,
        partDesignerDraft.partCategory,
        nextWeaponExplosive,
      );
      partDesignerDraft.layer = partDesignerDraft.partType === "structure" ? "structure" : "functional";
      partDesignerDraft.partProperties = getPartPropertiesDefaultsByType(partDesignerDraft.partType, partDesignerDraft.partCategory);
      partDesignerDraft.direction = getPartDirectionDefault(partDesignerDraft.baseComponent);
      partDesignerDraft.directional = COMPONENTS[partDesignerDraft.baseComponent].directional === true;
      partDesignerBrushSlot = normalizePartDesignerSlotForLayer(partDesignerBrushSlot, partDesignerDraft.layer);
      recalcPartDraftFromSlots();
      renderPanels();
    });

    getOptionalElement<HTMLSelectElement>("#partCanonicalCategorySelect")?.addEventListener("change", (event) => {
      const selectedPartId = Number.parseInt((event.currentTarget as HTMLSelectElement).value, 10);
      let preset = parts.find((part) => part.id === selectedPartId);
      if (!preset) {
        return;
      }
      if (getResolvedPartType(partDesignerDraft) === "engine") {
        const selectedPlatform = getResolvedPartCategory(preset);
        const currentDescription = (partDesignerDraft.tags ?? []).find((tag) => tag === "light" || tag === "heavy")
          ?? (partDesignerDraft.name.trim().toLowerCase().startsWith("heavy ") ? "heavy" : "light");
        preset = parts.find((part) => (
          getResolvedPartType(part) === "engine"
          && getResolvedPartCategory(part) === selectedPlatform
          && (
            (part.tags ?? []).includes(currentDescription)
            || part.name.trim().toLowerCase().startsWith(`${currentDescription} `)
          )
        )) ?? preset;
      }
      if (partDesignerOpenedPartId === null) {
        const draftId = partDesignerDraft.id;
        const presetDraft = clonePartDefinition(preset);
        presetDraft.id = draftId;
        presetDraft.name = `Custom ${preset.name}`;
        loadPartIntoDesignerSlots(presetDraft);
        partDesignerOpenedPartId = null;
        partDesignerSelectedId = draftId;
      } else {
        partDesignerSelectedId = preset.id;
        partDesignerOpenedPartId = preset.id;
        loadPartIntoDesignerSlots(preset);
      }
      renderPanels();
    });

    getOptionalElement<HTMLSelectElement>("#partBaseComponent")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      if (value === STRUCTURE_LAYER_BASE_OPTION) {
        if (partDesignerDraft.layer === "functional") {
          partDesignerLastFunctionalBaseComponent = partDesignerDraft.baseComponent;
        }
        partDesignerDraft.layer = "structure";
        partDesignerDraft.baseComponent = partDesignerLastFunctionalBaseComponent;
        partDesignerDraft.directional = false;
        partDesignerDraft.direction = getPartDirectionDefault(partDesignerDraft.baseComponent);
        partDesignerSlots = partDesignerSlots.map((entry) => {
          if (!entry) {
            return null;
          }
          return {
            ...entry,
            occupiesStructureSpace: true,
            occupiesFunctionalSpace: false,
            needsStructureBehind: false,
            isAttachPoint: false,
            isShootingPoint: false,
          };
        });
        partDesignerSupportOffsets = new Set<number>();
        partDesignerEmptyStructureOffsets = new Set<number>();
        partDesignerEmptyFunctionalOffsets = new Set<number>();
        partDesignerDraft.stats = {
          ...(partDesignerDraft.stats ?? {}),
          power: undefined,
          maxSpeed: undefined,
          recoil: undefined,
          hitImpulse: undefined,
          damage: undefined,
          range: undefined,
          cooldown: undefined,
          projectileSpeed: undefined,
          projectileGravity: undefined,
          penetration: undefined,
          spreadDeg: undefined,
          explosiveBlastRadius: undefined,
          explosiveBlastDamage: undefined,
          explosiveFalloffPower: undefined,
          trackingTurnRateDegPerSec: undefined,
          controlImpairFactor: undefined,
          controlDuration: undefined,
          loaderSupports: undefined,
          loaderLoadMultiplier: undefined,
          loaderFastOperation: undefined,
          loaderMinLoadTime: undefined,
          loaderMinBurstInterval: undefined,
        };
        const material = MATERIALS.basic;
        partDesignerDraft.properties = {
          ...(partDesignerDraft.properties ?? {}),
          materialArmor: partDesignerDraft.properties?.materialArmor ?? material.armor,
          materialRecoverPerSecond: partDesignerDraft.properties?.materialRecoverPerSecond ?? material.recoverPerSecond,
          materialColor: partDesignerDraft.properties?.materialColor ?? material.color,
          materialAlpha: partDesignerDraft.properties?.materialAlpha ?? 1,
          hp: partDesignerDraft.properties?.hp ?? material.hp,
        };
        partDesignerDraft.stats = {
          ...(partDesignerDraft.stats ?? {}),
          mass: partDesignerDraft.stats?.mass ?? material.mass,
        };
      } else {
        if (!(value in COMPONENTS)) {
          return;
        }
        partDesignerDraft.layer = "functional";
        partDesignerDraft.baseComponent = value as ComponentId;
        partDesignerLastFunctionalBaseComponent = partDesignerDraft.baseComponent;
        partDesignerDraft.direction = getPartDirectionDefault(partDesignerDraft.baseComponent);
      }
      if (partDesignerDraft.directional === undefined) {
        partDesignerDraft.directional = COMPONENTS[partDesignerDraft.baseComponent].directional === true;
      }
      const defaults = getPartPropertyDefaults(partDesignerDraft.baseComponent);
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        isEngine: partDesignerDraft.layer === "structure" ? false : defaults.isEngine,
        isWeapon: partDesignerDraft.layer === "structure" ? false : defaults.isWeapon,
        isLoader: partDesignerDraft.layer === "structure" ? false : defaults.isLoader,
        isArmor: partDesignerDraft.layer === "structure" ? true : defaults.isArmor,
        engineType: partDesignerDraft.layer === "structure" ? undefined : defaults.engineType,
        projectileClass: partDesignerDraft.layer === "structure" ? undefined : defaults.projectileClass,
        loaderServesTags: partDesignerDraft.layer === "structure" ? undefined : defaults.loaderServesTags,
        loaderCooldownMultiplier: partDesignerDraft.layer === "structure" ? undefined : defaults.loaderCooldownMultiplier,
      };
      partDesignerBrushSlot = normalizePartDesignerSlotForLayer(partDesignerBrushSlot, partDesignerDraft.layer);
      syncPartMetaDefaultsIfNotEdited();
      recalcPartDraftFromSlots();
      renderPanels();
    });

    getOptionalElement<HTMLInputElement>("#partDirectional")?.addEventListener("change", (event) => {
      partDesignerDraft.directional = (event.currentTarget as HTMLInputElement).checked;
      renderPanels();
    });
    getOptionalElement<HTMLSelectElement>("#partDirection")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      if (value === "up" || value === "right" || value === "down" || value === "left") {
        partDesignerDraft.direction = value as PartDirection;
      }
      renderPanels();
    });

    document.querySelectorAll<HTMLInputElement>("input.autoCraftToggle").forEach((input) => {
      input.addEventListener("change", () => {
        const templateId = Number.parseInt(input.getAttribute("data-template-id") ?? "", 10);
        if (!Number.isInteger(templateId)) return;
        if (input.checked && !defaultAutoTemplateIds.includes(templateId)) defaultAutoTemplateIds.push(templateId);
        if (!input.checked) defaultAutoTemplateIds = defaultAutoTemplateIds.filter((id) => id !== templateId);
        addLog(`Off-screen AI roster: ${defaultAutoTemplateIds.length} craft selected`, "good");
      });
    });
    getOptionalElement<HTMLInputElement>("#partHasAngleLimit")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      const nextProps = {
        ...(partDesignerDraft.partProperties ?? {}),
        hasAngleLimit: checked,
      };
      if (!checked) {
        nextProps.cwAngle = undefined;
        nextProps.ccwAngle = undefined;
      }
      partDesignerDraft.partProperties = nextProps;
      renderPanels();
    });
    getOptionalElement<HTMLSelectElement>("#partProjectileClass")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      if (value !== "bullet" && value !== "missile" && value !== "laser") return;
      const projectileClass = value as ProjectileClass;
      const firstShape = PROJECTILE_SHAPES[projectileClass][0]?.value;
      const current = partDesignerDraft.partProperties ?? {};
      const nextShape = PROJECTILE_SHAPES[projectileClass].some((option) => option.value === current.projectileShape)
        ? current.projectileShape
        : firstShape;
      partDesignerDraft.partProperties = {
        ...current,
        projectileClass,
        projectileShape: nextShape,
        projectileSizeRatio: current.projectileSizeRatio ?? 1,
        tracking: projectileClass === "missile" ? (current.tracking ?? false) : false,
        trackingTurnRate: projectileClass === "missile" ? current.trackingTurnRate : undefined,
        explodeOnHit: projectileClass === "laser" ? false : (current.explodeOnHit ?? false),
        projectileSpeed: projectileClass === "laser" ? undefined : (current.projectileSpeed ?? 400),
        projectileGravity: projectileClass === "laser" ? undefined : (current.projectileGravity ?? 100),
      };
      partDesignerDraft.properties = { ...(partDesignerDraft.properties ?? {}), projectileClass };
      partDesignerDraft.stats = {
        ...(partDesignerDraft.stats ?? {}),
        projectileClass,
        projectileShape: nextShape,
        projectileSizeRatio: current.projectileSizeRatio ?? 1,
      };
      partDesignerDraft.partCategory = projectileClass === "missile" ? "missile" : projectileClass === "laser" ? "beam" : "bullet";
      partDesignerDraft.baseComponent = getComponentFromProjectileClass(
        projectileClass,
        projectileClass !== "laser" && current.explodeOnHit === true,
      );
      renderPanels();
    });
    getOptionalElement<HTMLSelectElement>("#partProjectileShape")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value as ProjectileShape;
      const projectileClass = partDesignerDraft.partProperties?.projectileClass ?? "bullet";
      if (!PROJECTILE_SHAPES[projectileClass].some((option) => option.value === value)) return;
      partDesignerDraft.partProperties = { ...(partDesignerDraft.partProperties ?? {}), projectileShape: value };
      partDesignerDraft.stats = { ...(partDesignerDraft.stats ?? {}), projectileShape: value };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partProjectileSizeRatio")?.addEventListener("input", (event) => {
      const numeric = Number((event.currentTarget as HTMLInputElement).value);
      const value = Number.isFinite(numeric) ? Math.max(0.1, Math.min(10, numeric)) : 1;
      partDesignerDraft.partProperties = { ...(partDesignerDraft.partProperties ?? {}), projectileSizeRatio: value };
      partDesignerDraft.stats = { ...(partDesignerDraft.stats ?? {}), projectileSizeRatio: value };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partTracking")?.addEventListener("change", (event) => {
      const tracking = (event.currentTarget as HTMLInputElement).checked;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        tracking,
        trackingTurnRate: tracking ? (partDesignerDraft.partProperties?.trackingTurnRate ?? 50) : undefined,
      };
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partExplodeOnHit")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        explodeOnHit: checked,
      };
      const partType = getResolvedPartType(partDesignerDraft);
      const partCategory = getResolvedPartCategory(partDesignerDraft);
      const projectileClass = partDesignerDraft.partProperties?.projectileClass
        ?? (partCategory === "missile" ? "missile" : partCategory === "beam" ? "laser" : "bullet");
      partDesignerDraft.baseComponent = partType === "weapon"
        ? getComponentFromProjectileClass(projectileClass, checked)
        : getComponentFromPartTypeAndCategory(partType, partCategory, checked);
      syncPartMetaDefaultsIfNotEdited();
      recalcPartDraftFromSlots();
      renderPanels();
    });

    getOptionalElement<HTMLSelectElement>("#partCategorySelect")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value.trim();
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        category: value || undefined,
      };
      partDesignerCategoryEdited = true;
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partSubcategory")?.addEventListener("input", (event) => {
      const value = (event.currentTarget as HTMLInputElement).value.trim();
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        subcategory: value || undefined,
      };
      partDesignerSubcategoryEdited = true;
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partTags")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value;
      const tags = raw
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      partDesignerDraft.tags = tags.length > 0 ? tags : undefined;
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partMetaHp")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      const next = Number.isFinite(numeric) ? numeric : undefined;
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        hp: next,
      };
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        hp: next,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partMaterialArmor")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        materialArmor: Number.isFinite(numeric) ? numeric : undefined,
      };
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        armor: Number.isFinite(numeric) ? numeric : undefined,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partMaterialRecoverPerSecond")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        materialRecoverPerSecond: Number.isFinite(numeric) ? numeric : undefined,
      };
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        recover: Number.isFinite(numeric) ? numeric : undefined,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partMaterialColor")?.addEventListener("input", (event) => {
      const value = (event.currentTarget as HTMLInputElement).value.trim();
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        materialColor: value.length > 0 ? value : undefined,
      };
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        color: value.length > 0 ? value : undefined,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partMaterialAlpha")?.addEventListener("input", (event) => {
      const numeric = Number((event.currentTarget as HTMLInputElement).value);
      const alpha = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 1;
      partDesignerDraft.properties = { ...(partDesignerDraft.properties ?? {}), materialAlpha: alpha };
      partDesignerDraft.partProperties = { ...(partDesignerDraft.partProperties ?? {}), alpha };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partControlComputing")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      const next = Number.isFinite(numeric) ? Math.max(0, numeric) : undefined;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        computing: next,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partWeaponComputingConsumption")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      const next = Number.isFinite(numeric) ? Math.max(0, numeric) : undefined;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        computingConsumption: next,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partFireSoundVolume")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      const next = Number.isFinite(numeric) ? Math.max(0, Math.min(2, numeric)) : undefined;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        fireSoundVolume: next,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLSelectElement>("#partFireSoundPool")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value as FireSoundPool;
      if (!FIRE_SOUND_POOL_OPTIONS.some((option) => option.value === value)) return;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        fireSoundPool: value,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partPropIsEngine")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      const props = partDesignerDraft.properties ?? {};
      partDesignerDraft.properties = { ...props, isEngine: checked };
      if (!checked) {
        partDesignerDraft.properties.engineType = undefined;
        partDesignerDraft.stats = {
          ...(partDesignerDraft.stats ?? {}),
          power: undefined,
          maxSpeed: undefined,
        };
      } else if (!partDesignerDraft.properties.engineType) {
        partDesignerDraft.properties.engineType = "ground";
      }
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partPropIsWeapon")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      const props = partDesignerDraft.properties ?? {};
      partDesignerDraft.properties = { ...props, isWeapon: checked };
      if (!checked) {
        partDesignerDraft.properties.projectileClass = undefined;
        partDesignerDraft.stats = {
          ...(partDesignerDraft.stats ?? {}),
          recoil: undefined,
          hitImpulse: undefined,
          damage: undefined,
          range: undefined,
          cooldown: undefined,
          projectileSpeed: undefined,
          projectileGravity: undefined,
          penetration: undefined,
          spreadDeg: undefined,
          explosiveBlastRadius: undefined,
          explosiveBlastDamage: undefined,
          explosiveFalloffPower: undefined,
          trackingTurnRateDegPerSec: undefined,
          controlImpairFactor: undefined,
          controlDuration: undefined,
        };
      } else if (!partDesignerDraft.properties.projectileClass) {
        partDesignerDraft.properties.projectileClass = "bullet";
      }
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partPropIsLoader")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      const props = partDesignerDraft.properties ?? {};
      partDesignerDraft.properties = {
        ...props,
        isLoader: checked,
        loaderServesTags: checked ? (props.loaderServesTags ?? []) : undefined,
        loaderCooldownMultiplier: checked ? props.loaderCooldownMultiplier : undefined,
      };
      if (!checked) {
        partDesignerDraft.stats = {
          ...(partDesignerDraft.stats ?? {}),
          loaderSupports: undefined,
          loaderLoadMultiplier: undefined,
          loaderFastOperation: undefined,
          loaderMinLoadTime: undefined,
          loaderMinBurstInterval: undefined,
        };
      }
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partPropIsArmor")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      const props = partDesignerDraft.properties ?? {};
      partDesignerDraft.properties = {
        ...props,
        isArmor: checked,
        hp: checked ? props.hp : undefined,
      };
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partPropCoreTuning")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      const props = partDesignerDraft.properties ?? {};
      partDesignerDraft.properties = {
        ...props,
        hasCoreTuning: checked,
      };
      if (!checked) {
        partDesignerDraft.stats = {
          ...(partDesignerDraft.stats ?? {}),
          mass: undefined,
          hpMul: undefined,
        };
      }
      renderPanels();
    });
    getOptionalElement<HTMLSelectElement>("#partEngineType")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        engineType: value === "air" ? "air" : "ground",
      };
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partLoaderSupports")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value;
      const supportsRaw = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const supports = parseProjectileClassList(supportsRaw);
      partDesignerDraft.stats = {
        ...(partDesignerDraft.stats ?? {}),
        loaderSupports: supports.length > 0 ? supports : undefined,
      };
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        loaderServesTags: supports.length > 0 ? supports : undefined,
      };
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        supportedWeaponTags: supports.length > 0 ? supports : undefined,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partLoaderLoadMultiplier")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      const next = Number.isFinite(numeric) ? numeric : undefined;
      partDesignerDraft.stats = {
        ...(partDesignerDraft.stats ?? {}),
        loaderLoadMultiplier: next,
      };
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        loaderCooldownMultiplier: next,
      };
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        loadMultiplier: next,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partLoaderFastOperation")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      partDesignerDraft.stats = {
        ...(partDesignerDraft.stats ?? {}),
        loaderFastOperation: checked,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partRequireStructureOnFunctional")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      partDesignerDraft.placement = {
        ...(partDesignerDraft.placement ?? {}),
        requireStructureOnFunctionalOccupiedBoxes: checked,
      };
      recalcPartDraftFromSlots();
      renderPanels();
    });

    getOptionalElement<HTMLInputElement>("#partRequireStructureOnStructure")?.addEventListener("change", (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      partDesignerDraft.placement = {
        ...(partDesignerDraft.placement ?? {}),
        requireStructureOnStructureOccupiedBoxes: checked,
      };
      recalcPartDraftFromSlots();
      renderPanels();
    });

    const bindRuntimeInput = (
      selector: string,
      key: keyof NonNullable<PartDefinition["stats"]>,
      partPropKey?: keyof NonNullable<PartDefinition["partProperties"]>,
    ): void => {
      getOptionalElement<HTMLInputElement>(selector)?.addEventListener("input", (event) => {
        const raw = (event.currentTarget as HTMLInputElement).value;
        const numeric = raw.trim().length > 0 ? Number(raw) : Number.NaN;
        const next = Number.isFinite(numeric) ? numeric : undefined;
        partDesignerDraft.stats = {
          ...(partDesignerDraft.stats ?? {}),
          [key]: next,
        };
        if (partPropKey) {
          partDesignerDraft.partProperties = {
            ...(partDesignerDraft.partProperties ?? {}),
            [partPropKey]: next,
          };
        }
      });
    };
    bindRuntimeInput("#partMass", "mass", "mass");
    bindRuntimeInput("#partHpMul", "hpMul");
    bindRuntimeInput("#partPower", "power", "power");
    bindRuntimeInput("#partMaxSpeed", "maxSpeed", "maxSpeed");
    bindRuntimeInput("#partRecoil", "recoil", "recoil");
    bindRuntimeInput("#partHitImpulse", "hitImpulse", "hitImpulse");
    bindRuntimeInput("#partDamage", "damage", "damage");
    bindRuntimeInput("#partPenetration", "penetration", "penetration");
    bindRuntimeInput("#partRange", "range", "range");
    bindRuntimeInput("#partCooldown", "cooldown", "cooldown");
    bindRuntimeInput("#partProjectileSpeed", "projectileSpeed", "projectileSpeed");
    bindRuntimeInput("#partProjectileGravity", "projectileGravity", "projectileGravity");
    bindRuntimeInput("#partSpread", "spreadDeg", "spreadAngleDeg");
    bindRuntimeInput("#partExplosiveBlastRadius", "explosiveBlastRadius", "explodeRadius");
    bindRuntimeInput("#partExplosiveBlastDamage", "explosiveBlastDamage", "explosionDamage");
    bindRuntimeInput("#partExplosiveFalloffPower", "explosiveFalloffPower");
    bindRuntimeInput("#partTrackingTurnRate", "trackingTurnRateDegPerSec", "trackingTurnRate");
    bindRuntimeInput("#partControlImpairFactor", "controlImpairFactor");
    bindRuntimeInput("#partControlDuration", "controlDuration");
    bindRuntimeInput("#partLoaderMinLoadTime", "loaderMinLoadTime", "minLoadTime");
    bindRuntimeInput("#partLoaderMinBurstInterval", "loaderMinBurstInterval", "minBurstInterval");
    bindRuntimeInput("#partGasCost", "gasCost", "gasCost");
    getOptionalElement<HTMLInputElement>("#partWeaponNeedLoader")?.addEventListener("change", (event) => {
      const needLoader = (event.currentTarget as HTMLInputElement).checked;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        needLoader,
        bulletName: needLoader
          ? (partDesignerDraft.partProperties?.bulletName ?? "bullet")
          : undefined,
      };
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partBulletName")?.addEventListener("input", (event) => {
      const bulletName = (event.currentTarget as HTMLInputElement).value;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        bulletName,
      };
    });
    getOptionalElement<HTMLInputElement>("#partWeaponMaxLoadedAmmo")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      const maxCapacity = Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : undefined;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        maxCapacity,
        minFireInterval: maxCapacity !== undefined && maxCapacity !== 1
          ? (partDesignerDraft.partProperties?.minFireInterval ?? 0.2)
          : partDesignerDraft.partProperties?.minFireInterval,
      };
    });
    getOptionalElement<HTMLInputElement>("#partWeaponMaxLoadedAmmo")?.addEventListener("change", () => {
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partWeaponMinFireInterval")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        minFireInterval: Number.isFinite(numeric) ? Math.max(0, numeric) : 0.2,
      };
    });
    getOptionalElement<HTMLInputElement>("#partCwAngle")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        cwAngle: Number.isFinite(numeric) ? Math.max(0, numeric) : undefined,
      };
    });
    getOptionalElement<HTMLInputElement>("#partCcwAngle")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      partDesignerDraft.partProperties = {
        ...(partDesignerDraft.partProperties ?? {}),
        ccwAngle: Number.isFinite(numeric) ? Math.max(0, numeric) : undefined,
      };
    });

    getOptionalElement<HTMLButtonElement>("#btnNewPartDraft")?.addEventListener("click", () => {
      const newName = "Custom Part";
      const nextId = makeUniquePartId();
      partDesignerDraft = createDefaultPartDraft(nextId, newName);
      partDesignerDraft.anchor = { x: 0, y: 0 };
      partDesignerDraft.boxes = [];
      partDesignerLastFunctionalBaseComponent = partDesignerDraft.baseComponent;
      partDesignerCategoryEdited = false;
      partDesignerSubcategoryEdited = false;
      partDesignerSelectedId = partDesignerDraft.id;
      partDesignerOpenedPartId = null;
      partDesignerTool = "select";
      partDesignerDialogOpen = false;
      recenterEditorViewForScreen("partEditor");
      loadPartIntoDesignerSlots(partDesignerDraft);
      renderPanels();
    });

    getOptionalElement<HTMLButtonElement>("#btnClearPartGrid")?.addEventListener("click", () => {
      partDesignerSlots = new Array<PartDesignerSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
      partDesignerSupportOffsets = new Set<number>();
      partDesignerEmptyStructureOffsets = new Set<number>();
      partDesignerEmptyFunctionalOffsets = new Set<number>();
      partDesignerAnchorSlot = coordToSlot(0, 0);
      partDesignerSelectedSlot = partDesignerAnchorSlot;
      recalcPartDraftFromSlots();
      renderPanels();
    });

    const savePartDraft = async (): Promise<void> => {
      recalcPartDraftFromSlots();
      const snapshot = clonePartDefinition(partDesignerDraft);
      const isUnsavedDraft = partDesignerOpenedPartId === null;
      const collidesWithExistingPart = parts.some((part) => part.id === snapshot.id);
      if (isUnsavedDraft && collidesWithExistingPart) {
        const oldId = snapshot.id;
        snapshot.id = makeUniquePartId();
        partDesignerDraft.id = snapshot.id;
        partDesignerSelectedId = snapshot.id;
        addLog(`Adjusted copied/new draft id to avoid overwrite: ${oldId} -> ${snapshot.id}`, "warn");
      }
      const validation = validatePartDefinitionDetailed(snapshot);
      for (const issue of validation.errors) {
        addLog(`Part Error: ${issue}`, "bad");
      }
      for (const issue of validation.warnings) {
        addLog(`Part Warning: ${issue}`, "warn");
      }
      const savedPart = await saveDefaultPartToStore(snapshot);
      if (!savedPart) {
        addLog("Failed to save part", "bad");
        return;
      }
      await refreshPartsFromStore();
      // The successful PUT payload is authoritative. Do not let a stale catalog
      // GET replace the just-saved draft with the previous file contents.
      const savedPartIndex = parts.findIndex((part) => part.id === savedPart.id);
      if (savedPartIndex >= 0) {
        parts[savedPartIndex] = clonePartDefinition(savedPart);
      } else {
        parts.push(clonePartDefinition(savedPart));
      }
      battle.setPartCatalog(parts);
      await refreshTemplatesFromStore();
      partDesignerSelectedId = savedPart.id;
      partDesignerOpenedPartId = savedPart.id;
      loadPartIntoDesignerSlots(savedPart);
      addLog(`Saved part: ${savedPart.name}`, "good");
      renderPanels();
    };

    getOptionalElement<HTMLButtonElement>("#btnSavePartDraft")?.addEventListener("click", async () => {
      await savePartDraft();
    });
  };

  tabs.base.addEventListener("click", () => { setScreen("base"); renderPanels(); });
  tabs.map.addEventListener("click", () => { setScreen("map"); renderPanels(); });
  tabs.battle.addEventListener("click", () => { setScreen("battle"); renderPanels(); });
  tabs.testArena.addEventListener("click", () => {
    setScreen("testArena");
    renderPanels();
  });
  tabs.craftArena.addEventListener("click", () => {
    setScreen("craftArena");
    renderPanels();
    void Promise.all([refreshTestArenaCompositeModelOptions(), importCraftArenaSeed()]).then(() => {
      renderPanels();
    });
  });
  tabs.leaderboard.addEventListener("click", () => {
    setScreen("leaderboard");
    renderPanels();
    void refreshTestArenaLeaderboard().then(() => {
      void refreshTestArenaCompositeModelOptions().then(() => {
        renderPanels();
      });
    });
  });
  tabs.templateEditor.addEventListener("click", () => {
    setScreen("templateEditor");
    renderPanels();
  });
  tabs.partEditor.addEventListener("click", () => {
    setScreen("partEditor");
    const selected = parts.find((part) => part.id === partDesignerSelectedId);
    if (selected) {
      partDesignerSelectedId = selected.id;
      partDesignerOpenedPartId = selected.id;
      loadPartIntoDesignerSlots(selected);
    }
    renderPanels();
  });

  const closeGlobalSettings = (): void => {
    stopGlobalSettingsPreview();
    globalSettingsOverlay.classList.add("hidden");
    globalSettingsError.textContent = "";
  };
  const humanizeConfigKey = (key: string): string => {
    if (key.toLowerCase() === "ai") return "AI";
    return key
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replaceAll("-", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  };
  const getSoundPreviewKind = (path: string[]): "sample" | "fire-pool" | null => {
    if (path[0] !== "sound" || path[1] !== "battle") return null;
    if (path[2] === "samples" && path.length === 4) return "sample";
    if (path[2] === "firePools" && path.length === 4) return "fire-pool";
    return null;
  };
  const renderConfigNode = (value: unknown, path: string[], descriptions: Record<string, string>, depth = 0): string => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>).map(([key, child]) => {
        const childPath = [...path, key];
        if (child && typeof child === "object" && !Array.isArray(child)) {
          return `<details class="global-settings-group depth-${Math.min(depth, 3)}">
            <summary>${escapeHtml(humanizeConfigKey(key))}</summary>
            <div>${renderConfigNode(child, childPath, descriptions, depth + 1)}</div>
          </details>`;
        }
        return renderConfigNode(child, childPath, descriptions, depth + 1);
      }).join("");
    }
    const key = path[path.length - 1] ?? "value";
    const encodedPath = encodeURIComponent(JSON.stringify(path));
    const label = escapeHtml(humanizeConfigKey(key));
    const description = descriptions[path.slice(2).join(".")] ?? "No description is available for this setting.";
    const descriptionAttribute = escapeHtml(description);
    const help = `<span class="global-setting-help" title="${descriptionAttribute}" aria-label="${descriptionAttribute}" tabindex="0">?</span>`;
    const previewKind = getSoundPreviewKind(path);
    const previewButton = previewKind
      ? `<button type="button" class="global-setting-preview" data-sound-preview="${previewKind}" data-sound-path="${encodedPath}" aria-label="Preview ${label} sound">&#9654; Preview</button>`
      : "";
    if (typeof value === "boolean") {
      return `<label class="global-setting-field" data-description="${descriptionAttribute}" title="${descriptionAttribute}"><span><strong>${label}</strong><small>Boolean ${help}</small></span>
        <span class="global-setting-value"><input data-config-path="${encodedPath}" data-config-type="boolean" type="checkbox" ${value ? "checked" : ""} /></span></label>`;
    }
    if (typeof value === "number") {
      return `<label class="global-setting-field" data-description="${descriptionAttribute}" title="${descriptionAttribute}"><span><strong>${label}</strong><small>Number ${help}</small></span>
        <span class="global-setting-value"><input data-config-path="${encodedPath}" data-config-type="number" type="number" step="any" value="${value}" /></span></label>`;
    }
    if (Array.isArray(value)) {
      return `<label class="global-setting-field global-setting-array" data-description="${descriptionAttribute}" title="${descriptionAttribute}"><span><strong>${label}</strong><small>JSON array ${help}</small></span>
        <span class="global-setting-array-value"><textarea data-config-path="${encodedPath}" data-config-type="array" rows="2">${escapeHtml(JSON.stringify(value))}</textarea>${previewButton}</span></label>`;
    }
    return `<label class="global-setting-field" data-description="${descriptionAttribute}" title="${descriptionAttribute}"><span><strong>${label}</strong><small>Text ${help}</small></span>
      <span class="global-setting-value global-setting-text"><input data-config-path="${encodedPath}" data-config-type="string" type="text" value="${escapeHtml(String(value ?? ""))}" />${previewButton}</span></label>`;
  };
  const stopGlobalSettingsPreview = (): void => {
    if (!activeGlobalSettingsPreview) return;
    activeGlobalSettingsPreview.audio.pause();
    activeGlobalSettingsPreview.audio.currentTime = 0;
    activeGlobalSettingsPreview.button.disabled = false;
    activeGlobalSettingsPreview.button.innerHTML = "&#9654; Preview";
    activeGlobalSettingsPreview = null;
  };
  const playGlobalSettingsPreview = async (button: HTMLButtonElement): Promise<void> => {
    stopGlobalSettingsPreview();
    const path = JSON.parse(decodeURIComponent(button.dataset.soundPath ?? "")) as string[];
    const previewKind = button.dataset.soundPreview;
    const draft = collectGlobalSettingsDraft();
    const battleSound = draft.sound?.battle as {
      samples?: Record<string, unknown>;
      firePools?: Record<string, unknown>;
      firePlaybackRates?: Record<string, unknown>;
    } | undefined;
    if (!battleSound?.samples) throw new Error("Sound sample settings are unavailable.");

    let sampleKey = path[3] ?? "";
    let playbackRate = 1;
    if (previewKind === "fire-pool") {
      const pool = battleSound.firePools?.[sampleKey];
      if (!Array.isArray(pool) || pool.length === 0 || pool.some((entry) => typeof entry !== "string")) {
        throw new Error(`${humanizeConfigKey(sampleKey)} must contain at least one valid sample key.`);
      }
      sampleKey = pool[Math.floor(Math.random() * pool.length)] as string;
      const configuredRate = battleSound.firePlaybackRates?.[path[3] ?? ""];
      if (typeof configuredRate === "number" && Number.isFinite(configuredRate)) playbackRate = configuredRate;
    }
    const samplePath = battleSound.samples[sampleKey];
    if (typeof samplePath !== "string" || samplePath.trim().length === 0) {
      throw new Error(`No audio path is configured for sample "${sampleKey}".`);
    }

    const assetUrl = `/assets/audio/${samplePath.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
    const audio = new Audio(assetUrl);
    audio.playbackRate = playbackRate;
    button.disabled = true;
    button.textContent = "Playing...";
    activeGlobalSettingsPreview = { audio, button };
    const finish = (): void => {
      if (activeGlobalSettingsPreview?.audio === audio) stopGlobalSettingsPreview();
    };
    audio.addEventListener("ended", finish, { once: true });
    audio.addEventListener("error", finish, { once: true });
    try {
      await audio.play();
    } catch (error) {
      finish();
      throw error;
    }
  };
  const renderGlobalSettings = (): void => {
    stopGlobalSettingsPreview();
    if (!globalSettingsConfig) {
      globalSettingsTabs.innerHTML = "";
      globalSettingsContent.innerHTML = `<div class="small">Loading YAML settings...</div>`;
      return;
    }
    const categories = Object.keys(globalSettingsConfig);
    if (!categories.includes(globalSettingsCategory)) globalSettingsCategory = categories[0] ?? "";
    globalSettingsTabs.innerHTML = categories.map((category) => `<button type="button" role="tab" data-config-category="${escapeHtml(category)}" aria-selected="${category === globalSettingsCategory}" class="${category === globalSettingsCategory ? "active" : ""}">${escapeHtml(humanizeConfigKey(category))}</button>`).join("");
    const categoryConfig = globalSettingsConfig[globalSettingsCategory] ?? {};
    const categoryEntries = Object.entries(categoryConfig);
    const expandOnlySubcategory = categoryEntries.length === 1;
    globalSettingsContent.innerHTML = categoryEntries.map(([subcategory, value]) => `
      <details class="global-settings-subcategory" ${expandOnlySubcategory ? "open" : ""}>
        <summary>${escapeHtml(humanizeConfigKey(subcategory))}</summary>
        <div class="global-settings-subcategory-content">
          ${renderConfigNode(value, [globalSettingsCategory, subcategory], globalSettingsDescriptions?.[globalSettingsCategory]?.[subcategory] ?? {})}
        </div>
      </details>
    `).join("") || `<div class="small">No settings in this category.</div>`;
    globalSettingsTabs.querySelectorAll<HTMLButtonElement>("[data-config-category]").forEach((button) => {
      button.addEventListener("click", () => {
        try {
          globalSettingsConfig = collectGlobalSettingsDraft();
        } catch (error) {
          globalSettingsError.textContent = error instanceof Error ? error.message : String(error);
          return;
        }
        globalSettingsCategory = button.dataset.configCategory ?? globalSettingsCategory;
        globalSettingsError.textContent = "";
        renderGlobalSettings();
      });
    });
    globalSettingsContent.querySelectorAll<HTMLButtonElement>("[data-sound-preview]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        globalSettingsError.textContent = "";
        void playGlobalSettingsPreview(button).catch((error) => {
          globalSettingsError.textContent = `Sound preview failed: ${error instanceof Error ? error.message : String(error)}`;
        });
      });
    });
  };
  const loadGlobalSettingsForm = async (): Promise<void> => {
    const response = await fetch("/__config/settings");
    const payload = await response.json() as { ok?: boolean; config?: ConfigTree; descriptions?: ConfigDescriptionTree; error?: string };
    if (!response.ok || !payload.ok || !payload.config || !payload.descriptions) {
      throw new Error(payload.error ?? `Settings request failed (${response.status}).`);
    }
    globalSettingsConfig = payload.config;
    globalSettingsDescriptions = payload.descriptions;
    renderGlobalSettings();
  };
  const openGlobalSettings = (): void => {
    developerMenu.open = false;
    globalSettingsError.textContent = "";
    globalSettingsOverlay.classList.remove("hidden");
    renderGlobalSettings();
    void loadGlobalSettingsForm().catch((error) => {
      globalSettingsError.textContent = error instanceof Error ? error.message : String(error);
    });
  };
  const setConfigPathValue = (rootConfig: ConfigTree, path: string[], value: unknown): void => {
    let cursor: Record<string, unknown> = rootConfig;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index] ?? "";
      const next = cursor[key];
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(`Invalid setting path: ${path.join(".")}`);
      cursor = next as Record<string, unknown>;
    }
    cursor[path[path.length - 1] ?? ""] = value;
  };
  const collectGlobalSettingsDraft = (): ConfigTree => {
    if (!globalSettingsConfig) throw new Error("Settings have not loaded.");
    const draft = structuredClone(globalSettingsConfig);
    const controls = globalSettingsContent.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-config-path]");
    for (const control of controls) {
      const path = JSON.parse(decodeURIComponent(control.dataset.configPath ?? "")) as string[];
      const type = control.dataset.configType;
      let value: unknown;
      if (type === "boolean" && control instanceof HTMLInputElement) {
        value = control.checked;
      } else if (type === "number") {
        value = Number(control.value);
        if (!Number.isFinite(value)) throw new Error(`${humanizeConfigKey(path[path.length - 1] ?? "Setting")} must be a finite number.`);
      } else if (type === "array") {
        value = JSON.parse(control.value);
        if (!Array.isArray(value)) throw new Error(`${humanizeConfigKey(path[path.length - 1] ?? "Setting")} must be a JSON array.`);
      } else {
        value = control.value;
      }
      setConfigPathValue(draft, path, value);
    }
    return draft;
  };
  const saveGlobalSettings = async (): Promise<void> => {
    try {
      const config = collectGlobalSettingsDraft();
      const response = await fetch("/__config/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const payload = await response.json() as { ok?: boolean; config?: ConfigTree; descriptions?: ConfigDescriptionTree; error?: string };
      if (!response.ok || !payload.ok || !payload.config || !payload.descriptions) {
        throw new Error(payload.error ?? `Global settings save failed (${response.status}).`);
      }
      globalSettingsConfig = payload.config;
      globalSettingsDescriptions = payload.descriptions;
      const battlefield = payload.config.balance?.battlefield as { movement?: { defaultMultiplier?: unknown } } | undefined;
      const sound = payload.config.sound?.battle as { volume?: { default?: unknown } } | undefined;
      if (typeof battlefield?.movement?.defaultMultiplier !== "number" || typeof sound?.volume?.default !== "number") {
        throw new Error("Saved configuration did not contain live movement and sound settings.");
      }
      applyGlobalSettingsLive({
        movementSpeedMultiplier: battlefield.movement.defaultMultiplier,
        battleSoundVolume: sound.volume.default,
      });
    } catch (error) {
      globalSettingsError.textContent = error instanceof Error ? error.message : String(error);
      addLog("Global settings YAML was not changed.", "warn");
      return;
    }
    closeGlobalSettings();
    addLog(`YAML settings saved. Live movement ${globalMovementSpeedMultiplier.toFixed(1)}×, sound ${globalBattleSoundVolume.toFixed(1)}×.`, "good");
  };
  btnOpenGlobalSettings.addEventListener("click", openGlobalSettings);
  btnCancelGlobalSettings.addEventListener("click", closeGlobalSettings);
  btnResetGlobalSettings.addEventListener("click", () => {
    globalSettingsError.textContent = "";
    globalSettingsConfig = null;
    globalSettingsDescriptions = null;
    renderGlobalSettings();
    void loadGlobalSettingsForm().catch((error) => {
      globalSettingsError.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  btnSaveGlobalSettings.addEventListener("click", () => {
    void saveGlobalSettings();
  });
  globalSettingsOverlay.addEventListener("click", (event) => {
    if (event.target === globalSettingsOverlay) closeGlobalSettings();
  });
  globalSettingsOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeGlobalSettings();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void saveGlobalSettings();
  });

  selectedInfo.addEventListener("click", (event) => {
    if (!isEditorScreen()) {
      return;
    }
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button");
    if (!button) {
      return;
    }
    if (isPartEditorScreen()) {
      return;
    }
    if (!isTemplateEditorScreen()) {
      return;
    }
    if (button.id === "editorLayerStructureRight") {
      editorLayer = "structure";
    } else if (button.id === "editorLayerFunctionalRight") {
      editorLayer = "functional";
    } else if (button.id === "editorLayerDisplayRight") {
      editorLayer = "display";
    } else {
      return;
    }
    hideEditorTooltip();
    ensureEditorSelectionForLayer();
    renderPanels();
  });

  selectedInfo.addEventListener("change", (event) => {
    if (!isEditorScreen()) {
      return;
    }
    const target = event.target as HTMLElement;
    if (isPartEditorScreen()) {
      if (target instanceof HTMLSelectElement && target.id === "partToolRight") {
        partDesignerTool = target.value as PartDesignerTool;
        updateWeaponHud();
        updateSelectedInfo();
        return;
      }
      if (!(target instanceof HTMLInputElement)) {
        return;
      }
      if (partDesignerSelectedSlot === null) {
        return;
      }
      const slotIndex = partDesignerSelectedSlot;
      const slot = ensurePartDesignerSlot(slotIndex);
      const checked = target.checked;
      if (target.id === "partBoxOccupiesStructure") {
        slot.occupiesStructureSpace = checked;
        if (checked) {
          slot.isAttachPoint = false;
          slot.needsStructureBehind = false;
        } else if (!slot.occupiesFunctionalSpace && !slot.isAttachPoint) {
          slot.occupiesFunctionalSpace = true;
          slot.needsStructureBehind = true;
        }
      } else if (target.id === "partBoxOccupiesFunctional") {
        slot.occupiesFunctionalSpace = checked;
        if (checked) {
          slot.isAttachPoint = false;
        } else if (!slot.occupiesStructureSpace && !slot.isAttachPoint) {
          slot.needsStructureBehind = false;
        }
      } else if (target.id === "partBoxNeedsStructureBehind") {
        slot.needsStructureBehind = checked && !slot.isAttachPoint && !slot.occupiesStructureSpace && slot.occupiesFunctionalSpace;
      } else if (target.id === "partBoxTakeDamage") {
        slot.takesDamage = checked;
      } else if (target.id === "partBoxAttachPoint") {
        slot.isAttachPoint = checked;
        if (checked) {
          slot.occupiesStructureSpace = false;
          slot.occupiesFunctionalSpace = false;
          slot.needsStructureBehind = false;
        } else if (!slot.occupiesStructureSpace && !slot.occupiesFunctionalSpace) {
          slot.occupiesStructureSpace = partDesignerDraft.layer === "structure";
          slot.occupiesFunctionalSpace = partDesignerDraft.layer !== "structure";
          slot.needsStructureBehind = partDesignerDraft.layer !== "structure";
        }
      } else if (target.id === "partBoxAnchor") {
        if (checked) {
          partDesignerAnchorSlot = slotIndex;
        } else if (partDesignerAnchorSlot === slotIndex) {
          partDesignerAnchorSlot = null;
        }
      } else if (target.id === "partBoxShootingPoint") {
        if (checked) {
          for (let i = 0; i < partDesignerSlots.length; i += 1) {
            const existing = partDesignerSlots[i];
            if (!existing || i === slotIndex) {
              continue;
            }
            existing.isShootingPoint = false;
            partDesignerSlots[i] = existing;
          }
        }
        slot.isShootingPoint = checked;
      } else {
        return;
      }
      partDesignerSlots[slotIndex] = slot;
      setPartDesignerBrushFromSlot(slot);
      recalcPartDraftFromSlots();
      renderPanels();
      return;
    }
    if (!isTemplateEditorScreen()) {
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "editorStructureColor") {
      if (/^#[0-9a-fA-F]{6}$/.test(target.value)) {
        editorStructureColor = target.value;
        drawEditorCanvas();
      }
      return;
    }
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }
    if (target.id === "editorGridCols") {
      const value = Number.parseInt(target.value, 10);
      if (Number.isFinite(value)) {
        resizeEditorGrid(value, editorGridRows);
      }
      renderPanels();
      return;
    }
    if (target.id === "editorGridRows") {
      const value = Number.parseInt(target.value, 10);
      if (Number.isFinite(value)) {
        resizeEditorGrid(editorGridCols, value);
      }
      renderPanels();
    }
  });

  selectedInfo.addEventListener("mouseover", (event) => {
    if (!isTemplateEditorScreen()) {
      return;
    }
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
    if (!isTemplateEditorScreen()) {
      return;
    }
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
    if (!isTemplateEditorScreen()) {
      return;
    }
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
    if (editorLayer === "display") {
      editorSelection = value;
    } else {
      const numeric = Number.parseInt(value, 10);
      editorSelection = Number.isInteger(numeric) ? numeric : value;
      if (editorLayer === "structure" && typeof editorSelection === "number") {
        editorStructureColor = getStructurePartStats(editorSelection).color;
      }
    }
    hideEditorTooltip();
    ensureEditorSelectionForLayer();
    renderPanels();
  };

  selectedInfo.addEventListener("pointerdown", (event) => {
    if (!isTemplateEditorScreen()) {
      return;
    }
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
      debugPartHpOverlay = false;
      battle.setDebugDrawEnabled(false);
      battle.setDebugTargetLineEnabled(false);
      battle.setDisplayLayerEnabled(true);
      battle.setDebugPartHpEnabled(false);
      return;
    }
    debugUnlimitedResources = debugResourcesChk.checked;
    debugVisual = debugVisualChk.checked;
    debugTargetLines = debugTargetLineChk.checked;
    debugPartHpOverlay = debugPartHpChk.checked;
    syncDebugServerState();
    battle.setDebugDrawEnabled(isDebugVisual());
    battle.setDebugTargetLineEnabled(isDebugTargetLines());
    battle.setDisplayLayerEnabled(debugDisplayLayer);
    battle.setDebugPartHpEnabled(debugPartHpOverlay);
    addLog(
      `Debug options: resources=${debugUnlimitedResources ? "on" : "off"}, visual=${debugVisual ? "on" : "off"}, targetLines=${debugTargetLines ? "on" : "off"}, paint=always-on, partHp=${debugPartHpOverlay ? "on" : "off"}`,
      "warn",
    );
    renderPanels();
  };

  debugResourcesChk.addEventListener("change", applyDebugFlags);
  debugVisualChk.addEventListener("change", applyDebugFlags);
  debugTargetLineChk.addEventListener("change", applyDebugFlags);
  debugPartHpChk.addEventListener("change", applyDebugFlags);
  btnOpenPartDesigner.addEventListener("click", () => {
    setScreen("partEditor");
    const selected = parts.find((part) => part.id === partDesignerSelectedId);
    if (selected) {
      partDesignerSelectedId = selected.id;
      partDesignerOpenedPartId = selected.id;
      loadPartIntoDesignerSlots(selected);
    }
    renderPanels();
  });
  debugResourcesChk.checked = replayMode ? false : true;
  debugVisualChk.checked = replayMode ? false : true;
  debugTargetLineChk.checked = replayMode ? false : true;
  debugPartHpChk.checked = false;
  applyDebugFlags();

  window.addEventListener("keydown", (event) => {
    if (isTypingInFormField(event.target)) {
      return;
    }

    if (isEditorScreen()) {
      if (event.key === "q" || event.key === "Q") {
        if (isTemplateEditorScreen() && !isCurrentEditorSelectionRotatable()) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        editorWeaponRotateQuarter = ((editorWeaponRotateQuarter + 3) % 4) as 0 | 1 | 2 | 3;
        renderPanels();
        return;
      }
      if (event.key === "e" || event.key === "E") {
        if (isTemplateEditorScreen() && !isCurrentEditorSelectionRotatable()) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        editorWeaponRotateQuarter = ((editorWeaponRotateQuarter + 1) % 4) as 0 | 1 | 2 | 3;
        renderPanels();
        return;
      }
    }

    if (!isBattleScreen()) {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      panBattleViewBy(44, 0);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      panBattleViewBy(-44, 0);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      panBattleViewBy(0, 44);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      panBattleViewBy(0, -44);
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
          battle.toggleControlledWeaponManualControl(slot);
        }
        renderPanels();
      }
    }
  });

  window.addEventListener("keyup", (event) => {
    if (isTypingInFormField(event.target) || !isBattleScreen()) {
      return;
    }
    if (event.key === "a" || event.key === "A") keys.a = false;
    if (event.key === "d" || event.key === "D") keys.d = false;
    if (event.key === "w" || event.key === "W") keys.w = false;
    if (event.key === "s" || event.key === "S") keys.s = false;
  });

  const getPointerOnCanvas = (
    event: MouseEvent,
    targetCanvas: HTMLCanvasElement,
  ): { x: number; y: number; rect: DOMRect } => {
    const rect = targetCanvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (targetCanvas.width / Math.max(1, rect.width));
    const y = (event.clientY - rect.top) * (targetCanvas.height / Math.max(1, rect.height));
    return { x, y, rect };
  };

  const getPointerOnBattlefield = (event: MouseEvent): { x: number; y: number } => {
    const rect = canvasViewport.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - battleViewOffsetX) / Math.max(0.0001, battleViewScale),
      y: (event.clientY - rect.top - battleViewOffsetY) / Math.max(0.0001, battleViewScale),
    };
  };

  canvasViewport.addEventListener("mousedown", (event) => {
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    if (isEditorScreen()) {
      const targetCanvas = activeEditorCanvas();
      const { x, y } = getPointerOnCanvas(event, targetCanvas);
      editorHoverMouseX = x;
      editorHoverMouseY = y;
      editorHoverActive = true;
      if (event.button === 0) {
        editorRightClickDeletePending = false;
        applyEditorCellAction(x, y);
        renderPanels();
        return;
      }
      event.preventDefault();
      editorDragActive = true;
      editorDragMoved = false;
      editorDragStartClientX = event.clientX;
      editorDragStartClientY = event.clientY;
      editorDragLastClientX = event.clientX;
      editorDragLastClientY = event.clientY;
      editorRightClickDeletePending = true;
      editorRightClickDeleteMouseX = x;
      editorRightClickDeleteMouseY = y;
      return;
    }
    if (isBattleScreen() && event.button === 2) {
      event.preventDefault();
      battleViewDragActive = true;
      battleViewDragMoved = false;
      battleViewDragStartClientX = event.clientX;
      battleViewDragStartClientY = event.clientY;
      battleViewDragLastClientX = event.clientX;
      battleViewDragLastClientY = event.clientY;
      canvasViewport.style.cursor = "grabbing";
      return;
    }
    const { x, y } = getPointerOnBattlefield(event);
    battleViewFollowSelection = true;
    battle.handleLeftPointerDown(x, y);
    renderPanels();
  });

  canvasViewport.addEventListener("contextmenu", (event) => {
    if (isEditorScreen() || isBattleScreen()) {
      event.preventDefault();
    }
  });

  window.addEventListener("mouseup", () => {
    if (isEditorScreen() && editorDragActive) {
      const shouldDeleteCell = !editorDragMoved && editorRightClickDeletePending;
      editorDragActive = false;
      editorDragMoved = false;
      editorRightClickDeletePending = false;
      if (shouldDeleteCell) {
        applyEditorCellAction(editorRightClickDeleteMouseX, editorRightClickDeleteMouseY, true);
        renderPanels();
      }
    }
    if (battleViewDragActive) {
      if (battleViewDragMoved) {
        battleViewFollowSelection = false;
      }
      if (!battleViewDragMoved && isBattleScreen()) {
        battle.clearControlSelection();
        renderPanels();
      }
      battleViewDragActive = false;
      battleViewDragMoved = false;
      canvasViewport.style.cursor = isBattleScreen() ? "grab" : "default";
    }
    battle.handlePointerUp();
  });

  canvasViewport.addEventListener("mouseleave", () => {
    if (isEditorScreen()) {
      editorDragActive = false;
      editorDragMoved = false;
      editorRightClickDeletePending = false;
      editorHoverActive = false;
    }
    battle.handlePointerUp();
  });

  canvasViewport.addEventListener("mousemove", (event) => {
    if (isEditorScreen()) {
      const targetCanvas = activeEditorCanvas();
      const pointer = getPointerOnCanvas(event, targetCanvas);
      editorHoverMouseX = pointer.x;
      editorHoverMouseY = pointer.y;
      editorHoverActive = !editorDragActive;
      if (editorDragActive) {
        const dx = event.clientX - editorDragLastClientX;
        const dy = event.clientY - editorDragLastClientY;
        editorDragLastClientX = event.clientX;
        editorDragLastClientY = event.clientY;
        const movedDistance = Math.hypot(event.clientX - editorDragStartClientX, event.clientY - editorDragStartClientY);
        if (movedDistance > 4) {
          editorDragMoved = true;
          editorRightClickDeletePending = false;
        }
        if (editorDragMoved) {
          const drawCanvas = activeEditorCanvas();
          const rect = drawCanvas.getBoundingClientRect();
          editorGridPanX += dx * (drawCanvas.width / Math.max(1, rect.width));
          editorGridPanY += dy * (drawCanvas.height / Math.max(1, rect.height));
        }
      }
      return;
    }
    if (battleViewDragActive) {
      return;
    }
    const { x, y } = getPointerOnBattlefield(event);
    battle.setAim(x, y);
  });

  window.addEventListener("mousemove", (event) => {
    if (!battleViewDragActive || !isBattleScreen()) {
      return;
    }
    const dx = event.clientX - battleViewDragLastClientX;
    const dy = event.clientY - battleViewDragLastClientY;
    battleViewDragLastClientX = event.clientX;
    battleViewDragLastClientY = event.clientY;
    if (Math.hypot(event.clientX - battleViewDragStartClientX, event.clientY - battleViewDragStartClientY) > 3) {
      battleViewDragMoved = true;
    }
    panBattleViewBy(dx, dy);
  });

  window.addEventListener("resize", () => {
    applyBattleViewTransform();
  });

  canvasViewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const scaleFactor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    if (isBattleScreen()) {
      adjustBattleViewScaleAtClientPoint(battleViewScale * scaleFactor, event.clientX, event.clientY);
      return;
    }
    if (isEditorScreen()) {
      adjustEditorViewScaleAtClientPoint(editorViewScale * scaleFactor, event.clientX, event.clientY);
    }
  }, { passive: false });

  loadTemplateIntoEditorSlots(editorDraft);
  partDesignerSelectedId = partDesignerDraft.id;
  partDesignerOpenedPartId = null;
  loadPartIntoDesignerSlots(partDesignerDraft);
  ensureEditorSelectionForLayer();
  setScreen("base");
  applyBattleViewTransform();
  addLog("Campaign initialized");
  renderPanels();
  void refreshPartsFromStore()
    .then(async () => {
      const selectedPart = parts.find((part) => part.id === partDesignerSelectedId);
      if (selectedPart) {
        partDesignerSelectedId = selectedPart.id;
        partDesignerOpenedPartId = selectedPart.id;
        loadPartIntoDesignerSlots(selectedPart);
      }
      await refreshTemplatesFromStore();
      await importCraftArenaSeed();
      addLog("Loaded part catalog and object templates", "good");
      renderPanels();
    })
    .catch(() => {
      addLog("Failed to load part/template data from store", "bad");
      renderPanels();
    });

  let panelBucket = -1;
  let strategicPanelBucket = -1;
  let loopUpdateBusy = false;
  const testArenaLastBlockedByUnit = new Map<string, { reason: string; atMs: number }>();

  const logTestArenaFireBlockedReasons = (): void => {
    const state = battle.getState();
    if (!(state.active && state.nodeId === testArenaNode.id)) {
      if (testArenaLastBlockedByUnit.size > 0) {
        testArenaLastBlockedByUnit.clear();
      }
      return;
    }
    const nowMs = Date.now();
    for (const unit of state.units) {
      if (!unit.alive || !canOperate(unit)) {
        continue;
      }
      const reason = unit.aiDebugFireBlockReason;
      if (!reason || reason === "none") {
        continue;
      }
      const key = unit.id;
      const prev = testArenaLastBlockedByUnit.get(key);
      if (prev && prev.reason === reason && (nowMs - prev.atMs) < 1500) {
        continue;
      }
      testArenaLastBlockedByUnit.set(key, { reason, atMs: nowMs });
      addLog(`[AI block] ${unit.side}:${unit.name} reason=${reason} tree=${unit.aiDebugDecisionPath || "n/a"}`, "warn");
    }
  };

  let loopUpdate: (dt: number) => void | Promise<void> = async (dt: number): Promise<void> => {
    if (!running) {
      return;
    }
    if (!replayMode) {
      const strategic = campaign.update(dt, mapNodes);
      if (!isUnlimitedResources()) gas += strategic.gasIncome;
      for (const job of strategic.completed) {
        if (job.type === "building") {
          const kind = job.target as BuildingKind;
          addLog(`Construction complete: ${BUILDING_CATALOG[kind].name}`, "good");
        } else {
          const kind = job.target as ResearchKind;
          completeResearch(kind);
          addLog(`Research complete: ${RESEARCH_CATALOG[kind].name}`, "good");
        }
      }
      base.refineries = campaign.getBuildingCount("refinery");
      base.workshops = campaign.getBuildingCount("workshop");
      base.labs = campaign.getBuildingCount("research-lab");
      base.areaLevel = 1;
    }

    const state = battle.getState();
    const isCampaignBattle = state.active && state.nodeId !== testArenaNode.id;
    if (isCampaignBattle) {
      for (let i = deploymentQueue.length - 1; i >= 0; i -= 1) {
        const order = deploymentQueue[i];
        if (!order) continue;
        order.remainingSeconds -= dt;
        if (order.remainingSeconds > 0) continue;
        const spawned = battle.arenaDeploy("player", order.templateId, { chargeGas: false, deploymentGasCost: order.gasCost, ignoreCap: true });
        if (spawned) {
          const template = templates.find((entry) => entry.id === order.templateId);
          addLog(`${template?.name ?? "Craft"} arrived from ${order.sourceName}`, "good");
          deploymentQueue.splice(i, 1);
        } else {
          order.remainingSeconds = 1;
        }
      }

      autonomousSpawnCooldown = Math.max(0, autonomousSpawnCooldown - dt);
      if (screen !== "battle" && autonomousSpawnCooldown <= 0 && defaultAutoTemplateIds.length > 0) {
        const activeFriendly = state.units.filter((unit) => unit.type !== "base" && unit.side === "player" && unit.alive).length;
        if (activeFriendly + deploymentQueue.length < campaign.getDeliveryCapacity()) {
          const affordable = defaultAutoTemplateIds.filter((id) => {
            const template = templates.find((entry) => entry.id === id);
            if (!template || !state.nodeId) return false;
            const quote = quoteBattleLogistics(mapNodes, state.nodeId, getTemplateLogisticsSpeed(template), id);
            return isUnlimitedResources() || gas >= Math.ceil(template.gasCost * quote.gasCostMultiplier);
          });
          const chosen = affordable[Math.floor(Math.random() * affordable.length)];
          if (chosen !== undefined && queueDeployment(chosen, true)) autonomousSpawnCooldown = 4;
        }
      }
    }

    const shouldUpdateBattle = state.active && (state.nodeId !== testArenaNode.id || isBattleScreen());
    if (shouldUpdateBattle) {
      const noKeys: KeyState = { a: false, d: false, w: false, s: false, space: false };
      const battleInput: KeyState = isBattleScreen() ? { ...keys, ...pollGamepadInput() } : noKeys;
      battle.update(dt, battleInput);
      logTestArenaFireBlockedReasons();
      if (isBattleScreen()) followSelectedUnitWithCamera();
    }
  };

  const loop = new GameLoop(
    (dt) => {
      if (loopUpdateBusy) {
        return;
      }
      loopUpdateBusy = true;
      void Promise.resolve(loopUpdate(dt)).finally(() => {
        loopUpdateBusy = false;
      });
    },
    (_alpha, now) => {
      if (isEditorScreen()) {
        drawEditorCanvas();
      } else {
        // Phaser renders the battle on its own scene clock. Editors remain Canvas-based tools.
        void phaserBattleRenderer;
      }
      const nextBucket = Math.floor(now * 4);
      if (nextBucket !== panelBucket) {
        panelBucket = nextBucket;
        updateMetaBar();
        updateBattleOpsInfo();
        if (isEditorScreen()) {
          // Avoid remounting editor palette DOM on a timer, which causes visible flicker.
          return;
        }
        updateSelectedInfo();
        updateWeaponHud();
      }
      const nextStrategicBucket = Math.floor(now);
      if (nextStrategicBucket !== strategicPanelBucket && (screen === "base" || screen === "map" || screen === "battle")) {
        strategicPanelBucket = nextStrategicBucket;
        renderPanels();
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
    // Ensure we use latest parts/templates before starting replay.
    void refreshPartsFromStore().then(async () => {
      await refreshTemplatesFromStore();
      startArenaReplay();
    });
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
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
