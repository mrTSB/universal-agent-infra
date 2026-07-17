import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createSupportServer } from "./tools.ts";
import { REPROMPT_MESSAGE } from "./system-prompt.ts";
import type { RunState } from "./state.ts";
import type { CustomTool } from "./tool-registry.ts";
import type {
  CycleResult,
  CycleTransition,
  MemoryKind,
  StepStatus,
  ToolAuthorization,
} from "./mobius-types.ts";

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
  resumeSessionId?: string;
  model?: string;
  fallbackModel?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Called when the agent wants to notify the human (replaces Slack ping). */
  pingHuman: (message: string) => Promise<void>;
  /** Called when the agent wants to read pending human replies. */
  checkReplies: () => Promise<string[]>;
  /** User-defined custom tools to register for this run. */
  customTools?: CustomTool[];
  /**
   * Additional sub-agent definitions merged on top of the built-in researcher/coder pair.
   * Keys become the agent name; user-defined entries override defaults with the same name.
   */
  subAgents?: Record<string, {
    description: string;
    prompt: string;
    model?: string;
    tools?: string[];
  }>;
  onEvent: (event: SDKMessage) => void;
  onMessage: (text: string) => Promise<void>;
  onTurnComplete: (result: TurnResult) => void;
  onCycleComplete?: (result: CycleResult) => void | Promise<void>;
  onFailure?: (error: Error) => void | Promise<void>;
  onMemory?: (input: {
    kind: MemoryKind;
    content: string;
    confidence?: number;
    provenance?: Record<string, unknown>;
  }) => void | Promise<void>;
  onPlanStep?: (input: {
    id?: string;
    title?: string;
    description?: string;
    status?: StepStatus;
    result?: string;
    evidence?: unknown[];
  }) => string | Promise<string>;
  authorizeAction?: (
    tool: string,
    input: Record<string, unknown>,
    toolUseId?: string,
  ) => ToolAuthorization | Promise<ToolAuthorization>;
  completeAction?: (actionId: string, output: unknown) => void | Promise<void>;
  failAction?: (actionId: string, error: string) => void | Promise<void>;
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
  let lastResultText = "";
  let requestedTransition: CycleTransition | null = null;
  const authorizedActions = new Map<string, string>();
  let cycleSettled = false;
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

  async function settleCycle(transition: CycleTransition, summary: string): Promise<void> {
    if (cycleSettled) return;
    cycleSettled = true;
    await opts.onCycleComplete?.({
      transition,
      summary,
      sessionId: currentSessionId,
      costUsd: lastCostUsd,
      turns: lastNumTurns,
    });
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
    if (opts.resumeSessionId) return opts.initialMessage;
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

  // ── Bounded Mobius cycle input stream ─────────────────────────────────────

  async function* inputStream(): AsyncGenerator<SDKUserMessage, void, unknown> {
    yield makeUserMessage(buildInitialMessage());

    while (!stopped) {
      await waitForTurnComplete();

      // Exit the loop cleanly when stop() has been called
      if (stopped) return;

      const fullText = textChunks.splice(0).join("") || lastResultText;
      if (fullText) await opts.onMessage(fullText);

      opts.onTurnComplete({
        text: fullText,
        sessionId: currentSessionId,
        costUsd: lastCostUsd,
        numTurns: lastNumTurns,
      });

      const pending = drainExternalMessages();
      if (pending.length > 0) {
        yield makeUserMessage(buildReprompt(pending));
        continue;
      }

      const transition = requestedTransition ?? {
        type: "wait" as const,
        reason: "The bounded cycle ended without an explicit lifecycle transition.",
      };
      await settleCycle(transition, fullText);
      return;
    }
  }

  // ── Background event consumer ─────────────────────────────────────────────

  function consumeEvents(q: AsyncIterable<SDKMessage>): void {
    void (async () => {
      try {
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
            if (event.subtype === "success") {
              lastResultText = event.result ?? "";
            } else if (!requestedTransition) {
              requestedTransition = {
                type: "fail",
                error: event.errors?.join("\n") || event.subtype,
                retryable: event.subtype === "error_during_execution",
              };
            }
            signalTurnComplete();
          }

          if (event.type === "tool_use_summary") {
            for (const toolUseId of event.preceding_tool_use_ids) {
              const actionId = authorizedActions.get(toolUseId);
              if (actionId) {
                await opts.completeAction?.(actionId, { summary: event.summary });
                authorizedActions.delete(toolUseId);
              }
            }
          }

          if (event.type === "user" && Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
              if (block.type !== "tool_result") continue;
              const actionId = authorizedActions.get(block.tool_use_id);
              if (!actionId) continue;
              if (block.is_error) {
                await opts.failAction?.(actionId, JSON.stringify(block.content));
              } else {
                await opts.completeAction?.(actionId, block.content);
              }
              authorizedActions.delete(block.tool_use_id);
            }
          }
        }

        // Query ended — flush whatever is accumulated
        if ((textChunks.length > 0 || requestedTransition) && turnResolve) {
          signalTurnComplete();
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        requestedTransition = { type: "fail", error: err.message, retryable: true };
        signalTurnComplete();
        await opts.onFailure?.(err);
      }
    })();
  }

  // ── Start ─────────────────────────────────────────────────────────────────

  const enabledCustomTools = (opts.customTools ?? []).filter((t) => t.enabled);

  const supportServer = createSupportServer({
    pingHuman: opts.pingHuman,
    checkReplies: opts.checkReplies,
    customTools: enabledCustomTools,
    agentCwd: opts.cwd,
    transition: (transition) => { requestedTransition = transition; },
    remember: opts.onMemory,
    updatePlanStep: opts.onPlanStep,
    authorizeAction: opts.authorizeAction,
    completeAction: opts.completeAction,
    failAction: opts.failAction,
  });

  const mcpServers: Record<string, unknown> = { support: supportServer };
  const allowedTools = [
    "ping_human",
    "check_replies",
    "read_software_engineering_guide",
    "continue_objective",
    "wait_for_event",
    "complete_objective",
    "block_objective",
    "fail_objective",
    "remember",
    "update_plan_step",
    ...enabledCustomTools.map((t) => t.name),
  ];

  const bbConfig = browserbaseMcpConfig();
  if (bbConfig) {
    mcpServers["browserbase"] = bbConfig;
    if (!opts.authorizeAction) allowedTools.push(...BROWSERBASE_TOOLS);
  }

  const q = query({
    prompt: inputStream(),
    options: {
      model: opts.model ?? MODEL,
      fallbackModel: opts.fallbackModel,
      systemPrompt: opts.systemPrompt,
      cwd: opts.cwd,
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: opts.authorizeAction ? "default" : "bypassPermissions",
      allowDangerouslySkipPermissions: opts.authorizeAction ? undefined : true,
      allowedTools,
      canUseTool: opts.authorizeAction ? async (toolName, input, context) => {
        // Support-server lifecycle tools enforce their own policy where needed.
        if (toolName.startsWith("mcp__support__")) {
          return { behavior: "allow" as const };
        }
        const authorization = await opts.authorizeAction!(toolName, input, context.toolUseID);
        if (authorization.behavior === "allow") {
          authorizedActions.set(context.toolUseID, authorization.actionId);
          return { behavior: "allow" as const };
        }
        if (authorization.behavior === "approval") {
          requestedTransition = {
            type: "wait",
            reason: `Waiting for approval ${authorization.approval.id}: ${authorization.approval.summary}`,
            eventType: `approval.${authorization.approval.id}.resolved`,
          };
          return {
            behavior: "deny" as const,
            message: `Approval required: ${authorization.approval.id}`,
            interrupt: true,
          };
        }
        return { behavior: "deny" as const, message: authorization.reason };
      } : undefined,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      resume: opts.resumeSessionId,
      persistSession: true,
      enableFileCheckpointing: true,
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
        // User-defined sub-agents override defaults with the same name
        ...(opts.subAgents ?? {}),
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
      void settleCycle({
        type: "wait",
        reason: "Cycle interrupted by an operator.",
        eventType: "objective.resume",
      }, lastResultText);
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
      return null;
    default:
      return null;
  }
}
