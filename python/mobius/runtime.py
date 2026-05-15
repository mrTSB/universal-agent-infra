"""
Runtime — owns execution of agents and swarms.

While Agent defines what an agent is,
Runtime decides how and when it runs.

Usage:
    from mobius import Agent, Task, Runtime, SONNET

    agent = Agent(name="coder", models=[SONNET])
    task  = Task("Build a CLI todo app")

    runtime = Runtime()

    run = runtime.run(agent, task)        # start a fresh run
    runtime.pause(run.id)                 # stop, preserving state
    run2 = runtime.resume(run.id)         # continue from last checkpoint
    run3 = runtime.replay(run.id)         # same task, clean slate
    runs = runtime.list()                 # all runs on this server
    run4 = runtime.get(run.id)            # get a handle to any run
"""

import os
from typing import Any, Dict, List, Optional, Union

from .client import MobiusClient
from .models import Agent as _AgentModel


class Runtime:
    """
    Execution environment for agents and swarms.

    A single Runtime can manage many concurrent runs.
    By default it connects to localhost:3000 (or MOBIUS_SERVER env var).

    Args:
        server: Mobius server URL.
    """

    def __init__(self, server: Optional[str] = None) -> None:
        self._server = server or os.environ.get("MOBIUS_SERVER", "http://localhost:3000")
        self._client = MobiusClient(base_url=self._server)

    # ── Execution ─────────────────────────────────────────────────────────────

    def run(self, agent: "Agent", task: Union[str, "Task"]) -> "Run":  # type: ignore[name-defined]
        """
        Sync tools, then start a fresh agent run.
        Returns a Run handle immediately — the agent runs in the background.
        """
        from .agent import Run

        agent._sync_tools()

        body: Dict[str, Any] = {"task": agent._build_task_prompt(task)}
        if agent.max_cost is not None:
            body["maxCostUsd"] = agent.max_cost   # server-side hard stop
        sub_agents = agent._sub_agents_dict()
        if sub_agents:
            body["subAgents"] = sub_agents

        response = self._client._req("POST", "/api/agents", json=body).json()
        return Run(_AgentModel.from_dict(response).id, self._client)

    def batch(
        self,
        agent: "Agent",
        tasks: List[Union[str, "Task"]],
        *,
        wait: bool = False,
        poll_interval: float = 3.0,
    ) -> List["Run"]:  # type: ignore[name-defined]
        """
        Start multiple agent runs in parallel, one per task.

        All runs share the same agent definition (tools, models, constraints).
        Returns Run handles immediately unless wait=True.

        Args:
            agent:         Agent definition to use for every run.
            tasks:         List of task strings or Task objects.
            wait:          Block until every run completes before returning.
            poll_interval: Poll frequency in seconds when wait=True.

        Example:
            runs = runtime.batch(agent, [
                "Summarise paper A",
                "Summarise paper B",
                "Summarise paper C",
            ], wait=True)

            for run in runs:
                print(run.id, run.cost)
        """
        from concurrent.futures import ThreadPoolExecutor, as_completed

        with ThreadPoolExecutor(max_workers=min(len(tasks), 10)) as pool:
            futures = [pool.submit(self.run, agent, t) for t in tasks]
            runs = [f.result() for f in as_completed(futures)]

        if wait:
            with ThreadPoolExecutor(max_workers=len(runs)) as pool:
                futures_w = [
                    pool.submit(r.wait, poll_interval=poll_interval) for r in runs
                ]
                for f in as_completed(futures_w):
                    f.result()  # surface any exceptions

        return runs

    def pause(self, run_id: str) -> None:
        """
        Stop the agent, preserving its workspace and turn history.
        Use resume() to continue from the last checkpoint.
        """
        self._client.stop_agent(run_id)

    def resume(self, run_id: str) -> "Run":  # type: ignore[name-defined]
        """
        Resume a paused/stopped run from its last checkpoint.
        The same workspace, files, and accumulated state are reused.
        """
        from .agent import Run

        response = self._client._req("POST", f"/api/agents/{run_id}/resume").json()
        # Resume returns the same ID on success
        resumed_id = response.get("id", run_id)
        return Run(resumed_id, self._client)

    def replay(self, run_id: str) -> "Run":  # type: ignore[name-defined]
        """
        Start a fresh run with the same task as an existing run.
        Gets a new workspace and clean state — useful for retrying after failure.
        """
        from .agent import Run

        response = self._client._req("POST", f"/api/agents/{run_id}/replay").json()
        return Run(response["id"], self._client)

    # ── Inspection ────────────────────────────────────────────────────────────

    def get(self, run_id: str) -> "Run":  # type: ignore[name-defined]
        """Get a Run handle for any existing run by ID."""
        from .agent import Run
        return Run(run_id, self._client)

    def list(self) -> List["Run"]:  # type: ignore[name-defined]
        """Return Run handles for all agents on this server."""
        from .agent import Run
        return [Run(a.id, self._client) for a in self._client.list_agents()]

    def list_details(self) -> List[Dict[str, Any]]:
        """Return full detail dicts for all agents (cheaper than fetching each Run)."""
        agents = self._client.list_agents()
        return [
            {
                "id": a.id,
                "status": a.status,
                "task": a.task,
                "turns": a.turn_count,
                "cost_usd": a.total_cost_usd,
            }
            for a in agents
        ]

    def __repr__(self) -> str:
        return f"Runtime(server={self._server!r})"
