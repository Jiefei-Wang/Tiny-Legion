# Game Commands

Useful commands for running the game, developer interface, and arena tooling.

## 1) Install Dependencies

```bash
npm --prefix vip install
npm --prefix arena install
npm --prefix arena-ui install
```

## 2) Start Game UI (Developer Interface)

```bash
npm --prefix vip run dev
```

Open: `http://localhost:5173`

Check whether a dev server is already running:

```bash
curl -sf http://localhost:5173 >/dev/null && echo "vip dev server is running" || echo "no vip dev server"
```

## 3) Start Game With Developer Logging

```bash
DEBUG_LOG=1 npm --prefix vip run dev
```

This enables server-side runtime log output to:

- `vip/.debug/runtime.log`

## 4) Developer Interface Endpoints (`/__debug/*`)

Enable/disable runtime logging:

```bash
curl -X POST http://localhost:5173/__debug/toggle \
  -H 'content-type: application/json' \
  -d '{"enabled":true}'
```

Write a debug line:

```bash
curl -X POST http://localhost:5173/__debug/log \
  -H 'content-type: application/json' \
  -d '{"level":"info","message":"manual debug message"}'
```

Submit a debug probe request:

```bash
curl -X POST http://localhost:5173/__debug/probe \
  -H 'content-type: application/json' \
  -d '{"clientId":"manual-client","queries":[{"type":"dump","root":"battle","path":"state.units","options":{"maxDepth":2}}]}'
```

Read probe status/result:

```bash
curl http://localhost:5173/__debug/probe/<probeId>
```

## 5) Build And Verify Game

Build:

```bash
npm --prefix vip run build
```

Mandatory gameplay smoke test:

```bash
npm --prefix vip run test:headless
```

This smoke test also validates all system default templates with severity checks (`errors` + `warnings`), and verifies required defaults can deploy, move, and fire.

## 6) Arena (AI Match/Training Interface)

Build arena runtime:

```bash
npm --prefix arena run build
```

Run one match:

```bash
npm --prefix arena run match -- --aiA baseline --aiB range-bias --seed 123 --out .tmp/match.json
```

Train micro AI:

```bash
npm --prefix arena run train -- --ai range-bias --generations 5 --population 12 --parallel 4
```

Evaluate vs baseline:

```bash
npm --prefix arena run eval -- --ai range-bias --fromStore true --seeds 40 --parallel 8
```

Replay from artifact (opens UI):

```bash
npm --prefix arena run replay -- --file .tmp/match.json
```

## 7) Arena Replay UI (Direct)

Dev mode:

```bash
npm --prefix arena-ui run dev
```

Build:

```bash
npm --prefix arena-ui run build
```

## 8) Shared Core Logic

Shared gameplay/AI/simulation code lives in:

- `game-core/src/`

`vip/` and `arena/` both consume this package to keep battle logic consistent.

Static configuration and audio:

```bash
npm run config:generate
npm run config:check
```

- Author settings in `game-core/src/config/**/*.yaml`.
- Keep recorded audio and attribution under `game-core/assets/audio/`.
- Do not edit `game-core/src/config/generated/game-config.generated.ts` directly.

## 9) Verify Unified Shooting AI

Run the deterministic one-shot runtime-collision proof for every default weapon (1,000 random trials per weapon plus edge cases), followed by the required aggregate all-weapon L1-L5 accuracy checks at 50%, 60%, 70%, 80%, and 90%. Each level must remain within +/-1.5 percentage points of its target or the command fails:

```bash
npm --prefix arena run verify:shooting-ai
```

Optional filters:

```bash
npm --prefix arena run verify:shooting-ai -- --seed 20260727 --trials 1000 --weapon "anti-tank"
```
