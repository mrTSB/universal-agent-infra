# mobius-agents — Python SDK & CLI

Python package for creating and managing long-horizon Mobius agents without the web UI.
Wraps the Mobius HTTP/WebSocket API with a clean SDK and a `mobius` terminal command.

> **Prerequisite:** The Mobius server must be running before using this package.
> See the main project README for server setup. Start it with `mobius start` or `bun run agent`.

---

## Installation

```bash
cd python
pip install -e .
```

This installs the `mobius` CLI command and the `mobius` Python package.

### Dependencies

| Package | Purpose |
|---|---|
| `requests` | HTTP API calls |
| `websockets` | Real-time event streaming |
| `click` | CLI framework |
| `rich` | Terminal formatting |

---

## CLI

All commands accept a `--server` flag (or `MOBIUS_SERVER` env var) to point at a non-local server.

```bash
mobius --server http://192.168.1.10:3000 list
# or
export MOBIUS_SERVER=http://192.168.1.10:3000
```

### Start the server

```bash
mobius start           # runs: bun run agent  (auto-detects project root)
mobius start --safe    # runs in Modal sandbox
```

### Create an agent

```bash
mobius create "Research the top Python ML frameworks and write a comparison report"
```

Create and immediately stream its output:

```bash
mobius create "Build a web scraper for Hacker News" --watch
```

### List agents

```bash
mobius list
```

```
 ID         Status    Turns   Cost      Created    Task
 3f2a1b8c…  running   12      $0.0143   05/14 09:12  Research the top Python ML...
 a9d4e2f1…  stopped   47      $0.1820   05/13 22:41  Build a web scraper for...
```

### Get agent details

```bash
mobius get 3f2a1b8c-...
```

### Watch live events

Streams the agent's thinking, tool calls, and messages in real time:

```bash
mobius watch 3f2a1b8c-...
```

Output as raw JSON (useful for piping to `jq`):

```bash
mobius watch 3f2a1b8c-... --json | jq 'select(.type == "agent_message")'
```

Press `Ctrl+C` to stop watching — the agent keeps running.

### Send a message to an agent

Injects a message into the agent's conversation mid-run:

```bash
mobius send 3f2a1b8c-... "Focus only on open-source frameworks, skip commercial ones"
```

### Stop an agent

```bash
mobius stop 3f2a1b8c-...
```

### Analytics

Turn-by-turn breakdown of tool usage, phases, and costs:

```bash
mobius analytics 3f2a1b8c-...
```

### AI summary

Human-readable summary of what the agent did, grouped by phase:

```bash
mobius summary 3f2a1b8c-...
```

If the summary is still generating, re-run the command after a moment.

### Manage API keys

```bash
mobius config status
mobius config set ANTHROPIC_API_KEY=sk-ant-...
mobius config set OPENROUTER_API_KEY=sk-or-...
```

Keys are persisted on the server (in `.agents/keys.json`) — you only need to set them once.

---

## Python SDK

### Basic usage

```python
from mobius import MobiusClient

client = MobiusClient()                          # defaults to http://localhost:3000
client = MobiusClient("http://remote-host:3000") # remote server
```

### Create and manage agents

```python
from mobius import MobiusClient

client = MobiusClient()

# Create an agent — returns immediately, agent runs async on the server
agent = client.create_agent("Research AI trends in 2025 and write a report")
print(agent.id)      # full UUID
print(agent.status)  # "starting" → "running"
print(agent.task)

# List all agents
agents = client.list_agents()
for a in agents:
    print(a.id, a.status, a.turn_count, a.total_cost_usd)

# Fetch current state of one agent
agent = client.get_agent(agent.id)

# Steer a running agent
client.send_message(agent.id, "Only include peer-reviewed sources")

# Halt an agent
client.stop_agent(agent.id)
```

### Stream real-time events

`client.stream()` is an async generator. Use it inside an `async` function:

```python
import asyncio
from mobius import MobiusClient

client = MobiusClient()

async def watch(agent_id: str):
    async for event in client.stream(agent_id):
        if event.type == "agent_message":
            print("Agent:", event.data["text"])
        elif event.type == "turn_complete":
            cost = event.data.get("cost", 0)
            turns = event.data.get("turns", 0)
            print(f"Turn {turns} done — ${cost:.4f}")
        elif event.type == "ping":
            print("Agent needs input:", event.data["message"])

asyncio.run(watch("3f2a1b8c-..."))
```

### Analytics and summary

```python
analytics = client.get_analytics(agent.id)
# {
#   "turns": [...],
#   "phases": [...],
#   "totalCost": 0.0143,
#   ...
# }

summary = client.get_summary(agent.id)
# summary["state"]           → "ready" | "generating" | "error"
# summary["summary"]["overall"]  → one-sentence description
# summary["summary"]["phases"]   → list of phase summaries

# Force regeneration
client.invalidate_summary(agent.id)
```

### Config

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
| `turn_count` | `int` | Number of completed turns |
| `total_cost_usd` | `float` | Cumulative API cost |
| `workspace_path` | `str` | Absolute path to agent's workspace on the server |

### `AgentEvent`

| Field | Type | Description |
|---|---|---|
| `type` | `str` | Event type (see below) |
| `ts` | `str \| None` | ISO timestamp |
| `data` | `dict` | Full raw event payload |

**Event types:**

| Type | When | Key fields in `data` |
|---|---|---|
| `connected` | First connection | `agentId`, `task` |
| `history` | Replay on reconnect | `messages: list` |
| `thinking` | Agent is reasoning | — |
| `tool_use` | Tool invoked | `name`, `input` |
| `tool_result` | Tool returned | `summary` |
| `agent_message` | Agent produced text | `text` |
| `turn_complete` | Turn finished | `cost`, `turns`, `duration_ms`, `stop_reason` |
| `ping` | Agent asked a question | `message` |
| `user_message` | Human message injected | `text` |
| `status` | Agent stopping | `text` |

### `ConfigStatus`

| Field | Type | Description |
|---|---|---|
| `keys` | `dict[str, bool]` | Key name → whether it is set |

---

## Exceptions

```python
from mobius import ServerNotRunningError, AgentNotFoundError, MobiusError

try:
    agents = client.list_agents()
except ServerNotRunningError:
    print("Start the server first: mobius start")
except AgentNotFoundError:
    print("That agent ID does not exist")
except MobiusError as e:
    print("Unexpected error:", e)
```

---

## Extending the package

The package is structured to be easy to extend:

```
python/
  mobius/
    __init__.py     exports — update when adding public symbols
    client.py       MobiusClient — add new API methods here
    models.py       dataclasses — add fields as the server API grows
    streaming.py    WebSocket logic — isolated, easy to swap
    exceptions.py   error types
    cli.py          Click commands — add a new @main.command() to expose new methods
  pyproject.toml    bump version here when releasing
```

**Adding a new API endpoint:**
1. Add a method to `MobiusClient` in `client.py`
2. Add a corresponding `@main.command()` in `cli.py`
3. Export any new models from `__init__.py`
4. Bump the version in `pyproject.toml`

**Versioning:** follows the Mobius server version. A `0.x` package talks to a `0.x` server.
