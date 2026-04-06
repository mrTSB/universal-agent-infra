import { describe, expect, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { eventToLogEntries, type LogEntry } from "./logging.ts";

// ---------------------------------------------------------------------------
// Helpers to build fake SDK events
// ---------------------------------------------------------------------------

function assistantEvent(
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >,
  sessionId = "sess-1"
) {
  return {
    type: "assistant" as const,
    message: {
      id: "msg-1",
      type: "message" as const,
      role: "assistant" as const,
      content,
      model: "claude-sonnet-4-5-20250514",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "uuid-1",
    session_id: sessionId,
  };
}

// ---------------------------------------------------------------------------
// Unit tests — eventToLogEntries (pure, no network)
// ---------------------------------------------------------------------------

describe("eventToLogEntries", () => {
  test("assistant text block produces assistant_text entry", () => {
    const event = assistantEvent([{ type: "text", text: "Hello world" }]);
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: "assistant_text",
      content: "Hello world",
      sessionId: "sess-1",
    });
  });

  test("assistant thinking block produces thinking entry", () => {
    const event = assistantEvent([{ type: "thinking", thinking: "Let me reason about this..." }]);
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: "thinking",
      content: "Let me reason about this...",
      sessionId: "sess-1",
    });
  });

  test("assistant tool_use block produces tool_use entry with args", () => {
    const event = assistantEvent([
      {
        type: "tool_use",
        id: "tu-123",
        name: "Read",
        input: { file_path: "/tmp/test.ts" },
      },
    ]);
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: "tool_use",
      content: "Read",
      metadata: {
        tool_use_id: "tu-123",
        input: { file_path: "/tmp/test.ts" },
      },
      sessionId: "sess-1",
    });
  });

  test("mixed content produces multiple entries in order", () => {
    const event = assistantEvent([
      { type: "thinking", thinking: "Hmm..." },
      { type: "text", text: "I will read the file." },
      {
        type: "tool_use",
        id: "tu-1",
        name: "Read",
        input: { file_path: "foo.ts" },
      },
    ]);
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(3);
    expect(entries[0]!.type).toBe("thinking");
    expect(entries[1]!.type).toBe("assistant_text");
    expect(entries[2]!.type).toBe("tool_use");
  });

  test("empty text block is skipped", () => {
    const event = assistantEvent([{ type: "text", text: "" }]);
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(0);
  });

  test("tool_use_summary produces tool_result entry", () => {
    const event = {
      type: "tool_use_summary" as const,
      summary: "Read 42 lines from foo.ts",
      preceding_tool_use_ids: ["tu-1", "tu-2"],
      uuid: "uuid-2",
      session_id: "sess-1",
    };
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: "tool_result",
      content: "Read 42 lines from foo.ts",
      metadata: { preceding_tool_use_ids: ["tu-1", "tu-2"] },
      sessionId: "sess-1",
    });
  });

  test("tool_progress produces tool_progress entry", () => {
    const event = {
      type: "tool_progress" as const,
      tool_use_id: "tu-5",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3.5,
      uuid: "uuid-3",
      session_id: "sess-1",
    };
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: "tool_progress",
      content: "Bash",
      metadata: {
        tool_use_id: "tu-5",
        elapsed_time_seconds: 3.5,
      },
      sessionId: "sess-1",
    });
  });

  test("result success produces result entry with usage metadata", () => {
    const event = {
      type: "result" as const,
      subtype: "success" as const,
      duration_ms: 5000,
      duration_api_ms: 4500,
      is_error: false,
      num_turns: 3,
      result: "Done! I edited the file.",
      stop_reason: "end_turn",
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
      modelUsage: {},
      permission_denials: [],
      uuid: "uuid-4",
      session_id: "sess-1",
    };
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("result");
    expect(entries[0]!.content).toBe("Done! I edited the file.");
    expect(entries[0]!.metadata?.subtype).toBe("success");
    expect(entries[0]!.metadata?.duration_ms).toBe(5000);
    expect(entries[0]!.metadata?.total_cost_usd).toBe(0.05);
    expect(entries[0]!.metadata?.num_turns).toBe(3);
    expect(entries[0]!.metadata?.stop_reason).toBe("end_turn");
  });

  test("result error produces result entry with error content", () => {
    const event = {
      type: "result" as const,
      subtype: "error_during_execution" as const,
      duration_ms: 2000,
      duration_api_ms: 1800,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: {},
      permission_denials: [],
      errors: ["Connection timeout", "Retry failed"],
      uuid: "uuid-5",
      session_id: "sess-1",
    };
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("result");
    expect(entries[0]!.content).toBe("Connection timeout\nRetry failed");
    expect(entries[0]!.metadata?.subtype).toBe("error_during_execution");
  });

  test("system init event produces system entry", () => {
    const event = {
      type: "system" as const,
      subtype: "init" as const,
      model: "claude-sonnet-4-5-20250514",
      cwd: "/tmp",
      tools: ["Read", "Write"],
      mcp_servers: [],
      permissionMode: "acceptEdits",
      claude_code_version: "1.0.0",
      apiKeySource: "env",
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      uuid: "uuid-6",
      session_id: "sess-1",
    };
    const entries = eventToLogEntries(event as any);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("system");
    expect(entries[0]!.content).toBe("init");
    expect(entries[0]!.sessionId).toBe("sess-1");
  });

  test("unknown event type produces no entries", () => {
    const event = { type: "auth_status", session_id: "sess-1", uuid: "u" } as any;
    const entries = eventToLogEntries(event);

    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — write to + read from live Convex backend
// ---------------------------------------------------------------------------

const CONVEX_URL = process.env["CONVEX_URL"];

describe.skipIf(!CONVEX_URL)("Convex integration", () => {
  const convex = new ConvexHttpClient(CONVEX_URL!);

  test("write and read back a user_message log", async () => {
    const tag = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await convex.mutation(api.logs.write, {
      type: "user_message",
      content: tag,
      timestamp: new Date().toISOString(),
      sessionId: "test-session",
    });

    // Query back — the log should appear in the recent results.
    const logs = await convex.query(api.logs.list, { limit: 10, type: "user_message" });
    const found = logs.find((l: { content: string }) => l.content === tag);
    expect(found).toBeDefined();
    expect(found!.type).toBe("user_message");
    expect(found!.sessionId).toBe("test-session");
  });

  test("write and read back a tool_use log with metadata", async () => {
    const tag = `test-tool-${Date.now()}`;

    await convex.mutation(api.logs.write, {
      type: "tool_use",
      content: tag,
      metadata: {
        tool_use_id: "tu-test-123",
        input: { file_path: "/tmp/test.txt", command: "echo hello" },
      },
      timestamp: new Date().toISOString(),
      sessionId: "test-session",
    });

    const logs = await convex.query(api.logs.list, { limit: 10, type: "tool_use" });
    const found = logs.find((l: { content: string }) => l.content === tag);
    expect(found).toBeDefined();
    expect(found!.metadata).toEqual({
      tool_use_id: "tu-test-123",
      input: { file_path: "/tmp/test.txt", command: "echo hello" },
    });
  });

  test("write and read back a result log with usage stats", async () => {
    const tag = `test-result-${Date.now()}`;

    await convex.mutation(api.logs.write, {
      type: "result",
      content: tag,
      metadata: {
        subtype: "success",
        duration_ms: 1234,
        total_cost_usd: 0.02,
        num_turns: 2,
      },
      timestamp: new Date().toISOString(),
    });

    const logs = await convex.query(api.logs.list, { limit: 10, type: "result" });
    const found = logs.find((l: { content: string }) => l.content === tag);
    expect(found).toBeDefined();
    expect(found!.metadata.subtype).toBe("success");
    expect(found!.metadata.duration_ms).toBe(1234);
    expect(found!.metadata.total_cost_usd).toBe(0.02);
  });

  test("list with type filter only returns matching entries", async () => {
    const tag = `filter-test-${Date.now()}`;

    // Write one of each type.
    await Promise.all([
      convex.mutation(api.logs.write, {
        type: "thinking",
        content: `${tag}-thinking`,
        timestamp: new Date().toISOString(),
      }),
      convex.mutation(api.logs.write, {
        type: "assistant_text",
        content: `${tag}-text`,
        timestamp: new Date().toISOString(),
      }),
    ]);

    const thinkingLogs = await convex.query(api.logs.list, { limit: 5, type: "thinking" });
    const found = thinkingLogs.find((l: { content: string }) => l.content === `${tag}-thinking`);
    expect(found).toBeDefined();

    // The assistant_text entry should NOT show up in thinking filter.
    const wrongType = thinkingLogs.find((l: { content: string }) => l.content === `${tag}-text`);
    expect(wrongType).toBeUndefined();
  });
});
