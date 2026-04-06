import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Run state — persisted to disk so the agent survives restarts
// ---------------------------------------------------------------------------

export type RunState = {
  /** Claude SDK session ID */
  sessionId: string;
  /** Total turns completed across all runs */
  turnCount: number;
  /** The agent's last result text (used as context on restart) */
  lastResult: string;
  /** ISO-8601 timestamp of the very first run */
  startedAt: string;
  /** Accumulated API cost in USD */
  totalCostUsd: number;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const STATE_PATH = path.join(PROJECT_ROOT, "state.json");
const WORKSPACE_DIR = path.join(PROJECT_ROOT, ".mobius");

export function getWorkspacePath(): string {
  return WORKSPACE_DIR;
}

// ---------------------------------------------------------------------------
// Load / Save / Clear
// ---------------------------------------------------------------------------

export function loadState(): RunState | null {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export function saveState(state: RunState): void {
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, STATE_PATH);
}

export function clearState(): void {
  try {
    fs.unlinkSync(STATE_PATH);
  } catch {
    // already gone — fine
  }
}

// ---------------------------------------------------------------------------
// Workspace initialisation
// ---------------------------------------------------------------------------

/**
 * Ensure the .mobius/ workspace directory exists and is a git repo.
 * Returns the absolute path.
 */
export async function ensureWorkspace(): Promise<string> {
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }

  const gitDir = path.join(WORKSPACE_DIR, ".git");
  if (!fs.existsSync(gitDir)) {
    const proc = Bun.spawn(["git", "init"], { cwd: WORKSPACE_DIR, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  }

  return WORKSPACE_DIR;
}
