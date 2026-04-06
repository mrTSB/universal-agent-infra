import type { ServerWebSocket } from "bun";
import { injectMessage, type SDKMessage } from "./agent.ts";
import { logUserMessage } from "./logging.ts";
import { setPingHuman, setCheckReplies } from "./tools.ts";

const PORT = parseInt(process.env["UI_PORT"] ?? "3000");

// ---------------------------------------------------------------------------
// WebSocket client registry
// ---------------------------------------------------------------------------

type WSClient = ServerWebSocket<unknown>;
const clients = new Set<WSClient>();

function broadcast(data: unknown): void {
  const json = JSON.stringify(data);
  for (const ws of clients) {
    try {
      ws.send(json);
    } catch {
      /* ignore closed sockets */
    }
  }
}

// ---------------------------------------------------------------------------
// Pending user inputs — available for the agent's check_replies tool
// ---------------------------------------------------------------------------

const pendingReplies: string[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type UIHandlers = {
  postMessage: (text: string) => Promise<void>;
  broadcastEvent: (event: SDKMessage) => void;
};

export async function startUIServer(): Promise<UIHandlers> {
  // Wire ping_human tool → show in the local UI
  setPingHuman(async (message: string) => {
    console.log(`[ui] ping_human: ${message.slice(0, 80)}`);
    broadcast({ type: "ping", message });
  });

  // Wire check_replies tool → drain pending user inputs
  setCheckReplies(async () => {
    const replies = pendingReplies.splice(0);
    return replies;
  });

  const html = buildHTML();

  Bun.serve({
    port: PORT,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
    websocket: {
      open(ws: WSClient) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "connected" }));
        console.log(`[ui] Client connected (${clients.size} active)`);
      },
      close(ws: WSClient) {
        clients.delete(ws);
        console.log(`[ui] Client disconnected (${clients.size} remaining)`);
      },
      message(_ws: WSClient, raw: string | Buffer) {
        try {
          const msg = JSON.parse(raw.toString()) as { type: string; text?: string };
          if (msg.type === "user_message" && msg.text?.trim()) {
            const text = msg.text.trim();
            logUserMessage(text);
            pendingReplies.push(text);
            injectMessage("cli", text);
            broadcast({ type: "user_message", text });
          }
        } catch {
          /* ignore malformed messages */
        }
      },
    },
  });

  console.log(`\n[ui] Agent UI → http://localhost:${PORT}\n`);

  return {
    postMessage: async (text: string) => {
      broadcast({ type: "agent_message", text });
    },
    broadcastEvent: (event: SDKMessage) => {
      broadcastSDKEvent(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Convert SDK events → UI messages
// ---------------------------------------------------------------------------

function broadcastSDKEvent(event: SDKMessage): void {
  switch (event.type) {
    case "assistant": {
      for (const block of event.message.content) {
        if (block.type === "thinking") {
          broadcast({ type: "thinking" });
        } else if (block.type === "tool_use") {
          const input = (
            typeof block.input === "object" && block.input !== null ? block.input : {}
          ) as Record<string, unknown>;
          broadcast({ type: "tool_use", name: block.name, input });
        }
      }
      break;
    }
    case "tool_use_summary":
      broadcast({ type: "tool_result", summary: event.summary });
      break;
    case "tool_progress":
      broadcast({
        type: "tool_progress",
        tool: event.tool_name,
        elapsed: event.elapsed_time_seconds,
      });
      break;
    case "result":
      broadcast({
        type: "turn_complete",
        cost: "total_cost_usd" in event ? (event.total_cost_usd as number) : 0,
        turns: "num_turns" in event ? (event.num_turns as number) : 0,
      });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Frontend HTML — served at /
// ---------------------------------------------------------------------------

function buildHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Agent</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0d0d0d;
    color: #e2e2e2;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header ── */
  #header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: #141414;
    border-bottom: 1px solid #222;
    flex-shrink: 0;
    gap: 12px;
  }
  #header-left { display: flex; align-items: center; gap: 10px; }
  #header h1 { font-size: 14px; font-weight: 600; color: #f0f0f0; letter-spacing: -0.1px; }
  #status-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #333; flex-shrink: 0;
    transition: background 0.3s;
  }
  #status-dot.connected { background: #22c55e; }
  #status-dot.busy { background: #f59e0b; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }

  #header-right {
    display: flex; align-items: center; gap: 20px;
    font-size: 12px; color: #555;
    font-variant-numeric: tabular-nums;
  }
  #header-right .stat { display: flex; align-items: center; gap: 5px; }
  #header-right .stat-val { color: #888; font-weight: 500; }

  /* ── Messages ── */
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 24px 20px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

  /* ── Message groups ── */
  .msg-group { display: flex; flex-direction: column; max-width: 760px; width: 100%; gap: 2px; }
  .msg-group.agent { align-self: flex-start; }
  .msg-group.user  { align-self: flex-end; align-items: flex-end; }

  /* ── Bubbles ── */
  .bubble {
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 13.5px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .agent .bubble {
    background: #1a1a1a;
    border: 1px solid #252525;
    border-bottom-left-radius: 4px;
    color: #ddd;
  }
  .user .bubble {
    background: #1e40af;
    border-bottom-right-radius: 4px;
    color: #fff;
  }

  /* ── Tool activity ── */
  .tools-block {
    padding: 4px 2px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .tool-item {
    display: flex;
    align-items: baseline;
    gap: 7px;
    font-size: 11.5px;
    font-family: "SF Mono", "Fira Code", "Menlo", monospace;
    color: #3a3a3a;
    padding: 1px 0;
    transition: color 0.15s;
  }
  .tool-item.active { color: #666; }
  .tool-item.done   { color: #333; }
  .tool-icon { font-size: 10px; flex-shrink: 0; }
  .tool-label { flex: 1; }

  /* ── Thinking ── */
  .thinking-row {
    font-size: 11px;
    color: #333;
    font-style: italic;
    padding: 2px 2px;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  /* ── Ping card ── */
  .ping-card {
    background: #181409;
    border: 1px solid #2e2410;
    border-radius: 10px;
    padding: 12px 16px;
    max-width: 680px;
    align-self: flex-start;
    margin: 6px 0;
  }
  .ping-label {
    font-size: 10.5px;
    color: #92650a;
    font-weight: 600;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    margin-bottom: 7px;
  }
  .ping-text {
    font-size: 13.5px;
    color: #c9962e;
    line-height: 1.6;
    white-space: pre-wrap;
  }

  /* ── Status line ── */
  .status-line {
    font-size: 11px;
    color: #2a2a2a;
    text-align: center;
    padding: 8px 0;
    font-style: italic;
  }

  /* ── Offline banner ── */
  #offline-banner {
    display: none;
    position: fixed; top: 0; left: 0; right: 0;
    background: #450a0a; color: #fca5a5;
    text-align: center; font-size: 12px; padding: 7px;
    z-index: 100; border-bottom: 1px solid #7f1d1d;
  }
  #offline-banner.show { display: block; }

  /* ── Input area ── */
  #input-area {
    padding: 12px 20px 16px;
    background: #141414;
    border-top: 1px solid #1e1e1e;
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-shrink: 0;
  }
  #input {
    flex: 1;
    background: #0d0d0d;
    border: 1px solid #222;
    border-radius: 10px;
    padding: 9px 13px;
    color: #e2e2e2;
    font-size: 13.5px;
    font-family: inherit;
    resize: none;
    outline: none;
    max-height: 120px;
    min-height: 40px;
    line-height: 1.5;
    transition: border-color 0.2s;
  }
  #input:focus { border-color: #333; }
  #input::placeholder { color: #383838; }
  #send-btn {
    background: #1e3a8a;
    border: none;
    border-radius: 8px;
    color: #93c5fd;
    padding: 9px 16px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background 0.2s, opacity 0.2s;
    white-space: nowrap;
    align-self: flex-end;
    letter-spacing: 0.1px;
  }
  #send-btn:hover { background: #1d4ed8; color: #fff; }
  #send-btn:disabled { opacity: 0.35; cursor: not-allowed; }
</style>
</head>
<body>

<div id="offline-banner">Agent disconnected — reconnecting&hellip;</div>

<div id="header">
  <div id="header-left">
    <div id="status-dot"></div>
    <h1>Agent</h1>
  </div>
  <div id="header-right">
    <div class="stat">Turns <span class="stat-val" id="stat-turns">0</span></div>
    <div class="stat">Cost <span class="stat-val" id="stat-cost">$0.00</span></div>
  </div>
</div>

<div id="messages"></div>

<div id="input-area">
  <textarea id="input" placeholder="Message the agent…" rows="1"></textarea>
  <button id="send-btn">Send</button>
</div>

<script>
const messagesEl = document.getElementById('messages');
const inputEl    = document.getElementById('input');
const sendBtn    = document.getElementById('send-btn');
const statusDot  = document.getElementById('status-dot');
const statTurns  = document.getElementById('stat-turns');
const statCost   = document.getElementById('stat-cost');
const offlineBanner = document.getElementById('offline-banner');

let ws             = null;
let totalTurns     = 0;
let totalCost      = 0;
let activeGroup    = null;   // current agent msg-group div
let activeTools    = null;   // current tools-block div inside activeGroup
let lastToolItem   = null;   // most recent tool-item (for progress updates)

// ── Tool label formatter ────────────────────────────────────────────────────

function trunc(s, n) {
  if (!s) return '…';
  const line = String(s).replace(/\\n/g, ' ').trim();
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}
function base(p) { return p ? String(p).split('/').pop() : ''; }

function fmtTool(name, inp) {
  switch (name) {
    case 'Read':    return ['📖', 'Read ' + base(inp.file_path)];
    case 'Write':   return ['📝', 'Write ' + base(inp.file_path)];
    case 'Edit':    return ['✏️',  'Edit ' + base(inp.file_path)];
    case 'Bash':    return ['$',  trunc(inp.description || inp.command, 80)];
    case 'Grep':    return ['🔍', 'Grep "' + trunc(inp.pattern, 40) + '"'];
    case 'Glob':    return ['🔍', 'Glob "' + trunc(inp.pattern, 40) + '"'];
    case 'WebSearch': return ['🌐', 'Search "' + trunc(inp.query, 50) + '"'];
    case 'WebFetch':  return ['🌐', 'Fetch ' + trunc(inp.url, 60)];
    case 'Task':      return ['🤖', trunc((inp.subagent_type || '') + ' ' + (inp.description || ''), 70)];
    case 'ping_human': return ['📢', 'Ping: ' + trunc(inp.message, 60)];
    case 'check_replies': return ['📬', 'Checking for replies…'];
    case 'read_software_engineering_guide': return ['📘', 'Read engineering guide'];
    case 'browserbase_stagehand_navigate': return ['🌐', 'Navigate ' + trunc(inp.url, 50)];
    case 'browserbase_stagehand_act':      return ['🌐', trunc(inp.action, 60)];
    case 'browserbase_stagehand_extract':  return ['🌐', 'Extract page'];
    case 'browserbase_stagehand_observe':  return ['🌐', 'Observe elements'];
    case 'browserbase_screenshot':         return ['🌐', 'Screenshot'];
    case 'browserbase_session_create':     return ['🌐', 'Open browser'];
    case 'browserbase_session_close':      return ['🌐', 'Close browser'];
    default: return ['🔧', name];
  }
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function ensureAgentGroup() {
  if (activeGroup) return;
  activeGroup = document.createElement('div');
  activeGroup.className = 'msg-group agent';
  activeTools = null;
  lastToolItem = null;
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
  const [icon, label] = fmtTool(name, inp || {});
  const row = document.createElement('div');
  row.className = 'tool-item active';
  row.innerHTML =
    '<span class="tool-icon">' + icon + '</span>' +
    '<span class="tool-label">' + label + '</span>';
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
  // Close this group — next content starts a new one
  activeGroup   = null;
  activeTools   = null;
  lastToolItem  = null;
  scrollBottom();
}

function appendUserBubble(text) {
  activeGroup  = null;
  activeTools  = null;
  lastToolItem = null;
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
  activeGroup  = null;
  activeTools  = null;
  lastToolItem = null;
  const card = document.createElement('div');
  card.className = 'ping-card';
  const lbl = document.createElement('div');
  lbl.className = 'ping-label';
  lbl.textContent = '🔔 Agent needs input';
  const txt = document.createElement('div');
  txt.className = 'ping-text';
  txt.textContent = message;
  card.appendChild(lbl);
  card.appendChild(txt);
  messagesEl.appendChild(card);
  scrollBottom();
}

function appendStatus(text) {
  const el = document.createElement('div');
  el.className = 'status-line';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
}

// ── Message handler ──────────────────────────────────────────────────────────

function handle(msg) {
  switch (msg.type) {

    case 'connected':
      statusDot.className = 'connected';
      offlineBanner.classList.remove('show');
      appendStatus('Connected to agent');
      break;

    case 'thinking':
      ensureAgentGroup();
      statusDot.className = 'busy';
      if (!activeGroup.querySelector('.thinking-row')) {
        const t = document.createElement('div');
        t.className = 'thinking-row';
        t.textContent = '💭 thinking…';
        activeGroup.insertBefore(t, activeTools);
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
          lbl.textContent = lbl.dataset.base + ' (' + Number(msg.elapsed).toFixed(1) + 's)';
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
      statCost.textContent  = '$' + totalCost.toFixed(2);
      statusDot.className   = 'connected';
      break;
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);

  ws.onopen  = () => { statusDot.className = 'connected'; offlineBanner.classList.remove('show'); };
  ws.onclose = () => { statusDot.className = ''; offlineBanner.classList.add('show'); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch {} };
}

// ── Input ────────────────────────────────────────────────────────────────────

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
