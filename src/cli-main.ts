#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Aeon CLI — manage agents and custom tools from the terminal
// Usage: bun run cli <command> [args]
// ---------------------------------------------------------------------------

const BASE = process.env["AEON_SERVER"] ?? "http://localhost:3000";

async function req(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    die(`Cannot connect to Aeon server at ${BASE}.\nRun: bun run agent`);
  }
  const text = await res!.text();
  if (!res!.ok) {
    let msg = text;
    try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* raw text */ }
    die(`Server error ${res!.status}: ${msg}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

// ── Colour helpers ────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  bold:   "\x1b[1m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  blue:   "\x1b[34m",
};
const c = (col: string, s: string) => `${col}${s}${C.reset}`;

function die(msg: string): never {
  console.error(c(C.red, "Error:") + " " + msg);
  process.exit(1);
}

function fmtCost(n: number): string { return n ? `$${n.toFixed(4)}` : "-"; }
function fmtTs(s: string): string {
  if (!s) return "-";
  try { return new Date(s).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return s.slice(0, 16); }
}
function fmtStatus(s: string): string {
  const col = { running: C.green, starting: C.yellow, stopped: C.red }[s] ?? C.dim;
  return c(col, s);
}

// ── Commands ──────────────────────────────────────────────────────────────────

const commands: Record<string, (args: string[]) => Promise<void>> = {

  // -- agents ----------------------------------------------------------------

  async list() {
    const agents = (await req("GET", "/api/agents")) as Agent[];
    if (!agents.length) { console.log(c(C.dim, "No agents.")); return; }
    const rows = agents.map(a => [
      c(C.cyan, a.id.slice(0, 8)),
      fmtStatus(a.status),
      String(a.turnCount || "-"),
      fmtCost(a.totalCostUsd),
      fmtTs(a.createdAt),
      a.task.slice(0, 55) + (a.task.length > 55 ? "…" : ""),
    ]);
    printTable(["ID", "Status", "Turns", "Cost", "Created", "Task"], rows);
  },

  async create([task]) {
    if (!task) die("Usage: cli create <task description>");
    const agent = (await req("POST", "/api/agents", { task })) as Agent;
    console.log(c(C.bold + C.green, "Agent created"));
    console.log(`  ${c(C.dim, "id:")}   ${agent.id}`);
    console.log(`  ${c(C.dim, "task:")} ${agent.task}`);
    console.log(`  ${c(C.dim, "url:")}  ${BASE}/agents/${agent.id}`);
  },

  async get([id]) {
    if (!id) die("Usage: cli get <agent-id>");
    const a = (await req("GET", `/api/agents/${id}`)) as Agent;
    console.log(`${c(C.dim, "id:")}        ${a.id}`);
    console.log(`${c(C.dim, "task:")}      ${a.task}`);
    console.log(`${c(C.dim, "status:")}    ${fmtStatus(a.status)}`);
    console.log(`${c(C.dim, "turns:")}     ${a.turnCount ?? "-"}`);
    console.log(`${c(C.dim, "cost:")}      ${fmtCost(a.totalCostUsd)}`);
    console.log(`${c(C.dim, "created:")}   ${fmtTs(a.createdAt)}`);
    console.log(`${c(C.dim, "workspace:")} ${a.workspacePath ?? "-"}`);
  },

  async stop([id]) {
    if (!id) die("Usage: cli stop <agent-id>");
    await req("DELETE", `/api/agents/${id}`);
    console.log(c(C.green, "Stopped") + ` agent ${id.slice(0, 8)}`);
  },

  async send([id, ...rest]) {
    if (!id || !rest.length) die("Usage: cli send <agent-id> <message>");
    await req("POST", `/api/agents/${id}`, { message: rest.join(" ") });
    console.log(c(C.green, "Sent") + ` message to ${id.slice(0, 8)}`);
  },

  async watch([id]) {
    if (!id) die("Usage: cli watch <agent-id>");
    const agent = (await req("GET", `/api/agents/${id}`)) as Agent;
    console.log(c(C.bold, "Watching") + ` ${id.slice(0, 8)}: ${agent.task}`);
    console.log(c(C.dim, "Ctrl+C to stop\n"));

    const wsUrl = BASE.replace("https://", "wss://").replace("http://", "ws://");
    const ws = new WebSocket(`${wsUrl}/agents/${id}`);

    ws.onmessage = (e) => {
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(e.data as string) as Record<string, unknown>; } catch { return; }
      const ts = ev["ts"] ? c(C.dim, new Date(ev["ts"] as number).toLocaleTimeString() + " ") : "";
      switch (ev["type"]) {
        case "thinking":     console.log(`${ts}${c(C.yellow, "◌ thinking…")}`); break;
        case "tool_use":     console.log(`${ts}${c(C.cyan, `⚙ ${ev["name"]}`)} ${c(C.dim, JSON.stringify(ev["input"]).slice(0, 80))}`); break;
        case "tool_result":  console.log(`${ts}${c(C.dim, `  → ${String(ev["summary"] ?? "").slice(0, 100)}`)}`); break;
        case "agent_message": {
          const text = String(ev["text"] ?? "");
          console.log(`\n${c(C.blue + C.bold, "Agent:")} ${text}\n`);
          break;
        }
        case "ping":         console.log(`\n${c(C.yellow + C.bold, "⚡ Ping:")} ${ev["message"]}\n`); break;
        case "user_message": console.log(`${ts}${c(C.green, "You:")} ${ev["text"]}`); break;
        case "turn_complete":
          console.log(`${ts}${c(C.green + C.bold, `✓ Turn ${ev["turns"]} done`)} ${c(C.dim, `cost=${fmtCost(ev["cost"] as number)} time=${((ev["duration_ms"] as number) / 1000).toFixed(1)}s`)}`);
          break;
        case "status":       console.log(`${ts}${c(C.dim, `ℹ ${ev["text"]}`)}`); break;
        case "connected":
        case "history":      break;
        default:             console.log(`${ts}${c(C.dim, String(ev["type"]))} ${JSON.stringify(ev).slice(0, 100)}`);
      }
    };

    ws.onclose = () => console.log(c(C.dim, "\nDisconnected."));
    ws.onerror = () => die("WebSocket error");

    // Keep alive
    await new Promise(() => {});
  },

  async analytics([id]) {
    if (!id) die("Usage: cli analytics <agent-id>");
    console.log(JSON.stringify(await req("GET", `/api/agents/${id}/analytics`), null, 2));
  },

  async summary([id]) {
    if (!id) die("Usage: cli summary <agent-id>");
    const data = (await req("GET", `/api/agents/${id}/ai-summary`)) as Record<string, unknown>;
    if (data["state"] === "generating") { console.log(c(C.yellow, "Generating — try again shortly.")); return; }
    const s = data["summary"] as Record<string, unknown> | undefined;
    if (s?.["overall"]) {
      console.log(c(C.bold, "Summary:"), s["overall"]);
      const phases = s["phases"] as Array<{ summary: string }> | undefined;
      phases?.forEach((p, i) => console.log(`  ${c(C.dim, `Phase ${i + 1}:`)} ${p.summary}`));
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  },

  // -- config ----------------------------------------------------------------

  async "config:status"() {
    const cfg = (await req("GET", "/api/config")) as { keys: Record<string, boolean> };
    for (const [k, set] of Object.entries(cfg.keys)) {
      console.log(`  ${k}: ${set ? c(C.green, "● set") : c(C.red, "○ not set")}`);
    }
  },

  async "config:set"(pairs) {
    const body: Record<string, string> = {};
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq < 1) die(`Invalid format '${pair}'. Expected KEY=VALUE`);
      body[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    await req("POST", "/api/config", body);
    for (const k of Object.keys(body)) console.log(`${c(C.green, "Set")} ${k}`);
  },

  // -- tools -----------------------------------------------------------------

  async "tools:list"() {
    const tools = (await req("GET", "/api/tools")) as CustomTool[];
    if (!tools.length) { console.log(c(C.dim, "No custom tools.")); return; }
    const rows = tools.map(t => [
      c(C.cyan, t.name),
      t.executor.type === "http"
        ? c(C.blue, `http ${t.executor.method ?? "POST"}`)
        : c(C.yellow, "shell"),
      t.enabled ? c(C.green, "enabled") : c(C.dim, "disabled"),
      t.description.slice(0, 60) + (t.description.length > 60 ? "…" : ""),
    ]);
    printTable(["Name", "Executor", "Status", "Description"], rows);
  },

  async "tools:get"([id]) {
    if (!id) die("Usage: cli tools:get <tool-id>");
    const t = (await req("GET", `/api/tools/${id}`)) as CustomTool;
    console.log(JSON.stringify(t, null, 2));
  },

  async "tools:create"([file]) {
    if (!file) die("Usage: cli tools:create <tool.json>\n\nJSON schema:\n" + TOOL_SCHEMA_HINT);
    const raw = await Bun.file(file).text();
    let body: unknown;
    try { body = JSON.parse(raw); } catch { die("Invalid JSON in file"); }
    const t = (await req("POST", "/api/tools", body)) as CustomTool;
    console.log(c(C.green, "Created") + ` tool ${c(C.cyan, t.name)} (${t.id.slice(0, 8)})`);
  },

  async "tools:edit"([id, file]) {
    if (!id || !file) die("Usage: cli tools:edit <tool-id> <tool.json>");
    const raw = await Bun.file(file).text();
    let body: unknown;
    try { body = JSON.parse(raw); } catch { die("Invalid JSON in file"); }
    const t = (await req("PUT", `/api/tools/${id}`, body)) as CustomTool;
    console.log(c(C.green, "Updated") + ` tool ${c(C.cyan, t.name)}`);
  },

  async "tools:delete"([id]) {
    if (!id) die("Usage: cli tools:delete <tool-id>");
    await req("DELETE", `/api/tools/${id}`);
    console.log(c(C.green, "Deleted") + ` tool ${id.slice(0, 8)}`);
  },

  async "tools:toggle"([id]) {
    if (!id) die("Usage: cli tools:toggle <tool-id>");
    const t = (await req("POST", `/api/tools/${id}/toggle`)) as CustomTool;
    console.log(`Tool ${c(C.cyan, t.name)}: ${t.enabled ? c(C.green, "enabled") : c(C.dim, "disabled")}`);
  },
};

// ── Types (minimal) ──────────────────────────────────────────────────────────

type Agent = {
  id: string; task: string; status: string; createdAt: string;
  workspacePath?: string; turnCount?: number; totalCostUsd?: number;
};

type CustomTool = {
  id: string; name: string; description: string; enabled: boolean;
  executor: { type: string; method?: string; url?: string; command?: string };
};

// ── Table printer ─────────────────────────────────────────────────────────────

function printTable(headers: string[], rows: string[][]): void {
  const cols = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => stripAnsi(r[i] ?? "").length))
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
  const sep = widths.map(w => "─".repeat(w)).join("─ ");
  console.log(c(C.dim, headers.map((h, i) => pad(h, widths[i])).join("  ")));
  console.log(c(C.dim, sep));
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell, widths[i])).join("  "));
  }
}

function stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }

// ── Tool schema hint ──────────────────────────────────────────────────────────

const TOOL_SCHEMA_HINT = `
{
  "name": "search_db",
  "description": "Search the internal database",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" }
    },
    "required": ["query"]
  },
  "executor": {
    "type": "http",              // or "shell"
    "url": "http://localhost:8080/search",
    "method": "POST"
    // shell: "command": "python search.py --q '{{query}}'"
  },
  "enabled": true
}`;

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${c(C.bold, "Aeon CLI")} — manage agents and tools
${c(C.dim, "Set AEON_SERVER=http://... to point at a remote instance")}

${c(C.bold, "Agents")}
  ${c(C.cyan, "list")}                         List all agents
  ${c(C.cyan, "create")} <task>                Spawn a new agent
  ${c(C.cyan, "get")} <id>                     Show agent details
  ${c(C.cyan, "stop")} <id>                    Stop a running agent
  ${c(C.cyan, "send")} <id> <message>          Send a message to an agent
  ${c(C.cyan, "watch")} <id>                   Stream live events (Ctrl+C to exit)
  ${c(C.cyan, "analytics")} <id>               Turn-by-turn analytics (JSON)
  ${c(C.cyan, "summary")} <id>                 AI-written run summary

${c(C.bold, "Config")}
  ${c(C.cyan, "config:status")}                Show which API keys are set
  ${c(C.cyan, "config:set")} KEY=VAL ...       Persist API keys

${c(C.bold, "Tools")}
  ${c(C.cyan, "tools:list")}                   List all custom tools
  ${c(C.cyan, "tools:get")} <id>               Show full tool definition (JSON)
  ${c(C.cyan, "tools:create")} <tool.json>     Create a tool from a JSON file
  ${c(C.cyan, "tools:edit")} <id> <tool.json>  Replace a tool definition
  ${c(C.cyan, "tools:delete")} <id>            Delete a tool
  ${c(C.cyan, "tools:toggle")} <id>            Enable/disable a tool
`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const [, , cmd, ...args] = process.argv;

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(0);
}

const handler = commands[cmd];
if (!handler) {
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

handler(args).catch((err: unknown) => {
  console.error(c(C.red, "Fatal:"), err instanceof Error ? err.message : String(err));
  process.exit(1);
});
