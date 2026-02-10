"""Train neural composer modules with delayed rewards and backpropagation.

Training strategy:
- Start from `build_baseline_composer()`.
- Replace selected modules with neural modules (target/movement/fire).
- Roll out episodes through arena gRPC session stepping.
- Every 10 seconds, compute delayed reward from gas-value differential change.
- Update selected neural modules using policy-gradient style loss.

Gas objective:
- Metric per snapshot = `(enemy_remaining_gas + enemy_field_value) - (our_remaining_gas + our_field_value)`
- `field_value` uses per-unit `deploymentGasCost` scaled linearly by structure HP ratio.
- Reward chunk = negative delta of metric (`-(metric_t - metric_prev)`).
"""

from __future__ import annotations

import argparse
import importlib
import json
import subprocess
import sys
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple

PYTHON_DIR = Path(__file__).resolve().parent
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from modules.ai_composer import (
    AIComposer,
    NeuralFireModule,
    NeuralMovementModule,
    NeuralTargetModule,
    build_baseline_composer,
    create_fire_model,
    create_movement_model,
    create_target_model,
)

try:
    import grpc
    import torch
except Exception as exc:  # pragma: no cover - dependency guard
    raise RuntimeError(
        "train.py requires `grpcio`, `grpcio-tools`, and `torch`.\n"
        "Install with: pip install grpcio grpcio-tools torch"
    ) from exc


USE_NEURAL_TARGET = False
USE_NEURAL_MOVEMENT = False
USE_NEURAL_FIRE = True


@dataclass
class TrainConfig:
    """Static training configuration."""

    endpoint: str = "localhost:50051"
    episodes: int = 20
    max_steps_per_episode: int = 3000
    chunk_seconds: float = 10.0
    learning_rate: float = 1e-3
    hidden_dim: int = 64
    hidden_layers: int = 2
    seed: int = 123
    battle_max_sim_seconds: int = 240
    battle_node_defense: int = 1
    battle_player_gas: int = 10000
    battle_enemy_gas: int = 10000
    battle_with_base: bool = True
    battle_initial_units_per_side: int = 2
    battle_external_ai_player: bool = True
    battle_external_ai_enemy: bool = False
    battle_width: int = 2000
    battle_height: int = 1000
    battle_ground_height: int = 700


class ArenaGrpcStubAdapter:
    """Dictionary-friendly wrapper around generated gRPC client stub."""

    def __init__(self, endpoint: str) -> None:
        modules = _load_or_generate_proto_modules()
        pb2 = modules["pb2"]
        pb2_grpc = modules["pb2_grpc"]
        self._pb2 = pb2
        self._channel = grpc.insecure_channel(endpoint)
        self._stub = pb2_grpc.ArenaServiceStub(self._channel)

    def CreateBattle(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Create battle and return dict response."""

        req = self._pb2.CreateBattleRequest(config_json=json.dumps(config))
        res = self._stub.CreateBattle(req)
        return _message_to_dict(res)

    def StepBattle(self, req_dict: Dict[str, Any]) -> Dict[str, Any]:
        """Step battle and return dict response."""

        commands = [
            self._to_unit_step_command(c)
            for c in req_dict.get("commands", [])
        ]
        req = self._pb2.StepBattleRequest(
            battle_id=str(req_dict.get("battle_id", "")),
            commands=commands,
            n_steps=max(1, int(req_dict.get("n_steps", 1))),
        )
        res = self._stub.StepBattle(req)
        return _message_to_dict(res)

    def GetBattle(self, req_dict: Dict[str, Any]) -> Dict[str, Any]:
        """Get battle state and return dict response."""

        req = self._pb2.GetBattleRequest(battle_id=str(req_dict.get("battle_id", "")))
        res = self._stub.GetBattle(req)
        return _message_to_dict(res)

    def CloseBattle(self, req_dict: Dict[str, Any]) -> Dict[str, Any]:
        """Close battle and return dict response."""

        req = self._pb2.CloseBattleRequest(battle_id=str(req_dict.get("battle_id", "")))
        res = self._stub.CloseBattle(req)
        return _message_to_dict(res)

    def _to_unit_step_command(self, command: Dict[str, Any]) -> Any:
        """Convert command dictionary into proto message."""

        move = command.get("move", {})
        fire_requests = []
        for fr in command.get("fire_requests", []):
            fire_requests.append(
                self._pb2.FireRequest(
                    slot=int(fr.get("slot", -1)),
                    aim_x=float(fr.get("aim_x", 0.0)),
                    aim_y=float(fr.get("aim_y", 0.0)),
                    intended_target_id=str(fr.get("intended_target_id", "")),
                    intended_target_y=float(fr.get("intended_target_y", 0.0)),
                    has_intended_target_y=("intended_target_y" in fr and fr.get("intended_target_y") is not None),
                )
            )
        return self._pb2.UnitStepCommand(
            unit_id=str(command.get("unit_id", "")),
            move=self._pb2.MoveCommand(
                dir_x=float(move.get("dir_x", 0.0)),
                dir_y=float(move.get("dir_y", 0.0)),
                allow_descend=bool(move.get("allow_descend", False)),
            ),
            facing=int(command.get("facing", 0)),
            fire_requests=fire_requests,
        )


def _repo_root() -> Path:
    """Return repository root path from this script location."""

    return Path(__file__).resolve().parents[2]


def _message_to_dict(msg: Any) -> Dict[str, Any]:
    """Convert protobuf message to snake_case dictionary."""

    from google.protobuf.json_format import MessageToDict

    return MessageToDict(msg, preserving_proto_field_name=True)


def _load_or_generate_proto_modules() -> Dict[str, Any]:
    """Load generated proto modules, generating them on demand."""

    root = _repo_root()
    generated_dir = root / "arena" / "python" / "_generated"
    generated_dir.mkdir(parents=True, exist_ok=True)
    init_file = generated_dir / "__init__.py"
    if not init_file.exists():
        init_file.write_text('"""Generated protobuf modules for arena python client."""\n', encoding="utf-8")

    pb2_path = generated_dir / "arena_service_pb2.py"
    pb2_grpc_path = generated_dir / "arena_service_pb2_grpc.py"

    def _generate_proto() -> None:
        proto_path = root / "arena" / "proto" / "arena_service.proto"
        cmd = [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            f"-I{proto_path.parent}",
            f"--python_out={generated_dir}",
            f"--grpc_python_out={generated_dir}",
            str(proto_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(
                "Failed to generate protobuf python files.\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )

    if not (pb2_path.exists() and pb2_grpc_path.exists()):
        _generate_proto()

    import_path = "_generated"
    python_dir = root / "arena" / "python"
    if str(generated_dir) not in sys.path:
        sys.path.insert(0, str(generated_dir))
    if str(python_dir) not in sys.path:
        sys.path.insert(0, str(python_dir))

    pb2_module_name = f"{import_path}.arena_service_pb2"
    pb2_grpc_module_name = f"{import_path}.arena_service_pb2_grpc"
    try:
        importlib.invalidate_caches()
        sys.modules.pop(pb2_module_name, None)
        sys.modules.pop(pb2_grpc_module_name, None)
        sys.modules.pop("arena_service_pb2", None)
        sys.modules.pop("arena_service_pb2_grpc", None)
        pb2 = importlib.import_module(pb2_module_name)
        pb2_grpc = importlib.import_module(pb2_grpc_module_name)
    except Exception:
        _generate_proto()
        importlib.invalidate_caches()
        sys.modules.pop(pb2_module_name, None)
        sys.modules.pop(pb2_grpc_module_name, None)
        sys.modules.pop("arena_service_pb2", None)
        sys.modules.pop("arena_service_pb2_grpc", None)
        pb2 = importlib.import_module(pb2_module_name)
        pb2_grpc = importlib.import_module(pb2_grpc_module_name)
    return {"pb2": pb2, "pb2_grpc": pb2_grpc}


def build_trainable_composer(cfg: TrainConfig) -> Tuple[AIComposer, Dict[str, torch.nn.Module]]:
    """Build baseline composer and selectively replace modules with neural modules."""

    composer = build_baseline_composer(desired_range=280.0, cadence_steps=1)
    models: Dict[str, torch.nn.Module] = {}

    if USE_NEURAL_TARGET:
        target_model = create_target_model(hidden_dim=cfg.hidden_dim, hidden_layers=cfg.hidden_layers)
        composer.target_module = NeuralTargetModule(target_model, sample_actions=True)
        models["target"] = target_model
    if USE_NEURAL_MOVEMENT:
        movement_model = create_movement_model(hidden_dim=cfg.hidden_dim, hidden_layers=cfg.hidden_layers)
        composer.movement_module = NeuralMovementModule(movement_model, desired_range=280.0, sample_actions=True)
        models["movement"] = movement_model
    if USE_NEURAL_FIRE:
        fire_model = create_fire_model(hidden_dim=cfg.hidden_dim, hidden_layers=cfg.hidden_layers)
        composer.fire_module = NeuralFireModule(fire_model, sample_actions=True)
        models["fire"] = fire_model
    return composer, models


def _structure_hp_ratio(unit: Dict[str, Any]) -> float:
    """Compute linear HP ratio from structure cells for one unit."""

    structure = unit.get("structure", []) or []
    if not structure:
        return 1.0
    total = 0.0
    count = 0
    for cell in structure:
        break_threshold = float(cell.get("breakThreshold", 0.0) or 0.0)
        strain = float(cell.get("strain", 0.0) or 0.0)
        destroyed = bool(cell.get("destroyed", False))
        if break_threshold <= 1e-6:
            ratio = 0.0 if destroyed else 1.0
        elif destroyed:
            ratio = 0.0
        else:
            ratio = max(0.0, min(1.0, (break_threshold - strain) / break_threshold))
        total += ratio
        count += 1
    return total / max(1, count)


def _on_field_gas_value(state: Dict[str, Any], side: str) -> float:
    """Estimate on-field gas value with linear HP decay by structure health."""

    value = 0.0
    for unit in state.get("units", []):
        if not unit.get("alive", True):
            continue
        if str(unit.get("side", "")) != side:
            continue
        deploy_cost = float(unit.get("deploymentGasCost", 0.0) or 0.0)
        hp_ratio = _structure_hp_ratio(unit)
        value += deploy_cost * hp_ratio
    return value


def gas_advantage_metric(snapshot: Dict[str, Any]) -> float:
    """Compute `(enemy_total_value - our_total_value)` metric from snapshot."""

    state = snapshot.get("state", snapshot)
    player_gas = float(snapshot.get("player_gas", 0.0))
    enemy_gas = float(snapshot.get("enemy_gas", state.get("enemyGas", 0.0) or 0.0))
    player_total = player_gas + _on_field_gas_value(state, "player")
    enemy_total = enemy_gas + _on_field_gas_value(state, "enemy")
    return enemy_total - player_total


def _tensor_policy_loss(chunk_reward: float, log_probs: List[torch.Tensor], reward_baseline: float) -> torch.Tensor:
    """Build REINFORCE-style loss tensor for one delayed-reward chunk."""

    if not log_probs:
        return torch.tensor(0.0, dtype=torch.float32)
    advantage = float(chunk_reward - reward_baseline)
    stacked = torch.stack(log_probs)
    return -advantage * stacked.mean()


def _episode_config(seed: int, cfg: TrainConfig) -> Dict[str, Any]:
    """Return one battle configuration dictionary for training episodes."""

    return {
        "seed": int(seed),
        "maxSimSeconds": int(cfg.battle_max_sim_seconds),
        "nodeDefense": int(cfg.battle_node_defense),
        "playerGas": int(cfg.battle_player_gas),
        "enemyGas": int(cfg.battle_enemy_gas),
        "scenario": {
            "withBase": bool(cfg.battle_with_base),
            "initialUnitsPerSide": int(cfg.battle_initial_units_per_side),
        },
        "battlefield": {
            "width": int(cfg.battle_width),
            "height": int(cfg.battle_height),
            "groundHeight": int(cfg.battle_ground_height),
        },
        "externalAiSides": {
            "player": bool(cfg.battle_external_ai_player),
            "enemy": bool(cfg.battle_external_ai_enemy),
        },
    }


def train(cfg: TrainConfig) -> None:
    """Run delayed-reward training across multiple episodes."""

    torch.manual_seed(cfg.seed)
    composer, models = build_trainable_composer(cfg)
    if not models:
        raise RuntimeError("No neural modules enabled. Set at least one USE_NEURAL_* flag to True.")

    params = []
    for model in models.values():
        params.extend(list(model.parameters()))
    optimizer = torch.optim.Adam(params, lr=cfg.learning_rate)
    stub = ArenaGrpcStubAdapter(cfg.endpoint)

    reward_baseline = 0.0
    baseline_beta = 0.95
    total_updates = 0

    for episode in range(cfg.episodes):
        start = stub.CreateBattle(_episode_config(cfg.seed + episode * 7919, cfg))
        battle_id = str(start.get("battle_id", ""))
        if not battle_id:
            raise RuntimeError("CreateBattle response missing battle_id")

        response = start
        snapshot = json.loads(response.get("snapshot_json", "{}") or "{}")
        prev_metric = gas_advantage_metric(snapshot)
        dt = float(response.get("dt_seconds", 1.0 / 60.0))
        chunk_steps = max(1, int(cfg.chunk_seconds / max(1e-6, dt)))
        step = 0
        episode_reward = 0.0
        ctx: Dict[str, Any] = {
            "steps": 0,
            "_collect_log_probs": True,
            "_policy_log_probs": [],
        }

        while (not bool(response.get("terminal", False))) and step < cfg.max_steps_per_episode:
            pending_units = response.get("pending_units", []) or []
            commands = composer.callback(snapshot=snapshot, pending_units=pending_units, ctx=ctx)
            response = stub.StepBattle({"battle_id": battle_id, "commands": commands, "n_steps": 1})
            snapshot = json.loads(response.get("snapshot_json", "{}") or "{}")
            current_metric = gas_advantage_metric(snapshot)
            step += 1
            ctx["steps"] = int(ctx.get("steps", 0)) + 1

            if (step % chunk_steps == 0) or bool(response.get("terminal", False)):
                chunk_reward = -(current_metric - prev_metric)
                prev_metric = current_metric
                episode_reward += chunk_reward
                loss = _tensor_policy_loss(chunk_reward, ctx["_policy_log_probs"], reward_baseline)
                if float(loss.item()) != 0.0:
                    optimizer.zero_grad(set_to_none=True)
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(params, 1.0)
                    optimizer.step()
                    total_updates += 1
                reward_baseline = baseline_beta * reward_baseline + (1.0 - baseline_beta) * chunk_reward
                ctx["_policy_log_probs"] = []

        stub.CloseBattle({"battle_id": battle_id})
        print(
            f"[train] episode={episode + 1}/{cfg.episodes} "
            f"steps={step} reward={episode_reward:.4f} baseline={reward_baseline:.4f} updates={total_updates}"
        )

    out_dir = _repo_root() / "arena" / ".arena-data" / "python-models"
    out_dir.mkdir(parents=True, exist_ok=True)
    run_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    for name, model in models.items():
        path = out_dir / f"{name}_{run_timestamp}.pt"
        torch.save(model.state_dict(), path)
        print(f"[train] saved {name} model: {path}")


def main() -> None:
    """CLI entry point for training script."""

    parser = argparse.ArgumentParser(description="Train neural composer modules with delayed rewards.")
    parser.add_argument("--hidden-layers", type=int, default=None, help="Number of hidden layers in each MLP head.")
    parser.add_argument("--hidden-dim", type=int, default=None, help="Hidden width for each MLP head.")
    parser.add_argument("--episodes", type=int, default=None, help="Number of training episodes.")
    parser.add_argument("--battle-max-sim-seconds", type=int, default=None, help="CreateBattle.maxSimSeconds")
    parser.add_argument("--battle-node-defense", type=int, default=None, help="CreateBattle.nodeDefense")
    parser.add_argument("--battle-player-gas", type=int, default=None, help="CreateBattle.playerGas")
    parser.add_argument("--battle-enemy-gas", type=int, default=None, help="CreateBattle.enemyGas")
    parser.add_argument(
        "--battle-with-base",
        choices=["true", "false"],
        default=None,
        help="CreateBattle.scenario.withBase",
    )
    parser.add_argument(
        "--battle-initial-units-per-side",
        type=int,
        default=None,
        help="CreateBattle.scenario.initialUnitsPerSide",
    )
    parser.add_argument(
        "--battle-external-ai-player",
        choices=["true", "false"],
        default=None,
        help="CreateBattle.externalAiSides.player",
    )
    parser.add_argument(
        "--battle-external-ai-enemy",
        choices=["true", "false"],
        default=None,
        help="CreateBattle.externalAiSides.enemy",
    )
    parser.add_argument("--battle-width", type=int, default=None, help="CreateBattle.battlefield.width")
    parser.add_argument("--battle-height", type=int, default=None, help="CreateBattle.battlefield.height")
    parser.add_argument(
        "--battle-ground-height",
        type=int,
        default=None,
        help="CreateBattle.battlefield.groundHeight",
    )
    args = parser.parse_args()

    cfg = TrainConfig()
    if args.hidden_layers is not None:
        cfg.hidden_layers = max(0, int(args.hidden_layers))
    if args.hidden_dim is not None:
        cfg.hidden_dim = max(1, int(args.hidden_dim))
    if args.episodes is not None:
        cfg.episodes = max(1, int(args.episodes))
    if args.battle_max_sim_seconds is not None:
        cfg.battle_max_sim_seconds = max(1, int(args.battle_max_sim_seconds))
    if args.battle_node_defense is not None:
        cfg.battle_node_defense = max(0, int(args.battle_node_defense))
    if args.battle_player_gas is not None:
        cfg.battle_player_gas = max(0, int(args.battle_player_gas))
    if args.battle_enemy_gas is not None:
        cfg.battle_enemy_gas = max(0, int(args.battle_enemy_gas))
    if args.battle_with_base is not None:
        cfg.battle_with_base = args.battle_with_base == "true"
    if args.battle_initial_units_per_side is not None:
        cfg.battle_initial_units_per_side = max(0, int(args.battle_initial_units_per_side))
    if args.battle_external_ai_player is not None:
        cfg.battle_external_ai_player = args.battle_external_ai_player == "true"
    if args.battle_external_ai_enemy is not None:
        cfg.battle_external_ai_enemy = args.battle_external_ai_enemy == "true"
    if args.battle_width is not None:
        cfg.battle_width = max(640, int(args.battle_width))
    if args.battle_height is not None:
        cfg.battle_height = max(360, int(args.battle_height))
    if args.battle_ground_height is not None:
        cfg.battle_ground_height = max(40, int(args.battle_ground_height))
    train(cfg)


if __name__ == "__main__":
    main()
