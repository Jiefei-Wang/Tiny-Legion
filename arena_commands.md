# Arena Commands

All commands are run from the repo root.

## Prerequisites

```bash
# (Optional) sanity check the game headless harness
npm --prefix game run test:headless

# install arena deps
npm --prefix arena install
```

## Build

```bash
npm --prefix arena run build
```

## Run One Match (Headless)

```bash
# baseline (player) vs range-bias (enemy)
npm --prefix arena run match -- --aiA baseline --aiB range-bias --seed 123 --out .arena-data/test-match.json
```

Common flags:

```bash
--maxSimSeconds 240 --nodeDefense 1 --baseHp 1200 --playerGas 10000 --enemyGas 10000
```

## Global Defaults (Config File / Env Vars)

Defaults are resolved in this order:

1. CLI flags (`--playerGas`, `--baseHp`, ...)
2. Environment variables
3. `arena/arena.config.json`
4. Built-in defaults

Create `arena/arena.config.json` (example):

```json
{
  "playerGas": 10000,
  "enemyGas": 10000,
  "baseHp": 1200,
  "maxSimSeconds": 240,
  "nodeDefense": 1,
  "parallel": 8,
  "maxModels": 100
}
```

Supported env vars:

- `ARENA_PLAYER_GAS`
- `ARENA_ENEMY_GAS`
- `ARENA_BASE_HP`
- `ARENA_MAX_SIM_SECONDS`
- `ARENA_NODE_DEFENSE`
- `ARENA_PARALLEL`
- `ARENA_MAX_MODELS`
- `ARENA_SEEDS`
- `ARENA_GENERATIONS`
- `ARENA_POPULATION`

Optional params files:

```bash
npm --prefix arena run match -- \
  --aiA range-bias --paramsA path/to/paramsA.json \
  --aiB evade-bias --paramsB path/to/paramsB.json \
  --seed 123 --out .arena-data/custom-match.json
```

## Replay A Match Artifact

```bash
npm --prefix arena run replay -- --file .arena-data/test-match.json
```

## Train (Genetic Algorithm vs Baseline)

```bash
# train range-bias vs baseline
npm --prefix arena run train -- \
  --ai range-bias \
  --generations 25 \
  --population 40 \
  --seeds 20 \
  --parallel 8 \
  --maxModels 100
```

Training output:

- Periodic `progress=done/total` within each generation
- End-of-generation `top3` (score, wins/games, win rate, Wilson lower bound, avg gas-worth delta)

Outputs:

- Best model per run: `arena/.arena-data/runs/<runId>/best.json`
- Top models per AI family (capped): `arena/.arena-data/models/<aiFamilyId>/index.json`

## Serve (HTTP)

```bash
npm --prefix arena run serve
```

Endpoints:

- `POST /match` with a `MatchSpec` JSON
- `POST /train` with training options JSON (starts training async; returns 202)
