# Test Arena AI Module Selection

This document describes how the Test Arena `2 x 3` AI grid is populated and resolved.

## Grid Layout

- Rows: `target`, `movement`, `shoot`
- Columns: `player`, `enemy`
- Each cell is a single dropdown.

## Dropdown Inventory

Each module dropdown shows:

- Reusable built-in module families (baseline, decision-tree, history, autoregressive, and skill modules)
- `unified-shoot`, the property-driven exact given-target intercept module
- `unified-level-1-shoot` through `unified-level-5-shoot`, calibrated wrappers required to stay within +/-1.5 percentage points of 50% through 90% aggregate all-weapon accuracy. Their misses use stable, geometry-scaled near-miss angles (or close-range hesitation), while standalone `unified-shoot` uses the exact core
- Saved options discovered from arena run artifacts:
  - `arena/.arena-data/runs/*/best-composite.json`

The composed-model selector is separate:

- `L1 AI` through `L6 AI` are built in and resolve locally through `levelCompositeConfig(...)`.
- Entries returned by `GET /__arena/composite/models` are genuine saved training artifacts only. A built-in level is never labeled or duplicated as a saved AI.

The game dev server exposes:

- `GET /__arena/composite/modules`

Response shape:

```json
{
  "ok": true,
  "modules": {
    "target": [{ "id": "runId:target:family", "label": "saved:...", "spec": { "familyId": "...", "params": {} } }],
    "movement": [{ "id": "runId:movement:family", "label": "saved:...", "spec": { "familyId": "...", "params": {} } }],
    "shoot": [{ "id": "runId:shoot:family", "label": "saved:...", "spec": { "familyId": "...", "params": {} } }]
  }
}
```

## Runtime Mapping

Each dropdown value resolves to one module spec:

```json
{
  "familyId": "string",
  "params": {}
}
```

The three resolved specs per side are passed into composite controller creation.
Selections apply immediately after dropdown change.
