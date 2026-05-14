import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime
from typing import Optional

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .client import MobiusClient
from .exceptions import AgentNotFoundError, ServerNotRunningError
from .models import AgentEvent

console = Console()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _client(ctx) -> MobiusClient:
    return MobiusClient(base_url=ctx.obj["server"])


def _status_color(status: str) -> str:
    return {"running": "green", "starting": "yellow", "stopped": "red", "error": "red"}.get(
        status, "white"
    )


def _fmt_cost(cost: float) -> str:
    return f"${cost:.4f}" if cost else "-"


def _fmt_ts(ts: str) -> str:
    if not ts:
        return "-"
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%m/%d %H:%M")
    except Exception:
        return ts[:16]


def _handle_err(e: Exception) -> None:
    console.print(f"[red]Error:[/red] {e}")
    sys.exit(1)


def _find_project_root() -> Optional[str]:
    path = os.path.abspath(".")
    for _ in range(6):
        if os.path.exists(os.path.join(path, "index.ts")):
            return path
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
    return None


# ── Root group ────────────────────────────────────────────────────────────────

@click.group()
@click.option(
    "--server",
    default="http://localhost:3000",
    envvar="MOBIUS_SERVER",
    show_default=True,
    help="Mobius server URL",
)
@click.pass_context
def main(ctx, server):
    """Mobius – Universal Agent Infrastructure CLI

    Create and manage long-horizon AI agents from the terminal.

    \b
    Quick start:
      mobius start                          # start the server
      mobius create "Research X"            # spawn an agent
      mobius list                           # list all agents
      mobius watch <id>                     # stream live events
      mobius send <id> "focus on Y"         # steer the agent
      mobius stop <id>                      # halt the agent
    """
    ctx.ensure_object(dict)
    ctx.obj["server"] = server


# ── Agent commands ────────────────────────────────────────────────────────────

@main.command()
@click.argument("task")
@click.option("--watch", "-w", is_flag=True, help="Stream events immediately after creating")
@click.pass_context
def create(ctx, task, watch):
    """Spawn a new long-horizon agent with TASK as its objective."""
    client = _client(ctx)
    try:
        with console.status("Creating agent…"):
            agent = client.create_agent(task)
    except ServerNotRunningError as e:
        _handle_err(e)

    sc = _status_color(agent.status)
    console.print(
        Panel(
            f"[dim]ID:[/dim]     [bold]{agent.id}[/bold]\n"
            f"[dim]Task:[/dim]   {agent.task}\n"
            f"[dim]Status:[/dim] [{sc}]{agent.status}[/{sc}]\n"
            f"[dim]URL:[/dim]    {ctx.obj['server']}{agent.url}",
            title="[bold green]Agent created[/bold green]",
            border_style="green",
        )
    )

    if watch:
        ctx.invoke(watch_cmd, agent_id=agent.id)


@main.command("list")
@click.pass_context
def list_agents(ctx):
    """List all agents."""
    client = _client(ctx)
    try:
        agents = client.list_agents()
    except ServerNotRunningError as e:
        _handle_err(e)

    if not agents:
        console.print("[dim]No agents found.[/dim]")
        return

    table = Table(border_style="dim", show_lines=False)
    table.add_column("ID", style="bold cyan", no_wrap=True)
    table.add_column("Status", no_wrap=True)
    table.add_column("Turns", justify="right")
    table.add_column("Cost", justify="right")
    table.add_column("Created", no_wrap=True)
    table.add_column("Task")

    for a in agents:
        sc = _status_color(a.status)
        table.add_row(
            a.id[:8] + "…",
            f"[{sc}]{a.status}[/{sc}]",
            str(a.turn_count) if a.turn_count else "-",
            _fmt_cost(a.total_cost_usd),
            _fmt_ts(a.created_at),
            (a.task[:60] + "…") if len(a.task) > 60 else a.task,
        )

    console.print(table)


@main.command("get")
@click.argument("agent_id")
@click.pass_context
def get_agent(ctx, agent_id):
    """Show details for a single agent."""
    client = _client(ctx)
    try:
        agent = client.get_agent(agent_id)
    except (ServerNotRunningError, AgentNotFoundError) as e:
        _handle_err(e)

    sc = _status_color(agent.status)
    console.print(
        Panel(
            f"[dim]ID:[/dim]        {agent.id}\n"
            f"[dim]Task:[/dim]      {agent.task}\n"
            f"[dim]Status:[/dim]    [{sc}]{agent.status}[/{sc}]\n"
            f"[dim]Turns:[/dim]     {agent.turn_count or '-'}\n"
            f"[dim]Cost:[/dim]      {_fmt_cost(agent.total_cost_usd)}\n"
            f"[dim]Created:[/dim]   {_fmt_ts(agent.created_at)}\n"
            f"[dim]Workspace:[/dim] {agent.workspace_path or '-'}",
            title=f"[bold]Agent {agent.id[:8]}[/bold]",
            border_style=sc,
        )
    )


@main.command("stop")
@click.argument("agent_id")
@click.pass_context
def stop_agent(ctx, agent_id):
    """Halt a running agent."""
    client = _client(ctx)
    try:
        with console.status(f"Stopping {agent_id[:8]}…"):
            client.stop_agent(agent_id)
        console.print(f"[green]Stopped[/green] agent [bold]{agent_id[:8]}[/bold]")
    except (ServerNotRunningError, AgentNotFoundError) as e:
        _handle_err(e)


@main.command("send")
@click.argument("agent_id")
@click.argument("message")
@click.pass_context
def send_message(ctx, agent_id, message):
    """Inject MESSAGE into a running agent's conversation."""
    client = _client(ctx)
    try:
        client.send_message(agent_id, message)
        console.print(f"[green]Sent[/green] message to agent [bold]{agent_id[:8]}[/bold]")
    except (ServerNotRunningError, AgentNotFoundError) as e:
        _handle_err(e)


@main.command("watch")
@click.argument("agent_id")
@click.option("--json", "as_json", is_flag=True, help="Output raw JSON events")
@click.pass_context
def watch_cmd(ctx, agent_id, as_json):
    """Stream real-time events from an agent. Press Ctrl+C to exit."""
    server = ctx.obj["server"]
    ws_url = server.replace("https://", "wss://").replace("http://", "ws://")

    try:
        agent = MobiusClient(base_url=server).get_agent(agent_id)
    except (ServerNotRunningError, AgentNotFoundError) as e:
        _handle_err(e)

    console.print(
        Panel(
            f"[bold]Agent:[/bold] {agent_id}\n"
            f"[dim]Task:[/dim]  {agent.task}\n\n"
            "[dim]Ctrl+C to stop[/dim]",
            border_style="blue",
        )
    )
    asyncio.run(_watch_async(ws_url, agent_id, as_json))


async def _watch_async(ws_url: str, agent_id: str, as_json: bool) -> None:
    from .streaming import stream_agent_events

    try:
        async for event in stream_agent_events(ws_url, agent_id):
            _render_event(event, as_json)
    except KeyboardInterrupt:
        console.print("\n[dim]Stopped watching.[/dim]")
    except Exception as e:
        console.print(f"\n[red]Stream error:[/red] {e}")


def _render_event(event: AgentEvent, as_json: bool) -> None:
    if as_json:
        console.print_json(json.dumps(event.data))
        return

    t = event.type
    d = event.data
    ts = f"[dim]{event.ts[:19]}[/dim] " if event.ts else ""

    if t == "thinking":
        console.print(f"{ts}[yellow]◌ thinking…[/yellow]")
    elif t == "tool_use":
        name = d.get("name", "?")
        raw = json.dumps(d.get("input", {}))
        inp = raw[:80] + ("…" if len(raw) > 80 else "")
        console.print(f"{ts}[cyan]⚙ {name}[/cyan] [dim]{inp}[/dim]")
    elif t == "tool_result":
        summary = d.get("summary", "")[:100]
        console.print(f"{ts}[dim]  → {summary}[/dim]")
    elif t == "agent_message":
        console.print(Panel(d.get("text", ""), title="[bold blue]Agent[/bold blue]", border_style="blue"))
    elif t == "ping":
        console.print(Panel(f"[bold yellow]⚡ Ping:[/bold yellow]\n{d.get('message', '')}", border_style="yellow"))
    elif t == "user_message":
        console.print(f"{ts}[green]You:[/green] {d.get('text', '')}")
    elif t == "turn_complete":
        cost = d.get("cost", 0)
        turns = d.get("turns", 0)
        dur_s = d.get("duration_ms", 0) / 1000
        console.print(
            f"{ts}[bold green]✓ Turn {turns} complete[/bold green]  "
            f"[dim]cost={_fmt_cost(cost)}  time={dur_s:.1f}s[/dim]"
        )
    elif t == "status":
        console.print(f"{ts}[dim]ℹ {d.get('text', '')}[/dim]")
    elif t in ("connected", "history"):
        pass  # silently skip initial handshake noise
    else:
        console.print(f"{ts}[dim]{t}[/dim] {json.dumps(d)[:100]}")


# ── Analytics & Summary ───────────────────────────────────────────────────────

@main.command("analytics")
@click.argument("agent_id")
@click.pass_context
def analytics(ctx, agent_id):
    """Show turn-by-turn analytics for an agent run."""
    client = _client(ctx)
    try:
        data = client.get_analytics(agent_id)
    except (ServerNotRunningError, AgentNotFoundError) as e:
        _handle_err(e)
    console.print_json(json.dumps(data, indent=2))


@main.command("summary")
@click.argument("agent_id")
@click.pass_context
def summary(ctx, agent_id):
    """Get the AI-written summary of what an agent did."""
    client = _client(ctx)
    try:
        with console.status("Fetching summary…"):
            data = client.get_summary(agent_id)
    except (ServerNotRunningError, AgentNotFoundError) as e:
        _handle_err(e)

    state = data.get("state")
    if state == "generating":
        console.print("[yellow]Summary is being generated – try again in a moment.[/yellow]")
        return
    if state == "error":
        console.print(f"[red]Summary error:[/red] {data.get('error', 'unknown error')}")
        return

    s = data.get("summary", data)
    if isinstance(s, dict):
        console.print(Panel(s.get("overall", ""), title="[bold]Summary[/bold]", border_style="blue"))
        for i, phase in enumerate(s.get("phases", []), 1):
            console.print(f"[bold]Phase {i}:[/bold] {phase.get('summary', '')}")
    else:
        console.print(str(s))


# ── Config ────────────────────────────────────────────────────────────────────

@main.group()
def config():
    """Manage API keys and server configuration."""
    pass


@config.command("status")
@click.pass_context
def config_status(ctx):
    """Show which API keys are configured."""
    client = _client(ctx)
    try:
        cfg = client.get_config()
    except ServerNotRunningError as e:
        _handle_err(e)

    table = Table(border_style="dim")
    table.add_column("Key")
    table.add_column("Status")
    for key, is_set in cfg.keys.items():
        table.add_row(key, "[green]● set[/green]" if is_set else "[red]○ not set[/red]")
    console.print(table)


@config.command("set")
@click.argument("assignments", nargs=-1, required=True, metavar="KEY=VALUE …")
@click.pass_context
def config_set(ctx, assignments):
    """Set API keys.

    \b
    Example:
      mobius config set ANTHROPIC_API_KEY=sk-ant-...
      mobius config set OPENROUTER_API_KEY=sk-or-...
    """
    keys = {}
    for a in assignments:
        if "=" not in a:
            console.print(f"[red]Error:[/red] Expected KEY=VALUE, got '{a}'")
            sys.exit(1)
        k, v = a.split("=", 1)
        keys[k.strip()] = v.strip()

    client = _client(ctx)
    try:
        client.set_config(**keys)
        for k in keys:
            console.print(f"[green]Set[/green] {k}")
    except ServerNotRunningError as e:
        _handle_err(e)


# ── Server start ──────────────────────────────────────────────────────────────

@main.command("start")
@click.option("--safe", is_flag=True, help="Use Modal sandbox (requires Modal setup)")
@click.pass_context
def start_server(ctx, safe):
    """Start the Mobius server (requires bun installed)."""
    root = _find_project_root()
    if not root:
        console.print(
            "[red]Error:[/red] Could not find the Mobius project root.\n"
            "Run this command from within the project directory (needs index.ts)."
        )
        sys.exit(1)

    cmd = ["bun", "run", "agent:safe" if safe else "agent"]
    console.print(f"[dim]cwd:[/dim] {root}")
    console.print(f"[dim]cmd:[/dim] {' '.join(cmd)}\n")

    try:
        subprocess.run(cmd, cwd=root)
    except FileNotFoundError:
        console.print("[red]Error:[/red] 'bun' not found. Install from https://bun.sh")
        sys.exit(1)
    except KeyboardInterrupt:
        console.print("\n[dim]Server stopped.[/dim]")
