"""
Tool definitions for Aeon agents.

Usage:
    from aeon.tools import HttpTool, ShellTool

    HttpTool(
        name="search_db",
        description="Search the product database",
        url="http://localhost:8080/search",
        params={
            "query": ("string",  "Search query",  True),
            "limit": ("number",  "Max results",   False),
        },
    )

    ShellTool(
        name="run_tests",
        description="Run the test suite",
        command="pytest {{pattern}} -v",
        params={
            "pattern": ("string", "Test file pattern", False),
        },
    )

Param tuple format: (type, description, required)
  type: "string" | "number" | "integer" | "boolean" | "array"
"""

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

# (type, description, required)
ParamDef = Tuple[str, str, bool]


class Tool:
    """Base class — do not instantiate directly."""

    def _schema(self, params: Dict[str, ParamDef]) -> Dict[str, Any]:
        props: Dict[str, Any] = {}
        required = []
        for name, (ptype, pdesc, preq) in params.items():
            props[name] = {"type": ptype, "description": pdesc}
            if preq:
                required.append(name)
        d: Dict[str, Any] = {"type": "object", "properties": props}
        if required:
            d["required"] = required
        return d

    def _to_dict(self) -> Dict[str, Any]:
        raise NotImplementedError


@dataclass
class HttpTool(Tool):
    """
    Call an HTTP endpoint when the agent invokes this tool.

    Input parameters are sent as a JSON body (POST/PUT/PATCH) or query string (GET).
    The full response body is returned to the agent as text.
    """

    name: str
    description: str
    url: str
    method: str = "POST"
    headers: Optional[Dict[str, str]] = None
    params: Dict[str, ParamDef] = field(default_factory=dict)

    def _to_dict(self) -> Dict[str, Any]:
        executor: Dict[str, Any] = {"type": "http", "url": self.url, "method": self.method}
        if self.headers:
            executor["headers"] = self.headers
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self._schema(self.params),
            "executor": executor,
            "enabled": True,
        }


@dataclass
class ShellTool(Tool):
    """
    Run a shell command when the agent invokes this tool.

    Use {{param_name}} in the command string — values are shell-quoted before substitution.
    stdout + stderr are returned to the agent.
    """

    name: str
    description: str
    command: str
    cwd: Optional[str] = None
    timeout_ms: Optional[int] = None
    params: Dict[str, ParamDef] = field(default_factory=dict)

    def _to_dict(self) -> Dict[str, Any]:
        executor: Dict[str, Any] = {"type": "shell", "command": self.command}
        if self.cwd:
            executor["cwd"] = self.cwd
        if self.timeout_ms:
            executor["timeout"] = self.timeout_ms
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self._schema(self.params),
            "executor": executor,
            "enabled": True,
        }
