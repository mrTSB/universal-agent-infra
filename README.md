# mobius-1

Interactive autonomous CLI built on the Claude Agent SDK.

## Setup

```bash
bun install
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
