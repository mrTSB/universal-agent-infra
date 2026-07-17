import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobiusStore } from "./mobius-store.ts";

const dirs: string[] = [];

function createStore(): MobiusStore {
  const dir = mkdtempSync(join(tmpdir(), "aeon-mobius-store-"));
  dirs.push(dir);
  return new MobiusStore(join(dir, "runtime.sqlite"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MobiusStore", () => {
  test("persists a customizable objective and playbook", () => {
    const store = createStore();
    const objective = store.createObjective({
      goal: "Maintain a healthy open-source project indefinitely",
      context: "Prefer small, verified changes.",
      successCriteria: ["Main branch remains green"],
      agent: {
        name: "maintainer",
        model: "claude-sonnet-4-6",
        tools: ["Read", "Bash"],
      },
      budget: { maxCycles: 20, maxCostUsd: 3 },
      policy: { approvalRequiredTools: ["deploy"], workspaceOnly: true },
      playbook: {
        name: "maintenance",
        version: "1",
        steps: [
          { title: "Observe repository health" },
          { title: "Repair the highest-impact issue", dependsOn: ["Observe repository health"] },
        ],
      },
    });

    expect(objective.status).toBe("queued");
    expect(objective.agent.name).toBe("maintainer");
    expect(objective.budget.maxCycles).toBe(20);
    const steps = store.listSteps(objective.id);
    expect(steps).toHaveLength(2);
    expect(steps[1]?.dependsOn).toEqual([steps[0]!.id]);

    store.close();
    const reopened = new MobiusStore(join(dirs[0]!, "runtime.sqlite"));
    expect(reopened.getObjective(objective.id)?.goal).toBe(objective.goal);
    expect(reopened.listSteps(objective.id)).toHaveLength(2);
    reopened.close();
  });

  test("deduplicates events and actions and records memory and outcomes", () => {
    const store = createStore();
    const objective = store.createObjective({ goal: "Watch a dependency for regressions" });

    const event1 = store.appendEvent(objective.id, "dependency.released", "webhook", { version: "2" }, "release-2");
    const event2 = store.appendEvent(objective.id, "dependency.released", "webhook", { version: "2" }, "release-2");
    expect(event2.id).toBe(event1.id);

    const action1 = store.startAction(objective.id, {
      cycle: 1,
      tool: "run_tests",
      input: { version: "2" },
      risk: "low",
      idempotencyKey: "test-release-2",
    });
    const action2 = store.startAction(objective.id, {
      cycle: 1,
      tool: "run_tests",
      input: { version: "2" },
      risk: "low",
      idempotencyKey: "test-release-2",
    });
    expect(action2.id).toBe(action1.id);
    expect(store.finishAction(action1.id, "succeeded", { passed: true }).status).toBe("succeeded");

    store.addMemory(objective.id, {
      kind: "semantic",
      content: "Version 2 passes the compatibility suite.",
      confidence: 0.95,
      provenance: { eventId: event1.id },
    });
    store.addOutcome(objective.id, {
      name: "compatibility",
      status: "satisfied",
      value: true,
      evidence: [action1.id],
    });
    expect(store.listMemories(objective.id)).toHaveLength(1);
    expect(store.listOutcomes(objective.id)[0]?.status).toBe("satisfied");
    store.close();
  });

  test("supports leases, approvals, and restart recovery", () => {
    const store = createStore();
    const objective = store.createObjective({ goal: "Safely rotate a service credential" });
    const claimed = store.claimObjective(objective.id, "worker-1", 30_000);
    expect(claimed?.status).toBe("running");
    expect(claimed?.cycleCount).toBe(1);
    expect(store.claimObjective(objective.id, "worker-2", 30_000)).toBeNull();

    const action = store.startAction(objective.id, {
      cycle: 1,
      tool: "rotate_secret",
      input: {},
      risk: "critical",
    });
    const approval = store.requestApproval(objective.id, {
      actionId: action.id,
      risk: "critical",
      summary: "Rotate the production credential",
    });
    expect(store.resolveApproval(approval.id, "approved", "operator").status).toBe("approved");

    expect(store.recoverInterrupted()).toBe(1);
    expect(store.getObjective(objective.id)?.status).toBe("queued");
    store.close();
  });
});
