import { init, type TurnResult } from "./agent.ts";
import { formatEvent, startCli } from "./cli.ts";
import { logEvent } from "./logging.ts";
import { startUIServer } from "./ui-server.ts";
import { SYSTEM_PROMPT, INITIAL_MESSAGE } from "./system-prompt.ts";
import { loadState, saveState, ensureWorkspace, type RunState } from "./state.ts";

// ---------------------------------------------------------------------------
// 1. Load previous state (if any)
// ---------------------------------------------------------------------------

const previousState = loadState();

if (previousState) {
  console.log(
    `[main] Resuming — ${previousState.turnCount} turns completed, ` +
      `$${previousState.totalCostUsd.toFixed(2)} spent so far`
  );
} else {
  console.log("[main] Starting fresh run");
}

// ---------------------------------------------------------------------------
// 2. Ensure .mobius/ workspace exists and is a git repo
// ---------------------------------------------------------------------------

const workspacePath = await ensureWorkspace();
console.log(`[main] Workspace: ${workspacePath}`);

// ---------------------------------------------------------------------------
// 3. Start local UI server (wires up ping_human / check_replies tools)
// ---------------------------------------------------------------------------

const ui = await startUIServer();

// ---------------------------------------------------------------------------
// 4. State tracking — updated on every turn
// ---------------------------------------------------------------------------

let currentState: RunState = previousState ?? {
  sessionId: "",
  turnCount: 0,
  lastResult: "",
  startedAt: new Date().toISOString(),
  totalCostUsd: 0,
};

function handleTurnComplete(result: TurnResult): void {
  currentState = {
    sessionId: result.sessionId || currentState.sessionId,
    turnCount: currentState.turnCount + 1,
    lastResult: result.text || currentState.lastResult,
    startedAt: currentState.startedAt,
    totalCostUsd: currentState.totalCostUsd + result.costUsd,
  };

  saveState(currentState);

  console.log(
    `[main] Turn ${currentState.turnCount} complete — ` +
      `session total: $${currentState.totalCostUsd.toFixed(2)}`
  );
}

// ---------------------------------------------------------------------------
// 5. Initialize the autonomous agent
// ---------------------------------------------------------------------------

init({
  systemPrompt: SYSTEM_PROMPT,
  cwd: workspacePath,
  initialMessage: INITIAL_MESSAGE,
  previousState,
  onEvent(event) {
    formatEvent(event);
    logEvent(event);
    ui.broadcastEvent(event);
  },
  async onMessage(text) {
    await ui.postMessage(text);
  },
  onTurnComplete: handleTurnComplete,
});

console.log("[main] Agent started — running autonomously");

// ---------------------------------------------------------------------------
// 6. Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`\n[main] ${signal} received — saving state and exiting`);
  saveState(currentState);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// 7. CLI is the foreground interface (optional, for debugging / steering)
// ---------------------------------------------------------------------------

await startCli();
