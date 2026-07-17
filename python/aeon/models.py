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
        # The server wraps key availability in a `keys` object. Accept the
        # unwrapped shape as well for compatibility with older servers.
        return cls(keys=d.get("keys", d))


@dataclass
class JsonSchemaProperty:
    type: str
    description: Optional[str] = None


@dataclass
class ToolInputSchema:
    properties: Dict[str, JsonSchemaProperty] = field(default_factory=dict)
    required: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ToolInputSchema":
        props = {
            k: JsonSchemaProperty(type=v.get("type", "string"), description=v.get("description"))
            for k, v in d.get("properties", {}).items()
        }
        return cls(properties=props, required=d.get("required", []))

    def to_dict(self) -> Dict[str, Any]:
        props = {
            k: {**{"type": v.type}, **({"description": v.description} if v.description else {})}
            for k, v in self.properties.items()
        }
        d: Dict[str, Any] = {"type": "object", "properties": props}
        if self.required:
            d["required"] = self.required
        return d


@dataclass
class CustomTool:
    id: str
    name: str
    description: str
    input_schema: ToolInputSchema
    executor: Dict[str, Any]
    enabled: bool
    created_at: str = ""
    updated_at: str = ""

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CustomTool":
        return cls(
            id=d["id"],
            name=d["name"],
            description=d.get("description", ""),
            input_schema=ToolInputSchema.from_dict(d.get("inputSchema", {})),
            executor=d.get("executor", {}),
            enabled=d.get("enabled", True),
            created_at=d.get("createdAt", ""),
            updated_at=d.get("updatedAt", ""),
        )

    def to_create_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema.to_dict(),
            "executor": self.executor,
            "enabled": self.enabled,
        }
