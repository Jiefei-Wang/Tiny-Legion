"""Baseline-style reference AI callback for Python integration examples.

The logic is intentionally simple and deterministic:
- choose nearest enemy,
- move toward/away to maintain rough preferred range,
- fire weapon slot 0 at enemy position when available.

Use this module as a template when implementing custom policies.
"""

from __future__ import annotations

from typing import Any, Dict, List

from .arena_client import AI_callback, ArenaClient, start_battle
from .ai_composer import AIComposer, build_baseline_composer


BASELINE_COMPOSER: AIComposer = build_baseline_composer(desired_range=280.0, cadence_steps=1)


def baseline_ai_callback(
    snapshot: Dict[str, Any],
    pending_units: List[Dict[str, Any]],
    ctx: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Generate per-unit commands for pending controllable units.

    Args:
        snapshot: Battle snapshot dictionary.
        pending_units: Units that require commands on this tick.
        ctx: Mutable callback context (not required by this baseline policy).

    Returns:
        List of command dictionaries in bridge-compatible format:
        ``unit_id``, ``move``, optional ``facing``, and ``fire_requests``.
    """
    return BASELINE_COMPOSER.callback(snapshot=snapshot, pending_units=pending_units, ctx=ctx)


def run_example(grpc_stub: Any) -> Dict[str, Any]:
    """Run one end-to-end battle using this baseline callback.

    Args:
        grpc_stub: Service stub exposing CreateBattle/StepBattle endpoints.

    Returns:
        Final terminal battle response dictionary.
    """
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
