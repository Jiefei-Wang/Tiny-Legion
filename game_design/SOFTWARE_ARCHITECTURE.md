# Web Game Software Architecture

## 0. Current Implementation Reality

This document includes target architecture and current shipped implementation.

Current active stack/runtime:

- Runtime: Browser (`Phaser 3` on HTML5 Canvas; DOM developer panels)
- Language: `TypeScript`
- Build tool: `Vite`
- Active app path: `vip/`
- Shared logic package: `game-core/`
- Legacy prototype path: `webgame/` (reference only)

Implemented gameplay architecture highlights:

- Ground combat: continuous `X/Y` movement zone
- Air combat: `X/Z` abstraction (rendered on screen vertical axis)
- Air propulsion uses a single isotropic `jetEngine` model.
- Unit layers: `structure + functional + display`
- Runtime rendering resolves display survivability by stable structure-cell ID, but positions display and functional layers from their authored `x/y` coordinates. Destruction therefore cannot compact a row or change its local origin.
- AI modules split by concern:
  - `src/ai/composite/composite-ai.ts` (shared composite interface)
  - `src/ai/composite/baseline-modules.ts` (baseline target/movement/shoot modules)
  - `src/ai/decision-tree/combat-decision-tree.ts` (legacy compatibility wrapper)
  - `src/ai/targeting/target-selector.ts`
  - `src/ai/shooting/ballistic-aim.ts`
  - `src/ai/movement/threat-movement.ts`
  - `src/ai/shooting/weapon-ai-policy.ts`
- Multi-weapon units with independent cooldown timers, per-slot manual-control toggles, and per-slot auto-fire toggles
- AI shoot input contract includes per-slot resolved firepoint world coordinates plus resolved projectile speed/gravity from runtime weapon stats (with fallback), so aim solve and projectile spawn use consistent ballistics.
- Player-controlled manual slots suppress auto-fire execution at runtime without mutating stored auto-fire flags
- Browser battlefield input polls the standard Gamepad API each simulation update. Deadzoned left/right stick axes and right-trigger/right-bumper fire state extend `KeyState`, then flow through the same `playerInputToCommand()` and `UnitCommand` execution path as keyboard/mouse input.
- Manual target-dependent weapons resolve an intended enemy by scoring valid enemies along the forward aim ray; the resulting target ID/Y is carried by `FireRequest` for homing behavior, while non-tracking manual weapons remain angle-only.
- Top-level mode tabs include dedicated `Template Editor` and `Part Editor` entries (alongside `Base`/`Map`/`Battle`)
- The production shell groups navigation into `Campaign` and `Developer Tools`, with context-aware inspector titles and wider authoring/scenario layouts.
- Base and Map use `#managementCenter` as a DOM workspace in the central panel; battle/Test Arena/editors retain their canvas workspaces.
- The Base management workspace renders the compound before secondary research content. Live base metrics are scene overlays, while a single bottom construction dock is populated from the selected empty `BaseBuildingSlot` and its size-compatible `BUILDING_CATALOG` entries.
- Developer destinations are routed through the top-bar `#developerMenu`; the left campaign navigation and active panel are separated by a pointer-driven, locally persisted vertical resizer.
- `#debugMenu` reuses the Developer Tools dropdown shell and floating popover pattern while retaining dedicated checkbox controls for runtime overlays and resource debugging.
- `Test Arena` is a dedicated top-level tab for debug battles (not part of the map node list)
- Display layer visibility is debug-controlled (top-bar `Debug Options`) and defaults to OFF in battle runtime
- In-app debug options plus local runtime log pipeline (`/__debug/*` -> `vip/.debug/runtime.log`)
- Battle simulation defaults are centralized in shared balance config (`battlefield.ts`) including dimensions, ground height, air layer ratios, air physics constants, battle rules (salvage refund factor), and unit soft-separation tuning constants - all reused by browser + headless/arena paths
- Test Arena supports uncapped runtime battlefield simulation-size overrides (`W`/`H`) and ground-height tuning in the browser app; display zoom and canvas resolution remain separate view-only concerns. Battle entry derives its default zoom from the live viewport and lane bounds (`airMinZ` through `groundMaxY`), and Test Arena recomputes that vertical fit when runtime battlefield dimensions change.
- Strategic layer uses `RealTimeCampaign`: the fixed game loop advances continuous income, timed building/research jobs, deployment ETAs, and off-screen campaign battles (Test Arena behavior remains isolated)
- `game-core/src/gameplay/campaign/real-time-campaign.ts` owns building catalogs, four sized Main Base slots, timed jobs, delivery capacity, nearest-base logistics quotes, distance cost, and outpost support rules
- `MapNode` carries optional strategic metadata (`kind`, routed `links`, map coordinates, home distance, yields, deposits, outpost roster/range); remote bases are logistics-only and never receive building slots
- Campaign art assets live under `vip/public/assets/campaign/` as optimized WebP scene/facility art plus an alpha PNG command-bunker sprite. Base and Map consume scene/facility assets through DOM/CSS composition. Phaser independently preloads `battle-air-layer.webp` and `battle-ground-layer.webp`, resizes their boundary from the runtime `groundMinY`, positions side-specific bunker instances behind its immediate-mode effects layer, and keeps simulation state renderer-independent.
- `BattleSession` owns logical `battlefieldWidth`/`battlefieldHeight` values independently of its optional legacy Canvas 2D drawing surface. Changing battlefield size updates simulation bounds only and never resizes a browser canvas; browser, headless match, leaderboard, and Vite scenario normalization enforce minimum dimensions without an upper cap.
- Phaser's visible canvas tracks the CSS viewport, with backing pixel density authored by `display/battle.yaml.canvas.resolutionScale`. CSS pan/zoom transforms are not used: the Phaser camera maps the shared world-to-screen offset and zoom, pointer input applies the inverse mapping, and spatial audio uses the same visible world center/width.
- The app stores battle view offsets as a top-left screen transform. The Phaser renderer converts them to Phaser's center-anchored zoom/scroll coordinates, counter-transforms its fixed debug HUD, and keeps manual right-drag panning persistent by suspending selected-unit follow until the next selection.
- Phaser's tactical overlay reads renderer-safe `BattleSession` state: per-cell structure geometry for hitboxes, `getSelectedWeaponRange(...)` for each craft's effective range ring, velocity for movement vectors, and `aiDebugTargetId` for faction-colored aim lines/reticles. The immediate-mode pass culls units, projectiles, particles, debris, beams, explosions, and debug sources outside the camera rectangle, while simulation continues for all entities. Projectile images are retained in a reusable pool rather than destroyed and recreated every frame. Selected/controlled range rings receive stronger emphasis; the two related Runtime Debug checkboxes default ON outside replay mode.
- Phaser derives crack density and low-HP pixel smoke directly from each live structure cell's strain/threshold ratio. Shared simulation state carries short-lived `blockExplosions` records (position, lifetime, deterministic seed, and one of three variants), allowing browser presentation to render varied pixel bursts while headless runtime owns effect timing.
- `UnitInstance.weaponAimAngles` stores per-slot presentation aim. Command processing updates it from manual/AI fire requests, and `BattleSession.getWeaponVisualState(...)` exposes the clamped angle plus exact projectile muzzle geometry. Phaser draws each live barrel from its attachment center to that muzzle, and projectile creation reuses the same muzzle calculation so shots originate at the visible barrel tip.

## 1. Target Stack

Use a browser-first stack with TypeScript for maintainability.

- Runtime: Browser (`HTML5`, `Canvas/WebGL`, `WebAudio`)
- Language: `TypeScript` (compiles to JS)
- Build tool: `Vite`
- Rendering: `Phaser 3` for battles; direct Canvas 2D remains scoped to the template and part editors
- Physics/combat model: custom deterministic simulation modules

---

## 2. Package Plan

## 2.1 Must-Have Packages

| Package | Why needed |
| --- | --- |
| `vite` | Fast dev/build pipeline for web game iteration |
| `typescript` | Type safety for large modular systems |
| `vite` | Dev/build pipeline |
| `typescript` | Type safety and maintainability |
| `phaser` | Battle scene lifecycle, Graphics rendering, and WebAudio integration |

## 2.2 Optional Expansion Packages (Future)

| Package | Why useful |
| --- | --- |
| `@dimforge/rapier2d-compat` | If migrating to rigid-body physics engine |
| `zustand` | If state complexity outgrows current app orchestration |
| `howler` | If audio system is expanded |

## 2.3 Optional Packages

| Package | Use case |
| --- | --- |
| `socket.io-client` | Real-time multiplayer transport |
| `colyseus.js` | Authoritative multiplayer room/session model |
| `idb-keyval` | Local persistence via IndexedDB |
| `stats.js` | FPS/frametime overlay during tuning |

## 2.4 Physics/Renderer Alternatives

### Physics options

- `@dimforge/rapier2d-compat` (recommended)
  - Pros: performant, impulse/contact features, good for recoil/knockback model.
  - Cons: WASM init/loading complexity.
- `planck-js` (Box2D-style)
  - Pros: deterministic-friendly style and proven 2D gameplay behavior.
  - Cons: slower at large counts vs modern optimized WASM engines.
- `matter-js`
  - Pros: simple API and fast prototyping.
  - Cons: weaker for heavy unit counts and strict physical consistency.

### Renderer

- `phaser` is the active browser battle renderer. The shared simulation does not import Phaser, keeping headless Arena execution DOM-free.

---

## 3. High-Level Architecture

Split implementation into 4 runtime layers plus 2 integration surfaces:

1. **Core Simulation Layer**
   - Deterministic-ish fixed-timestep world update.
   - Physics, combat, unit state, AI decisions.
2. **Presentation Layer**
   - Phaser rendering, debug overlays, VFX, and hit audio.
3. **Game Meta Layer**
   - Base building, map progression, unlocks, commander skill, economy.
4. **Platform Layer**
   - Save/load, settings, input devices, telemetry, networking.

Integration surfaces:

1. **Developer Interface**
   - Debug options UI + `/__debug/*` middleware (`toggle`, `log`, `probe`).
   - Runtime inspection without changing gameplay logic modules.
2. **AI Arena Interface**
   - Headless match/training/eval/replay in `arena/`.
   - Consumes shared logic from `game-core` directly.

Rule: presentation can read simulation state, but simulation cannot depend on rendering classes.

---

## 4. Module Breakdown (Code Structure)

Current implemented structure (abridged):

```text
game-core/
  assets/audio/              (canonical recorded samples + attribution)
  scripts/generate-config.mjs
  src/
    ai/
    config/
      ai/*.yaml
      balance/*.yaml
      display/*.yaml
      editor/*.yaml
      sound/*.yaml
      generated/game-config.generated.ts
    core/ids/
    gameplay/
      battle/battle-session.ts
      map/
    parts/
      part-geometry.ts
      part-schema.ts
      part-validation.ts
    simulation/
    templates/template-schema.ts
    templates/template-validation.ts
    types.ts

vip/src/
  app/
    bootstrap.ts
    game-loop.ts
    part-store.ts          (fetch/save adapter over game-core part schema/validation)
    template-store.ts      (fetch/save adapter over game-core template schema/validation)
  ai|config|core|gameplay|simulation|types.ts
    (thin re-exports to game-core)

vip/templates/
  default/*.json
  user/*.json

vip/parts/
  default/*.json
  user/*.json
```

Arena training/runtime package (implemented):

```text
arena/src/
  ai/
    ai-schema.ts
    composite-controller.ts
  match/
    match-types.ts
    mirrored-series.ts
    run-match.ts
    run-single-match.ts
  config/
    leaderboard-scenario.ts
  spawn/
    spawn-schema.ts
    families.ts
    families/spawn-baseline.ts
    families/spawn-weighted.ts
  train/
    run-composite-training.ts
    fitness.ts
    param-genetics.ts
  worker/
    match-worker.ts
  replay/
    run-replay.ts
    open-replay-ui.ts
```

Notes:

- Arena composite controller resolves baseline, calibrated skill-tier, and trainable module-family IDs to their game-core target/movement/shoot implementations.
- `run-composite-training.ts` performs phased headless compare/optimization over decision-tree module parameters.

Arena-specific architecture notes:

- Arena runtime imports battle/simulation/template domain code directly from `game-core/src/*` (no dynamic loading from `vip/.headless-dist`).
- Training and evaluation run headless through `WorkerPool` + `match-worker.ts` for parallel CPU usage.
- Model ranking now prioritizes `winRateLowerBound` then `winRate`, then `score`.
- Arena composite AI path can supply per-side `{ target, movement, shoot }` module specs that instantiate game-core `createCompositeAiController(...)`.
- `ShootDecision`/`CombatDecision` carry normalized `firePlans[]`; `BattleSession.appendFireRequestsFromDecision(...)` deduplicates slots and converts them to ordinary `FireRequest`s, keeping enforcement centralized.
- Headless `runMatch(...)` resets the shared unit UID counter before each seeded match. Unit-ID-derived deterministic jink phases therefore remain identical regardless of worker reuse, prior matches, or evaluation order.
- Built-ins resolve through `levelCompositeConfig(...)`, `game-core/src/ai/composite/level-modules.ts`, and the property-only classifier in `craft-profile.ts`. L1 preserves the former L2 capability-aware bundle. The current tuples are L1 `t2/m6/s1`, L2 `t47/m95/s42`, L3 `t47/m95/s49`, L4 `t47/m97/s54`, and L5 `t47/m99/s93`. Level 5's shoot module preserves the strategic target but performs a per-weapon kinematic feasibility check from firing axis, effective range, projectile speed, and relative target velocity. A weapon redirects to a property-ranked reachable local threat only when it cannot intercept the strategic target; independent slots can therefore fire at different enemies without craft/part identity checks.
- `run-composite-training.ts` optimizes modules in staged order (`shoot -> movement -> target`) with phase scenarios:
  - no-base 1v1,
  - no-base NvN,
  - full base battle,
  - leaderboard-nearby ladder (`p4-leaderboard`) against saved models with similar Elo score.
- Composite phase scenarios are config-driven from `arena/composite-training.phases.json` (override via `--phaseConfig`) with per-phase template wildcard filters and battlefield params (`width`, `height`, optional `groundHeight`).
- `train-composite` CLI now supports:
  - scoped module optimization (`--scope shoot|movement|target|all`),
  - per-module source selection (`baseline|new|trained:<path>`),
  - optional seed composite loading (`--seedComposite`).
- `cli.ts` lazy-loads command implementations and supports `match`, `train-composite`, `eval-levels`, `eval-tiers`, and `replay` commands.
- `match` runtime is composite-only (`familyId: "composite"`); baseline-vs-baseline test matches are represented by baseline module bundles on both sides.
- Replay UI (`arena-ui/src/main.ts`) still uses game interface bootstrap (`vip/src/app/bootstrap.ts`) while consuming AI/simulation primitives from `game-core`.
- Game dev server exposes `/__arena/composite/latest` for Test Arena to load latest trained composite spec from `arena/.arena-data/runs/*/best-composite.json`.
- Game dev server exposes `/__arena/composite/leaderboard` for in-game ranking entries backed by persistent match-based rating storage (`arena/.arena-data/leaderboard/composite-elo.json`).
- Game dev server exposes `/__arena/composite/models` for genuine saved composed-model artifacts only. The local composed selector supplies certified L1-L6 built-ins, while `/__arena/composite/leaderboard/compete` ranks the same six-level pool without duplicating built-ins as saved models.
- Leaderboard compete endpoint executes batched rounds in parallel using arena worker threads (`arena/.dist/.../worker-pool.js`) with all detected CPU cores when available, and falls back to single-thread execution if worker runtime is unavailable.
- Leaderboard compete and `eval-levels` load `p4-leaderboard` from `arena/composite-training.phases.json` using a working-directory-independent resolver. `useGlobalBattlefield` resolves `BATTLEFIELD_WIDTH`, `BATTLEFIELD_HEIGHT`, and `DEFAULT_GROUND_HEIGHT` from the same authored balance config used by Test Arena (currently `3000x1500` and `600`), while phase four retains four fixed initial units per side, zero reinforcement gas, a `120s` limit, and its shared node/base/spawn settings.
- Arena match loading parses the runtime `vip/parts/{default,user}` and `vip/templates/{default,user}` catalogs, including loader normalization, rather than silently falling back to obsolete arena-only templates. Template filters match IDs or display names.
- Arena filters out templates with validation errors, builds the roster from every remaining catalog ID, and seeded-shuffles starter groups so distinct valid craft are used before any repeat. There is no preferred template-ID list.
- Combat AI receives resolved per-slot weapon capabilities (`projectileClass`, effective range, damage, penetration, spread, blast radius, tracking rate, ballistics, angle limits, cooldown, minimum fire interval, maximum ammo, loaded ammo, and loader dependency). Skill-tier targeting/shooting and craft role classification consume those capabilities plus live mobility/structure state and never branch on template/part identity.
- Spawn-family rosters carry generic template metadata (gas cost, unit layer, structure-cell count, weapon count). `spawn-weighted` derives weights from those attributes and no longer infers roles from template-name fragments such as `tank` or `scout`.
- Each leaderboard round runs both side assignments concurrently with one seed. `mirrored-series.ts` compares side-neutral margins lexicographically in this order: destroyed gas value, destroyed craft count, surviving unit integrity, operational units, base HP, then gas worth. Deadline resolution uses the same craft-first priorities, so base damage cannot outrank craft combat and exact equality remains a tie.
- `level-modules.ts` derives an awareness radius from desired range, maximum weapon range, and mobility. Any live enemy within that radius forces a craft attack point and suppresses every weapon's base fallback; only an all-far/no-enemy state permits base engagement.
- `arena/src/eval/verify-ai-rules.ts` asserts awareness-boundary behavior, craft-first scoring over a winning base rush, and equality between leaderboard battlefield resolution and the authored Test Arena defaults.
- Persistent leaderboard storage is schema version `8`; the version bump invalidates ratings from the base-first score and replaced level definitions. It saves Elo/global results plus per-pair W/L/T. Manual-pair competition cycles the same 16 deterministic seeds as level certification, and the leaderboard API/UI auto-loads and displays each level's persisted win rate against its previous level.
- Elo ratings use pairwise diminishing-K updates (tracked by per-pair match count in leaderboard store) so repeated battles between the same two models converge without hard rating caps.

Map node metadata supports test-only battle tuning via optional fields on `MapNode`:

- `testEnemyMinActive` keeps a minimum enemy unit count active in battle.
- `testEnemyInfiniteGas` bypasses enemy gas drain so test scenarios can sustain pressure.
- `testBaseHpOverride` sets both player/enemy battle base HP and max HP for long-running test battles.
- The `Test Arena` tab uses these overrides while skipping campaign rewards/ownership changes.
- Test Arena UI controls for enemy count / battlefield size / zoom apply on input commit (`Enter` or blur) without extra apply buttons.
- Test Arena enemy/player spawn selection uses one shared template expansion whose rows expose Player and Enemy checkboxes together.
- Test Arena Unit tab includes two auto-spawn toggles (`enemy side`, `player side`, both default ON), side count inputs (both default `4`), and the shared craft expansion (all available templates selected by default); runtime keeps alive units per side at/above configured targets by auto-spawning from the selected side templates when enabled.
- Test Arena includes a separate collapsible Manual Spawn tab. It calls `BattleSession.arenaDeploy(...)` once for the chosen side/template with arena-style free deployment and ignored unit caps, and is enabled only while Test Arena is active.
- Browser bootstrap auto-persists Test Arena counts, craft filters, auto-spawn/invincibility toggles, battlefield geometry, AI selections, and manual-spawn choices under `forge-command.test-arena-settings.v1`; saved template IDs are reconciled after the file-backed template catalog loads.
- Test Arena start path clears default starter units so no extra non-auto units remain.
- Test Arena Unit tab includes a `Clear all units` action that removes all currently active units from the running Test Arena session.
- Battle Ops panel includes spawn-side toggles (`Player Spawn` / `Enemy Spawn`, default player); enemy-side deploy via Battle Ops is restricted to active Test Arena sessions.
- Test Arena AI control supports side-level composed-model selection (full `{ target, movement, shoot }` bundle) plus a `2 x 3` component grid fallback for custom per-module composition.
- Dropdown inventory is populated from:
  - built-in module presets,
  - saved module specs enumerated from `arena/.arena-data/runs/*/best-composite.json` via dev endpoint `GET /__arena/composite/modules`.
- Selecting a dropdown value maps directly to one composite module spec (`{ familyId, params }`) and reapplies controller wiring immediately.
- Left-side mode menu includes a dedicated `Leaderboard` screen that fetches ranked entries from `GET /__arena/composite/leaderboard`.
- Leaderboard screen includes controls to trigger server-side compare batches (`random pair`, `unranked vs random`, `manual pair`) via `POST /__arena/composite/leaderboard/compete`.
- Developer Tools includes a DOM-only `Craft Arena` screen backed by versioned browser-local settings, pair definitions, and results. Version 4 persistence moves quantity into the global settings alongside duration, shared composed AI, and Test Arena battlefield geometry. Missing unordered template pairs are synthesized automatically so the center can render a complete craft-by-craft heat map.
- The heat map has destroyed-count and gas-wasted tabs. A cell displays the row craft's raw result, while its diverging color is normalized from the signed difference against the column craft. Both mirrored matrix cells point to the same fixed-orientation scenario. Cell selection is presentation state and drives the existing right inspector with both sides' loss totals, run metadata, and a rerun action.
- `POST /__arena/craft-arena/simulate` validates one fixed-orientation matchup and executes exactly one headless match through the shared worker pool (with sequential single-thread fallback). Craft A is runtime Player/left and Craft B is runtime Enemy/right. The match uses `scenario.replenishInitialLineup` to replace losses immediately after each simulation update and before no-base elimination, maintaining the requested counts until the duration deadline. The endpoint returns side-mapped loss totals only and never writes arena data or leaderboard ratings.
- `GET /__arena/craft-arena/seed` exposes an optional ignored `arena/.arena-data/craft-arena/scenario-seed.json`. VIP imports each seed revision into versioned browser storage once, replacing matching seed IDs during that import only, so generated batch results remain viewable without overriding later browser-local changes.
- Selection format and examples are documented in `vip/AI_COMPONENT_CONFIG.md`.

Template/editor architecture notes:

- `ScreenMode` now separates editor surfaces into `templateEditor` and `partEditor` (no nested editor workspace switch state) and includes `testArena`.
- The left mode pane tab strip is rendered as a 2x3 grid and routes directly to each screen.
- `template-validation.ts` is an isolated validation module with severity output (`errors` + `warnings`).
- `template-schema.ts` parse pipeline supports placement sanitization plus loader coverage normalization, and middleware/headless flows persist the normalized JSON so editor/headless/runtime stay aligned.
- Functional placement and validation now resolve through part catalog definitions (`partId` + normalized runtime component mapping), with `partType`/`partCategory`/`partProperties` as primary authoring fields.
- `parts/part-schema.ts` + `parts/part-validation.ts` define part parsing and validation severity output.
- Multi-round weapon parsing normalizes `partProperties.minFireInterval` to `0.2`, and battle firing enforces that weapon-owned interval between loaded shots.
- Runtime/editor part catalog merge order is file-backed defaults -> user overrides (no implicit built-in part entries in `/__parts/*` payloads).
- Part Designer uses dedicated default-config helpers (`vip/src/app/part-default-config.ts`) to seed values when creating a new part or switching part type/category.
- Part Editor category options are driven by the canonical file-backed gameplay catalog for every part type. Technical schema families such as `bullet`, `beam`, `vehicle`, and `jet` remain internal and are not presented as gameplay categories.
- Part saves use the normalized successful PUT response as the authoritative editor draft. Catalog GET requests are `no-store`, and a post-save refresh cannot overwrite the saved draft with stale pre-save data.
- Part Editor geometry writes `boxes` and the legacy `cells` mirror together. Parsing treats `boxes` as authoritative when both exist, preventing stale legacy cells from restoring an older footprint after save.
- Loader injection remains configurable in parse options; current dev/headless normalization persists the injected-loader result to template JSON.
- Editor save does not block on warnings/errors; categories are surfaced in UI/logs for developer feedback.
- Battle deploy/spawn paths validate templates and block creation when `errors` are present.
- Template editor displays computed template gas (sum of part gas values); template-level gas override input is removed.
- Editor `Open` workflow supports direct editing of existing templates and one-click copy creation (`-copy` suffix).
- Template `Open` list is grouped by template type (`ground` then `air`) and sorted by computed gas cost ascending within each group, with gas shown per row.
- Template IDs are internal positive integers and auto-generated for new/copy templates; ID editing is removed from UI.

---

## 5. Critical Domain Rules in Code

Encode your game rules as explicit modules (not scattered checks):

- `control-unit-rules.ts`
  - exactly one control unit per craft.
  - template validation and runtime instantiation reject zero or multiple controls.
  - the control part's `computing` value limits the sum of each placed non-control functional part's `computingConsumption`; each part is charged once regardless of footprint size, missing values default to zero, and the control part itself is excluded.
  - a ground object becomes a stationary, damageable wreck if control is lost or it lacks either a usable ground engine or a fireable weapon. Wreck entry applies a deterministic-random 1%-50% initial HP loss per surviving cell, records that post-entry HP in `groundWreckInitialCellHp`, and linearly scales each cell toward zero over the configured 10-second lifetime. Aircraft that lose control enter the battle session's direct vertical crash path and are destroyed on ground impact.
- `damage-model.ts`
  - applies localized structure damage with either normal armor deduction or explicit armor bypass for relayed functional hits.
  - applies per-cell strain recovery using material `recoverPerSecond`.
  - exposes the canonical remaining/initial penetration damage scaler used for every follow-through hit.
- `structure-grid.ts`
  - after cell destruction, enforces control-connectivity and destroys any disconnected structure cluster.
- `functional-attachments.ts`
  - functional components must attach to structure cells.
  - detached structure removes every functional component whose support-link list contains that cell.
- `mass-cache.ts`
  - maintain incremental total mass (`M_total`) for fast recoil/knockback calculations.
- `recoil.ts` and `impulse-model.ts`
  - shared formulas for fire recoil and incoming hit impulse.
- `battle-session.ts` (air movement sub-system)
  - aircraft only gain propulsion from `jetEngine` components.
  - pre-gravity speed/lift capacity is total jet power-to-mass scaled by `AIR_POWER_TO_SPEED_SCALE`; command direction is normalized separately.
  - effective movement speed is pre-gravity thrust speed minus `AIR_HOLD_GRAVITY`, capped by aggregate engine max speed.
  - normalized horizontal, vertical, and diagonal commands target the same speed magnitude.
  - velocity approaches the commanded vector over time; acceleration is live jet thrust-to-mass scaled by `AIR_POWER_TO_SPEED_SCALE` and the YAML-authored `aircraft_acceleration_ratio`.
  - a zero movement command targets zero velocity, providing default aircraft deceleration through the same acceleration limiter.
- `battle-session.ts` (unit overlap management)
  - same-layer units (`ground-ground`, `air-air`) use soft separation after movement integration.
  - partial overlap is allowed via configurable overlap allowance ratio, but deep stacking is pushed apart.
  - pair search uses uniform-grid broad phase to avoid O(n^2) full pair scans at typical battle unit counts.
  - separation weighting uses inverse mass and only damps normal closing velocity, preserving slide-like movement.
- `battle-session.ts` (unified command system)
  - all unit control (player input, combat AI, retreat AI, air-drop AI) produces a `UnitCommand` each tick.
  - `UnitCommand` contains `move` (direction), `facing`, and `fire` (list of `FireRequest`).
  - `FireRequest` carries `slot`, `manual`, and world-space `angleRad` (radians); fire execution derives aim projection from angle and effective range, then applies weapon-policy/angle clamps.
  - `executeCommand()` applies the command with unified enforcement of movement physics, weapon constraints, and boundary clamping.
  - command builders: `playerInputToCommand`, `aiDecisionToCommand`, `airDropReturnToCommand`, `retreatToCommand`.
  - Escape return delays its base-facing command for one second so newly asymmetric damage remains spatially stable before the retreat turn.
  - `alive` represents a unit that remains present in battlefield state; `canOperate(unit)` distinguishes active units from timed ground wrecks and falling controller-loss aircraft. `BattleSession.shouldGroundUnitEnterWreck(...)` evaluates the broader ground capability rule (control plus usable ground engine plus fireable weapon), initializes `UnitInstance.groundWreckTimerS`, and makes that countdown irreversible. Aircraft leave the ground-wreck fields unused. Active counts, spawning, targeting, collision separation, and arena scoring exclude inoperable units.
  - controller priority: player-controlled available weapon → thrust-loss air-drop → escape return → armed AI decision tree.
  - weapon availability means a surviving weapon has a loaded round, does not require a loader, or has a surviving compatible loader that can eventually reload it.
  - loss of all weapon availability starts the ground wreck countdown for ground craft. For aircraft it sets persistent `UnitInstance.escapeActive`, releases player control immediately, and routes the craft through return-to-base escape behavior.
  - `CommandResult` reports which slots fired and which were blocked (with reason).
  - craft control capacity is validated before spawn: the one Control Unit's `partProperties.computing` must cover the summed `partProperties.computingConsumption` of all placed non-control functional parts.

This keeps your physics behavior consistent across all systems.

---

## 6. Runtime Flow (Per Frame)

Use fixed timestep simulation for gameplay, interpolated rendering for smooth visuals.

1. Poll input.
2. Convert input to commands.
3. Run simulation ticks (`dt = 1/60`) as needed.
4. Physics + damage + AI updates.
5. Publish simulation snapshot.
6. Phaser reads current simulation state and presents the battle on its own scene clock.
7. Present UI using latest snapshot/meta-state.

Strategic progression shares the fixed real-time loop. `RealTimeCampaign.update(dt, nodes)` accrues resource income and advances building/research jobs regardless of the active campaign screen. A campaign `BattleSession` also updates off-screen with neutral player input. The browser integration owns a deployment ETA queue: it quotes the closest controlled Main/remote base, craft speed, outpost eligibility, and distance multiplier before spawning the craft into battle. Off-screen AI chooses from the player's default craft roster while gas and Delivery Center capacity allow.

---

## 7. Worker Strategy

Start simple, then scale:

- Phase 1 (MVP): single-thread main loop.
- Phase 2: move physics to `physics.worker.ts`.
- Phase 3: move AI planning to `ai.worker.ts`.

Use message contracts:

- `SimulationStepRequest`
- `SimulationStepResult`
- `SpawnUnitCommand`
- `ApplyPlayerControlCommand`

Keep payloads numeric/compact (typed arrays where possible).

---

## 8. Data and Save Architecture

Separate static content from dynamic state.

- Static game data (versioned):
  - materials, module stats, weapon recoil, commander growth.
- Dynamic save state:
  - base layout, unlocked tech, map ownership, gas economy, blueprints.

Use schema versioning:

- `saveVersion`
- migration functions (`v1 -> v2 -> v3`).

---

## 9. Networking Architecture (If Added)

Recommended for this game: server-authoritative simulation with client prediction.

- Client:
  - sends player commands.
  - predicts controlled unit movement.
- Server:
  - runs authoritative battle state.
  - sends snapshots/deltas.
- Client reconciles on mismatch.

For first release, keep single-player/offline architecture but design command/snapshot APIs now so multiplayer can be added later.

---

## 10. Performance Plan by Module

- Physics:
  - broad-phase spatial partitioning.
  - avoid full mass recalculation each frame.
- Rendering:
  - sprite batching, texture atlas, instance-like patterns.
  - quality presets for vibration effects.
- AI:
  - stagger expensive decisions (not every frame).
  - use stateful blackboard caches.
- UI:
  - decouple UI refresh from simulation tick; throttle non-critical updates.

Frame budget target at 60 FPS:

- Simulation: 6 to 8 ms
- Rendering: 5 to 7 ms
- UI + overhead: 1 to 2 ms

---

## 11. Local Debug Workflow

Template persistence middleware (dev server via `vite.config.ts`):

- `GET /__templates/default` -> read default object templates from `vip/templates/default`
- `PUT /__templates/default/:id` -> save/overwrite one default object template JSON
- `GET /__templates/user` -> read user object templates from `vip/templates/user`
- `PUT /__templates/user/:id` -> save/overwrite one user object template JSON
- `DELETE /__templates/user/:id` -> remove one user object template JSON
- Template save filenames are canonicalized from `template.name` (illegal filename symbols removed); delete/update resolves by internal integer `template.id`, not by filename.

Part persistence middleware (dev server via `vite.config.ts`):

- `GET /__parts/default` -> read file-backed default part catalog from `vip/parts/default`
- `PUT /__parts/default/:id` -> save/overwrite one default part definition JSON
- `PUT /__parts/default/batch` -> validate and rollback-protect a multi-part update used by the Part Designer comparison panel
- Part save filenames are canonicalized from `part.name` (illegal filename symbols removed); delete/update resolves by internal integer `part.id`, not by filename.
- Browser part loading and authoring are default-only; the legacy `vip/parts/user` directory is left untouched but is not exposed through browser storage endpoints.

Startup flow in `bootstrap.ts` merges templates from built-in defaults + file-backed defaults + user templates, then feeds the merged list into deploy/editor flows.

Editor UX implementation details:

- Canvas editor uses a resizable placement grid up to `10x10`.
- Shared design tokens and responsive layout rules in `style.css` provide consistent cards, metrics, action states, developer introductions, navigation, focus hierarchy, and compact breakpoints across Base, Map, Test Arena, Leaderboard, and both editors.
- Right-side palette renders component cards (placeholder thumbnail + label + type) in a scrollable list with hover detail text.
- Weapon Part Designer fields expose a `Show Info` modal with Hit Number and Destroy Time matrices (default weapons by default structures). Header selection drives a staged parameter inspector for shared gas/mass values, weapon damage/penetration/timing, and structure armor/HP; edits recalculate immediately, Discard is non-mutating, and Save All uses the transactional default-part batch endpoint before refreshing the still-open modal while preserving its tab and selection.
- The comparison uses flat armor damage (`max(1, damage - armor)`) and a simplified burst schedule: the first shot is immediate, loaded shots use `minFireInterval`, and `cooldown` separates magazines. It intentionally ignores penetration, explosions, recovery, accuracy, travel time, and loader-part behavior.
- Active layer (`structure`, `functional`, `display`) is switched from right-panel controls above the part palette.
- Template editor functional palette uses part catalog entries (not only hardcoded component IDs).
- Template editor functional palette applies template-type compatibility filtering: `air`-tagged parts are hidden on ground templates, `ground`-tagged parts are hidden on air templates, and untagged parts remain shared.
- Template editor structure palette is part-catalog driven and keyed by structure `part.id` (no material-bucket dedupe).
- Template structure schema uses `partId` per cell (not `material`), and template gas cost is always computed from structure-part + functional-part gas values.
- Template persistence omits template gas fields; normalized runtime gas remains derived from part totals so part edits auto-refresh template gas.
- Template parsing is strict for structure cells: invalid or missing structure `partId` fails parsing (no legacy `material` fallback path).
- Part Designer supports optional `stats.gasCost` override per part; deleting the field reverts to default gas calculation from base component/material defaults.
- Part Designer supports a unique per-part firepoint marker (`Fire point`) on box flags (max one per part); runtime resolves it for AI targeting input, while projectile spawn uses the live clamped barrel-tip geometry shared with rendering.
- Editor `Open` window lists all templates; clicking a template row opens it directly, and right-aligned `Copy` / `Delete` actions clone (`-copy` suffix) or remove file-backed entries.
- Template Editor has a single `Save` action that persists to default templates; save path runs template normalization before writing JSON.
- Template ID is internal integer/auto-managed for new and copied templates (no manual ID field in editor UI).
- When an opened template is renamed and saved, editor save flow assigns a new template ID and removes the previously opened template entry.
- Editor templates persist coordinates per placed part (`x`,`y`, origin `(0,0)`; negatives allowed).
- Template Editor and Part Editor maintain separate grid pan/view state, so tab switching restores each editor's last viewport.
- Editor grid viewport defaults to screen-centered origin and only recenters when loading a different template/part.
- Battle, Template Editor, and Part Editor use dedicated canvases (`#battleCanvas`, `#templateEditorCanvas`, `#partEditorCanvas`) layered in the shared viewport container. Phaser owns the viewport-resolution `#battleCanvas`; editor canvases intentionally remain direct Canvas tools.
- `src/rendering/phaser-battle-renderer.ts` is the browser-only presentation adapter. It reads `BattleSession` state without owning game rules, preserving browser/headless combat parity.
- Phaser draws faction affiliation directly on live craft geometry: every structure-block seam receives a light blue-player/red-enemy tint, then a brighter low-opacity two-stroke border is generated only for cell edges without a living orthogonal neighbor. This keeps the ownership cue attached to the authored surviving silhouette and composes beneath functional glyphs, selection markers, and later combat effects without adding simulation state.
- `BattleSession.getDebugSnapshot()` publishes battlefield, entity counts, selection, craft motion/health, and AI target/evasion/lead/fire-block telemetry. The dev probe exposes it at `battle.debug`.
- `BattleSession.getLossStats()` exposes per-side destroyed-craft counts and authored gas value lost. Stats reset with each battle session; the Test Arena viewport renders them as a fixed upper-left overlay, while administrative clears and successful withdrawals are excluded.
- Arena `MatchSpec.scenario.initialLineup` optionally selects an exact template/count per runtime side while preserving the legacy symmetric starter path when omitted. `replenishInitialLineup` optionally maintains those counts throughout a match. `MatchResult.losses` snapshots `BattleSession.getLossStats()`, allowing headless consumers such as Craft Arena to map destruction and authored gas loss from runtime sides back to craft identities.
- `BattleSession.consumeBattleAudioEvents()` bridges weapon-fire, impact, and explosion events to Phaser audio. Projectile class is combat-facing, while independent fire/impact sound-pool fields retain the five recorded audio profiles.
- `BattleSession` publishes `BattleState.blockExplosions` whenever structure cells transition to destroyed, including splash damage and final wreck cleanup. Phaser renders three deterministic pixel-art burst geometries from those records; the legacy/headless simulation remains free of Phaser types.
- Phaser combines preloaded CC0 recorded samples with synthesized fallbacks for spatial weapon-fire and impacts, while explosion, deployment, and movement remain synthesized through Web Audio. Fire sample pools and playback-rate profiles are keyed by all five weapon classes; rapid-fire uses shortened broadband bullet-on-metal transients, heavy cannon adds a synthesized sub-bass recoil tail to a true cannon source, and tracking missiles use processed variants of a broadband rocket-launch recording without an extra synthesized layer. Light-projectile impacts use four individually segmented hard-surface ricochet variants with descending metallic tails and a lower mix level than heavy impacts; heavy impacts retain a separate pool. Impact playback rate still varies by material acoustics. The listener center and width come from the active CSS pan/zoom view rather than the fixed logical battlefield center. A live global sound multiplier (`0x..5x`, default `3x`) is applied to each event. Browser gesture listeners explicitly resume the Phaser Web Audio context, and combat events remain queued while autoplay policy keeps that context suspended. Recorded samples and attribution live only under `game-core/assets/audio/`; the VIP Vite plugin serves them in development and emits them under `/assets/audio/` for builds.
- Display attachments are visual-only paint and render in the normal Phaser craft pass; functional attachments render component-family glyphs independently of paint.
- `StructureCellTemplate.color` is an optional per-cell Craft Designer tint. Unit instancing falls back to the referenced structure part's `materialColor`, so existing templates retain their defaults. Phaser renders every cell with the same code-drawn armor-panel texture and applies the resolved cell color; it does not add vehicle- or aircraft-sized silhouette art behind the grid.
- The Craft Designer functional palette and grid render per-component icons through `getFunctionalThumbGlyph(...)` and `drawFunctionalPartIcon(...)`, while the Phaser renderer uses its own world-scale functional glyph pass.
- Template Editor and Part Editor canvas overlays include the currently opened template/part name at top-left.
- Editor viewport controls use right-click click-to-delete and right-click drag for panning, plus mouse wheel zoom; battle keeps right-drag pan and wheel zoom.
- Template Editor shows a 50% alpha hover ghost for selected parts only when the current mouse-target placement is valid.
- Template Editor labels structure part names near the top of each occupied structure cell and labels functional anchors near the bottom using `partId + "." + part-name initials` (for example `18.P`, `16.ML`).
- Template Editor right-click delete prioritizes functional removal at a cell before structure removal on subsequent click.
- If no valid existing template/part is currently opened, editor entry starts with an empty grid draft instead of auto-opening a fallback catalog entry.
- Part Editor uses a persistent box-property brush so erased/recreated boxes can reuse the latest per-box property configuration without re-toggling each field.
- Editor functional attachments persist `partId` + `component` for runtime compatibility and part-catalog lookup.
- Weapon functional entries may carry `rotateQuarter` metadata (0..3, each step = 90deg).
- Heavy-shot weapons use grouped multi-cell occupancy in editor and rotate footprint with `rotateQuarter`.
- `rotateQuarter` owns placed footprint orientation. The separate top-level `directional` flag means that placement rotation also changes functional facing; it does not mean firing-arc width.
- Directional weapon facing uses additive composition: top-level part base `direction` + runtime/template `rotateQuarter`. Non-directional weapons retain their base facing even when a multi-cell footprint is rotated.
- Weapon firing arcs are independent and use `hasAngleLimit` + `cwAngle`/`ccwAngle`; engines are isotropic. The Part Designer labels these as placement-facing rotation versus firing-arc limits.
- Parsed file-backed weapons normalize a missing `hasAngleLimit` to `false`, matching the Part Editor's unchecked state. Runtime and AI use only `hasAngleLimit` with `cwAngle`/`ccwAngle`; base component definitions use the same fields when no part is present.
- Saved and parsed parts keep `directional` and `direction` only at the top level. The removed `partProperties.directional`, `defaultDirection`, and `shootAngleDeg` fields are neither emitted nor accepted.
- Template placement rotation uses only integer `rotateQuarter` values (`0..3`); the former boolean `rotate90` alias is not accepted.
- Editor grid is user-resizable (up to 10x10) and supports mouse drag panning.
- Template editor supports optional center-based placement (`center place on click`) for multi-cell part footprints.
- Runtime unit instancing and battle rendering consume template coordinates, so visual shape and hit cell layout match editor placement.
- Battle AI fire input is computed from per-part shooting-point box offsets when defined (falling back to attachment anchor/cell coordinates); actual projectile creation starts at the live visible barrel tip.
- Template parsing normalizes legacy weapon IDs (`mg`, `cannonL`, `cannonM`, `rocket`) to current IDs so old object designs remain valid.
- Weapon firing clamps out-of-angle aim to the nearest allowed boundary before projectile spawn/cooldown.
- Weapon firing evaluates limits in part-local facing space (part default direction + template rotation + unit facing).
- Runtime mobility derives from current engine power and current mass (power-to-mass), recalculated during battle updates.
- Runtime mobility also applies per-engine max-speed caps; multiple-engine cap is computed as a power-weighted average, then used as a hard upper bound on computed speed.
- `BattleSessionOptions.movementSpeedMultiplier` and the live `BattleSession.setMovementSpeedMultiplier(...)` setter scale commanded ground acceleration/velocity caps and commanded air speed without changing lift eligibility, gravity, recoil, or projectile physics. YAML owns only the shared default (`2x`); developer-authored finite values are not clamped by a separate configurable min/max pair.
- Authored static settings live in domain YAML under `game-core/src/config/`. Each document carries a reserved `_descriptions` map whose exact paths or single-segment wildcard paths must cover every editable leaf. `game-core/scripts/generate-config.mjs` strips that metadata from runtime values, rejects missing, ambiguous, or stale descriptions alongside malformed/unknown configuration, inconsistent ranges, invalid audio paths, and external repository audio, then deterministically emits both `GAME_CONFIG` and resolved `GAME_CONFIG_DESCRIPTIONS`. VIP and Arena build hooks run generation; `npm run config:check` verifies drift without writing.
- The development-only Developer Tools -> Global Settings panel reads the complete validated config and resolved descriptions from `GET /__config/settings`, then renders category tabs, YAML-file sections, recursive object subcategories, scalar/array controls, and hover/focus help. Sound sample-path rows preview their current form URL through browser audio; fire-pool rows resolve a random current pool key through the current sample map and apply the weapon class's authored playback rate. `POST /__config/settings` accepts only the complete fixed-shape runtime config tree, validates it before writing, preserves each document's `_descriptions`, updates every mapped YAML document as one rollback-capable transaction, regenerates typed config, and invalidates Vite's cached module transforms. Movement applies to the active `BattleSession` and master sound to the Phaser live getter without reloading; settings without runtime setters require a VIP/Arena restart. Test Arena battlefield persistence includes an explicit follow-global flag: global W/H/ground defaults apply until an arena field is edited, and legacy stored canonical defaults migrate to follow-global mode. The narrower `/__config/global-settings` endpoint remains available for movement/sound automation compatibility.
- Projectile runtime state now carries firing origin metadata (`sourceUnitType`, `fireOriginY`, `initialVy`) so ground-vehicle non-tracking shots fired above horizontal can be terminated when they fall too far below the firing origin, while downward-fired shots remain unaffected.
- Projectile runtime state carries `initialPenetration`, `remainingPenetration`, residual `currentDamage`, and per-part hit keys. The first hit uses full damage; later hits scale by remaining/initial penetration, and the same projectile never damages one part twice.
- Laser fire is resolved as an instant full-range rectangular sweep. A separate short-lived `beamEffects` snapshot carries its SVG shape and fitted half-width without coupling visual lifetime to collision lifetime.
- Canonical SVGs live under `game-core/assets/projectiles/`. `generate-projectile-assets.mjs` rasterizes them deterministically, thresholds opacity at 95%, maximizes one inscribed horizontal capsule for Bullet/Missile bodies, fits the Laser core rectangle, and emits the typed manifest shared by headless collision and Phaser rendering. Vite serves and emits the same SVG files.
- Structure-cell world sizing is centralized in `getStructureCellSize(...)` from battlefield balance config. Phaser rendering, projectile AABBs, targeting points, legacy Canvas/debug rendering, debris, and weapon geometry consume that shared size so presentation and hit resolution remain aligned.
- AI shot-feedback correction has been removed from runtime projectile state and despawn handling; projectile aim now remains purely command/solver-driven for deterministic behavior.
- Baseline shoot module now applies anti-jitter lead smoothing (filtered target velocity, partial lead gain with acceleration guard, and per-weapon aim slew/deadband) before issuing fire angles.
- Battle runtime now maintains per-unit target history buffers (`targetHistory`) sampled by elapsed time (default 10 samples over 1 second; no frame-number coupling).
- Composite shoot module resolver now supports `history-shoot`/`history-weighted-shoot`, which derives lead velocity from weighted historical coordinates (newest-biased) instead of instantaneous velocity.
- Composite shoot module resolver now also supports `autoreg-shoot`, which uses autoregressive velocity smoothing (`v_hat = (1-alpha)*old + alpha*current`) via module param `alpha`.
- Composite shoot module resolver now supports `w11-shoot`, which computes lead velocity as a direct non-negative weighted blend of 11 lag velocities (`v1..v11`) derived from target-history interval averages only (no instantaneous-velocity sample, no sum-to-1 normalization), driven by trainable module params `shoot.alpha1..shoot.alpha11`.
- AI-side angle deadband/slew damping is intentionally scoped to `baseline-shoot` only; `history-shoot`, `autoreg-shoot`, and `w11-shoot` keep ballistic solve output angles without additional per-tick angle-change clamping.
- `train-composite` supports `--shootFamily history-shoot`, `--shootFamily w11-shoot`, and `--shootFamily autoreg-shoot`; when `shootSource=new`, Arena seeds default params (`history`: `history.recencyPower=1.0`, `w11`: descending alpha weights, `autoreg`: `alpha=0.5`) and mutates them during optimization.
- Dev leaderboard model inventory keeps the six certified level built-ins. `history-shoot`, `autoreg-shoot`, and other trainable families remain reusable through saved run artifacts and the per-module selector.
- Air units compare isotropic jet thrust speed against gravity; only the post-gravity remainder becomes movement speed.
- Horizontal, vertical, and diagonal commands share that target speed magnitude, while finite thrust rotates or grows the live velocity vector over time.
- If jet thrust cannot overcome gravity, units transition into the air-drop crash path.
- Loader subsystem is selected per weapon with `needLoader`, while loader compatibility is expressed with `bullet|missile|laser` projectile classes:
- Loader components (`cannonLoader`, `missileLoader`) are functional modules with per-loader capabilities.
  - Each loader services one weapon at a time via per-unit loader state.
  - Weapon slots initialize ready charges from their authored `maxCapacity` and track load timers independently.
  - Multi-round weapons consume one ready charge per shot and enforce `minFireInterval` between released shots. Non-loader weapons restore one round per weapon-cooldown cycle; loader settings (`supports`, `loadMultiplier`, `fastOperation`, `minLoadTime`, `minBurstInterval`) drive the equivalent one-round incremental replenishment for `needLoader` weapons.
  - Loader-managed weapons and loaders both require `partProperties.bulletName`. Runtime trims and case-normalizes that free text and requires it to match, in addition to projectile-class support, before assigning a loader to a weapon. Template loader auto-injection uses the same compound compatibility key.
- Part-level runtime override coverage now includes full functional tuning:
  - weapon overrides: recoil/hit impulse, projectile speed/gravity, explosive blast settings, tracking turn rate, control-impair factor/duration, and per-attachment fire-sound volume;
  - loader overrides: supports/load-multiplier/fast-operation/min-load-time/min-burst-interval;
  - functional HP tuning is ignored because runtime functional attachments have no durability pool.
- Selection highlight rendering traces outer alive-structure edges.
- Missile projectiles optionally keep homing-aim coordinates and reacquire the nearest valid enemy when tracking is enabled.
- Runtime attachment instances carry part metadata (`partId`, footprint occupancy flags, optional runtime overrides) plus explicit supporting structure-cell IDs.
- Functional hit resolution sweeps exposed damageable part boxes alongside structure. Overlapping boxes defer to the structure hit; exposed boxes route damage to the closest support cell with armor bypass.
- Weapon-control and selected-unit HUD labels resolve `Attachment.partId` through the live part catalog so authored part names are shown instead of base component IDs.

Developer Part Designer UX:

- Primary access is the top-level `Part Editor` mode tab.
- Top-bar `Debug Options` -> `Part Designer` is a shortcut into the same `Part Editor` screen.
- Dedicated editor workspace for authoring a single reusable part definition.
- Part Designer uses `partType` for the component family. Weapon authoring replaces category selection with `projectileClass` (`bullet|missile|laser`), a compatible SVG `projectileShape`, and `projectileSizeRatio` (`0.1..10`); runtime `baseComponent` remains a compatibility/default-stat identity.
- Explosive behavior remains an independent Bullet/Missile `explodeOnHit` modifier and is not a projectile class.
- Part Designer no longer exposes explosive delivery/fuse fields; explosive projectiles detonate on hit and rely on configured projectile speed/gravity plus blast tuning.
- `Open Part` rows include explicit layer labels and structure defaults are provided as explicit file-backed material parts (`material-basic`, `material-reinforced`, `material-ceramic`, `material-reactive`, `material-combined`).
- `Open Part` modal includes tab-style filtering by part kind (`all`, `structure`, and functional component types).
- In `partType=structure`, functional-only part-property and placement controls are hidden.
- Part type/category default values auto-seed `partProperties` for new drafts and type/category switches.
- The engine category selector groups the four canonical presets into `tank engine` and `aircraft engine`; light/heavy remains variant metadata, and switching platform resolves the counterpart with the same variant.
- Part Designer conditionally exposes weapon `minFireInterval` (default `0.2`) when `maxCapacity` is not `1`.
- Weapon Part Designer fields include `Fire Sound`, persisted as `partProperties.fireSoundPool`, and `Fire Sound Volume` (`0x..2x`), persisted as `partProperties.fireSoundVolume`. The selected pool controls recorded sample choice/playback rate independently from the weapon's combat class; the renderer applies part volume before the global battle-volume multiplier.
- The catalog-facing weapon categories group both the explosive `cannons` part and the non-blast `anti-tank gun` part under `cannon`. Their runtime projectile/blast settings and per-part fire pools remain independent.
- Recorded and synthesized weapon-fire paths share a distance-aware Web Audio spatial bus. The bus derives listener distance from the current camera center and visible world width, then applies stereo pan, gain attenuation, and a progressive low-pass filter; impact samples retain their separate unfiltered spatial path so metallic transients remain distinct.
- Material runtime defaults are sourced from balance config and can still be overridden by file-backed structure-material part definitions when present.
- Part `Open` window mirrors template open-row actions with right-aligned `Copy` / `Delete` controls.
- Part definitions use integer IDs internally (`id` and all template/attachment `partId` references).
- Part Editor does not expose editable ID input; new/copy flows auto-assign next available integer ID.
- UI split:
  - left panel edits part-level fields (`name`, `partType`, optional `partCategory`) and type-aware `partProperties` controls.
  - right panel edits per-cell properties for the currently selected grid cell.
- Per-cell properties include:
  - `structureOccupy`,
  - `functionalOccupy`,
  - `needStructureBehind` (functional-only),
  - `takeDamage`,
  - `attachPoint`,
  - `anchorPoint` (single),
  - `firePoint` (single; weapon-only).
- Part-level engine/weapon property controls include:
  - `hasAngleLimit`
  - `cwAngle` / `ccwAngle` (shown only when `hasAngleLimit = true`)
- Canonical default part set is stored under `vip/parts/default/*.json`, and default template `partId` values align with those explicit IDs.

In-app debug UI:

- Top bar `Debug Options`
  - `Unlimited Resources`
  - `Draw Path + Hitbox`
  - `Draw Target Lines`
  - `Show Part HP Overlay`
  - `Show Part HP Overlay` (per-structure-cell HP text + red damage tint)

Dev-server log endpoints (available via `vite.config.ts` middleware):

- `POST /__debug/toggle` -> enable/disable file logging
- `POST /__debug/log` -> append runtime log entries

Dev-server debug probe RPC (dev-only, no eval; used by agents/scripts to fetch arbitrary state):

- `POST /__debug/probe` -> enqueue probe queries
- `GET /__debug/probe/next?clientId=...` -> client polls for work
- `POST /__debug/probe/<probeId>/response` -> client returns results
- `GET /__debug/probe/<probeId>` -> fetch probe status/results

Runtime log file path:

- `vip/.debug/runtime.log`

Recommended startup command:

```bash
DEBUG_LOG=1 npm --prefix vip run dev
```

## 12. Minimal Setup Commands

```bash
npm create vite@latest modular-army -- --template vanilla-ts
npm install phaser
npm install -D vite-plugin-wasm
```

If you want pure JavaScript (no TypeScript), use `vanilla` template and remove `typescript`-specific tooling.

---

## 13. First Implementation Milestones

1. Boot app + fixed simulation loop + Phaser battle scene.
2. Implement structure grid + attachment rules + exactly-one control unit and functional-cell-capacity validation.
3. Implement impulse hit/recoil and mass-based velocity changes.
4. Add damage pipeline (structure breach -> module loss).
5. Add simple AI and battle win/loss flow.
6. Add base/map meta layer and gas/commander caps.

This architecture is modular enough to ship a single-player build first, then scale to multiplayer and richer effects later.
