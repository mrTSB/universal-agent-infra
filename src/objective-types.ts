export type ObjectiveStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type MemoryKind = "working" | "episodic" | "semantic" | "procedural";

export type Budget = {
  maxCostUsd?: number;
  maxCycles?: number;
  maxTurnsPerCycle?: number;
  maxMinutes?: number;
  maxToolCalls?: number;
};

export type RetryPolicy = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
};

export type PolicyConfig = {
  allowedTools?: string[];
  deniedTools?: string[];
  approvalRequiredTools?: string[];
  approvalRiskLevel?: RiskLevel;
  defaultRiskLevel?: RiskLevel;
  toolRiskLevels?: Record<string, RiskLevel>;
  retry?: Partial<RetryPolicy>;
  workspaceOnly?: boolean;
};

export type MemoryConfig = {
  enabled?: boolean;
  maxContextItems?: number;
  kinds?: MemoryKind[];
};

export type AgentDefinition = {
  name: string;
  description?: string;
  model?: string;
  fallbackModel?: string;
  systemPrompt?: string;
  tools?: string[];
  subAgents?: Record<string, {
    description: string;
    prompt: string;
    model?: string;
    tools?: string[];
  }>;
};

export type Playbook = {
  name: string;
  version?: string;
  instructions?: string;
  steps?: Array<{
    title: string;
    description?: string;
    successCriteria?: string[];
    dependsOn?: string[];
  }>;
};

export type ObjectiveInput = {
  id?: string;
  goal: string;
  context?: string;
  successCriteria?: string[];
  priority?: number;
  agent?: Partial<AgentDefinition>;
  budget?: Budget;
  policy?: PolicyConfig;
  memory?: MemoryConfig;
  playbook?: Playbook;
  metadata?: Record<string, unknown>;
  start?: boolean;
};

export type Objective = {
  id: string;
  goal: string;
  context: string;
  successCriteria: string[];
  status: ObjectiveStatus;
  priority: number;
  agent: AgentDefinition;
  budget: Budget;
  policy: PolicyConfig;
  memory: MemoryConfig;
  playbook: Playbook | null;
  metadata: Record<string, unknown>;
  cycleCount: number;
  failureCount: number;
  totalCostUsd: number;
  totalTurns: number;
  totalRuntimeMs: number;
  wakeAt: string | null;
  waitForEvent: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  result: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  version: number;
};

export type PlanStep = {
  id: string;
  objectiveId: string;
  title: string;
  description: string;
  status: StepStatus;
  dependsOn: string[];
  successCriteria: string[];
  assignedAgent: string | null;
  attempts: number;
  maxAttempts: number;
  result: string | null;
  evidence: unknown[];
  createdAt: string;
  updatedAt: string;
};

export type RuntimeEvent = {
  id: string;
  objectiveId: string | null;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  createdAt: string;
  consumedAt: string | null;
};

export type ActionRecord = {
  id: string;
  objectiveId: string;
  cycle: number;
  tool: string;
  input: Record<string, unknown>;
  status: "pending" | "running" | "waiting_approval" | "succeeded" | "failed";
  risk: RiskLevel;
  idempotencyKey: string | null;
  attempts: number;
  maxAttempts: number;
  output: unknown;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type MemoryRecord = {
  id: string;
  objectiveId: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  provenance: Record<string, unknown>;
  createdAt: string;
  expiresAt: string | null;
};

export type OutcomeRecord = {
  id: string;
  objectiveId: string;
  name: string;
  status: "observed" | "satisfied" | "rejected" | "inconclusive";
  value: unknown;
  evidence: unknown[];
  createdAt: string;
};

export type ApprovalRecord = {
  id: string;
  objectiveId: string;
  actionId: string | null;
  status: ApprovalStatus;
  risk: RiskLevel;
  summary: string;
  payload: Record<string, unknown>;
  requestedAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  note: string | null;
};

export type CycleTransition =
  | { type: "continue"; reason?: string }
  | { type: "wait"; reason: string; wakeAt?: string; eventType?: string }
  | { type: "block"; reason: string }
  | { type: "complete"; result: string; evidence?: unknown[] }
  | { type: "fail"; error: string; retryable?: boolean };

export type CycleResult = {
  transition: CycleTransition;
  summary: string;
  sessionId?: string;
  costUsd: number;
  turns: number;
};

export type ToolAuthorization =
  | { behavior: "allow"; risk: RiskLevel; actionId: string }
  | { behavior: "deny"; reason: string; actionId: string }
  | { behavior: "approval"; approval: ApprovalRecord; actionId: string };

export const TERMINAL_STATUSES = new Set<ObjectiveStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export const DEFAULT_BUDGET: Required<Budget> = {
  maxCostUsd: 5,
  maxCycles: 100,
  maxTurnsPerCycle: 30,
  maxMinutes: 24 * 60,
  maxToolCalls: 1_000,
};

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
};
