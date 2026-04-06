import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

const GUIDE_PATH = path.resolve(import.meta.dirname, "..", "SOFTWARE_ENGINEERING_GUIDE.md");

// ---------------------------------------------------------------------------
// Per-instance support MCP server factory
// ---------------------------------------------------------------------------

type SupportServerOpts = {
  pingHuman: (message: string) => Promise<void>;
  checkReplies: () => Promise<string[]>;
};

/**
 * Create a fresh MCP server instance for one agent run.
 * Each call returns a completely isolated server — no shared callback state.
 */
export function createSupportServer(opts: SupportServerOpts) {
  return createSdkMcpServer({
    name: "mobius-support",
    tools: [
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
    ],
  });
}
