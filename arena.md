# AI Arena Plan

This document describes a headless AI arena system that runs battles in parallel, stays synced with game logic by importing shared engine code, and supports flexible AI behavior through parameterized AI families optimized via an evolutionary (survival) algorithm.

## Goals

- Run AI-vs-AI battles headless (no canvas), deterministically by seed.
- Run many matches in parallel across CPU cores.
- Keep arena results in sync with the game by reusing the same battle/simulation logic.
- Keep AI independent from game internals: AI only talks to the engine via a stable interface (observations in, commands out).
- Start by comparing everything against the current shipped AI logic (baseline).
- Gate entry: only AI configurations that can beat the baseline with >= 80% win rate are allowed into the full arena pool.
- After promotion, optimize against other promoted AIs.

## Non-Goals (Initial)

- Loading untrusted user-supplied AI code.
- Browser rendering/visual replay UI inside the arena service (optional later).

## Repository Layout (Proposed)

Add new projects/packages alongside `game/`:

```text
arena/                # Node service + CLI + trainer (implemented)

packages/             # reserved for future extraction

arena.md              # this plan
```

## Quick Start (Implemented)

From repo root:

```bash
npm --prefix game run test:headless
npm --prefix arena install

# run one match (writes a replay artifact)
npm --prefix arena run match -- --seed 123 --out .arena-data/test-match.json

# replay a match artifact
npm --prefix arena run replay -- --file .arena-data/test-match.json

# train a composed AI (target/movement/shoot components)
npm --prefix arena run train:composite -- --scope all --generations 20 --population 24 --phaseSeeds 16 --parallel 8 --nUnits 4
```

Current runtime note: arena match execution is composite-only (`familyId: "composite"`); baseline is represented as a baseline composite module bundle.

Artifacts:

- `arena/.arena-data/runs/<runId>/best.json` best model for that run
- `arena/.arena-data/models/<aiFamilyId>/index.json` top models across runs (capped at `--maxModels`, default 100)

## 1) Shared Headless Engine (packages/engine)

### Purpose

Provide an authoritative battle simulation that can run in Node or browser with identical logic.

### API surface (shape)

- `BattleEngine.init(config, seed)`
- `BattleEngine.step(dt)` (fixed timestep runner)
- `BattleEngine.applyCommands(side, commands)`
- `BattleEngine.getSnapshot()` (readonly state for UI/logging)
- `BattleEngine.getOutcome()` (win/loss/tie + reason)

### Scenario generation

- `ScenarioGenerator` creates initial state: bases, randomly spawned objects, initial unit placements.
- All scenario randomness comes from a seeded RNG.

### Determinism requirements

- Introduce a seeded RNG implementation inside `packages/engine`.
- Thread RNG through any randomness that changes outcomes (spawns, timers, combat randomness, AI movement jitter that impacts interactions).
- Match runner always records `seed + config + ai ids + params` for replay.

## 2) AI Independence Contract (packages/ai-contract)

### Core interfaces

- `AiController`:
  - `reset(matchInfo)`
  - `tick(observation) => Command[]`
- `Observation`: what AI is allowed to see.
- `Command`: what AI is allowed to do (movement, facing/weapon selection toggles, fire intent, etc.).

### What the AI must observe to make good decisions

The observation contract must be rich enough to support different weapon classes and different movement profiles without reading game internals.

At minimum, expose:

- Global/match context
  - `simTimeS`, `dt`
  - `maxSimSeconds`
  - `seed` (optional, for debugging/replay only)
- Resource state (for scoring/strategy)
  - `gas.ownCurrent`
  - `gas.enemyCurrent` (if the simulation has an enemy gas pool)
  - `gas.ownRecoverableOnField` (see “battlefield gas value” below)
- Bases/objective
  - own base hp/maxHp + position bounds
  - enemy base hp/maxHp + position bounds
- Friendly/enemy unit list (for each unit)
  - identity: `id`, `side`, `type` (ground/air)
  - kinematics: `x,y,vx,vy`, plus movement capabilities `accel,maxSpeed,turnDrag`
  - facing and any control impairments: `facing`, `controlImpairTimer`, `controlImpairFactor`
  - survivability signals: structure integrity summary, alive/operable
  - weapon slots (per slot)
    - slot readiness: `weaponFireTimers`, `weaponLoadTimers`, `weaponReadyCharges`
    - slot mode: `selectedWeaponIndex`, `weaponAutoFire[slot]`
    - derived weapon stats (from balance config at engine build time)
      - `weaponClass`, `range`, `cooldown`, `shootAngleDeg`, `spreadDeg`
      - `damage`, `hitImpulse`
      - ballistic: `projectileSpeed`, `projectileGravity`
      - tracking: `turnRateDegPerSec`
      - explosive: `deliveryMode`, `blastRadius`, `blastDamage`, `falloffPower`, `fuse`, `fuseTime?`
      - control-utility: `impairFactor`, `duration`
    - loader state summary (if present): current loader timers/capacity constraints

Notes:

- Air/altitude range bonuses exist in current balance logic; the engine should either expose an “effectiveRange” per weapon slot (already altitude-adjusted) or expose the necessary inputs to compute it.
- Do not require the AI to infer whether a unit “disappeared” means destroyed vs. withdrawn; the engine should publish explicit lifecycle outcomes for units.

### Parameter schemas (maximize flexibility without arbitrary code)

Each AI family exposes a machine-readable schema:

- numeric: `{ min, max, default, mutationSigma? }`
- integer: `{ min, max, default, step?, mutationRate? }`
- boolean: `{ default, mutationRate? }`
- enum: `{ values[], default, mutationRate? }`

Arena treats a specific `(aiId, params)` as an "entrant configuration".

## 3) Fixed Set of AI Families (packages/ai)

- `default-ai@current`:
  - Adapter around the current game AI logic.
  - This is the baseline reference for gating.
- Additional AI families:
  - May reuse existing logic/modules but expose tunable heuristics/weights/thresholds/cooldowns.
  - Must implement `AiController` via adapters.

Important rule: the engine never imports AI logic directly. The arena injects AI controllers into the engine.

## 4) Arena Service (arena/) - Separate Endpoint

Node/TypeScript service. Responsibilities:

- Load AI families from `packages/ai`.
- Run match simulations headlessly.
- Evaluate entrants vs baseline (gate league).
- Promote entrants that satisfy the 80% rule.
- Run tournaments/ladder among promoted entrants (arena league).
- Store results (JSONL or SQLite) for reproducibility and leaderboards.

### Endpoints (sketch)

- `POST /gate/evaluate` -> evaluate `(aiId, params)` vs baseline
- `POST /gate/optimize` -> evolutionary optimization vs baseline
- `POST /arena/tournament` -> run pool competitions
- `GET /leaderboard` -> rankings/ratings
- `GET /entrants/:id` -> config + metadata + results

## 5) Parallel Execution Model

- Scheduler process accepts jobs and dispatches matches to a worker pool.
- Workers run deterministic fixed-timestep loops with strict limits:
  - `maxSimSeconds` / `maxSteps`
  - optional per-AI compute budget guard (wall-clock) to prevent pathological behavior
- Parallelism level defaults to CPU cores; configurable.

## 6) Two-League Flow: Gate First, Then Arena

### Gate League (baseline-only)

- Goal: find parameter vectors that reliably beat `default-ai@current`.
- Entrants are not allowed into the main arena until they pass promotion.

### Promotion rule (80% requirement)

- Primary requirement: win rate vs baseline >= 0.80.
- Recommended robustness: require a conservative lower confidence bound >= 0.80 (e.g., Wilson lower bound) to avoid promotion by variance.
- Use fairness pairing:
  - For each seed batch, run two games with side swap.
  - Use a fixed seed schedule per evaluation batch for stable comparisons.

### Arena League (promoted pool)

- All promoted entrants compete.
- Continue optimization against the pool.
- Maintain periodic baseline checks to prevent regressions and keep a stable reference.

## 7) Evolutionary (Survival) Optimization

For each AI family:

- Population: N parameter vectors.
- Fitness: computed from match results (see scoring below).
- Selection: rank-based or tournament selection.
- Variation:
  - float mutation: Gaussian noise (sigma per-parameter)
  - int mutation: +/- step or random within bounds
  - boolean: flip with rate
  - enum: random change with rate
- Crossover (optional): combine parameter subsets from two parents.
- Elitism: keep top K unchanged each generation.

Optimization is match-evaluation-bound and parallelizable.

## 8) Scoring Function (Priority: Win > Time > Destroyed)

We score each match with a single scalar that encodes lexicographic priority.

Priority order:

1. Win the battle
2. Minimize net gas cost

Key constraint: do not assume a unit “disappearing” means it was fully destroyed. Gas can be recovered via special mechanics (e.g., withdrawal refunds), so the scoring must be based on resource accounting (gas delta) plus the on-field gas value.

Definitions per match:

- `O = 2` if win (enemy base destroyed)
- `O = 1` if tie (time limit)
- `O = 0` if loss

Gas accounting terms (for the scoring side):

- `G0 = gasStart` (gas at match start)
- `G1 = gasEnd` (gas at match end)
- `V0 = onFieldGasValueStart`
- `V1 = onFieldGasValueEnd`

Where “on-field gas value” is the recoverable value of currently deployed assets on the battlefield (not “destroyed units”), computed by the engine from authoritative state (e.g., refundable portion of each alive unit’s `deploymentGasCost`, plus any other recoverable gas mechanisms).

We score “gas efficiency” as the change in total gas worth:

```ts
totalWorth0 = G0 + V0;
totalWorth1 = G1 + V1;
gasWorthDelta = totalWorth1 - totalWorth0; // higher is better
```

Score:

```ts
// Outcome dominates, then gas worth (minimize net gas cost).
score = O * 1_000_000
      + gasWorthDelta;
```

Evaluation score for an entrant configuration over N matches:

```ts
fitness = (1 / N) * Σ score_i;
```

This guarantees:

- any win beats any tie/loss regardless of gas
- among wins (or ties), higher retained/recaptured gas value ranks higher

## 9) CLI (arena-cli/)

- `arena gate-evaluate --ai <id> --params params.json --matches 400`
- `arena gate-optimize --ai <id> --budget 2000 --parallel 12`
- `arena tournament --pool current --format round-robin --parallel 12`

## 10) Game Integration (Keep Logic Shared)

The browser game should consume `packages/engine` for battle logic:

- Rendering layer reads snapshots and draws to canvas.
- Input layer turns player actions into engine commands.

This ensures arena and game use identical battle resolution logic.

## 11) Result Storage & Reproducibility

Store per match:

- engine version (git hash), arena version
- scenario config
- seed
- AI ids + parameter vectors
- outcome (win/loss/tie)
- gas accounting (for both sides): `gasStart`, `gasEnd`, `onFieldGasValueStart`, `onFieldGasValueEnd`, and optionally a summarized gas event ledger (spend/refund/reward)
- optional sim time (useful for debugging/analysis, not a primary objective)
- optional event trace/replay stream (later)

With this, any interesting match is replayable exactly by rerunning with the same seed and versions.

## Open Questions (To Finalize Before Coding)

- How to treat ties in gating: count as not-win (recommended) vs partial credit (currently: tie < win, > loss in scoring).
- Standard match config set for evaluation (map sizes, spawn density, time limit, etc.).
- Any additional constraints: minimum diversity of scenarios required to promote.
