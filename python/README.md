# mobius-agents — Python SDK

Python SDK for programmatic access to the Mobius agent infrastructure.
Use this when you want to create and manage agents from Python code — scripts,
notebooks, or your own applications.

> **The Mobius server must be running** before using this SDK.
> Start it with `bun run agent` from the project root, or use the built-in CLI (`bun run cli`).
>
> For terminal usage without Python, use the built-in Bun CLI: `bun run cli --help`

---

## Installation

```bash
cd python
pip install -e .
```

### Dependencies

| Package | Purpose |
|---|---|
| `requests` | HTTP API calls |
| `websockets` | Real-time event streaming |

---

## Quickstart

```python
from mobius import MobiusClient

client = MobiusClient()  # connects to http://localhost:3000 by default

agent = client.create_agent("Research the top Python ML frameworks")
print(agent.id, agent.status)
```

---

## Client

```python
from mobius import MobiusClient

client = MobiusClient()                           # local server
client = MobiusClient("http://remote-host:3000")  # or remote
```

---

## Agents

```python
# Create an agent — returns immediately, agent runs async on the server
agent = client.create_agent("Build a web scraper for Hacker News")
print(agent.id)             # UUID
print(agent.status)         # "starting" → "running"
print(agent.task)

# List all agents
for a in client.list_agents():
    print(a.id, a.status, a.turn_count, a.total_cost_usd)

# Refresh state
agent = client.get_agent(agent.id)

# Steer a running agent
client.send_message(agent.id, "Only include open-source tools")

# Stop
client.stop_agent(agent.id)
```

### Stream live events

```python
import asyncio
from mobius import MobiusClient

client = MobiusClient()

async def watch(agent_id: str):
    async for event in client.stream(agent_id):
        if event.type == "agent_message":
            print("Agent:", event.data["text"])
        elif event.type == "turn_complete":
            print(f"Turn {event.data['turns']} — ${event.data['cost']:.4f}")
        elif event.type == "ping":
            print("Agent needs input:", event.data["message"])

asyncio.run(watch(agent.id))
```

---

## Custom Tools

Define tools that agents can call during their runs.
Tools can call HTTP endpoints or execute local shell commands.

### List and get tools

```python
tools = client.list_tools()
for t in tools:
    print(t.name, t.executor["type"], "enabled" if t.enabled else "disabled")

tool = client.get_tool(tool_id)
```

### Create an HTTP tool

The agent sends input parameters as a JSON body and receives the response text.

```python
from mobius import MobiusClient, ToolInputSchema, JsonSchemaProperty

client = MobiusClient()

schema = ToolInputSchema(
    properties={
        "query": JsonSchemaProperty(type="string", description="Search query"),
        "limit": JsonSchemaProperty(type="number", description="Max results"),
    },
    required=["query"],
)

tool = client.create_tool(
    name="search_database",
    description="Search the internal product database. Use when the user asks about specific products or inventory.",
    executor={
        "type": "http",
        "url": "http://localhost:8080/api/search",
        "method": "POST",
        # "headers": {"Authorization": "Bearer sk-..."},  # optional
    },
    input_schema=schema,
)
print(tool.id, tool.name)
```

### Create a shell tool

Parameter values are shell-quoted and substituted into the command via `{{param_name}}`.

```python
tool = client.create_tool(
    name="run_tests",
    description="Run the project test suite. Use before committing code changes.",
    executor={
        "type": "shell",
        "command": "npm test -- --testPathPattern={{pattern}}",
        # "cwd": "/path/to/project",  # defaults to agent workspace
        # "timeout": 60000,            # ms, default 30000
    },
    input_schema=ToolInputSchema(
        properties={"pattern": JsonSchemaProperty(type="string", description="Test file pattern")},
    ),
)
```

### No-parameter tool

Omit `input_schema` for tools that take no arguments:

```python
tool = client.create_tool(
    name="get_server_status",
    description="Check if the production server is healthy.",
    executor={"type": "http", "url": "http://prod/health", "method": "GET"},
)
```

### Update and toggle

```python
# Update any fields
client.update_tool(tool.id, description="Updated description", enabled=False)

# Toggle enabled/disabled
updated = client.toggle_tool(tool.id)
print(updated.enabled)  # True / False

# Delete
client.delete_tool(tool.id)
```

---

## Analytics and Summary

```python
analytics = client.get_analytics(agent.id)
# dict with turn-by-turn breakdown of tool usage, phases, costs

summary = client.get_summary(agent.id)
# summary["state"]                → "ready" | "generating" | "error"
# summary["summary"]["overall"]   → one-sentence description
# summary["summary"]["phases"]    → list of phase summaries

client.invalidate_summary(agent.id)  # force regeneration
```

---

## Config

```python
cfg = client.get_config()
print(cfg.keys)  # {"ANTHROPIC_API_KEY": True, "OPENROUTER_API_KEY": False}

client.set_config(ANTHROPIC_API_KEY="sk-ant-...")
```

---

## Data models

### `Agent`

| Field | Type | Description |
|---|---|---|
| `id` | `str` | Full UUID |
| `task` | `str` | Original task description |
| `status` | `str` | `starting` / `running` / `stopped` / `error` |
| `created_at` | `str` | ISO timestamp |
| `url` | `str` | Path to web UI page (`/agents/{id}`) |
| `turn_count` | `int` | Completed turns |
| `total_cost_usd` | `float` | Cumulative API cost |
| `workspace_path` | `str` | Absolute path to agent's workspace on the server |

### `AgentEvent`

| Field | Type | Description |
|---|---|---|
| `type` | `str` | Event type (see table below) |
| `ts` | `str \| None` | ISO timestamp |
| `data` | `dict` | Full raw payload |

**Event types:**

| Type | When | Key fields |
|---|---|---|
| `connected` | First connection | `agentId`, `task` |
| `thinking` | Agent reasoning | — |
| `tool_use` | Tool invoked | `name`, `input` |
| `tool_result` | Tool returned | `summary` |
| `agent_message` | Agent produced text | `text` |
| `turn_complete` | Turn finished | `cost`, `turns`, `duration_ms` |
| `ping` | Agent asked a question | `message` |
| `user_message` | Human message injected | `text` |
| `status` | Agent stopping | `text` |

### `CustomTool`

| Field | Type | Description |
|---|---|---|
| `id` | `str` | UUID |
| `name` | `str` | snake_case identifier |
| `description` | `str` | Shown to the model |
| `input_schema` | `ToolInputSchema` | Parameter definitions |
| `executor` | `dict` | `{"type": "http" \| "shell", ...}` |
| `enabled` | `bool` | Whether agents can call this tool |
| `created_at` / `updated_at` | `str` | ISO timestamps |

### `ToolInputSchema`

| Field | Type | Description |
|---|---|---|
| `properties` | `dict[str, JsonSchemaProperty]` | Parameter definitions |
| `required` | `list[str]` | Names of required parameters |

### `JsonSchemaProperty`

| Field | Type | Description |
|---|---|---|
| `type` | `str` | `string` / `number` / `integer` / `boolean` / `array` |
| `description` | `str \| None` | Shown to the model alongside the parameter |

---

## Exceptions

```python
from mobius import ServerNotRunningError, AgentNotFoundError, MobiusError

try:
    client.list_agents()
except ServerNotRunningError:
    print("Start the server: bun run agent")
except AgentNotFoundError:
    print("Agent ID not found")
except MobiusError as e:
    print("Error:", e)
```

---

## Extending the package

```
python/
  mobius/
    __init__.py     public exports — update when adding symbols
    client.py       MobiusClient — add new API methods here
    models.py       dataclasses — add fields as the server API grows
    streaming.py    WebSocket logic
    exceptions.py   error types
  pyproject.toml    bump version here when releasing
```

**Adding a new API endpoint:**
1. Add a method to `MobiusClient` in `client.py`
2. Add any new response types to `models.py`
3. Export new symbols from `__init__.py`
4. Bump the version in `pyproject.toml`
