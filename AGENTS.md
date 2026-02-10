# AGENTS.md

This file is the session bootstrap for this repository.

If you are a new coding agent/session, read this file first, then read:

1. `GAME_PLAN.md`
2. `SOFTWARE_ARCHITECTURE.md`

## Project Snapshot

- Project root: `physics god`
- Active game app: `game/` (TypeScript + Vite + Canvas)
- Shared game logic: `packages/game-core/`
- Legacy prototype: `webgame/` (reference only)
- Command reference: `game_command.md`
- Composite AI arena training command: `npm --prefix arena run train:composite -- --phaseSeeds 16 --nUnits 4`
- Unified training wrapper script: `./train_ai.sh help` (module-only and full composite training with per-module network size/depth and source selection)

## Current Runtime/Feature Reality

- Battle model: ground XY zone + air XZ abstraction
- Canonical/default logical battlefield size is `2000x1000` (shared across browser runtime and headless/arena)
- Test Arena can override runtime battlefield simulation size (`W`/`H`) and ground height from UI; zoom remains display-only
- Unit layers: structure + functional + optional display layer
- AI modules split by concern:
  - `src/ai/targeting/target-selector.ts`
  - `src/ai/shooting/ballistic-aim.ts`
  - `src/ai/movement/threat-movement.ts`
  - `src/ai/shooting/weapon-ai-policy.ts`
- Multi-weapon units with independent cooldown timers
- Player weapon controls:
  - `1..9`: toggle manual control for slot
  - `Shift+1..9`: toggle auto fire for slot
  - Hold left mouse: fire all manual-controlled slots
  - Manual-controlled slots temporarily suppress auto fire (auto toggle state is preserved)

## Debug Instructions (Agent)

### Dev server reuse (Agent)

- Before starting a new `npm --prefix game run dev`, check whether a dev server is already running (typically on `http://localhost:5173`).
- If it responds, reuse the existing server (do not start a second one). Use the running server for all verification/debug steps, including `POST /__debug/*` endpoints.
- Only start a new server if nothing is listening/responding on the expected port, or if the running server is clearly for a different workspace/build.

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
- Log file path: `game/.debug/runtime.log`
- Enable server-side logging at startup:
### Debug probe RPC (dev-only)

This repo includes a dev-only "debug probe" RPC so agents (and scripts) can request arbitrary state from the running browser game without adding fixed snapshot endpoints.

- Server broker (Vite middleware in `game/vite.config.ts`):
  - `POST /__debug/probe` with `{ "clientId": "...", "queries": [...] }` -> `{ ok: true, probeId }`
  - `GET /__debug/probe/<probeId>` -> `{ ok: true, status: "pending"|"done", result? }`
  - Client polling: `GET /__debug/probe/next?clientId=...` -> `{ ok: true, probe: { id, queries } | null }`
  - Client response: `POST /__debug/probe/<probeId>/response` with `{ ok: true, results: [...], errors?: [...] }`
- Safety: **no eval**. Queries are limited to `path`/`dump` (from explicit roots) and `dom` (selector-based). Payloads are size-capped.
- Enablement: probe polling is active only when debug server logging is enabled (same toggle as `/__debug/log`, usually via in-app Debug Options).

- Enable server-side logging at startup:

```bash
DEBUG_LOG=1 npm --prefix game run dev
```

If shell does not support inline env assignment, set env var in shell first, then run dev.

## Known Environment Caveat

- This repo is under Google Drive path (`G:\My Drive\...`).
- `npm install` may intermittently fail with TAR/EBADF errors in this path.
- If builds fail unexpectedly due to dependency corruption, retry carefully and avoid destructive git operations.

## Session Best Practice

- Keep design docs and architecture docs in sync with implemented behavior.
- Hard rule: if you change gameplay design, player/AI rules, balance logic, or any user-facing behavior, update `GAME_PLAN.md` in the same change.
- Hard rule: if you change code structure (new modules, moving responsibilities, new data flows/types, new debug endpoints), update `SOFTWARE_ARCHITECTURE.md` in the same change.
- If both apply, update both docs; prefer small, surgical doc edits over letting them drift.
- Add durable agent instructions to this `AGENTS.md` so new sessions can discover workflow quickly.
- Put temporary images and other temporary outputs under `.tmp/` instead of the project root.

## Mandatory Headless Verification

- For any gameplay, unit, weapon, AI, template, or battle-loop change, run headless smoke verification before reporting done:

```bash
npm --prefix game run test:headless
```

- This smoke test reuses battle logic and verifies all default templates can move and fire.
- If it fails, include full failing template/check details in your report and fix before completion.
