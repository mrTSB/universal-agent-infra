import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createSupportServer } from "./tools.ts";
import { REPROMPT_MESSAGE } from "./system-prompt.ts";
import type { RunState } from "./state.ts";

export type { SDKMessage };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TurnResult = {
  text: string;
  sessionId: string;
  costUsd: number;
  numTurns: number;
};

export type AgentOptions = {
  systemPrompt: string;
  cwd: string;
  initialMessage: string;
  previousState: RunState | null;
  /** Called when the agent wants to notify the human (replaces Slack ping). */
  pingHuman: (message: string) => Promise<void>;
  /** Called when the agent wants to read pending human replies. */
  checkReplies: () => Promise<string[]>;
  onEvent: (event: SDKMessage) => void;
  onMessage: (text: string) => Promise<void>;
  onTurnComplete: (result: TurnResult) => void;
};

export type AgentHandle = {
  injectMessage: (source: "ui" | "cli", text: string) => void;
  stop: () => void;
};

// ---------------------------------------------------------------------------
// Browserbase MCP (optional, shared config builder — stateless)
// ---------------------------------------------------------------------------

function browserbaseMcpConfig(): Record<string, unknown> | null {
  const apiKey = process.env["BROWSERBASE_API_KEY"];
  const projectId = process.env["BROWSERBASE_PROJECT_ID"];
  if (!apiKey || !projectId) return null;

  const env: Record<string, string> = {
    BROWSERBASE_API_KEY: apiKey,
    BROWSERBASE_PROJECT_ID: projectId,
  };
  const geminiKey = process.env["GEMINI_API_KEY"];
  if (geminiKey) env["GEMINI_API_KEY"] = geminiKey;
  const googleCreds = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
  if (googleCreds) env["GOOGLE_APPLICATION_CREDENTIALS"] = googleCreds;

  return { command: "npx", args: ["@browserbasehq/mcp-server-browserbase"], env };
}

const BROWSERBASE_TOOLS = [
  "browserbase_stagehand_navigate",
  "browserbase_stagehand_act",
  "browserbase_stagehand_extract",
  "browserbase_stagehand_observe",
  "browserbase_screenshot",
  "browserbase_stagehand_get_url",
  "browserbase_session_create",
  "browserbase_session_close",
];

const MODEL = process.env["CLAUDE_MODEL"] ?? "claude-sonnet-4-5-20250514";

// ---------------------------------------------------------------------------
// Factory — returns a fully isolated agent instance
// ---------------------------------------------------------------------------

/**
 * Create an isolated agent instance.
 * Every call returns its own private state — no module-level globals are shared.
 * The returned handle starts running immediately; call stop() to terminate.
 */
export function createAgent(opts: AgentOptions): AgentHandle {
  // ── Per-instance state (no module-level globals) ──────────────────────────

  type ExternalMessage = { source: "ui" | "cli"; text: string };

  const externalQueue: ExternalMessage[] = [];
  let activeQuery: Query | null = null;
  const textChunks: string[] = [];
  let turnResolve: (() => void) | null = null;
  let currentSessionId = "";
  let lastCostUsd = 0;
  let lastNumTurns = 0;
  let stopped = false;

  // ── Message injection ─────────────────────────────────────────────────────

  function injectMessage(source: "ui" | "cli", text: string): void {
    externalQueue.push({ source, text });
    if (activeQuery) {
      activeQuery.interrupt().catch((err: unknown) => {
        console.error("[agent] Interrupt failed:", err instanceof Error ? err.message : err);
      });
    }
  }

  function drainExternalMessages(): ExternalMessage[] {
    return externalQueue.splice(0);
  }

  // ── Turn synchronisation ──────────────────────────────────────────────────

  function waitForTurnComplete(): Promise<void> {
    return new Promise<void>((resolve) => {
      turnResolve = resolve;
    });
  }

  function signalTurnComplete(): void {
    if (turnResolve) {
      const resolve = turnResolve;
      turnResolve = null;
      resolve();
    }
  }

  // ── Message builders ──────────────────────────────────────────────────────

  function makeUserMessage(text: string): SDKUserMessage {
    return {
      type: "user" as const,
      session_id: "",
      message: { role: "user" as const, content: [{ type: "text" as const, text }] },
      parent_tool_use_id: null,
    };
  }

  function buildInitialMessage(): string {
    if (!opts.previousState) return opts.initialMessage;
    const s = opts.previousState;
    return [
      "You have historical context from a previous autonomous run. It may or may not still be relevant.",
      "",
      `- Started: ${s.startedAt}`,
      `- Turns completed: ${s.turnCount}`,
      `- Total cost so far: $${s.totalCostUsd.toFixed(2)}`,
      "",
      "Last recorded result from that older run:",
      s.lastResult,
      "",
      "Treat the older run as background only. Follow the current human-directed objective over any previous self-assigned goal.",
      "",
      "---",
      "",
      opts.initialMessage,
    ].join("\n");
  }

  function buildReprompt(pending: ExternalMessage[]): string {
    if (pending.length > 0) {
      const parts: string[] = ["--- PRIORITY: Messages from your human team ---"];
      for (const msg of pending) {
        const label = msg.source === "ui" ? "Human via UI" : "Human via CLI";
        parts.push(`[${label}]: ${msg.text}`);
      }
      parts.push("--- End of human messages ---", "");
      parts.push(
        "Your current turn was interrupted to deliver the above message. " +
          "Address it immediately, then continue with your work."
      );
      return parts.join("\n");
    }
    return REPROMPT_MESSAGE;
  }

  // ── Self-reprompting input stream ─────────────────────────────────────────

  async function* inputStream(): AsyncGenerator<SDKUserMessage, void, unknown> {
    yield makeUserMessage(buildInitialMessage());

    while (true) {
      await waitForTurnComplete();

      // Exit the loop cleanly when stop() has been called
      if (stopped) return;

      const fullText = textChunks.splice(0).join("");
      if (fullText) await opts.onMessage(fullText);

      opts.onTurnComplete({
        text: fullText,
        sessionId: currentSessionId,
        costUsd: lastCostUsd,
        numTurns: lastNumTurns,
      });

      const pending = drainExternalMessages();
      yield makeUserMessage(buildReprompt(pending));
    }
  }

  // ── Background event consumer ─────────────────────────────────────────────

  function consumeEvents(q: AsyncIterable<SDKMessage>): void {
    void (async () => {
      for await (const event of q) {
        opts.onEvent(event);

        if (event.type === "system" && "subtype" in event && event.subtype === "init") {
          currentSessionId = event.session_id;
        }

        const text = textFrom(event);
        if (text) textChunks.push(text);

        if (event.type === "result") {
          lastCostUsd = event.total_cost_usd;
          lastNumTurns = event.num_turns;
          signalTurnComplete();
        }
      }

      // Query ended — flush whatever is accumulated
      if (textChunks.length > 0 && turnResolve) {
        signalTurnComplete();
      }
    })();
  }

  // ── Start ─────────────────────────────────────────────────────────────────

  const supportServer = createSupportServer({
    pingHuman: opts.pingHuman,
    checkReplies: opts.checkReplies,
  });

  const mcpServers: Record<string, unknown> = { support: supportServer };
  const allowedTools = ["ping_human", "check_replies", "read_software_engineering_guide"];

  const bbConfig = browserbaseMcpConfig();
  if (bbConfig) {
    mcpServers["browserbase"] = bbConfig;
    allowedTools.push(...BROWSERBASE_TOOLS);
  }

  const q = query({
    prompt: inputStream(),
    options: {
      model: MODEL,
      systemPrompt: opts.systemPrompt,
      cwd: opts.cwd,
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools,
      mcpServers: mcpServers as NonNullable<Parameters<typeof query>[0]["options"]>["mcpServers"],
      agents: {
        researcher: {
          description: "Research a topic by reading files, searching code, and browsing the web",
          prompt: "You are a research agent. Investigate the topic thoroughly and return a clear summary.",
          model: "sonnet",
        },
        coder: {
          description: "Implement code changes across multiple files",
          prompt: "You are a coding agent. Follow existing patterns. Run type-checks after changes.",
          model: "sonnet",
        },
      },
    },
  });

  activeQuery = q;
  consumeEvents(q);

  // ── Public handle ─────────────────────────────────────────────────────────

  return {
    injectMessage,
    stop() {
      stopped = true;
      if (activeQuery) {
        activeQuery.interrupt().catch(() => {});
        activeQuery = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textFrom(msg: SDKMessage): string | null {
  switch (msg.type) {
    case "assistant": {
      const parts: string[] = [];
      for (const block of msg.message.content) {
        if (block.type === "text") parts.push(block.text);
      }
      return parts.length > 0 ? parts.join("") : null;
    }
    case "result":
      if (msg.subtype === "success" && msg.result) return msg.result;
      return null;
    default:
      return null;
  }
}
