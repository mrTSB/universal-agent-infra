import * as config from "./config.ts";
import {
  objectiveRuntime,
  objectiveSnapshot,
  objectiveStore,
} from "./objective-service.ts";
import type { ObjectiveInput, ObjectiveStatus } from "./objective-types.ts";
import { stopRun } from "./agent-run.ts";

const OBJECTIVE_PREFIX = "/api/v1/objectives";

export function handleObjectiveAPI(
  req: Request,
  url: URL,
): Response | Promise<Response> | null {
  const { pathname } = url;
  const method = req.method;
  if (!pathname.startsWith(OBJECTIVE_PREFIX) && !pathname.startsWith("/api/v1/approvals/")) {
    return null;
  }

  if (pathname === OBJECTIVE_PREFIX) {
    if (method === "GET") {
      const statuses = parseStatuses(url.searchParams.get("status"));
      return json(objectiveStore.listObjectives(statuses));
    }
    if (method === "POST") return createObjective(req);
  }

  const approvalMatch = pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/resolve$/);
  if (approvalMatch && method === "POST") {
    return resolveApproval(requiredCapture(approvalMatch), req);
  }

  const resourceMatch = pathname.match(
    /^\/api\/v1\/objectives\/([^/]+)\/(plan|events|memories|actions|outcomes|approvals)$/,
  );
  if (resourceMatch && method === "GET") {
    const objectiveId = requiredCapture(resourceMatch, 1);
    if (!objectiveStore.getObjective(objectiveId)) return json({ error: "Not found" }, 404);
    switch (requiredCapture(resourceMatch, 2)) {
      case "plan": return json(objectiveStore.listSteps(objectiveId));
      case "events": return json(objectiveStore.listEvents(objectiveId));
      case "memories": return json(objectiveStore.listMemories(objectiveId));
      case "actions": return json(objectiveStore.listActions(objectiveId));
      case "outcomes": return json(objectiveStore.listOutcomes(objectiveId));
      case "approvals": return json(objectiveStore.listApprovals(objectiveId));
    }
  }

  const eventMatch = pathname.match(/^\/api\/v1\/objectives\/([^/]+)\/events$/);
  if (eventMatch && method === "POST") {
    return emitEvent(requiredCapture(eventMatch), req);
  }

  const controlMatch = pathname.match(
    /^\/api\/v1\/objectives\/([^/]+)\/(resume|pause|cancel)$/,
  );
  if (controlMatch && method === "POST") {
    return controlObjective(
      requiredCapture(controlMatch, 1),
      requiredCapture(controlMatch, 2),
      req,
    );
  }

  const nestedApprovalMatch = pathname.match(
    /^\/api\/v1\/objectives\/([^/]+)\/approvals\/([^/]+)\/resolve$/,
  );
  if (nestedApprovalMatch && method === "POST") {
    return resolveApproval(
      requiredCapture(nestedApprovalMatch, 2),
      req,
      requiredCapture(nestedApprovalMatch, 1),
    );
  }

  const objectiveMatch = pathname.match(/^\/api\/v1\/objectives\/([^/]+)$/);
  if (objectiveMatch && method === "GET") {
    const snapshot = objectiveSnapshot(requiredCapture(objectiveMatch));
    return snapshot ? json(snapshot) : json({ error: "Not found" }, 404);
  }

  return json({ error: "Not found" }, 404);
}

async function createObjective(req: Request): Promise<Response> {
  const body = await readBody<ObjectiveInput>(req);
  if (!body || typeof body.goal !== "string" || !body.goal.trim()) {
    return json({ error: "goal is required" }, 400);
  }
  if (body.start !== false && !config.status().ANTHROPIC_API_KEY) {
    return json({
      error: "ANTHROPIC_API_KEY is not set. Set it before starting an objective.",
    }, 400);
  }
  try {
    const objective = objectiveRuntime.create(body);
    return json(objectiveSnapshot(objective.id), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function emitEvent(objectiveId: string, req: Request): Promise<Response> {
  const body = await readBody<{
    type?: string;
    payload?: Record<string, unknown>;
    source?: string;
    dedupeKey?: string;
  }>(req);
  if (!body?.type?.trim()) return json({ error: "type is required" }, 400);
  try {
    const event = objectiveRuntime.emit(
      objectiveId,
      body.type.trim(),
      body.payload ?? {},
      { source: body.source, dedupeKey: body.dedupeKey },
    );
    return json(event, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function controlObjective(
  objectiveId: string,
  control: string,
  req: Request,
): Promise<Response> {
  const body = await readBody<{ reason?: string }>(req) ?? {};
  try {
    if (control === "resume") return json(objectiveRuntime.resume(objectiveId));
    if (control === "pause") {
      const objective = objectiveRuntime.pause(objectiveId, body.reason);
      stopRun(objectiveId);
      return json(objective);
    }
    const objective = objectiveRuntime.cancel(objectiveId, body.reason);
    stopRun(objectiveId);
    return json(objective);
  } catch (error) {
    return errorResponse(error);
  }
}

async function resolveApproval(
  approvalId: string,
  req: Request,
  expectedObjectiveId?: string,
): Promise<Response> {
  const body = await readBody<{
    status?: "approved" | "rejected";
    resolvedBy?: string;
    note?: string;
  }>(req);
  if (body?.status !== "approved" && body?.status !== "rejected") {
    return json({ error: "status must be approved or rejected" }, 400);
  }
  const existing = objectiveStore.getApproval(approvalId);
  if (!existing || (expectedObjectiveId && existing.objectiveId !== expectedObjectiveId)) {
    return json({ error: "Not found" }, 404);
  }
  try {
    const approval = objectiveStore.resolveApproval(
      approvalId,
      body.status,
      body.resolvedBy ?? "sdk",
      body.note,
    );
    objectiveRuntime.emit(
      approval.objectiveId,
      `approval.${approval.id}.resolved`,
      { approvalId: approval.id, status: approval.status, note: approval.note },
      { source: body.resolvedBy ?? "sdk", dedupeKey: `approval:${approval.id}:${approval.status}` },
    );
    return json(approval);
  } catch (error) {
    return errorResponse(error);
  }
}

function parseStatuses(value: string | null): ObjectiveStatus[] | undefined {
  if (!value) return undefined;
  const valid = new Set<ObjectiveStatus>([
    "queued", "planning", "running", "waiting", "blocked",
    "completed", "failed", "cancelled",
  ]);
  const statuses = value.split(",").filter((status): status is ObjectiveStatus =>
    valid.has(status as ObjectiveStatus),
  );
  return statuses.length ? statuses : undefined;
}

async function readBody<T>(req: Request): Promise<T | null> {
  try {
    return await req.json() as T;
  } catch {
    return null;
  }
}

function requiredCapture(match: RegExpMatchArray, index = 1): string {
  const value = match[index];
  if (!value) throw new Error("Invalid route capture");
  return decodeURIComponent(value);
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("not found") || message.includes("not found".toUpperCase())
    ? 404
    : 400;
  return json({ error: message }, status);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
