"""Typed building blocks for durable, infinite-horizon Aeon objectives."""

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from .client import AeonClient


def _compact(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _compact(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_compact(item) for item in value]
    return value


@dataclass
class Budget:
    """Hard runtime limits across all wake cycles of an objective."""

    max_cost_usd: Optional[float] = None
    max_cycles: Optional[int] = None
    max_turns_per_cycle: Optional[int] = None
    max_minutes: Optional[float] = None
    max_tool_calls: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return _compact({
            "maxCostUsd": self.max_cost_usd,
            "maxCycles": self.max_cycles,
            "maxTurnsPerCycle": self.max_turns_per_cycle,
            "maxMinutes": self.max_minutes,
            "maxToolCalls": self.max_tool_calls,
        })


@dataclass
class RetryPolicy:
    max_attempts: Optional[int] = None
    initial_delay_ms: Optional[int] = None
    max_delay_ms: Optional[int] = None
    multiplier: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return _compact({
            "maxAttempts": self.max_attempts,
            "initialDelayMs": self.initial_delay_ms,
            "maxDelayMs": self.max_delay_ms,
            "multiplier": self.multiplier,
        })


@dataclass
class Policy:
    """Per-objective tool allowlists, risk levels, approvals, and retries."""

    allowed_tools: Optional[List[str]] = None
    denied_tools: Optional[List[str]] = None
    approval_required_tools: Optional[List[str]] = None
    approval_risk_level: Optional[str] = None
    default_risk_level: Optional[str] = None
    tool_risk_levels: Optional[Dict[str, str]] = None
    retry: Optional[RetryPolicy] = None
    workspace_only: Optional[bool] = None

    def to_dict(self) -> Dict[str, Any]:
        return _compact({
            "allowedTools": self.allowed_tools,
            "deniedTools": self.denied_tools,
            "approvalRequiredTools": self.approval_required_tools,
            "approvalRiskLevel": self.approval_risk_level,
            "defaultRiskLevel": self.default_risk_level,
            "toolRiskLevels": self.tool_risk_levels,
            "retry": self.retry.to_dict() if self.retry else None,
            "workspaceOnly": self.workspace_only,
        })


@dataclass
class MemoryConfig:
    enabled: bool = True
    max_context_items: Optional[int] = None
    kinds: Optional[List[str]] = None

    def to_dict(self) -> Dict[str, Any]:
        return _compact({
            "enabled": self.enabled,
            "maxContextItems": self.max_context_items,
            "kinds": self.kinds,
        })


@dataclass
class PlaybookStep:
    title: str
    description: Optional[str] = None
    success_criteria: List[str] = field(default_factory=list)
    depends_on: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return _compact({
            "title": self.title,
            "description": self.description,
            "successCriteria": self.success_criteria,
            "dependsOn": self.depends_on,
        })


@dataclass
class Playbook:
    """Reusable domain workflow that seeds the durable plan graph."""

    name: str
    version: Optional[str] = None
    instructions: Optional[str] = None
    steps: List[PlaybookStep] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return _compact({
            "name": self.name,
            "version": self.version,
            "instructions": self.instructions,
            "steps": [step.to_dict() for step in self.steps],
        })


@dataclass
class Objective:
    """A durable outcome pursued across bounded, event-driven wake cycles."""

    goal: str
    context: Optional[str] = None
    success_criteria: List[str] = field(default_factory=list)
    priority: int = 0
    budget: Optional[Budget] = None
    policy: Optional[Policy] = None
    memory: Optional[MemoryConfig] = None
    playbook: Optional[Playbook] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    start: bool = True
    id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        if not self.goal.strip():
            raise ValueError("Objective goal cannot be empty.")
        return _compact({
            "id": self.id,
            "goal": self.goal,
            "context": self.context,
            "successCriteria": self.success_criteria,
            "priority": self.priority,
            "budget": self.budget.to_dict() if self.budget else None,
            "policy": self.policy.to_dict() if self.policy else None,
            "memory": self.memory.to_dict() if self.memory else None,
            "playbook": self.playbook.to_dict() if self.playbook else None,
            "metadata": self.metadata,
            "start": self.start,
        })


class ObjectiveRun:
    """Live handle for inspecting and steering one durable objective."""

    TERMINAL_STATUSES = ("completed", "failed", "cancelled")
    IDLE_STATUSES = ("waiting", "blocked", "completed", "failed", "cancelled")

    def __init__(self, objective_id: str, client: AeonClient) -> None:
        self._id = objective_id
        self._client = client

    @property
    def id(self) -> str:
        return self._id

    def snapshot(self) -> Dict[str, Any]:
        return self._client.get_objective(self._id)

    @property
    def status(self) -> str:
        return str(self.snapshot()["status"])

    @property
    def cycles(self) -> int:
        return int(self.snapshot().get("cycleCount", 0))

    @property
    def cost(self) -> float:
        return float(self.snapshot().get("totalCostUsd", 0.0))

    @property
    def result(self) -> Optional[str]:
        value = self.snapshot().get("result")
        return str(value) if value is not None else None

    def emit(
        self,
        event_type: str,
        payload: Optional[Dict[str, Any]] = None,
        *,
        dedupe_key: Optional[str] = None,
        source: str = "sdk",
    ) -> Dict[str, Any]:
        return self._client.emit_objective_event(
            self._id, event_type, payload or {}, source=source, dedupe_key=dedupe_key
        )

    def pause(self, reason: Optional[str] = None) -> Dict[str, Any]:
        return self._client.control_objective(self._id, "pause", reason)

    def resume(self) -> Dict[str, Any]:
        return self._client.control_objective(self._id, "resume")

    def cancel(self, reason: Optional[str] = None) -> Dict[str, Any]:
        return self._client.control_objective(self._id, "cancel", reason)

    def plan(self) -> List[Dict[str, Any]]:
        return self._client.get_objective_resource(self._id, "plan")

    def events(self) -> List[Dict[str, Any]]:
        return self._client.get_objective_resource(self._id, "events")

    def memories(self) -> List[Dict[str, Any]]:
        return self._client.get_objective_resource(self._id, "memories")

    def actions(self) -> List[Dict[str, Any]]:
        return self._client.get_objective_resource(self._id, "actions")

    def outcomes(self) -> List[Dict[str, Any]]:
        return self._client.get_objective_resource(self._id, "outcomes")

    def approvals(self, pending_only: bool = False) -> List[Dict[str, Any]]:
        approvals = self._client.get_objective_resource(self._id, "approvals")
        if pending_only:
            return [item for item in approvals if item.get("status") == "pending"]
        return approvals

    def approve(
        self,
        approval_id: str,
        *,
        note: Optional[str] = None,
        resolved_by: str = "sdk",
    ) -> Dict[str, Any]:
        return self._client.resolve_approval(
            self._id, approval_id, "approved", resolved_by=resolved_by, note=note
        )

    def reject(
        self,
        approval_id: str,
        *,
        note: Optional[str] = None,
        resolved_by: str = "sdk",
    ) -> Dict[str, Any]:
        return self._client.resolve_approval(
            self._id, approval_id, "rejected", resolved_by=resolved_by, note=note
        )

    def wait(
        self,
        timeout: Optional[float] = None,
        poll_interval: float = 1.0,
        statuses: Sequence[str] = TERMINAL_STATUSES,
    ) -> Dict[str, Any]:
        """Wait for one of the requested statuses; defaults to terminal states."""
        deadline = time.monotonic() + timeout if timeout is not None else None
        while True:
            snapshot = self.snapshot()
            if snapshot.get("status") in statuses:
                return snapshot
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(
                    "Objective {} did not reach {} within {}s (current status: {})".format(
                        self._id[:8], list(statuses), timeout, snapshot.get("status")
                    )
                )
            time.sleep(poll_interval)

    def wait_until_idle(
        self,
        timeout: Optional[float] = None,
        poll_interval: float = 1.0,
    ) -> Dict[str, Any]:
        """Wait until the objective is dormant, blocked, or terminal."""
        return self.wait(timeout, poll_interval, self.IDLE_STATUSES)

    def __repr__(self) -> str:
        return "ObjectiveRun(id={}...)".format(self._id[:8])
