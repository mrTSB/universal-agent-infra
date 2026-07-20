import { createHash } from "node:crypto";
import { MobiusStore } from "./mobius-store.ts";
import {
  DEFAULT_RETRY,
  type Objective,
  type RiskLevel,
  type ToolAuthorization,
} from "./mobius-types.ts";

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

function stableInput(input: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(input));
}

export class MobiusPolicyEngine {
  constructor(private readonly store: MobiusStore) {}

  authorize(
    objective: Objective,
    tool: string,
    input: Record<string, unknown>,
    _toolUseId?: string,
    options: { shellExecutor?: boolean } = {},
  ): ToolAuthorization {
    const policy = objective.policy;
    const risk = policy.toolRiskLevels?.[tool] ?? policy.defaultRiskLevel ?? "low";
    const explicitKey = typeof input["idempotency_key"] === "string"
      ? input["idempotency_key"]
      : undefined;
    const key = explicitKey ?? createHash("sha256")
      .update(`${objective.id}:${tool}:${stableInput(input)}`)
      .digest("hex");
    const retry = { ...DEFAULT_RETRY, ...(policy.retry ?? {}) };
    const action = this.store.startAction(objective.id, {
      cycle: objective.cycleCount,
      tool,
      input,
      risk,
      idempotencyKey: key,
      maxAttempts: retry.maxAttempts,
    });

    const denied = policy.deniedTools?.includes(tool)
      || (policy.allowedTools?.length ? !policy.allowedTools.includes(tool) : false)
      || violatesWorkspacePolicy(
        policy.workspaceOnly === true,
        tool,
        input,
        options.shellExecutor === true,
      )
      || this.store.countActions(objective.id) > (objective.budget.maxToolCalls ?? Infinity);
    if (denied) {
      const reason = `Tool ${tool} is denied by objective policy or budget`;
      this.store.finishAction(action.id, "failed", undefined, reason);
      return { behavior: "deny", reason, actionId: action.id };
    }

    const existingApproval = this.store.approvalForAction(action.id);
    if (existingApproval?.status === "approved") {
      return { behavior: "allow", risk, actionId: action.id };
    }
    if (existingApproval?.status === "rejected") {
      const reason = existingApproval.note || `Approval rejected for ${tool}`;
      this.store.finishAction(action.id, "failed", undefined, reason);
      return { behavior: "deny", reason, actionId: action.id };
    }

    const threshold = policy.approvalRiskLevel ?? "high";
    const requiresApproval = policy.approvalRequiredTools?.includes(tool)
      || RISK_ORDER[risk] >= RISK_ORDER[threshold];
    if (requiresApproval) {
      const approval = existingApproval ?? this.store.requestApproval(objective.id, {
        actionId: action.id,
        risk,
        summary: `Allow ${tool} for objective: ${objective.goal}`,
        payload: { tool, input },
      });
      this.store.finishAction(action.id, "waiting_approval");
      return { behavior: "approval", approval, actionId: action.id };
    }

    return { behavior: "allow", risk, actionId: action.id };
  }

  complete(actionId: string, output: unknown): void {
    this.store.finishAction(actionId, "succeeded", output);
  }

  fail(actionId: string, error: string): void {
    this.store.finishAction(actionId, "failed", undefined, error);
  }
}

function violatesWorkspacePolicy(
  workspaceOnly: boolean,
  tool: string,
  input: Record<string, unknown>,
  shellExecutor: boolean,
): boolean {
  if (!workspaceOnly) return false;
  if (shellExecutor || tool.toLowerCase().includes("bash") || tool.toLowerCase().includes("shell")) {
    return true;
  }
  for (const [key, value] of Object.entries(input)) {
    if (!/(path|file|directory|cwd)/i.test(key) || typeof value !== "string") continue;
    if (value.startsWith("/") || value.split(/[\\/]/).includes("..")) return true;
  }
  return false;
}
