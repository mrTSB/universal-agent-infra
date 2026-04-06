import type { ServerWebSocket } from "bun";
import * as registry from "./agent-registry.ts";
import { startRun, stopRun } from "./agent-run.ts";

const PORT = parseInt(process.env["UI_PORT"] ?? "3000");

type WSData = { agentId: string };
type WSClient = ServerWebSocket<WSData>;

// ---------------------------------------------------------------------------
// Start the multi-agent API + UI server
// ---------------------------------------------------------------------------

export function startAPIServer(): void {
  Bun.serve<WSData>({
    port: PORT,

    fetch(req, server) {
      const url = new URL(req.url);
      const { pathname, method } = Object.assign(url, { method: req.method });

      // ── WebSocket upgrade for /agents/:id ──────────────────────────────
      const agentPageMatch = pathname.match(/^\/agents\/([^/]+)$/);
      if (agentPageMatch) {
        const agentId = agentPageMatch[1];
        if (req.headers.get("upgrade") === "websocket") {
          const upgraded = server.upgrade(req, { data: { agentId } });
          if (upgraded) return undefined;
        }
        // Regular GET — serve the per-agent chat page
        const record = registry.get(agentId);
        if (!record) return new Response("Agent not found", { status: 404 });
        return html(buildAgentHTML(agentId, record.task));
      }

      // ── Dashboard ──────────────────────────────────────────────────────
      if (pathname === "/" || pathname === "/index.html") {
        return html(buildDashboardHTML());
      }

      // ── REST API ───────────────────────────────────────────────────────
      if (pathname === "/api/agents" && method === "GET") {
        return json(
          registry.list().map((r) => ({
            id: r.id,
            task: r.task,
            status: r.status,
            createdAt: r.createdAt,
            workspacePath: r.workspacePath,
            turnCount: r.turnCount,
            totalCostUsd: r.totalCostUsd,
          }))
        );
      }

      if (pathname === "/api/agents" && method === "POST") {
        return handleCreateAgent(req);
      }

      const apiAgentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (apiAgentMatch) {
        const agentId = apiAgentMatch[1];

        if (method === "GET") {
          const record = registry.get(agentId);
          if (!record) return json({ error: "Not found" }, 404);
          return json({
            id: record.id,
            task: record.task,
            status: record.status,
            createdAt: record.createdAt,
            workspacePath: record.workspacePath,
            turnCount: record.turnCount,
            totalCostUsd: record.totalCostUsd,
            lastResult: record.lastResult,
          });
        }

        if (method === "DELETE") {
          const stopped = stopRun(agentId);
          if (!stopped) return json({ error: "Not found" }, 404);
          return json({ id: agentId, stopped: true });
        }

        if (method === "POST") {
          return handleSendMessage(agentId, req);
        }
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws: WSClient) {
        const { agentId } = ws.data;
        const record = registry.get(agentId);
        if (!record) {
          ws.send(JSON.stringify({ type: "error", text: "Agent not found" }));
          ws.close();
          return;
        }
        record.wsClients.add(ws as unknown as ServerWebSocket<unknown>);
        ws.send(JSON.stringify({ type: "connected", agentId, task: record.task }));

        // Replay everything the client missed while it was away
        if (record.chatHistory.length > 0) {
          ws.send(JSON.stringify({ type: "history", messages: record.chatHistory }));
        }

        console.log(
          `[ws] Client connected to agent ${agentId.slice(0, 8)} ` +
            `(replaying ${record.chatHistory.length} events)`
        );
      },

      close(ws: WSClient) {
        const { agentId } = ws.data;
        registry.get(agentId)?.wsClients.delete(ws as unknown as ServerWebSocket<unknown>);
      },

      message(ws: WSClient, raw: string | Buffer) {
        const { agentId } = ws.data;
        const record = registry.get(agentId);
        if (!record || record.status !== "running") return;

        try {
          const msg = JSON.parse(raw.toString()) as { type: string; text?: string };
          if (msg.type === "user_message" && msg.text?.trim()) {
            const text = msg.text.trim();
            record.pendingReplies.push(text);
            record.handle?.injectMessage("ui", text);
            registry.broadcast(agentId, { type: "user_message", text });
          }
        } catch { /* ignore malformed */ }
      },
    },
  });

  console.log(`\n[api] Multi-agent server → http://localhost:${PORT}`);
  console.log(`[api] Dashboard          → http://localhost:${PORT}/`);
  console.log(`[api] API                → http://localhost:${PORT}/api/agents\n`);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleCreateAgent(req: Request): Promise<Response> {
  let task: string | undefined;
  try {
    const body = (await req.json()) as { task?: string };
    task = body.task?.trim() || undefined;
  } catch { /* body is optional */ }

  const record = await startRun({ task });

  return json(
    {
      id: record.id,
      task: record.task,
      status: record.status,
      createdAt: record.createdAt,
      url: `/agents/${record.id}`,
    },
    201
  );
}

async function handleSendMessage(agentId: string, req: Request): Promise<Response> {
  const record = registry.get(agentId);
  if (!record) return json({ error: "Not found" }, 404);
  if (record.status !== "running") return json({ error: "Agent is not running" }, 400);

  let text = "";
  try {
    const body = (await req.json()) as { text?: string };
    text = body.text?.trim() ?? "";
  } catch { /* ignore */ }

  if (!text) return json({ error: "text is required" }, 400);

  record.pendingReplies.push(text);
  record.handle?.injectMessage("ui", text);
  registry.broadcast(agentId, { type: "user_message", text });

  return json({ delivered: true });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

function buildDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Agent Runs</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0d0d0d; color: #e2e2e2;
    min-height: 100vh;
  }

  #header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 24px;
    background: #141414; border-bottom: 1px solid #1e1e1e;
  }
  #header h1 { font-size: 15px; font-weight: 600; color: #f0f0f0; }
  #header-right { display: flex; align-items: center; gap: 10px; }

  button {
    cursor: pointer; border: none; border-radius: 7px;
    font-size: 13px; font-weight: 500; font-family: inherit;
    transition: background 0.15s, opacity 0.15s;
  }
  .btn-primary { background: #1e3a8a; color: #93c5fd; padding: 8px 14px; }
  .btn-primary:hover { background: #1d4ed8; color: #fff; }
  .btn-danger  { background: #3f0000; color: #f87171; padding: 5px 10px; font-size: 12px; }
  .btn-danger:hover { background: #7f1d1d; }
  .btn-ghost { background: transparent; color: #555; padding: 5px 10px; font-size: 12px; border: 1px solid #222; }
  .btn-ghost:hover { color: #aaa; border-color: #444; }

  /* New run panel */
  #new-run-panel {
    display: none;
    background: #141414; border-bottom: 1px solid #1e1e1e;
    padding: 16px 24px;
  }
  #new-run-panel.open { display: block; }
  #new-run-panel label { font-size: 12px; color: #666; display: block; margin-bottom: 6px; }
  #task-input {
    width: 100%; background: #0d0d0d; border: 1px solid #222; border-radius: 8px;
    color: #e2e2e2; font-size: 13.5px; font-family: inherit;
    padding: 10px 13px; resize: vertical; min-height: 70px; max-height: 200px;
    outline: none; transition: border-color 0.2s;
  }
  #task-input:focus { border-color: #333; }
  #task-input::placeholder { color: #383838; }
  #new-run-actions { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }

  /* Agent list */
  #main { padding: 24px; max-width: 900px; }
  #empty-state { color: #333; font-size: 13px; padding: 40px 0; text-align: center; }

  .agent-card {
    background: #141414; border: 1px solid #1e1e1e; border-radius: 10px;
    padding: 14px 16px; margin-bottom: 10px;
    display: flex; align-items: flex-start; gap: 12px;
    transition: border-color 0.15s;
  }
  .agent-card:hover { border-color: #2a2a2a; }

  .status-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 4px;
  }
  .status-dot.running  { background: #22c55e; }
  .status-dot.starting { background: #f59e0b; animation: pulse 1s infinite; }
  .status-dot.stopped  { background: #333; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  .agent-card-body { flex: 1; min-width: 0; }
  .agent-task {
    font-size: 13.5px; color: #ccc; line-height: 1.5;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-bottom: 6px;
  }
  .agent-meta { display: flex; gap: 16px; font-size: 11.5px; color: #444; flex-wrap: wrap; }
  .agent-meta span { font-variant-numeric: tabular-nums; }
  .agent-meta .id { font-family: monospace; color: #383838; }

  .agent-card-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: flex-start; }

  a { color: inherit; text-decoration: none; }
  a:hover .agent-task { color: #e2e2e2; }
</style>
</head>
<body>

<div id="header">
  <h1>Agent Runs</h1>
  <div id="header-right">
    <span id="run-count" style="font-size:12px;color:#444;"></span>
    <button class="btn-primary" onclick="toggleNewRun()">+ New Run</button>
  </div>
</div>

<div id="new-run-panel">
  <label>Task (optional — describe what you want the agent to do)</label>
  <textarea id="task-input" placeholder="e.g. Investigate the codebase and write a summary of the architecture…"></textarea>
  <div id="new-run-actions">
    <button class="btn-ghost" onclick="toggleNewRun()">Cancel</button>
    <button class="btn-primary" onclick="createRun()">Start Agent</button>
  </div>
</div>

<div id="main">
  <div id="empty-state" style="display:none;">No agent runs yet — click "New Run" to start one.</div>
  <div id="agent-list"></div>
</div>

<script>
const agentList   = document.getElementById('agent-list');
const emptyState  = document.getElementById('empty-state');
const runCount    = document.getElementById('run-count');
const panel       = document.getElementById('new-run-panel');
const taskInput   = document.getElementById('task-input');

function toggleNewRun() {
  const open = panel.classList.toggle('open');
  if (open) taskInput.focus();
}

async function createRun() {
  const task = taskInput.value.trim();
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: task || undefined }),
  });
  if (!res.ok) { alert('Failed to create agent run'); return; }
  const data = await res.json();
  taskInput.value = '';
  panel.classList.remove('open');
  window.location.href = data.url;
}

function fmtCost(n) { return '$' + Number(n).toFixed(2); }
function fmtDate(s) {
  const d = new Date(s);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderAgents(agents) {
  if (agents.length === 0) {
    emptyState.style.display = 'block';
    agentList.innerHTML = '';
    runCount.textContent = '';
    return;
  }
  emptyState.style.display = 'none';
  const running = agents.filter(a => a.status === 'running' || a.status === 'starting').length;
  runCount.textContent = running + ' running';

  agentList.innerHTML = agents.map(a => \`
    <div class="agent-card">
      <div class="status-dot \${a.status}"></div>
      <a class="agent-card-body" href="/agents/\${a.id}">
        <div class="agent-task">\${esc(a.task)}</div>
        <div class="agent-meta">
          <span class="id">\${a.id.slice(0, 8)}</span>
          <span>Turns: \${a.turnCount}</span>
          <span>Cost: \${fmtCost(a.totalCostUsd)}</span>
          <span>\${fmtDate(a.createdAt)}</span>
        </div>
      </a>
      <div class="agent-card-actions">
        <button class="btn-ghost" onclick="window.location.href='/agents/\${a.id}'">Open</button>
        \${a.status !== 'stopped' ? \`<button class="btn-danger" onclick="stopAgent('\${a.id}',event)">Stop</button>\` : ''}
      </div>
    </div>
  \`).join('');
}

async function stopAgent(id, e) {
  e.preventDefault();
  e.stopPropagation();
  if (!confirm('Stop this agent run?')) return;
  await fetch('/api/agents/' + id, { method: 'DELETE' });
  load();
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function load() {
  const res = await fetch('/api/agents');
  if (!res.ok) return;
  const agents = await res.json();
  agents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderAgents(agents);
}

taskInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) createRun();
});

load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Per-agent chat HTML
// ---------------------------------------------------------------------------

function buildAgentHTML(agentId: string, task: string): string {
  const escapedTask = task.replace(/`/g, "\\`").replace(/\$/g, "\\$");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Agent ${agentId.slice(0, 8)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0d0d0d; color: #e2e2e2;
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }

  #header {
    display: flex; align-items: center; gap: 10px;
    padding: 11px 18px; background: #141414; border-bottom: 1px solid #1e1e1e;
    flex-shrink: 0;
  }
  #back { color: #444; font-size: 13px; text-decoration: none; flex-shrink: 0; }
  #back:hover { color: #888; }
  #header-divider { color: #2a2a2a; font-size: 13px; }
  #header-center { flex: 1; min-width: 0; }
  #agent-id-label { font-size: 11px; color: #383838; font-family: monospace; }
  #task-label {
    font-size: 13px; color: #888; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
    max-width: 500px;
  }
  #status-dot {
    width: 7px; height: 7px; border-radius: 50%; background: #333;
    flex-shrink: 0; transition: background 0.3s;
  }
  #status-dot.connected { background: #22c55e; }
  #status-dot.busy { background: #f59e0b; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }

  #header-right { display: flex; align-items: center; gap: 16px; font-size: 12px; color: #555; flex-shrink: 0; }
  #header-right .stat-val { color: #888; font-weight: 500; font-variant-numeric: tabular-nums; }

  #messages {
    flex: 1; overflow-y: auto;
    padding: 20px 20px 10px; display: flex; flex-direction: column; gap: 3px;
  }
  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }

  .msg-group { display: flex; flex-direction: column; max-width: 780px; width: 100%; gap: 2px; }
  .msg-group.agent { align-self: flex-start; }
  .msg-group.user  { align-self: flex-end; align-items: flex-end; }

  .bubble {
    padding: 10px 14px; border-radius: 14px;
    font-size: 13.5px; line-height: 1.65;
    white-space: pre-wrap; word-break: break-word;
  }
  .agent .bubble {
    background: #1a1a1a; border: 1px solid #242424;
    border-bottom-left-radius: 4px; color: #ddd;
  }
  .user .bubble {
    background: #1e3a8a; border-bottom-right-radius: 4px; color: #fff;
  }

  .tools-block { padding: 3px 0; display: flex; flex-direction: column; gap: 1px; }
  .tool-item {
    display: flex; align-items: baseline; gap: 7px;
    font-size: 11.5px; font-family: "SF Mono","Fira Code","Menlo",monospace;
    color: #2e2e2e; padding: 1px 0; transition: color 0.15s;
  }
  .tool-item.active { color: #555; }
  .tool-item.done   { color: #2a2a2a; }
  .tool-icon { font-size: 10px; flex-shrink: 0; }

  .thinking-row {
    font-size: 11px; color: #2e2e2e; font-style: italic;
    font-family: "SF Mono","Fira Code",monospace; padding: 2px 0;
  }

  .ping-card {
    background: #181409; border: 1px solid #2e2410; border-radius: 10px;
    padding: 12px 16px; max-width: 700px; align-self: flex-start; margin: 6px 0;
  }
  .ping-label {
    font-size: 10.5px; color: #92650a; font-weight: 600;
    letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 6px;
  }
  .ping-text { font-size: 13.5px; color: #c9962e; line-height: 1.6; white-space: pre-wrap; }

  .status-line {
    font-size: 11px; color: #252525; text-align: center;
    padding: 8px 0; font-style: italic;
  }

  #offline-banner {
    display: none; position: fixed; top: 0; left: 0; right: 0;
    background: #450a0a; color: #fca5a5;
    text-align: center; font-size: 12px; padding: 7px; z-index: 100;
  }
  #offline-banner.show { display: block; }

  #input-area {
    padding: 12px 18px 16px; background: #141414; border-top: 1px solid #1a1a1a;
    display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0;
  }
  #input {
    flex: 1; background: #0d0d0d; border: 1px solid #1e1e1e; border-radius: 10px;
    padding: 9px 13px; color: #e2e2e2; font-size: 13.5px; font-family: inherit;
    resize: none; outline: none; max-height: 120px; min-height: 40px; line-height: 1.5;
    transition: border-color 0.2s;
  }
  #input:focus { border-color: #2e2e2e; }
  #input::placeholder { color: #333; }
  #send-btn {
    background: #1e3a8a; border: none; border-radius: 8px; color: #93c5fd;
    padding: 9px 16px; cursor: pointer; font-size: 13px; font-weight: 500;
    font-family: inherit; transition: background 0.2s; white-space: nowrap; align-self: flex-end;
  }
  #send-btn:hover { background: #1d4ed8; color: #fff; }
</style>
</head>
<body>

<div id="offline-banner">Disconnected — reconnecting&hellip;</div>

<div id="header">
  <a id="back" href="/">← Runs</a>
  <span id="header-divider">/</span>
  <div id="header-center">
    <div id="agent-id-label">${agentId.slice(0, 8)}</div>
    <div id="task-label">${task.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
  </div>
  <div id="status-dot"></div>
  <div id="header-right">
    <span>Turns <span class="stat-val" id="stat-turns">0</span></span>
    <span>Cost <span class="stat-val" id="stat-cost">$0.00</span></span>
  </div>
</div>

<div id="messages"></div>

<div id="input-area">
  <textarea id="input" placeholder="Message the agent…" rows="1"></textarea>
  <button id="send-btn">Send</button>
</div>

<script>
const AGENT_ID    = '${agentId}';
const messagesEl  = document.getElementById('messages');
const inputEl     = document.getElementById('input');
const sendBtn     = document.getElementById('send-btn');
const statusDot   = document.getElementById('status-dot');
const statTurns   = document.getElementById('stat-turns');
const statCost    = document.getElementById('stat-cost');
const offlineBanner = document.getElementById('offline-banner');

let ws            = null;
let totalTurns    = 0;
let totalCost     = 0;
let activeGroup   = null;
let activeTools   = null;
let lastToolItem  = null;

// ── Tool label formatter ───────────────────────────────────────────────────

function trunc(s, n) {
  if (!s) return '…';
  const line = String(s).replace(/\\n/g,' ').trim();
  return line.length > n ? line.slice(0,n-1)+'…' : line;
}
function base(p) { return p ? String(p).split('/').pop() : ''; }

function fmtTool(name, inp) {
  switch(name) {
    case 'Read':    return ['📖','Read '+base(inp.file_path)];
    case 'Write':   return ['📝','Write '+base(inp.file_path)];
    case 'Edit':    return ['✏️','Edit '+base(inp.file_path)];
    case 'Bash':    return ['$', trunc(inp.description||inp.command,80)];
    case 'Grep':    return ['🔍','Grep "'+trunc(inp.pattern,40)+'"'];
    case 'Glob':    return ['🔍','Glob "'+trunc(inp.pattern,40)+'"'];
    case 'WebSearch': return ['🌐','Search "'+trunc(inp.query,50)+'"'];
    case 'WebFetch':  return ['🌐','Fetch '+trunc(inp.url,60)];
    case 'Task':    return ['🤖',trunc((inp.subagent_type||'')+' '+(inp.description||''),70)];
    case 'ping_human': return ['📢','Ping: '+trunc(inp.message,60)];
    case 'check_replies': return ['📬','Checking for replies…'];
    case 'read_software_engineering_guide': return ['📘','Read engineering guide'];
    case 'browserbase_stagehand_navigate': return ['🌐','Navigate '+trunc(inp.url,50)];
    case 'browserbase_stagehand_act':      return ['🌐',trunc(inp.action,60)];
    case 'browserbase_stagehand_extract':  return ['🌐','Extract page'];
    case 'browserbase_stagehand_observe':  return ['🌐','Observe elements'];
    case 'browserbase_screenshot':         return ['🌐','Screenshot'];
    case 'browserbase_session_create':     return ['🌐','Open browser'];
    case 'browserbase_session_close':      return ['🌐','Close browser'];
    default: return ['🔧', name];
  }
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function ensureAgentGroup() {
  if (activeGroup) return;
  activeGroup = document.createElement('div');
  activeGroup.className = 'msg-group agent';
  activeTools = null; lastToolItem = null;
  messagesEl.appendChild(activeGroup);
  scrollBottom();
}

function ensureToolsBlock() {
  ensureAgentGroup();
  if (!activeTools) {
    activeTools = document.createElement('div');
    activeTools.className = 'tools-block';
    activeGroup.appendChild(activeTools);
  }
}

function appendTool(name, inp) {
  ensureToolsBlock();
  const [icon, label] = fmtTool(name, inp||{});
  const row = document.createElement('div');
  row.className = 'tool-item active';
  row.innerHTML = '<span class="tool-icon">'+icon+'</span><span class="tool-label">'+label+'</span>';
  activeTools.appendChild(row);
  scrollBottom();
  return row;
}

function appendAgentBubble(text) {
  ensureAgentGroup();
  const bbl = document.createElement('div');
  bbl.className = 'bubble';
  bbl.textContent = text;
  activeGroup.appendChild(bbl);
  activeGroup = null; activeTools = null; lastToolItem = null;
  scrollBottom();
}

function appendUserBubble(text) {
  activeGroup = null; activeTools = null; lastToolItem = null;
  const grp = document.createElement('div');
  grp.className = 'msg-group user';
  const bbl = document.createElement('div');
  bbl.className = 'bubble';
  bbl.textContent = text;
  grp.appendChild(bbl);
  messagesEl.appendChild(grp);
  scrollBottom();
}

function appendPing(message) {
  activeGroup = null; activeTools = null; lastToolItem = null;
  const card = document.createElement('div');
  card.className = 'ping-card';
  const lbl = document.createElement('div');
  lbl.className = 'ping-label'; lbl.textContent = '🔔 Agent needs input';
  const txt = document.createElement('div');
  txt.className = 'ping-text'; txt.textContent = message;
  card.appendChild(lbl); card.appendChild(txt);
  messagesEl.appendChild(card);
  scrollBottom();
}

function appendStatus(text) {
  const el = document.createElement('div');
  el.className = 'status-line'; el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
}

// ── Message handler ────────────────────────────────────────────────────────

function handle(msg) {
  switch (msg.type) {
    case 'connected':
      statusDot.className = 'connected';
      offlineBanner.classList.remove('show');
      break;

    case 'history':
      // Replay all events that happened while we were away
      for (const m of msg.messages) handle(m);
      appendStatus('— now live —');
      break;
    case 'thinking':
      ensureAgentGroup();
      statusDot.className = 'busy';
      if (!activeGroup.querySelector('.thinking-row')) {
        const t = document.createElement('div');
        t.className = 'thinking-row'; t.textContent = '💭 thinking…';
        if (activeTools) activeGroup.insertBefore(t, activeTools);
        else activeGroup.appendChild(t);
      }
      break;
    case 'tool_use':
      statusDot.className = 'busy';
      lastToolItem = appendTool(msg.name, msg.input);
      break;
    case 'tool_result':
      if (lastToolItem) {
        lastToolItem.classList.remove('active');
        lastToolItem.classList.add('done');
        lastToolItem = null;
      }
      break;
    case 'tool_progress':
      if (lastToolItem) {
        const lbl = lastToolItem.querySelector('.tool-label');
        if (lbl) {
          if (!lbl.dataset.base) lbl.dataset.base = lbl.textContent;
          lbl.textContent = lbl.dataset.base+' ('+Number(msg.elapsed).toFixed(1)+'s)';
        }
      }
      break;
    case 'agent_message':
      appendAgentBubble(msg.text);
      statusDot.className = 'connected';
      break;
    case 'user_message':
      appendUserBubble(msg.text);
      break;
    case 'ping':
      appendPing(msg.message);
      break;
    case 'turn_complete':
      totalTurns++;
      totalCost += msg.cost || 0;
      statTurns.textContent = totalTurns;
      statCost.textContent  = '$'+totalCost.toFixed(2);
      statusDot.className   = 'connected';
      break;
    case 'status':
      appendStatus(msg.text);
      if (msg.text === 'Agent stopped') statusDot.className = '';
      break;
    case 'error':
      appendStatus('Error: ' + msg.text);
      break;
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/agents/' + AGENT_ID);
  ws.onopen  = () => { statusDot.className = 'connected'; offlineBanner.classList.remove('show'); };
  ws.onclose = () => { statusDot.className = ''; offlineBanner.classList.add('show'); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch {} };
}

// ── Input ──────────────────────────────────────────────────────────────────

function send() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'user_message', text }));
  inputEl.value = '';
  inputEl.style.height = 'auto';
  inputEl.focus();
}

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

connect();
</script>
</body>
</html>`;
}
