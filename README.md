# aeon

Customizable infrastructure for durable, general-purpose infinite-horizon agents.

Aeon uses the Mobius architecture: each objective advances through bounded
`observe -> plan -> act -> verify -> reflect -> report` wake cycles, then becomes
dormant until useful work, a schedule, or an external event wakes it again. The
durable runtime is domain-neutral and the model, instructions, tools, sub-agents,
playbook, memory, budgets, risk policy, and approval gates are all SDK inputs.

The original interactive agent and swarm APIs remain available for one-off work.

## Setup

```bash
pnpm install
```

Make sure your `.env` has the required credentials configured.

## Anthropic API Key

This runner is now Anthropic-only for the main agent.

Before running it, provide `ANTHROPIC_API_KEY` in one of these places:

1. Root `.env` file:

```bash
# copy the example once
cp .env.example .env

# then add your real key
ANTHROPIC_API_KEY=sk-ant-...
```

2. Or your current shell session:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

If `ANTHROPIC_API_KEY` is missing, startup exits immediately with a clear error instead of falling back to Vertex.

Old Vertex env vars are ignored now. `GEMINI_API_KEY` still does not power the main agent; it only helps Browserbase Stagehand browser tools when browser automation is enabled.

## What The Agent Does

On startup, the agent now begins by figuring out what the human wants it to do.

- If you already gave it a clear task, it will work on that.
- If not, it will ask what outcome you want.
- It will not invent a startup, product, or company-building mission on its own anymore.

For software-heavy tasks, it can call the local engineering reference in [SOFTWARE_ENGINEERING_GUIDE.md](/Users/tanvirb/Documents/Code/universal-agent-infra/SOFTWARE_ENGINEERING_GUIDE.md).

## Run On Desktop (default)

```bash
bun run agent
```

## Infinite-Horizon SDK

Install the Python SDK into any application:

```bash
python -m pip install ./python
```

```python
from aeon import Agent, Budget, Objective, Playbook, PlaybookStep, Policy

agent = Agent(
    name="release-operator",
    models=["claude-sonnet-4-6"],
    system_prompt="Prefer reversible changes and verify every release.",
    policy=Policy(
        approval_required_tools=["deploy"],
        tool_risk_levels={"deploy": "critical"},
        workspace_only=True,
    ),
)

run = agent.pursue(Objective(
    goal="Keep this project releasable and publish verified releases.",
    success_criteria=["Tests pass", "Release evidence is recorded"],
    budget=Budget(max_cost_usd=20, max_cycles=10_000, max_turns_per_cycle=20),
    playbook=Playbook(
        name="verified-release",
        steps=[
            PlaybookStep("Inspect changes"),
            PlaybookStep("Run verification"),
            PlaybookStep("Publish with approval"),
        ],
    ),
))

run.emit("repository.changed", {"ref": "main"}, dedupe_key="push-123")
for approval in run.approvals(pending_only=True):
    run.approve(approval["id"], note="Release reviewed")
```

The server exposes the same control plane under `/api/v1/objectives`: objective
snapshots, durable plan steps, events, memories, action ledger, outcomes,
approvals, pause/resume/cancel, and approval resolution.

See [MOBIUS_ARCHITECTURE.md](./MOBIUS_ARCHITECTURE.md) and
[python/README.md](./python/README.md) for the full lifecycle and SDK reference.

## Safety Invariants

- A wake is bounded by SDK-native turn and cost limits; no self-reprompt loop runs forever.
- Waiting objectives consume no model tokens and can remain dormant indefinitely.
- SQLite state, checkpoints, leases, plans, events, actions, memories, approvals, and outcomes survive restarts.
- Cost, cycle, active-runtime, and tool-call budgets are enforced by the runtime.
- Denied and high-risk tools are blocked before execution; high-risk actions become durable approvals.
- Event and action idempotency keys prevent duplicate side effects across retries.
- Interrupted workers are recovered and stale leases are reclaimed on startup.

## Tests

```bash
pnpm test
pnpm test:sdk
```

`pnpm test:sdk` creates a clean virtual environment, performs a non-editable
`pip install` of the package, and drives realistic one-off, swarm, and durable
objective scenarios through the public SDK.

## Run Safe Copy On Modal CPU

```bash
bun run agent:safe
```

Install/auth once for safe mode:

```bash
python3 -m pip install modal
modal token set --token-id "$MODAL_TOKEN_ID" --token-secret "$MODAL_TOKEN_SECRET"
```

Safe mode runs the same command path in a Modal sandbox and streams terminal output live.

## Generic Modal Wrapper

Run any command in Modal:

```bash
./modal/run -- <your command>
```

Examples:

```bash
./modal/run -- bun run index.ts
./modal/run --port 3000 -- npm run dev
```

If a port is exposed, the script prints the Modal tunnel URL.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required | Direct Anthropic API key used by the main agent |
| `CLAUDE_MODEL` | `claude-sonnet-4-5-20250514` | Model to use |
