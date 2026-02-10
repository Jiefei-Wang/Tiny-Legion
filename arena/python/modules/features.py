"""Feature schema definitions for composer-based policy learning.

This file defines named feature lists for each composer stage:

- target assignment
- movement planning
- fire timing/aim

Feature metadata is designed for RL + backprop pipelines with delayed rewards:
- stable names for model I/O contracts
- explicit normalization hints
- reward-signal list for trajectory-level credit assignment
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot
from typing import Any, Dict, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class FeatureSpec:
    """One feature descriptor used by model input pipelines.

    Attributes:
        name: Stable feature key name.
        description: Semantic meaning and expected interpretation.
        normalization: Suggested normalization scheme.
        min_value: Typical minimum bound after preprocessing.
        max_value: Typical maximum bound after preprocessing.
    """

    name: str
    description: str
    normalization: str
    min_value: float
    max_value: float


TARGET_FEATURES: List[FeatureSpec] = [
    FeatureSpec("bias", "Constant bias term.", "constant_1", 1.0, 1.0),
    FeatureSpec("self_x_norm", "Self x position over battlefield width.", "x / width", -1.0, 2.0),
    FeatureSpec("self_y_norm", "Self y position over battlefield height.", "y / height", -1.0, 2.0),
    FeatureSpec("self_vx_norm", "Self x velocity over max speed.", "vx / max_speed", -2.0, 2.0),
    FeatureSpec("self_vy_norm", "Self y velocity over max speed.", "vy / max_speed", -2.0, 2.0),
    FeatureSpec("enemy_dx_norm", "Relative x to candidate target.", "(enemy_x - self_x) / width", -2.0, 2.0),
    FeatureSpec("enemy_dy_norm", "Relative y to candidate target.", "(enemy_y - self_y) / height", -2.0, 2.0),
    FeatureSpec("enemy_dist_norm", "Distance to candidate target.", "distance / diag", 0.0, 2.0),
    FeatureSpec("enemy_speed_norm", "Candidate target speed.", "sqrt(vx^2+vy^2) / speed_ref", 0.0, 3.0),
    FeatureSpec("enemy_alive", "Candidate target alive flag.", "0_or_1", 0.0, 1.0),
    FeatureSpec("enemy_type_air", "Candidate target is air unit.", "0_or_1", 0.0, 1.0),
    FeatureSpec("enemy_threat_norm", "Target threat proxy from weapon count.", "weapon_count / 8", 0.0, 2.0),
    FeatureSpec("weapon_slot_norm", "Current slot index feature.", "slot / max_slots", 0.0, 1.0),
    FeatureSpec("weapon_count_norm", "Self weapon count feature.", "weapon_count / 8", 0.0, 2.0),
]


MOVEMENT_FEATURES: List[FeatureSpec] = [
    FeatureSpec("bias", "Constant bias term.", "constant_1", 1.0, 1.0),
    FeatureSpec("self_x_norm", "Self x position over battlefield width.", "x / width", -1.0, 2.0),
    FeatureSpec("self_y_norm", "Self y position over battlefield height.", "y / height", -1.0, 2.0),
    FeatureSpec("self_vx_norm", "Self x velocity over max speed.", "vx / max_speed", -2.0, 2.0),
    FeatureSpec("self_vy_norm", "Self y velocity over max speed.", "vy / max_speed", -2.0, 2.0),
    FeatureSpec("target_dx_norm", "Relative x to primary target.", "(tx - x) / width", -2.0, 2.0),
    FeatureSpec("target_dy_norm", "Relative y to primary target.", "(ty - y) / height", -2.0, 2.0),
    FeatureSpec("target_dist_norm", "Distance to primary target.", "distance / diag", 0.0, 2.0),
    FeatureSpec("desired_range_norm", "Preferred range feature.", "desired_range / width", 0.0, 2.0),
    FeatureSpec("projectile_threat_norm", "Nearby enemy projectile pressure.", "clamped_threat", 0.0, 1.0),
    FeatureSpec("nearest_projectile_dx_norm", "Relative x to nearest enemy projectile.", "(px - x) / width", -2.0, 2.0),
    FeatureSpec("nearest_projectile_dy_norm", "Relative y to nearest enemy projectile.", "(py - y) / height", -2.0, 2.0),
    FeatureSpec("air_unit_flag", "Self unit is air type.", "0_or_1", 0.0, 1.0),
    FeatureSpec("engage_state_flag", "Optional tactical state bit (engage/evade).", "0_or_1", 0.0, 1.0),
]


FIRE_FEATURES: List[FeatureSpec] = [
    FeatureSpec("bias", "Constant bias term.", "constant_1", 1.0, 1.0),
    FeatureSpec("slot_norm", "Weapon slot index feature.", "slot / max_slots", 0.0, 1.0),
    FeatureSpec("cooldown_ready_flag", "Slot can fire this tick.", "0_or_1", 0.0, 1.0),
    FeatureSpec("ready_charge_norm", "Ready charge count for slot.", "charges / charge_ref", 0.0, 4.0),
    FeatureSpec("target_dx_norm", "Relative x to assigned target.", "(tx - x) / width", -2.0, 2.0),
    FeatureSpec("target_dy_norm", "Relative y to assigned target.", "(ty - y) / height", -2.0, 2.0),
    FeatureSpec("target_dist_norm", "Distance to assigned target.", "distance / diag", 0.0, 2.0),
    FeatureSpec("target_vx_norm", "Assigned target x velocity.", "vx / speed_ref", -3.0, 3.0),
    FeatureSpec("target_vy_norm", "Assigned target y velocity.", "vy / speed_ref", -3.0, 3.0),
    FeatureSpec("movement_dir_x", "Movement output x component entering fire stage.", "raw_clamped", -1.0, 1.0),
    FeatureSpec("movement_dir_y", "Movement output y component entering fire stage.", "raw_clamped", -1.0, 1.0),
    FeatureSpec("projectile_threat_norm", "Bullet pressure near shooter when deciding to fire.", "clamped_threat", 0.0, 1.0),
]


DELAYED_REWARD_SIGNALS: List[FeatureSpec] = [
    FeatureSpec("win_signal", "Episode terminal win indicator.", "terminal_0_or_1", 0.0, 1.0),
    FeatureSpec("team_alive_delta", "Alive friendly minus alive enemy units over time.", "signed_count_delta", -100.0, 100.0),
    FeatureSpec("base_hp_delta_norm", "Friendly minus enemy base HP delta.", "delta / base_hp_ref", -2.0, 2.0),
    FeatureSpec("damage_dealt_norm", "Cumulative normalized outgoing damage.", "damage / damage_ref", 0.0, 100.0),
    FeatureSpec("damage_taken_norm", "Cumulative normalized incoming damage.", "damage / damage_ref", 0.0, 100.0),
    FeatureSpec("gas_worth_delta_norm", "Resource efficiency delta over episode.", "delta / gas_ref", -10.0, 10.0),
    FeatureSpec("survival_time_norm", "Per-unit survival duration.", "time / max_time", 0.0, 1.0),
    FeatureSpec("shot_efficiency_norm", "Hit-confirmed shots over fired shots.", "ratio_0_to_1", 0.0, 1.0),
]


COMPOSER_FEATURE_GROUPS: Dict[str, List[FeatureSpec]] = {
    "target": TARGET_FEATURES,
    "movement": MOVEMENT_FEATURES,
    "fire": FIRE_FEATURES,
    "delayed_reward": DELAYED_REWARD_SIGNALS,
}


def _clampf(value: float, min_v: float, max_v: float) -> float:
    """Clamp a float to a closed interval."""

    return max(min_v, min(max_v, value))


def _battlefield_dims(snapshot: Dict[str, Any]) -> Tuple[float, float, float]:
    """Return battlefield width/height/diag with safe defaults."""

    battlefield = snapshot.get("battlefield", {})
    width = float(battlefield.get("width", 2000.0))
    height = float(battlefield.get("height", 1000.0))
    width = max(1.0, width)
    height = max(1.0, height)
    diag = hypot(width, height) or 1.0
    return width, height, diag


def _unit_id(unit: Dict[str, Any]) -> str:
    """Resolve unit id from ``unit_id`` or ``id`` fields."""

    return str(unit.get("unit_id") or unit.get("id") or "")


def _find_unit_by_id(state: Dict[str, Any], unit_id: str) -> Optional[Dict[str, Any]]:
    """Find a unit by id inside a battle ``state`` dict."""

    for unit in state.get("units", []):
        if str(unit.get("id", "")) == unit_id:
            return unit
    return None


def _projectile_threat_and_nearest(
    unit: Dict[str, Any],
    projectiles: Sequence[Dict[str, Any]],
) -> Tuple[float, float, float]:
    """Compute projectile threat score and nearest projectile offset.

    Returns:
        Tuple of (threat_norm, nearest_dx, nearest_dy).
    """

    ux = float(unit.get("x", 0.0))
    uy = float(unit.get("y", 0.0))
    side = unit.get("side")
    best_d2 = float("inf")
    best_dx = 0.0
    best_dy = 0.0
    threat = 0.0
    for projectile in projectiles:
        if projectile.get("side") == side:
            continue
        px = float(projectile.get("x", 0.0))
        py = float(projectile.get("y", 0.0))
        dx = px - ux
        dy = py - uy
        d2 = max(1.0, dx * dx + dy * dy)
        threat += 20000.0 / d2
        if d2 < best_d2:
            best_d2 = d2
            best_dx = dx
            best_dy = dy
    return _clampf(threat, 0.0, 1.0), best_dx, best_dy


def extract_target_features(
    unit: Dict[str, Any],
    enemy: Dict[str, Any],
    slot: int,
    snapshot: Dict[str, Any],
    max_slots: int = 8,
) -> List[float]:
    """Extract target-assignment features for one (unit, enemy, slot) pair.

    Args:
        unit: Controlled unit dict.
        enemy: Candidate enemy unit dict.
        slot: Weapon slot index.
        snapshot: Full snapshot dict (may include ``battlefield``).
        max_slots: Normalization factor for slot index.

    Returns:
        Feature vector aligned with ``TARGET_FEATURES``.
    """

    width, height, diag = _battlefield_dims(snapshot)
    ux = float(unit.get("x", 0.0))
    uy = float(unit.get("y", 0.0))
    uvx = float(unit.get("vx", 0.0))
    uvy = float(unit.get("vy", 0.0))
    max_speed = max(1.0, float(unit.get("max_speed", unit.get("maxSpeed", 1.0) or 1.0)))

    ex = float(enemy.get("x", 0.0))
    ey = float(enemy.get("y", 0.0))
    evx = float(enemy.get("vx", 0.0))
    evy = float(enemy.get("vy", 0.0))

    dx = ex - ux
    dy = ey - uy
    dist = hypot(dx, dy)
    enemy_alive = 1.0 if enemy.get("alive", True) else 0.0
    enemy_air = 1.0 if enemy.get("type") == "air" else 0.0
    enemy_threat = float(enemy.get("weapon_count", enemy.get("weaponCount", 0) or 0)) / 8.0
    weapon_count = float(unit.get("weapon_count", unit.get("weaponCount", 0) or 0)) / 8.0
    slot_norm = float(slot) / max(1.0, float(max_slots))

    return [
        1.0,
        _clampf(ux / width, -1.0, 2.0),
        _clampf(uy / height, -1.0, 2.0),
        _clampf(uvx / max_speed, -2.0, 2.0),
        _clampf(uvy / max_speed, -2.0, 2.0),
        _clampf(dx / width, -2.0, 2.0),
        _clampf(dy / height, -2.0, 2.0),
        _clampf(dist / diag, 0.0, 2.0),
        _clampf(hypot(evx, evy) / max(1.0, max_speed), 0.0, 3.0),
        enemy_alive,
        enemy_air,
        _clampf(enemy_threat, 0.0, 2.0),
        _clampf(slot_norm, 0.0, 1.0),
        _clampf(weapon_count, 0.0, 2.0),
    ]


def extract_movement_features(
    unit: Dict[str, Any],
    primary_target: Optional[Dict[str, Any]],
    desired_range: float,
    snapshot: Dict[str, Any],
    engage_state_flag: float = 1.0,
) -> List[float]:
    """Extract movement planning features.

    Args:
        unit: Controlled unit dict.
        primary_target: Target dict or ``None``.
        desired_range: Preferred engagement range.
        snapshot: Full snapshot dict.
        engage_state_flag: Optional 0/1 tactical state bit.

    Returns:
        Feature vector aligned with ``MOVEMENT_FEATURES``.
    """

    width, height, diag = _battlefield_dims(snapshot)
    ux = float(unit.get("x", 0.0))
    uy = float(unit.get("y", 0.0))
    uvx = float(unit.get("vx", 0.0))
    uvy = float(unit.get("vy", 0.0))
    max_speed = max(1.0, float(unit.get("max_speed", unit.get("maxSpeed", 1.0) or 1.0)))

    if primary_target is None:
        tx = ux
        ty = uy
    else:
        tx = float(primary_target.get("x", 0.0))
        ty = float(primary_target.get("y", 0.0))

    dx = tx - ux
    dy = ty - uy
    dist = hypot(dx, dy)

    state = snapshot.get("state", snapshot)
    projectiles = state.get("projectiles", [])
    threat, p_dx, p_dy = _projectile_threat_and_nearest(unit, projectiles)
    air_flag = 1.0 if unit.get("type") == "air" else 0.0

    return [
        1.0,
        _clampf(ux / width, -1.0, 2.0),
        _clampf(uy / height, -1.0, 2.0),
        _clampf(uvx / max_speed, -2.0, 2.0),
        _clampf(uvy / max_speed, -2.0, 2.0),
        _clampf(dx / width, -2.0, 2.0),
        _clampf(dy / height, -2.0, 2.0),
        _clampf(dist / diag, 0.0, 2.0),
        _clampf(float(desired_range) / width, 0.0, 2.0),
        _clampf(threat, 0.0, 1.0),
        _clampf(p_dx / width, -2.0, 2.0),
        _clampf(p_dy / height, -2.0, 2.0),
        air_flag,
        _clampf(engage_state_flag, 0.0, 1.0),
    ]


def extract_fire_features(
    unit: Dict[str, Any],
    assigned_target: Optional[Dict[str, Any]],
    slot: int,
    movement_dir: Tuple[float, float],
    snapshot: Dict[str, Any],
    max_slots: int = 8,
) -> List[float]:
    """Extract fire decision features for one weapon slot.

    Args:
        unit: Controlled unit dict.
        assigned_target: Target dict or ``None``.
        slot: Weapon slot index.
        movement_dir: Movement vector (dir_x, dir_y).
        snapshot: Full snapshot dict.
        max_slots: Normalization factor for slot index.

    Returns:
        Feature vector aligned with ``FIRE_FEATURES``.
    """

    width, height, diag = _battlefield_dims(snapshot)
    ux = float(unit.get("x", 0.0))
    uy = float(unit.get("y", 0.0))
    max_speed = max(1.0, float(unit.get("max_speed", unit.get("maxSpeed", 1.0) or 1.0)))

    if assigned_target is None:
        tx = ux
        ty = uy
        tvx = 0.0
        tvy = 0.0
    else:
        tx = float(assigned_target.get("x", 0.0))
        ty = float(assigned_target.get("y", 0.0))
        tvx = float(assigned_target.get("vx", 0.0))
        tvy = float(assigned_target.get("vy", 0.0))

    dx = tx - ux
    dy = ty - uy
    dist = hypot(dx, dy)

    slot_norm = float(slot) / max(1.0, float(max_slots))
    fire_timers = unit.get("weapon_fire_timers", unit.get("weaponFireTimers", [])) or []
    ready_charges = unit.get("weapon_ready_charges", unit.get("weaponReadyCharges", [])) or []
    cooldown_ready = 1.0
    if slot < len(fire_timers):
        cooldown_ready = 1.0 if float(fire_timers[slot] or 0.0) <= 0.0 else 0.0
    charges = float(ready_charges[slot]) if slot < len(ready_charges) else 0.0

    state = snapshot.get("state", snapshot)
    projectiles = state.get("projectiles", [])
    threat, _, _ = _projectile_threat_and_nearest(unit, projectiles)

    return [
        1.0,
        _clampf(slot_norm, 0.0, 1.0),
        _clampf(cooldown_ready, 0.0, 1.0),
        _clampf(charges / 3.0, 0.0, 4.0),
        _clampf(dx / width, -2.0, 2.0),
        _clampf(dy / height, -2.0, 2.0),
        _clampf(dist / diag, 0.0, 2.0),
        _clampf(tvx / max_speed, -3.0, 3.0),
        _clampf(tvy / max_speed, -3.0, 3.0),
        _clampf(float(movement_dir[0]), -1.0, 1.0),
        _clampf(float(movement_dir[1]), -1.0, 1.0),
        _clampf(threat, 0.0, 1.0),
    ]


def feature_vector(specs: Sequence[FeatureSpec], values: Sequence[float]) -> List[float]:
    """Validate and return a feature vector aligned with a spec list."""

    if len(specs) != len(values):
        raise ValueError(f"feature length mismatch: specs={len(specs)} values={len(values)}")
    return list(values)
