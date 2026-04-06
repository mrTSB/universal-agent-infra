import * as readline from "node:readline";
import * as path from "node:path";
import { injectMessage, type SDKMessage } from "./agent.ts";
import { logUserMessage } from "./logging.ts";

// ANSI
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Tool use formatting — one clean line per tool call
// ---------------------------------------------------------------------------

function formatToolUse(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read": {
      const file = input["file_path"] as string | undefined;
      return file ? `📖 Read ${basename(file)}` : "📖 Read";
    }
    case "Write": {
      const file = input["file_path"] as string | undefined;
      return file ? `📝 Write ${basename(file)}` : "📝 Write";
    }
    case "Edit": {
      const file = input["file_path"] as string | undefined;
      const oldStr = (input["old_string"] as string) ?? "";
      const newStr = (input["new_string"] as string) ?? "";
      const added = newStr.split("\n").length;
      const removed = oldStr.split("\n").length;
      const label = file ? basename(file) : "file";
      return `✏️  Edit ${label} ${GREEN}+${added}${RESET} ${CYAN}${DIM}-${removed}${RESET}`;
    }
    case "Bash": {
      const cmd = input["command"] as string | undefined;
      const desc = input["description"] as string | undefined;
      if (desc) return `$ ${desc}`;
      return cmd ? `$ ${truncate(cmd, 80)}` : "$ (command)";
    }
    case "Grep": {
      const pattern = input["pattern"] as string | undefined;
      const p = input["path"] as string | undefined;
      const where = p ? ` in ${basename(p)}` : "";
      return `🔍 Grep "${pattern ?? "..."}"${where}`;
    }
    case "Glob": {
      const pattern = input["pattern"] as string | undefined;
      const p = input["path"] as string | undefined;
      const where = p ? ` in ${basename(p)}` : "";
      return `🔍 Glob "${pattern ?? "..."}"${where}`;
    }
    case "WebSearch": {
      const q = input["query"] as string | undefined;
      return `🌐 Search "${truncate(q ?? "...", 60)}"`;
    }
    case "WebFetch": {
      const url = input["url"] as string | undefined;
      return `🌐 Fetch ${truncate(url ?? "...", 70)}`;
    }
    case "Task": {
      const desc = input["description"] as string | undefined;
      const type = input["subagent_type"] as string | undefined;
      const label = type ? `${MAGENTA}${type}${RESET}` : "";
      return `🤖 Task ${label} ${desc ?? ""}`.trim();
    }
    case "TodoWrite":
      return "📋 Updated todos";
    case "NotebookEdit": {
      const file = input["notebook_path"] as string | undefined;
      return `📓 Edit notebook ${file ? basename(file) : ""}`.trim();
    }
    case "ping_human": {
      const msg = input["message"] as string | undefined;
      return `📢 Ping human: ${truncate(msg ?? "", 60)}`;
    }
    case "check_replies":
      return "📬 Checking for human replies...";
    case "read_software_engineering_guide":
      return "📘 Read software engineering guide";
    
    // Browserbase tools
    case "browserbase_session_create":
      return "🌐 Browser: new session";
    case "browserbase_session_close":
      return "🌐 Browser: close session";
    case "browserbase_stagehand_navigate": {
      const url = input["url"] as string | undefined;
      return `🌐 Browser: navigate ${truncate(url ?? "...", 60)}`;
    }
    case "browserbase_stagehand_act": {
      const action = input["action"] as string | undefined;
      return `🌐 Browser: ${truncate(action ?? "act", 70)}`;
    }
    case "browserbase_stagehand_extract":
      return "🌐 Browser: extract page content";
    case "browserbase_stagehand_observe":
      return "🌐 Browser: observe elements";
    case "browserbase_screenshot":
      return "🌐 Browser: screenshot";
    case "browserbase_stagehand_get_url":
      return "🌐 Browser: get URL";
    default:
      return `🔧 ${toolName}`;
  }
}

function basename(filePath: string): string {
  return path.basename(filePath);
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

// ---------------------------------------------------------------------------
// Event formatting — exported so main.ts can wire it into onEvent
// ---------------------------------------------------------------------------

export function formatEvent(event: SDKMessage): void {
  switch (event.type) {
    case "assistant": {
      for (const block of event.message.content) {
        if (block.type === "thinking") {
          process.stdout.write(`${DIM}💭 Thinking...${RESET}\n`);
        } else if (block.type === "tool_use") {
          const input = (
            typeof block.input === "object" && block.input !== null ? block.input : {}
          ) as Record<string, unknown>;
          process.stdout.write(`${CYAN}   ${formatToolUse(block.name, input)}${RESET}\n`);
        } else if (block.type === "text" && block.text) {
          process.stdout.write(`\n${BOLD}Mobius >${RESET} ${block.text}\n`);
        }
      }
      break;
    }
    case "tool_use_summary":
      process.stdout.write(`${GREEN}   ↳ ${event.summary}${RESET}\n`);
      break;
    case "tool_progress":
      process.stdout.write(
        `${YELLOW}   ⏳ ${event.tool_name} (${event.elapsed_time_seconds.toFixed(1)}s)${RESET}\n`
      );
      break;
    case "result":
      if (event.subtype === "success" && event.result) {
        process.stdout.write(`\n${BOLD}Mobius >${RESET} ${event.result}\n`);
      }
      process.stdout.write(`\n${DIM}[autonomous — type to steer]${RESET} `);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point — steering input (not the main message loop)
// ---------------------------------------------------------------------------

export async function startCli(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write(`\n${DIM}[autonomous — type to steer]${RESET} `);

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      process.stdout.write(`${DIM}[autonomous — type to steer]${RESET} `);
      return;
    }
    if (trimmed.toLowerCase() === "exit") {
      rl.close();
      return;
    }
    logUserMessage(trimmed);
    injectMessage("cli", trimmed);
    process.stdout.write(
      `${GREEN}[sent — interrupting current turn]${RESET}\n${DIM}[autonomous — type to steer]${RESET} `
    );
  });

  await new Promise<void>((resolve) => rl.on("close", resolve));
}
