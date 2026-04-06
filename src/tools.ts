import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// ping_human — lets the agent message the human on Slack proactively
// ---------------------------------------------------------------------------

let pingHumanFn: ((msg: string) => Promise<void>) | null = null;

export function setPingHuman(fn: (msg: string) => Promise<void>): void {
  pingHumanFn = fn;
  console.log("[tools] ping_human wired to local UI");
}

// ---------------------------------------------------------------------------
// check_replies — lets the agent fetch replies to its recent Slack pings
// ---------------------------------------------------------------------------

let checkRepliesFn: (() => Promise<string[]>) | null = null;

export function setCheckReplies(fn: () => Promise<string[]>): void {
  checkRepliesFn = fn;
  console.log("[tools] check_replies wired to local UI");
}

// ---------------------------------------------------------------------------
// Static guide lookup
// ---------------------------------------------------------------------------

const SOFTWARE_ENGINEERING_GUIDE_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "SOFTWARE_ENGINEERING_GUIDE.md"
);

// ---------------------------------------------------------------------------
// MCP Server with support tools
// ---------------------------------------------------------------------------

export const supportServer = createSdkMcpServer({
  name: "mobius-support",
  tools: [
    tool(
      "ping_human",
      "Send a proactive message to the human in the local UI. Use this frequently to share progress, ask questions, report milestones, and keep the human informed. If you asked a question, use check_replies shortly after to see if they responded.",
      { message: z.string().describe("The message to send to the human") },
      async ({ message }) => {
        console.log(`\n[ping_human] ${message}`);

        if (!pingHumanFn) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Logged to console (UI not connected). The message may not have been seen.",
              },
            ],
          };
        }

        try {
          await pingHumanFn(message);
          return {
            content: [
              { type: "text" as const, text: "Message sent to human in the local UI. If you asked a question, use check_replies in a subsequent turn to see their response." },
            ],
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[ping_human] UI post failed: ${errMsg}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to send message: ${errMsg}. The message was logged to console instead.`,
              },
            ],
          };
        }
      }
    ),

    tool(
      "check_replies",
      "Check for new replies from the human via the local UI. Use this after sending a ping_human that asks a question, or periodically to see if the human has responded with information, API keys, approvals, or steering input. Returns all unread messages.",
      {},
      async () => {
        if (!checkRepliesFn) {
          return {
            content: [
              {
                type: "text" as const,
                text: "UI not connected — cannot check replies.",
              },
            ],
          };
        }

        try {
          const replies = await checkRepliesFn();

          if (replies.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No new replies from the human team yet. They may not have seen your message yet — keep working and check again later.",
                },
              ],
            };
          }

          const formatted = replies.map((r, i) => `Reply ${i + 1}: ${r}`).join("\n\n");
          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${replies.length} new reply(ies) from the human team:\n\n${formatted}\n\nProcess this information and incorporate it into your work.`,
              },
            ],
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[check_replies] failed: ${errMsg}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to check replies: ${errMsg}`,
              },
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
          const guide = fs.readFileSync(SOFTWARE_ENGINEERING_GUIDE_PATH, "utf-8");
          return {
            content: [
              {
                type: "text" as const,
                text: guide,
              },
            ],
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to read software engineering guide: ${errMsg}`,
              },
            ],
          };
        }
      }
    ),
  ],
});
