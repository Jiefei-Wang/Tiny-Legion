# AGENTS.md

This file is the session bootstrap for this repository.

If you are a new coding agent/session, read this file first, then read:

1. `game_design/GAME_PLAN.md`
2. `game_design/SOFTWARE_ARCHITECTURE.md`

## Project Snapshot

- Project root: `physics god`
- Active game app: `vip/` (TypeScript + Vite + Canvas)
- Shared game logic: `game-core/`
- Authored static game settings: `game-core/src/config/**/*.yaml`
- Generated typed config: `game-core/src/config/generated/game-config.generated.ts` (do not edit directly)
- Canonical audio sources and attribution: `game-core/assets/audio/`
- Legacy prototype: `webgame/` (reference only)
- Command reference: `game_design/game_command.md`
- Composite AI arena training command: `npm --prefix arena run train:composite -- --phaseSeeds 16 --nUnits 4`
- Unified training wrapper script: `./train_ai.sh help` (module-only and full composite compare/optimization with per-module source selection)
- Unified shooting verification: `npm --prefix arena run verify:shooting-ai` (exact 1,000-shot proof per weapon plus aggregate L1-L5 50/60/70/80/90% calibration). The L1-L5 aggregate result must remain within +/-1.5 percentage points of its target; failure blocks completion of shooting-AI changes.

## Static Configuration Workflow

- Edit domain YAML under `game-core/src/config/` (`balance`, `ai`, `display`, `editor`, or `sound`); do not add a `global` config folder. Every editable leaf must be covered by that document's `_descriptions` map (single-segment `*` wildcards are supported for repeated maps).
- Run `npm run config:generate` after YAML edits. `npm run config:check` validates YAML, generated output, and audio ownership without rewriting files.
- VIP dev/build/headless and Arena builds run generation automatically.
- The development-only Global Settings panel exposes every YAML document through category tabs (`balance`, `ai`, `display`, `editor`, `sound`) and recursive subcategory controls. Hovering or focusing a setting shows its YAML-authored description. Saving validates and transactionally rewrites the fixed YAML file set while preserving description metadata; movement and master sound apply through live hooks, while other settings require restarting the affected runtime.
- All repository audio source files must remain under `game-core/assets/audio/`; VIP serves and bundles them through its Vite plugin.

## Current Runtime/Feature Reality

- Battle model: ground XY zone + air XZ abstraction
- Canonical/default logical battlefield size is `3000x1500` with `600` ground height (shared authored defaults across browser runtime and headless/arena)
- Test Arena can override runtime battlefield simulation size (`W`/`H`) and ground height from UI; zoom remains display-only
- Unit layers: structure + functional + optional display layer
- AI modules split by concern:
  - `src/ai/targeting/target-selector.ts`
  - `src/ai/shooting/ballistic-aim.ts`
  - `src/ai/movement/threat-movement.ts`
  - `src/ai/shooting/weapon-ai-policy.ts`
- Certified AI behavior rules:
  1. Do not stay at the battlefield border for too long; border travel remains unrestricted, but prolonged dwell must produce soft inward recovery.
  2. Do not flip facing or horizontal movement direction too quickly.
  3. Ground craft/tanks should dodge bullets with up/down movement and should not move backward frequently.
  4. Aircraft may fly in any direction to dodge bullets.
  5. Movement must not ignore nearby enemies even while pursuing a separate strategic target.
  6. Reuse the current unified shooting algorithm. Target selection/integration may change, but ballistic solving, accuracy calibration, and miss behavior must not be replaced.
  7. Certified movement should hold 90% of the currently intended weapon's effective firing range from its target; do not derive this standoff from the craft's longest weapon or a blend of all weapons.
- Arena workflow is JS/TS-only (no Python bridge, no gRPC battlefield service).
- Multi-weapon units with independent cooldown timers
- Player weapon controls:
  - `1..9`: toggle manual control for slot
  - `Shift+1..9`: toggle auto fire for slot
  - Hold left mouse: fire all manual-controlled slots
  - Manual-controlled slots temporarily suppress auto fire (auto toggle state is preserved)
- Battlefield controller controls (standard Gamepad API):
  - Left stick: move controlled unit
  - Right stick: set firing angle
  - Right trigger or right bumper: fire manual-controlled slots
  - Tracking/target-dependent weapons auto-lock the valid enemy nearest the aim ray

## Debug Instructions (Agent)

### Dev server reuse (Agent)

- Before starting a new `npm --prefix vip run dev`, check whether a dev server is already running (typically on `http://localhost:5173`).
- If it responds, reuse the existing server (do not start a second one). Use the running server for all verification/debug steps, including `POST /__debug/*` endpoints.
- Only start a new server if nothing is listening/responding on the expected port, or if the running server is clearly for a different workspace/build.
- Keep in mind that there might be multiple agents working in the same repo, so if you find a bug not related to your changes, leave it as it is.

### Runtime debug UI

- Open `Debug Options` in top bar:
  - `Unlimited Resources`
  - `Draw Path + Hitbox`
  - `Show Display Layer` (default OFF)
  - `Show Part HP Overlay` (per-structure-cell HP text + red damage tint)
- With visual debug ON, battle HUD includes live AI telemetry.

### Local debug file logging

- Vite middleware endpoints are available in dev mode:
  - `POST /__debug/toggle` with `{ "enabled": true|false }`
  - `POST /__debug/log` with `{ "level": "info|warn|bad", "message": "..." }`
- Log file path: `vip/.debug/runtime.log`
- Enable server-side logging at startup:
### Debug probe RPC (dev-only)

This repo includes a dev-only "debug probe" RPC so agents (and scripts) can request arbitrary state from the running browser game without adding fixed snapshot endpoints.

- Server broker (Vite middleware in `vip/vite.config.ts`):
  - `POST /__debug/probe` with `{ "clientId": "...", "queries": [...] }` -> `{ ok: true, probeId }`
  - `GET /__debug/probe/<probeId>` -> `{ ok: true, status: "pending"|"done", result? }`
  - Client polling: `GET /__debug/probe/next?clientId=...` -> `{ ok: true, probe: { id, queries } | null }`
  - Client response: `POST /__debug/probe/<probeId>/response` with `{ ok: true, results: [...], errors?: [...] }`
- Safety: **no eval**. Queries are limited to `path`/`dump` (from explicit roots) and `dom` (selector-based). Payloads are size-capped.
- Enablement: probe polling is active only when debug server logging is enabled (same toggle as `/__debug/log`, usually via in-app Debug Options).

- Enable server-side logging at startup:

```bash
DEBUG_LOG=1 npm --prefix vip run dev
```

If shell does not support inline env assignment, set env var in shell first, then run dev.

## Known Environment Caveat

- This repo is under Google Drive path (`G:\My Drive\...`).
- `npm install` may intermittently fail with TAR/EBADF errors in this path.
- If builds fail unexpectedly due to dependency corruption, retry carefully and avoid destructive git operations.

## Session Best Practice

- Keep design docs and architecture docs in sync with implemented behavior.
- Hard rule: if you change gameplay design, player/AI rules, balance logic, or any user-facing behavior, update `game_design/GAME_PLAN.md` in the same change.
- Hard rule: if you change code structure (new modules, moving responsibilities, new data flows/types, new debug endpoints), update `game_design/SOFTWARE_ARCHITECTURE.md` in the same change.
- If both apply, update both docs; prefer small, surgical doc edits over letting them drift.
- Add durable agent instructions to this `AGENTS.md` so new sessions can discover workflow quickly.
- Put temporary images and other temporary outputs under `.tmp/` instead of the project root.
- When taking screenshots or performing visual checks that save images, save every resulting image under `.tmp/`.

## Leaderboard Configuration Awareness

- The AI leaderboard competition (`/__arena/composite/leaderboard/compete`) reads settings from `arena/composite-training.phases.json` `p4-leaderboard` phase.
- Do not duplicate comparison timing/spawn/scoring values in `p4-leaderboard`. The leaderboard code reads phase catalog/base-mode declarations, then sources battlefield/Test Arena defaults and comparison `spawnCountPerSide`, `spawnIntervalSeconds`, `maxSimSeconds`, and `baseWorthUnits` from game-core Global Settings.
- Phase-four training, headless evaluation, and the leaderboard MUST continue to share `loadLeaderboardScenario()` so Elo scores remain meaningful and comparable.

## Mandatory Headless Verification

- For any gameplay, unit, weapon, AI, template, or battle-loop change, run headless smoke verification before reporting done:

```bash
npm --prefix vip run test:headless
```

- This smoke test reuses battle logic and verifies all default templates can move and fire.
- If it fails, include full failing template/check details in your report and fix before completion.
