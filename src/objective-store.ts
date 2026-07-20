import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_BUDGET,
  type ActionRecord,
  type ApprovalRecord,
  type ApprovalStatus,
  type MemoryKind,
  type MemoryRecord,
  type Objective,
  type ObjectiveInput,
  type ObjectiveStatus,
  type OutcomeRecord,
  type PlanStep,
  type RiskLevel,
  type RuntimeEvent,
  type StepStatus,
} from "./objective-types.ts";

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function encode(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class ObjectiveStore {
  readonly db: Database;

  constructor(path = process.env["AEON_DB_PATH"] ?? resolve(".agents", "aeon.sqlite")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS objectives (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        agent TEXT NOT NULL,
        budget TEXT NOT NULL,
        policy TEXT NOT NULL,
        memory TEXT NOT NULL,
        playbook TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        cycle_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        total_turns INTEGER NOT NULL DEFAULT 0,
        total_runtime_ms INTEGER NOT NULL DEFAULT 0,
        wake_at TEXT,
        wait_for_event TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        result TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS objectives_due ON objectives(status, wake_at, priority);

      CREATE TABLE IF NOT EXISTS plan_steps (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        depends_on TEXT NOT NULL DEFAULT '[]',
        success_criteria TEXT NOT NULL DEFAULT '[]',
        assigned_agent TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        result TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plan_steps_objective ON plan_steps(objective_id, status);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        objective_id TEXT REFERENCES objectives(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        dedupe_key TEXT,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        UNIQUE(objective_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS events_pending ON events(objective_id, consumed_at, created_at);

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        cycle INTEGER NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        risk TEXT NOT NULL,
        idempotency_key TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(objective_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS actions_objective ON actions(objective_id, cycle, status);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        provenance TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS memories_objective ON memories(objective_id, kind, created_at);

      CREATE TABLE IF NOT EXISTS outcomes (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        value TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outcomes_objective ON outcomes(objective_id, created_at);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        risk TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT,
        resolved_by TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_objective ON approvals(objective_id, status);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        cycle INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkpoints_objective ON checkpoints(objective_id, cycle);
    `);
    const objectiveColumns = this.db.query("PRAGMA table_info(objectives)").all() as Row[];
    if (!objectiveColumns.some((column) => column.name === "total_runtime_ms")) {
      this.db.exec("ALTER TABLE objectives ADD COLUMN total_runtime_ms INTEGER NOT NULL DEFAULT 0");
    }
    if (!objectiveColumns.some((column) => column.name === "failure_count")) {
      this.db.exec("ALTER TABLE objectives ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0");
    }
  }

  createObjective(input: ObjectiveInput): Objective {
    const id = input.id ?? crypto.randomUUID();
    const timestamp = now();
    const agent = {
      name: input.agent?.name ?? "aeon",
      description: typeof input.agent?.description === "string" ? input.agent.description : undefined,
      model: typeof input.agent?.model === "string" ? input.agent.model : undefined,
      fallbackModel: typeof input.agent?.fallbackModel === "string" ? input.agent.fallbackModel : undefined,
      systemPrompt: typeof input.agent?.systemPrompt === "string" ? input.agent.systemPrompt : undefined,
      tools: Array.isArray(input.agent?.tools) ? input.agent.tools : undefined,
      subAgents: input.agent?.subAgents && typeof input.agent.subAgents === "object"
        ? input.agent.subAgents
        : undefined,
    };
    const budget = { ...DEFAULT_BUDGET, ...(input.budget ?? {}) };
    this.db.run(
      `INSERT INTO objectives (
        id, goal, context, success_criteria, status, priority, agent, budget,
        policy, memory, playbook, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.goal.trim(), input.context ?? "", encode(input.successCriteria ?? []),
       input.start === false ? "waiting" : "queued", input.priority ?? 0, encode(agent),
       encode(budget), encode(input.policy ?? {}), encode(input.memory ?? { enabled: true }),
       input.playbook ? encode(input.playbook) : null, encode(input.metadata ?? {}), timestamp, timestamp]
    );

    const playbookSteps = (input.playbook?.steps ?? []).map((step) => ({
      ...step,
      id: crypto.randomUUID(),
    }));
    const stepIdsByTitle = new Map(playbookSteps.map((step) => [step.title, step.id]));
    for (const step of playbookSteps) {
      this.addStep(id, {
        ...step,
        dependsOn: (step.dependsOn ?? []).map(
          (dependency) => stepIdsByTitle.get(dependency) ?? dependency,
        ),
      });
    }
    this.appendEvent(id, "objective.created", "sdk", { goal: input.goal });
    return this.getObjective(id)!;
  }

  getObjective(id: string): Objective | null {
    const row = this.db.query("SELECT * FROM objectives WHERE id = ?").get(id) as Row | null;
    return row ? this.objectiveFromRow(row) : null;
  }

  listObjectives(statuses?: ObjectiveStatus[]): Objective[] {
    if (statuses?.length) {
      const marks = statuses.map(() => "?").join(",");
      return (this.db.query(`SELECT * FROM objectives WHERE status IN (${marks}) ORDER BY priority DESC, created_at ASC`)
        .all(...statuses) as Row[]).map((row) => this.objectiveFromRow(row));
    }
    return (this.db.query("SELECT * FROM objectives ORDER BY created_at DESC").all() as Row[])
      .map((row) => this.objectiveFromRow(row));
  }

  updateObjective(id: string, patch: Partial<{
    status: ObjectiveStatus;
    wakeAt: string | null;
    waitForEvent: string | null;
    result: string | null;
    lastError: string | null;
    completedAt: string | null;
    totalCostUsd: number;
    totalTurns: number;
    totalRuntimeMs: number;
    cycleCount: number;
    failureCount: number;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
  }>): Objective {
    const columns: Record<string, string> = {
      status: "status", wakeAt: "wake_at", waitForEvent: "wait_for_event",
      result: "result", lastError: "last_error", completedAt: "completed_at",
      totalCostUsd: "total_cost_usd", totalTurns: "total_turns",
      totalRuntimeMs: "total_runtime_ms",
      cycleCount: "cycle_count", leaseOwner: "lease_owner", leaseExpiresAt: "lease_expires_at",
      failureCount: "failure_count",
    };
    const entries = Object.entries(patch).filter(
      ([key, value]) => columns[key] && value !== undefined,
    );
    if (!entries.length) return this.requireObjective(id);
    const set = entries.map(([key]) => `${columns[key]} = ?`);
    const values = entries.map(([, value]) => value);
    set.push("updated_at = ?", "version = version + 1");
    values.push(now(), id);
    this.db.run(`UPDATE objectives SET ${set.join(", ")} WHERE id = ?`, values);
    return this.requireObjective(id);
  }

  claimObjective(id: string, owner: string, leaseMs: number): Objective | null {
    const timestamp = now();
    const expires = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.run(
      `UPDATE objectives SET lease_owner = ?, lease_expires_at = ?, status = 'running',
       cycle_count = cycle_count + 1, updated_at = ?, version = version + 1
       WHERE id = ? AND status IN ('queued', 'waiting')
       AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
      [owner, expires, timestamp, id, timestamp]
    );
    return result.changes > 0 ? this.getObjective(id) : null;
  }

  releaseLease(id: string): void {
    this.db.run(
      "UPDATE objectives SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      [now(), id]
    );
  }

  recoverInterrupted(): number {
    const result = this.db.run(
      `UPDATE objectives SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
       last_error = 'Recovered after runtime restart', updated_at = ?, version = version + 1
       WHERE status IN ('running', 'planning')`,
      [now()]
    );
    return result.changes;
  }

  listDueObjectives(at = now()): Objective[] {
    return (this.db.query(
      `SELECT * FROM objectives
       WHERE status = 'queued'
          OR (status = 'waiting' AND wake_at IS NOT NULL AND wake_at <= ?)
       ORDER BY priority DESC, created_at ASC`
    ).all(at) as Row[]).map((row) => this.objectiveFromRow(row));
  }

  appendEvent(
    objectiveId: string | null,
    type: string,
    source: string,
    payload: Record<string, unknown> = {},
    dedupeKey?: string,
  ): RuntimeEvent {
    if (dedupeKey) {
      const existing = this.db.query(
        "SELECT * FROM events WHERE objective_id IS ? AND dedupe_key = ?"
      ).get(objectiveId, dedupeKey) as Row | null;
      if (existing) return this.eventFromRow(existing);
    }
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO events (id, objective_id, type, source, payload, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, objectiveId, type, source, encode(payload), dedupeKey ?? null, now()]
    );
    return this.getEvent(id)!;
  }

  getEvent(id: string): RuntimeEvent | null {
    const row = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as Row | null;
    return row ? this.eventFromRow(row) : null;
  }

  pendingEvents(objectiveId: string): RuntimeEvent[] {
    return (this.db.query(
      "SELECT * FROM events WHERE objective_id = ? AND consumed_at IS NULL ORDER BY created_at ASC"
    ).all(objectiveId) as Row[]).map((row) => this.eventFromRow(row));
  }

  consumeEvent(id: string): void {
    this.db.run("UPDATE events SET consumed_at = ? WHERE id = ?", [now(), id]);
  }

  listEvents(objectiveId: string, limit = 200): RuntimeEvent[] {
    return (this.db.query(
      "SELECT * FROM events WHERE objective_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(objectiveId, limit) as Row[]).map((row) => this.eventFromRow(row));
  }

  addStep(objectiveId: string, input: {
    id?: string;
    title: string;
    description?: string;
    successCriteria?: string[];
    dependsOn?: string[];
    assignedAgent?: string;
    maxAttempts?: number;
  }): PlanStep {
    const id = input.id ?? crypto.randomUUID();
    const timestamp = now();
    this.db.run(
      `INSERT INTO plan_steps (id, objective_id, title, description, status, depends_on,
       success_criteria, assigned_agent, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [id, objectiveId, input.title, input.description ?? "", encode(input.dependsOn ?? []),
       encode(input.successCriteria ?? []), input.assignedAgent ?? null, input.maxAttempts ?? 3,
       timestamp, timestamp]
    );
    return this.getStep(id)!;
  }

  getStep(id: string): PlanStep | null {
    const row = this.db.query("SELECT * FROM plan_steps WHERE id = ?").get(id) as Row | null;
    return row ? this.stepFromRow(row) : null;
  }

  listSteps(objectiveId: string): PlanStep[] {
    return (this.db.query(
      "SELECT * FROM plan_steps WHERE objective_id = ? ORDER BY created_at ASC"
    ).all(objectiveId) as Row[]).map((row) => this.stepFromRow(row));
  }

  updateStep(id: string, patch: Partial<{
    status: StepStatus;
    result: string | null;
    evidence: unknown[];
    attempts: number;
    assignedAgent: string | null;
  }>): PlanStep {
    const columns: Record<string, string> = {
      status: "status", result: "result", evidence: "evidence",
      attempts: "attempts", assignedAgent: "assigned_agent",
    };
    const entries = Object.entries(patch).filter(
      ([key, value]) => columns[key] && value !== undefined,
    );
    if (!entries.length) return this.getStep(id)!;
    const values: Array<string | number | null> = entries.map(([key, value]) => {
      if (key === "evidence") return encode(value);
      if (value === null || typeof value === "string" || typeof value === "number") return value;
      return encode(value);
    });
    values.push(now(), id);
    this.db.run(
      `UPDATE plan_steps SET ${entries.map(([key]) => `${columns[key]} = ?`).join(", ")},
       updated_at = ? WHERE id = ?`, values
    );
    return this.getStep(id)!;
  }

  addMemory(objectiveId: string, input: {
    kind: MemoryKind;
    content: string;
    confidence?: number;
    provenance?: Record<string, unknown>;
    expiresAt?: string;
  }): MemoryRecord {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO memories (id, objective_id, kind, content, confidence, provenance, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, objectiveId, input.kind, input.content, input.confidence ?? 1,
       encode(input.provenance ?? {}), now(), input.expiresAt ?? null]
    );
    return this.getMemory(id)!;
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as Row | null;
    return row ? this.memoryFromRow(row) : null;
  }

  listMemories(objectiveId: string, limit = 50): MemoryRecord[] {
    return (this.db.query(
      `SELECT * FROM memories WHERE objective_id = ?
       AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ?`
    ).all(objectiveId, now(), limit) as Row[]).map((row) => this.memoryFromRow(row));
  }

  startAction(objectiveId: string, input: {
    cycle: number;
    tool: string;
    input: Record<string, unknown>;
    risk: RiskLevel;
    idempotencyKey?: string;
    maxAttempts?: number;
  }): ActionRecord {
    if (input.idempotencyKey) {
      const existing = this.db.query(
        "SELECT * FROM actions WHERE objective_id = ? AND idempotency_key = ?"
      ).get(objectiveId, input.idempotencyKey) as Row | null;
      if (existing) return this.actionFromRow(existing);
    }
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO actions (id, objective_id, cycle, tool, input, status, risk,
       idempotency_key, attempts, max_attempts, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, 1, ?, ?)`,
      [id, objectiveId, input.cycle, input.tool, encode(input.input), input.risk,
       input.idempotencyKey ?? null, input.maxAttempts ?? 3, now()]
    );
    return this.getAction(id)!;
  }

  getAction(id: string): ActionRecord | null {
    const row = this.db.query("SELECT * FROM actions WHERE id = ?").get(id) as Row | null;
    return row ? this.actionFromRow(row) : null;
  }

  finishAction(id: string, status: "succeeded" | "failed" | "waiting_approval", output?: unknown, error?: string): ActionRecord {
    this.db.run(
      "UPDATE actions SET status = ?, output = ?, error = ?, completed_at = ? WHERE id = ?",
      [status, output === undefined ? null : encode(output), error ?? null,
       status === "waiting_approval" ? null : now(), id]
    );
    return this.getAction(id)!;
  }

  listActions(objectiveId: string, limit = 200): ActionRecord[] {
    return (this.db.query(
      "SELECT * FROM actions WHERE objective_id = ? ORDER BY started_at DESC LIMIT ?"
    ).all(objectiveId, limit) as Row[]).map((row) => this.actionFromRow(row));
  }

  countActions(objectiveId: string): number {
    const row = this.db.query(
      "SELECT COUNT(*) AS count FROM actions WHERE objective_id = ?",
    ).get(objectiveId) as Row;
    return Number(row.count ?? 0);
  }

  addOutcome(objectiveId: string, input: {
    name: string;
    status: OutcomeRecord["status"];
    value?: unknown;
    evidence?: unknown[];
  }): OutcomeRecord {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO outcomes (id, objective_id, name, status, value, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, objectiveId, input.name, input.status,
       input.value === undefined ? null : encode(input.value), encode(input.evidence ?? []), now()]
    );
    return this.getOutcome(id)!;
  }

  getOutcome(id: string): OutcomeRecord | null {
    const row = this.db.query("SELECT * FROM outcomes WHERE id = ?").get(id) as Row | null;
    return row ? this.outcomeFromRow(row) : null;
  }

  listOutcomes(objectiveId: string): OutcomeRecord[] {
    return (this.db.query(
      "SELECT * FROM outcomes WHERE objective_id = ? ORDER BY created_at DESC"
    ).all(objectiveId) as Row[]).map((row) => this.outcomeFromRow(row));
  }

  requestApproval(objectiveId: string, input: {
    actionId?: string;
    risk: RiskLevel;
    summary: string;
    payload?: Record<string, unknown>;
    expiresAt?: string;
  }): ApprovalRecord {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO approvals (id, objective_id, action_id, status, risk, summary,
       payload, requested_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [id, objectiveId, input.actionId ?? null, input.risk, input.summary,
       encode(input.payload ?? {}), now(), input.expiresAt ?? null]
    );
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.db.query("SELECT * FROM approvals WHERE id = ?").get(id) as Row | null;
    return row ? this.approvalFromRow(row) : null;
  }

  resolveApproval(id: string, status: Extract<ApprovalStatus, "approved" | "rejected">, by: string, note?: string): ApprovalRecord {
    this.db.run(
      `UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, note = ?
       WHERE id = ? AND status = 'pending'`,
      [status, now(), by, note ?? null, id]
    );
    return this.getApproval(id)!;
  }

  listApprovals(objectiveId: string, status?: ApprovalStatus): ApprovalRecord[] {
    const rows = status
      ? this.db.query("SELECT * FROM approvals WHERE objective_id = ? AND status = ? ORDER BY requested_at DESC").all(objectiveId, status)
      : this.db.query("SELECT * FROM approvals WHERE objective_id = ? ORDER BY requested_at DESC").all(objectiveId);
    return (rows as Row[]).map((row) => this.approvalFromRow(row));
  }

  approvalForAction(actionId: string): ApprovalRecord | null {
    const row = this.db.query(
      "SELECT * FROM approvals WHERE action_id = ? ORDER BY requested_at DESC LIMIT 1"
    ).get(actionId) as Row | null;
    return row ? this.approvalFromRow(row) : null;
  }

  saveCheckpoint(objectiveId: string, cycle: number, state: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO checkpoints (id, objective_id, cycle, state, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, objectiveId, cycle, encode(state), now()]
    );
    return id;
  }

  private requireObjective(id: string): Objective {
    const objective = this.getObjective(id);
    if (!objective) throw new Error(`Objective not found: ${id}`);
    return objective;
  }

  private objectiveFromRow(row: Row): Objective {
    return {
      id: String(row.id), goal: String(row.goal), context: String(row.context ?? ""),
      successCriteria: json(row.success_criteria, []), status: row.status as ObjectiveStatus,
      priority: Number(row.priority), agent: json(row.agent, { name: "aeon" }),
      budget: json(row.budget, DEFAULT_BUDGET), policy: json(row.policy, {}),
      memory: json(row.memory, { enabled: true }), playbook: json(row.playbook, null),
      metadata: json(row.metadata, {}), cycleCount: Number(row.cycle_count),
      failureCount: Number(row.failure_count ?? 0),
      totalCostUsd: Number(row.total_cost_usd), totalTurns: Number(row.total_turns),
      totalRuntimeMs: Number(row.total_runtime_ms ?? 0),
      wakeAt: row.wake_at as string | null, waitForEvent: row.wait_for_event as string | null,
      leaseOwner: row.lease_owner as string | null, leaseExpiresAt: row.lease_expires_at as string | null,
      result: row.result as string | null, lastError: row.last_error as string | null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      completedAt: row.completed_at as string | null, version: Number(row.version),
    };
  }

  private stepFromRow(row: Row): PlanStep {
    return {
      id: String(row.id), objectiveId: String(row.objective_id), title: String(row.title),
      description: String(row.description ?? ""), status: row.status as StepStatus,
      dependsOn: json(row.depends_on, []), successCriteria: json(row.success_criteria, []),
      assignedAgent: row.assigned_agent as string | null, attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts), result: row.result as string | null,
      evidence: json(row.evidence, []), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private eventFromRow(row: Row): RuntimeEvent {
    return {
      id: String(row.id), objectiveId: row.objective_id as string | null, type: String(row.type),
      source: String(row.source), payload: json(row.payload, {}), dedupeKey: row.dedupe_key as string | null,
      createdAt: String(row.created_at), consumedAt: row.consumed_at as string | null,
    };
  }

  private actionFromRow(row: Row): ActionRecord {
    return {
      id: String(row.id), objectiveId: String(row.objective_id), cycle: Number(row.cycle),
      tool: String(row.tool), input: json(row.input, {}), status: row.status as ActionRecord["status"],
      risk: row.risk as RiskLevel, idempotencyKey: row.idempotency_key as string | null,
      attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts), output: json(row.output, null),
      error: row.error as string | null, startedAt: String(row.started_at),
      completedAt: row.completed_at as string | null,
    };
  }

  private memoryFromRow(row: Row): MemoryRecord {
    return {
      id: String(row.id), objectiveId: String(row.objective_id), kind: row.kind as MemoryKind,
      content: String(row.content), confidence: Number(row.confidence), provenance: json(row.provenance, {}),
      createdAt: String(row.created_at), expiresAt: row.expires_at as string | null,
    };
  }

  private outcomeFromRow(row: Row): OutcomeRecord {
    return {
      id: String(row.id), objectiveId: String(row.objective_id), name: String(row.name),
      status: row.status as OutcomeRecord["status"], value: json(row.value, null),
      evidence: json(row.evidence, []), createdAt: String(row.created_at),
    };
  }

  private approvalFromRow(row: Row): ApprovalRecord {
    return {
      id: String(row.id), objectiveId: String(row.objective_id), actionId: row.action_id as string | null,
      status: row.status as ApprovalStatus, risk: row.risk as RiskLevel, summary: String(row.summary),
      payload: json(row.payload, {}), requestedAt: String(row.requested_at),
      expiresAt: row.expires_at as string | null, resolvedAt: row.resolved_at as string | null,
      resolvedBy: row.resolved_by as string | null, note: row.note as string | null,
    };
  }
}
