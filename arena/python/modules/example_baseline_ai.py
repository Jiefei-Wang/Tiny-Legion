from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .arena_client import AI_callback, ArenaClient, start_battle


def _nearest_enemy(unit: Dict[str, Any], all_units: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    ux = float(unit.get("x", 0.0))
    uy = float(unit.get("y", 0.0))
    side = unit.get("side")
    best = None
    best_d2 = float("inf")
    for other in all_units:
        if not other.get("alive", True):
            continue
        if other.get("side") == side:
            continue
        dx = float(other.get("x", 0.0)) - ux
        dy = float(other.get("y", 0.0)) - uy
        d2 = dx * dx + dy * dy
        if d2 < best_d2:
            best_d2 = d2
            best = other
    return best


def _move_toward(
    unit: Dict[str, Any],
    target: Dict[str, Any],
    desired_range: float = 280.0,
) -> Tuple[float, float]:
    ux = float(unit.get("x", 0.0))
    uy = float(unit.get("y", 0.0))
    tx = float(target.get("x", 0.0))
    ty = float(target.get("y", 0.0))
    dx = tx - ux
    dy = ty - uy
    dist = max(1e-6, (dx * dx + dy * dy) ** 0.5)
    nx = dx / dist
    ny = dy / dist
    if dist > desired_range:
        return nx, ny
    if dist < desired_range * 0.6:
        return -nx, -ny
    return 0.0, 0.0


def baseline_ai_callback(
    snapshot: Dict[str, Any],
    pending_units: List[Dict[str, Any]],
    ctx: Dict[str, Any],
) -> List[Dict[str, Any]]:
    all_units = list(snapshot.get("units", []))
    commands: List[Dict[str, Any]] = []

    for unit in pending_units:
        if not unit.get("alive", True):
            continue
        enemy = _nearest_enemy(unit, all_units)
        if enemy is None:
            commands.append(
                {
                    "unit_id": unit.get("unit_id") or unit.get("id"),
                    "move": {"dir_x": 0.0, "dir_y": 0.0},
                    "facing": 0,
                    "fire_requests": [],
                }
            )
            continue

        dir_x, dir_y = _move_toward(unit, enemy)
        ex = float(enemy.get("x", 0.0))
        ey = float(enemy.get("y", 0.0))

        fire_requests: List[Dict[str, Any]] = []
        if int(unit.get("weapon_count", 1)) > 0:
            fire_requests.append(
                {
                    "slot": 0,
                    "aim_x": ex,
                    "aim_y": ey,
                    "intended_target_id": enemy.get("id"),
                }
            )

        commands.append(
            {
                "unit_id": unit.get("unit_id") or unit.get("id"),
                "move": {"dir_x": dir_x, "dir_y": dir_y},
                "facing": 1 if ex >= float(unit.get("x", 0.0)) else -1,
                "fire_requests": fire_requests,
            }
        )
    return commands


def run_example(grpc_stub: Any) -> Dict[str, Any]:
    client = ArenaClient(endpoint="localhost:50051", grpc_stub=grpc_stub)
    client.set_ai_callback(AI_callback(baseline_ai_callback))
    first = start_battle(
        client,
        {
            "seed": 123,
            "max_sim_seconds": 240,
            "battlefield": {"width": 2000, "height": 1000},
            "scenario": {"with_base": True, "initial_units_per_side": 2},
        },
    )
    return client.run_until_terminal(first, max_steps=20_000)
