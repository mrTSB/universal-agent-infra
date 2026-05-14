// ---------------------------------------------------------------------------
// Persistent custom tool registry
// Tools are stored in .agents/tools.json and loaded at startup.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const TOOLS_DIR  = ".agents";
const TOOLS_FILE = join(TOOLS_DIR, "tools.json");

// ── Schema types ─────────────────────────────────────────────────────────────

export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
};

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export type HttpExecutor = {
  type: "http";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
};

export type ShellExecutor = {
  type: "shell";
  command: string; // Use {{param_name}} for parameter substitution
  cwd?: string;    // Defaults to agent workspace if omitted
  timeout?: number; // ms, default 30_000
};

export type CustomTool = {
  id: string;
  name: string;            // snake_case identifier used by the agent
  description: string;     // shown to the model — be specific
  inputSchema: ToolInputSchema;
  executor: HttpExecutor | ShellExecutor;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

// ── In-memory store + persistence ────────────────────────────────────────────

let _tools: CustomTool[] = [];

function persist(): void {
  mkdirSync(TOOLS_DIR, { recursive: true });
  writeFileSync(TOOLS_FILE, JSON.stringify(_tools, null, 2));
}

try {
  const raw = readFileSync(TOOLS_FILE, "utf-8");
  _tools = JSON.parse(raw) as CustomTool[];
  if (_tools.length) console.log(`[tool-registry] Loaded ${_tools.length} custom tool(s)`);
} catch { /* first run — no file yet */ }

// ── Public API ────────────────────────────────────────────────────────────────

export function list(): CustomTool[] {
  return [..._tools];
}

export function get(id: string): CustomTool | undefined {
  return _tools.find((t) => t.id === id);
}

export function getByName(name: string): CustomTool | undefined {
  return _tools.find((t) => t.name === name);
}

export function create(
  input: Omit<CustomTool, "id" | "createdAt" | "updatedAt">
): CustomTool {
  if (getByName(input.name)) {
    throw new Error(`A tool named "${input.name}" already exists`);
  }
  const now = new Date().toISOString();
  const t: CustomTool = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  _tools.push(t);
  persist();
  return t;
}

export function update(
  id: string,
  patch: Partial<Omit<CustomTool, "id" | "createdAt">>
): CustomTool | null {
  const idx = _tools.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  if (patch.name && patch.name !== _tools[idx].name && getByName(patch.name)) {
    throw new Error(`A tool named "${patch.name}" already exists`);
  }
  _tools[idx] = { ..._tools[idx], ...patch, updatedAt: new Date().toISOString() };
  persist();
  return _tools[idx];
}

export function remove(id: string): boolean {
  const before = _tools.length;
  _tools = _tools.filter((t) => t.id !== id);
  if (_tools.length < before) { persist(); return true; }
  return false;
}
