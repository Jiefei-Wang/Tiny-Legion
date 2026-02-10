"""Python helper client for the arena gRPC control flow.

This module provides a thin, explicit wrapper around the arena RPC surface
used by training scripts:

- register an AI callback,
- create/step/query/close battles,
- and run a full episode loop until terminal state.

The wrapper intentionally keeps payloads as plain dictionaries so callers can
adapt quickly while the service schema evolves.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


Snapshot = Dict[str, Any]
PendingUnits = List[Dict[str, Any]]
UnitCommand = Dict[str, Any]
AiCallback = Callable[[Snapshot, PendingUnits, Dict[str, Any]], List[UnitCommand]]


def AI_callback(fun: AiCallback) -> AiCallback:
    """Validate and return an AI callback callable.

    Args:
        fun: Callable with signature
            ``(snapshot, pending_units, ctx) -> list[unit_command_dict]``.

    Returns:
        The same callable when validation succeeds.

    Raises:
        TypeError: If ``fun`` is not callable.
    """
    if not callable(fun):
        raise TypeError("AI_callback expects a callable")
    return fun


@dataclass
class ArenaClient:
    """Stateful convenience wrapper for arena RPC interactions.

    Attributes:
        endpoint: Human-readable endpoint label (for caller bookkeeping/logging).
        grpc_stub: Object that exposes RPC-like methods:
            ``CreateBattle``, ``StepBattle``, ``GetBattle``, ``CloseBattle``.
            The wrapper does not enforce concrete gRPC types; it only forwards
            dictionaries to these methods.
        _ai_callback: Registered inference callback used by
            :meth:`run_until_terminal`.
        _ctx: Mutable callback context that persists across steps of one run.
    """

    endpoint: str
    grpc_stub: Any = None
    _ai_callback: Optional[AiCallback] = None
    _ctx: Dict[str, Any] = field(default_factory=dict)

    def set_ai_callback(self, fun: AiCallback) -> None:
        """Register the policy callback used in step loops.

        Args:
            fun: AI callback compatible with :func:`AI_callback`.
        """
        self._ai_callback = AI_callback(fun)

    def start_battle(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Create a battle session through the arena service.

        Args:
            config: Battle creation config dictionary.

        Returns:
            First battle response payload from ``CreateBattle``.

        Raises:
            RuntimeError: If no ``grpc_stub`` is configured.
        """
        if self.grpc_stub is None:
            raise RuntimeError(
                "ArenaClient requires a gRPC stub. "
                "Pass grpc_stub=... with CreateBattle/StepBattle methods."
            )
        return self.grpc_stub.CreateBattle(config)

    def step_battle(
        self,
        battle_id: str,
        commands: List[UnitCommand],
        n_steps: int = 1,
    ) -> Dict[str, Any]:
        """Advance an existing battle by one or more simulation steps.

        Args:
            battle_id: Session identifier returned by ``CreateBattle``.
            commands: Per-unit command list for current pending units.
            n_steps: Number of fixed simulation steps to advance. Values lower
                than 1 are clamped to 1.

        Returns:
            Step response payload from ``StepBattle``.

        Raises:
            RuntimeError: If no ``grpc_stub`` is configured.
        """
        if self.grpc_stub is None:
            raise RuntimeError("ArenaClient requires a gRPC stub.")
        req = {
            "battle_id": battle_id,
            "commands": commands,
            "n_steps": max(1, int(n_steps)),
        }
        return self.grpc_stub.StepBattle(req)

    def get_battle(self, battle_id: str) -> Dict[str, Any]:
        """Fetch current snapshot/state for an existing battle.

        Args:
            battle_id: Session identifier.

        Returns:
            Battle payload from ``GetBattle``.

        Raises:
            RuntimeError: If no ``grpc_stub`` is configured.
        """
        if self.grpc_stub is None:
            raise RuntimeError("ArenaClient requires a gRPC stub.")
        return self.grpc_stub.GetBattle({"battle_id": battle_id})

    def close_battle(self, battle_id: str) -> Dict[str, Any]:
        """Request explicit battle session teardown.

        Args:
            battle_id: Session identifier.

        Returns:
            Result payload from ``CloseBattle`` (for example ``{"ok": True}``).

        Raises:
            RuntimeError: If no ``grpc_stub`` is configured.
        """
        if self.grpc_stub is None:
            raise RuntimeError("ArenaClient requires a gRPC stub.")
        return self.grpc_stub.CloseBattle({"battle_id": battle_id})

    def run_until_terminal(
        self,
        first_response: Dict[str, Any],
        max_steps: int = 20_000,
    ) -> Dict[str, Any]:
        """Execute a full episode loop until battle terminal state.

        Loop behavior:
        1. Read ``snapshot`` + ``pending_units`` from current response.
        2. Invoke registered AI callback.
        3. Submit callback output via :meth:`step_battle`.
        4. Repeat until ``terminal == True`` or ``max_steps`` is reached.

        Args:
            first_response: Initial response from :meth:`start_battle`.
            max_steps: Safety cap on number of loop iterations.

        Returns:
            Final terminal battle response.

        Raises:
            RuntimeError: If no callback is registered.
            ValueError: If ``battle_id`` is missing from initial response.
            TimeoutError: If terminal state is not reached within ``max_steps``.
        """
        if self._ai_callback is None:
            raise RuntimeError("No AI callback registered. Use set_ai_callback(AI_callback(...)).")

        response = first_response
        battle_id = str(response.get("battle_id", ""))
        if not battle_id:
            raise ValueError("Missing battle_id in start response")

        self._ctx.setdefault("episode_steps", 0)
        for _ in range(max_steps):
            if bool(response.get("terminal", False)):
                return response

            snapshot = response.get("snapshot", {})
            pending_units = response.get("pending_units", [])
            commands = self._ai_callback(snapshot, pending_units, self._ctx) or []

            response = self.step_battle(battle_id, commands, n_steps=1)
            self._ctx["episode_steps"] = int(self._ctx.get("episode_steps", 0)) + 1

        raise TimeoutError(f"Battle did not terminate within {max_steps} steps")


def start_battle(client: ArenaClient, config: Dict[str, Any]) -> Dict[str, Any]:
    """Functional helper equivalent to ``client.start_battle(config)``.

    Args:
        client: Configured :class:`ArenaClient`.
        config: Battle creation config dictionary.

    Returns:
        First battle response payload.
    """
    return client.start_battle(config)
