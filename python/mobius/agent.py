"""
High-level Agent / Task / Run API for Mobius.

Usage:
    from mobius import Agent, Task
    from mobius.tools import HttpTool, ShellTool
    from mobius.models import SONNET, OPUS

    agent = Agent(
        name="builder",
        models=[SONNET, OPUS],
        tools=[
            HttpTool(name="search_db", description="...", url="http://localhost:8080/search"),
            ShellTool(name="run_tests", description="...", command="pytest {{pattern}}"),
        ],
        max_cost=5.0,
        max_steps=100,
    )

    task = Task(
        goal="Build a CLI todo app with tests",
        success_criteria=["all tests pass", "README explains usage"],
    )

    run = agent.run(task)

    import asyncio
    async def watch():
        async for event in run.stream():
            if event.type == "agent_message":
                print(event.data["text"])
    asyncio.run(watch())

    run.send("Use Click, not argparse")
    print(run.result())
    run.stop()
"""

import os
from typing import Any, AsyncGenerator, Dict, List, Optional

from .client import MobiusClient
from .models import AgentEvent
from .tools import Tool

# ── Model name constants ──────────────────────────────────────────────────────

SONNET = "claude-sonnet-4-6"
HAIKU  = "claude-haiku-4-5"
OPUS   = "claude-opus-4-7"


# ── Task ──────────────────────────────────────────────────────────────────────

class Task:
    """
    Describes what an agent should accomplish.

    Args:
        goal:               The primary objective in plain language.
        context:            Optional background the agent should know.
        success_criteria:   Optional checklist the agent should satisfy before stopping.
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
            parts += ["", "Success criteria (all must be met before you finish):"]
            parts += [f"  - {c}" for c in self.success_criteria]
        return "\n".join(parts)


# ── Run ───────────────────────────────────────────────────────────────────────

class Run:
    """
    A live agent run returned by Agent.run(task).

    All methods that hit the server are synchronous except stream(), which is async.
    """

    def __init__(self, agent_id: str, client: MobiusClient) -> None:
        self._id = agent_id
        self._client = client

    # ── Identity & state ─────────────────────────────────────────────────────

    @property
    def id(self) -> str:
        """The agent's UUID on the server."""
        return self._id

    @property
    def status(self) -> str:
        """Current status: starting | running | stopped | error."""
        return self._client.get_agent(self._id).status

    @property
    def cost(self) -> float:
        """Cumulative API cost in USD so far."""
        return self._client.get_agent(self._id).total_cost_usd

    @property
    def turns(self) -> int:
        """Number of completed turns."""
        return self._client.get_agent(self._id).turn_count

    @property
    def workspace(self) -> str:
        """Absolute path to the agent's working directory on the server."""
        return self._client.get_agent(self._id).workspace_path

    # ── Control ───────────────────────────────────────────────────────────────

    def send(self, message: str) -> None:
        """Inject a message into the agent's conversation mid-run."""
        self._client.send_message(self._id, message)

    def stop(self) -> None:
        """Halt the agent immediately."""
        self._client.stop_agent(self._id)

    # ── Results ───────────────────────────────────────────────────────────────

    def result(self) -> Dict[str, Any]:
        """Return the current run snapshot (non-blocking)."""
        a = self._client.get_agent(self._id)
        return {
            "id": a.id,
            "status": a.status,
            "turns": a.turn_count,
            "cost_usd": a.total_cost_usd,
            "workspace": a.workspace_path,
        }

    def analytics(self) -> Dict[str, Any]:
        """Turn-by-turn breakdown of tool usage, phases, and costs."""
        return self._client.get_analytics(self._id)

    def summary(self) -> Dict[str, Any]:
        """AI-written narrative summary of what the agent did."""
        return self._client.get_summary(self._id)

    def invalidate_summary(self) -> None:
        """Force the AI summary to regenerate on next call."""
        self._client.invalidate_summary(self._id)

    # ── Streaming ─────────────────────────────────────────────────────────────

    async def stream(self) -> AsyncGenerator[AgentEvent, None]:
        """
        Async generator — yields live AgentEvent objects until disconnected.

        Usage:
            import asyncio

            async def watch():
                async for event in run.stream():
                    if event.type == "agent_message":
                        print(event.data["text"])
                    elif event.type == "turn_complete":
                        print(f"Turn {event.data['turns']} — ${event.data['cost']:.4f}")
                    elif event.type == "ping":
                        run.send("Yes, proceed with that approach")

            asyncio.run(watch())
        """
        async for event in self._client.stream(self._id):
            yield event


# ── Agent ─────────────────────────────────────────────────────────────────────

class Agent:
    """
    Define a long-horizon agent.

    The agent is not started until you call run(task).
    Tools are synced to the server automatically when run() is called.

    Args:
        name:       Display name (prepended to the task for context).
        models:     Allowed model names, e.g. [SONNET, OPUS].
                    The server picks the active model via CLAUDE_MODEL env var;
                    this list is recorded with the task for transparency.
        tools:      HttpTool / ShellTool instances to register for this agent.
        max_cost:   Optional USD budget ceiling (injected as a constraint in the task).
        max_steps:  Optional turn limit (injected as a constraint in the task).
        server:     Mobius server URL. Defaults to MOBIUS_SERVER env var or
                    http://localhost:3000.
    """

    def __init__(
        self,
        name: str = "agent",
        models: Optional[List[str]] = None,
        tools: Optional[List[Tool]] = None,
        max_cost: Optional[float] = None,
        max_steps: Optional[int] = None,
        server: Optional[str] = None,
    ) -> None:
        self.name = name
        self.models = models or [SONNET]
        self.tools = tools or []
        self.max_cost = max_cost
        self.max_steps = max_steps
        self._server = server or os.environ.get("MOBIUS_SERVER", "http://localhost:3000")
        self._client = MobiusClient(base_url=self._server)

    def run(self, task: Task) -> Run:
        """
        Sync tools to the server, then start the agent.
        Returns a Run handle immediately — the agent runs in the background.
        """
        self._sync_tools()

        parts = [f"[Agent: {self.name}]"]
        if len(self.models) == 1:
            parts.append(f"[Model: {self.models[0]}]")
        parts.append("")
        parts.append(task._to_prompt())
        if self.max_cost is not None:
            parts.append(f"\nBudget: stop before exceeding ${self.max_cost:.2f} in API costs.")
        if self.max_steps is not None:
            parts.append(f"Step limit: complete within {self.max_steps} turns.")

        model = self._client.create_agent("\n".join(parts))
        return Run(model.id, self._client)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _sync_tools(self) -> None:
        """Create or update each tool on the server before starting the run."""
        if not self.tools:
            return

        existing = {t.name: t for t in self._client.list_tools()}

        for tool in self.tools:
            body = tool._to_dict()
            if body["name"] in existing:
                self._client._req("PUT", f"/api/tools/{existing[body['name']].id}", json=body)
            else:
                self._client._req("POST", "/api/tools", json=body)
