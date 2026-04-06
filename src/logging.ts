import { ConvexHttpClient } from "convex/browser";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { api } from "../convex/_generated/api.js";

// ---------------------------------------------------------------------------
// Log entry type — the shape we write to Convex
// ---------------------------------------------------------------------------

export type LogEntry = {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
};

// ---------------------------------------------------------------------------
// Convex HTTP client
// ---------------------------------------------------------------------------

const CONVEX_URL = process.env["CONVEX_URL"];

let client: ConvexHttpClient | null = null;

function getClient(): ConvexHttpClient | null {
  if (client) return client;
  if (!CONVEX_URL) {
    console.warn("[logging] CONVEX_URL not set — log writes disabled");
    return null;
  }
  client = new ConvexHttpClient(CONVEX_URL);
  return client;
}

// ---------------------------------------------------------------------------
// Low-level write — fire-and-forget, never throws
// ---------------------------------------------------------------------------

function write(entry: LogEntry): void {
  const c = getClient();
  if (!c) return;

  c.mutation(api.logs.write, {
    ...entry,
    timestamp: new Date().toISOString(),
  }).catch((err: unknown) => {
    console.error("[logging] write failed:", err);
  });
}

// ---------------------------------------------------------------------------
// Pure event → log-entry mapping (exported for testing)
// ---------------------------------------------------------------------------

/** Convert an SDK event into zero or more log entries. Pure function. */
export function eventToLogEntries(event: SDKMessage): LogEntry[] {
  const entries: LogEntry[] = [];

  switch (event.type) {
    case "assistant": {
      for (const block of event.message.content) {
        if (block.type === "thinking") {
          entries.push({
            type: "thinking",
            content: block.thinking ?? "",
            sessionId: event.session_id,
          });
        } else if (block.type === "tool_use") {
          entries.push({
            type: "tool_use",
            content: block.name,
            metadata: {
              tool_use_id: block.id,
              input: block.input,
            },
            sessionId: event.session_id,
          });
        } else if (block.type === "text" && block.text) {
          entries.push({
            type: "assistant_text",
            content: block.text,
            sessionId: event.session_id,
          });
        }
      }
      break;
    }

    case "tool_use_summary": {
      entries.push({
        type: "tool_result",
        content: event.summary,
        metadata: {
          preceding_tool_use_ids: event.preceding_tool_use_ids,
        },
        sessionId: event.session_id,
      });
      break;
    }

    case "tool_progress": {
      entries.push({
        type: "tool_progress",
        content: event.tool_name,
        metadata: {
          tool_use_id: event.tool_use_id,
          elapsed_time_seconds: event.elapsed_time_seconds,
        },
        sessionId: event.session_id,
      });
      break;
    }

    case "result": {
      if (event.subtype === "success") {
        entries.push({
          type: "result",
          content: event.result ?? "",
          metadata: {
            subtype: event.subtype,
            duration_ms: event.duration_ms,
            duration_api_ms: event.duration_api_ms,
            num_turns: event.num_turns,
            total_cost_usd: event.total_cost_usd,
            usage: event.usage,
            stop_reason: event.stop_reason,
          },
          sessionId: event.session_id,
        });
      } else {
        entries.push({
          type: "result",
          content: event.errors?.join("\n") ?? "",
          metadata: {
            subtype: event.subtype,
            duration_ms: event.duration_ms,
            duration_api_ms: event.duration_api_ms,
            num_turns: event.num_turns,
            total_cost_usd: event.total_cost_usd,
            usage: event.usage,
          },
          sessionId: event.session_id,
        });
      }
      break;
    }

    case "system": {
      const subtype = "subtype" in event ? (event.subtype as string) : "unknown";
      entries.push({
        type: "system",
        content: subtype,
        metadata: { ...event } as unknown as Record<string, unknown>,
        sessionId: event.session_id,
      });
      break;
    }

    default:
      break;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API — called from main.ts callbacks
// ---------------------------------------------------------------------------

/** Log a raw SDK event. Breaks it into specific typed entries. */
export function logEvent(event: SDKMessage): void {
  for (const entry of eventToLogEntries(event)) {
    write(entry);
  }
}

/** Log a user message (called when Slack or CLI receives input). */
export function logUserMessage(text: string, sessionId?: string): void {
  write({ type: "user_message", content: text, sessionId });
}
