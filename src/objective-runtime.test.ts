import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectivePolicyEngine } from "./objective-policy.ts";
import { ObjectiveRuntime } from "./objective-runtime.ts";
import { ObjectiveStore } from "./objective-store.ts";
import type { CycleResult } from "./objective-types.ts";

const dirs: string[] = [];

function setup(executor: ConstructorParameters<typeof ObjectiveRuntime>[1]) {
  const dir = mkdtempSync(join(tmpdir(), "aeon-objective-runtime-"));
  dirs.push(dir);
  const store = new ObjectiveStore(join(dir, "runtime.sqlite"));
  const runtime = new ObjectiveRuntime(store, executor, { workerId: "test-worker" });
  return { store, runtime };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ObjectiveRuntime", () => {
  test("runs one bounded cycle and waits for a matching event", async () => {
    const results: CycleResult[] = [
      {
        transition: { type: "wait", reason: "Waiting for build", eventType: "build.finished" },
        summary: "Started the build.", costUsd: 0.01, turns: 1,
      },
      {
        transition: { type: "complete", result: "Build passed", evidence: ["ci:123"] },
        summary: "Verified the build result.", costUsd: 0.01, turns: 1,
      },
    ];
    const { store, runtime } = setup(async () => results.shift()!);
    const objective = runtime.create({ goal: "Keep the build green", start: false });
    runtime.resume(objective.id);
    await runtime.tick();
    expect(store.getObjective(objective.id)?.status).toBe("waiting");
    expect(store.getObjective(objective.id)?.waitForEvent).toBe("build.finished");

    runtime.emit(objective.id, "unrelated.event");
    await runtime.tick();
    expect(store.getObjective(objective.id)?.cycleCount).toBe(1);

    runtime.emit(objective.id, "build.finished", { passed: true }, { dedupeKey: "ci:123" });
    await runtime.tick();
    expect(store.getObjective(objective.id)?.status).toBe("completed");
    expect(store.listOutcomes(objective.id)[0]?.value).toBe("Build passed");
    expect(store.listMemories(objective.id)).toHaveLength(2);
    store.close();
  });

  test("enforces cycle budgets before runaway execution", async () => {
    let calls = 0;
    const { store, runtime } = setup(async () => {
      calls += 1;
      return { transition: { type: "continue" }, summary: "Again", costUsd: 0, turns: 1 };
    });
    const objective = runtime.create({ goal: "Never loop forever", budget: { maxCycles: 2 }, start: false });
    runtime.resume(objective.id);
    await runtime.tick();
    await runtime.tick();
    await runtime.tick();
    expect(calls).toBe(2);
    expect(store.getObjective(objective.id)?.status).toBe("failed");
    expect(store.getObjective(objective.id)?.lastError).toContain("Cycle budget exceeded");
    store.close();
  });

  test("counts active execution time instead of dormant wall-clock age", async () => {
    let calls = 0;
    const { store, runtime } = setup(async () => {
      calls += 1;
      return {
        transition: { type: "complete", result: "Awake and healthy" },
        summary: "Handled a wake event.", costUsd: 0, turns: 1,
      };
    });
    const objective = runtime.create({
      goal: "Remain dormant for years between useful events",
      budget: { maxMinutes: 0.01 },
      start: false,
    });
    store.db.run(
      "UPDATE objectives SET created_at = ? WHERE id = ?",
      ["2020-01-01T00:00:00.000Z", objective.id],
    );
    runtime.resume(objective.id);
    await runtime.tick();
    expect(calls).toBe(1);
    expect(store.getObjective(objective.id)?.status).toBe("completed");
    expect(store.getObjective(objective.id)?.totalRuntimeMs).toBeGreaterThanOrEqual(0);
    store.close();
  });

  test("retries consecutive failures instead of lifetime cycles", async () => {
    let calls = 0;
    const { store, runtime } = setup(async () => {
      calls += 1;
      return {
        transition: { type: "fail", error: "Transient dependency error", retryable: true },
        summary: "Dependency was unavailable.", costUsd: 0, turns: 1,
      };
    });
    const objective = runtime.create({
      goal: "Keep working after years of healthy cycles",
      budget: { maxCycles: 1_000 },
      policy: { retry: { maxAttempts: 3, initialDelayMs: 1 } },
      start: false,
    });
    store.db.run("UPDATE objectives SET cycle_count = 99 WHERE id = ?", [objective.id]);
    store.updateObjective(objective.id, { status: "queued" });
    await runtime.tick();
    expect(store.getObjective(objective.id)?.status).toBe("waiting");
    expect(store.getObjective(objective.id)?.failureCount).toBe(1);

    store.updateObjective(objective.id, { status: "queued", wakeAt: null });
    await runtime.tick();
    expect(store.getObjective(objective.id)?.failureCount).toBe(2);

    store.updateObjective(objective.id, { status: "queued", wakeAt: null });
    await runtime.tick();
    expect(calls).toBe(3);
    expect(store.getObjective(objective.id)?.status).toBe("failed");
    expect(store.getObjective(objective.id)?.failureCount).toBe(3);
    store.close();
  });

  test("turns high-risk tool calls into durable approvals", () => {
    const { store } = setup(async () => {
      throw new Error("not called");
    });
    const objective = store.createObjective({
      goal: "Deploy only with approval",
      policy: { toolRiskLevels: { deploy: "critical" }, approvalRiskLevel: "high" },
    });
    const policy = new ObjectivePolicyEngine(store);
    const decision = policy.authorize(objective, "deploy", { environment: "production" }, "call-1");
    expect(decision.behavior).toBe("approval");
    expect(store.listApprovals(objective.id, "pending")).toHaveLength(1);
    store.close();
  });

  test("enforces tool-call and workspace policies", () => {
    const { store } = setup(async () => {
      throw new Error("not called");
    });
    const policy = new ObjectivePolicyEngine(store);
    const capped = store.createObjective({
      goal: "Use at most one tool",
      budget: { maxToolCalls: 1 },
    });
    expect(policy.authorize(capped, "inspect", { target: "one" }).behavior).toBe("allow");
    expect(policy.authorize(capped, "inspect", { target: "two" }).behavior).toBe("deny");

    const contained = store.createObjective({
      goal: "Stay inside the workspace",
      policy: { workspaceOnly: true },
    });
    expect(policy.authorize(contained, "Read", { file_path: "notes.txt" }).behavior).toBe("allow");
    expect(policy.authorize(contained, "Read", { file_path: "../secret" }).behavior).toBe("deny");
    expect(policy.authorize(contained, "Bash", { command: "pwd" }).behavior).toBe("deny");
    store.close();
  });
});
