import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Run state — persisted per agent instance
// ---------------------------------------------------------------------------

export type RunState = {
  sessionId: string;
  turnCount: number;
  lastResult: string;
  startedAt: string;
  totalCostUsd: number;
};

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

/** Root directory that holds one sub-directory per agent run. */
export const AGENTS_DIR = path.join(PROJECT_ROOT, ".agents");

// ---------------------------------------------------------------------------
// Per-agent storage factory
// ---------------------------------------------------------------------------

export type AgentStorage = {
  /** Absolute path to this agent's isolated workspace (git-init'd on first use). */
  workspacePath: string;
  load: () => RunState | null;
  save: (state: RunState) => void;
  ensureWorkspace: () => Promise<string>;
};

/**
 * Create isolated storage for one agent run.
 * Layout:  .agents/<id>/state.json
 *          .agents/<id>/workspace/   ← agent's cwd
 */
export function createAgentStorage(agentId: string): AgentStorage {
  const agentDir = path.join(AGENTS_DIR, agentId);
  const statePath = path.join(agentDir, "state.json");
  const workspacePath = path.join(agentDir, "workspace");

  // Ensure the agent directory exists immediately
  fs.mkdirSync(agentDir, { recursive: true });

  return {
    workspacePath,

    load(): RunState | null {
      try {
        return JSON.parse(fs.readFileSync(statePath, "utf-8")) as RunState;
      } catch {
        return null;
      }
    },

    save(state: RunState): void {
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
      fs.renameSync(tmp, statePath);
    },

    async ensureWorkspace(): Promise<string> {
      if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
      }
      const gitDir = path.join(workspacePath, ".git");
      if (!fs.existsSync(gitDir)) {
        const proc = Bun.spawn(["git", "init"], {
          cwd: workspacePath,
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
      }
      return workspacePath;
    },
  };
}
