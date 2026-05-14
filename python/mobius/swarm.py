"""
Swarm — coordinate a team of specialised sub-agents.

A Swarm is an Agent with sub-agents attached.
It inherits run(), spawn(), resume(), and inspect() from Agent.
The orchestrator is started as a normal Mobius agent run; sub-agents
are registered with the Claude Agent SDK so the orchestrator can
delegate to them as native tool calls.

Shared memory lives in .swarm/memory.md inside the workspace.
Each sub-agent reads it before starting and appends its findings when done,
giving the team a persistent, accumulated context across calls.

Usage:
    from mobius import Swarm, Runtime
    from mobius.swarm import SubAgent

    swarm = Swarm(
        agents=[
            SubAgent("planner", role="Break work into milestones with acceptance criteria"),
            SubAgent("coder",   role="Implement each milestone as clean, tested code"),
            SubAgent("critic",  role="Review code, run tests, flag any issues"),
        ],
        max_cost=10.0,
    )

    # Simple — swarm owns its runtime
    run = swarm.run("Build a CLI todo app with SQLite storage and full test coverage")

    # Explicit — runtime owns execution
    from mobius import Runtime
    runtime = Runtime()
    run = runtime.run(swarm, "Build a CLI todo app…")
    runtime.pause(run.id)
    run2 = runtime.resume(run.id)

    import asyncio
    async def watch():
        async for event in run.stream():
            if event.type == "agent_message":
                print(event.data["text"])
            elif event.type == "ping":
                run.send("Yes, go ahead.")
    asyncio.run(watch())
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

from .agent import Agent, Task, SONNET
from .tools import Tool


# ── Sub-agent definition ──────────────────────────────────────────────────────

@dataclass
class SubAgent:
    """
    A specialised role within a Swarm.

    Args:
        name:          Identifier the orchestrator uses to call this agent (snake_case).
        role:          One-sentence capability description shown to the orchestrator.
        system_prompt: Explicit system prompt. Auto-generated from `role` if omitted.
        model:         "sonnet" | "opus" | "haiku"  (default: "sonnet")
    """

    name: str
    role: str
    system_prompt: Optional[str] = None
    model: str = "sonnet"

    def _resolved_prompt(self) -> str:
        if self.system_prompt:
            return self.system_prompt
        return "\n".join([
            f"You are a specialised sub-agent. Your role: {self.role}",
            "",
            "Shared memory protocol:",
            "  1. Read .swarm/memory.md before starting — it holds accumulated team context.",
            "  2. Do your work thoroughly.",
            "  3. When done, append your results to .swarm/memory.md in this format:",
            "       ## [your-name] — <one-line summary>",
            "       - bullet points: key findings, decisions, artefacts created",
            "",
            "Return a clear result summary to the orchestrator.",
        ])

    def _to_sdk_entry(self) -> Dict[str, Any]:
        return {
            "description": self.role,
            "prompt": self._resolved_prompt(),
            "model": self.model,
        }

    def __repr__(self) -> str:
        return f"SubAgent({self.name!r}, role={self.role!r})"


# ── Swarm ─────────────────────────────────────────────────────────────────────

class Swarm(Agent):
    """
    A multi-agent swarm: one orchestrator coordinating N specialised sub-agents.

    Inherits all Agent methods (run, spawn, resume, inspect).
    Shared memory is maintained in .swarm/memory.md inside the workspace.

    Args:
        agents:    SubAgent definitions — the orchestrator's team.
        tools:     Custom tools available to the orchestrator.
        max_cost:  Optional USD budget constraint.
        max_steps: Optional orchestrator turn limit.
        context:   Optional background knowledge pre-loaded into shared memory.
        server:    Mobius server URL.
    """

    def __init__(
        self,
        agents: List[SubAgent],
        tools: Optional[List[Tool]] = None,
        max_cost: Optional[float] = None,
        max_steps: Optional[int] = None,
        context: Optional[str] = None,
        server: Optional[str] = None,
    ) -> None:
        if not agents:
            raise ValueError("A Swarm requires at least one SubAgent.")
        super().__init__(
            name="swarm-orchestrator",
            models=[SONNET],
            tools=tools,
            max_cost=max_cost,
            max_steps=max_steps,
            server=server,
        )
        self.agents = agents
        self.context = context

    # ── Override Agent hooks ──────────────────────────────────────────────────

    def _build_task_prompt(self, task: Union[str, Task]) -> str:
        goal = task if isinstance(task, str) else task._to_prompt()
        agent_lines = "\n".join(f"  - {a.name}: {a.role}" for a in self.agents)

        parts = [
            "[Swarm Orchestrator]",
            "",
            "You are coordinating a specialised team of sub-agents to complete a task.",
            "Delegate subtasks to each agent by role, collect their results, and",
            "synthesise the final outcome. You are accountable for the end result.",
            "",
            f"Your team ({len(self.agents)} agents):",
            agent_lines,
            "",
            "─── Shared memory protocol ───────────────────────────────────────────",
            "The file .swarm/memory.md in the workspace is shared working memory.",
            "",
            "On startup:",
            "  - Create .swarm/memory.md with the task goal and any pre-loaded context.",
            "  - If it already exists, read it to resume prior progress.",
            "",
            "Before each agent call:",
            "  - Write a '## Delegating to <name>' block: the scoped subtask,",
            "    relevant context from memory, and expected output format.",
            "",
            "After each agent returns:",
            "  - Record '## <name> result' in memory with key findings.",
            "  - Use memory — not just the last result — to plan the next step.",
            "",
            "─── Orchestration rules ──────────────────────────────────────────────",
            "  1. Decompose the task into steps that match each agent's role.",
            "  2. Give focused, scoped subtasks — not the full goal.",
            "  3. Agents share the workspace and can read/write files freely.",
            "  4. Use ping_human to report milestones or get unblocked.",
            "  5. Mark the task complete only when all success criteria are met.",
            "",
        ]

        if self.context:
            parts += [
                "─── Pre-loaded context ───────────────────────────────────────────────",
                self.context,
                "(Write this to .swarm/memory.md as the first entry.)",
                "",
            ]

        parts += ["─── Task ─────────────────────────────────────────────────────────────", goal]

        if self.max_cost is not None:
            parts.append(f"\nBudget: stop before exceeding ${self.max_cost:.2f} in total API costs.")
        if self.max_steps is not None:
            parts.append(f"Step limit: complete within {self.max_steps} orchestrator turns.")

        return "\n".join(parts)

    def _sub_agents_dict(self) -> Dict[str, Any]:
        return {a.name: a._to_sdk_entry() for a in self.agents}

    def __repr__(self) -> str:
        names = [a.name for a in self.agents]
        return f"Swarm(agents={names})"
