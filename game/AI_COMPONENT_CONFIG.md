# Test Arena AI Module Selection

This document describes how the Test Arena `2 x 3` AI grid is populated and resolved.

## Grid Layout

- Rows: `target`, `movement`, `shoot`
- Columns: `player`, `enemy`
- Each cell is a single dropdown.

## Dropdown Inventory

Each dropdown shows:

- Built-in options (for example `baseline-*`, `neural-*-default`)
- Saved options discovered from arena run artifacts:
  - `arena/.arena-data/runs/*/best-composite.json`

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
