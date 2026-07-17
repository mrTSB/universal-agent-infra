"""
Agent, Task, and Run — the core building blocks of Aeon.

Agent   owns the definition: capabilities, tools, constraints.
Task    owns the goal: what to accomplish and how to know when it's done.
Run     owns a live execution: stream events, steer, stop, read results.

Execution is separated into Runtime (see runtime.py).
Convenience methods like agent.run() delegate to a default Runtime internally.
"""

import os
from typing import TYPE_CHECKING, Any, AsyncGenerator, Dict, List, Optional, Union

from .client import AeonClient
from .models import Agent as _AgentModel, AgentEvent
from .tools import Tool

if TYPE_CHECKING:
    from .objective import MemoryConfig, Objective, ObjectiveRun, Policy

# ── Model name constants ──────────────────────────────────────────────────────

SONNET = "claude-sonnet-4-6"
HAIKU  = "claude-haiku-4-5"
OPUS   = "claude-opus-4-7"


# ── Task ──────────────────────────────────────────────────────────────────────

class Task:
    """
    What an agent should accomplish.

    Args:
        goal:              The primary objective in plain language.
        context:           Optional background the agent should know upfront.
        success_criteria:  Checklist the agent should satisfy before finishing.
    """

    def __init__(
        self,
        goal: str,
        context: Optional[str] = None,
        success_criteria: Optional[List[str]] = None,
    ) -> None:
        self.goal = goal
        self.context = context
        self.success_criteria = success_criteria or []

    def _to_prompt(self) -> str:
        parts = [self.goal]
        if self.context:
            parts += ["", "Context:", self.context]
        if self.success_criteria:
            parts += ["", "Success criteria (all must be met before finishing):"]
            parts += [f"  - {c}" for c in self.success_criteria]
        return "\n".join(parts)


# ── Run ───────────────────────────────────────────────────────────────────────

class Run:
    """
    A live (or completed) agent run.

    Returned by Runtime.run(), agent.run(), or swarm.run().
    All state-reading properties hit the server on each call.
    """

    def __init__(self, agent_id: str, client: AeonClient) -> None:
        self._id = agent_id
        self._client = client

    # ── Identity & state ─────────────────────────────────────────────────────

    @property
    def id(self) -> str:
        """The run's UUID on the server."""
        return self._id

    @property
    def status(self) -> str:
        """starting | running | stopped | error"""
        return self._client.get_agent(self._id).status

    @property
    def cost(self) -> float:
        """Cumulative API cost in USD."""
        return self._client.get_agent(self._id).total_cost_usd

    @property
    def turns(self) -> int:
        """Number of completed turns."""
        return self._client.get_agent(self._id).turn_count

    @property
    def workspace(self) -> str:
        """Absolute path to the agent's working directory."""
        return self._client.get_agent(self._id).workspace_path

    # ── Control ───────────────────────────────────────────────────────────────

    def send(self, message: str) -> None:
        """Inject a message into the agent's conversation."""
        self._client.send_message(self._id, message)

    def stop(self) -> None:
        """Halt the agent. State is preserved — use Runtime.resume() to continue."""
        self._client.stop_agent(self._id)

    # ── Results ───────────────────────────────────────────────────────────────

    def result(self) -> Dict[str, Any]:
        """Current run snapshot."""
        a = self._client.get_agent(self._id)
        return {
            "id": a.id,
            "status": a.status,
            "turns": a.turn_count,
            "cost_usd": a.total_cost_usd,
            "workspace": a.workspace_path,
        }

    def analytics(self) -> Dict[str, Any]:
        """Turn-by-turn tool usage and phase breakdown."""
        return self._client.get_analytics(self._id)

    def summary(self) -> Dict[str, Any]:
        """AI-written narrative summary of what the agent did."""
        return self._client.get_summary(self._id)

    def invalidate_summary(self) -> None:
        """Force the AI summary to regenerate on next call."""
        self._client.invalidate_summary(self._id)

    def artifacts(self) -> Dict[str, Any]:
        """
        List files created or modified in the agent's workspace.

        Returns a dict with:
          files           — list of {path, status, size_bytes}
                            status: "new" | "modified" | "deleted" | "renamed"
          total_files     — int
          total_size_bytes — int
          workspace       — absolute path on the server

        Example:
            arts = run.artifacts()
            for f in arts["files"]:
                print(f["status"], f["path"], f["size_bytes"])
        """
        return self._client._req("GET", f"/api/agents/{self._id}/artifacts").json()

    def wait(
        self,
        timeout: Optional[float] = None,
        poll_interval: float = 3.0,
    ) -> Dict[str, Any]:
        """
        Block until the run reaches stopped or error status, then return result().

        Args:
            timeout:       Max seconds to wait. Raises TimeoutError if exceeded.
            poll_interval: Seconds between status checks (default 3.0).

        Example:
            result = agent.run(task).wait(timeout=300)
            print(result["cost_usd"])
        """
        import time
        deadline = (time.monotonic() + timeout) if timeout is not None else None

        while True:
            status = self.status
            if status in ("stopped", "error"):
                return self.result()
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Run {self._id[:8]} did not complete within {timeout}s "
                    f"(current status: {status})"
                )
            time.sleep(poll_interval)

    # ── Streaming ─────────────────────────────────────────────────────────────

    async def stream(self) -> AsyncGenerator[AgentEvent, None]:
        """
        Async generator — yields live AgentEvent objects.

        Usage:
            import asyncio

            async def watch():
                async for event in run.stream():
                    if event.type == "agent_message":
                        print(event.data["text"])
                    elif event.type == "ping":
                        run.send("Yes, proceed.")
                    elif event.type == "turn_complete":
                        print(f"Turn {event.data['turns']} — ${event.data['cost']:.4f}")

            asyncio.run(watch())
        """
        async for event in self._client.stream(self._id):
            yield event

    def __repr__(self) -> str:
        return f"Run(id={self._id[:8]}…)"


# ── Agent ─────────────────────────────────────────────────────────────────────

class Agent:
    """
    The agent definition — its identity, capabilities, and operating constraints.

    Agent owns the what and the how.
    Runtime (see runtime.py) owns execution.

    Convenience methods (run, spawn, resume, inspect) delegate to a default
    Runtime so you don't have to instantiate one explicitly for simple cases.

    Args:
        name:      Display name, prepended to the task for context.
        models:    Primary model followed by optional fallback model.
        tools:     HttpTool / ShellTool instances synced to the server on run().
        max_cost:  Optional USD budget constraint injected into the task prompt.
        max_steps: Optional turn limit injected into the task prompt.
        system_prompt: Custom instructions appended to Aeon's base operating rules.
        policy:    Default tool/risk/approval policy for durable objectives.
        memory:    Default durable memory configuration for objectives.
        server:    Aeon server URL. Defaults to AEON_SERVER or localhost:3000.
    """

    def __init__(
        self,
        name: str = "agent",
        models: Optional[List[str]] = None,
        tools: Optional[List[Tool]] = None,
        max_cost: Optional[float] = None,
        max_steps: Optional[int] = None,
        system_prompt: Optional[str] = None,
        fallback_model: Optional[str] = None,
        policy: Optional["Policy"] = None,
        memory: Optional["MemoryConfig"] = None,
        server: Optional[str] = None,
    ) -> None:
        self.name = name
        self.models = models or [SONNET]
        self.tools = tools or []
        self.max_cost = max_cost
        self.max_steps = max_steps
        self.system_prompt = system_prompt
        self.fallback_model = fallback_model
        self.policy = policy
        self.memory = memory
        self._server = server or os.environ.get("AEON_SERVER", "http://localhost:3000")
        self._client = AeonClient(base_url=self._server)

    # ── High-level entry points ───────────────────────────────────────────────

    def run(self, task: Union[str, "Task"]) -> "Run":
        """
        Start a new agent run for the given task.
        Convenience wrapper around Runtime.run(agent, task).
        """
        from .runtime import Runtime
        return Runtime(server=self._server).run(self, task)

    def spawn(self, task: Union[str, "Task"]) -> "Run":
        """
        Spawn a focused sub-run from this agent definition.
        Identical to run() — use when semantically spawning a sub-task.
        """
        return self.run(task)

    def pursue(self, objective: "Objective") -> "ObjectiveRun":
        """Start a durable, event-driven objective using this agent definition."""
        from .runtime import Runtime
        return Runtime(server=self._server).pursue(self, objective)

    def resume(self, run_id: str) -> "Run":
        """
        Resume a previously stopped run from its last checkpoint.
        The original workspace and turn history are preserved.
        """
        from .runtime import Runtime
        return Runtime(server=self._server).resume(run_id)

    def inspect(self, run_id: str) -> Dict[str, Any]:
        """Return a state snapshot for any run by ID."""
        return Run(run_id, self._client).result()

    # ── Internal ──────────────────────────────────────────────────────────────

    def _build_task_prompt(self, task: Union[str, "Task"]) -> str:
        goal = task if isinstance(task, str) else task._to_prompt()
        parts = [f"[Agent: {self.name}]"]
        if len(self.models) == 1:
            parts.append(f"[Model: {self.models[0]}]")
        parts += ["", goal]
        if self.max_cost is not None:
            parts.append(f"\nBudget: stop before exceeding ${self.max_cost:.2f} in API costs.")
        if self.max_steps is not None:
            parts.append(f"Step limit: complete within {self.max_steps} turns.")
        return "\n".join(parts)

    def _sync_tools(self) -> None:
        if not self.tools:
            return
        existing = {t.name: t for t in self._client.list_tools()}
        for tool in self.tools:
            body = tool._to_dict()
            name = body["name"]
            if name in existing:
                self._client._req("PUT", f"/api/tools/{existing[name].id}", json=body)
            else:
                self._client._req("POST", "/api/tools", json=body)

    def _sub_agents_dict(self) -> Optional[Dict[str, Any]]:
        """Subclasses (e.g. Swarm) override this to inject sub-agent definitions."""
        return None

    def __repr__(self) -> str:
        return f"Agent(name={self.name!r}, models={self.models})"
