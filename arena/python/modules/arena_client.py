from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


Snapshot = Dict[str, Any]
PendingUnits = List[Dict[str, Any]]
UnitCommand = Dict[str, Any]
AiCallback = Callable[[Snapshot, PendingUnits, Dict[str, Any]], List[UnitCommand]]


def AI_callback(fun: AiCallback) -> AiCallback:
    if not callable(fun):
        raise TypeError("AI_callback expects a callable")
    return fun


@dataclass
class ArenaClient:
    endpoint: str
    grpc_stub: Any = None
    _ai_callback: Optional[AiCallback] = None
    _ctx: Dict[str, Any] = field(default_factory=dict)

    def set_ai_callback(self, fun: AiCallback) -> None:
        self._ai_callback = AI_callback(fun)

    def start_battle(self, config: Dict[str, Any]) -> Dict[str, Any]:
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
        if self.grpc_stub is None:
            raise RuntimeError("ArenaClient requires a gRPC stub.")
        req = {
            "battle_id": battle_id,
            "commands": commands,
            "n_steps": max(1, int(n_steps)),
        }
        return self.grpc_stub.StepBattle(req)

    def get_battle(self, battle_id: str) -> Dict[str, Any]:
        if self.grpc_stub is None:
            raise RuntimeError("ArenaClient requires a gRPC stub.")
        return self.grpc_stub.GetBattle({"battle_id": battle_id})

    def close_battle(self, battle_id: str) -> Dict[str, Any]:
        if self.grpc_stub is None:
            raise RuntimeError("ArenaClient requires a gRPC stub.")
        return self.grpc_stub.CloseBattle({"battle_id": battle_id})

    def run_until_terminal(
        self,
        first_response: Dict[str, Any],
        max_steps: int = 20_000,
    ) -> Dict[str, Any]:
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
    return client.start_battle(config)
