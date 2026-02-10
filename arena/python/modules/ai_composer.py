"""Composable Python AI pipeline for arena control.

This module mirrors the JS composite AI flow at a high level:

1. Target module assigns weapon slots to targets.
2. Movement module plans directional motion using target assignments and bullet threats.
3. Fire module decides firing timing and aim for each assigned slot.

The output format is bridge-compatible for ``/__pyai/*`` usage.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence


JsonDict = Dict[str, Any]


@dataclass
class TargetAssignment:
    """Assignment of one weapon slot to one target.

    Attributes:
        slot: Weapon slot index on the controlled unit.
        target_id: Enemy unit id selected for this slot.
        aim_x: Current aim x coordinate.
        aim_y: Current aim y coordinate.
        score: Heuristic score used to rank assignment quality.
    """

    slot: int
    target_id: str
    aim_x: float
    aim_y: float
    score: float


@dataclass
class TargetPlan:
    """Targeting output consumed by movement and fire modules."""

    primary_target_id: Optional[str]
    assignments: List[TargetAssignment]


@dataclass
class MovementPlan:
    """Movement output generated from tactical context.

    Attributes:
        dir_x: Horizontal movement intent in roughly ``[-1, 1]``.
        dir_y: Vertical movement intent in roughly ``[-1, 1]``.
        allow_descend: Air-unit descent permission.
    """

    dir_x: float
    dir_y: float
    allow_descend: bool = False


@dataclass
class FirePlan:
    """Fire output containing per-slot fire request dictionaries."""

    fire_requests: List[JsonDict]


def _clampf(value: float, min_v: float, max_v: float) -> float:
    """Clamp float ``value`` to closed interval ``[min_v, max_v]``."""

    return max(min_v, min(max_v, value))


def _unit_id(unit: JsonDict) -> str:
    """Resolve unit identifier from either ``unit_id`` or ``id`` fields."""

    return str(unit.get("unit_id") or unit.get("id") or "")


def _distance2(ax: float, ay: float, bx: float, by: float) -> float:
    """Return squared Euclidean distance between two points."""

    dx = bx - ax
    dy = by - ay
    return dx * dx + dy * dy


def _alive_enemies_of(unit: JsonDict, all_units: Sequence[JsonDict]) -> List[JsonDict]:
    """Return all alive enemy units for ``unit`` from ``all_units``."""

    side = unit.get("side")
    result: List[JsonDict] = []
    for other in all_units:
        if not other.get("alive", True):
            continue
        if other.get("side") == side:
            continue
        result.append(other)
    return result


def _nearest_enemy(unit: JsonDict, all_units: Sequence[JsonDict]) -> Optional[JsonDict]:
    """Return nearest alive enemy unit or ``None`` if no enemy exists."""

    ux = float(unit.get("x", 0.0))
    uy = float(unit.get("y", 0.0))
    best: Optional[JsonDict] = None
    best_d2 = float("inf")
    for enemy in _alive_enemies_of(unit, all_units):
        d2 = _distance2(ux, uy, float(enemy.get("x", 0.0)), float(enemy.get("y", 0.0)))
        if d2 < best_d2:
            best_d2 = d2
            best = enemy
    return best


def _threat_from_projectiles(unit: JsonDict, projectiles: Sequence[JsonDict]) -> float:
    """Compute threat score from nearby enemy projectiles.

    Returns:
        Float in ``[0, 1]`` where higher means stronger nearby bullet pressure.
    """

    ux = float(unit.get("x", 0.0))
    uy = float(unit.get("y", 0.0))
    side = unit.get("side")
    total = 0.0
    for projectile in projectiles:
        if projectile.get("side") == side:
            continue
        px = float(projectile.get("x", 0.0))
        py = float(projectile.get("y", 0.0))
        d2 = max(1.0, _distance2(ux, uy, px, py))
        total += 20000.0 / d2
    return _clampf(total, 0.0, 1.0)


class TargetModule:
    """Base class for target assignment modules."""

    def assign(self, unit: JsonDict, snapshot: JsonDict, pending_units: Sequence[JsonDict], ctx: JsonDict) -> TargetPlan:
        """Assign weapon slots to targets.

        Args:
            unit: Controlled unit.
            snapshot: Full state snapshot.
            pending_units: Units currently requiring decisions.
            ctx: Mutable callback context.

        Returns:
            Target plan with primary target and slot assignments.
        """

        raise NotImplementedError


class MovementModule:
    """Base class for movement modules."""

    def plan(
        self,
        unit: JsonDict,
        snapshot: JsonDict,
        target_plan: TargetPlan,
        pending_units: Sequence[JsonDict],
        ctx: JsonDict,
    ) -> MovementPlan:
        """Produce directional movement conditioned on target and projectile pressure."""

        raise NotImplementedError


class FireModule:
    """Base class for fire-decision modules."""

    def plan(
        self,
        unit: JsonDict,
        snapshot: JsonDict,
        target_plan: TargetPlan,
        movement_plan: MovementPlan,
        pending_units: Sequence[JsonDict],
        ctx: JsonDict,
    ) -> FirePlan:
        """Generate fire requests (timing + aim) from tactical plans."""

        raise NotImplementedError


class BaselineTargetModule(TargetModule):
    """Simple deterministic target assigner.

    Policy:
    - Choose nearest enemy as primary target.
    - Assign all weapon slots to that same target.
    """

    def assign(self, unit: JsonDict, snapshot: JsonDict, pending_units: Sequence[JsonDict], ctx: JsonDict) -> TargetPlan:
        state = snapshot.get("state", snapshot)
        all_units = list(state.get("units", []))
        enemy = _nearest_enemy(unit, all_units)
        if enemy is None:
            return TargetPlan(primary_target_id=None, assignments=[])

        enemy_id = str(enemy.get("id", ""))
        ex = float(enemy.get("x", 0.0))
        ey = float(enemy.get("y", 0.0))
        weapon_count = int(unit.get("weapon_count", 1))
        assignments = [
            TargetAssignment(slot=slot, target_id=enemy_id, aim_x=ex, aim_y=ey, score=1.0)
            for slot in range(max(0, weapon_count))
        ]
        return TargetPlan(primary_target_id=enemy_id, assignments=assignments)


class BaselineMovementModule(MovementModule):
    """Movement module that balances desired range with projectile evasion.

    Policy:
    - Move toward primary target when too far.
    - Move away when too close.
    - Add perpendicular dodge component under projectile threat.
    """

    def __init__(self, desired_range: float = 280.0) -> None:
        """Initialize movement module.

        Args:
            desired_range: Preferred engagement distance.
        """

        self.desired_range = float(desired_range)

    def plan(
        self,
        unit: JsonDict,
        snapshot: JsonDict,
        target_plan: TargetPlan,
        pending_units: Sequence[JsonDict],
        ctx: JsonDict,
    ) -> MovementPlan:
        state = snapshot.get("state", snapshot)
        all_units = list(state.get("units", []))
        projectiles = list(state.get("projectiles", []))
        ux = float(unit.get("x", 0.0))
        uy = float(unit.get("y", 0.0))

        primary = None
        if target_plan.primary_target_id:
            for enemy in all_units:
                if str(enemy.get("id", "")) == target_plan.primary_target_id and enemy.get("alive", True):
                    primary = enemy
                    break
        if primary is None:
            return MovementPlan(dir_x=0.0, dir_y=0.0, allow_descend=False)

        tx = float(primary.get("x", 0.0))
        ty = float(primary.get("y", 0.0))
        dx = tx - ux
        dy = ty - uy
        dist = max(1e-6, (dx * dx + dy * dy) ** 0.5)
        nx = dx / dist
        ny = dy / dist

        dir_x = 0.0
        dir_y = 0.0
        if dist > self.desired_range:
            dir_x += nx
            dir_y += ny
        elif dist < self.desired_range * 0.6:
            dir_x -= nx
            dir_y -= ny

        threat = _threat_from_projectiles(unit, projectiles)
        if threat > 0.15:
            # Perpendicular dodge with threat-scaled weight.
            dodge_w = 0.7 * threat
            dir_x += -ny * dodge_w
            dir_y += nx * dodge_w

        dir_x = _clampf(dir_x, -1.0, 1.0)
        dir_y = _clampf(dir_y, -1.0, 1.0)
        allow_descend = bool(unit.get("type") == "air" and threat > 0.5)
        return MovementPlan(dir_x=dir_x, dir_y=dir_y, allow_descend=allow_descend)


class BaselineFireModule(FireModule):
    """Fire module with simple timing gate and direct aim.

    Policy:
    - Emit one fire request per assigned slot.
    - Optional cadence gate to avoid always-on firing.
    """

    def __init__(self, cadence_steps: int = 1) -> None:
        """Initialize fire module.

        Args:
            cadence_steps: Minimum step interval between shots for each unit.
        """

        self.cadence_steps = max(1, int(cadence_steps))

    def plan(
        self,
        unit: JsonDict,
        snapshot: JsonDict,
        target_plan: TargetPlan,
        movement_plan: MovementPlan,
        pending_units: Sequence[JsonDict],
        ctx: JsonDict,
    ) -> FirePlan:
        uid = _unit_id(unit)
        if not uid:
            return FirePlan(fire_requests=[])

        step_index = int(ctx.get("steps", 0))
        last_step_by_unit = ctx.setdefault("last_fire_step_by_unit", {})
        last_step = int(last_step_by_unit.get(uid, -10**9))
        if step_index - last_step < self.cadence_steps:
            return FirePlan(fire_requests=[])

        requests: List[JsonDict] = []
        for assignment in target_plan.assignments:
            requests.append(
                {
                    "slot": int(assignment.slot),
                    "aim_x": float(assignment.aim_x),
                    "aim_y": float(assignment.aim_y),
                    "intended_target_id": assignment.target_id,
                }
            )

        if requests:
            last_step_by_unit[uid] = step_index
        return FirePlan(fire_requests=requests)


class AIComposer:
    """Composable policy orchestrator for per-unit decision flow.

    This class composes three modules and exposes:
    - ``decide_unit(...)`` for one controlled unit
    - ``callback(...)`` for bridge-compatible batch decisions
    """

    def __init__(self, target_module: TargetModule, movement_module: MovementModule, fire_module: FireModule) -> None:
        """Construct composer from stage modules."""

        self.target_module = target_module
        self.movement_module = movement_module
        self.fire_module = fire_module

    def decide_unit(
        self,
        unit: JsonDict,
        snapshot: JsonDict,
        pending_units: Sequence[JsonDict],
        ctx: JsonDict,
    ) -> JsonDict:
        """Produce one command dictionary for a single unit."""

        target_plan = self.target_module.assign(unit, snapshot, pending_units, ctx)
        movement_plan = self.movement_module.plan(unit, snapshot, target_plan, pending_units, ctx)
        fire_plan = self.fire_module.plan(unit, snapshot, target_plan, movement_plan, pending_units, ctx)

        unit_id = _unit_id(unit)
        ux = float(unit.get("x", 0.0))
        primary_x = None
        if target_plan.assignments:
            primary_x = float(target_plan.assignments[0].aim_x)
        facing = 0
        if primary_x is not None:
            facing = 1 if primary_x >= ux else -1

        return {
            "unit_id": unit_id,
            "move": {
                "dir_x": float(movement_plan.dir_x),
                "dir_y": float(movement_plan.dir_y),
                "allow_descend": bool(movement_plan.allow_descend),
            },
            "facing": facing,
            "fire_requests": fire_plan.fire_requests,
        }

    def callback(
        self,
        snapshot: JsonDict,
        pending_units: List[JsonDict],
        ctx: JsonDict,
    ) -> List[JsonDict]:
        """Bridge-compatible callback across all pending units."""

        commands: List[JsonDict] = []
        for unit in pending_units:
            if not unit.get("alive", True):
                continue
            cmd = self.decide_unit(unit, snapshot, pending_units, ctx)
            if cmd.get("unit_id"):
                commands.append(cmd)
        return commands


def build_baseline_composer(desired_range: float = 280.0, cadence_steps: int = 1) -> AIComposer:
    """Factory for baseline deterministic composer."""

    return AIComposer(
        target_module=BaselineTargetModule(),
        movement_module=BaselineMovementModule(desired_range=desired_range),
        fire_module=BaselineFireModule(cadence_steps=cadence_steps),
    )
