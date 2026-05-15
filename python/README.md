# aeon-agents — Python SDK

> **Requires the Aeon server running.**
> Start it: `bun run agent` from the project root.
> Override server: `AEON_SERVER=http://...`

```bash
cd python && pip install -e .
```

---

## Concepts

| Class | Owns |
|---|---|
| `Agent` | Definition — name, models, tools, constraints |
| `Task` | Goal — what to accomplish, success criteria |
| `Run` | A live execution — stream, steer, stop, read results |
| `Runtime` | Execution — start, pause, resume, replay, list runs |
| `Swarm` | A multi-agent team (subclass of Agent) |
| `SubAgent` | One role within a Swarm |

---

## Agent

```python
from aeon import Agent, Task, SONNET, OPUS
from aeon.tools import HttpTool, ShellTool

agent = Agent(
    name="builder",
    models=[SONNET, OPUS],          # informational; server uses CLAUDE_MODEL env var
    tools=[
        HttpTool(
            name="search_db",
            description="Search the internal database. Use when asked about products.",
            url="http://localhost:8080/search",
            params={"query": ("string", "Search query", True)},
        ),
        ShellTool(
            name="run_tests",
            description="Run the test suite before committing.",
            command="pytest {{pattern}} -v",
        ),
    ],
    max_cost=5.0,    # optional USD budget constraint
    max_steps=100,   # optional turn limit
)
```

### Agent methods

```python
run   = agent.run("Build a CLI todo app")        # start a fresh run
sub   = agent.spawn("Write tests for auth.py")   # spawn a focused sub-task
run2  = agent.resume(run.id)                     # continue from last checkpoint
state = agent.inspect(run.id)                    # snapshot dict by run ID
```

---

## Runtime

`Runtime` owns execution. Use it when you want explicit control or to manage multiple runs.

```python
from aeon import Agent, Task, Runtime, SONNET

agent   = Agent(name="researcher", models=[SONNET])
runtime = Runtime()                             # or Runtime("http://remote:3000")

run  = runtime.run(agent, Task("Research ML frameworks"))
runtime.pause(run.id)                           # stop, preserve state + workspace
run2 = runtime.resume(run.id)                   # continue from last checkpoint
run3 = runtime.replay(run.id)                   # same task, clean slate
run4 = runtime.get(run.id)                      # get handle to any existing run
runs = runtime.list()                           # all runs as Run objects
details = runtime.list_details()                # all runs as plain dicts
```

`agent.run(task)` is shorthand for `Runtime().run(agent, task)`.

---

## Task

```python
from aeon import Task

task = Task(
    goal="Build a CLI todo app in Python",
    context="Use Click. Store todos in SQLite.",          # optional
    success_criteria=[                                    # optional
        "all tests pass",
        "README explains install and usage",
        "pip install -e . works",
    ],
)
```

---

## Run

```python
run.id        # UUID
run.status    # "starting" | "running" | "stopped" | "error"
run.cost      # cumulative USD
run.turns     # completed turns
run.workspace # abs path to working directory on the server

run.send("Focus on Python 3.12+")   # steer mid-run
run.stop()                           # halt (state preserved)

run.result()     # → {"id", "status", "turns", "cost_usd", "workspace"}
run.analytics()  # → turn-by-turn tool breakdown
run.summary()    # → AI-written narrative (needs OPENROUTER_API_KEY)
run.invalidate_summary()
```

### Streaming

```python
import asyncio

async def watch(run):
    async for event in run.stream():
        t = event.type
        if t == "thinking":
            print("◌")
        elif t == "tool_use":
            print(f"⚙  {event.data['name']}")
        elif t == "agent_message":
            print(f"\nAgent: {event.data['text']}\n")
        elif t == "ping":
            print(f"⚡ {event.data['message']}")
            run.send("Yes, proceed.")
        elif t == "turn_complete":
            d = event.data
            print(f"✓ Turn {d['turns']}  ${d['cost']:.4f}  {d['duration_ms']/1000:.1f}s")

asyncio.run(watch(run))
```

**Event types:** `thinking` · `tool_use` · `tool_result` · `agent_message` · `turn_complete` · `ping` · `user_message` · `status`

---

## Swarm

Coordinate specialised sub-agents under one orchestrator.
All agents share a workspace. Shared state lives in `.swarm/memory.md` —
each agent reads it before starting and appends findings when done.

```python
from aeon import Swarm, Runtime
from aeon.swarm import SubAgent

swarm = Swarm(
    agents=[
        SubAgent("planner", role="Break work into milestones with acceptance criteria"),
        SubAgent("coder",   role="Implement each milestone as clean, tested code"),
        SubAgent("critic",  role="Review code, run tests, report issues"),
    ],
    max_cost=10.0,
    context="Stack: Python + Click + SQLite. Tests: pytest.",  # optional shared context
)

# Simple
run = swarm.run("Build a CLI todo app with full test coverage")

# With explicit runtime
runtime = Runtime()
run = runtime.run(swarm, "Build a CLI todo app…")
runtime.pause(run.id)
run2 = runtime.resume(run.id)
```

### SubAgent

```python
SubAgent(
    name="analyzer",                       # snake_case, used by orchestrator to call it
    role="Analyse code for security issues",  # shown to orchestrator
    system_prompt="...",                   # optional — auto-generated from role if omitted
    model="sonnet",                        # "sonnet" | "opus" | "haiku"
)
```

### How shared memory works

The orchestrator is instructed to maintain `.swarm/memory.md` in its workspace.

| When | What happens |
|---|---|
| Swarm starts | Orchestrator creates `.swarm/memory.md` with goal + context |
| Before each agent call | Orchestrator writes a delegation block to memory |
| Sub-agent runs | Reads memory for context, appends results when done |
| Orchestrator decides next step | Reads accumulated memory, not just last result |

Sub-agents' system prompts include these instructions automatically. You can override them per-agent with a custom `system_prompt`.

---

## Tools

```python
from aeon.tools import HttpTool, ShellTool

# HTTP — POST input as JSON, receive response as text
HttpTool(
    name="notify_slack",
    description="Send a message to the #builds Slack channel.",
    url="https://hooks.slack.com/...",
    method="POST",
    headers={"Content-Type": "application/json"},
    params={"text": ("string", "Message to send", True)},
)

# Shell — substitute {{param}} tokens, run via sh -c
ShellTool(
    name="deploy",
    description="Deploy to staging. Run after tests pass.",
    command="./scripts/deploy.sh --env {{env}} --tag {{tag}}",
    cwd="/path/to/project",
    timeout_ms=120_000,
    params={
        "env": ("string", "Target environment",  True),
        "tag": ("string", "Git tag to deploy",   True),
    },
)
```

Param tuple: `(type, description, required)` — type is `"string"` `"number"` `"integer"` `"boolean"` `"array"`.

Tools are synced to the server when `run()` is called. Manage them in the web UI at `/tools` or via `bun run cli tools:list`.

---

## Model constants

```python
from aeon import SONNET, HAIKU, OPUS

SONNET  # "claude-sonnet-4-6"
HAIKU   # "claude-haiku-4-5"
OPUS    # "claude-opus-4-7"
```

---

## Exceptions

```python
from aeon import ServerNotRunningError, AgentNotFoundError

try:
    run = agent.run(task)
except ServerNotRunningError:
    print("Start the server: bun run agent")
except AgentNotFoundError:
    print("Run ID not found")
```

---

## Low-level client

`AeonClient` is still available for direct API access:

```python
from aeon import AeonClient

client = AeonClient()
agents = client.list_agents()
client.set_config(ANTHROPIC_API_KEY="sk-ant-...")
tools  = client.list_tools()
```

---

## Package layout

```
python/aeon/
  __init__.py    exports
  agent.py       Agent, Task, Run + model constants
  runtime.py     Runtime
  swarm.py       Swarm, SubAgent
  tools.py       HttpTool, ShellTool
  client.py      AeonClient (HTTP wrapper)
  models.py      dataclasses for API responses
  streaming.py   WebSocket async generator
  exceptions.py  error types
```
