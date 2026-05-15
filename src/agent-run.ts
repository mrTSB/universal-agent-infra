import { createAgent, type TurnResult, type SDKMessage } from "./agent.ts";
import { createAgentStorage } from "./state.ts";
import { SYSTEM_PROMPT, INITIAL_MESSAGE } from "./system-prompt.ts";
import { formatEvent } from "./cli.ts";
import { logEvent } from "./logging.ts";
import * as registry from "./agent-registry.ts";
import { invalidate as invalidateAISummary } from "./ai-summary.ts";
import * as toolRegistry from "./tool-registry.ts";

// ---------------------------------------------------------------------------
// SDK event → UI broadcast
// ---------------------------------------------------------------------------

function broadcastSDKEvent(agentId: string, event: SDKMessage): void {
  const ts = Date.now();
  switch (event.type) {
    case "assistant": {
      for (const block of event.message.content) {
        if (block.type === "thinking") {
          registry.broadcast(agentId, { type: "thinking", ts });
        } else if (block.type === "tool_use") {
          const input = (
            typeof block.input === "object" && block.input !== null ? block.input : {}
          ) as Record<string, unknown>;
          registry.broadcast(agentId, { type: "tool_use", name: block.name, input, ts });
        }
      }
      break;
    }
    case "tool_use_summary":
      registry.broadcast(agentId, { type: "tool_result", summary: event.summary, ts });
      break;
    case "tool_progress":
      registry.broadcast(agentId, {
        type: "tool_progress",
        tool: event.tool_name,
        elapsed: event.elapsed_time_seconds,
        ts,
      });
      break;
    case "result":
      registry.broadcast(agentId, {
        type: "turn_complete",
        cost: "total_cost_usd" in event ? (event.total_cost_usd as number) : 0,
        turns: "num_turns" in event ? (event.num_turns as number) : 0,
        usage: "usage" in event ? (event as Record<string, unknown>)["usage"] : null,
        duration_ms: "duration_ms" in event ? (event as Record<string, unknown>)["duration_ms"] : null,
        stop_reason: "stop_reason" in event ? (event as Record<string, unknown>)["stop_reason"] : null,
        ts,
      });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Start a new isolated agent run
// ---------------------------------------------------------------------------

export type StartRunOptions = {
  /** Optional task description shown in the UI and injected into initial message. */
  task?: string;
  /** Optional sub-agent definitions for swarm runs. */
  subAgents?: Record<string, { description: string; prompt: string; model?: string }>;
  /**
   * Resume a previously stopped run.
   * If provided, this exact ID is reused so the existing workspace and state.json
   * are picked up automatically — the agent resumes from its last checkpoint.
   */
  resumeId?: string;
  /**
   * Hard cost ceiling in USD. The agent is stopped automatically the turn after
   * this threshold is crossed. Takes effect server-side — not just a prompt hint.
   */
  maxCostUsd?: number;
};

/**
 * Spawn a new isolated agent run (or resume an existing one via resumeId).
 * - Creates `.agents/<id>/workspace/` (git init'd) and `.agents/<id>/state.json`
 * - Registers the run in the global registry
 * - Returns immediately; agent runs asynchronously in the background
 */
export async function startRun(opts: StartRunOptions): Promise<registry.AgentRecord> {
  const id = opts.resumeId ?? crypto.randomUUID();
  const task = opts.task?.trim() || "No specific task provided — ask the human what they need.";

  const storage = createAgentStorage(id);
  const previousState = storage.load();

  // Register immediately so HTTP callers get a response before the workspace is ready
  const record: registry.AgentRecord = {
    id,
    task,
    status: "starting",
    createdAt: new Date().toISOString(),
    workspacePath: storage.workspacePath,
    turnCount: previousState?.turnCount ?? 0,
    totalCostUsd: previousState?.totalCostUsd ?? 0,
    lastResult: previousState?.lastResult ?? "",
    handle: null,
    wsClients: new Set(),
    pendingReplies: [],
    chatHistory: [],
  };

  registry.register(record);

  // Initialise workspace (async) then start the agent
  const workspacePath = await storage.ensureWorkspace();
  record.workspacePath = workspacePath;

  const initialMessage = task
    ? `${INITIAL_MESSAGE}\n\nYour specific task for this session:\n${task}`
    : INITIAL_MESSAGE;

  // Track the last cumulative cost the SDK reported so we can compute per-turn deltas.
  // The SDK's total_cost_usd is cumulative since query() was called — NOT per-turn.
  let lastReportedCostUsd = 0;

  const customTools = toolRegistry.list();

  const handle = createAgent({
    systemPrompt: SYSTEM_PROMPT,
    cwd: workspacePath,
    initialMessage,
    previousState,
    customTools,
    subAgents: opts.subAgents,

    pingHuman: async (message) => {
      registry.broadcast(id, { type: "ping", message, ts: Date.now() });
    },

    checkReplies: async () => {
      const rec = registry.get(id);
      if (!rec) return [];
      return rec.pendingReplies.splice(0);
    },

    onEvent: (event) => {
      formatEvent(event);
      logEvent(event);
      broadcastSDKEvent(id, event);
    },

    onMessage: async (text) => {
      registry.broadcast(id, { type: "agent_message", text, ts: Date.now() });
    },

    onTurnComplete: (result: TurnResult) => {
      const rec = registry.get(id);
      if (!rec) return;

      const turnCost = result.costUsd - lastReportedCostUsd;
      lastReportedCostUsd = result.costUsd;

      rec.turnCount++;
      rec.totalCostUsd += turnCost;
      if (result.text) rec.lastResult = result.text;

      storage.save({
        sessionId: result.sessionId || "",
        turnCount: rec.turnCount,
        lastResult: rec.lastResult,
        startedAt: rec.createdAt,
        totalCostUsd: rec.totalCostUsd,
      });

      invalidateAISummary(id); // stale after each turn

      console.log(
        `[run:${id.slice(0, 8)}] Turn ${rec.turnCount} — $${rec.totalCostUsd.toFixed(4)}`
      );

      // Hard budget enforcement — stop after the turn that crosses the ceiling
      if (opts.maxCostUsd !== undefined && rec.totalCostUsd >= opts.maxCostUsd) {
        console.warn(
          `[run:${id.slice(0, 8)}] Budget $${opts.maxCostUsd} reached ` +
          `(spent $${rec.totalCostUsd.toFixed(4)}) — stopping`
        );
        registry.broadcast(id, {
          type: "budget_exceeded",
          limit: opts.maxCostUsd,
          cost: rec.totalCostUsd,
          ts: Date.now(),
        });
        stopRun(id);
      }
    },
  });

  record.handle = handle;
  record.status = "running";

  console.log(`[manager] Agent ${id.slice(0, 8)} started — task: ${task.slice(0, 60)}`);
  return record;
}

// ---------------------------------------------------------------------------
// Stop a running agent
// ---------------------------------------------------------------------------

export function stopRun(id: string): boolean {
  const record = registry.get(id);
  if (!record) return false;

  record.handle?.stop();
  record.handle = null;
  record.status = "stopped";

  // Close all connected WebSocket clients
  for (const ws of record.wsClients) {
    try {
      ws.send(JSON.stringify({ type: "status", text: "Agent stopped" }));
      ws.close();
    } catch { /* ignore */ }
  }
  record.wsClients.clear();

  console.log(`[manager] Agent ${id.slice(0, 8)} stopped`);
  return true;
}
