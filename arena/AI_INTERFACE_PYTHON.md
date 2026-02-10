# Python AI Interface

This document defines the Python-side training helper API and callback contract.

## Helper API

### `start_battle(client, config)`

Starts one arena battle session.

- Input:
  - `client`: `ArenaClient`
  - `config`: `dict` (seed, spawn/base config, limits, etc.)
- Output:
  - `dict` with at least:
    - `battle_id: str`
    - `tick: int`
    - `dt_seconds: float`
    - `snapshot: dict`
    - `pending_units: list[dict]`
    - `terminal: bool`
    - `outcome: dict | None`

### `AI_callback(fun)`

Registers a Python callable used for next-step inference.

- Input:
  - `fun(snapshot, pending_units, ctx) -> list[dict]`
- Output:
  - The same callable, validated and wrapped.

### Optional lifecycle helpers

- `client.get_battle(battle_id)` -> current battle snapshot/metadata
- `client.close_battle(battle_id)` -> release battle session

## Callback Contract

### Callback input

- `snapshot: dict`
  - Full battlefield state for this tick.
  - Includes battle metadata, bases, units, projectiles, and economy.
- `pending_units: list[dict]`
  - Subset of units requiring control decisions now.
  - Each item contains at least `unit_id`, `side`, `type`, and per-unit runtime status.
- `ctx: dict`
  - Helper context (episode id, step index, arbitrary policy state).

### Callback output

Return a list of unit commands:

```python
[
  {
    "unit_id": "u_123",
    "move": {"dir_x": 0.7, "dir_y": -0.2, "allow_descend": False},
    "facing": 1,
    "fire_requests": [
      {"slot": 0, "aim_x": 1520.0, "aim_y": 420.0, "intended_target_id": "e_11"}
    ],
  }
]
```

Rules:

- `facing`: `-1`, `1`, or `0` (`0` means keep current facing).
- If a `pending_unit` has no command, helper sends no-op for that unit.
- Server validates/clamps invalid values.

## Minimal usage

```python
from arena_client import ArenaClient, start_battle, AI_callback

def my_ai(snapshot, pending_units, ctx):
    return []

client = ArenaClient(endpoint="localhost:50051")
client.set_ai_callback(AI_callback(my_ai))
first = start_battle(client, {"seed": 123})
result = client.run_until_terminal(first)
```

## Test Arena bridge usage (browser Test Arena -> Python callback)

Use `arena/python/test_arena_bridge.py` when Test Arena AI preset is `Python Bridge (external)`.

```python
from arena.python.example_baseline_ai import baseline_ai_callback
from arena.python.test_arena_bridge import TestArenaBridgeClient

bridge = TestArenaBridgeClient(
    base_url="http://localhost:5173",
    client_id="py-baseline-1",
    callback=baseline_ai_callback,
)
bridge.run_forever()
```

While this process is running, Test Arena status changes from `Waiting for connection` to `Connected (...)`.
