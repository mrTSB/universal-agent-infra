# mobius-agents — Python SDK

Python SDK for defining and running long-horizon Mobius agents from code.

> **Requires the Mobius server to be running.**
> Start it with `bun run agent` from the project root.
> Set `MOBIUS_SERVER=http://...` to point at a remote instance.

---

## Installation

```bash
cd python
pip install -e .
```

---

## Quickstart

```python
from mobius import Agent, Task, SONNET

agent = Agent(
    name="researcher",
    models=[SONNET],
)

task = Task(goal="Summarise the top 5 Python web frameworks")

run = agent.run(task)
print(run.id, run.status)
```

---

## Defining an agent

```python
from mobius import Agent, SONNET, OPUS
from mobius.tools import HttpTool, ShellTool

agent = Agent(
    name="builder",

    # Allowed models — informational; server picks the active model via CLAUDE_MODEL env var.
    # Listed here so the task prompt reflects the intended capability tier.
    models=[SONNET, OPUS],

    # Custom tools the agent can call (synced to the server on run())
    tools=[
        HttpTool(
            name="search_db",
            description="Search the internal product database. Use when asked about products or inventory.",
            url="http://localhost:8080/search",
            method="POST",
            params={
                "query": ("string", "Search query",  True),
                "limit": ("number", "Max results",   False),
            },
        ),
        ShellTool(
            name="run_tests",
            description="Run the test suite before committing code changes.",
            command="pytest {{pattern}} -v",
            params={
                "pattern": ("string", "Test file pattern or path", False),
            },
        ),
    ],

    max_cost=5.00,   # optional USD budget — injected as a constraint in the task prompt
    max_steps=100,   # optional turn limit  — same
)
```

### Model constants

```python
from mobius import SONNET, HAIKU, OPUS

SONNET  # "claude-sonnet-4-6"
HAIKU   # "claude-haiku-4-5"
OPUS    # "claude-opus-4-7"
```

---

## Defining a task

```python
from mobius import Task

task = Task(
    goal="Build a CLI todo app in Python with full test coverage",

    context="Use Click for the CLI. Store todos in a local SQLite database.",  # optional

    success_criteria=[           # optional — agent is told to satisfy all before finishing
        "all tests pass",
        "README explains install and usage",
        "package installs with pip install -e .",
    ],
)
```

---

## Starting a run

`agent.run(task)` syncs any tool definitions to the server, then starts the agent.
It returns immediately — the agent runs in the background.

```python
run = agent.run(task)

print(run.id)        # UUID
print(run.status)    # "starting" → "running"
print(run.cost)      # cumulative USD so far
print(run.turns)     # completed turns
print(run.workspace) # absolute path to agent's working directory on the server
```

---

## Streaming live events

```python
import asyncio
from mobius import Agent, Task, SONNET

agent = Agent(name="coder", models=[SONNET])
run = agent.run(Task(goal="Write a Fibonacci function and test it"))

async def watch():
    async for event in run.stream():
        t = event.type

        if t == "thinking":
            print("◌ thinking...")
        elif t == "tool_use":
            print(f"⚙  {event.data['name']}  {event.data['input']}")
        elif t == "tool_result":
            print(f"   → {event.data['summary']}")
        elif t == "agent_message":
            print(f"\nAgent: {event.data['text']}\n")
        elif t == "ping":
            print(f"\n⚡ Agent asks: {event.data['message']}")
            run.send("Yes, go ahead.")           # reply inside the loop
        elif t == "turn_complete":
            d = event.data
            print(f"✓ Turn {d['turns']}  cost=${d['cost']:.4f}  {d['duration_ms']/1000:.1f}s")

asyncio.run(watch())
```

### All event types

| `event.type` | When | Key fields in `event.data` |
|---|---|---|
| `thinking` | Agent is reasoning | — |
| `tool_use` | Tool called | `name`, `input` |
| `tool_result` | Tool returned | `summary` |
| `agent_message` | Agent produced text | `text` |
| `turn_complete` | Turn finished | `cost`, `turns`, `duration_ms`, `stop_reason` |
| `ping` | Agent asks a question | `message` |
| `user_message` | Message injected | `text` |
| `status` | Agent stopping | `text` |

---

## Controlling a run

```python
# Steer the agent mid-run
run.send("Focus on Python 3.12+, ignore older versions")

# Stop immediately
run.stop()
```

---

## Reading results

```python
# Non-blocking snapshot
r = run.result()
# {
#   "id": "...",
#   "status": "running",
#   "turns": 14,
#   "cost_usd": 0.0312,
#   "workspace": "/path/to/.agents/{id}/workspace"
# }

# Turn-by-turn tool breakdown
analytics = run.analytics()

# AI-written narrative summary (requires OPENROUTER_API_KEY on the server)
summary = run.summary()
# summary["state"]                  → "ready" | "generating" | "error"
# summary["summary"]["overall"]     → one sentence
# summary["summary"]["phases"]      → list of phase summaries

run.invalidate_summary()  # force regeneration
```

---

## Tools

### HttpTool

Calls an HTTP endpoint when invoked. Input params → JSON body (POST/PUT/PATCH) or query string (GET). Response body returned to agent as text.

```python
HttpTool(
    name="get_weather",
    description="Get current weather for a city. Use when the task involves location-based decisions.",
    url="http://api.weather.internal/current",
    method="GET",
    headers={"X-API-Key": "secret"},  # optional
    params={
        "city": ("string", "City name", True),
    },
)
```

### ShellTool

Runs a local shell command. Use `{{param_name}}` for substitution — values are shell-quoted before insertion.

```python
ShellTool(
    name="deploy",
    description="Deploy the app to the staging environment.",
    command="./scripts/deploy.sh --env {{env}} --tag {{tag}}",
    cwd="/path/to/project",  # optional, defaults to agent workspace
    timeout_ms=120_000,      # optional, default 30 000
    params={
        "env": ("string", "Target environment (staging|prod)", True),
        "tag": ("string", "Git tag or branch to deploy",       True),
    },
)
```

### Param tuple format

```
(type, description, required)
```

| `type` | Python equivalent |
|---|---|
| `"string"` | `str` |
| `"number"` | `float` |
| `"integer"` | `int` |
| `"boolean"` | `bool` |
| `"array"` | `list` |

Tools are synced to the server when `agent.run()` is called. If a tool with the same name already exists it is updated in place. Tools persist across runs — you can manage them in the web UI (`/tools`) or via the CLI (`bun run cli tools:list`).

---

## Low-level client

`MobiusClient` is still available for direct API access when you need it:

```python
from mobius import MobiusClient

client = MobiusClient()                           # http://localhost:3000
client = MobiusClient("http://remote-host:3000")

# Direct agent management
agents = client.list_agents()
client.send_message(agent_id, "message")
client.stop_agent(agent_id)

# Config
client.set_config(ANTHROPIC_API_KEY="sk-ant-...")
cfg = client.get_config()  # ConfigStatus — never exposes key values

# Tools
tools = client.list_tools()
client.toggle_tool(tool_id)
client.delete_tool(tool_id)
```

---

## Exceptions

```python
from mobius import ServerNotRunningError, AgentNotFoundError, MobiusError

try:
    run = agent.run(task)
except ServerNotRunningError:
    print("Start the server: bun run agent")
except MobiusError as e:
    print("Error:", e)
```

---

## Extending the package

```
python/
  mobius/
    __init__.py   public exports
    agent.py      Agent, Task, Run — high-level API
    tools.py      HttpTool, ShellTool — tool definitions
    client.py     MobiusClient — raw HTTP wrapper
    models.py     dataclasses for API responses
    streaming.py  WebSocket event generator
    exceptions.py error types
  pyproject.toml  bump version here when releasing
```
