# AGENTS.md

This file is the session bootstrap for this repository.

If you are a new coding agent/session, read this file first, then read:

1. `GAME_PLAN.md`
2. `SOFTWARE_ARCHITECTURE.md`

## Project Snapshot

- Project root: `physics god`
- Active game app: `game/` (TypeScript + Vite + Canvas)
- Legacy prototype: `webgame/` (reference only)

## Current Runtime/Feature Reality

- Battle model: ground XY zone + air XZ abstraction
- Unit layers: structure + functional + optional display layer
- AI modules split by concern:
  - `src/ai/targeting/target-selector.ts`
  - `src/ai/shooting/ballistic-aim.ts`
  - `src/ai/movement/threat-movement.ts`
  - `src/ai/shooting/weapon-ai-policy.ts`
- Multi-weapon units with independent cooldown timers
- Player weapon controls:
  - `1..9`: select weapon slot
  - `Shift+1..9`: toggle auto fire for slot
  - Hold left mouse: fire selected weapon

## Debug Instructions (Agent)

### Dev server reuse (Agent)

- Before starting a new `npm --prefix game run dev`, check whether a dev server is already running (typically on `http://localhost:5173`).
- If it responds, reuse the existing server (do not start a second one). Use the running server for all verification/debug steps, including `POST /__debug/*` endpoints.
- Only start a new server if nothing is listening/responding on the expected port, or if the running server is clearly for a different workspace/build.

### Runtime debug UI

- Open `Debug Options` in top bar:
  - `Unlimited Resources`
  - `Draw Path + Hitbox`
- With visual debug ON, battle HUD includes live AI telemetry.

### Local debug file logging

- Vite middleware endpoints are available in dev mode:
  - `POST /__debug/toggle` with `{ "enabled": true|false }`
  - `POST /__debug/log` with `{ "level": "info|warn|bad", "message": "..." }`
- Log file path: `game/.debug/runtime.log`
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

## Mandatory Headless Verification

- For any gameplay, unit, weapon, AI, template, or battle-loop change, run headless smoke verification before reporting done:

```bash
npm --prefix game run test:headless
```

- This smoke test reuses battle logic and verifies all default templates can move and fire.
- If it fails, include full failing template/check details in your report and fix before completion.
