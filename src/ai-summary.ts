// ---------------------------------------------------------------------------
// AI-powered run summaries via OpenRouter
// Calls a lightweight model to describe what the agent was actually doing,
// based on tool inputs, file names, commands, and agent messages.
// ---------------------------------------------------------------------------

// Read keys at call-time so they pick up values saved via the settings UI
function getOpenRouterKey(): string | undefined {
  return process.env["OPENROUTER_API_KEY"];
}
const OPENROUTER_MODEL = process.env["OPENROUTER_MODEL"] ?? "google/gemini-2.0-flash-lite";

// ── Types ────────────────────────────────────────────────────────────────────

export type PhaseSummary = {
  phaseIdx: number;
  summary: string;
};

export type RunSummaryResult = {
  overall: string;
  phases: PhaseSummary[];
  model: string;
  generatedAt: string;
};

type SummaryEntry =
  | { status: "ready"; result: RunSummaryResult }
  | { status: "generating" }
  | { status: "error"; message: string };

// ── In-memory cache ──────────────────────────────────────────────────────────

const cache = new Map<string, SummaryEntry>();

export function getCached(agentId: string): SummaryEntry | undefined {
  return cache.get(agentId);
}

export function isAvailable(): boolean {
  return !!getOpenRouterKey();
}

// ── Context extraction ───────────────────────────────────────────────────────

type AnalyticsPhase = {
  cat: string;
  label: string;
  start: number;
  end: number;
  toolTotals: Record<string, number>;
  toolSamples: string[];   // Specific inputs e.g. filenames, commands, URLs
  messages: string[];      // Agent messages (truncated)
  pings: string[];
};

/** Pull meaningful signal out of the analytics data for the AI prompt. */
export function extractPhaseContexts(analyticsData: unknown): AnalyticsPhase[] {
  const d = analyticsData as {
    task: string;
    turns: Array<{
      turnNum: number;
      events: Array<Record<string, unknown>>;
      hasThinking: boolean;
    }>;
  };

  // Re-run the same phase-grouping logic used in the frontend
  const PHASE_CATS: Record<string, string> = {
    explore: "Exploration", write: "Writing", exec: "Running Commands",
    web: "Web Research", browser: "Browser Automation",
    agents: "Sub-agents", reasoning: "Planning", idle: "Idle", other: "Tool Use",
  };

  function cat(turn: typeof d.turns[0]): string {
    const counts: Record<string, number> = {};
    for (const ev of turn.events ?? []) {
      if (ev.type !== "tool_use") continue;
      const n = ev.name as string;
      if (["Read","Grep","Glob"].includes(n))         counts.explore = (counts.explore||0)+1;
      else if (["Write","Edit"].includes(n))          counts.write   = (counts.write  ||0)+1;
      else if (n === "Bash")                          counts.exec    = (counts.exec   ||0)+1;
      else if (["WebSearch","WebFetch"].includes(n))  counts.web     = (counts.web    ||0)+1;
      else if (n.startsWith("browserbase"))           counts.browser = (counts.browser||0)+1;
      else if (["Task","Agent"].includes(n))          counts.agents  = (counts.agents ||0)+1;
      else                                            counts.other   = (counts.other  ||0)+1;
    }
    const total = Object.values(counts).reduce((a,b)=>a+b,0);
    if (total === 0) return turn.hasThinking ? "reasoning" : "idle";
    return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
  }

  // Group turns into phases
  const phases: Array<{ cat: string; turns: typeof d.turns; start: number; end: number }> = [];
  let cur: typeof phases[0] | null = null;
  for (const t of (d.turns ?? [])) {
    const c = cat(t);
    if (!cur || cur.cat !== c) {
      cur = { cat: c, turns: [t], start: t.turnNum, end: t.turnNum };
      phases.push(cur);
    } else {
      cur.turns.push(t);
      cur.end = t.turnNum;
    }
  }

  return phases.map((p) => {
    const toolTotals: Record<string, number> = {};
    const sampleSet = new Set<string>();
    const messages: string[] = [];
    const pings: string[] = [];

    for (const t of p.turns) {
      for (const ev of t.events ?? []) {
        if (ev.type === "tool_use") {
          const name = ev.name as string;
          toolTotals[name] = (toolTotals[name] || 0) + 1;

          // Extract meaningful input snippets
          const inp = (ev.input ?? {}) as Record<string, unknown>;
          const snippet = extractToolSnippet(name, inp);
          if (snippet) sampleSet.add(snippet);
        }
        if (ev.type === "agent_message" && ev.text) {
          const txt = String(ev.text).replace(/\n/g, " ").trim().slice(0, 120);
          messages.push(txt);
        }
        if (ev.type === "ping" && ev.message) {
          pings.push(String(ev.message).replace(/\n/g, " ").trim().slice(0, 100));
        }
      }
    }

    return {
      cat: p.cat,
      label: PHASE_CATS[p.cat] ?? "Activity",
      start: p.start,
      end: p.end,
      toolTotals,
      toolSamples: [...sampleSet].slice(0, 12),
      messages: messages.slice(-3), // last 3 messages = most recent conclusions
      pings: pings.slice(0, 2),
    };
  });
}

function extractToolSnippet(toolName: string, inp: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":   return inp.file_path ? String(inp.file_path).split("/").slice(-2).join("/") : null;
    case "Bash":   return inp.description ? String(inp.description).slice(0, 60) :
                          inp.command     ? String(inp.command).slice(0, 60) : null;
    case "Grep":   return inp.pattern ? `grep: "${String(inp.pattern).slice(0, 40)}"` : null;
    case "Glob":   return inp.pattern ? `glob: ${String(inp.pattern).slice(0, 40)}` : null;
    case "WebSearch": return inp.query ? `search: "${String(inp.query).slice(0, 60)}"` : null;
    case "WebFetch":  return inp.url   ? String(inp.url).slice(0, 80) : null;
    case "Agent":
    case "Task":   return inp.description ? String(inp.description).slice(0, 60) : null;
    case "browserbase_stagehand_navigate": return inp.url ? String(inp.url).slice(0, 60) : null;
    case "browserbase_stagehand_act":      return inp.action ? String(inp.action).slice(0, 60) : null;
    default: return null;
  }
}

// ── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(task: string, phases: AnalyticsPhase[]): string {
  const phaseBlocks = phases.map((p, i) => {
    const toolSummary = Object.entries(p.toolTotals)
      .sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([n,c])=>`${c}× ${n}`).join(", ");

    const samples = p.toolSamples.length
      ? `  Specific inputs:\n${p.toolSamples.map(s=>`    - ${s}`).join("\n")}`
      : "";

    const msgs = p.messages.length
      ? `  Agent said:\n${p.messages.map(m=>`    "${m}"`).join("\n")}`
      : "";

    return `Phase ${i+1} (${p.label}, Turns ${p.start}–${p.end}):
  Tools: ${toolSummary || "none"}
${samples}
${msgs}`.trim();
  }).join("\n\n");

  return `You are summarizing what an AI software agent did during a run.

Task given to the agent: "${task}"

The run had ${phases.length} phase(s):

${phaseBlocks}

Write a JSON object with:
1. "overall": One sentence (max 20 words) describing the big-picture goal of this run — what problem is being solved or what is being built. Be SPECIFIC to the content (e.g. "Building a React dashboard for legal document management" not "Working on a web project").
2. "phases": Array of objects, one per phase above, each with:
   - "idx": phase index (0-based)
   - "summary": One SHORT sentence (max 15 words) describing what was specifically happening in that phase — use the file names, commands, and URLs as clues to describe the actual content, not just the method. E.g. "Reading authentication middleware and JWT token validation logic" not "Reading files".

Reply with ONLY the JSON, no markdown fences.`;
}

// ── OpenRouter call ──────────────────────────────────────────────────────────

async function callOpenRouter(prompt: string): Promise<string> {
  const key = getOpenRouterKey();
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/universal-agent-infra",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 200)}`);
  }

  const json = await res.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return json.choices[0]?.message?.content ?? "";
}

// ── Parse response ───────────────────────────────────────────────────────────

function parseResponse(raw: string): { overall: string; phases: PhaseSummary[] } {
  // Strip possible markdown code fences
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(cleaned) as {
    overall: string;
    phases: Array<{ idx: number; summary: string }>;
  };
  return {
    overall: String(parsed.overall ?? "").trim(),
    phases: (parsed.phases ?? []).map((p) => ({
      phaseIdx: Number(p.idx ?? 0),
      summary: String(p.summary ?? "").trim(),
    })),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Kick off background generation for an agent run.
 * Safe to call multiple times — deduplicates automatically.
 */
export function requestSummary(agentId: string, analyticsData: unknown): void {
  if (!OPENROUTER_KEY) return;
  const existing = cache.get(agentId);
  if (existing?.status === "ready" || existing?.status === "generating") return;

  cache.set(agentId, { status: "generating" });

  const d = analyticsData as { task: string };
  const phases = extractPhaseContexts(analyticsData);

  if (phases.length === 0) {
    cache.set(agentId, { status: "error", message: "No phases to summarize yet" });
    return;
  }

  // Fire-and-forget
  (async () => {
    try {
      const prompt = buildPrompt(d.task ?? "", phases);
      const raw = await callOpenRouter(prompt);
      const parsed = parseResponse(raw);
      cache.set(agentId, {
        status: "ready",
        result: {
          ...parsed,
          model: OPENROUTER_MODEL,
          generatedAt: new Date().toISOString(),
        },
      });
      console.log(`[ai-summary] Generated for agent ${agentId.slice(0, 8)} via ${OPENROUTER_MODEL}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ai-summary] Failed for ${agentId.slice(0, 8)}:`, msg);
      cache.set(agentId, { status: "error", message: msg });
    }
  })();
}

/** Invalidate cached summary (call when new turns arrive so it regenerates). */
export function invalidate(agentId: string): void {
  const entry = cache.get(agentId);
  if (entry?.status === "ready") cache.delete(agentId);
}
