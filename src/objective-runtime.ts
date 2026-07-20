import { MobiusStore } from "./mobius-store.ts";
import {
  DEFAULT_BUDGET,
  DEFAULT_RETRY,
  TERMINAL_STATUSES,
  type CycleResult,
  type Objective,
  type ObjectiveInput,
  type RuntimeEvent,
} from "./mobius-types.ts";

export type CycleExecutor = (
  objective: Objective,
  events: RuntimeEvent[],
) => Promise<CycleResult>;

export type MobiusRuntimeOptions = {
  pollIntervalMs?: number;
  leaseMs?: number;
  workerId?: string;
};

export class MobiusRuntime {
  private readonly inFlight = new Set<string>();
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly workerId: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly store: MobiusStore,
    private readonly executor: CycleExecutor,
    options: MobiusRuntimeOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
  }

  start(): void {
    if (this.timer) return;
    const recovered = this.store.recoverInterrupted();
    if (recovered) console.log(`[mobius] Recovered ${recovered} interrupted objective(s)`);
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  create(input: ObjectiveInput): Objective {
    const objective = this.store.createObjective(input);
    if (objective.status === "queued") void this.tick();
    return objective;
  }

  emit(
    objectiveId: string,
    type: string,
    payload: Record<string, unknown> = {},
    options: { source?: string; dedupeKey?: string } = {},
  ): RuntimeEvent {
    const objective = this.requireObjective(objectiveId);
    const event = this.store.appendEvent(
      objectiveId,
      type,
      options.source ?? "external",
      payload,
      options.dedupeKey,
    );
    if (
      objective.status === "waiting"
      && (!objective.waitForEvent || objective.waitForEvent === type || objective.waitForEvent === "*")
    ) {
      this.store.updateObjective(objectiveId, {
        status: "queued",
        wakeAt: null,
        waitForEvent: null,
      });
      void this.tick();
    }
    return event;
  }

  resume(objectiveId: string): Objective {
    const objective = this.requireObjective(objectiveId);
    if (TERMINAL_STATUSES.has(objective.status)) {
      throw new Error(`Cannot resume ${objective.status} objective ${objectiveId}`);
    }
    const updated = this.store.updateObjective(objectiveId, {
      status: "queued",
      wakeAt: null,
      waitForEvent: null,
      lastError: null,
      failureCount: 0,
    });
    this.store.appendEvent(objectiveId, "objective.resumed", "control", {});
    void this.tick();
    return updated;
  }

  pause(objectiveId: string, reason = "Paused by operator"): Objective {
    const objective = this.requireObjective(objectiveId);
    if (TERMINAL_STATUSES.has(objective.status)) return objective;
    const updated = this.store.updateObjective(objectiveId, {
      status: "waiting",
      wakeAt: null,
      waitForEvent: "objective.resume",
    });
    this.store.appendEvent(objectiveId, "objective.paused", "control", { reason });
    return updated;
  }

  cancel(objectiveId: string, reason = "Cancelled by operator"): Objective {
    const updated = this.store.updateObjective(objectiveId, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      result: reason,
      wakeAt: null,
      waitForEvent: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    this.store.appendEvent(objectiveId, "objective.cancelled", "control", { reason });
    return updated;
  }

  async tick(): Promise<void> {
    const due = this.store.listDueObjectives();
    const runs = due
      .filter((objective) => !this.inFlight.has(objective.id))
      .map((objective) => this.runCycle(objective.id));
    await Promise.allSettled(runs);
  }

  private async runCycle(objectiveId: string): Promise<void> {
    this.inFlight.add(objectiveId);
    let claimed: Objective | null = null;
    let cycleStartedAt = 0;
    let runtimeRecorded = false;
    try {
      claimed = this.store.claimObjective(objectiveId, this.workerId, this.leaseMs);
      if (!claimed) return;
      cycleStartedAt = Date.now();

      const budget = { ...DEFAULT_BUDGET, ...claimed.budget };
      const elapsedMinutes = claimed.totalRuntimeMs / 60_000;
      if (claimed.cycleCount > budget.maxCycles) {
        this.failBudget(claimed, `Cycle budget exceeded (${budget.maxCycles})`);
        return;
      }
      if (claimed.totalCostUsd >= budget.maxCostUsd) {
        this.failBudget(claimed, `Cost budget reached ($${budget.maxCostUsd})`);
        return;
      }
      if (elapsedMinutes >= budget.maxMinutes) {
        this.failBudget(claimed, `Active runtime budget exceeded (${budget.maxMinutes} minutes)`);
        return;
      }
      if (this.store.countActions(objectiveId) >= budget.maxToolCalls) {
        this.failBudget(claimed, `Tool-call budget reached (${budget.maxToolCalls})`);
        return;
      }

      const events = this.store.pendingEvents(objectiveId);
      this.store.appendEvent(objectiveId, "cycle.started", "mobius", {
        cycle: claimed.cycleCount,
        eventIds: events.map((event) => event.id),
      });
      this.store.saveCheckpoint(objectiveId, claimed.cycleCount, {
        objective: claimed,
        plan: this.store.listSteps(objectiveId),
        memories: this.store.listMemories(objectiveId, claimed.memory.maxContextItems ?? 50),
      });

      const result = await this.executor(claimed, events);
      for (const event of events) this.store.consumeEvent(event.id);
      const current = this.requireObjective(objectiveId);
      this.store.updateObjective(objectiveId, {
        totalCostUsd: current.totalCostUsd + result.costUsd,
        totalTurns: current.totalTurns + result.turns,
        totalRuntimeMs: current.totalRuntimeMs + (Date.now() - cycleStartedAt),
      });
      runtimeRecorded = true;
      this.store.addMemory(objectiveId, {
        kind: "episodic",
        content: result.summary || `${result.transition.type} after cycle ${claimed.cycleCount}`,
        provenance: { cycle: claimed.cycleCount, eventIds: events.map((event) => event.id) },
      });
      this.applyTransition(claimed, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const objective = this.store.getObjective(objectiveId);
      if (objective && !TERMINAL_STATUSES.has(objective.status)) {
        if (cycleStartedAt && !runtimeRecorded) {
          this.store.updateObjective(objectiveId, {
            totalRuntimeMs: objective.totalRuntimeMs + (Date.now() - cycleStartedAt),
          });
        }
        this.applyRetry(objective, message);
      }
    } finally {
      if (claimed) this.store.releaseLease(objectiveId);
      this.inFlight.delete(objectiveId);
    }
  }

  private applyTransition(objective: Objective, result: CycleResult): void {
    const current = this.store.getObjective(objective.id);
    if (!current || TERMINAL_STATUSES.has(current.status)) return;
    const transition = result.transition;
    const timestamp = new Date().toISOString();
    switch (transition.type) {
      case "continue":
        this.store.updateObjective(objective.id, {
          status: "queued", wakeAt: null, waitForEvent: null, lastError: null,
          failureCount: 0,
        });
        break;
      case "wait":
        this.store.updateObjective(objective.id, {
          status: "waiting",
          wakeAt: transition.wakeAt ?? null,
          waitForEvent: transition.eventType ?? null,
          lastError: null,
          failureCount: 0,
        });
        break;
      case "block":
        this.store.updateObjective(objective.id, {
          status: "blocked", wakeAt: null, waitForEvent: null, lastError: transition.reason,
          failureCount: 0,
        });
        break;
      case "complete":
        this.store.updateObjective(objective.id, {
          status: "completed", completedAt: timestamp, result: transition.result,
          wakeAt: null, waitForEvent: null, lastError: null,
          failureCount: 0,
        });
        this.store.addOutcome(objective.id, {
          name: "objective",
          status: "satisfied",
          value: transition.result,
          evidence: transition.evidence ?? [],
        });
        break;
      case "fail":
        if (transition.retryable) this.applyRetry(objective, transition.error);
        else this.store.updateObjective(objective.id, {
          status: "failed", completedAt: timestamp, lastError: transition.error,
          wakeAt: null, waitForEvent: null,
        });
        break;
    }
    this.store.appendEvent(objective.id, `cycle.${transition.type}`, "mobius", {
      cycle: objective.cycleCount,
      transition,
      summary: result.summary,
      costUsd: result.costUsd,
      turns: result.turns,
    });
  }

  private applyRetry(objective: Objective, error: string): void {
    const retry = { ...DEFAULT_RETRY, ...(objective.policy.retry ?? {}) };
    const failureCount = objective.failureCount + 1;
    if (failureCount >= retry.maxAttempts) {
      this.store.updateObjective(objective.id, {
        status: "failed", completedAt: new Date().toISOString(), lastError: error,
        wakeAt: null, waitForEvent: null, failureCount,
      });
      this.store.appendEvent(objective.id, "objective.failed", "mobius", { error });
      return;
    }
    const delay = Math.min(
      retry.maxDelayMs,
      retry.initialDelayMs * Math.pow(retry.multiplier, Math.max(0, failureCount - 1)),
    );
    const wakeAt = new Date(Date.now() + delay).toISOString();
    this.store.updateObjective(objective.id, {
      status: "waiting", wakeAt, waitForEvent: null, lastError: error, failureCount,
    });
    this.store.appendEvent(objective.id, "cycle.retry_scheduled", "mobius", { error, wakeAt });
  }

  private failBudget(objective: Objective, error: string): void {
    this.store.updateObjective(objective.id, {
      status: "failed", completedAt: new Date().toISOString(), lastError: error,
      wakeAt: null, waitForEvent: null,
    });
    this.store.appendEvent(objective.id, "objective.budget_exceeded", "mobius", { error });
  }

  private requireObjective(id: string): Objective {
    const objective = this.store.getObjective(id);
    if (!objective) throw new Error(`Objective not found: ${id}`);
    return objective;
  }
}
