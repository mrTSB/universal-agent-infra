import type { ServerWebSocket } from "bun";
import { statSync } from "fs";
import { join } from "path";
import * as registry from "./agent-registry.ts";
import { startRun, stopRun } from "./agent-run.ts";
import * as aiSummary from "./ai-summary.ts";
import * as config from "./config.ts";
import * as toolRegistry from "./tool-registry.ts";

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

      // ── Analytics page ─────────────────────────────────────────────────
      const analyticsPageMatch = pathname.match(/^\/agents\/([^/]+)\/analytics$/);
      if (analyticsPageMatch) {
        const agentId = analyticsPageMatch[1];
        const record = registry.get(agentId);
        if (!record) return new Response("Agent not found", { status: 404 });
        return html(buildAnalyticsHTML(agentId, record.task));
      }

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

      // ── Tools page ─────────────────────────────────────────────────────
      if (pathname === "/tools") {
        return html(buildToolsHTML());
      }

      // ── REST API ───────────────────────────────────────────────────────
      if (pathname === "/api/config" && method === "GET") {
        return json({ keys: config.status() });
      }

      if (pathname === "/api/config" && method === "POST") {
        return handleSaveConfig(req);
      }

      // ── Tools API ──────────────────────────────────────────────────────
      if (pathname === "/api/tools" && method === "GET") {
        return json(toolRegistry.list());
      }

      if (pathname === "/api/tools" && method === "POST") {
        return handleCreateTool(req);
      }

      const toolMatch = pathname.match(/^\/api\/tools\/([^/]+)$/);
      if (toolMatch) {
        const toolId = toolMatch[1];
        if (method === "GET") {
          const t = toolRegistry.get(toolId);
          return t ? json(t) : json({ error: "Not found" }, 404);
        }
        if (method === "PUT") return handleUpdateTool(toolId, req);
        if (method === "DELETE") {
          const removed = toolRegistry.remove(toolId);
          return removed ? json({ deleted: true }) : json({ error: "Not found" }, 404);
        }
      }

      const toolToggleMatch = pathname.match(/^\/api\/tools\/([^/]+)\/toggle$/);
      if (toolToggleMatch && method === "POST") {
        const toolId = toolToggleMatch[1];
        const t = toolRegistry.get(toolId);
        if (!t) return json({ error: "Not found" }, 404);
        const updated = toolRegistry.update(toolId, { enabled: !t.enabled });
        return json(updated);
      }

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

      const apiAgentAnalyticsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/analytics$/);
      if (apiAgentAnalyticsMatch && method === "GET") {
        const agentId = apiAgentAnalyticsMatch[1];
        const record = registry.get(agentId);
        if (!record) return json({ error: "Not found" }, 404);
        return json(computeAnalytics(record));
      }

      const apiAISummaryMatch = pathname.match(/^\/api\/agents\/([^/]+)\/ai-summary$/);
      if (apiAISummaryMatch && method === "GET") {
        const agentId = apiAISummaryMatch[1];
        const record = registry.get(agentId);
        if (!record) return json({ error: "Not found" }, 404);
        if (!aiSummary.isAvailable()) {
          return json({ status: "unavailable", message: "OPENROUTER_API_KEY not set" });
        }
        const cached = aiSummary.getCached(agentId);
        if (cached) return json(cached);
        // Not cached — compute analytics and kick off generation
        const data = computeAnalytics(record);
        aiSummary.requestSummary(agentId, data);
        return json({ status: "generating" });
      }

      // Regenerate AI summary (DELETE to bust cache, then GET again)
      if (apiAISummaryMatch && method === "DELETE") {
        const agentId = apiAISummaryMatch[1];
        aiSummary.invalidate(agentId);
        return json({ invalidated: true });
      }

      // Artifacts — files created/modified in the agent workspace
      const artifactsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/artifacts$/);
      if (artifactsMatch && method === "GET") {
        const agentId = artifactsMatch[1];
        const record = registry.get(agentId);
        if (!record) return json({ error: "Not found" }, 404);
        return handleGetArtifacts(record.workspacePath);
      }

      // Resume a stopped agent (reuses its workspace + last state.json checkpoint)
      const resumeMatch = pathname.match(/^\/api\/agents\/([^/]+)\/resume$/);
      if (resumeMatch && method === "POST") {
        const agentId = resumeMatch[1];
        const stopped = registry.get(agentId);
        if (!stopped) return json({ error: "Not found" }, 404);
        if (stopped.status === "running") return json({ error: "Agent is already running" }, 400);
        const record = await startRun({ task: stopped.task, resumeId: agentId });
        return json({ id: record.id, status: record.status, resumed: true });
      }

      // Replay a run — same task but fresh workspace and state
      const replayMatch = pathname.match(/^\/api\/agents\/([^/]+)\/replay$/);
      if (replayMatch && method === "POST") {
        const agentId = replayMatch[1];
        const original = registry.get(agentId);
        if (!original) return json({ error: "Not found" }, 404);
        const record = await startRun({ task: original.task });
        return json({ id: record.id, status: record.status, replayed: true, originalId: agentId });
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
            registry.broadcast(agentId, { type: "user_message", text, ts: Date.now() });
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

async function handleSaveConfig(req: Request): Promise<Response> {
  let body: Record<string, string>;
  try {
    body = (await req.json()) as Record<string, string>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const patch: Partial<Record<"ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY", string>> = {};
  if (typeof body["ANTHROPIC_API_KEY"]  === "string") patch["ANTHROPIC_API_KEY"]  = body["ANTHROPIC_API_KEY"];
  if (typeof body["OPENROUTER_API_KEY"] === "string") patch["OPENROUTER_API_KEY"] = body["OPENROUTER_API_KEY"];

  try {
    config.save(patch);
    return json({ ok: true, keys: config.status() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
}

async function handleCreateAgent(req: Request): Promise<Response> {
  if (!config.status().ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY is not set. Open Settings and enter your key before starting a run." }, 400);
  }

  let task: string | undefined;
  let subAgents: Record<string, { description: string; prompt: string; model?: string }> | undefined;
  let maxCostUsd: number | undefined;
  try {
    const body = (await req.json()) as {
      task?: string;
      subAgents?: Record<string, { description: string; prompt: string; model?: string }>;
      maxCostUsd?: number;
    };
    task = body.task?.trim() || undefined;
    subAgents = body.subAgents;
    maxCostUsd = typeof body.maxCostUsd === "number" ? body.maxCostUsd : undefined;
  } catch { /* body is optional */ }

  const record = await startRun({ task, subAgents, maxCostUsd });

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
  registry.broadcast(agentId, { type: "user_message", text, ts: Date.now() });

  return json({ delivered: true });
}

async function handleGetArtifacts(workspacePath: string): Promise<Response> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const STATUS: Record<string, string> = {
      M: "modified", A: "added", D: "deleted",
      R: "renamed",  C: "copied", "??": "new",
    };

    const files: Array<{ path: string; status: string; size_bytes: number }> = [];
    let totalBytes = 0;

    for (const line of output.trim().split("\n")) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2).trim();
      const filePath = line.slice(3).trim().split(" -> ").pop()!; // handle renames
      let size = 0;
      try {
        size = statSync(join(workspacePath, filePath)).size;
      } catch { /* deleted or unreadable */ }
      files.push({ path: filePath, status: STATUS[code] ?? code, size_bytes: size });
      totalBytes += size;
    }

    return json({ files, total_files: files.length, total_size_bytes: totalBytes, workspace: workspacePath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: `Could not read workspace: ${msg}` }, 500);
  }
}

async function handleCreateTool(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  try {
    const t = toolRegistry.create(body as Parameters<typeof toolRegistry.create>[0]);
    return json(t, 201);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

async function handleUpdateTool(toolId: string, req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  try {
    const t = toolRegistry.update(toolId, body as Parameters<typeof toolRegistry.update>[1]);
    return t ? json(t) : json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
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

  /* Settings panel */
  #settings-panel {
    display: none; background: #141414; border-bottom: 1px solid #1e1e1e; padding: 20px 24px;
  }
  #settings-panel.open { display: block; }
  .settings-title { font-size: 13px; font-weight: 600; color: #ccc; margin-bottom: 4px; }
  .settings-sub { font-size: 12px; color: #444; margin-bottom: 20px; }
  .key-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .key-label { font-size: 11.5px; color: #666; display: flex; align-items: center; gap: 8px; }
  .key-badge { font-size: 10px; padding: 1px 6px; border-radius: 10px; font-weight: 600; }
  .key-badge.set   { background: #052e16; color: #4ade80; }
  .key-badge.unset { background: #2d0000; color: #f87171; }
  .key-badge.optional { background: #1a1a1a; color: #555; }
  .key-input-row { display: flex; gap: 8px; align-items: center; }
  .key-input {
    flex: 1; background: #0d0d0d; border: 1px solid #222; border-radius: 8px;
    color: #e2e2e2; font-size: 13px; font-family: "SF Mono","Fira Code",monospace;
    padding: 9px 12px; outline: none; transition: border-color 0.2s;
  }
  .key-input:focus { border-color: #1e3a8a; }
  .key-input::placeholder { color: #2a2a2a; font-family: inherit; }
  .btn-reveal {
    background: transparent; border: 1px solid #222; border-radius: 7px;
    color: #444; font-size: 12px; padding: 7px 10px; cursor: pointer;
    font-family: inherit; transition: color 0.15s, border-color 0.15s; flex-shrink: 0;
  }
  .btn-reveal:hover { color: #888; border-color: #444; }
  .settings-actions { display: flex; align-items: center; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid #1a1a1a; }
  .btn-save {
    background: #1e3a8a; color: #93c5fd; padding: 9px 20px;
    border: none; border-radius: 8px; font-size: 13px; font-weight: 600;
    font-family: inherit; cursor: pointer; transition: background 0.15s;
  }
  .btn-save:hover { background: #1d4ed8; color: #fff; }
  .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
  #save-feedback { font-size: 12px; color: #4ade80; display: none; }
  #save-error    { font-size: 12px; color: #f87171; display: none; }

  /* No-key banner */
  #no-key-banner {
    display: none; background: #1a0a00; border-bottom: 1px solid #3a1a00;
    padding: 12px 24px; display: flex; align-items: center; gap: 12px;
  }
  #no-key-banner.hidden { display: none !important; }
  #no-key-banner-text { font-size: 13px; color: #d97706; flex: 1; }
  #no-key-banner-text strong { color: #fbbf24; }
</style>
</head>
<body>

<div id="header">
  <h1>Agent Runs</h1>
  <div id="header-right">
    <span id="run-count" style="font-size:12px;color:#444;"></span>
    <a href="/tools" class="btn-ghost" style="text-decoration:none;display:inline-flex;align-items:center;">⚡ Tools</a>
    <button class="btn-ghost" onclick="toggleSettings()" id="settings-btn">⚙ Settings</button>
    <button class="btn-primary" onclick="toggleNewRun()">+ New Run</button>
  </div>
</div>

<div id="no-key-banner" class="hidden">
  <span style="font-size:16px">⚠️</span>
  <div id="no-key-banner-text"><strong>Anthropic API key not set.</strong> Enter your key in Settings before starting agent runs.</div>
  <button class="btn-ghost" onclick="toggleSettings()" style="flex-shrink:0">Open Settings</button>
</div>

<div id="settings-panel">
  <div class="settings-title">API Keys</div>
  <div class="settings-sub">Keys are saved locally to <code style="color:#555">.agents/keys.json</code> (gitignored) and never leave your machine.</div>

  <div class="key-row">
    <div class="key-label">
      Anthropic API Key
      <span id="anthropic-badge" class="key-badge unset">not set</span>
      <span style="color:#2a2a2a;font-size:11px">— required to run agents</span>
    </div>
    <div class="key-input-row">
      <input id="anthropic-key-input" class="key-input" type="password"
        placeholder="sk-ant-api03-…" autocomplete="off" spellcheck="false" />
      <button class="btn-reveal" onclick="toggleReveal('anthropic-key-input', this)">Show</button>
    </div>
  </div>

  <div class="key-row">
    <div class="key-label">
      OpenRouter API Key
      <span id="openrouter-badge" class="key-badge optional">not set</span>
      <span style="color:#2a2a2a;font-size:11px">— optional, enables AI run summaries</span>
    </div>
    <div class="key-input-row">
      <input id="openrouter-key-input" class="key-input" type="password"
        placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false" />
      <button class="btn-reveal" onclick="toggleReveal('openrouter-key-input', this)">Show</button>
    </div>
  </div>

  <div class="settings-actions">
    <button class="btn-save" id="save-btn" onclick="saveKeys()">Save Keys</button>
    <button class="btn-ghost" onclick="toggleSettings()">Cancel</button>
    <span id="save-feedback">✓ Keys saved</span>
    <span id="save-error"></span>
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
const settingsPanel = document.getElementById('settings-panel');
const noKeyBanner   = document.getElementById('no-key-banner');

// ── Settings ────────────────────────────────────────────────────────────────

let keyStatus = { ANTHROPIC_API_KEY: false, OPENROUTER_API_KEY: false };

function applyKeyStatus(s) {
  keyStatus = s;

  const ab = document.getElementById('anthropic-badge');
  ab.textContent = s.ANTHROPIC_API_KEY ? 'set ✓' : 'not set';
  ab.className = 'key-badge ' + (s.ANTHROPIC_API_KEY ? 'set' : 'unset');

  const ob = document.getElementById('openrouter-badge');
  ob.textContent = s.OPENROUTER_API_KEY ? 'set ✓' : 'not set';
  ob.className = 'key-badge ' + (s.OPENROUTER_API_KEY ? 'set' : 'optional');

  if (s.ANTHROPIC_API_KEY) {
    noKeyBanner.classList.add('hidden');
  } else {
    noKeyBanner.classList.remove('hidden');
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const data = await res.json();
    applyKeyStatus(data.keys);
  } catch { /* non-fatal */ }
}

function toggleSettings() {
  const open = settingsPanel.classList.toggle('open');
  if (open) {
    // Clear inputs so placeholder shows current status
    document.getElementById('anthropic-key-input').value = '';
    document.getElementById('openrouter-key-input').value = '';
    document.getElementById('save-feedback').style.display = 'none';
    document.getElementById('save-error').style.display = 'none';
    if (panel.classList.contains('open')) panel.classList.remove('open');
  }
}

function toggleReveal(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
}

async function saveKeys() {
  const btn = document.getElementById('save-btn');
  const feedback = document.getElementById('save-feedback');
  const errEl = document.getElementById('save-error');
  feedback.style.display = 'none';
  errEl.style.display = 'none';

  const anthropic  = document.getElementById('anthropic-key-input').value;
  const openrouter = document.getElementById('openrouter-key-input').value;

  // Validate Anthropic key format if provided
  if (anthropic && !anthropic.startsWith('sk-ant-')) {
    errEl.textContent = 'Anthropic keys should start with sk-ant-';
    errEl.style.display = 'inline';
    return;
  }
  if (openrouter && !openrouter.startsWith('sk-or-')) {
    errEl.textContent = 'OpenRouter keys should start with sk-or-';
    errEl.style.display = 'inline';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const body = {};
    // Only send fields the user actually typed — blank = keep existing
    if (anthropic  !== '') body['ANTHROPIC_API_KEY']  = anthropic;
    if (openrouter !== '') body['OPENROUTER_API_KEY'] = openrouter;

    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');

    applyKeyStatus(data.keys);
    document.getElementById('anthropic-key-input').value = '';
    document.getElementById('openrouter-key-input').value = '';
    feedback.style.display = 'inline';
    setTimeout(() => { feedback.style.display = 'none'; }, 3000);
  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = 'inline';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Keys';
  }
}

function toggleNewRun() {
  const open = panel.classList.toggle('open');
  if (open) {
    taskInput.focus();
    settingsPanel.classList.remove('open');
  }
}

async function createRun() {
  const task = taskInput.value.trim();
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: task || undefined }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Failed to create agent run');
    if (!keyStatus.ANTHROPIC_API_KEY) {
      panel.classList.remove('open');
      settingsPanel.classList.add('open');
      document.getElementById('anthropic-key-input').focus();
    }
    return;
  }
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
        <button class="btn-ghost" onclick="window.location.href='/agents/\${a.id}'">Chat</button>
        <button class="btn-ghost" onclick="window.location.href='/agents/\${a.id}/analytics'">Analytics</button>
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

loadConfig();
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
    <a href="/agents/${agentId}/analytics" style="font-size:12px;color:#444;text-decoration:none;border:1px solid #222;border-radius:6px;padding:4px 10px;" onmouseover="this.style.color='#aaa';this.style.borderColor='#444'" onmouseout="this.style.color='#444';this.style.borderColor='#222'">Analytics ↗</a>
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

// ---------------------------------------------------------------------------
// Analytics — server-side computation
// ---------------------------------------------------------------------------

type AnalyticsEvent = Record<string, unknown>;

function computeAnalytics(record: registry.AgentRecord): unknown {
  const history = record.chatHistory as AnalyticsEvent[];

  // ── Group history into per-turn buckets ──────────────────────────────────
  type Turn = {
    turnNum: number;
    costDelta: number;
    cumulativeCost: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreation: number;
    cacheRead: number;
    durationMs: number | null;
    stopReason: string | null;
    events: AnalyticsEvent[];
    toolCount: number;
    hasThinking: boolean;
    messageCount: number;
    userMessages: number;
    pingCount: number;
  };

  const turns: Turn[] = [];
  let currentEvents: AnalyticsEvent[] = [];
  let turnNum = 1;
  let runningCost = 0;

  for (const ev of history) {
    if (ev.type === "connected" || ev.type === "history") continue;

    if (ev.type === "turn_complete") {
      const cost = (ev.cost as number) || 0;
      const usage = ev.usage as Record<string, number> | null | undefined;
      runningCost += cost;
      turns.push({
        turnNum: turnNum++,
        costDelta: cost,
        cumulativeCost: runningCost,
        inputTokens: usage?.input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        cacheCreation: usage?.cache_creation_input_tokens || 0,
        cacheRead: usage?.cache_read_input_tokens || 0,
        durationMs: (ev.duration_ms as number) || null,
        stopReason: (ev.stop_reason as string) || null,
        events: currentEvents,
        toolCount: currentEvents.filter((e) => e.type === "tool_use").length,
        hasThinking: currentEvents.some((e) => e.type === "thinking"),
        messageCount: currentEvents.filter((e) => e.type === "agent_message").length,
        userMessages: currentEvents.filter((e) => e.type === "user_message").length,
        pingCount: currentEvents.filter((e) => e.type === "ping").length,
      });
      currentEvents = [];
    } else {
      currentEvents.push(ev);
    }
  }

  // In-progress turn (no turn_complete yet)
  if (currentEvents.length > 0) {
    turns.push({
      turnNum: turnNum,
      costDelta: 0,
      cumulativeCost: runningCost,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 0,
      durationMs: null,
      stopReason: null,
      events: currentEvents,
      toolCount: currentEvents.filter((e) => e.type === "tool_use").length,
      hasThinking: currentEvents.some((e) => e.type === "thinking"),
      messageCount: currentEvents.filter((e) => e.type === "agent_message").length,
      userMessages: currentEvents.filter((e) => e.type === "user_message").length,
      pingCount: currentEvents.filter((e) => e.type === "ping").length,
    });
  }

  // ── Tool breakdown ────────────────────────────────────────────────────────
  const toolCounts: Record<string, number> = {};
  const toolMaxElapsed: Record<string, number> = {};

  for (const ev of history) {
    if (ev.type === "tool_use") {
      const name = ev.name as string;
      toolCounts[name] = (toolCounts[name] || 0) + 1;
    }
    if (ev.type === "tool_progress") {
      const name = ev.tool as string;
      const elapsed = (ev.elapsed as number) || 0;
      if (!toolMaxElapsed[name] || elapsed > toolMaxElapsed[name]) {
        toolMaxElapsed[name] = elapsed;
      }
    }
  }

  const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  const toolBreakdown = Object.entries(toolCounts)
    .map(([name, count]) => ({
      name,
      count,
      pct: totalToolCalls > 0 ? Math.round((count / totalToolCalls) * 1000) / 10 : 0,
      maxElapsedSec: toolMaxElapsed[name] ?? null,
    }))
    .sort((a, b) => b.count - a.count);

  // ── Token totals ──────────────────────────────────────────────────────────
  let totalInput = 0, totalOutput = 0, totalCacheCreate = 0, totalCacheRead = 0;
  for (const t of turns) {
    totalInput += t.inputTokens;
    totalOutput += t.outputTokens;
    totalCacheCreate += t.cacheCreation;
    totalCacheRead += t.cacheRead;
  }
  const hasTokenData = totalInput > 0 || totalOutput > 0;
  const cacheHitRate =
    totalCacheCreate + totalCacheRead > 0
      ? Math.round((totalCacheRead / (totalCacheCreate + totalCacheRead)) * 1000) / 10
      : null;

  // ── Duration ─────────────────────────────────────────────────────────────
  const firstTs = history.find((e) => (e.ts as number) > 0)?.ts as number | undefined;
  const lastTs = [...history].reverse().find((e) => (e.ts as number) > 0)?.ts as number | undefined;
  const wallTimeMs = firstTs && lastTs ? lastTs - firstTs : null;

  return {
    agentId: record.id,
    task: record.task,
    status: record.status,
    startedAt: record.createdAt,
    summary: {
      turnCount: record.turnCount,
      totalCostUsd: record.totalCostUsd,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCacheCreationTokens: totalCacheCreate,
      totalCacheReadTokens: totalCacheRead,
      totalToolCalls,
      hasTokenData,
      cacheHitRate,
      wallTimeMs,
    },
    toolBreakdown,
    turns: turns.map((t) => ({
      ...t,
      // Truncate event inputs to avoid huge payloads
      events: t.events.map((ev) => {
        if (ev.type === "tool_use" && ev.input) {
          const inp = ev.input as Record<string, unknown>;
          const truncated: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(inp)) {
            const s = String(v);
            truncated[k] = s.length > 200 ? s.slice(0, 197) + "…" : v;
          }
          return { ...ev, input: truncated };
        }
        if (ev.type === "agent_message" && typeof ev.text === "string" && ev.text.length > 300) {
          return { ...ev, text: ev.text.slice(0, 297) + "…" };
        }
        if (ev.type === "tool_result" && typeof ev.summary === "string" && ev.summary.length > 300) {
          return { ...ev, summary: ev.summary.slice(0, 297) + "…" };
        }
        return ev;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Analytics Dashboard HTML
// ---------------------------------------------------------------------------

function buildAnalyticsHTML(agentId: string, task: string): string {
  const escapedTask = task.replace(/`/g, "\\`").replace(/\$/g, "\\$");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Analytics — ${agentId.slice(0, 8)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0d0d0d; color: #e2e2e2; min-height: 100vh;
  }

  /* ── Header ── */
  #header {
    display: flex; align-items: center; gap: 10px;
    padding: 11px 20px; background: #141414; border-bottom: 1px solid #1e1e1e;
    position: sticky; top: 0; z-index: 50;
  }
  #back { color: #444; font-size: 13px; text-decoration: none; flex-shrink: 0; }
  #back:hover { color: #888; }
  .hdiv { color: #2a2a2a; font-size: 13px; }
  #hcenter { flex: 1; min-width: 0; }
  #h-id { font-size: 11px; color: #383838; font-family: monospace; }
  #h-task { font-size: 13px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 500px; }
  #hright { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .status-badge {
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase;
    padding: 3px 8px; border-radius: 20px;
  }
  .status-badge.running  { background: #052e16; color: #4ade80; }
  .status-badge.starting { background: #2d1e02; color: #fbbf24; }
  .status-badge.stopped  { background: #1a1a1a; color: #555; }
  .hbtn {
    font-size: 12px; color: #444; text-decoration: none; border: 1px solid #222;
    border-radius: 6px; padding: 4px 10px; cursor: pointer; background: transparent;
    font-family: inherit; transition: color 0.15s, border-color 0.15s;
  }
  .hbtn:hover { color: #aaa; border-color: #444; }

  /* ── Layout ── */
  #main { padding: 24px 24px 60px; max-width: 1100px; }
  .section-title {
    font-size: 11px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase;
    color: #383838; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #1a1a1a;
  }
  .section { margin-bottom: 32px; }

  /* ── Summary cards ── */
  #summary-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px;
    margin-bottom: 32px;
  }
  .stat-card {
    background: #141414; border: 1px solid #1e1e1e; border-radius: 10px; padding: 14px 16px;
  }
  .stat-label { font-size: 11px; color: #444; margin-bottom: 6px; letter-spacing: 0.3px; }
  .stat-value { font-size: 22px; font-weight: 600; color: #e2e2e2; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .stat-sub { font-size: 11px; color: #383838; margin-top: 4px; }

  /* ── Two-column middle ── */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 32px; }
  @media (max-width: 700px) { .two-col { grid-template-columns: 1fr; } }

  /* ── Tables ── */
  .data-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .data-table th {
    text-align: left; font-size: 10.5px; font-weight: 600; color: #383838;
    letter-spacing: 0.4px; text-transform: uppercase;
    padding: 6px 10px; border-bottom: 1px solid #1a1a1a;
  }
  .data-table td {
    padding: 7px 10px; border-bottom: 1px solid #161616; color: #888;
    font-variant-numeric: tabular-nums; vertical-align: middle;
  }
  .data-table tr:last-child td { border-bottom: none; }
  .data-table tr:hover td { background: #141414; }
  .td-name { color: #ccc; font-family: "SF Mono","Fira Code",monospace; font-size: 12px; }
  .td-count { color: #e2e2e2; font-weight: 600; }

  /* ── Bar ── */
  .bar-wrap { display: flex; align-items: center; gap: 8px; }
  .bar-track { flex: 1; height: 4px; background: #1a1a1a; border-radius: 2px; min-width: 60px; }
  .bar-fill { height: 4px; border-radius: 2px; background: #1e3a8a; }

  /* ── Token section ── */
  .token-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .token-label { font-size: 12px; color: #555; width: 140px; flex-shrink: 0; }
  .token-bar-track { flex: 1; height: 6px; background: #1a1a1a; border-radius: 3px; }
  .token-bar-fill { height: 6px; border-radius: 3px; }
  .tok-in  { background: #1e3a8a; }
  .tok-out { background: #065f46; }
  .tok-cc  { background: #3b1764; }
  .tok-cr  { background: #4a1d00; }
  .token-val { font-size: 12px; color: #888; width: 90px; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }

  /* ── Turn table ── */
  .cost-cell { color: #fbbf24 !important; }
  .stop-badge {
    font-size: 10px; padding: 2px 6px; border-radius: 10px; font-weight: 500;
    background: #1a1a1a; color: #444;
  }
  .stop-badge.end_turn { background: #052e16; color: #4ade80; }
  .stop-badge.max_tokens { background: #2d1e02; color: #fbbf24; }
  .stop-badge.in_progress { background: #172554; color: #93c5fd; animation: blink 1.5s ease-in-out infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }

  /* ── Decision tree ── */
  .tree-turn {
    border: 1px solid #1a1a1a; border-radius: 10px; margin-bottom: 8px;
    overflow: hidden;
  }
  .tree-turn-header {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; cursor: pointer; user-select: none;
    background: #141414; transition: background 0.15s;
  }
  .tree-turn-header:hover { background: #181818; }
  .tree-chevron { font-size: 10px; color: #383838; transition: transform 0.2s; flex-shrink: 0; }
  .tree-turn.open .tree-chevron { transform: rotate(90deg); }
  .tree-turn-num { font-size: 11px; color: #444; font-family: monospace; flex-shrink: 0; }
  .tree-turn-stats { display: flex; gap: 14px; font-size: 11.5px; color: #444; flex-wrap: wrap; }
  .tree-turn-stats .hi { color: #666; }
  .tree-turn-body { display: none; padding: 10px 14px 12px; border-top: 1px solid #1a1a1a; }
  .tree-turn.open .tree-turn-body { display: block; }

  /* Events within a turn */
  .ev-list { display: flex; flex-direction: column; gap: 4px; }
  .ev-row {
    display: flex; align-items: flex-start; gap: 8px;
    font-size: 12px; line-height: 1.5; padding: 3px 0;
  }
  .ev-icon { flex-shrink: 0; width: 18px; text-align: center; font-size: 11px; margin-top: 1px; }
  .ev-main { flex: 1; min-width: 0; }
  .ev-name { color: #888; font-family: "SF Mono","Fira Code",monospace; }
  .ev-detail { color: #444; font-size: 11px; margin-top: 1px; white-space: pre-wrap; word-break: break-word; }
  .ev-elapsed { font-size: 10.5px; color: #2e2e2e; margin-left: 6px; flex-shrink: 0; }

  .ev-thinking { color: #2a2a4a; font-style: italic; }
  .ev-tool   .ev-name { color: #5b8dd9; }
  .ev-result .ev-name { color: #2e2e2e; }
  .ev-message .ev-name { color: #4ade80; }
  .ev-user   .ev-name { color: #93c5fd; }
  .ev-ping   .ev-name { color: #fbbf24; }

  /* ── Loading / empty ── */
  #loading { color: #333; font-size: 13px; padding: 60px; text-align: center; }
  #refresh-badge {
    font-size: 11px; color: #2a2a2a; padding: 3px 8px; border-radius: 20px;
    background: #141414; border: 1px solid #1e1e1e;
  }
</style>
</head>
<body>

<div id="header">
  <a id="back" href="/agents/${agentId}">← Chat</a>
  <span class="hdiv">/</span>
  <div id="hcenter">
    <div id="h-id">${agentId.slice(0, 8)}</div>
    <div id="h-task">${task.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
  </div>
  <div id="hright">
    <span id="status-badge" class="status-badge"></span>
    <span id="refresh-badge" style="display:none">Auto-refreshing…</span>
    <button class="hbtn" onclick="loadData()">Refresh</button>
    <a class="hbtn" href="/">All Runs</a>
  </div>
</div>

<div id="main">
  <div id="loading">Loading analytics…</div>
  <div id="content" style="display:none"></div>
</div>

<script>
const AGENT_ID = '${agentId}';
let refreshTimer = null;

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtCost(n) {
  if (!n && n !== 0) return '—';
  return '$' + Number(n).toFixed(4);
}
function fmtCostShort(n) {
  if (!n && n !== 0) return '—';
  return '$' + Number(n).toFixed(2);
}
function fmtNum(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return m + 'm ' + s + 's';
}
function fmtDate(s) {
  const d = new Date(s);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function trunc(s, n) {
  if (s === null || s === undefined) return '';
  const line = String(s).replace(/\\n/g,' ').trim();
  return line.length > n ? line.slice(0, n-1) + '…' : line;
}
function base(p) { return p ? String(p).split('/').pop() : ''; }

function fmtToolLabel(name, inp) {
  inp = inp || {};
  switch(name) {
    case 'Read':    return ['📖', 'Read ' + esc(base(inp.file_path))];
    case 'Write':   return ['📝', 'Write ' + esc(base(inp.file_path))];
    case 'Edit':    return ['✏️', 'Edit ' + esc(base(inp.file_path))];
    case 'Bash':    return ['$', esc(trunc(inp.description || inp.command, 90))];
    case 'Grep':    return ['🔍', 'Grep <span style="color:#444">"' + esc(trunc(inp.pattern,50)) + '"</span>'];
    case 'Glob':    return ['🔍', 'Glob <span style="color:#444">"' + esc(trunc(inp.pattern,50)) + '"</span>'];
    case 'WebSearch':  return ['🌐', 'Search <span style="color:#444">"' + esc(trunc(inp.query,60)) + '"</span>'];
    case 'WebFetch':   return ['🌐', 'Fetch ' + esc(trunc(inp.url,70))];
    case 'Agent':      return ['🤖', esc(trunc((inp.subagent_type||'') + ' ' + (inp.description||inp.prompt||''), 80))];
    case 'Task':       return ['🤖', esc(trunc((inp.subagent_type||'') + ' ' + (inp.description||''), 80))];
    case 'ping_human': return ['📢', 'Ping: ' + esc(trunc(inp.message,70))];
    case 'check_replies': return ['📬', 'Check replies'];
    case 'read_software_engineering_guide': return ['📘', 'Read engineering guide'];
    case 'browserbase_stagehand_navigate': return ['🌐', 'Navigate ' + esc(trunc(inp.url,60))];
    case 'browserbase_stagehand_act':      return ['🌐', esc(trunc(inp.action,70))];
    case 'browserbase_stagehand_extract':  return ['🌐', 'Extract page data'];
    case 'browserbase_stagehand_observe':  return ['🌐', 'Observe elements'];
    case 'browserbase_screenshot':         return ['🌐', 'Screenshot'];
    case 'browserbase_session_create':     return ['🌐', 'Open browser session'];
    case 'browserbase_session_close':      return ['🌐', 'Close browser session'];
    default: return ['🔧', esc(name)];
  }
}

// ── Section builders ─────────────────────────────────────────────────────────

function renderSummary(d) {
  const s = d.summary;
  const started = new Date(d.startedAt);
  const runningFor = d.status !== 'stopped' ? Math.round((Date.now() - started.getTime()) / 1000) : null;

  const tokenNote = s.hasTokenData ? '' : '<div class="stat-sub" style="color:#383838">No data yet — run in progress or pre-dates analytics</div>';

  return \`
  <div id="summary-grid">
    <div class="stat-card">
      <div class="stat-label">Turns</div>
      <div class="stat-value">\${s.turnCount}</div>
      <div class="stat-sub">completed turns</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Cost</div>
      <div class="stat-value">\${fmtCostShort(s.totalCostUsd)}</div>
      <div class="stat-sub">\${fmtCost(s.totalCostUsd)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Input Tokens</div>
      <div class="stat-value">\${s.hasTokenData ? fmtNum(s.totalInputTokens) : '—'}</div>
      \${tokenNote}
    </div>
    <div class="stat-card">
      <div class="stat-label">Output Tokens</div>
      <div class="stat-value">\${s.hasTokenData ? fmtNum(s.totalOutputTokens) : '—'}</div>
      \${tokenNote}
    </div>
    <div class="stat-card">
      <div class="stat-label">Cache Hit Rate</div>
      <div class="stat-value">\${s.cacheHitRate !== null ? s.cacheHitRate + '%' : '—'}</div>
      <div class="stat-sub">of prompted tokens</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Tool Calls</div>
      <div class="stat-value">\${s.totalToolCalls}</div>
      <div class="stat-sub">\${s.turnCount > 0 ? (s.totalToolCalls / s.turnCount).toFixed(1) + ' avg/turn' : ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Wall Time</div>
      <div class="stat-value">\${fmtDuration(s.wallTimeMs)}</div>
      <div class="stat-sub">\${runningFor ? 'running ' + fmtDuration(runningFor * 1000) : 'total'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Started</div>
      <div class="stat-value" style="font-size:13px">\${fmtDate(d.startedAt)}</div>
      <div class="stat-sub">\${d.status}</div>
    </div>
  </div>\`;
}

function renderTokenSection(d) {
  const s = d.summary;
  if (!s.hasTokenData) return \`<div class="section">
    <div class="section-title">Token Usage</div>
    <div style="color:#333;font-size:12px;padding:12px 0;">Token data will appear after the first completed turn (requires updated infrastructure).</div>
  </div>\`;

  const total = s.totalInputTokens + s.totalOutputTokens + s.totalCacheCreationTokens + s.totalCacheReadTokens;
  const pct = (n) => total > 0 ? (n / total * 100).toFixed(1) : 0;
  const bar = (n, cls) => \`<div class="token-bar-fill \${cls}" style="width:\${pct(n)}%"></div>\`;

  return \`<div>
    <div class="section-title">Token Breakdown</div>
    <div class="token-row">
      <div class="token-label">Input (prompt)</div>
      <div class="token-bar-track">\${bar(s.totalInputTokens, 'tok-in')}</div>
      <div class="token-val">\${fmtNum(s.totalInputTokens)}</div>
    </div>
    <div class="token-row">
      <div class="token-label">Output (generated)</div>
      <div class="token-bar-track">\${bar(s.totalOutputTokens, 'tok-out')}</div>
      <div class="token-val">\${fmtNum(s.totalOutputTokens)}</div>
    </div>
    <div class="token-row">
      <div class="token-label">Cache write</div>
      <div class="token-bar-track">\${bar(s.totalCacheCreationTokens, 'tok-cc')}</div>
      <div class="token-val">\${fmtNum(s.totalCacheCreationTokens)}</div>
    </div>
    <div class="token-row">
      <div class="token-label">Cache read (saved)</div>
      <div class="token-bar-track">\${bar(s.totalCacheReadTokens, 'tok-cr')}</div>
      <div class="token-val">\${fmtNum(s.totalCacheReadTokens)}</div>
    </div>
    \${s.cacheHitRate !== null ? \`<div style="font-size:11px;color:#383838;margin-top:8px">Cache hit rate: <span style="color:#555">\${s.cacheHitRate}%</span> — cache reads avoid re-paying input token cost</div>\` : ''}
  </div>\`;
}

function renderToolBreakdown(d) {
  if (!d.toolBreakdown.length) return \`<div>
    <div class="section-title">Tool Usage</div>
    <div style="color:#333;font-size:12px;padding:12px 0;">No tool calls recorded yet.</div>
  </div>\`;

  const maxCount = d.toolBreakdown[0].count;
  const rows = d.toolBreakdown.map(t => \`
    <tr>
      <td class="td-name">\${esc(t.name)}</td>
      <td class="td-count">\${t.count}</td>
      <td style="width:140px">
        <div class="bar-wrap">
          <div class="bar-track"><div class="bar-fill" style="width:\${Math.round(t.count/maxCount*100)}%"></div></div>
          <span style="font-size:10.5px;color:#383838;width:36px;text-align:right">\${t.pct}%</span>
        </div>
      </td>
      <td>\${t.maxElapsedSec ? t.maxElapsedSec.toFixed(1) + 's' : '—'}</td>
    </tr>
  \`).join('');

  return \`<div>
    <div class="section-title">Tool Usage</div>
    <table class="data-table">
      <thead><tr><th>Tool</th><th>Calls</th><th>Share</th><th>Max Duration</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  </div>\`;
}

function renderTurnTimeline(d) {
  if (!d.turns.length) return '';

  const rows = d.turns.map(t => {
    const inProgress = !t.durationMs && !t.stopReason;
    const stopBadge = inProgress
      ? '<span class="stop-badge in_progress">in progress</span>'
      : (t.stopReason ? \`<span class="stop-badge \${esc(t.stopReason)}">\${esc(t.stopReason)}</span>\` : '<span class="stop-badge">—</span>');
    return \`<tr>
      <td style="color:#555;font-family:monospace">#\${t.turnNum}</td>
      <td class="\${t.costDelta > 0 ? 'cost-cell' : ''}">\${t.costDelta > 0 ? fmtCostShort(t.costDelta) : '—'}</td>
      <td>\${t.inputTokens ? fmtNum(t.inputTokens) : '—'}</td>
      <td>\${t.outputTokens ? fmtNum(t.outputTokens) : '—'}</td>
      <td style="color:\${t.toolCount > 0 ? '#888' : '#333'}">\${t.toolCount}</td>
      <td style="color:\${t.hasThinking ? '#5b8dd9' : '#333'}">\${t.hasThinking ? '💭 yes' : 'no'}</td>
      <td>\${fmtDuration(t.durationMs)}</td>
      <td>\${stopBadge}</td>
    </tr>\`;
  }).join('');

  return \`<div class="section">
    <div class="section-title">Turn Timeline</div>
    <table class="data-table">
      <thead><tr>
        <th>Turn</th><th>Cost</th><th>Input Tok</th><th>Output Tok</th>
        <th>Tools</th><th>Thinking</th><th>Duration</th><th>Stop</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  </div>\`;
}

function renderEventRow(ev) {
  switch (ev.type) {
    case 'thinking':
      return \`<div class="ev-row ev-thinking">
        <div class="ev-icon">💭</div>
        <div class="ev-main"><span style="color:#2a2a4a;font-style:italic">Extended thinking</span></div>
      </div>\`;

    case 'tool_use': {
      const [icon, label] = fmtToolLabel(ev.name, ev.input);
      return \`<div class="ev-row ev-tool">
        <div class="ev-icon">\${icon}</div>
        <div class="ev-main">
          <span class="ev-name">\${esc(ev.name)}</span>
          <span style="color:#333;margin-left:6px;font-size:11px">\${label}</span>
        </div>
      </div>\`;
    }

    case 'tool_progress':
      return \`<div class="ev-row" style="padding-left:26px">
        <div class="ev-icon" style="color:#2a2a2a">⏱</div>
        <div class="ev-main"><span style="font-size:10.5px;color:#2a2a2a;font-family:monospace">\${esc(ev.tool)} running… \${ev.elapsed ? Number(ev.elapsed).toFixed(1) + 's' : ''}</span></div>
      </div>\`;

    case 'tool_result':
      return \`<div class="ev-row ev-result" style="padding-left:26px">
        <div class="ev-icon" style="color:#2e4a2e">✓</div>
        <div class="ev-main">
          <span class="ev-name" style="color:#2e4a2e">result</span>
          \${ev.summary ? \`<div class="ev-detail">\${esc(trunc(ev.summary, 200))}</div>\` : ''}
        </div>
      </div>\`;

    case 'agent_message':
      return \`<div class="ev-row ev-message">
        <div class="ev-icon">💬</div>
        <div class="ev-main">
          <span class="ev-name">agent message</span>
          <div class="ev-detail" style="color:#555">\${esc(trunc(ev.text, 250))}</div>
        </div>
      </div>\`;

    case 'user_message':
      return \`<div class="ev-row ev-user">
        <div class="ev-icon">👤</div>
        <div class="ev-main">
          <span class="ev-name">user</span>
          <div class="ev-detail" style="color:#555">\${esc(trunc(ev.text, 200))}</div>
        </div>
      </div>\`;

    case 'ping':
      return \`<div class="ev-row ev-ping">
        <div class="ev-icon">📢</div>
        <div class="ev-main">
          <span class="ev-name">ping human</span>
          <div class="ev-detail" style="color:#92650a">\${esc(trunc(ev.message, 200))}</div>
        </div>
      </div>\`;

    case 'status':
      return \`<div class="ev-row">
        <div class="ev-icon" style="color:#2a2a2a">•</div>
        <div class="ev-main"><span style="font-size:11px;color:#2a2a2a">\${esc(ev.text)}</span></div>
      </div>\`;

    default:
      return '';
  }
}

function renderDecisionTree(d) {
  if (!d.turns.length) return '';

  const turnItems = d.turns.map((t, i) => {
    const inProgress = !t.durationMs && !t.stopReason;
    const stats = [
      t.costDelta > 0 ? fmtCostShort(t.costDelta) : null,
      (t.inputTokens || t.outputTokens) ? (fmtNum(t.inputTokens) + ' in / ' + fmtNum(t.outputTokens) + ' out') : null,
      t.durationMs ? fmtDuration(t.durationMs) : null,
      t.toolCount ? t.toolCount + ' tools' : null,
    ].filter(Boolean).map(s => \`<span class="hi">\${s}</span>\`).join(' · ');

    const evRows = (t.events || []).map(renderEventRow).join('');
    const bodyContent = evRows || \`<div style="color:#2a2a2a;font-size:12px;padding:4px 0">No events recorded for this turn.</div>\`;

    // Start turn 1 open, rest closed
    const openClass = i === 0 ? ' open' : '';

    return \`<div class="tree-turn\${openClass}" onclick="toggleTurn(this)">
      <div class="tree-turn-header">
        <span class="tree-chevron">▶</span>
        <span class="tree-turn-num">Turn \${t.turnNum}</span>
        \${inProgress ? '<span class="stop-badge in_progress" style="font-size:10px">in progress</span>' : ''}
        <div class="tree-turn-stats">\${stats || '<span style="color:#2a2a2a">no data</span>'}</div>
      </div>
      <div class="tree-turn-body">
        <div class="ev-list">\${bodyContent}</div>
      </div>
    </div>\`;
  }).join('');

  return \`<div class="section">
    <div class="section-title">Decision &amp; Action Tree</div>
    <div style="margin-bottom:8px;font-size:11px;color:#2e2e2e">Click a turn to expand. Shows the sequence of thinking, tool calls, and messages within each turn.</div>
    \${turnItems}
  </div>\`;
}

function toggleTurn(el) {
  el.classList.toggle('open');
}

// ── Run summary (narrative phases) ───────────────────────────────────────────

function categorizeTurn(turn) {
  const counts = {};
  for (const ev of (turn.events || [])) {
    if (ev.type !== 'tool_use') continue;
    const n = ev.name;
    if (['Read','Grep','Glob'].includes(n))            counts.explore  = (counts.explore  || 0) + 1;
    else if (['Write','Edit'].includes(n))             counts.write    = (counts.write    || 0) + 1;
    else if (n === 'Bash')                             counts.exec     = (counts.exec     || 0) + 1;
    else if (['WebSearch','WebFetch'].includes(n))     counts.web      = (counts.web      || 0) + 1;
    else if (n.startsWith('browserbase'))              counts.browser  = (counts.browser  || 0) + 1;
    else if (['Task','Agent'].includes(n))             counts.agents   = (counts.agents   || 0) + 1;
    else                                               counts.other    = (counts.other    || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return turn.hasThinking ? 'reasoning' : 'idle';
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

const PHASE_META = {
  explore:   { label: 'Exploration',         icon: '🔍', color: '#1e3a8a' },
  write:     { label: 'Writing / Editing',    icon: '✏️', color: '#065f46' },
  exec:      { label: 'Running Commands',     icon: '⚡', color: '#3b1764' },
  web:       { label: 'Web Research',         icon: '🌐', color: '#4a1d00' },
  browser:   { label: 'Browser Automation',   icon: '🖥',  color: '#1c3050' },
  agents:    { label: 'Spawning Sub-agents',  icon: '🤖', color: '#1a2e1a' },
  reasoning: { label: 'Planning / Reasoning', icon: '💭', color: '#1a1a2e' },
  idle:      { label: 'Idle',                 icon: '•',  color: '#1a1a1a' },
  other:     { label: 'Tool Use',             icon: '🔧', color: '#1a1a1a' },
};

function renderRunSummary(d, aiData) {
  if (!d.turns || !d.turns.length) return '';

  // Tag each turn with a category
  const tagged = d.turns.map(t => ({ ...t, cat: categorizeTurn(t) }));

  // Group consecutive turns with the same category into phases
  const phases = [];
  let cur = null;
  for (const t of tagged) {
    if (!cur || cur.cat !== t.cat) {
      cur = { cat: t.cat, turns: [t], start: t.turnNum, end: t.turnNum };
      phases.push(cur);
    } else {
      cur.turns.push(t);
      cur.end = t.turnNum;
    }
  }

  const inProgress = d.status === 'running' || d.status === 'starting';

  // AI overall summary banner
  let overallBanner = '';
  if (aiData?.status === 'ready' && aiData.result?.overall) {
    overallBanner = \`<div style="background:#0d1a2e;border:1px solid #1e3a5a;border-radius:8px;padding:10px 14px;margin-bottom:18px;display:flex;align-items:flex-start;gap:10px">
      <span style="font-size:14px;flex-shrink:0">✨</span>
      <div>
        <div style="font-size:11px;color:#3a6a9a;font-weight:600;letter-spacing:0.4px;margin-bottom:3px">AI SUMMARY</div>
        <div style="font-size:13.5px;color:#93c5fd;line-height:1.5">\${esc(aiData.result.overall)}</div>
        <div style="font-size:10px;color:#1e3a5a;margin-top:4px">via \${esc(aiData.result.model)}</div>
      </div>
      <button onclick="regenSummary()" style="margin-left:auto;flex-shrink:0;font-size:10px;color:#2a4a6a;background:transparent;border:1px solid #1e3a5a;border-radius:5px;padding:3px 7px;cursor:pointer" title="Regenerate">↺</button>
    </div>\`;
  } else if (aiData?.status === 'generating') {
    overallBanner = \`<div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:10px 14px;margin-bottom:18px;display:flex;align-items:center;gap:10px;color:#333;font-size:12px">
      <span style="animation:spin 1.2s linear infinite;display:inline-block">⟳</span> Generating AI summary…
    </div>\`;
  } else if (aiData?.status === 'unavailable') {
    overallBanner = \`<div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:8px 14px;margin-bottom:18px;font-size:11px;color:#2a2a2a">
      Set <code style="color:#383838">OPENROUTER_API_KEY</code> to enable AI-generated summaries.
    </div>\`;
  } else if (aiData?.status === 'error') {
    overallBanner = \`<div style="background:#1a0000;border:1px solid #3a0000;border-radius:8px;padding:8px 14px;margin-bottom:18px;font-size:11px;color:#7a3a3a">
      AI summary error: \${esc(aiData.message)}
    </div>\`;
  }

  // Build per-phase AI summary lookup
  const aiPhaseMap = {};
  if (aiData?.status === 'ready') {
    for (const p of (aiData.result?.phases ?? [])) {
      aiPhaseMap[p.phaseIdx] = p.summary;
    }
  }

  // Re-render items with AI summaries injected
  const itemsWithAI = phases.map((p, i) => {
    const meta = PHASE_META[p.cat] || PHASE_META.other;
    const range = p.start === p.end ? \`Turn \${p.start}\` : \`Turns \${p.start}–\${p.end}\`;
    const toolTotals = {};
    for (const t of p.turns) {
      for (const ev of (t.events || [])) {
        if (ev.type === 'tool_use') toolTotals[ev.name] = (toolTotals[ev.name] || 0) + 1;
      }
    }
    const toolParts = Object.entries(toolTotals)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([name, cnt]) => \`\${cnt}× \${esc(name)}\`).join('  ·  ');

    let conclusion = null;
    for (const t of [...p.turns].reverse()) {
      for (const ev of [...(t.events || [])].reverse()) {
        if (ev.type === 'agent_message' && ev.text) {
          conclusion = String(ev.text).replace(/\\n/g, ' ').trim().slice(0, 220);
          if (conclusion.length === 220) conclusion += '…';
          break;
        }
      }
      if (conclusion) break;
    }

    const pings = p.turns.flatMap(t => (t.events||[]).filter(e => e.type === 'ping').map(e => e.message));
    const pingSnippet = pings.length
      ? \`<div style="margin-top:5px;font-size:11.5px;color:#92650a;border-left:2px solid #2e2410;padding-left:7px">📢 \${esc(trunc(pings[0], 160))}\${pings.length > 1 ? \` <span style="color:#3a2a00">+\${pings.length-1} more</span>\` : ''}</div>\`
      : '';

    const hasThinking = p.turns.some(t => t.hasThinking);
    const aiPhaseSummary = aiPhaseMap[i];

    const connector = i < phases.length - 1
      ? \`<div style="width:1px;height:16px;background:#1e1e1e;margin:0 0 0 9px"></div>\`
      : '';

    return \`
      <div style="display:flex;gap:14px;align-items:flex-start">
        <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
          <div style="width:20px;height:20px;border-radius:50%;background:\${meta.color};border:1px solid #2a2a2a;display:flex;align-items:center;justify-content:center;font-size:10px">\${meta.icon}</div>
        </div>
        <div style="flex:1;min-width:0;padding-bottom:4px">
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:3px">
            <span style="font-size:13px;font-weight:600;color:#ccc">\${meta.label}</span>
            <span style="font-size:11px;color:#383838">\${range}</span>
            \${hasThinking ? '<span style="font-size:10px;color:#3a3a6a;border:1px solid #1e1e3a;border-radius:10px;padding:1px 5px">💭 thinking</span>' : ''}
          </div>
          \${aiPhaseSummary
            ? \`<div style="font-size:12.5px;color:#7ab3e0;margin-bottom:4px;font-style:italic">\${esc(aiPhaseSummary)}</div>\`
            : ''}
          \${toolParts ? \`<div style="font-size:11px;color:#383838;font-family:monospace;margin-bottom:3px">\${toolParts}</div>\` : \`<div style="font-size:11.5px;color:#2e2e2e">No tool calls</div>\`}
          \${conclusion ? \`<div style="font-size:11.5px;color:#2e2e2e;font-style:italic;border-left:2px solid #1e1e1e;padding-left:7px;margin-top:4px">"\${esc(conclusion)}"</div>\` : ''}
          \${pingSnippet}
        </div>
      </div>
      \${connector}
    \`;
  }).join('');

  return \`<div class="section">
    <div class="section-title">Run Summary</div>
    <div style="font-size:11px;color:#2e2e2e;margin-bottom:14px">\${d.turns.length} turn\${d.turns.length!==1?'s':''} · \${phases.length} phase\${phases.length!==1?'s':''}
    \${inProgress ? ' · <span style="color:#3a5a3a">still running</span>' : ''}</div>
    \${overallBanner}
    \${itemsWithAI}
  </div>\`;
}

// ── Main render ───────────────────────────────────────────────────────────────

let analyticsData = null;
let aiData = null;
let aiPollTimer = null;

function render() {
  if (!analyticsData) return;
  const d = analyticsData;
  const content = document.getElementById('content');
  content.style.display = 'block';
  document.getElementById('loading').style.display = 'none';

  const badge = document.getElementById('status-badge');
  badge.textContent = d.status;
  badge.className = 'status-badge ' + d.status;

  const twoCol = \`<div class="two-col">
    <div>\${renderToolBreakdown(d)}</div>
    <div>\${renderTokenSection(d)}</div>
  </div>\`;

  content.innerHTML =
    renderSummary(d) +
    renderRunSummary(d, aiData) +
    twoCol +
    renderTurnTimeline(d) +
    renderDecisionTree(d);
}

async function loadAI() {
  try {
    const res = await fetch('/api/agents/' + AGENT_ID + '/ai-summary');
    if (!res.ok) return;
    aiData = await res.json();
    render();
    // If still generating, keep polling
    if (aiData?.status === 'generating') {
      clearTimeout(aiPollTimer);
      aiPollTimer = setTimeout(loadAI, 3000);
    }
  } catch { /* non-fatal */ }
}

async function regenSummary() {
  await fetch('/api/agents/' + AGENT_ID + '/ai-summary', { method: 'DELETE' });
  aiData = { status: 'generating' };
  render();
  clearTimeout(aiPollTimer);
  aiPollTimer = setTimeout(loadAI, 1500);
}

async function loadData() {
  try {
    const res = await fetch('/api/agents/' + AGENT_ID + '/analytics');
    if (!res.ok) { document.getElementById('loading').textContent = 'Failed to load analytics.'; return; }
    analyticsData = await res.json();
    render();

    // Auto-refresh analytics if agent is still running
    if (analyticsData.status === 'running' || analyticsData.status === 'starting') {
      document.getElementById('refresh-badge').style.display = 'inline';
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(loadData, 12000);
    } else {
      document.getElementById('refresh-badge').style.display = 'none';
    }

    // Fetch AI summary in parallel (non-blocking)
    loadAI();

  } catch(e) {
    document.getElementById('loading').textContent = 'Error: ' + e.message;
  }
}

// spin keyframe for generating indicator
const style = document.createElement('style');
style.textContent = '@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }';
document.head.appendChild(style);

loadData();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Tools management page
// ---------------------------------------------------------------------------

function buildToolsHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Custom Tools</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #0d0d0d; color: #e2e2e2; min-height: 100vh; }
  a { color: inherit; text-decoration: none; }
  button { cursor: pointer; border: none; border-radius: 7px; font-size: 13px; font-weight: 500; font-family: inherit; transition: background 0.15s; }
  .btn-primary { background: #1e3a8a; color: #93c5fd; padding: 8px 14px; }
  .btn-primary:hover { background: #1d4ed8; color: #fff; }
  .btn-danger  { background: #3f0000; color: #f87171; padding: 5px 10px; font-size: 12px; }
  .btn-danger:hover { background: #7f1d1d; }
  .btn-ghost { background: transparent; color: #555; padding: 5px 10px; font-size: 12px; border: 1px solid #222; }
  .btn-ghost:hover { color: #aaa; border-color: #444; }
  .btn-sm { padding: 4px 9px; font-size: 12px; }

  #header { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; background: #141414; border-bottom: 1px solid #1e1e1e; }
  #header h1 { font-size: 15px; font-weight: 600; color: #f0f0f0; }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .back-link { color: #444; font-size: 12px; }
  .back-link:hover { color: #888; }

  #main { padding: 24px; max-width: 900px; }
  .empty { color: #333; font-size: 13px; padding: 40px 0; text-align: center; }

  .tool-card { background: #141414; border: 1px solid #1e1e1e; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; display: flex; align-items: flex-start; gap: 12px; transition: border-color 0.15s; }
  .tool-card:hover { border-color: #2a2a2a; }
  .tool-body { flex: 1; min-width: 0; }
  .tool-name { font-size: 13.5px; color: #e2e2e2; font-family: "SF Mono","Fira Code",monospace; margin-bottom: 4px; }
  .tool-desc { font-size: 12.5px; color: #555; line-height: 1.5; margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-meta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .badge { font-size: 10.5px; padding: 2px 7px; border-radius: 10px; font-weight: 600; }
  .badge-http  { background: #0c2340; color: #60a5fa; }
  .badge-shell { background: #1a1200; color: #fbbf24; }
  .badge-params { background: #111; color: #555; }
  .tool-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: flex-start; }

  .toggle { position: relative; width: 32px; height: 18px; flex-shrink: 0; margin-top: 1px; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; inset: 0; background: #222; border-radius: 18px; cursor: pointer; transition: background 0.2s; }
  .toggle-slider::before { content: ""; position: absolute; height: 12px; width: 12px; left: 3px; bottom: 3px; background: #555; border-radius: 50%; transition: transform 0.2s, background 0.2s; }
  .toggle input:checked + .toggle-slider { background: #1e3a8a; }
  .toggle input:checked + .toggle-slider::before { transform: translateX(14px); background: #93c5fd; }

  #modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; align-items: flex-start; justify-content: center; padding: 40px 20px; overflow-y: auto; }
  #modal-overlay.open { display: flex; }
  #modal { background: #141414; border: 1px solid #222; border-radius: 12px; width: 100%; max-width: 640px; padding: 24px; }
  #modal-title { font-size: 15px; font-weight: 600; color: #f0f0f0; margin-bottom: 20px; }

  .form-group { margin-bottom: 16px; }
  .form-label { font-size: 11.5px; color: #666; margin-bottom: 6px; display: block; }
  .form-input, .form-select, .form-textarea {
    width: 100%; background: #0d0d0d; border: 1px solid #222; border-radius: 8px;
    color: #e2e2e2; font-size: 13px; font-family: inherit; padding: 9px 12px;
    outline: none; transition: border-color 0.2s;
  }
  .form-input:focus, .form-select:focus, .form-textarea:focus { border-color: #1e3a8a; }
  .form-select { cursor: pointer; }
  .form-textarea { resize: vertical; min-height: 70px; }
  .form-mono { font-family: "SF Mono","Fira Code",monospace; font-size: 12px; }
  .form-hint { font-size: 11px; color: #3a3a3a; margin-top: 4px; }

  .params-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .params-header .form-label { margin: 0; }
  #params-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 8px; }
  #params-table th { text-align: left; color: #444; font-weight: 500; padding: 4px 6px; border-bottom: 1px solid #1e1e1e; }
  #params-table td { padding: 4px 4px; vertical-align: middle; }
  #params-table input, #params-table select { background: #0d0d0d; border: 1px solid #1e1e1e; border-radius: 5px; color: #e2e2e2; font-size: 12px; font-family: inherit; padding: 5px 7px; outline: none; width: 100%; }
  #params-table input:focus, #params-table select:focus { border-color: #1e3a8a; }
  .td-req { text-align: center; width: 50px; }
  .td-del { text-align: center; width: 32px; }
  .del-param { background: transparent; border: none; color: #555; font-size: 14px; cursor: pointer; padding: 2px 4px; }
  .del-param:hover { color: #f87171; }

  #exec-http, #exec-shell { display: none; }
  #exec-http.active, #exec-shell.active { display: block; }

  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; padding-top: 16px; border-top: 1px solid #1a1a1a; }

  #toast { display: none; position: fixed; bottom: 24px; right: 24px; background: #141414; border: 1px solid #222; border-radius: 8px; padding: 10px 16px; font-size: 13px; z-index: 200; }
  #toast.error { border-color: #7f1d1d; color: #f87171; }
  #toast.success { border-color: #14532d; color: #4ade80; }
</style>
</head>
<body>

<div id="header">
  <div class="header-left">
    <a href="/" class="back-link">← Agents</a>
    <h1>Custom Tools</h1>
  </div>
  <button class="btn-primary" onclick="openModal()">+ New Tool</button>
</div>

<div id="main">
  <div id="empty" class="empty" style="display:none">No custom tools yet. Click "+ New Tool" to define one.</div>
  <div id="tool-list"></div>
</div>

<div id="modal-overlay" onclick="maybeClose(event)">
  <div id="modal">
    <div id="modal-title">New Tool</div>

    <div class="form-group">
      <label class="form-label">Name <span style="color:#3a3a3a">(snake_case — this is what the agent calls)</span></label>
      <input id="f-name" class="form-input form-mono" placeholder="search_database" />
    </div>

    <div class="form-group">
      <label class="form-label">Description <span style="color:#3a3a3a">(shown to the model — be specific about when to use it)</span></label>
      <textarea id="f-desc" class="form-textarea" rows="2" placeholder="Search the internal database for records matching a query."></textarea>
    </div>

    <div class="form-group">
      <div class="params-header">
        <label class="form-label">Parameters</label>
        <button class="btn-ghost btn-sm" onclick="addParam()">+ Add</button>
      </div>
      <table id="params-table">
        <thead><tr>
          <th style="width:28%">Name</th>
          <th style="width:20%">Type</th>
          <th>Description</th>
          <th class="td-req">Req</th>
          <th class="td-del"></th>
        </tr></thead>
        <tbody id="params-body"></tbody>
      </table>
      <div class="form-hint">Add a parameter for each piece of input the agent should provide when calling this tool.</div>
    </div>

    <div class="form-group">
      <label class="form-label">Executor</label>
      <select id="f-executor-type" class="form-select" onchange="switchExecutor(this.value)">
        <option value="http">HTTP — call a URL endpoint</option>
        <option value="shell">Shell — run a local command</option>
      </select>
    </div>

    <div id="exec-http" class="active">
      <div class="form-group">
        <label class="form-label">URL</label>
        <input id="f-http-url" class="form-input form-mono" placeholder="http://localhost:8080/api/search" />
      </div>
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:0 0 120px">
          <label class="form-label">Method</label>
          <select id="f-http-method" class="form-select">
            <option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option>
          </select>
        </div>
        <div class="form-group" style="flex:1">
          <label class="form-label">Extra Headers <span style="color:#3a3a3a">(JSON, optional)</span></label>
          <input id="f-http-headers" class="form-input form-mono" placeholder='{"Authorization": "Bearer ..."}' />
        </div>
      </div>
      <div class="form-hint">Input is sent as JSON body (POST/PUT/PATCH) or query string (GET). Response body is returned to the agent.</div>
    </div>

    <div id="exec-shell">
      <div class="form-group">
        <label class="form-label">Command <span style="color:#3a3a3a">(use {{param_name}} for substitution)</span></label>
        <input id="f-shell-cmd" class="form-input form-mono" placeholder="python scripts/search.py --query '{{query}}'" />
      </div>
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:1">
          <label class="form-label">Working directory <span style="color:#3a3a3a">(defaults to agent workspace)</span></label>
          <input id="f-shell-cwd" class="form-input form-mono" placeholder="/path/to/project" />
        </div>
        <div class="form-group" style="flex:0 0 120px">
          <label class="form-label">Timeout (ms)</label>
          <input id="f-shell-timeout" class="form-input" type="number" placeholder="30000" />
        </div>
      </div>
      <div class="form-hint">stdout+stderr returned to agent. Parameters are shell-quoted before substitution.</div>
    </div>

    <div id="form-error" style="color:#f87171;font-size:12px;margin-top:8px;display:none"></div>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveTool()">Save Tool</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
let tools = [], editingId = null;

async function load() {
  tools = await fetch('/api/tools').then(r => r.json());
  render();
}

function render() {
  const list = document.getElementById('tool-list');
  const empty = document.getElementById('empty');
  if (!tools.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  list.innerHTML = tools.map(t => {
    const ex = t.executor;
    const exB = ex.type === 'http'
      ? \`<span class="badge badge-http">HTTP \${ex.method||'POST'}</span>\`
      : '<span class="badge badge-shell">shell</span>';
    const pc = Object.keys(t.inputSchema?.properties || {}).length;
    const pB = pc ? \`<span class="badge badge-params">\${pc} param\${pc>1?'s':''}</span>\` : '';
    return \`<div class="tool-card">
      <label class="toggle" title="\${t.enabled?'Disable':'Enable'}">
        <input type="checkbox" \${t.enabled?'checked':''} onchange="toggle('\${t.id}',this)">
        <span class="toggle-slider"></span>
      </label>
      <div class="tool-body">
        <div class="tool-name">\${t.name}</div>
        <div class="tool-desc">\${t.description}</div>
        <div class="tool-meta">\${exB}\${pB}</div>
      </div>
      <div class="tool-actions">
        <button class="btn-ghost btn-sm" onclick="editTool('\${t.id}')">Edit</button>
        <button class="btn-danger btn-sm" onclick="deleteTool('\${t.id}','\${t.name}')">Delete</button>
      </div>
    </div>\`;
  }).join('');
}

async function toggle(id, el) {
  const r = await fetch(\`/api/tools/\${id}/toggle\`, { method: 'POST' });
  if (!r.ok) { el.checked = !el.checked; toast('Toggle failed', true); return; }
  const t = await r.json();
  tools = tools.map(x => x.id === id ? t : x);
  toast(t.enabled ? 'Tool enabled' : 'Tool disabled');
}

async function deleteTool(id, name) {
  if (!confirm(\`Delete "\${name}"?\`)) return;
  const r = await fetch(\`/api/tools/\${id}\`, { method: 'DELETE' });
  if (!r.ok) { toast('Delete failed', true); return; }
  tools = tools.filter(t => t.id !== id);
  render(); toast('Tool deleted');
}

function openModal(t) {
  editingId = t ? t.id : null;
  document.getElementById('modal-title').textContent = t ? 'Edit Tool' : 'New Tool';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('f-name').value = t?.name || '';
  document.getElementById('f-desc').value = t?.description || '';
  document.getElementById('params-body').innerHTML = '';
  const props = t?.inputSchema?.properties || {};
  const req = new Set(t?.inputSchema?.required || []);
  for (const [k, v] of Object.entries(props)) addParam(k, v.type, v.description, req.has(k));
  const exType = t?.executor?.type || 'http';
  document.getElementById('f-executor-type').value = exType;
  switchExecutor(exType);
  if (exType === 'http') {
    document.getElementById('f-http-url').value = t?.executor?.url || '';
    document.getElementById('f-http-method').value = t?.executor?.method || 'POST';
    document.getElementById('f-http-headers').value = t?.executor?.headers ? JSON.stringify(t.executor.headers) : '';
  } else {
    document.getElementById('f-shell-cmd').value = t?.executor?.command || '';
    document.getElementById('f-shell-cwd').value = t?.executor?.cwd || '';
    document.getElementById('f-shell-timeout').value = t?.executor?.timeout || '';
  }
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); editingId = null; }
function maybeClose(e) { if (e.target === document.getElementById('modal-overlay')) closeModal(); }
function editTool(id) { const t = tools.find(x => x.id === id); if (t) openModal(t); }
function switchExecutor(v) {
  document.getElementById('exec-http').classList.toggle('active', v === 'http');
  document.getElementById('exec-shell').classList.toggle('active', v === 'shell');
}

let pi = 0;
function addParam(name, type, desc, required) {
  const id = pi++;
  const tr = document.createElement('tr');
  tr.id = 'pr-' + id;
  tr.innerHTML = \`
    <td><input class="pname" value="\${name||''}" placeholder="param_name"/></td>
    <td><select class="ptype">
      <option value="string" \${!type||type==='string'?'selected':''}>string</option>
      <option value="number" \${type==='number'?'selected':''}>number</option>
      <option value="integer" \${type==='integer'?'selected':''}>integer</option>
      <option value="boolean" \${type==='boolean'?'selected':''}>boolean</option>
      <option value="array" \${type==='array'?'selected':''}>array</option>
    </select></td>
    <td><input class="pdesc" value="\${desc||''}" placeholder="What this parameter does"/></td>
    <td class="td-req"><input type="checkbox" class="preq" \${required?'checked':''}></td>
    <td class="td-del"><button class="del-param" onclick="document.getElementById('pr-\${id}').remove()">×</button></td>\`;
  document.getElementById('params-body').appendChild(tr);
}

function collectParams() {
  const props = {}, req = [];
  for (const row of document.getElementById('params-body').rows) {
    const name = row.querySelector('.pname').value.trim();
    if (!name) continue;
    const type = row.querySelector('.ptype').value;
    const desc = row.querySelector('.pdesc').value.trim();
    props[name] = { type, ...(desc ? { description: desc } : {}) };
    if (row.querySelector('.preq').checked) req.push(name);
  }
  return { type: 'object', properties: props, ...(req.length ? { required: req } : {}) };
}

async function saveTool() {
  const errEl = document.getElementById('form-error');
  errEl.style.display = 'none';
  const name = document.getElementById('f-name').value.trim();
  const description = document.getElementById('f-desc').value.trim();
  if (!name) { errEl.textContent = 'Name is required'; errEl.style.display = 'block'; return; }
  if (!description) { errEl.textContent = 'Description is required'; errEl.style.display = 'block'; return; }
  const exType = document.getElementById('f-executor-type').value;
  let executor;
  if (exType === 'http') {
    const url = document.getElementById('f-http-url').value.trim();
    if (!url) { errEl.textContent = 'URL is required'; errEl.style.display = 'block'; return; }
    const hr = document.getElementById('f-http-headers').value.trim();
    let headers;
    if (hr) { try { headers = JSON.parse(hr); } catch { errEl.textContent = 'Headers must be valid JSON'; errEl.style.display = 'block'; return; } }
    executor = { type: 'http', url, method: document.getElementById('f-http-method').value, ...(headers ? { headers } : {}) };
  } else {
    const command = document.getElementById('f-shell-cmd').value.trim();
    if (!command) { errEl.textContent = 'Command is required'; errEl.style.display = 'block'; return; }
    const cwd = document.getElementById('f-shell-cwd').value.trim();
    const timeout = parseInt(document.getElementById('f-shell-timeout').value) || undefined;
    executor = { type: 'shell', command, ...(cwd ? { cwd } : {}), ...(timeout ? { timeout } : {}) };
  }
  const body = { name, description, inputSchema: collectParams(), executor, enabled: true };
  const r = await fetch(editingId ? \`/api/tools/\${editingId}\` : '/api/tools', {
    method: editingId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) { errEl.textContent = data.error || 'Save failed'; errEl.style.display = 'block'; return; }
  if (editingId) tools = tools.map(t => t.id === editingId ? data : t);
  else tools.push(data);
  render(); closeModal(); toast(editingId ? 'Tool updated' : 'Tool created');
}

function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = isErr ? 'error' : 'success'; el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2500);
}

load();
</script>
</body>
</html>`;
}
