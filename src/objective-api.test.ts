import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "aeon-objective-api-"));
process.env["AEON_DB_PATH"] = join(testDir, "runtime.sqlite");

let api: typeof import("./objective-api.ts");
let service: typeof import("./objective-service.ts");

beforeAll(async () => {
  api = await import("./objective-api.ts");
  service = await import("./objective-service.ts");
});

afterAll(() => {
  service.objectiveRuntime.stop();
  service.objectiveStore.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("objective HTTP API", () => {
  test("creates and controls a customizable durable objective", async () => {
    const createdResponse = await request("POST", "/api/v1/objectives", {
      goal: "Maintain a verified operational readiness report",
      context: "This scenario is domain-neutral.",
      successCriteria: ["Every claim has evidence"],
      start: false,
      agent: {
        name: "readiness-agent",
        model: "claude-test",
        systemPrompt: "Prefer direct evidence.",
        tools: ["inspect_system"],
      },
      budget: { maxCycles: 10, maxTurnsPerCycle: 4, maxCostUsd: 2 },
      policy: {
        approvalRequiredTools: ["publish_report"],
        toolRiskLevels: { publish_report: "high" },
      },
      memory: { enabled: true, maxContextItems: 12 },
      playbook: {
        name: "readiness",
        steps: [{ title: "Inspect" }, { title: "Verify" }],
      },
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string; status: string; plan: unknown[] };
    expect(created.status).toBe("waiting");
    expect(created.plan).toHaveLength(2);

    const listResponse = await request("GET", "/api/v1/objectives?status=waiting");
    const objectives = await listResponse.json() as Array<{ id: string }>;
    expect(objectives.map((objective) => objective.id)).toContain(created.id);

    const planResponse = await request("GET", `/api/v1/objectives/${created.id}/plan`);
    expect(await planResponse.json()).toHaveLength(2);

    const pausedResponse = await request("POST", `/api/v1/objectives/${created.id}/pause`, {
      reason: "Await operator",
    });
    expect((await pausedResponse.json() as { waitForEvent: string }).waitForEvent)
      .toBe("objective.resume");

    const objective = service.objectiveStore.getObjective(created.id)!;
    const authorization = service.objectivePolicy.authorize(
      objective,
      "publish_report",
      { report: "verified" },
    );
    expect(authorization.behavior).toBe("approval");
    if (authorization.behavior !== "approval") throw new Error("Expected approval");

    const resolvedResponse = await request(
      "POST",
      `/api/v1/objectives/${created.id}/approvals/${authorization.approval.id}/resolve`,
      { status: "approved", resolvedBy: "test", note: "Evidence reviewed" },
    );
    expect((await resolvedResponse.json() as { status: string }).status).toBe("approved");

    const eventsResponse = await request("GET", `/api/v1/objectives/${created.id}/events`);
    const events = await eventsResponse.json() as Array<{ type: string }>;
    expect(events.some((event) => event.type.endsWith(".resolved"))).toBe(true);

    const cancelledResponse = await request("POST", `/api/v1/objectives/${created.id}/cancel`, {
      reason: "Scenario finished",
    });
    expect((await cancelledResponse.json() as { status: string }).status).toBe("cancelled");
  });
});

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://aeon.test${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = api.handleObjectiveAPI(req, new URL(req.url));
  if (!result) throw new Error(`Objective route was not handled: ${path}`);
  return await result;
}
