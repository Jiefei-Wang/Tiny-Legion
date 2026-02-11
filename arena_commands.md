# Arena Commands (Current)

All commands are run from repo root.

## Prerequisites

```bash
npm --prefix arena install
npm --prefix arena run build
```

Optional sanity check:

```bash
npm --prefix game run test:headless
```

## Composite AI Component Models

Current available model family per component:

- `target`
  - `baseline-target`
  - `dt-target`
- `movement`
  - `baseline-movement`
  - `dt-movement`
- `shoot`
  - `baseline-shoot`
  - `dt-shoot`

For `train-composite`, each component source can be:

- `baseline`
- `new` (new trainable DT params initialized from schema defaults)
- `trained:<path>` (load from existing trained artifact)

Composite phases (`p1`..`p4`) are loaded from:

- default: `arena/composite-training.phases.json`
- override: `--phaseConfig <path>`

Phase entries support:

- `templateNames`: wildcard patterns (`"*" = all templates`)
- `battlefield.width`, `battlefield.height`, optional `battlefield.groundHeight`

## Train One Combination (Recommended)

Example combination:

- target source = `new`
- movement source = `baseline`
- shoot source = `new`

Using wrapper script:

```bash
./train_ai.sh compose \
  --target-source new \
  --movement-source baseline \
  --shoot-source new \
  --phase-seeds 16 \
  --generations 20 \
  --population 24 \
  --parallel 8 \
  --n-units 4
```

Direct CLI equivalent:

```bash
npm --prefix arena run train:composite -- \
  --scope all \
  --phaseConfig arena/composite-training.phases.json \
  --targetSource new \
  --movementSource baseline \
  --shootSource new \
  --phaseSeeds 16 \
  --generations 20 \
  --population 24 \
  --parallel 8 \
  --nUnits 4
```

## Train Single Component Only

Train shoot only (hold others fixed by source):

```bash
./train_ai.sh shoot \
  --target-source baseline \
  --movement-source baseline \
  --shoot-source new
```

Direct CLI:

```bash
npm --prefix arena run train:composite -- \
  --scope shoot \
  --targetSource baseline \
  --movementSource baseline \
  --shootSource new
```

## Seed From Existing Trained Composite

```bash
./train_ai.sh compose \
  --seed-composite arena/.arena-data/runs/<run-id>/best-composite.json \
  --target-source trained:arena/.arena-data/runs/<run-id>/best-composite.json \
  --movement-source trained:arena/.arena-data/runs/<run-id>/best-composite.json \
  --shoot-source trained:arena/.arena-data/runs/<run-id>/best-composite.json
```

## Useful Runtime Commands

Single headless match:

```bash
npm --prefix arena run match -- --seed 123 --out .arena-data/test-match.json
# Optional per-side composite override:
# --playerComposite <path-to-composite-json> --enemyComposite <path-to-composite-json>
```

Replay artifact:

```bash
npm --prefix arena run replay -- --file .arena-data/test-match.json
```

Headless replay:

```bash
npm --prefix arena run replay -- --headless --file .arena-data/test-match.json
```

## Removed/Outdated

- Python bridge/training commands are removed.
- gRPC training server commands are removed.
- ONNX export/load flow is removed.
- Legacy arena micro-AI families (`range-bias`, `evade-bias`, `aggressive-rush`, `adaptive-kite`, `base-rush`) are removed.
- Legacy `arena train`, `arena train-spawn`, and `arena eval` flows are removed.
