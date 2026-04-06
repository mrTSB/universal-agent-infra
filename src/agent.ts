import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { supportServer } from "./tools.ts";
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
  /** Full system prompt for the agent */
  systemPrompt: string;
  /** Working directory for the agent (the .mobius/ workspace) */
  cwd: string;
  /** The very first user message to send */
  initialMessage: string;
  /** Previous run state — injected as context on restart */
  previousState: RunState | null;
  /** Called every time a SDK event is emitted */
  onEvent: (event: SDKMessage) => void;
  /** Called when the agent produces a full text response (end of turn) */
  onMessage: (text: string) => Promise<void>;
  /** Called when a turn completes — use for state persistence */
  onTurnComplete: (result: TurnResult) => void;
};

// ---------------------------------------------------------------------------
// External message queue — Slack / CLI push messages here for steering
// ---------------------------------------------------------------------------

type ExternalMessage = { source: "slack" | "cli"; text: string };

const externalQueue: ExternalMessage[] = [];

/** Live query handle — used to interrupt the current turn */
let activeQuery: Query | null = null;

/**
 * Inject a steering message from an external source (Slack or CLI).
 * Interrupts the agent's current turn so the message is delivered immediately.
 */
export function injectMessage(source: "slack" | "cli", text: string): void {
  externalQueue.push({ source, text });

  // Interrupt the running turn so the reprompt (with this message) fires now
  if (activeQuery) {
    console.log(`[agent] Interrupting current turn to deliver ${source} message`);
    activeQuery.interrupt().catch((err: unknown) => {
      console.error("[agent] Interrupt failed:", err instanceof Error ? err.message : err);
    });
  }
}

function drainExternalMessages(): ExternalMessage[] {
  return externalQueue.splice(0);
}

// ---------------------------------------------------------------------------
// Turn tracking
// ---------------------------------------------------------------------------

const textChunks: string[] = [];
let turnResolve: (() => void) | null = null;
let currentSessionId = "";
let lastCostUsd = 0;
let lastNumTurns = 0;

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

// ---------------------------------------------------------------------------
// Build messages
// ---------------------------------------------------------------------------

function makeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user" as const,
    session_id: "",
    message: { role: "user" as const, content: [{ type: "text" as const, text }] },
    parent_tool_use_id: null,
  };
}

function buildInitialMessage(opts: AgentOptions): string {
  if (!opts.previousState) {
    return opts.initialMessage;
  }

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
    // Human messages take priority — lead with them
    const parts: string[] = [];
    parts.push("--- PRIORITY: Messages from your human team ---");
    for (const msg of pending) {
      const label = msg.source === "slack" ? "Human via Slack" : "Human via CLI";
      parts.push(`[${label}]: ${msg.text}`);
    }
    parts.push("--- End of human messages ---");
    parts.push("");
    parts.push(
      "Your current turn was interrupted to deliver the above message. " +
        "Address it immediately, then continue with your work."
    );
    return parts.join("\n");
  }

  return REPROMPT_MESSAGE;
}

// ---------------------------------------------------------------------------
// Async generator — self-reprompting input stream
// ---------------------------------------------------------------------------

async function* inputStream(opts: AgentOptions): AsyncGenerator<SDKUserMessage, void, unknown> {
  // 1. Yield the initial message
  yield makeUserMessage(buildInitialMessage(opts));

  // 2. Self-reprompting loop — runs forever
  while (true) {
    await waitForTurnComplete();

    // Flush accumulated text and notify listeners
    const fullText = textChunks.splice(0).join("");
    if (fullText) await opts.onMessage(fullText);

    opts.onTurnComplete({
      text: fullText,
      sessionId: currentSessionId,
      costUsd: lastCostUsd,
      numTurns: lastNumTurns,
    });

    // Drain any external messages and build the re-prompt
    const pending = drainExternalMessages();
    const reprompt = buildReprompt(pending);

    yield makeUserMessage(reprompt);
  }
}

// ---------------------------------------------------------------------------
// Background consumer — reads events from the query and dispatches them
// ---------------------------------------------------------------------------

function consumeEvents(q: AsyncIterable<SDKMessage>, onEvent: (event: SDKMessage) => void): void {
  void (async () => {
    for await (const event of q) {
      onEvent(event);

      // Track session ID from init events
      if (event.type === "system" && "subtype" in event && event.subtype === "init") {
        currentSessionId = event.session_id;
      }

      // Accumulate text from assistant messages
      const text = textFrom(event);
      if (text) textChunks.push(text);

      // Track cost & turns from result events, then signal turn complete
      if (event.type === "result") {
        lastCostUsd = event.total_cost_usd;
        lastNumTurns = event.num_turns;
        signalTurnComplete();
      }
    }

    // Query ended unexpectedly — flush whatever is left
    const fullText = textChunks.splice(0).join("");
    if (fullText && turnResolve) {
      signalTurnComplete();
    }
  })();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MODEL = process.env["CLAUDE_MODEL"] ?? "claude-sonnet-4-5-20250514";

// ---------------------------------------------------------------------------
// Browserbase MCP server — cloud browser for autonomous web interaction
// ---------------------------------------------------------------------------

function browserbaseMcpConfig(): Record<string, unknown> | null {
  const apiKey = process.env["BROWSERBASE_API_KEY"];
  const projectId = process.env["BROWSERBASE_PROJECT_ID"];
  if (!apiKey || !projectId) {
    console.warn(
      "[agent] BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID not set — browser disabled"
    );
    return null;
  }

  const env: Record<string, string> = {
    BROWSERBASE_API_KEY: apiKey,
    BROWSERBASE_PROJECT_ID: projectId,
  };

  // Gemini key for Stagehand's internal model (required for act/observe/agent tools)
  const geminiKey = process.env["GEMINI_API_KEY"];
  if (geminiKey) env["GEMINI_API_KEY"] = geminiKey;

  // Also pass Google Cloud / Vertex credentials in case Stagehand supports them
  const googleCreds = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
  if (googleCreds) env["GOOGLE_APPLICATION_CREDENTIALS"] = googleCreds;
  const vertexProject = process.env["ANTHROPIC_VERTEX_PROJECT_ID"];
  if (vertexProject) env["GOOGLE_CLOUD_PROJECT"] = vertexProject;
  const cloudRegion = process.env["CLOUD_ML_REGION"];
  if (cloudRegion) env["GOOGLE_CLOUD_REGION"] = cloudRegion;

  return {
    command: "npx",
    args: ["@browserbasehq/mcp-server-browserbase"],
    env,
  };
}

/** Tool names exposed by the Browserbase MCP server */
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

export function init(opts: AgentOptions): void {
  // Build MCP servers map
  const mcpServers: Record<string, unknown> = {
    support: supportServer,
  };
  const allowedTools = ["ping_human", "check_replies", "read_software_engineering_guide"];

  const bbConfig = browserbaseMcpConfig();
  if (bbConfig) {
    mcpServers["browserbase"] = bbConfig;
    allowedTools.push(...BROWSERBASE_TOOLS);
  }

  const q = query({
    prompt: inputStream(opts),
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
          prompt:
            "You are a research agent. Investigate the topic thoroughly and return a clear summary.",
          model: "sonnet",
        },
        coder: {
          description: "Implement code changes across multiple files",
          prompt:
            "You are a coding agent. Follow existing patterns. Run type-checks after changes.",
          model: "sonnet",
        },
      },
    },
  });

  // Store the query handle so we can interrupt it when human messages arrive
  activeQuery = q;

  consumeEvents(q, opts.onEvent);
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
