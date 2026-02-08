# Web Game Software Architecture

## 0. Current Implementation Reality

This document includes target architecture and current shipped implementation.

Current active stack/runtime:

- Runtime: Browser (`HTML5 Canvas`)
- Language: `TypeScript`
- Build tool: `Vite`
- Active app path: `game/`
- Shared logic package: `packages/game-core/`
- Legacy prototype path: `webgame/` (reference only)

Implemented gameplay architecture highlights:

- Ground combat: continuous `X/Y` movement zone
- Air combat: `X/Z` abstraction (rendered on screen vertical axis)
- Air propulsion split: `jetEngine` (omni thrust) + `propeller` (directional thrust with placement constraints)
- Unit layers: `structure + functional + display`
- AI modules split by concern:
  - `src/ai/decision-tree/combat-decision-tree.ts` (combat orchestrator)
  - `src/ai/targeting/target-selector.ts`
  - `src/ai/shooting/ballistic-aim.ts`
  - `src/ai/movement/threat-movement.ts`
  - `src/ai/shooting/weapon-ai-policy.ts`
- Multi-weapon units with independent cooldown timers and slot controls
- In-app debug options plus local runtime log pipeline (`/__debug/*` -> `game/.debug/runtime.log`)
- Strategic layer is turn-based: **Next Round** advances gas economy, construction, and resolves battles

## 1. Target Stack

Use a browser-first stack with TypeScript for maintainability.

- Runtime: Browser (`HTML5`, `Canvas/WebGL`, `WebAudio`)
- Language: `TypeScript` (compiles to JS)
- Build tool: `Vite`
- Rendering: `Canvas 2D` (current implementation)
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

## 2.2 Optional Expansion Packages (Future)

| Package | Why useful |
| --- | --- |
| `pixi.js` | If switching from Canvas to GPU sprite renderer |
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

### Renderer options

- `pixi.js` (recommended)
  - Pros: built for 2D games, excellent batching and sprite workflows.
- `phaser`
  - Pros: many built-in game systems.
  - Cons: if you want strict custom architecture, can feel framework-heavy.

---

## 3. High-Level Architecture

Split implementation into 4 runtime layers plus 2 integration surfaces:

1. **Core Simulation Layer**
   - Deterministic-ish fixed-timestep world update.
   - Physics, combat, unit state, AI decisions.
2. **Presentation Layer**
   - Pixi rendering, VFX (vibration, hit flashes), audio.
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
   - Consumes shared logic from `packages/game-core` directly.

Rule: presentation can read simulation state, but simulation cannot depend on rendering classes.

---

## 4. Module Breakdown (Code Structure)

Current implemented structure (abridged):

```text
packages/game-core/src/
  ai/
  config/balance/
  core/ids/
  gameplay/
    battle/battle-session.ts
    map/
  simulation/
  templates/template-schema.ts
  templates/template-validation.ts
  types.ts

game/src/
  app/
    bootstrap.ts
    game-loop.ts
    template-store.ts      (fetch/save adapter over game-core template schema/validation)
  ai|config|core|gameplay|simulation|types.ts
    (thin re-exports to packages/game-core)

game/templates/
  default/*.json
  user/*.json
```

Arena training/runtime package (implemented):

```text
arena/src/
  ai/
    ai-schema.ts
    families.ts
    families/
      baseline.ts
      range-bias.ts
      evade-bias.ts
      aggressive-rush.ts
      adaptive-kite.ts
      neural-linear.ts
      base-rush.ts
  eval/
    evaluate-vs-baseline.ts
  match/
    match-types.ts
    run-match.ts
    run-single-match.ts
  spawn/
    spawn-schema.ts
    families.ts
    families/spawn-baseline.ts
    families/spawn-weighted.ts
  train/
    run-training.ts
    run-spawn-training.ts
    fitness.ts
    param-genetics.ts
    model-store.ts
  worker/
    match-worker.ts
  replay/
    run-replay.ts
    open-replay-ui.ts
```

Arena-specific architecture notes:

- Arena runtime imports battle/simulation/template domain code directly from `packages/game-core/src/*` (no dynamic loading from `game/.headless-dist`).
- Training and evaluation run headless through `WorkerPool` + `match-worker.ts` for parallel CPU usage.
- Model ranking now prioritizes `winRateLowerBound` then `winRate`, then `score`.
- `cli.ts` includes an `eval` command for reproducible held-out benchmarking versus `baseline`.
- Replay UI (`arena-ui/src/main.ts`) still uses game interface bootstrap (`game/src/app/bootstrap.ts`) while consuming AI/simulation primitives from `packages/game-core`.

Map node metadata supports test-only battle tuning via optional fields on `MapNode`:

- `testEnemyMinActive` keeps a minimum enemy unit count active in battle.
- `testEnemyInfiniteGas` bypasses enemy gas drain so test scenarios can sustain pressure.
- `testBaseHpOverride` sets both player/enemy battle base HP and max HP for long-running test battles.

Template/editor architecture notes:

- `template-validation.ts` is an isolated validation module with severity output (`errors` + `warnings`).
- `template-schema.ts` parse pipeline supports placement sanitization (skip invalid/overlapping placements) before runtime usage, and middleware/headless loaders persist the sanitized JSON to keep editor/headless results aligned.
- Loader injection is configurable in parse options and does not alter warning/error severity evaluation logic.
- Editor save does not block on warnings/errors; categories are surfaced in UI/logs for developer feedback.
- Battle deploy/spawn paths validate templates and block creation when `errors` are present.
- Editor `Open` workflow supports direct editing of existing templates and one-click copy creation (`-copy` suffix).
- Template IDs are internal and auto-generated for new/copy templates; ID editing is removed from UI.

---

## 5. Critical Domain Rules in Code

Encode your game rules as explicit modules (not scattered checks):

- `control-unit-rules.ts`
  - exactly one control unit per object.
  - if destroyed: object mission-killed.
- `damage-model.ts`
  - resolves projectile hits to impacted structure cells (localized front/back damage).
  - applies per-cell strain recovery using material `recoverPerSecond`.
- `structure-grid.ts`
  - after cell destruction, enforces control-connectivity and destroys any disconnected structure cluster.
- `functional-attachments.ts`
  - functional components must attach to structure cells.
  - detached structure removes attached functional components.
- `mass-cache.ts`
  - maintain incremental total mass (`M_total`) for fast recoil/knockback calculations.
- `recoil.ts` and `impulse-model.ts`
  - shared formulas for fire recoil and incoming hit impulse.
- `battle-session.ts` (air movement sub-system)
  - aircraft only gain propulsion from air components (`jetEngine`/`propeller`).
  - lift-vs-gravity deficit drives altitude loss.
  - non-descent commands reserve thrust for vertical hold and spend spare thrust on horizontal movement.

This keeps your physics behavior consistent across all systems.

---

## 6. Runtime Flow (Per Frame)

Use fixed timestep simulation for gameplay, interpolated rendering for smooth visuals.

1. Poll input.
2. Convert input to commands.
3. Run simulation ticks (`dt = 1/60`) as needed.
4. Physics + damage + AI updates.
5. Publish simulation snapshot.
6. Render interpolation in Pixi.
7. Present UI using latest snapshot/meta-state.

Strategic progression is round-based (user-driven): **Next Round** applies gas income/upkeep, advances construction timers, and forces any active battle to resolve by the end of the round.

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

- `GET /__templates/default` -> read default object templates from `game/templates/default`
- `GET /__templates/user` -> read user object templates from `game/templates/user`
- `PUT /__templates/user/:id` -> save/overwrite one user object template JSON
- `DELETE /__templates/user/:id` -> remove one user object template JSON

Startup flow in `bootstrap.ts` merges templates from built-in defaults + file-backed defaults + user templates, then feeds the merged list into deploy/editor flows.

Editor UX implementation details:

- Canvas editor uses a resizable placement grid up to `10x10`.
- Right-side palette renders up to `30` component cards (placeholder thumbnail + label + type), with hover detail text.
- Active layer (`structure`, `functional`, `display`) is switched from right-panel controls above the part palette.
- Per-part gas contribution is not used in current editor stage; part cards and placement logic focus on gameplay stats/constraints.
- Editor `Open` window lists all templates and supports either direct-open editing or one-click `Copy` (`-copy` suffix).
- Template ID is internal/auto-managed for new and copied templates (no manual ID field in editor UI).
- Editor templates persist coordinates per placed part (`x`,`y`, origin `(0,0)`; negatives allowed).
- Weapon functional entries may carry `rotateQuarter` metadata (0..3, each step = 90deg).
- Heavy-shot weapons use grouped multi-cell occupancy in editor and rotate footprint with `rotateQuarter`.
- Functional component rotation/rendering now keys off a `directional` property (default undirectional).
- Editor grid is user-resizable (up to 10x10) and supports mouse drag panning.
- Runtime unit instancing and battle rendering consume template coordinates, so visual shape and hit cell layout match editor placement.
- Battle shot origin is computed from weapon attachment coordinates.
- Template parsing normalizes legacy weapon IDs (`mg`, `cannonL`, `cannonM`, `rocket`) to current IDs so old object designs remain valid.
- Weapon firing clamps out-of-angle aim to the nearest allowed boundary before projectile spawn/cooldown.
- Runtime mobility derives from current engine power and current mass (power-to-mass), recalculated during battle updates.
- Runtime mobility also applies per-engine max-speed caps; multiple-engine cap is computed as a power-weighted average, then used as a hard upper bound on computed speed.
- Air units compute lift from air propulsion thrust (`jetEngine` omni, `propeller` directional cone) and compare against gravity hold.
- Air movement reserves thrust for vertical hold first, then spends remaining thrust for horizontal/intentional altitude movement.
- If lift becomes critically low, units transition into an air-drop crash path.
- Loader subsystem added for selected weapon classes (heavy-shot/explosive/tracking):
- Loader components (`cannonLoader`, `missileLoader`) are functional modules with per-loader capabilities.
  - Each loader services one weapon at a time via per-unit loader state.
  - Weapon slots now track ready charges and load timers.
  - Loader settings (`supports`, `loadMultiplier`, `fastOperation`, `minLoadTime`, `storeCapacity`, `minBurstInterval`) drive reload and burst cadence.
- Selection highlight rendering traces outer alive-structure edges.
- Tracking projectiles keep homing-aim coordinates and reacquire nearest valid enemy when initial target is unavailable.

In-app debug UI:

- Top bar `Debug Options`
  - `Unlimited Resources`
  - `Draw Path + Hitbox`
  - `Draw Target Lines`

Dev-server log endpoints (available via `vite.config.ts` middleware):

- `POST /__debug/toggle` -> enable/disable file logging
- `POST /__debug/log` -> append runtime log entries

Dev-server debug probe RPC (dev-only, no eval; used by agents/scripts to fetch arbitrary state):

- `POST /__debug/probe` -> enqueue probe queries
- `GET /__debug/probe/next?clientId=...` -> client polls for work
- `POST /__debug/probe/<probeId>/response` -> client returns results
- `GET /__debug/probe/<probeId>` -> fetch probe status/results

Runtime log file path:

- `game/.debug/runtime.log`

Recommended startup command:

```bash
DEBUG_LOG=1 npm --prefix game run dev
```

## 12. Minimal Setup Commands

```bash
npm create vite@latest modular-army -- --template vanilla-ts
npm install pixi.js @dimforge/rapier2d-compat zustand zod nanoid howler comlink immer
npm install -D vite-plugin-wasm
```

If you want pure JavaScript (no TypeScript), use `vanilla` template and remove `typescript`-specific tooling.

---

## 13. First Implementation Milestones

1. Boot app + fixed loop + Pixi scene + Rapier world.
2. Implement structure grid + attachment rules + single control unit validation.
3. Implement impulse hit/recoil and mass-based velocity changes.
4. Add damage pipeline (structure breach -> module loss).
5. Add simple AI and battle win/loss flow.
6. Add base/map meta layer and gas/commander caps.

This architecture is modular enough to ship a single-player build first, then scale to multiplayer and richer effects later.
