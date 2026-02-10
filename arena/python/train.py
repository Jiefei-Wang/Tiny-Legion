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
import math
import random
import subprocess
import sys
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

PYTHON_DIR = Path(__file__).resolve().parent
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from modules.ai_composer import (
    AIComposer,
    FirePlan,
    MovementPlan,
    NeuralFireModule,
    NeuralMovementModule,
    NeuralTargetModule,
    TargetAssignment,
    TargetPlan,
    build_baseline_composer,
    create_fire_model,
    create_movement_model,
    create_target_model,
)
from modules.features import extract_fire_features, extract_movement_features, extract_target_features

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
    episodes: int = 2000
    max_steps_per_episode: int = 3000
    chunk_seconds: float = 2.0
    learning_rate: float = 1e-3
    hidden_dim: int = 64
    hidden_layers: int = 2
    seed: int = 123
    self_play_same_model: bool = False
    train_enemy_side: bool = False
    base_hp_weight: float = 1000.0
    metric_delta_weight: float = 1.0
    terminal_reward_scale: float = 120.0
    reward_clip_abs: float = 300.0
    entropy_coef: float = 0.01
    grad_clip_norm: float = 1.0
    baseline_beta: float = 0.98
    adv_var_beta: float = 0.98
    bc_epochs: int = 3
    bc_episodes: int = 6
    bc_steps_per_episode: int = 500
    bc_batch_size: int = 256
    bc_fire_weight: float = 2.5
    bc_lr_scale: float = 0.7
    eval_every_episodes: int = 25
    eval_episodes: int = 8
    eval_max_steps: int = 3000
    save_best_only: bool = False
    print_every_episodes: int = 1
    battle_max_sim_seconds: int = 240
    battle_node_defense: int = 1
    battle_player_gas: int = 10000
    battle_enemy_gas: int = 10000
    battle_with_base: bool = True
    battle_initial_units_per_side: int = 2
    battle_external_ai_player: bool = True
    battle_external_ai_enemy: bool = False
    battle_width: int = 500
    battle_height: int = 1000
    battle_ground_height: int = 700


def _module_kind_from_name(component_name: str) -> str:
    """Map training component key to composite module key."""

    if component_name == "fire":
        return "shoot"
    return component_name


def _component_io_shape(component_name: str) -> Tuple[int, int]:
    """Return expected `(input_dim, output_dim)` for one component model."""

    if component_name == "target":
        return (14, 1)
    if component_name == "movement":
        return (14, 3)
    if component_name == "fire":
        return (12, 2)
    raise ValueError(f"Unsupported component name: {component_name}")


def _create_component_model(component_name: str, hidden_dim: int, hidden_layers: int) -> torch.nn.Module:
    """Create one component model instance from configuration."""

    if component_name == "target":
        return create_target_model(hidden_dim=hidden_dim, hidden_layers=hidden_layers)
    if component_name == "movement":
        return create_movement_model(hidden_dim=hidden_dim, hidden_layers=hidden_layers)
    if component_name == "fire":
        return create_fire_model(hidden_dim=hidden_dim, hidden_layers=hidden_layers)
    raise ValueError(f"Unsupported component name: {component_name}")


def _export_component_conversion(
    component_name: str,
    model: torch.nn.Module,
    out_dir: Path,
    stem: str,
    hidden_dim: int,
    hidden_layers: int,
) -> Dict[str, Path]:
    """Export component model to ONNX and component config JSON."""

    input_dim, _ = _component_io_shape(component_name)
    onnx_path = out_dir / f"{stem}.onnx"
    config_path = out_dir / f"{stem}.component.json"

    model.eval()
    dummy_input = torch.randn(1, input_dim, dtype=torch.float32)
    export_kwargs = {
        "export_params": True,
        "do_constant_folding": True,
        "input_names": ["x"],
        "output_names": ["y"],
        "dynamic_axes": {"x": {0: "batch"}, "y": {0: "batch"}},
        "opset_version": 17,
    }
    try:
        torch.onnx.export(
            model,
            dummy_input,
            str(onnx_path),
            dynamo=False,
            **export_kwargs,
        )
    except TypeError:
        torch.onnx.export(
            model,
            dummy_input,
            str(onnx_path),
            **export_kwargs,
        )

    config_payload = {
        "schemaVersion": "ai-component.v1",
        "moduleKind": _module_kind_from_name(component_name),
        "aiType": "onnx",
        "modelPath": str(onnx_path),
        "inputName": "x",
        "outputName": "y",
        "hiddenDim": int(hidden_dim),
        "hiddenLayers": int(hidden_layers),
    }
    config_path.write_text(json.dumps(config_payload, indent=2), encoding="utf-8")
    return {"onnx": onnx_path, "config": config_path}


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


def _load_template_gas_costs() -> Dict[str, float]:
    """Load template gas costs from default game template JSON files.

    Returns:
        Mapping from ``templateId`` to ``gasCost``.
    """

    root = _repo_root()
    template_dir = root / "game" / "templates" / "default"
    result: Dict[str, float] = {}
    if not template_dir.exists():
        return result
    for path in template_dir.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        template_id = str(data.get("id", "")).strip()
        if not template_id:
            continue
        gas_cost = float(data.get("gasCost", 0.0) or 0.0)
        if gas_cost > 0.0:
            result[template_id] = gas_cost
    return result


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


def build_trainable_composer(cfg: TrainConfig, sample_actions: bool) -> Tuple[AIComposer, Dict[str, torch.nn.Module]]:
    """Build baseline composer and selectively replace modules with neural modules."""

    composer = build_baseline_composer(desired_range=280.0, cadence_steps=1)
    models: Dict[str, torch.nn.Module] = {}

    if USE_NEURAL_TARGET:
        target_model = create_target_model(hidden_dim=cfg.hidden_dim, hidden_layers=cfg.hidden_layers)
        composer.target_module = NeuralTargetModule(target_model, sample_actions=sample_actions)
        models["target"] = target_model
    if USE_NEURAL_MOVEMENT:
        movement_model = create_movement_model(hidden_dim=cfg.hidden_dim, hidden_layers=cfg.hidden_layers)
        composer.movement_module = NeuralMovementModule(
            movement_model,
            desired_range=280.0,
            sample_actions=sample_actions,
        )
        models["movement"] = movement_model
    if USE_NEURAL_FIRE:
        fire_model = create_fire_model(hidden_dim=cfg.hidden_dim, hidden_layers=cfg.hidden_layers)
        composer.fire_module = NeuralFireModule(fire_model, sample_actions=sample_actions)
        models["fire"] = fire_model
    return composer, models


def build_composer_from_models(cfg: TrainConfig, models: Dict[str, torch.nn.Module], sample_actions: bool) -> AIComposer:
    """Build composer reusing existing model instances with chosen sampling mode."""

    composer = build_baseline_composer(desired_range=280.0, cadence_steps=1)
    if "target" in models:
        composer.target_module = NeuralTargetModule(models["target"], sample_actions=sample_actions)
    if "movement" in models:
        composer.movement_module = NeuralMovementModule(
            models["movement"],
            desired_range=280.0,
            sample_actions=sample_actions,
        )
    if "fire" in models:
        composer.fire_module = NeuralFireModule(models["fire"], sample_actions=sample_actions)
    return composer


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


def _on_field_gas_value(state: Dict[str, Any], side: str, template_costs: Dict[str, float]) -> float:
    """Estimate on-field gas value with linear HP decay by structure health."""

    value = 0.0
    for unit in state.get("units", []):
        if not unit.get("alive", True):
            continue
        if str(unit.get("side", "")) != side:
            continue
        deploy_cost = float(unit.get("deploymentGasCost", 0.0) or 0.0)
        if deploy_cost <= 0.0:
            template_id = str(unit.get("templateId", "")).strip()
            deploy_cost = float(template_costs.get(template_id, 0.0))
        hp_ratio = _structure_hp_ratio(unit)
        value += deploy_cost * hp_ratio
    return value


def _base_hp_ratio(state: Dict[str, Any], side: str) -> float:
    """Return base HP ratio in `[0, 1]` for one side."""

    base_key = "playerBase" if side == "player" else "enemyBase"
    base = state.get(base_key, {}) or {}
    hp = float(base.get("hp", 0.0) or 0.0)
    max_hp = float(base.get("maxHp", 0.0) or 0.0)
    if max_hp <= 1e-6:
        return 0.0
    return max(0.0, min(1.0, hp / max_hp))


def gas_advantage_metric(snapshot: Dict[str, Any], template_costs: Dict[str, float], base_hp_weight: float) -> float:
    """Compute `(enemy_total_value - our_total_value)` metric from snapshot."""

    state = snapshot.get("state", snapshot)
    player_gas = float(snapshot.get("player_gas", 0.0))
    enemy_gas = float(snapshot.get("enemy_gas", state.get("enemyGas", 0.0) or 0.0))
    player_total = player_gas + _on_field_gas_value(state, "player", template_costs)
    enemy_total = enemy_gas + _on_field_gas_value(state, "enemy", template_costs)
    player_base = _base_hp_ratio(state, "player")
    enemy_base = _base_hp_ratio(state, "enemy")
    base_hp_term = float(base_hp_weight) * (enemy_base - player_base)
    return (enemy_total - player_total) + base_hp_term


def _clampf(value: float, min_v: float, max_v: float) -> float:
    """Clamp float to closed interval."""

    return max(min_v, min(max_v, value))


def _unit_id(unit: Dict[str, Any]) -> str:
    """Resolve canonical unit id from pending/state entries."""

    return str(unit.get("unit_id") or unit.get("id") or "")


def _compute_terminal_bonus(response: Dict[str, Any], side: str, scale: float) -> float:
    """Return terminal reward bonus for `side` from battle outcome."""

    if not bool(response.get("terminal", False)):
        return 0.0
    outcome = response.get("outcome", {}) or {}
    victory = bool(outcome.get("victory", False))
    if side == "player":
        return float(scale) if victory else -float(scale)
    return -float(scale) if victory else float(scale)


def _policy_loss_from_advantage(
    advantage: float,
    log_probs: Sequence[torch.Tensor],
    entropies: Sequence[torch.Tensor],
    entropy_coef: float,
) -> torch.Tensor:
    """Build one policy loss tensor from normalized advantage and entropy bonus."""

    if not log_probs:
        return torch.tensor(0.0, dtype=torch.float32)
    log_prob_term = torch.stack(list(log_probs)).mean()
    loss = -float(advantage) * log_prob_term
    if entropies:
        entropy_term = torch.stack(list(entropies)).mean()
        loss = loss - float(entropy_coef) * entropy_term
    return loss


def _find_unit_by_state_id(state: Dict[str, Any], unit_id: str) -> Optional[Dict[str, Any]]:
    """Find state unit by unit id."""

    for unit in state.get("units", []):
        if str(unit.get("id", "")) == unit_id:
            return unit
    return None


def _enemy_candidates(state: Dict[str, Any], side: str) -> List[Dict[str, Any]]:
    """Return alive enemy units for one side."""

    return [u for u in state.get("units", []) if u.get("alive", True) and str(u.get("side", "")) != side]


def _extract_supervised_target_samples(
    unit: Dict[str, Any],
    snapshot: Dict[str, Any],
    target_plan: TargetPlan,
    samples: List[Tuple[torch.Tensor, int]],
) -> None:
    """Append target-module supervised samples for one unit decision."""

    state = snapshot.get("state", snapshot)
    enemies = _enemy_candidates(state, str(unit.get("side", "")))
    if not enemies:
        return

    assignments_by_slot: Dict[int, TargetAssignment] = {int(a.slot): a for a in target_plan.assignments}
    weapon_count = int(unit.get("weapon_count", 0) or 0)
    if weapon_count <= 0:
        weapon_count = len(unit.get("weaponAttachmentIds", []) or [])
    weapon_count = max(1, weapon_count)
    max_slots = 8
    for slot in range(min(max_slots, weapon_count)):
        target_id = assignments_by_slot.get(slot).target_id if slot in assignments_by_slot else str(enemies[0].get("id", ""))
        target_idx = 0
        rows: List[List[float]] = []
        for idx, enemy in enumerate(enemies):
            rows.append(extract_target_features(unit=unit, enemy=enemy, slot=slot, snapshot=snapshot, max_slots=max_slots))
            if str(enemy.get("id", "")) == target_id:
                target_idx = idx
        samples.append((torch.tensor(rows, dtype=torch.float32), int(target_idx)))


def _extract_supervised_movement_samples(
    unit: Dict[str, Any],
    snapshot: Dict[str, Any],
    target_plan: TargetPlan,
    movement_plan: MovementPlan,
    samples: List[Tuple[torch.Tensor, torch.Tensor]],
    desired_range: float = 280.0,
) -> None:
    """Append movement-module supervised sample for one unit decision."""

    state = snapshot.get("state", snapshot)
    primary_target: Optional[Dict[str, Any]] = None
    if target_plan.primary_target_id:
        primary_target = _find_unit_by_state_id(state, target_plan.primary_target_id)
    features = extract_movement_features(
        unit=unit,
        primary_target=primary_target,
        desired_range=desired_range,
        snapshot=snapshot,
        engage_state_flag=1.0,
    )
    label = torch.tensor(
        [
            float(_clampf(movement_plan.dir_x, -1.0, 1.0)),
            float(_clampf(movement_plan.dir_y, -1.0, 1.0)),
            1.0 if movement_plan.allow_descend else 0.0,
        ],
        dtype=torch.float32,
    )
    samples.append((torch.tensor(features, dtype=torch.float32), label))


def _extract_supervised_fire_samples(
    unit: Dict[str, Any],
    snapshot: Dict[str, Any],
    target_plan: TargetPlan,
    movement_plan: MovementPlan,
    fire_plan: FirePlan,
    samples: List[Tuple[torch.Tensor, torch.Tensor]],
    angle_delta_max_rad: float = 0.45,
) -> None:
    """Append fire-module supervised samples for each slot assignment."""

    state = snapshot.get("state", snapshot)
    requests_by_slot: Dict[int, Dict[str, Any]] = {int(req.get("slot", -1)): req for req in fire_plan.fire_requests}
    for assignment in target_plan.assignments:
        slot = int(assignment.slot)
        target = _find_unit_by_state_id(state, assignment.target_id)
        features = extract_fire_features(
            unit=unit,
            assigned_target=target,
            slot=slot,
            movement_dir=(movement_plan.dir_x, movement_plan.dir_y),
            snapshot=snapshot,
            max_slots=8,
        )
        fire_req = requests_by_slot.get(slot)
        should_fire = 1.0 if fire_req is not None else 0.0
        angle_delta_norm = 0.0
        if fire_req is not None:
            ux = float(unit.get("x", 0.0))
            uy = float(unit.get("y", 0.0))
            base_angle = math.atan2(float(assignment.aim_y) - uy, float(assignment.aim_x) - ux)
            req_angle = math.atan2(float(fire_req.get("aim_y", assignment.aim_y)) - uy, float(fire_req.get("aim_x", assignment.aim_x)) - ux)
            raw_delta = req_angle - base_angle
            while raw_delta > math.pi:
                raw_delta -= 2.0 * math.pi
            while raw_delta < -math.pi:
                raw_delta += 2.0 * math.pi
            angle_delta_norm = float(_clampf(raw_delta / max(1e-5, angle_delta_max_rad), -1.0, 1.0))
        label = torch.tensor([should_fire, angle_delta_norm], dtype=torch.float32)
        samples.append((torch.tensor(features, dtype=torch.float32), label))


def run_behavior_cloning_warmstart(cfg: TrainConfig, models: Dict[str, torch.nn.Module], stub: "ArenaGrpcStubAdapter") -> None:
    """Collect baseline trajectories and warm-start enabled neural modules with supervised losses."""

    if cfg.bc_epochs <= 0 or cfg.bc_episodes <= 0:
        return
    if not models:
        return

    baseline = build_baseline_composer(desired_range=280.0, cadence_steps=1)
    target_samples: List[Tuple[torch.Tensor, int]] = []
    movement_samples: List[Tuple[torch.Tensor, torch.Tensor]] = []
    fire_samples: List[Tuple[torch.Tensor, torch.Tensor]] = []

    for ep in range(cfg.bc_episodes):
        start = stub.CreateBattle(_episode_config(cfg.seed + 100_000 + ep * 53, cfg))
        battle_id = str(start.get("battle_id", ""))
        if not battle_id:
            continue
        response = start
        snapshot = json.loads(response.get("snapshot_json", "{}") or "{}")
        steps = 0
        ctx: Dict[str, Any] = {"steps": 0, "_collect_log_probs": False}
        while not bool(response.get("terminal", False)) and steps < cfg.bc_steps_per_episode:
            pending_units = response.get("pending_units", []) or []
            commands: List[Dict[str, Any]] = []
            for pending in pending_units:
                uid = _unit_id(pending)
                state_unit = _find_unit_by_state_id(snapshot.get("state", snapshot), uid)
                if state_unit is None or not state_unit.get("alive", True):
                    continue
                target_plan = baseline.target_module.assign(state_unit, snapshot, pending_units, ctx)
                movement_plan = baseline.movement_module.plan(state_unit, snapshot, target_plan, pending_units, ctx)
                fire_plan = baseline.fire_module.plan(state_unit, snapshot, target_plan, movement_plan, pending_units, ctx)
                if "target" in models:
                    _extract_supervised_target_samples(state_unit, snapshot, target_plan, target_samples)
                if "movement" in models:
                    _extract_supervised_movement_samples(state_unit, snapshot, target_plan, movement_plan, movement_samples)
                if "fire" in models:
                    _extract_supervised_fire_samples(state_unit, snapshot, target_plan, movement_plan, fire_plan, fire_samples)
                commands.append(
                    {
                        "unit_id": uid,
                        "move": {
                            "dir_x": float(movement_plan.dir_x),
                            "dir_y": float(movement_plan.dir_y),
                            "allow_descend": bool(movement_plan.allow_descend),
                        },
                        "facing": 1 if movement_plan.dir_x >= 0 else -1,
                        "fire_requests": list(fire_plan.fire_requests),
                    }
                )
            response = stub.StepBattle({"battle_id": battle_id, "commands": commands, "n_steps": 1})
            snapshot = json.loads(response.get("snapshot_json", "{}") or "{}")
            steps += 1
            ctx["steps"] = steps
        stub.CloseBattle({"battle_id": battle_id})

    trainable_params: List[torch.nn.Parameter] = []
    for model in models.values():
        trainable_params.extend(list(model.parameters()))
    optimizer = torch.optim.Adam(trainable_params, lr=cfg.learning_rate * cfg.bc_lr_scale)

    batch_size = max(1, int(cfg.bc_batch_size))
    for epoch in range(cfg.bc_epochs):
        epoch_losses: List[float] = []

        if "target" in models and target_samples:
            random.shuffle(target_samples)
            target_model = models["target"]
            for rows, target_idx in target_samples:
                logits = target_model(rows).squeeze(-1)
                target = torch.tensor([target_idx], dtype=torch.long)
                loss = torch.nn.functional.cross_entropy(logits.unsqueeze(0), target)
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(trainable_params, cfg.grad_clip_norm)
                optimizer.step()
                epoch_losses.append(float(loss.item()))

        if "movement" in models and movement_samples:
            random.shuffle(movement_samples)
            movement_model = models["movement"]
            for i in range(0, len(movement_samples), batch_size):
                batch = movement_samples[i : i + batch_size]
                x = torch.stack([item[0] for item in batch], dim=0)
                y = torch.stack([item[1] for item in batch], dim=0)
                out = movement_model(x)
                move_loss = torch.nn.functional.mse_loss(torch.tanh(out[:, :2]), y[:, :2])
                descend_loss = torch.nn.functional.binary_cross_entropy_with_logits(out[:, 2], y[:, 2])
                loss = move_loss + descend_loss
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(trainable_params, cfg.grad_clip_norm)
                optimizer.step()
                epoch_losses.append(float(loss.item()))

        if "fire" in models and fire_samples:
            random.shuffle(fire_samples)
            fire_model = models["fire"]
            for i in range(0, len(fire_samples), batch_size):
                batch = fire_samples[i : i + batch_size]
                x = torch.stack([item[0] for item in batch], dim=0)
                y = torch.stack([item[1] for item in batch], dim=0)
                out = fire_model(x)
                fire_loss = torch.nn.functional.binary_cross_entropy_with_logits(
                    out[:, 0],
                    y[:, 0],
                    pos_weight=torch.tensor(float(cfg.bc_fire_weight)),
                )
                angle_loss = torch.nn.functional.mse_loss(torch.tanh(out[:, 1]), y[:, 1])
                loss = fire_loss + 0.25 * angle_loss
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(trainable_params, cfg.grad_clip_norm)
                optimizer.step()
                epoch_losses.append(float(loss.item()))

        mean_loss = sum(epoch_losses) / max(1, len(epoch_losses))
        print(
            f"[bc] epoch={epoch + 1}/{cfg.bc_epochs} "
            f"target_samples={len(target_samples)} movement_samples={len(movement_samples)} fire_samples={len(fire_samples)} "
            f"mean_loss={mean_loss:.4f}"
        )


def evaluate_policy(cfg: TrainConfig, composer: AIComposer, stub: "ArenaGrpcStubAdapter", seed_offset: int = 200_000) -> Dict[str, float]:
    """Run deterministic evaluation episodes and return aggregate metrics."""

    rewards: List[float] = []
    fire_counts: List[float] = []
    template_costs = _load_template_gas_costs()
    for ep in range(cfg.eval_episodes):
        start = stub.CreateBattle(_episode_config(cfg.seed + seed_offset + ep * 67, cfg))
        battle_id = str(start.get("battle_id", ""))
        if not battle_id:
            continue
        response = start
        snapshot = json.loads(response.get("snapshot_json", "{}") or "{}")
        prev_metric = gas_advantage_metric(snapshot, template_costs, cfg.base_hp_weight)
        step = 0
        episode_reward = 0.0
        episode_fire = 0
        ctx: Dict[str, Any] = {"steps": 0, "_collect_log_probs": False}
        while not bool(response.get("terminal", False)) and step < cfg.eval_max_steps:
            pending_units = response.get("pending_units", []) or []
            commands: List[Dict[str, Any]] = []
            for unit in pending_units:
                if not unit.get("alive", True):
                    continue
                cmd = composer.decide_unit(unit, snapshot, pending_units, ctx)
                episode_fire += len(cmd.get("fire_requests", []))
                commands.append(cmd)
            response = stub.StepBattle({"battle_id": battle_id, "commands": commands, "n_steps": 1})
            snapshot = json.loads(response.get("snapshot_json", "{}") or "{}")
            current_metric = gas_advantage_metric(snapshot, template_costs, cfg.base_hp_weight)
            step_reward = cfg.metric_delta_weight * (-(current_metric - prev_metric))
            prev_metric = current_metric
            if bool(response.get("terminal", False)):
                step_reward += _compute_terminal_bonus(response, "player", cfg.terminal_reward_scale)
            episode_reward += _clampf(step_reward, -cfg.reward_clip_abs, cfg.reward_clip_abs)
            step += 1
            ctx["steps"] = step
        stub.CloseBattle({"battle_id": battle_id})
        rewards.append(episode_reward)
        fire_counts.append(float(episode_fire))

    return {
        "eval_reward_mean": sum(rewards) / max(1, len(rewards)),
        "eval_reward_min": min(rewards) if rewards else 0.0,
        "eval_reward_max": max(rewards) if rewards else 0.0,
        "eval_fire_mean": sum(fire_counts) / max(1, len(fire_counts)),
    }


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
            "player": True if cfg.self_play_same_model else bool(cfg.battle_external_ai_player),
            "enemy": True if cfg.self_play_same_model else bool(cfg.battle_external_ai_enemy),
        },
    }


def train(cfg: TrainConfig) -> None:
    """Run delayed-reward training across multiple episodes."""

    random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)
    composer, models = build_trainable_composer(cfg, sample_actions=True)
    if not models:
        raise RuntimeError("No neural modules enabled. Set at least one USE_NEURAL_* flag to True.")

    params = []
    for model in models.values():
        params.extend(list(model.parameters()))
    optimizer = torch.optim.Adam(params, lr=cfg.learning_rate)
    stub = ArenaGrpcStubAdapter(cfg.endpoint)
    run_behavior_cloning_warmstart(cfg, models, stub)
    composer = build_composer_from_models(cfg, models, sample_actions=True)

    reward_baseline = 0.0
    adv_var_ema = 1.0
    total_updates = 0
    template_costs = _load_template_gas_costs()
    best_eval_reward = -1e18
    best_state_dict: Optional[Dict[str, Dict[str, torch.Tensor]]] = None

    for episode in range(cfg.episodes):
        start = stub.CreateBattle(_episode_config(cfg.seed + episode * 7919, cfg))
        battle_id = str(start.get("battle_id", ""))
        if not battle_id:
            raise RuntimeError("CreateBattle response missing battle_id")

        response = start
        snapshot = json.loads(response.get("snapshot_json", "{}") or "{}")
        prev_metric = gas_advantage_metric(snapshot, template_costs, cfg.base_hp_weight)
        dt = float(response.get("dt_seconds", 1.0 / 60.0))
        chunk_steps = max(1, int(cfg.chunk_seconds / max(1e-6, dt)))
        step = 0
        episode_reward = 0.0
        episode_raw_reward = 0.0
        episode_fire_requests = 0
        episode_commands = 0
        episode_entropy_samples: List[float] = []
        ctx: Dict[str, Any] = {
            "steps": 0,
            "_collect_log_probs": True,
        }
        chunk_log_probs: Dict[str, List[torch.Tensor]] = {"player": [], "enemy": []}
        chunk_entropies: Dict[str, List[torch.Tensor]] = {"player": [], "enemy": []}
        raw_chunk_reward = 0.0

        while (not bool(response.get("terminal", False))) and step < cfg.max_steps_per_episode:
            pending_units = response.get("pending_units", []) or []
            commands: List[Dict[str, Any]] = []
            for unit in pending_units:
                if not unit.get("alive", True):
                    continue
                unit_side = str(unit.get("side", "player"))
                unit_log_probs: List[torch.Tensor] = []
                unit_entropies: List[torch.Tensor] = []
                collect_this_unit = unit_side == "player" or bool(cfg.train_enemy_side)
                ctx["_collect_log_probs"] = collect_this_unit
                ctx["_policy_log_probs"] = unit_log_probs
                ctx["_policy_entropies"] = unit_entropies
                cmd = composer.decide_unit(unit, snapshot, pending_units, ctx)
                if cmd.get("unit_id"):
                    commands.append(cmd)
                episode_commands += 1
                episode_fire_requests += len(cmd.get("fire_requests", []))
                if unit_log_probs and collect_this_unit:
                    if unit_side not in chunk_log_probs:
                        chunk_log_probs[unit_side] = []
                    chunk_log_probs[unit_side].extend(unit_log_probs)
                if unit_entropies and collect_this_unit:
                    if unit_side not in chunk_entropies:
                        chunk_entropies[unit_side] = []
                    chunk_entropies[unit_side].extend(unit_entropies)
                    episode_entropy_samples.extend([float(t.detach().item()) for t in unit_entropies])
            response = stub.StepBattle({"battle_id": battle_id, "commands": commands, "n_steps": 1})
            snapshot = json.loads(response.get("snapshot_json", "{}") or "{}")
            current_metric = gas_advantage_metric(snapshot, template_costs, cfg.base_hp_weight)
            step += 1
            ctx["steps"] = int(ctx.get("steps", 0)) + 1
            step_reward = cfg.metric_delta_weight * (-(current_metric - prev_metric))
            prev_metric = current_metric
            if bool(response.get("terminal", False)):
                step_reward += _compute_terminal_bonus(response, "player", cfg.terminal_reward_scale)
            raw_chunk_reward += step_reward

            if (step % chunk_steps == 0) or bool(response.get("terminal", False)):
                chunk_reward = float(_clampf(raw_chunk_reward, -cfg.reward_clip_abs, cfg.reward_clip_abs))
                raw_chunk_reward = 0.0
                episode_reward += chunk_reward
                episode_raw_reward += chunk_reward
                advantage = float(chunk_reward - reward_baseline)
                adv_var_ema = cfg.adv_var_beta * adv_var_ema + (1.0 - cfg.adv_var_beta) * (advantage * advantage)
                advantage_norm = advantage / math.sqrt(max(1e-6, adv_var_ema))
                player_loss = _policy_loss_from_advantage(
                    advantage=advantage_norm,
                    log_probs=chunk_log_probs.get("player", []),
                    entropies=chunk_entropies.get("player", []),
                    entropy_coef=cfg.entropy_coef,
                )
                enemy_loss = torch.tensor(0.0, dtype=torch.float32)
                if cfg.train_enemy_side:
                    enemy_loss = _policy_loss_from_advantage(
                        advantage=-advantage_norm,
                        log_probs=chunk_log_probs.get("enemy", []),
                        entropies=chunk_entropies.get("enemy", []),
                        entropy_coef=cfg.entropy_coef,
                    )
                loss = player_loss + enemy_loss
                if float(loss.detach().item()) != 0.0:
                    optimizer.zero_grad(set_to_none=True)
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(params, cfg.grad_clip_norm)
                    optimizer.step()
                    total_updates += 1
                reward_baseline = cfg.baseline_beta * reward_baseline + (1.0 - cfg.baseline_beta) * chunk_reward
                chunk_log_probs = {"player": [], "enemy": []}
                chunk_entropies = {"player": [], "enemy": []}

        stub.CloseBattle({"battle_id": battle_id})
        if (episode + 1) % max(1, cfg.print_every_episodes) == 0:
            fire_per_100_cmd = 100.0 * float(episode_fire_requests) / max(1.0, float(episode_commands))
            entropy_mean = sum(episode_entropy_samples) / max(1, len(episode_entropy_samples))
            print(
                f"[train] episode={episode + 1}/{cfg.episodes} "
                f"steps={step} reward={episode_reward:.4f} raw_reward={episode_raw_reward:.4f} "
                f"baseline={reward_baseline:.4f} adv_std={math.sqrt(max(1e-6, adv_var_ema)):.4f} "
                f"fire_per_100_cmd={fire_per_100_cmd:.2f} entropy={entropy_mean:.4f} updates={total_updates}"
            )

        if ((episode + 1) % max(1, cfg.eval_every_episodes) == 0) or (episode + 1 == cfg.episodes):
            composer_eval = build_composer_from_models(cfg, models, sample_actions=False)
            eval_metrics = evaluate_policy(cfg, composer_eval, stub)
            eval_reward = float(eval_metrics["eval_reward_mean"])
            print(
                f"[eval] episode={episode + 1} "
                f"reward_mean={eval_reward:.4f} reward_min={eval_metrics['eval_reward_min']:.4f} "
                f"reward_max={eval_metrics['eval_reward_max']:.4f} fire_mean={eval_metrics['eval_fire_mean']:.2f}"
            )
            if eval_reward > best_eval_reward:
                best_eval_reward = eval_reward
                best_state_dict = {
                    name: {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
                    for name, model in models.items()
                }
                print(f"[eval] new best mean reward: {best_eval_reward:.4f}")

    if cfg.save_best_only and best_state_dict is not None:
        for name, model in models.items():
            model.load_state_dict(best_state_dict[name])

    out_dir = _repo_root() / "arena" / ".arena-data" / "python-models"
    out_dir.mkdir(parents=True, exist_ok=True)
    run_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    for name, model in models.items():
        stem = f"{name}_{run_timestamp}"
        pt_path = out_dir / f"{stem}.pt"
        torch.save(model.state_dict(), pt_path)
        conversion = _export_component_conversion(
            component_name=name,
            model=model,
            out_dir=out_dir,
            stem=stem,
            hidden_dim=cfg.hidden_dim,
            hidden_layers=cfg.hidden_layers,
        )
        print(f"[train] saved {name} model: {pt_path}")
        print(f"[train] converted {name} ONNX: {conversion['onnx']}")
        print(f"[train] wrote {name} component config: {conversion['config']}")


def convert_checkpoint(
    checkpoint_path: Path,
    component_name: str,
    hidden_dim: int,
    hidden_layers: int,
    out_dir: Optional[Path] = None,
) -> None:
    """Convert one existing `.pt` checkpoint into ONNX + component config JSON."""

    out = out_dir if out_dir is not None else checkpoint_path.parent
    out.mkdir(parents=True, exist_ok=True)
    model = _create_component_model(
        component_name=component_name,
        hidden_dim=hidden_dim,
        hidden_layers=hidden_layers,
    )
    state_dict = torch.load(checkpoint_path, map_location="cpu")
    model.load_state_dict(state_dict)
    conversion = _export_component_conversion(
        component_name=component_name,
        model=model,
        out_dir=out,
        stem=checkpoint_path.stem,
        hidden_dim=hidden_dim,
        hidden_layers=hidden_layers,
    )
    print(f"[convert] checkpoint: {checkpoint_path}")
    print(f"[convert] onnx: {conversion['onnx']}")
    print(f"[convert] component config: {conversion['config']}")


def main() -> None:
    """CLI entry point for training script."""

    parser = argparse.ArgumentParser(description="Train neural composer modules with delayed rewards.")
    parser.add_argument("--hidden-layers", type=int, default=None, help="Number of hidden layers in each MLP head.")
    parser.add_argument("--hidden-dim", type=int, default=None, help="Hidden width for each MLP head.")
    parser.add_argument("--episodes", type=int, default=None, help="Number of training episodes.")
    parser.add_argument("--max-steps-per-episode", type=int, default=None, help="Maximum StepBattle iterations per episode.")
    parser.add_argument("--chunk-seconds", type=float, default=None, help="Delayed reward chunk size in seconds.")
    parser.add_argument("--learning-rate", type=float, default=None, help="Adam learning rate.")
    parser.add_argument("--entropy-coef", type=float, default=None, help="Entropy bonus coefficient.")
    parser.add_argument("--reward-clip-abs", type=float, default=None, help="Absolute clip value for chunk rewards.")
    parser.add_argument("--terminal-reward-scale", type=float, default=None, help="Terminal win/loss reward bonus magnitude.")
    parser.add_argument("--eval-every-episodes", type=int, default=None, help="Run deterministic eval every N episodes.")
    parser.add_argument("--eval-episodes", type=int, default=None, help="Evaluation episode count.")
    parser.add_argument("--bc-epochs", type=int, default=None, help="Behavior-cloning warm-start epochs.")
    parser.add_argument("--bc-episodes", type=int, default=None, help="Behavior-cloning data collection episodes.")
    parser.add_argument("--bc-steps-per-episode", type=int, default=None, help="Behavior-cloning rollout steps per episode.")
    parser.add_argument("--bc-batch-size", type=int, default=None, help="Behavior-cloning batch size.")
    parser.add_argument("--save-best-only", choices=["true", "false"], default=None, help="If true, save best eval checkpoint instead of final.")
    parser.add_argument(
        "--convert-checkpoint",
        type=str,
        default=None,
        help="Convert an existing .pt checkpoint to ONNX + component config and exit.",
    )
    parser.add_argument(
        "--convert-component",
        choices=["target", "movement", "fire"],
        default=None,
        help="Component kind for --convert-checkpoint.",
    )
    parser.add_argument(
        "--convert-out-dir",
        type=str,
        default=None,
        help="Optional output directory for converted artifacts.",
    )
    parser.add_argument(
        "--self-play-same-model",
        choices=["true", "false"],
        default=None,
        help="If true, same model callback controls both player and enemy pending units.",
    )
    parser.add_argument(
        "--train-enemy-side",
        choices=["true", "false"],
        default=None,
        help="If true, also train enemy side with sign-flipped advantage.",
    )
    parser.add_argument(
        "--base-hp-weight",
        type=float,
        default=None,
        help="Reward metric weight for normalized base HP differential.",
    )
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
    if args.max_steps_per_episode is not None:
        cfg.max_steps_per_episode = max(1, int(args.max_steps_per_episode))
    if args.chunk_seconds is not None:
        cfg.chunk_seconds = max(0.1, float(args.chunk_seconds))
    if args.learning_rate is not None:
        cfg.learning_rate = max(1e-7, float(args.learning_rate))
    if args.entropy_coef is not None:
        cfg.entropy_coef = max(0.0, float(args.entropy_coef))
    if args.reward_clip_abs is not None:
        cfg.reward_clip_abs = max(1e-3, float(args.reward_clip_abs))
    if args.terminal_reward_scale is not None:
        cfg.terminal_reward_scale = max(0.0, float(args.terminal_reward_scale))
    if args.eval_every_episodes is not None:
        cfg.eval_every_episodes = max(1, int(args.eval_every_episodes))
    if args.eval_episodes is not None:
        cfg.eval_episodes = max(1, int(args.eval_episodes))
    if args.bc_epochs is not None:
        cfg.bc_epochs = max(0, int(args.bc_epochs))
    if args.bc_episodes is not None:
        cfg.bc_episodes = max(0, int(args.bc_episodes))
    if args.bc_steps_per_episode is not None:
        cfg.bc_steps_per_episode = max(1, int(args.bc_steps_per_episode))
    if args.bc_batch_size is not None:
        cfg.bc_batch_size = max(1, int(args.bc_batch_size))
    if args.save_best_only is not None:
        cfg.save_best_only = args.save_best_only == "true"
    if args.self_play_same_model is not None:
        cfg.self_play_same_model = args.self_play_same_model == "true"
    if args.train_enemy_side is not None:
        cfg.train_enemy_side = args.train_enemy_side == "true"
    if args.base_hp_weight is not None:
        cfg.base_hp_weight = float(args.base_hp_weight)
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

    if args.convert_checkpoint:
        if not args.convert_component:
            raise RuntimeError("--convert-component is required with --convert-checkpoint.")
        checkpoint_path = Path(args.convert_checkpoint).resolve()
        if not checkpoint_path.exists():
            raise RuntimeError(f"Checkpoint not found: {checkpoint_path}")
        convert_out_dir = Path(args.convert_out_dir).resolve() if args.convert_out_dir else None
        convert_checkpoint(
            checkpoint_path=checkpoint_path,
            component_name=str(args.convert_component),
            hidden_dim=cfg.hidden_dim,
            hidden_layers=cfg.hidden_layers,
            out_dir=convert_out_dir,
        )
        return
    train(cfg)


if __name__ == "__main__":
    main()
