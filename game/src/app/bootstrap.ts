import { armyCap } from "../config/balance/commander.ts";
import { BATTLEFIELD_HEIGHT, BATTLEFIELD_WIDTH, DEFAULT_GROUND_HEIGHT_RATIO, BATTLE_SALVAGE_REFUND_FACTOR } from "../config/balance/battlefield.ts";
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
import type { BattleAiController } from "../gameplay/battle/battle-session.ts";
import { createBaselineCompositeAiController } from "../ai/composite/baseline-modules.ts";
import {
  cloneTemplate,
  computeTemplateGasCost,
  deleteDefaultTemplateFromStore,
  deleteUserTemplateFromStore,
  fetchDefaultTemplatesFromStore,
  fetchUserTemplatesFromStore,
  mergeTemplates,
  saveDefaultTemplateToStore,
  saveUserTemplateToStore,
  validateTemplateDetailed,
} from "./template-store.ts";
import {
  clonePartDefinition,
  deleteDefaultPartFromStore,
  deleteUserPartFromStore,
  fetchDefaultPartsFromStore,
  fetchUserPartsFromStore,
  getPartFootprintOffsets,
  mergePartCatalogs,
  normalizePartAttachmentRotate,
  resolvePartDefinitionForAttachment,
  saveDefaultPartToStore,
  validatePartDefinitionDetailed,
} from "./part-store.ts";
import {
  createDefaultPartDraft,
  getPartMetadataDefaultsForLayer as getConfiguredPartMetadataDefaultsForLayer,
  getPartPropertyDefaults,
  getStructureMaterialDefaults,
} from "./part-default-config.ts";
import { makeCompositeAiController, type CompositeModuleSpec } from "../../../arena/src/ai/composite-controller.ts";
import type { MatchAiSpec } from "../../../arena/src/match/match-types.ts";
import type {
  ComponentId,
  DisplayAttachmentTemplate,
  GameBase,
  KeyState,
  MapNode,
  MaterialId,
  MaterialStats,
  PartDefinition,
  ScreenMode,
  TechState,
  UnitTemplate,
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
        <div class="title">Modular Army 2D - MVP</div>
        <details id="debugMenu" class="debug-menu">
          <summary>Debug Options</summary>
          <label><input id="debugResourcesChk" type="checkbox" /> Unlimited Resources</label>
          <label><input id="debugVisualChk" type="checkbox" /> Draw Path + Hitbox</label>
          <label><input id="debugTargetLineChk" type="checkbox" /> Draw Target Lines</label>
          <label><input id="debugDisplayLayerChk" type="checkbox" /> Show Display Layer</label>
          <label><input id="debugPartHpChk" type="checkbox" /> Show Part HP Overlay</label>
          <button id="btnOpenPartDesigner" type="button">Part Designer</button>
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
            <div class="tabs">
              <button id="tabBase">Base</button>
              <button id="tabMap">Map</button>
              <button id="tabBattle">Battle</button>
              <button id="tabTestArena">Test Arena</button>
              <button id="tabLeaderboard">Leaderboard</button>
              <button id="tabTemplateEditor">Template Editor</button>
              <button id="tabPartEditor">Part Editor</button>
            </div>
          </div>

          <div id="basePanel" class="card panel"></div>
          <div id="mapPanel" class="card panel hidden"></div>
          <div id="battlePanel" class="card panel hidden"></div>
          <div id="testArenaPanel" class="card panel hidden"></div>
          <div id="leaderboardPanel" class="card panel hidden"></div>
          <div id="editorPanel" class="card panel hidden"></div>
        </section>

        <section class="center-panel card">
          <div id="battleCanvasViewport" class="battle-canvas-viewport">
            <canvas id="battleCanvas" width="${BATTLEFIELD_WIDTH}" height="${BATTLEFIELD_HEIGHT}"></canvas>
            <canvas id="templateEditorCanvas" class="hidden"></canvas>
            <canvas id="partEditorCanvas" class="hidden"></canvas>
          </div>
          <div id="leaderboardCenter" class="panel hidden"></div>
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
              - Hold left click: fire all manually controlled weapons<br />
              - Arrow keys: pan battlefield viewport<br />
              - Right-click drag: pan viewport (battle/editor)<br />
              - Mouse wheel: zoom viewport (battle/editor, wheel up=in, down=out)<br />
              - WASD: move selected unit<br />
              - Space: flip selected unit direction<br />
              - 1..9: toggle manual control for that weapon slot<br />
              - Shift+1..9: toggle auto fire for that slot<br />
              - Manual-controlled slots temporarily suppress auto fire<br />
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
  const testArenaPanel = getElement<HTMLDivElement>("#testArenaPanel");
  const leaderboardPanel = getElement<HTMLDivElement>("#leaderboardPanel");
  const leaderboardCenter = getElement<HTMLDivElement>("#leaderboardCenter");
  const editorPanel = getElement<HTMLDivElement>("#editorPanel");
  const selectedInfo = getElement<HTMLDivElement>("#selectedInfo");
  const weaponHud = getElement<HTMLDivElement>("#weaponHud");
  const logBox = getElement<HTMLDivElement>("#logBox");
  const debugResourcesChk = getElement<HTMLInputElement>("#debugResourcesChk");
  const debugVisualChk = getElement<HTMLInputElement>("#debugVisualChk");
  const debugTargetLineChk = getElement<HTMLInputElement>("#debugTargetLineChk");
  const debugDisplayLayerChk = getElement<HTMLInputElement>("#debugDisplayLayerChk");
  const debugPartHpChk = getElement<HTMLInputElement>("#debugPartHpChk");
  const btnOpenPartDesigner = getElement<HTMLButtonElement>("#btnOpenPartDesigner");
  const debugMenu = getElement<HTMLElement>("#debugMenu");
  const metaBar = getElement<HTMLDivElement>("#metaBar");
  const arenaReplayStats = getElement<HTMLDivElement>("#arenaReplayStats");
  const timeScale = getElement<HTMLInputElement>("#timeScale");
  const timeScaleLabel = getElement<HTMLSpanElement>("#timeScaleLabel");
  const canvasViewport = getElement<HTMLDivElement>("#battleCanvasViewport");
  const canvas = getElement<HTMLCanvasElement>("#battleCanvas");
  const templateEditorCanvas = getElement<HTMLCanvasElement>("#templateEditorCanvas");
  const partEditorCanvas = getElement<HTMLCanvasElement>("#partEditorCanvas");

  // Keep battle simulation dimensions deterministic in all runtime modes.
  canvas.width = BATTLEFIELD_WIDTH;
  canvas.height = BATTLEFIELD_HEIGHT;
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;

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
    leaderboard: getElement<HTMLButtonElement>("#tabLeaderboard"),
    templateEditor: getElement<HTMLButtonElement>("#tabTemplateEditor"),
    partEditor: getElement<HTMLButtonElement>("#tabPartEditor"),
  };

  const templates: UnitTemplate[] = createInitialTemplates();
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
  let screen: ScreenMode = "base";
  const testArenaNode: MapNode = {
    id: "test-arena",
    name: "Test Arena",
    owner: "enemy",
    garrison: false,
    reward: 0,
    defense: 1.1,
    testEnemyMinActive: 2,
    testEnemyInfiniteGas: true,
    testBaseHpOverride: 1000000000,
  };
  let testArenaEnemyCount = 2;
  let testArenaBattlefieldWidth = BATTLEFIELD_WIDTH;
  let testArenaBattlefieldHeight = BATTLEFIELD_HEIGHT;
  let testArenaGroundHeight = Math.floor(BATTLEFIELD_HEIGHT * DEFAULT_GROUND_HEIGHT_RATIO);
  let testArenaSpawnTemplateIds: string[] = templates.map((template) => template.id);
  let testArenaManualSpawnTemplateId: string | null = templates[0]?.id ?? null;
  let testArenaSpawnTemplateDropdownOpen = false;
  let testArenaInvinciblePlayer = false;
  type TestArenaAiPreset =
    | "baseline"
    | "composite-baseline"
    | "composite-decision-default"
    | "component-config";
  type TestArenaAiModuleKind = "target" | "movement" | "shoot";
  type TestArenaSide = "player" | "enemy";
  type TestArenaPanelSection = "unit" | "ai" | "ui";
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
    wins?: number;
    spec?: MatchAiSpec;
    mtimeMs: number;
  };
  let testArenaPlayerAiPreset: TestArenaAiPreset = "component-config";
  let testArenaEnemyAiPreset: TestArenaAiPreset = "component-config";
  let latestCompositeSpec: MatchAiSpec | null = null;
  let testArenaCompositeModelOptions: TestArenaCompositeModelOption[] = [
    { id: "custom-components", label: "Custom components (target/movement/shoot)" },
    {
      id: "builtin-baseline-composite",
      label: "builtin: baseline composite",
      spec: {
        familyId: "composite",
        params: {},
        composite: {
          target: { familyId: "baseline-target", params: {} },
          movement: { familyId: "baseline-movement", params: {} },
          shoot: { familyId: "baseline-shoot", params: {} },
        },
      },
    },
    {
      id: "builtin-dt-default-composite",
      label: "builtin: dt composite (default params)",
      spec: {
        familyId: "composite",
        params: {},
        composite: {
          target: { familyId: "dt-target", params: {} },
          movement: { familyId: "dt-movement", params: {} },
          shoot: { familyId: "dt-shoot", params: {} },
        },
      },
    },
  ];
  let testArenaCompositeModelSelections: Record<TestArenaSide, string> = {
    player: "custom-components",
    enemy: "custom-components",
  };
  const defaultAiOptions: Record<TestArenaAiModuleKind, TestArenaAiOption[]> = {
    target: [
      { id: "baseline-target", label: "builtin: baseline-target", spec: { familyId: "baseline-target", params: {} } },
      { id: "dt-target-default", label: "builtin: dt-target (default)", spec: { familyId: "dt-target", params: {} } },
    ],
    movement: [
      { id: "baseline-movement", label: "builtin: baseline-movement", spec: { familyId: "baseline-movement", params: {} } },
      { id: "dt-movement-default", label: "builtin: dt-movement (default)", spec: { familyId: "dt-movement", params: {} } },
    ],
    shoot: [
      { id: "baseline-shoot", label: "builtin: baseline-shoot", spec: { familyId: "baseline-shoot", params: {} } },
      { id: "dt-shoot-default", label: "builtin: dt-shoot (default)", spec: { familyId: "dt-shoot", params: {} } },
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
  let testArenaLeaderboardCompeteMode: "random-pair" | "unranked-vs-random" | "manual-pair" = "random-pair";
  let testArenaLeaderboardCompeteRuns = 100;
  let testArenaLeaderboardCompeteBusy = false;
  let testArenaLeaderboardCompeteStatus = "";
  let testArenaLeaderboardManualPairA = "";
  let testArenaLeaderboardManualPairB = "";
  let testArenaPanelSections: Record<TestArenaPanelSection, boolean> = {
    unit: true,
    ai: false,
    ui: false,
  };
  const isTemplateEditorScreen = (): boolean => screen === "templateEditor";
  const isPartEditorScreen = (): boolean => screen === "partEditor";
  const isEditorScreen = (): boolean => isTemplateEditorScreen() || isPartEditorScreen();
  const isBattleScreen = (): boolean => screen === "battle" || screen === "testArena";
  let running = true;
  let round = 1;
  let gas = replay?.spec.playerGas ?? 250;
  let commanderSkill = 1;
  let pendingOccupation: string | null = null;
  let debugUnlimitedResources = replayMode ? false : true;
  let debugVisual = replayMode ? false : true;
  let debugTargetLines = replayMode ? false : true;
  let debugDisplayLayer = false;
  let debugPartHpOverlay = false;
  let debugServerEnabled = false;
  const EDITOR_GRID_MAX_COLS = 10;
  const EDITOR_GRID_MAX_ROWS = 10;
  const EDITOR_GRID_MAX_SIZE = EDITOR_GRID_MAX_COLS * EDITOR_GRID_MAX_ROWS;
  const EDITOR_DISPLAY_KINDS: DisplayAttachmentTemplate["kind"][] = ["panel", "stripe", "glass"];
  type EditorFunctionalSlot = {
    component: ComponentId;
    partId?: string;
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
  type PartOpenFilter = "all" | "structure" | "control" | "engine" | "weapon" | "loader" | "ammo";
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
  let editorSelection = "basic";
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
  let battleViewOffsetX = 0;
  let battleViewOffsetY = 0;
  let battleViewScale = 1;
  let battleViewDragActive = false;
  let battleViewDragMoved = false;
  let battleViewDragStartClientX = 0;
  let battleViewDragStartClientY = 0;
  let battleViewDragLastClientX = 0;
  let battleViewDragLastClientY = 0;
  let editorStructureSlots: Array<MaterialId | null> = new Array<MaterialId | null>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorFunctionalSlots: EditorFunctionalSlot[] = new Array<EditorFunctionalSlot>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorDisplaySlots: Array<DisplayAttachmentTemplate["kind"] | null> = new Array<DisplayAttachmentTemplate["kind"] | null>(EDITOR_GRID_MAX_SIZE).fill(null);
  let editorTemplateDialogOpen = false;
  let editorTemplateDialogSelectedId: string | null = null;
  let partDesignerDialogOpen = false;
  let partDesignerSelectedId: string | null = null;
  let partDesignerOpenFilter: PartOpenFilter = "all";
  let partDesignerTool: PartDesignerTool = "select";
  const STRUCTURE_LAYER_BASE_OPTION = "__structure_layer__";
  let partDesignerDraft: PartDefinition = (() => {
    const draft = clonePartDefinition(createDefaultPartDraft("custom-part", "Custom Part"));
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
  let partDesignerRequireStructureBelowAnchor = false;
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
    id: "custom-1",
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
  const getCanvasDisplayWidth = (): number => Math.max(1, canvas.clientWidth || BATTLEFIELD_WIDTH);
  const getCanvasDisplayHeight = (): number => Math.max(1, canvas.clientHeight || BATTLEFIELD_HEIGHT);
  const toDisplayX = (worldX: number): number => worldX * (getCanvasDisplayWidth() / Math.max(1, canvas.width));
  const toDisplayY = (worldY: number): number => worldY * (getCanvasDisplayHeight() / Math.max(1, canvas.height));

  const clampBattleViewOffsets = (): void => {
    const viewportWidth = Math.max(0, canvasViewport.clientWidth);
    const viewportHeight = Math.max(0, canvasViewport.clientHeight);
    const scaledCanvasWidth = getCanvasDisplayWidth() * battleViewScale;
    const scaledCanvasHeight = getCanvasDisplayHeight() * battleViewScale;
    const VIEW_MARGIN = 80;

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
      canvas.style.transform = "translate(0px, 0px) scale(1)";
      return;
    }
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    clampBattleViewOffsets();
    canvas.style.transform = `translate(${battleViewOffsetX}px, ${battleViewOffsetY}px) scale(${battleViewScale})`;
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
    const clampedScale = Math.max(0.45, Math.min(2.4, nextScale));
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
  const normalizeTestArenaBattlefieldWidth = (value: number): number => Math.max(640, Math.min(4096, Math.floor(value)));
  const normalizeTestArenaBattlefieldHeight = (value: number): number => Math.max(360, Math.min(2160, Math.floor(value)));
  const normalizeTestArenaZoomPercent = (value: number): number => Math.max(45, Math.min(240, Math.round(value)));
  const normalizeTestArenaGroundHeight = (value: number): number => Math.max(80, Math.min(Math.max(120, testArenaBattlefieldHeight - 40), Math.floor(value)));
  const normalizeTestArenaSpawnTemplateIds = (candidateIds: ReadonlyArray<string>): string[] => {
    const validIds = new Set<string>(templates.map((template) => template.id));
    const normalized: string[] = [];
    for (const id of candidateIds) {
      if (!validIds.has(id)) {
        continue;
      }
      if (normalized.includes(id)) {
        continue;
      }
      normalized.push(id);
    }
    return normalized;
  };
  const setTestArenaSpawnTemplateIds = (candidateIds: ReadonlyArray<string>): string[] => {
    testArenaSpawnTemplateIds = normalizeTestArenaSpawnTemplateIds(candidateIds);
    return testArenaSpawnTemplateIds;
  };
  const getTestArenaSpawnTemplateIds = (): string[] => {
    testArenaSpawnTemplateIds = normalizeTestArenaSpawnTemplateIds(testArenaSpawnTemplateIds);
    return testArenaSpawnTemplateIds;
  };
  const normalizeTestArenaManualSpawnTemplateId = (candidateId: string | null): string | null => {
    if (typeof candidateId === "string" && templates.some((template) => template.id === candidateId)) {
      return candidateId;
    }
    return templates[0]?.id ?? null;
  };
  const setTestArenaManualSpawnTemplateId = (candidateId: string | null): string | null => {
    testArenaManualSpawnTemplateId = normalizeTestArenaManualSpawnTemplateId(candidateId);
    return testArenaManualSpawnTemplateId;
  };
  const getTestArenaManualSpawnTemplateId = (): string | null => {
    testArenaManualSpawnTemplateId = normalizeTestArenaManualSpawnTemplateId(testArenaManualSpawnTemplateId);
    return testArenaManualSpawnTemplateId;
  };
  const syncTestArenaZoomInput = (): void => {
    const zoomInput = getOptionalElement<HTMLInputElement>("#testArenaZoomPercent");
    if (zoomInput) {
      const value = String(Math.round(battleViewScale * 100));
      if (zoomInput.value !== value) {
        zoomInput.value = value;
      }
    }
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
    } catch {
      testArenaLeaderboardEntries = [];
      testArenaLeaderboardManualPairA = "";
      testArenaLeaderboardManualPairB = "";
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
      testArenaCompositeModelOptions.find((entry) => entry.id === "builtin-baseline-composite")
        ?? {
          id: "builtin-baseline-composite",
          label: "builtin: baseline composite",
          spec: {
            familyId: "composite",
            params: {},
            composite: {
              target: { familyId: "baseline-target", params: {} },
              movement: { familyId: "baseline-movement", params: {} },
              shoot: { familyId: "baseline-shoot", params: {} },
            },
          },
        },
      testArenaCompositeModelOptions.find((entry) => entry.id === "builtin-dt-default-composite")
        ?? {
          id: "builtin-dt-default-composite",
          label: "builtin: dt composite (default params)",
          spec: {
            familyId: "composite",
            params: {},
            composite: {
              target: { familyId: "dt-target", params: {} },
              movement: { familyId: "dt-movement", params: {} },
              shoot: { familyId: "dt-shoot", params: {} },
            },
          },
        },
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

  const runLeaderboardCompetition = async (
    mode: "random-pair" | "unranked-vs-random" | "manual-pair",
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
    testArenaLeaderboardCompeteBusy = true;
    const totalRuns = Math.max(1, Math.min(200, Math.floor(runs)));
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
      const parsed = await res.json().catch(() => null) as { completed?: number; reason?: string } | null;
      const completedTotal = Math.max(0, Number(parsed?.completed ?? 0));
      if (!res.ok) {
        testArenaLeaderboardCompeteStatus = `Competition stopped at ${completedTotal}/${totalRuns}: ${parsed?.reason ?? "request failed"}`;
        return;
      }
      await refreshTestArenaLeaderboard();
      await refreshTestArenaCompositeModelOptions();
      if (completedTotal >= totalRuns) {
        testArenaLeaderboardCompeteStatus = `Competition completed: ${completedTotal}/${totalRuns} rounds.`;
      } else if (completedTotal > 0) {
        testArenaLeaderboardCompeteStatus = `Competition partially completed: ${completedTotal}/${totalRuns} rounds.`;
      } else if (!testArenaLeaderboardCompeteStatus.toLowerCase().includes("stopped")) {
        testArenaLeaderboardCompeteStatus = "Competition finished with no completed rounds.";
      }
    } catch {
      testArenaLeaderboardCompeteStatus = "Competition failed due to network or server error.";
    } finally {
      testArenaLeaderboardCompeteBusy = false;
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
        renderPanels();
      },
    },
    templates,
    {
      ...(battleSessionOptions ?? {}),
      partCatalog: battleSessionOptions?.partCatalog
        ? mergePartCatalogs(parts, battleSessionOptions.partCatalog)
        : parts,
    },
  );
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
        round,
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
    battle.setEnemySpawnTemplateFilter(null);
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
    centerBattleViewYOnPlayerBase();
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


  const refreshPartsFromStore = async (): Promise<void> => {
    const defaultParts = await fetchDefaultPartsFromStore();
    const userParts = await fetchUserPartsFromStore();
    const mergedParts = mergePartCatalogs(defaultParts, userParts);
    parts.splice(0, parts.length, ...mergedParts);
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
          if (part.properties?.materialId === materialId) {
            return true;
          }
          return part.id === materialId || part.id === `material-${materialId}`;
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
      return;
    }
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
      const testArenaActive = battle.getState().active && battle.getState().nodeId === testArenaNode.id;
      const showNextRound = !testArenaActive;
      metaBar.innerHTML = `Round: ${round} | Gas: ${gasLabel} | Commander Skill: ${commanderSkill} | Army Cap: ${capLabel}${battleLabel}${showNextRound ? ` <button id="btnNextRound">Next Round</button>` : ""}`;
      if (showNextRound) {
        getOptionalElement<HTMLButtonElement>("#btnNextRound")?.addEventListener("click", () => endRound());
      }
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
    const prev = screen;
    if (isEditorScreenMode(prev)) {
      saveEditorViewForScreen(prev);
    }
    screen = next;
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
    leaderboardPanel.classList.toggle("hidden", next !== "leaderboard");
    leaderboardCenter.classList.toggle("hidden", next !== "leaderboard");
    editorPanel.classList.toggle("hidden", !isEditorScreen());
    tabs.base.classList.toggle("active", next === "base");
    tabs.map.classList.toggle("active", next === "map");
    tabs.battle.classList.toggle("active", next === "battle");
    tabs.testArena.classList.toggle("active", next === "testArena");
    tabs.leaderboard.classList.toggle("active", next === "leaderboard");
    tabs.templateEditor.classList.toggle("active", next === "templateEditor");
    tabs.partEditor.classList.toggle("active", next === "partEditor");
    if (!isEditorScreen()) {
      hideEditorTooltip();
    }
    canvasViewport.classList.toggle("hidden", next === "leaderboard");
    if (!battleViewDragActive) {
      canvasViewport.style.cursor = isBattleScreen() ? "grab" : "default";
    }
    weaponHud.classList.toggle("hidden", next === "leaderboard");
    applyBattleViewTransform();
  };

  const followSelectedUnitWithCamera = (): void => {
    if (!isBattleScreen() || battleViewDragActive) {
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
    const BORDER_MARGIN = 72;
    const screenX = battleViewOffsetX + toDisplayX(tracked.x) * battleViewScale;
    const screenY = battleViewOffsetY + toDisplayY(tracked.y) * battleViewScale;

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

  const centerBattleViewYOnPlayerBase = (): void => {
    if (!isBattleScreen()) {
      return;
    }
    const viewportHeight = canvasViewport.clientHeight;
    if (viewportHeight <= 0) {
      return;
    }
    const state = battle.getState();
    if (!state.active) {
      return;
    }
    const baseCenterY = state.playerBase.y + state.playerBase.h * 0.5;
    if (!Number.isFinite(baseCenterY)) {
      return;
    }
    battleViewOffsetY = viewportHeight * 0.5 - toDisplayY(baseCenterY) * battleViewScale;
    applyBattleViewTransform();
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

  const slugifyPartId = (rawName: string): string => {
    const base = rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");
    return base || "custom-part";
  };

  const makeUniquePartId = (baseId: string): string => {
    const used = new Set<string>(parts.map((part) => part.id));
    used.delete(partDesignerDraft.id);
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

  const makeCopyPart = (source: PartDefinition): PartDefinition => {
    const copy = clonePartDefinition(source);
    copy.name = `${source.name}-copy`;
    copy.id = makeUniquePartId(slugifyPartId(copy.name));
    return copy;
  };

  const parseWeaponClassList = (values: ReadonlyArray<string>): Array<"rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" | "control-utility"> => {
    const result: Array<"rapid-fire" | "heavy-shot" | "explosive" | "tracking" | "beam-precision" | "control-utility"> = [];
    for (const value of values) {
      if (
        value === "rapid-fire"
        || value === "heavy-shot"
        || value === "explosive"
        || value === "tracking"
        || value === "beam-precision"
        || value === "control-utility"
      ) {
        result.push(value);
      }
    }
    return result;
  };

  const resolveMaterialIdFromStructurePart = (part: PartDefinition): MaterialId | null => {
    if (part.layer !== "structure") {
      return null;
    }
    if (part.properties?.materialId) {
      return part.properties.materialId;
    }
    if (part.id === "material-basic" || part.id === "basic") {
      return "basic";
    }
    if (part.id === "material-reinforced" || part.id === "reinforced") {
      return "reinforced";
    }
    if (part.id === "material-ceramic" || part.id === "ceramic") {
      return "ceramic";
    }
    if (part.id === "material-reactive" || part.id === "reactive") {
      return "reactive";
    }
    if (part.id === "material-combined" || part.id === "combined") {
      return "combined";
    }
    return null;
  };

  const getMaterialDefaultsForPart = (part: PartDefinition): {
    materialId: MaterialId;
    materialArmor: number;
    materialRecoverPerSecond: number;
    materialColor: string;
    hp: number;
    mass: number;
  } => {
    const materialId: MaterialId = resolveMaterialIdFromStructurePart(part) ?? "basic";
    return getStructureMaterialDefaults(materialId);
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
        materialId: part.properties?.materialId ?? materialDefaults?.materialId,
        materialArmor: part.properties?.materialArmor ?? materialDefaults?.materialArmor,
        materialRecoverPerSecond: part.properties?.materialRecoverPerSecond ?? materialDefaults?.materialRecoverPerSecond,
        materialColor: part.properties?.materialColor ?? materialDefaults?.materialColor,
        hp: part.properties?.hp ?? materialDefaults?.hp,
        isEngine: part.properties?.isEngine ?? defaults.isEngine,
        isWeapon: part.properties?.isWeapon ?? defaults.isWeapon,
        isLoader: part.properties?.isLoader ?? defaults.isLoader,
        isArmor: part.layer === "structure" ? true : (part.properties?.isArmor ?? defaults.isArmor),
        engineType: part.properties?.engineType ?? defaults.engineType,
        weaponType: part.properties?.weaponType ?? defaults.weaponType,
        loaderServesTags: part.properties?.loaderServesTags ?? defaults.loaderServesTags,
        loaderCooldownMultiplier: part.properties?.loaderCooldownMultiplier ?? defaults.loaderCooldownMultiplier,
        hasCoreTuning: part.properties?.hasCoreTuning ?? hasCoreTuningOverrides,
      },
    };
  };

  const updateSelectedInfo = (): void => {
    if (isEditorScreen()) {
      if (isPartEditorScreen()) {
        const validation = validatePartDefinitionDetailed(partDesignerDraft);
        const errorSummary = validation.errors.length > 0 ? validation.errors.join(" | ") : "none";
        const warningSummary = validation.warnings.length > 0 ? validation.warnings.join(" | ") : "none";
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
          <div class="small">Layer: ${partDesignerDraft.layer} | Base component: ${partDesignerDraft.baseComponent} | Directional: ${partDesignerDraft.directional ? "yes" : "no"}</div>
          <div class="small">Boxes: ${partDesignerDraft.boxes.length} | Anchor: (${partDesignerDraft.anchor.x},${partDesignerDraft.anchor.y})</div>
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
            <label class="small"><input id="partBoxShootingPoint" type="checkbox" ${resolvedEntry.isShootingPoint ? "checked" : ""} ${selectedSlot === null ? "disabled" : ""} /> Shooting point</label>
          </div>
          <div class="small bad">Errors (${validation.errors.length}): ${errorSummary}</div>
          <div class="small warn">Warnings (${validation.warnings.length}): ${warningSummary}</div>
        `;
        return;
      }
      ensureEditorSelectionForLayer();
      const catalog = getEditorCatalogItems();
      const validation = validateTemplateDetailed(editorDraft, { partCatalog: parts });
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
        </button>`;
      }).join("");
      selectedInfo.innerHTML = `
        <div><strong>${editorDraft.name}</strong> (${editorDraft.type})</div>
        <div class="small">Workspace: Template Editor</div>
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
        <div class="small">Placement: ${editorPlaceByCenter ? "center-on-click" : "anchor-on-click"}</div>
        <div class="small">Material usage: ${materialUsage}</div>
        <div class="small bad">Errors (${validation.errors.length}): ${errorSummary}</div>
        <div class="small warn">Warnings (${validation.warnings.length}): ${warningSummary}</div>
        <div class="editor-comp-scroll">
          <div class="editor-comp-grid">${paletteCards}</div>
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
      const mode = selected.weaponAutoFire[index] ? "auto" : "manual";
      const control = selected.weaponManualControl[index] !== false ? "ctrl" : "free";
      const selectedMark = index === selected.selectedWeaponIndex ? "*" : "";
      return `${selectedMark}#${index + 1}: ${attachment.component} (${weaponType}, ${mode}, ${control})`;
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
        weaponHud.innerHTML = `<div><strong>Part Designer</strong></div><div class="small">Tool=${partDesignerTool}. Left-click applies the selected tool, right-click erases a box, right-drag pans, and wheel zooms. Q/E rotates preview for directional parts.</div>`;
      } else {
        weaponHud.innerHTML = `<div><strong>Object Editor</strong></div><div class="small">Layer=${editorLayer} | Mode=${editorDeleteMode ? "delete" : "place"}. Left-click places/deletes by mode, right-click deletes (functional first, then structure), right-drag pans, wheel zooms. Q/E = weapon rotate 90deg (ccw/cw). Display items attach to structure cells only.</div>`;
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
      const label = attachment ? attachment.component : "destroyed";
      const timer = controlled.weaponFireTimers[index] ?? 0;
      const cooldown = attachment ? (attachment.stats?.cooldown ?? COMPONENTS[attachment.component].cooldown ?? 0) : 0;
      const cooldownPct = cooldown > 0 ? Math.max(0, Math.min(100, ((cooldown - timer) / cooldown) * 100)) : 100;
      const cooldownText = timer > 0.01 ? `${timer.toFixed(2)}s` : "ready";
      const weaponClass = attachment ? COMPONENTS[attachment.component].weaponClass : undefined;
      const loaderManaged = weaponClass === "heavy-shot" || weaponClass === "explosive" || weaponClass === "tracking";
      const charges = controlled.weaponReadyCharges[index] ?? 0;
      const loadTimer = controlled.weaponLoadTimers[index] ?? 0;
      const loaderText = loaderManaged ? ` | load ${loadTimer > 0.01 ? `${loadTimer.toFixed(2)}s` : "idle"} | chg ${charges}` : "";
      return `<span class="${chipClass}">[${index + 1}] ${label} ${control} | ${auto} | ${cooldownText} (${cooldownPct.toFixed(0)}%)${loaderText}</span>`;
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

  const getPartById = (partId: string): PartDefinition | null => {
    return parts.find((part) => part.id === partId) ?? null;
  };

  const resolvePartForSelection = (selection: string): PartDefinition | null => {
    const byId = getPartById(selection);
    if (byId) {
      return byId;
    }
    if (selection in COMPONENTS) {
      return resolvePartDefinitionForAttachment({ component: selection as ComponentId }, parts);
    }
    return null;
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
    const placement = part.placement;
    const currentGroupId = editorFunctionalSlots[anchorSlot]?.groupId ?? -1;
    const requireStructureOnFunctional = placement?.requireStructureOnFunctionalOccupiedBoxes ?? true;
    const requireStructureOnStructure = placement?.requireStructureOnStructureOccupiedBoxes ?? true;

    for (const footprint of footprintSlots) {
      const needsStructureForFunctional = footprint.needsStructureBehind || (footprint.occupiesFunctionalSpace && requireStructureOnFunctional);
      const needsStructureForAttachPoint = footprint.isAttachPoint;
      if ((needsStructureForFunctional || needsStructureForAttachPoint) && !editorStructureSlots[footprint.slot]) {
        return { ok: false, reason: needsStructureForAttachPoint ? "Attach point requires structure support at target cell" : "Functional occupied boxes must sit on structure cells" };
      }
      if (footprint.occupiesStructureSpace && requireStructureOnStructure && !editorStructureSlots[footprint.slot]) {
        return { ok: false, reason: "Structure occupied boxes require structure support" };
      }
      if (footprint.occupiesStructureSpace && editorStructureSlots[footprint.slot]) {
        return { ok: false, reason: "Structure occupied boxes require empty structure space" };
      }
      const existing = editorFunctionalSlots[footprint.slot];
      if (footprint.occupiesFunctionalSpace && existing && existing.groupId !== currentGroupId) {
        return { ok: false, reason: "Functional occupied boxes overlap another component" };
      }
    }

    if (placement?.requireStructureBelowAnchor === true) {
      const supportSlot = coordToSlot(anchorCoord.x, anchorCoord.y + 1);
      if (supportSlot === null || !editorStructureSlots[supportSlot]) {
        return { ok: false, reason: "Component requires structure support directly below anchor" };
      }
    }

    const requiredSupportOffsets = getPlacementOffsets(part, rotateQuarter, "support");
    for (const offset of requiredSupportOffsets) {
      const requiredSlot = coordToSlot(anchorCoord.x + offset.x, anchorCoord.y + offset.y);
      if (requiredSlot === null || !editorStructureSlots[requiredSlot]) {
        return { ok: false, reason: "Component requires structure support offsets" };
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

  const isDirectionalPart = (part: PartDefinition | null): boolean => {
    if (!part) {
      return false;
    }
    return part.directional ?? COMPONENTS[part.baseComponent].directional === true;
  };

  const isCurrentEditorSelectionDirectional = (): boolean => {
    if (editorLayer !== "functional") {
      return false;
    }
    return isDirectionalPart(resolvePartForSelection(editorSelection));
  };

  const getEditorCatalogItems = (): EditorCatalogItem[] => {
    if (editorLayer === "structure") {
      const seenMaterial = new Set<MaterialId>();
      const items: EditorCatalogItem[] = [];
      for (const part of parts) {
        const materialId = resolveMaterialIdFromStructurePart(part);
        if (!materialId || seenMaterial.has(materialId)) {
          continue;
        }
        seenMaterial.add(materialId);
        const stats = MATERIALS[materialId];
        items.push({
          value: materialId,
          title: part.name,
          subtitle: `${materialId}/${part.id}`,
          detail: `Mass ${stats.mass.toFixed(2)} | Armor ${stats.armor.toFixed(2)} | HP ${stats.hp.toFixed(0)} | Recover ${stats.recoverPerSecond.toFixed(1)}/s`,
          thumb: materialId.slice(0, 2).toUpperCase(),
        });
      }
      return items;
    }
    if (editorLayer === "functional") {
      const functionalParts = parts.filter((part) => part.layer === "functional");
      const hasExplicitByBase = new Set<ComponentId>();
      for (const part of functionalParts) {
        const isImplicitFallback = (part.tags ?? []).includes("implicit") && part.id === part.baseComponent;
        if (!isImplicitFallback) {
          hasExplicitByBase.add(part.baseComponent);
        }
      }
      return functionalParts.filter((part) => {
        const isImplicitFallback = (part.tags ?? []).includes("implicit") && part.id === part.baseComponent;
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
          thumb: part.id.slice(0, 2).toUpperCase(),
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
    editorDraft.gasCost = typeof editorDraft.gasCostOverride === "number" ? editorDraft.gasCostOverride : computed;
    return computed;
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
        entry: { component: ComponentId; partId?: string; rotateQuarter: 0 | 1 | 2 | 3; groupId: number; isAnchor: boolean };
        slotIndex: number;
      } => item.entry !== null && item.entry.isAnchor && slotToCell.has(item.slotIndex))
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
      boxes,
      placement: {
        requireStructureOffsets: toRelativeOffsets(partDesignerSupportOffsets),
        requireStructureBelowAnchor: partDesignerRequireStructureBelowAnchor,
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
    partDesignerRequireStructureBelowAnchor = part.placement?.requireStructureBelowAnchor ?? false;

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
        const part = resolvePartDefinitionForAttachment(
          { partId: attachment.partId, component: attachment.component },
          parts,
        );
        if (!part) {
          continue;
        }
        const rotateQuarter = typeof attachment.rotateQuarter === "number"
          ? ((attachment.rotateQuarter % 4 + 4) % 4) as 0 | 1 | 2 | 3
          : (attachment.rotate90 ? 1 : 0);
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
      const part = resolvePartDefinitionForAttachment({ partId: attachment.partId, component: attachment.component }, parts);
      totalMass += part?.stats?.mass ?? stats.mass;
      if (stats.type === "engine") {
        const enginePower = Math.max(0, part?.stats?.power ?? stats.power ?? 0);
        const engineSpeedCap = Math.max(1, part?.stats?.maxSpeed ?? stats.maxSpeed ?? 90);
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
    context.fillStyle = validation.errors.length > 0 ? "#ffd1c1" : "#bde6c6";
    context.fillText(`Errors ${validation.errors.length} | Warnings ${validation.warnings.length}`, 18, 86);

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
    context.fillText("Left-click: place/delete | Right-click: delete (functional first) | Right-drag: pan | Mouse wheel: zoom | Origin: (0,0).", 18, 66);

    if (isCurrentEditorSelectionDirectional()) {
      context.fillStyle = "rgba(28, 43, 61, 0.92)";
      context.fillRect(drawCanvas.width - 170, 14, 154, 40);
      context.strokeStyle = "rgba(139, 172, 206, 0.8)";
      context.strokeRect(drawCanvas.width - 170, 14, 154, 40);
      context.fillStyle = "#dbe8f6";
      context.font = "12px Trebuchet MS";
      context.fillText(`Dir: ${getRotationSymbol()}`, drawCanvas.width - 160, 31);
      context.fillText(`Q ccw | E cw`, drawCanvas.width - 160, 47);
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
    const panelY = drawCanvas.height - 54;
    context.fillStyle = "rgba(19, 30, 44, 0.94)";
    context.fillRect(panelX, panelY, 530, 38);
    context.strokeStyle = "rgba(128, 172, 206, 0.7)";
    context.strokeRect(panelX, panelY, 530, 38);
    context.fillStyle = "#dbe8f6";
    context.font = "12px Trebuchet MS";
    context.fillText(speedText, panelX + 8, panelY + 15);
    context.fillText(legend, panelX + 8, panelY + 31);
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
        const rotateQuarter = isDirectionalPart(part) ? editorWeaponRotateQuarter : 0;

        let anchorSlot = slot;
        if (editorPlaceByCenter) {
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
          const clickCoord = slotToCoord(slot);
          const centeredAnchorSlot = coordToSlot(clickCoord.x - centerOffsetX, clickCoord.y - centerOffsetY);
          if (centeredAnchorSlot === null) {
            addLog("Centered placement is out of editor bounds", "warn");
            return;
          }
          anchorSlot = centeredAnchorSlot;
        }

        const placement = getFootprintSlots(anchorSlot, part, rotateQuarter);
        if (!placement || placement.slots.length <= 0) {
          addLog("Part footprint out of editor bounds", "warn");
          return;
        }
        const check = validateFunctionalPlacement(part, rotateQuarter, anchorSlot, placement.slots, placement.anchorCoord);
        if (!check.ok) {
          addLog(check.reason ?? "Invalid component placement", "warn");
          return;
        }
        if (part.baseComponent === "control") {
          editorFunctionalSlots = editorFunctionalSlots.map((entry) => (entry?.component === "control" ? null : entry));
        }
        const occupiedGroupIds = new Set(
          placement.slots
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
        for (const occupiedSlot of placement.slots) {
          editorFunctionalSlots[occupiedSlot.slot] = {
            component: part.baseComponent,
            partId: part.id,
            rotateQuarter,
            groupId,
            isAnchor: occupiedSlot.slot === anchorSlot,
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

    const isTestArenaActive = battle.getState().active && battle.getState().nodeId === testArenaNode.id;
    mapPanel.innerHTML = `
      <h3>Map</h3>
      <div class="small">Choose where to fight from your base.</div>
      ${battle.getState().active && !battle.getState().outcome && !isTestArenaActive ? `<div class="small warn">Battle resolves when you press Next Round.</div>` : ""}
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
      <div id="friendlyActive" class="small"></div>
      ${battle.getState().outcome ? `<div class="row"><button id="btnBackToMap">Return to Map</button></div>` : ""}
    `;

    const selectedSpawnTemplateIds = getTestArenaSpawnTemplateIds();
    const selectedSpawnTemplateIdSet = new Set<string>(selectedSpawnTemplateIds);
    const spawnTemplateCheckboxRows = templates
      .map((template) => `
        <label class="small test-arena-spawn-option">
          <input class="testArenaSpawnTemplateToggle" type="checkbox" data-template-id="${escapeHtml(template.id)}" ${selectedSpawnTemplateIdSet.has(template.id) ? "checked" : ""} />
          <span>${escapeHtml(template.name)}</span>
        </label>
      `)
      .join("");
    const spawnTemplateSummary = selectedSpawnTemplateIds.length <= 0
      ? "Enemy (none selected)"
      : `Enemy (${selectedSpawnTemplateIds.length} selected)`;
    const spawnTemplateDropdownOpenAttr = testArenaSpawnTemplateDropdownOpen ? "open" : "";
    const manualSpawnTemplateId = getTestArenaManualSpawnTemplateId();
    const manualSpawnTemplateOptions = templates
      .map((template) => `<option value="${template.id}" ${template.id === manualSpawnTemplateId ? "selected" : ""}>${escapeHtml(template.name)}</option>`)
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
    const enemyCountActive = isTestArenaActive
      ? battle.getAliveEnemyCount()
      : enemyCountLabel;
    const zoomPercentLabel = Math.round(battleViewScale * 100);
    const unitSectionOpenAttr = testArenaPanelSections.unit ? "open" : "";
    const aiSectionOpenAttr = testArenaPanelSections.ai ? "open" : "";
    const uiSectionOpenAttr = testArenaPanelSections.ui ? "open" : "";
    testArenaPanel.innerHTML = `
      <h3>Test Arena</h3>
      <div class="small">Debug arena for spawn pressure and survivability. Starts a battle without campaign rewards.</div>
      <div class="small">Not turn-based: Next Round is disabled while in Test Arena.</div>
      <div class="row">
        <button id="btnStartTestArena">${isTestArenaActive ? "Restart Test Arena" : "Start Test Arena"}</button>
        ${isTestArenaActive ? `<button id="btnEndTestArena">End Test Arena</button>` : ""}
      </div>
      <details id="testArenaSectionUnit" class="test-arena-section" ${unitSectionOpenAttr}>
        <summary><strong>Unit</strong></summary>
        <div class="test-arena-section-body">
          <div class="test-arena-inline-grid">
            <label class="small">Enemy count
              <input id="testArenaEnemyCount" type="number" min="0" max="40" step="1" value="${enemyCountLabel}" />
            </label>
            <span class="small">Active: ${enemyCountActive}</span>
          </div>
          <div class="test-arena-spawn-row">
            <details id="testArenaSpawnTemplateDropdown" class="test-arena-spawn-dropdown" ${spawnTemplateDropdownOpenAttr}>
              <summary class="small">${spawnTemplateSummary}</summary>
              <div class="test-arena-spawn-options">
                ${spawnTemplateCheckboxRows}
              </div>
            </details>
          </div>
          <div class="test-arena-spawn-row">
            <label class="small">Manual spawn enemy
              <select id="testArenaManualSpawnTemplate">
                ${manualSpawnTemplateOptions}
              </select>
            </label>
            <button id="btnSpawnTestEnemy">Spawn</button>
          </div>
          <div class="small">Checkbox dropdown affects automatic enemy spawn only.</div>
          <label class="small"><input id="testArenaInvinciblePlayer" type="checkbox" ${testArenaInvinciblePlayer ? "checked" : ""} /> Player controlled invincible</label>
          <div class="small">Invincible player still collides and can be targeted, but takes no damage.</div>
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
          <div class="test-arena-ui-grid">
            <span class="small">Width</span>
            <span class="small">Height</span>
            <span class="small">Zoom %</span>
            <span class="small">Ground H</span>
            <input id="testArenaBattlefieldWidth" type="number" min="640" max="4096" step="10" value="${testArenaBattlefieldWidth}" />
            <input id="testArenaBattlefieldHeight" type="number" min="360" max="2160" step="10" value="${testArenaBattlefieldHeight}" />
            <input id="testArenaZoomPercent" type="number" min="45" max="240" step="1" value="${zoomPercentLabel}" />
            <input id="testArenaGroundHeight" type="number" min="80" max="${Math.max(120, testArenaBattlefieldHeight - 40)}" step="10" value="${testArenaGroundHeight}" />
          </div>
        </div>
      </details>
    `;

    const leaderboardRows = testArenaLeaderboardEntries
      .slice(0, 24)
      .map((entry, index) => {
        const winRate = Number.isFinite(entry.winRate) ? `${(Number(entry.winRate) * 100).toFixed(1)}%` : "-";
        const score = Number.isFinite(entry.leaderboardScore) ? Number(entry.leaderboardScore).toFixed(2) : "-";
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
          <td>${winRate}</td>
          <td>${wins}/${losses}/${ties}</td>
          <td>${rounds}</td>
        </tr>`;
      })
      .join("");
    const competeRunsValue = Math.max(1, Math.min(200, Math.floor(testArenaLeaderboardCompeteRuns)));
    const competeModeOptions = `
      <option value="random-pair" ${testArenaLeaderboardCompeteMode === "random-pair" ? "selected" : ""}>Random pair</option>
      <option value="unranked-vs-random" ${testArenaLeaderboardCompeteMode === "unranked-vs-random" ? "selected" : ""}>Unranked vs random</option>
      <option value="manual-pair" ${testArenaLeaderboardCompeteMode === "manual-pair" ? "selected" : ""}>Manual pair</option>
    `;
    const manualPairOptionsA = testArenaLeaderboardEntries
      .map((entry) => `<option value="${escapeHtml(entry.runId)}" ${entry.runId === testArenaLeaderboardManualPairA ? "selected" : ""}>${escapeHtml(entry.runId)}</option>`)
      .join("");
    const manualPairOptionsB = testArenaLeaderboardEntries
      .map((entry) => `<option value="${escapeHtml(entry.runId)}" ${entry.runId === testArenaLeaderboardManualPairB ? "selected" : ""}>${escapeHtml(entry.runId)}</option>`)
      .join("");
    leaderboardPanel.innerHTML = `
      <h3>Leaderboard Options</h3>
      <div class="small">Configure and run Elo competitions between AI models.</div>
      <div class="leaderboard-actions">
        <label class="small">Mode
          <select id="leaderboardCompeteMode">
            ${competeModeOptions}
          </select>
        </label>
        <label class="small">Runs
          <input id="leaderboardCompeteRuns" type="number" min="1" max="200" step="1" value="${competeRunsValue}" />
        </label>
        ${testArenaLeaderboardCompeteMode === "manual-pair" ? `
          <label class="small">Model A
            <select id="leaderboardManualPairA">${manualPairOptionsA}</select>
          </label>
          <label class="small">Model B
            <select id="leaderboardManualPairB">${manualPairOptionsB}</select>
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
      <div class="small">Real ranking by head-to-head matches. All runs start at score 100.</div>
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
              <th style="text-align:left;">Win Rate</th>
              <th style="text-align:left;">W/L/T</th>
              <th style="text-align:left;">Rounds</th>
            </tr>
          </thead>
          <tbody>${leaderboardRows}</tbody>
        </table>` : ""}
      </div>
    `;

    ensureEditorSelectionForLayer();
    if (isTemplateEditorScreen()) {
      const computedTemplateGas = computeTemplateGasCost(editorDraft, parts);
      const effectiveTemplateGas = typeof editorDraft.gasCostOverride === "number" ? editorDraft.gasCostOverride : computedTemplateGas;
      editorDraft.gasCost = effectiveTemplateGas;
      if (editorTemplateDialogSelectedId === null || !templates.some((template) => template.id === editorTemplateDialogSelectedId)) {
        editorTemplateDialogSelectedId = templates[0]?.id ?? null;
      }
      const templateOpenRows = templates
        .map((template) => {
          const selectedClass = template.id === editorTemplateDialogSelectedId ? "active" : "";
          return `<div class="row" style="gap:8px; flex-wrap:nowrap; align-items:center;">
            <button data-editor-open-select="${template.id}" class="${selectedClass}" style="flex:1; text-align:left;">${template.name} (${template.type})</button>
            <div style="display:flex; gap:6px; margin-left:auto;">
              <button data-editor-open-copy="${template.id}">Copy</button>
              <button data-editor-open-delete="${template.id}">Delete</button>
            </div>
          </div>`;
        })
        .join("");
      editorPanel.innerHTML = `
        <h3>Template Editor</h3>
        <div class="small">Choose a layer, pick a part card on the right panel, then click the ${editorGridCols}x${editorGridRows} grid on canvas. Right-drag to move view and wheel to zoom. Origin is (0,0), negative coordinates supported.</div>
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
            </select>
          </label>
          <label class="small">Gas Override
            <input id="editorGasOverride" type="number" min="0" step="1" value="${editorDraft.gasCostOverride ?? ""}" placeholder="${computedTemplateGas}" />
          </label>
        </div>
        <div class="small">Gas cost = ${effectiveTemplateGas} (${typeof editorDraft.gasCostOverride === "number" ? "template override" : "sum of part gas values"}).</div>
        <div class="row">
          <label class="small"><input id="editorDeleteMode" type="checkbox" ${editorDeleteMode ? "checked" : ""} /> Delete mode</label>
          <label class="small"><input id="editorPlaceByCenter" type="checkbox" ${editorPlaceByCenter ? "checked" : ""} /> Center place on click</label>
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
          <button id="btnSaveDraft">Save</button>
          <button id="btnSaveDraftDefault">Save to Default</button>
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
      const functionalTypeOrder: Array<Exclude<PartOpenFilter, "all" | "structure">> = ["control", "engine", "weapon", "loader", "ammo"];
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
      const isStructureLayerMode = partDesignerDraft.layer === "structure";
      const selectedBaseOption = isStructureLayerMode ? STRUCTURE_LAYER_BASE_OPTION : partDesignerDraft.baseComponent;
      const baseComponentOptions = [
        `<option value="${STRUCTURE_LAYER_BASE_OPTION}" ${selectedBaseOption === STRUCTURE_LAYER_BASE_OPTION ? "selected" : ""}>structure-layer</option>`,
        ...Object.keys(COMPONENTS)
        .map((component) => `<option value="${component}" ${selectedBaseOption === component ? "selected" : ""}>${component}</option>`)
      ].join("");
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
        shootAngleDeg: baseStats.shootAngleDeg !== undefined ? String(baseStats.shootAngleDeg) : "none",
        projectileSpeed: baseStats.projectileSpeed !== undefined ? String(baseStats.projectileSpeed) : "none",
        projectileGravity: baseStats.projectileGravity !== undefined ? String(baseStats.projectileGravity) : "none",
        spreadDeg: baseStats.spreadDeg !== undefined ? String(baseStats.spreadDeg) : "none",
        explosiveBlastRadius: baseStats.explosive?.blastRadius !== undefined ? String(baseStats.explosive.blastRadius) : "none",
        explosiveBlastDamage: baseStats.explosive?.blastDamage !== undefined ? String(baseStats.explosive.blastDamage) : "none",
        explosiveFalloffPower: baseStats.explosive?.falloffPower !== undefined ? String(baseStats.explosive.falloffPower) : "none",
        explosiveFuseTime: baseStats.explosive?.fuseTime !== undefined ? String(baseStats.explosive.fuseTime) : "none",
        trackingTurnRateDegPerSec: baseStats.tracking?.turnRateDegPerSec !== undefined ? String(baseStats.tracking.turnRateDegPerSec) : "none",
        controlImpairFactor: baseStats.control?.impairFactor !== undefined ? String(baseStats.control.impairFactor) : "none",
        controlDuration: baseStats.control?.duration !== undefined ? String(baseStats.control.duration) : "none",
        loaderLoadMultiplier: baseStats.loader?.loadMultiplier !== undefined ? String(baseStats.loader.loadMultiplier) : "none",
        loaderMinLoadTime: baseStats.loader?.minLoadTime !== undefined ? String(baseStats.loader.minLoadTime) : "none",
        loaderStoreCapacity: baseStats.loader?.storeCapacity !== undefined ? String(baseStats.loader.storeCapacity) : "none",
        loaderMinBurstInterval: baseStats.loader?.minBurstInterval !== undefined ? String(baseStats.loader.minBurstInterval) : "none",
      };
      const categoryOptionsBase: string[] = ["functional", "structure", "weapon", "mobility", "support", "defense", "utility", "other"];
      const weaponTypeOptions: Array<{ value: NonNullable<PartDefinition["properties"]>["weaponType"]; label: string }> = [
        { value: "rapid-fire", label: "rapid-fire" },
        { value: "heavy-shot", label: "heavy-shot" },
        { value: "explosive", label: "explosive" },
        { value: "tracking", label: "tracking" },
        { value: "beam-precision", label: "beam-precision" },
        { value: "control-utility", label: "control-utility" },
      ];
      const partProps = partDesignerDraft.properties ?? {};
      const categoryOptions = partProps.category && !categoryOptionsBase.includes(partProps.category)
        ? [partProps.category, ...categoryOptionsBase]
        : categoryOptionsBase;
      const propIsEngine = !isStructureLayerMode && partProps.isEngine === true;
      const propIsWeapon = !isStructureLayerMode && partProps.isWeapon === true;
      const propIsLoader = !isStructureLayerMode && partProps.isLoader === true;
      const propIsArmor = isStructureLayerMode ? true : partProps.isArmor === true;
      const propHasCoreTuning = !isStructureLayerMode && partProps.hasCoreTuning === true;
      const resolvedWeaponType = partProps.weaponType ?? baseStats.weaponClass;
      const weaponSupportsExplosive = resolvedWeaponType === "explosive";
      const weaponSupportsTracking = resolvedWeaponType === "tracking";
      const weaponSupportsControl = resolvedWeaponType === "control-utility";
      const loaderSupportsPlaceholder = baseStats.loader?.supports?.join(", ") ?? "none";
      editorPanel.innerHTML = `
        <h3>Part Designer</h3>
        <div class="small">Left panel edits part-level metadata and runtime values. Right panel edits single-box properties for the currently selected cell.</div>
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
          <label class="small">Part ID <input id="partId" value="${partDesignerDraft.id}" /></label>
        </div>
        <div class="row">
          <label class="small">Base Component
            <select id="partBaseComponent">${baseComponentOptions}</select>
          </label>
          <label class="small"><input id="partDirectional" type="checkbox" ${partDesignerDraft.directional ? "checked" : ""} /> Directional</label>
        </div>
        ${!isStructureLayerMode ? `<div><strong>Editor Meta</strong></div>
        <div class="row">
          <label class="small">Category
            <select id="partCategorySelect">
              ${categoryOptions.map((option) => `<option value="${option}" ${(partProps.category ?? "") === option ? "selected" : ""}>${option}</option>`).join("")}
            </select>
          </label>
          <label class="small">Subcategory <input id="partSubcategory" value="${partProps.subcategory ?? ""}" /></label>
        </div>` : ""}
        <div><strong>Part Properties</strong></div>
        <div class="row">
          <label class="small" style="flex:1;">Tags (comma separated) <input id="partTags" value="${(partDesignerDraft.tags ?? []).join(", ")}" /></label>
        </div>
        <div class="row">
          <label class="small">Gas Cost <input id="partGasCost" type="number" min="0" step="1" value="${partDesignerDraft.stats?.gasCost ?? ""}" placeholder="${runtimePlaceholders.gasCost}" /></label>
          <span class="small">Delete value to reset to default gas calculation.</span>
        </div>
        ${isStructureLayerMode ? `<div class="row">
          <label class="small">Material
            <select id="partMaterialId">
              <option value="basic" ${partProps.materialId === "basic" ? "selected" : ""}>basic steel</option>
              <option value="reinforced" ${partProps.materialId === "reinforced" ? "selected" : ""}>reinforced</option>
              <option value="ceramic" ${partProps.materialId === "ceramic" ? "selected" : ""}>ceramic</option>
              <option value="reactive" ${partProps.materialId === "reactive" ? "selected" : ""}>reactive</option>
              <option value="combined" ${partProps.materialId === "combined" ? "selected" : ""}>combined mk1</option>
            </select>
          </label>
          <label class="small">Armor <input id="partMaterialArmor" type="number" step="0.01" value="${partProps.materialArmor ?? ""}" /></label>
          <label class="small">Recover/s <input id="partMaterialRecoverPerSecond" type="number" step="0.05" value="${partProps.materialRecoverPerSecond ?? ""}" /></label>
          <label class="small">Color <input id="partMaterialColor" value="${partProps.materialColor ?? ""}" placeholder="#95a4b8" /></label>
        </div>
        <div class="row">
          <label class="small">Mass <input id="partStructureMass" type="number" step="0.1" value="${partDesignerDraft.stats?.mass ?? ""}" /></label>
          <label class="small">HP <input id="partMetaHp" type="number" step="1" value="${partProps.hp ?? ""}" /></label>
        </div>` : ""}
        ${!isStructureLayerMode ? `<div class="row">
          <label class="small"><input id="partPropIsEngine" type="checkbox" ${propIsEngine ? "checked" : ""} /> is_engine</label>
          <label class="small"><input id="partPropIsWeapon" type="checkbox" ${propIsWeapon ? "checked" : ""} /> is_weapon</label>
          <label class="small"><input id="partPropIsLoader" type="checkbox" ${propIsLoader ? "checked" : ""} /> is_loader</label>
          <label class="small"><input id="partPropIsArmor" type="checkbox" ${propIsArmor ? "checked" : ""} /> is_armor</label>
          <label class="small"><input id="partPropCoreTuning" type="checkbox" ${propHasCoreTuning ? "checked" : ""} /> core_tuning</label>
        </div>` : `<div class="small">Structure layer mode: functional-specific metadata and placement constraints are hidden.</div>`}
        ${propIsEngine ? `<div class="row">
          <label class="small">Engine Type
            <select id="partEngineType">
              <option value="ground" ${partProps.engineType === "ground" ? "selected" : ""}>ground</option>
              <option value="air" ${partProps.engineType === "air" ? "selected" : ""}>air</option>
            </select>
          </label>
          <label class="small">Power <input id="partPower" type="number" step="1" value="${partDesignerDraft.stats?.power ?? ""}" placeholder="${runtimePlaceholders.power}" /></label>
          <label class="small">Max Speed <input id="partMaxSpeed" type="number" step="1" value="${partDesignerDraft.stats?.maxSpeed ?? ""}" placeholder="${runtimePlaceholders.maxSpeed}" /></label>
        </div>` : ""}
        ${propIsWeapon ? `<div class="row">
          <label class="small">Weapon Type
            <select id="partWeaponType">
              ${weaponTypeOptions.map((option) => `<option value="${option.value}" ${partProps.weaponType === option.value ? "selected" : ""}>${option.label}</option>`).join("")}
            </select>
          </label>
          <label class="small">Recoil <input id="partRecoil" type="number" step="0.1" value="${partDesignerDraft.stats?.recoil ?? ""}" placeholder="${runtimePlaceholders.recoil}" /></label>
          <label class="small">Hit Impulse <input id="partHitImpulse" type="number" step="0.1" value="${partDesignerDraft.stats?.hitImpulse ?? ""}" placeholder="${runtimePlaceholders.hitImpulse}" /></label>
        </div>
        <div class="row">
          <label class="small">Damage <input id="partDamage" type="number" step="1" value="${partDesignerDraft.stats?.damage ?? ""}" placeholder="${runtimePlaceholders.damage}" /></label>
          <label class="small">Range <input id="partRange" type="number" step="1" value="${partDesignerDraft.stats?.range ?? ""}" placeholder="${runtimePlaceholders.range}" /></label>
          <label class="small">Cooldown <input id="partCooldown" type="number" step="0.05" value="${partDesignerDraft.stats?.cooldown ?? ""}" placeholder="${runtimePlaceholders.cooldown}" /></label>
        </div>
        <div class="row">
          <label class="small">Shoot Angle <input id="partShootAngle" type="number" step="1" value="${partDesignerDraft.stats?.shootAngleDeg ?? ""}" placeholder="${runtimePlaceholders.shootAngleDeg}" /></label>
          <label class="small">Projectile Speed <input id="partProjectileSpeed" type="number" step="1" value="${partDesignerDraft.stats?.projectileSpeed ?? ""}" placeholder="${runtimePlaceholders.projectileSpeed}" /></label>
          <label class="small">Projectile Gravity <input id="partProjectileGravity" type="number" step="1" value="${partDesignerDraft.stats?.projectileGravity ?? ""}" placeholder="${runtimePlaceholders.projectileGravity}" /></label>
        </div>
        <div class="row">
          <label class="small">Spread <input id="partSpread" type="number" step="0.1" value="${partDesignerDraft.stats?.spreadDeg ?? ""}" placeholder="${runtimePlaceholders.spreadDeg}" /></label>
          ${weaponSupportsTracking ? `<label class="small">Tracking Turn Rate <input id="partTrackingTurnRate" type="number" step="1" value="${partDesignerDraft.stats?.trackingTurnRateDegPerSec ?? ""}" placeholder="${runtimePlaceholders.trackingTurnRateDegPerSec}" /></label>` : ""}
          ${weaponSupportsControl ? `<label class="small">Control Impair Factor <input id="partControlImpairFactor" type="number" step="0.01" value="${partDesignerDraft.stats?.controlImpairFactor ?? ""}" placeholder="${runtimePlaceholders.controlImpairFactor}" /></label>` : ""}
        </div>
        ${weaponSupportsControl ? `<div class="row">
          <label class="small">Control Duration <input id="partControlDuration" type="number" step="0.05" value="${partDesignerDraft.stats?.controlDuration ?? ""}" placeholder="${runtimePlaceholders.controlDuration}" /></label>
        </div>` : ""}
        ${weaponSupportsExplosive ? `<div class="row">
          <label class="small">Explosive Delivery
            <select id="partExplosiveDeliveryMode">
              <option value="shell" ${(partDesignerDraft.stats?.explosiveDeliveryMode ?? baseStats.explosive?.deliveryMode ?? "shell") === "shell" ? "selected" : ""}>shell</option>
              <option value="bomb" ${(partDesignerDraft.stats?.explosiveDeliveryMode ?? baseStats.explosive?.deliveryMode ?? "shell") === "bomb" ? "selected" : ""}>bomb</option>
            </select>
          </label>
          <label class="small">Explosive Fuse
            <select id="partExplosiveFuse">
              <option value="impact" ${(partDesignerDraft.stats?.explosiveFuse ?? baseStats.explosive?.fuse ?? "impact") === "impact" ? "selected" : ""}>impact</option>
              <option value="timed" ${(partDesignerDraft.stats?.explosiveFuse ?? baseStats.explosive?.fuse ?? "impact") === "timed" ? "selected" : ""}>timed</option>
            </select>
          </label>
          <label class="small">Fuse Time <input id="partExplosiveFuseTime" type="number" step="0.05" value="${partDesignerDraft.stats?.explosiveFuseTime ?? ""}" placeholder="${runtimePlaceholders.explosiveFuseTime}" /></label>
        </div>
        <div class="row">
          <label class="small">Blast Radius <input id="partExplosiveBlastRadius" type="number" step="1" value="${partDesignerDraft.stats?.explosiveBlastRadius ?? ""}" placeholder="${runtimePlaceholders.explosiveBlastRadius}" /></label>
          <label class="small">Blast Damage <input id="partExplosiveBlastDamage" type="number" step="1" value="${partDesignerDraft.stats?.explosiveBlastDamage ?? ""}" placeholder="${runtimePlaceholders.explosiveBlastDamage}" /></label>
          <label class="small">Falloff Power <input id="partExplosiveFalloffPower" type="number" step="0.1" value="${partDesignerDraft.stats?.explosiveFalloffPower ?? ""}" placeholder="${runtimePlaceholders.explosiveFalloffPower}" /></label>
        </div>` : ""}` : ""}
        ${propIsLoader ? `<div class="row">
          <label class="small" style="flex:1;">Loader supports (comma separated weapon classes) <input id="partLoaderSupports" value="${(partDesignerDraft.stats?.loaderSupports ?? partProps.loaderServesTags ?? []).join(", ")}" placeholder="${loaderSupportsPlaceholder}" /></label>
          <label class="small">Load Multiplier <input id="partLoaderLoadMultiplier" type="number" step="0.01" value="${partDesignerDraft.stats?.loaderLoadMultiplier ?? partProps.loaderCooldownMultiplier ?? ""}" placeholder="${runtimePlaceholders.loaderLoadMultiplier}" /></label>
          <label class="small"><input id="partLoaderFastOperation" type="checkbox" ${(partDesignerDraft.stats?.loaderFastOperation ?? baseStats.loader?.fastOperation ?? false) ? "checked" : ""} /> Fast Operation</label>
        </div>
        <div class="row">
          <label class="small">Min Load Time <input id="partLoaderMinLoadTime" type="number" step="0.05" value="${partDesignerDraft.stats?.loaderMinLoadTime ?? ""}" placeholder="${runtimePlaceholders.loaderMinLoadTime}" /></label>
          <label class="small">Store Capacity <input id="partLoaderStoreCapacity" type="number" step="1" value="${partDesignerDraft.stats?.loaderStoreCapacity ?? ""}" placeholder="${runtimePlaceholders.loaderStoreCapacity}" /></label>
          <label class="small">Min Burst Interval <input id="partLoaderMinBurstInterval" type="number" step="0.05" value="${partDesignerDraft.stats?.loaderMinBurstInterval ?? ""}" placeholder="${runtimePlaceholders.loaderMinBurstInterval}" /></label>
        </div>` : ""}
        ${!isStructureLayerMode && propIsArmor ? `<div class="row">
          <label class="small">HP <input id="partMetaHp" type="number" step="1" value="${partProps.hp ?? ""}" /></label>
        </div>` : ""}
        ${propHasCoreTuning ? `<div class="row">
          <label class="small">Mass <input id="partMass" type="number" step="0.1" value="${partDesignerDraft.stats?.mass ?? ""}" placeholder="${runtimePlaceholders.mass}" /></label>
          <label class="small">HP Mul <input id="partHpMul" type="number" step="0.05" value="${partDesignerDraft.stats?.hpMul ?? ""}" placeholder="${runtimePlaceholders.hpMul}" /></label>
        </div>
        ` : ""}
        ${!isStructureLayerMode ? `<div class="row">
          <label class="small"><input id="partRequireStructureBelowAnchor" type="checkbox" ${partDesignerRequireStructureBelowAnchor ? "checked" : ""} /> Require structure below anchor</label>
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
      if (typeof template.gasCostOverride === "number") {
        template.gasCostOverride += material === "combined" ? 8 : 4;
        template.gasCost = template.gasCostOverride;
      } else {
        template.gasCost = computeTemplateGasCost(template, parts);
      }
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
    applyBattleViewTransform();
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
    battleViewScale = Math.max(0.45, Math.min(2.4, scale));
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
    battle.setEnemySpawnTemplateFilter(getTestArenaSpawnTemplateIds());
    battle.start(testArenaNode);
    battle.setControlledUnitInvincible(testArenaInvinciblePlayer);
    battle.setEnemyActiveCount(testArenaEnemyCount);
    const playerModel = findCompositeModelOptionById(testArenaCompositeModelSelections.player)?.label ?? testArenaCompositeModelSelections.player;
    const enemyModel = findCompositeModelOptionById(testArenaCompositeModelSelections.enemy)?.label ?? testArenaCompositeModelSelections.enemy;
    addLog(`Test Arena started. P model=${playerModel} | E model=${enemyModel}.`);
    setScreen("testArena");
    centerBattleViewYOnPlayerBase();
    renderPanels();
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
        if (typeof tankTemplate.gasCostOverride === "number") {
          tankTemplate.gasCostOverride += 9;
          tankTemplate.gasCost = tankTemplate.gasCostOverride;
        } else {
          tankTemplate.gasCost = computeTemplateGasCost(tankTemplate, parts);
        }
      }
      addLog("Unlocked explosive cannon option", "good");
      renderPanels();
    });

    document.querySelectorAll<HTMLButtonElement>("button.nodeAttack").forEach((button) => {
      button.addEventListener("click", () => {
        if (battle.getState().active && !battle.getState().outcome) {
          battle.resetToMapMode();
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
        battle.setEnemySpawnTemplateFilter(null);
        battle.start(node);
        addLog(`Battle started at ${node.name}`);
        setScreen("battle");
        centerBattleViewYOnPlayerBase();
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

    getOptionalElement<HTMLButtonElement>("#btnStartTestArena")?.addEventListener("click", () => {
      void startTestArena();
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

    const leaderboardCompeteRunsInput = getOptionalElement<HTMLInputElement>("#leaderboardCompeteRuns");
    const commitLeaderboardCompeteRuns = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#leaderboardCompeteRuns")?.value ?? "";
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        testArenaLeaderboardCompeteRuns = 100;
      } else {
        testArenaLeaderboardCompeteRuns = Math.max(1, Math.min(200, parsed));
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
      await runLeaderboardCompetition(
        testArenaLeaderboardCompeteMode,
        testArenaLeaderboardCompeteRuns,
        testArenaLeaderboardManualPairA,
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
      if (battle.getState().active && battle.getState().nodeId === testArenaNode.id) {
        const updated = battle.setEnemyActiveCount(testArenaEnemyCount);
        addLog(`Test Arena enemy count set to ${updated}.`, "good");
      } else {
        addLog(`Test Arena enemy count queued: ${testArenaEnemyCount}.`, "warn");
      }
      renderPanels();
    };
    bindCommitOnEnterOrBlur(getOptionalElement<HTMLInputElement>("#testArenaEnemyCount"), commitTestArenaEnemyCount);

    const commitTestArenaBattlefieldWidth = (): void => {
      const raw = getOptionalElement<HTMLInputElement>("#testArenaBattlefieldWidth")?.value ?? "";
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) {
        addLog("Battlefield width must be a number.", "warn");
        renderPanels();
        return;
      }
      testArenaBattlefieldWidth = normalizeTestArenaBattlefieldWidth(value);
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
      if (battle.getState().active && battle.getState().nodeId !== testArenaNode.id) {
        addLog(`Test Arena ground height queued: ${testArenaGroundHeight}.`, "warn");
      } else {
        testArenaGroundHeight = battle.setGroundHeight(testArenaGroundHeight);
        addLog(`Test Arena ground height set to ${testArenaGroundHeight}.`, "good");
      }
      renderPanels();
    };
    bindCommitOnEnterOrBlur(getOptionalElement<HTMLInputElement>("#testArenaGroundHeight"), commitTestArenaGroundHeight);

    document.querySelectorAll<HTMLInputElement>("input.testArenaSpawnTemplateToggle").forEach((input) => {
      input.addEventListener("change", (event) => {
        const checkbox = event.currentTarget as HTMLInputElement;
        const templateId = checkbox.getAttribute("data-template-id") ?? "";
        if (!templateId) {
          return;
        }
        const nextSelection = new Set<string>(getTestArenaSpawnTemplateIds());
        if (checkbox.checked) {
          nextSelection.add(templateId);
        } else {
          nextSelection.delete(templateId);
        }
        const appliedSelection = setTestArenaSpawnTemplateIds(Array.from(nextSelection));
        battle.setEnemySpawnTemplateFilter(appliedSelection);
        if (battle.getState().active && battle.getState().nodeId === testArenaNode.id) {
          const updated = battle.setEnemyActiveCount(testArenaEnemyCount);
          addLog(
            appliedSelection.length > 0
              ? `Enemy spawn templates updated (${appliedSelection.length} selected). Active: ${updated}.`
              : `Enemy spawn templates cleared. Active: ${updated}.`,
            appliedSelection.length > 0 ? "good" : "warn",
          );
        } else {
          addLog(
            appliedSelection.length > 0
              ? `Enemy spawn templates queued (${appliedSelection.length} selected).`
              : "Enemy spawn templates queued: none selected.",
            "warn",
          );
        }
        renderPanels();
      });
    });

    getOptionalElement<HTMLSelectElement>("#testArenaManualSpawnTemplate")?.addEventListener("change", (event) => {
      const nextValue = (event.currentTarget as HTMLSelectElement).value;
      setTestArenaManualSpawnTemplateId(nextValue);
    });

    getOptionalElement<HTMLButtonElement>("#btnSpawnTestEnemy")?.addEventListener("click", async () => {
      const selection = getOptionalElement<HTMLSelectElement>("#testArenaManualSpawnTemplate")?.value
        ?? getTestArenaManualSpawnTemplateId()
        ?? "";
      if (!selection) {
        addLog("Select a manual enemy template to spawn.", "warn");
        return;
      }
      setTestArenaManualSpawnTemplateId(selection);
      if (!battle.getState().active || battle.getState().nodeId !== testArenaNode.id) {
        await startTestArena();
      }
      const spawned = battle.spawnEnemyTemplate(selection);
      addLog(spawned ? `Spawned enemy: ${selection}.` : `Failed to spawn enemy: ${selection}.`, spawned ? "good" : "bad");
      renderPanels();
    });

    getOptionalElement<HTMLInputElement>("#testArenaInvinciblePlayer")?.addEventListener("change", (event) => {
      testArenaInvinciblePlayer = (event.currentTarget as HTMLInputElement).checked;
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
        const templateId = button.getAttribute("data-editor-open-select");
        if (!templateId) {
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
        const templateId = button.getAttribute("data-editor-open-copy");
        if (!templateId) {
          return;
        }
        const source = templates.find((template) => template.id === templateId);
        if (!source) {
          return;
        }
        recenterEditorViewForScreen("templateEditor");
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
    document.querySelectorAll<HTMLButtonElement>("button[data-editor-open-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        const templateId = button.getAttribute("data-editor-open-delete");
        if (!templateId) {
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
      editorDraft.type = value === "air" ? "air" : "ground";
      recomputeEditorDraftGasCost();
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#editorGasOverride")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      if (raw.length <= 0) {
        editorDraft.gasCostOverride = undefined;
      } else {
        const parsed = Number(raw);
        editorDraft.gasCostOverride = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
      }
      recomputeEditorDraftGasCost();
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
        gasCostOverride: undefined,
        structure: [],
        attachments: [],
        display: [],
      };
      editorDeleteMode = false;
      editorLayer = "structure";
      editorWeaponRotateQuarter = 0;
      editorTemplateDialogOpen = false;
      editorTemplateDialogSelectedId = editorDraft.id;
      recenterEditorViewForScreen("templateEditor");
      loadTemplateIntoEditorSlots(editorDraft);
      ensureEditorSelectionForLayer();
      renderPanels();
    });
    const saveEditorDraft = async (target: "user" | "default"): Promise<void> => {
      const snapshot = cloneTemplate(editorDraft);
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
      const saved = target === "default"
        ? await saveDefaultTemplateToStore(snapshot)
        : await saveUserTemplateToStore(snapshot);
      if (!saved) {
        addLog(`Failed to save ${target} object`, "bad");
        return;
      }
      await refreshTemplatesFromStore();
      addLog(`Saved ${target} object: ${snapshot.name}`, "good");
      renderPanels();
    };

    getOptionalElement<HTMLButtonElement>("#btnSaveDraft")?.addEventListener("click", async () => {
      await saveEditorDraft("user");
    });
    getOptionalElement<HTMLButtonElement>("#btnSaveDraftDefault")?.addEventListener("click", async () => {
      await saveEditorDraft("default");
    });

    getOptionalElement<HTMLInputElement>("#editorPlaceByCenter")?.addEventListener("change", (event) => {
      editorPlaceByCenter = (event.currentTarget as HTMLInputElement).checked;
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
        const partId = button.getAttribute("data-part-open-select");
        if (!partId) {
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
        partDesignerDialogOpen = false;
        loadPartIntoDesignerSlots(source);
        renderPanels();
      });
    });

    document.querySelectorAll<HTMLButtonElement>("button[data-part-open-copy]").forEach((button) => {
      button.addEventListener("click", () => {
        const partId = button.getAttribute("data-part-open-copy");
        if (!partId) {
          return;
        }
        const source = parts.find((part) => part.id === partId);
        if (!source) {
          return;
        }
        recenterEditorViewForScreen("partEditor");
        const copy = makeCopyPart(source);
        partDesignerSelectedId = copy.id;
        partDesignerDialogOpen = false;
        loadPartIntoDesignerSlots(copy);
        addLog(`Created part copy: ${copy.name}`, "good");
        renderPanels();
      });
    });
    document.querySelectorAll<HTMLButtonElement>("button[data-part-open-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        const partId = button.getAttribute("data-part-open-delete");
        if (!partId) {
          return;
        }
        const source = parts.find((part) => part.id === partId);
        if (!source) {
          return;
        }
        if (!window.confirm(`Delete part "${source.name}" (${source.id})?`)) {
          return;
        }
        const deletedUser = await deleteUserPartFromStore(partId);
        const deletedDefault = await deleteDefaultPartFromStore(partId);
        if (!deletedUser && !deletedDefault) {
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

    getOptionalElement<HTMLInputElement>("#partId")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value;
      partDesignerDraft.id = makeUniquePartId(slugifyPartId(raw || partDesignerDraft.name || "custom-part"));
      updateSelectedInfo();
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
        partDesignerRequireStructureBelowAnchor = false;
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
          shootAngleDeg: undefined,
          projectileSpeed: undefined,
          projectileGravity: undefined,
          spreadDeg: undefined,
          explosiveDeliveryMode: undefined,
          explosiveBlastRadius: undefined,
          explosiveBlastDamage: undefined,
          explosiveFalloffPower: undefined,
          explosiveFuse: undefined,
          explosiveFuseTime: undefined,
          trackingTurnRateDegPerSec: undefined,
          controlImpairFactor: undefined,
          controlDuration: undefined,
          loaderSupports: undefined,
          loaderLoadMultiplier: undefined,
          loaderFastOperation: undefined,
          loaderMinLoadTime: undefined,
          loaderStoreCapacity: undefined,
          loaderMinBurstInterval: undefined,
        };
        const materialId = (partDesignerDraft.properties?.materialId ?? "basic") as MaterialId;
        const material = MATERIALS[materialId] ?? MATERIALS.basic;
        partDesignerDraft.properties = {
          ...(partDesignerDraft.properties ?? {}),
          materialId,
          materialArmor: partDesignerDraft.properties?.materialArmor ?? material.armor,
          materialRecoverPerSecond: partDesignerDraft.properties?.materialRecoverPerSecond ?? material.recoverPerSecond,
          materialColor: partDesignerDraft.properties?.materialColor ?? material.color,
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
        weaponType: partDesignerDraft.layer === "structure" ? undefined : defaults.weaponType,
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
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        hp: Number.isFinite(numeric) ? numeric : undefined,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLSelectElement>("#partMaterialId")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value as MaterialId;
      if (!(value in MATERIALS)) {
        return;
      }
      const base = MATERIALS[value];
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        materialId: value,
        materialArmor: base.armor,
        materialRecoverPerSecond: base.recoverPerSecond,
        materialColor: base.color,
        hp: base.hp,
      };
      partDesignerDraft.stats = {
        ...(partDesignerDraft.stats ?? {}),
        mass: base.mass,
      };
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partMaterialArmor")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        materialArmor: Number.isFinite(numeric) ? numeric : undefined,
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
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partMaterialColor")?.addEventListener("input", (event) => {
      const value = (event.currentTarget as HTMLInputElement).value.trim();
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        materialColor: value.length > 0 ? value : undefined,
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLInputElement>("#partStructureMass")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value.trim();
      const numeric = raw.length > 0 ? Number(raw) : Number.NaN;
      partDesignerDraft.stats = {
        ...(partDesignerDraft.stats ?? {}),
        mass: Number.isFinite(numeric) ? numeric : undefined,
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
        partDesignerDraft.properties.weaponType = undefined;
        partDesignerDraft.stats = {
          ...(partDesignerDraft.stats ?? {}),
          recoil: undefined,
          hitImpulse: undefined,
          damage: undefined,
          range: undefined,
          cooldown: undefined,
          shootAngleDeg: undefined,
          projectileSpeed: undefined,
          projectileGravity: undefined,
          spreadDeg: undefined,
          explosiveDeliveryMode: undefined,
          explosiveBlastRadius: undefined,
          explosiveBlastDamage: undefined,
          explosiveFalloffPower: undefined,
          explosiveFuse: undefined,
          explosiveFuseTime: undefined,
          trackingTurnRateDegPerSec: undefined,
          controlImpairFactor: undefined,
          controlDuration: undefined,
        };
      } else if (!partDesignerDraft.properties.weaponType) {
        partDesignerDraft.properties.weaponType = "rapid-fire";
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
          loaderStoreCapacity: undefined,
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
    getOptionalElement<HTMLSelectElement>("#partWeaponType")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        weaponType: value as NonNullable<PartDefinition["properties"]>["weaponType"],
      };
      renderPanels();
    });
    getOptionalElement<HTMLInputElement>("#partLoaderSupports")?.addEventListener("input", (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value;
      const supportsRaw = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const supports = parseWeaponClassList(supportsRaw);
      partDesignerDraft.stats = {
        ...(partDesignerDraft.stats ?? {}),
        loaderSupports: supports.length > 0 ? supports : undefined,
      };
      partDesignerDraft.properties = {
        ...(partDesignerDraft.properties ?? {}),
        loaderServesTags: supports.length > 0 ? supports : undefined,
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
    getOptionalElement<HTMLSelectElement>("#partExplosiveDeliveryMode")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      partDesignerDraft.stats = {
        ...(partDesignerDraft.stats ?? {}),
        explosiveDeliveryMode: value === "bomb" ? "bomb" : "shell",
      };
      updateSelectedInfo();
    });
    getOptionalElement<HTMLSelectElement>("#partExplosiveFuse")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      partDesignerDraft.stats = {
        ...(partDesignerDraft.stats ?? {}),
        explosiveFuse: value === "timed" ? "timed" : "impact",
      };
      updateSelectedInfo();
    });

    getOptionalElement<HTMLInputElement>("#partRequireStructureBelowAnchor")?.addEventListener("change", (event) => {
      partDesignerRequireStructureBelowAnchor = (event.currentTarget as HTMLInputElement).checked;
      recalcPartDraftFromSlots();
      renderPanels();
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
    ): void => {
      getOptionalElement<HTMLInputElement>(selector)?.addEventListener("input", (event) => {
        const raw = (event.currentTarget as HTMLInputElement).value;
        const numeric = raw.trim().length > 0 ? Number(raw) : Number.NaN;
        const next = Number.isFinite(numeric) ? numeric : undefined;
        partDesignerDraft.stats = {
          ...(partDesignerDraft.stats ?? {}),
          [key]: next,
        };
      });
    };
    bindRuntimeInput("#partMass", "mass");
    bindRuntimeInput("#partHpMul", "hpMul");
    bindRuntimeInput("#partPower", "power");
    bindRuntimeInput("#partMaxSpeed", "maxSpeed");
    bindRuntimeInput("#partRecoil", "recoil");
    bindRuntimeInput("#partHitImpulse", "hitImpulse");
    bindRuntimeInput("#partDamage", "damage");
    bindRuntimeInput("#partRange", "range");
    bindRuntimeInput("#partCooldown", "cooldown");
    bindRuntimeInput("#partShootAngle", "shootAngleDeg");
    bindRuntimeInput("#partProjectileSpeed", "projectileSpeed");
    bindRuntimeInput("#partProjectileGravity", "projectileGravity");
    bindRuntimeInput("#partSpread", "spreadDeg");
    bindRuntimeInput("#partExplosiveFuseTime", "explosiveFuseTime");
    bindRuntimeInput("#partExplosiveBlastRadius", "explosiveBlastRadius");
    bindRuntimeInput("#partExplosiveBlastDamage", "explosiveBlastDamage");
    bindRuntimeInput("#partExplosiveFalloffPower", "explosiveFalloffPower");
    bindRuntimeInput("#partTrackingTurnRate", "trackingTurnRateDegPerSec");
    bindRuntimeInput("#partControlImpairFactor", "controlImpairFactor");
    bindRuntimeInput("#partControlDuration", "controlDuration");
    bindRuntimeInput("#partLoaderMinLoadTime", "loaderMinLoadTime");
    bindRuntimeInput("#partLoaderStoreCapacity", "loaderStoreCapacity");
    bindRuntimeInput("#partLoaderMinBurstInterval", "loaderMinBurstInterval");
    bindRuntimeInput("#partGasCost", "gasCost");

    getOptionalElement<HTMLButtonElement>("#btnNewPartDraft")?.addEventListener("click", () => {
      const newName = "Custom Part";
      const nextId = makeUniquePartId(slugifyPartId(newName));
      partDesignerDraft = createDefaultPartDraft(nextId, newName);
      partDesignerDraft.anchor = { x: 0, y: 0 };
      partDesignerDraft.boxes = [];
      partDesignerLastFunctionalBaseComponent = partDesignerDraft.baseComponent;
      partDesignerCategoryEdited = false;
      partDesignerSubcategoryEdited = false;
      partDesignerSelectedId = partDesignerDraft.id;
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
      const validation = validatePartDefinitionDetailed(snapshot);
      for (const issue of validation.errors) {
        addLog(`Part Error: ${issue}`, "bad");
      }
      for (const issue of validation.warnings) {
        addLog(`Part Warning: ${issue}`, "warn");
      }
      const saved = await saveDefaultPartToStore(snapshot);
      if (!saved) {
        addLog("Failed to save part", "bad");
        return;
      }
      await refreshPartsFromStore();
      await refreshTemplatesFromStore();
      partDesignerSelectedId = snapshot.id;
      const reloaded = parts.find((part) => part.id === snapshot.id) ?? snapshot;
      loadPartIntoDesignerSlots(reloaded);
      addLog(`Saved part: ${snapshot.name}`, "good");
      renderPanels();
    };

    getOptionalElement<HTMLButtonElement>("#btnSavePartDraft")?.addEventListener("click", async () => {
      await savePartDraft();
    });
  };

  tabs.base.addEventListener("click", () => setScreen("base"));
  tabs.map.addEventListener("click", () => setScreen("map"));
  tabs.battle.addEventListener("click", () => setScreen("battle"));
  tabs.testArena.addEventListener("click", () => {
    setScreen("testArena");
    renderPanels();
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
      loadPartIntoDesignerSlots(selected);
    }
    renderPanels();
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
    editorSelection = value;
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
      debugDisplayLayer = false;
      debugPartHpOverlay = false;
      battle.setDebugDrawEnabled(false);
      battle.setDebugTargetLineEnabled(false);
      battle.setDisplayLayerEnabled(false);
      battle.setDebugPartHpEnabled(false);
      return;
    }
    debugUnlimitedResources = debugResourcesChk.checked;
    debugVisual = debugVisualChk.checked;
    debugTargetLines = debugTargetLineChk.checked;
    debugDisplayLayer = debugDisplayLayerChk.checked;
    debugPartHpOverlay = debugPartHpChk.checked;
    syncDebugServerState();
    battle.setDebugDrawEnabled(isDebugVisual());
    battle.setDebugTargetLineEnabled(isDebugTargetLines());
    battle.setDisplayLayerEnabled(debugDisplayLayer);
    battle.setDebugPartHpEnabled(debugPartHpOverlay);
    addLog(
      `Debug options: resources=${debugUnlimitedResources ? "on" : "off"}, visual=${debugVisual ? "on" : "off"}, targetLines=${debugTargetLines ? "on" : "off"}, display=${debugDisplayLayer ? "on" : "off"}, partHp=${debugPartHpOverlay ? "on" : "off"}`,
      "warn",
    );
    renderPanels();
  };

  debugResourcesChk.addEventListener("change", applyDebugFlags);
  debugVisualChk.addEventListener("change", applyDebugFlags);
  debugTargetLineChk.addEventListener("change", applyDebugFlags);
  debugDisplayLayerChk.addEventListener("change", applyDebugFlags);
  debugPartHpChk.addEventListener("change", applyDebugFlags);
  btnOpenPartDesigner.addEventListener("click", () => {
    setScreen("partEditor");
    const selected = parts.find((part) => part.id === partDesignerSelectedId);
    if (selected) {
      partDesignerSelectedId = selected.id;
      loadPartIntoDesignerSlots(selected);
    }
    renderPanels();
  });
  debugResourcesChk.checked = replayMode ? false : true;
  debugVisualChk.checked = replayMode ? false : true;
  debugTargetLineChk.checked = replayMode ? false : true;
  debugDisplayLayerChk.checked = false;
  debugPartHpChk.checked = true;
  applyDebugFlags();

  window.addEventListener("keydown", (event) => {
    if (isTypingInFormField(event.target)) {
      return;
    }

    if (isEditorScreen()) {
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

  canvasViewport.addEventListener("mousedown", (event) => {
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    if (isEditorScreen()) {
      const targetCanvas = activeEditorCanvas();
      const { x, y } = getPointerOnCanvas(event, targetCanvas);
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
    const { x, y } = getPointerOnCanvas(event, canvas);
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
    }
    battle.handlePointerUp();
  });

  canvasViewport.addEventListener("mousemove", (event) => {
    if (isEditorScreen()) {
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
    const { x, y } = getPointerOnCanvas(event, canvas);
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
        loadPartIntoDesignerSlots(selectedPart);
      }
      await refreshTemplatesFromStore();
      addLog("Loaded part catalog and object templates", "good");
      renderPanels();
    })
    .catch(() => {
      addLog("Failed to load part/template data from store", "bad");
      renderPanels();
    });

  let panelBucket = -1;
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
    if (!(isBattleScreen() && battle.getState().active)) {
      return;
    }
    battle.update(dt, keys);
    logTestArenaFireBlockedReasons();
    followSelectedUnitWithCamera();
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
        battle.draw(now);
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
