from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Agent:
    id: str
    task: str
    status: str
    created_at: str = ""
    url: str = ""
    turn_count: int = 0
    total_cost_usd: float = 0.0
    workspace_path: str = ""

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Agent":
        return cls(
            id=d["id"],
            task=d.get("task", ""),
            status=d.get("status", "unknown"),
            created_at=d.get("createdAt", ""),
            url=d.get("url", f"/agents/{d['id']}"),
            turn_count=d.get("turnCount", 0),
            total_cost_usd=d.get("totalCostUsd", 0.0),
            workspace_path=d.get("workspacePath", ""),
        )


@dataclass
class AgentEvent:
    type: str
    data: Dict[str, Any]
    ts: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AgentEvent":
        return cls(
            type=d.get("type", "unknown"),
            ts=d.get("ts"),
            data=d,
        )


@dataclass
class ConfigStatus:
    keys: Dict[str, bool] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ConfigStatus":
        return cls(keys=d)
