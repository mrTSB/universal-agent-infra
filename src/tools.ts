import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { CustomTool, HttpExecutor, ShellExecutor } from "./tool-registry.ts";

const GUIDE_PATH = path.resolve(import.meta.dirname, "..", "SOFTWARE_ENGINEERING_GUIDE.md");

// ---------------------------------------------------------------------------
// Per-instance support MCP server factory
// ---------------------------------------------------------------------------

type SupportServerOpts = {
  pingHuman: (message: string) => Promise<void>;
  checkReplies: () => Promise<string[]>;
  customTools?: CustomTool[];
  agentCwd?: string;
};

/**
 * Create a fresh MCP server instance for one agent run.
 * Each call returns a completely isolated server — no shared callback state.
 * User-defined custom tools are registered dynamically alongside built-ins.
 */
export function createSupportServer(opts: SupportServerOpts) {
  const builtins = [
    tool(
      "ping_human",
      "Send a proactive message to the human in the local UI. Use this frequently to share progress, ask questions, report milestones, and keep the human informed. If you asked a question, use check_replies shortly after to see if they responded.",
      { message: z.string().describe("The message to send to the human") },
      async ({ message }) => {
        console.log(`\n[ping_human] ${message}`);
        try {
          await opts.pingHuman(message);
          return {
            content: [
              {
                type: "text" as const,
                text: "Message sent to human in the local UI. If you asked a question, use check_replies in a subsequent turn to see their response.",
              },
            ],
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[ping_human] failed: ${errMsg}`);
          return {
            content: [
              { type: "text" as const, text: `Failed to send message: ${errMsg}` },
            ],
          };
        }
      }
    ),

    tool(
      "check_replies",
      "Check for new replies from the human via the local UI. Use after sending a ping_human that asks a question, or periodically to see if the human has responded with information, API keys, approvals, or steering input. Returns all unread messages.",
      {},
      async () => {
        try {
          const replies = await opts.checkReplies();
          if (replies.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No new replies yet. Keep working and check again later.",
                },
              ],
            };
          }
          const formatted = replies.map((r, i) => `Reply ${i + 1}: ${r}`).join("\n\n");
          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${replies.length} reply(ies) from the human:\n\n${formatted}\n\nIncorporate this into your work.`,
              },
            ],
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[check_replies] failed: ${errMsg}`);
          return {
            content: [
              { type: "text" as const, text: `Failed to check replies: ${errMsg}` },
            ],
          };
        }
      }
    ),

    tool(
      "read_software_engineering_guide",
      "Read the local software engineering guide. Use this before making major software architecture, backend, auth, API, deployment, or large implementation decisions.",
      {},
      async () => {
        try {
          const guide = fs.readFileSync(GUIDE_PATH, "utf-8");
          return { content: [{ type: "text" as const, text: guide }] };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: "text" as const, text: `Failed to read guide: ${errMsg}` },
            ],
          };
        }
      }
    ),
  ];

  // Register each enabled custom tool
  const enabled = (opts.customTools ?? []).filter((t) => t.enabled);
  const customEntries = enabled.map((ct) =>
    tool(ct.name, ct.description, buildZodShape(ct), makeHandler(ct, opts.agentCwd ?? "."))
  );

  return createSdkMcpServer({
    name: "mobius-support",
    tools: [...builtins, ...customEntries],
  });
}

// ---------------------------------------------------------------------------
// JSON Schema → Zod shape (for dynamic tool registration)
// ---------------------------------------------------------------------------

function buildZodShape(ct: CustomTool): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(ct.inputSchema.required ?? []);

  for (const [key, prop] of Object.entries(ct.inputSchema.properties ?? {})) {
    let t: z.ZodTypeAny;
    switch (prop.type) {
      case "number":
      case "integer":
        t = z.number();
        break;
      case "boolean":
        t = z.boolean();
        break;
      case "array":
        t = z.array(z.unknown());
        break;
      case "object":
        t = z.record(z.unknown());
        break;
      default:
        t = z.string();
    }
    if (prop.description) t = t.describe(prop.description);
    if (!required.has(key)) t = t.optional();
    shape[key] = t;
  }

  return shape;
}

// ---------------------------------------------------------------------------
// Executor handlers
// ---------------------------------------------------------------------------

function makeHandler(ct: CustomTool, agentCwd: string) {
  return async (input: Record<string, unknown>) => {
    try {
      const output =
        ct.executor.type === "http"
          ? await runHttp(ct.executor, input)
          : await runShell(ct.executor, input, agentCwd);

      console.log(`[custom-tool:${ct.name}] success`);
      return { content: [{ type: "text" as const, text: output }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[custom-tool:${ct.name}] error: ${msg}`);
      return { content: [{ type: "text" as const, text: `Tool error: ${msg}` }] };
    }
  };
}

async function runHttp(executor: HttpExecutor, input: Record<string, unknown>): Promise<string> {
  const method = executor.method ?? "POST";
  const isGet  = method === "GET";

  let url = executor.url;
  let body: string | undefined;

  if (isGet) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url = `${url}?${qs}`;
  } else {
    body = JSON.stringify(input);
  }

  const resp = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(executor.headers ?? {}) },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  return text;
}

async function runShell(
  executor: ShellExecutor,
  input: Record<string, unknown>,
  agentCwd: string
): Promise<string> {
  // Substitute {{param}} tokens — values are shell-quoted to prevent injection
  let cmd = executor.command;
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) {
      const safe = String(v).replace(/'/g, "'\\''");
      cmd = cmd.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), `'${safe}'`);
    }
  }

  const cwd     = executor.cwd ?? agentCwd;
  const timeout = executor.timeout ?? 30_000;

  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => { proc.kill(); reject(new Error(`Timed out after ${timeout}ms`)); }, timeout)
  );

  await Promise.race([proc.exited, timer]);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return (stdout + stderr).trim() || "(no output)";
}
