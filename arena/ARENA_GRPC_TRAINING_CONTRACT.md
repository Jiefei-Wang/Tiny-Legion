# Arena gRPC Training Contract (Draft)

## Goal

Define a gRPC arena server for Python-driven training:

- Python starts and controls battle sessions.
- Server returns full battlefield state each step.
- Server explicitly lists units requiring AI commands.
- Python returns next-step commands per unit.
- Python computes custom loss/reward externally.

## Fixed-Step Session Model

- Simulation tick: `dt = 1/60` seconds (same as current runtime).
- Each battle has a persistent `battle_id`.
- Determinism key: `seed + start config + command stream`.

### RPC flow

1. `CreateBattle(CreateBattleRequest) -> CreateBattleResponse`
- Creates a new battle session.
- Returns `battle_id`, `tick=0`, initial `snapshot`, initial `pending_units`.

2. `StepBattle(StepBattleRequest) -> StepBattleResponse`
- Input includes commands for previously pending units.
- Server advances exactly one tick (or `n_steps` if provided).
- Returns updated `snapshot`, `pending_units`, and battle outcome status.

3. `GetBattle(GetBattleRequest) -> GetBattleResponse`
- Read-only current snapshot and metadata.

4. `CloseBattle(CloseBattleRequest) -> CloseBattleResponse`
- Frees session resources.

## What server sends to Python

`StepBattleResponse` includes:

- `battle_id`
- `tick`
- `dt_seconds`
- `snapshot` (full battlefield state)
- `pending_units` (unit IDs that need external AI command now)
- `terminal` (bool)
- `outcome` (if terminal)

### Snapshot minimum fields

- Battle/meta:
- `seed`, `sim_time_seconds`, `max_sim_seconds`
- `battlefield_width`, `battlefield_height`, lane bounds (`air_min_z`, `air_max_z`, `ground_min_y`, `ground_max_y`)

- Economy/base:
- player/enemy gas
- player/enemy base hp/max hp and rect

- Units:
- identity: `id`, `side`, `type`, `template_id`, `alive`, `can_operate`
- kinematics: `x,y,vx,vy`, `accel`, `max_speed`, `turn_drag`, `facing`
- combat/status: `ai_state`, `control_impair_timer/factor`, `air_drop_active`
- weapon arrays: `weapon_attachment_ids`, `weapon_fire_timers`, `weapon_ready_charges`, `weapon_load_timers`, `weapon_auto_fire`
- attachment and structure summaries (for full-state training)

- Projectiles/debris/particles (full list)

## What Python returns to server

Python sends a list of `UnitStepCommand`.

For each commanded unit:

- `unit_id`
- `move`: `dir_x`, `dir_y`, optional `allow_descend`
- `facing`: `-1 | 1 | 0` (`0` means unchanged)
- `fire_requests[]`:
  - `slot`
  - `aim_x`, `aim_y`
  - optional target hints: `intended_target_id`, `intended_target_y`

If a pending unit is omitted, server applies a safe default no-op command for that unit.

## Python AI function contract

Suggested Python function signature:

```python
def decide_actions(snapshot: dict, pending_units: list[dict], ctx: dict) -> list[dict]:
    """
    Input:
      snapshot: full battlefield state for current tick
      pending_units: units requiring commands this tick
      ctx: optional trainer context (episode id, policy state, etc.)

    Return:
      list of UnitStepCommand dicts (one per unit_id, optional partial)
    """
```

Return shape per unit command:

```python
{
  "unit_id": "u_123",
  "move": {"dir_x": 0.4, "dir_y": -0.1, "allow_descend": False},
  "facing": 1,
  "fire_requests": [
    {"slot": 0, "aim_x": 1530.0, "aim_y": 420.0, "intended_target_id": "e_88"}
  ]
}
```

## Validation rules

- `dir_x`, `dir_y` are clamped to `[-1.5, 1.5]` server-side.
- Invalid `slot` or dead weapon -> rejected in command result metadata.
- Unknown `unit_id` or wrong side -> ignored + error entry in response.

## ONNX compatibility guidance

- Keep a separate stable feature extractor in Python training code.
- Export policy to ONNX using that feature order exactly.
- Implement the same feature extractor in JS (or precompute in server and expose versioned feature vector).
- Include `feature_schema_version` in model artifacts and gRPC metadata.
