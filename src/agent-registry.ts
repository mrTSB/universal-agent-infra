import type { ServerWebSocket } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentStatus = "starting" | "running" | "stopped";

export type AgentHandle = {
  injectMessage: (source: "ui" | "cli", text: string) => void;
  stop: () => void;
};

export type AgentRecord = {
  id: string;
  task: string;
  status: AgentStatus;
  createdAt: string;
  workspacePath: string;
  turnCount: number;
  totalCostUsd: number;
  lastResult: string;
  handle: AgentHandle | null;
  /** Connected WebSocket clients watching this agent. */
  wsClients: Set<ServerWebSocket<unknown>>;
  /** User messages buffered for the agent's check_replies tool. */
  pendingReplies: string[];
  /** All UI events emitted during this run — replayed to clients that reconnect. */
  chatHistory: unknown[];
};

// ---------------------------------------------------------------------------
// Registry — the single source of truth for all live agent runs
// ---------------------------------------------------------------------------

const _registry = new Map<string, AgentRecord>();

export function register(record: AgentRecord): void {
  _registry.set(record.id, record);
}

export function get(id: string): AgentRecord | undefined {
  return _registry.get(id);
}

export function list(): AgentRecord[] {
  return Array.from(_registry.values());
}

export function update(id: string, patch: Partial<AgentRecord>): void {
  const record = _registry.get(id);
  if (record) Object.assign(record, patch);
}

export function remove(id: string): void {
  _registry.delete(id);
}

// ---------------------------------------------------------------------------
// WebSocket broadcast helper
// ---------------------------------------------------------------------------

const HISTORY_CAP = 2000;

export function broadcast(agentId: string, data: unknown): void {
  const record = _registry.get(agentId);
  if (!record) return;

  // Always buffer — clients that reconnect will receive a full replay
  record.chatHistory.push(data);
  if (record.chatHistory.length > HISTORY_CAP) {
    record.chatHistory.splice(0, record.chatHistory.length - HISTORY_CAP);
  }

  if (record.wsClients.size === 0) return;
  const json = JSON.stringify(data);
  for (const ws of record.wsClients) {
    try {
      ws.send(json);
    } catch {
      record.wsClients.delete(ws);
    }
  }
}
