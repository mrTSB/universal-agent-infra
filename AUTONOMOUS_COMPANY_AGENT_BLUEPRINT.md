# Autonomous Company-Building Agent: Streamlined Blueprint

## Mission and constraints

Build a continuously running autonomous agent system that, in a **12-hour hackathon window**, can launch and validate a business direction while keeping the founder in control.

Required constraints:

- Agent framework: **Claude Agent SDK**
- Model platform: **Vertex AI (Claude models)**
- Realtime and operational state: **Convex**
- Execution environment: **Modal sandbox** (all autonomous work runs here)
- Browser automation: **Claude computer-use style loop** in Modal, with browser-use as optional accelerator
- Human control and updates: **Slack-first**

Core outcomes:

1. Self-unblock instead of stalling.
2. Spawn child agents for parallel tasks.
3. Progressively update user in Slack.
4. Allow user steering at any moment.

---

## What the system does

During the run, the system:

- Generates and updates hypotheses (market, customer, problem, solution).
- Plans and executes experiments (landing page, outreach, pricing, prototype tests).
- Collects evidence (traffic, conversion events, interviews, waitlist, first revenue signals).
- Re-prioritizes every cycle from evidence, not assumptions.
- Requests approval only for gated actions (spend, legal, sensitive external actions).

Self-unblocking behavior:

1. Detect blocker (tool/API failure, ambiguous decision, missing credentials, low confidence).
2. Attempt auto-recovery (retry, fallback tool/provider, alternate strategy).
3. If still blocked, generate 2-3 options with trade-offs.
4. Escalate in Slack with a recommended default and timeout.
5. Continue on response or timeout policy.

---

## Target architecture

1. **Parent orchestrator (Claude Agent SDK)**
   - Runs the main loop: observe -> plan -> act -> verify -> reflect -> report.
   - Owns final decisions, policy checks, and escalation.
   - Spawns bounded child agents for parallel work.

2. **Model layer (Vertex AI)**
   - Claude models served through Vertex AI.
   - Wrapper enforces timeout, retry, token/cost limits, and fallback profile.

3. **Runtime layer (Modal, required)**
   - All autonomous tasks execute in isolated Modal sandboxes.
   - Ephemeral workers per task batch; shared truth in Convex.
   - Network allowlist, scoped secrets, sandbox kill switch.

4. **State and memory (Convex, required)**
   - Realtime system of record for goals, tasks, blockers, decisions, approvals, runs, and Slack events.
   - Short-term + long-term memory in Convex.
   - Optional semantic embeddings can be stored in Convex for MVP; external vector system can be deferred.

5. **Browser execution layer**
   - Primary: Modal-hosted browser worker using Playwright + virtual display (computer-use style loop).
   - Secondary: browser-use MCP/cloud for fast deterministic browser tasks.
   - Fallback: direct API integrations whenever available (preferred for reliability/cost).

6. **Slack control plane**
   - Outbound updates: heartbeats, milestones, blockers, recaps.
   - Inbound control: status, pause/resume, focus changes, approvals/rejections, budget commands.

7. **Safety and governance**
   - Action tiers, approval gates, audit log, rollback paths, circuit breakers.

---

## Control loop and multi-agent model

### Core loop

1. **Observe**: gather metrics, blockers, and external signals.
2. **Plan**: choose top goals for next 30-90 minutes.
3. **Act**: execute tasks via tools and child agents.
4. **Verify**: validate outputs and expected outcomes.
5. **Reflect**: compare expected vs actual; update strategy/memory.
6. **Report**: post Slack updates and request steering if needed.

### Child-agent spawning rules

Spawn child agents when work is parallelizable, specialized, or unblock-related.

Hackathon limits:

- max concurrent child agents: `3`
- max depth: `1` (no recursive spawn in MVP)
- max runtime per child: `20m`

Parent-only authority:

- persists final decisions in Convex
- executes approval-required actions
- publishes milestone updates to `#general`

Child required output:

- `result_summary`
- `evidence`
- `confidence`
- `next_recommended_action`

Failure handling:

- one retry with adjusted context, then escalate options to user

---

## Slack-first operating model

Channels:

- `#general`: business heartbeat and milestone updates (typically every 15 minutes during run)
- `#agent-ops`: technical traces, risk alerts, blocker diagnostics
- Founder DM: approvals and urgent decisions

Progressive update policy:

1. **Heartbeat** every 15 minutes in `#general`:
   - current objective
   - completed actions
   - next action
   - spend/time remaining
2. **Immediate milestone updates** on:
   - hypothesis selected
   - landing page live
   - outreach batch sent
   - KPI delta detected
   - major child-agent completion that changes plan/outcome
3. **Immediate blocker alerts** in DM + `#agent-ops`:
   - blocker type
   - attempted auto-recovery
   - options with recommended default
   - timeout before default
4. **Hourly recap**:
   - wins, misses, course correction

Control commands (slash or natural language):

- `/agent status`
- `/agent pause 2h`
- `/agent resume`
- `/agent focus "B2B fintech customer discovery"`
- `/agent approve TASK_ID`
- `/agent reject TASK_ID`
- `/agent budget set ads_monthly 5000`

---

## Data model (Convex-first)

Core entities:

- `Goal` (north star + milestones)
- `Hypothesis` (assumption, confidence, evidence links)
- `Experiment` (design, success metric, status, owner)
- `Task` (action with dependencies)
- `TaskLease` (task ownership lock to avoid duplicate execution)
- `Blocker` (type, severity, retries, escalation status)
- `Decision` (options, selected path, rationale)
- `MetricSnapshot` (time-series KPIs)
- `SlackMessage` (inbound/outbound linkage)
- `Approval` (required/received/expired)
- `AgentRun` (parent/child metadata, status, duration, budget used)

---

## Safety, reliability, and trust

### Action tiers

1. **Auto-allowed**: research, drafting, feature-branch coding, low-risk experiments.
2. **Guarded**: external publishing/email, low-threshold spend.
3. **Approval-required**: contracts, high spend, production data migrations, legal commitments.

### Reliability safeguards

- retries with exponential backoff
- fallback tools/providers
- circuit breakers for repeated failures
- idempotency keys for external actions
- dead-letter queue for unrecoverable jobs
- concurrency caps + leases for child-agent safety
- watchdog to terminate hung child agents and safely requeue work

### Transparency

Every meaningful action logs:

- reason
- input
- output
- cost/time
- risk score

---

## Recommended stack

Core:

- `TypeScript` + Claude Agent SDK
- Vertex AI (Claude models)
- Convex (state + realtime workflow events)
- Modal (sandbox compute + browser workers)

Execution and tooling:

- Playwright + virtual display (computer-use style browser loop)
- browser-use MCP/cloud (selective accelerator)
- GitHub + CI for product iteration

Observability:

- Slack app (Events API + slash commands + interactive blocks)
- OpenTelemetry + Grafana/Datadog
- Sentry

Design principle:

- thin services, strong prompts/policies, bounded autonomy

---

## 12-hour execution plan

### Phase 0 (Hour 0-1): Setup and guardrails

- configure Vertex access and model routing
- bootstrap Convex schema/functions
- provision Modal app/image/secrets
- create Slack app scopes/endpoints
- set budget cap, action tiers, and kill switches

Exit criteria:

- Vertex, Convex, Modal, Slack smoke tests pass
- `/agent status` reports healthy

### Phase 1 (Hour 1-3): Core loop

- implement parent orchestrator loop
- wire Convex entities (`Goal`, `Task`, `Blocker`, `Decision`, `Approval`, `AgentRun`, `TaskLease`)
- build Modal task runner
- implement Slack status/pause/resume/approval
- add blocker detection + recovery/escalation

Exit criteria:

- continuous 1-hour run in staging
- heartbeat to Slack every 15 minutes
- recovers from simulated tool failure

### Phase 2 (Hour 3-6): Tools and steering

- integrate research, browser, and repo tools
- add steering parser from Slack
- implement approval gates and action tiers
- enforce timebox mode (ETA + cutoff per task)
- enable progressive update hooks
- add parent/child spawn manager (3 concurrent, depth 1, 20m timeout)

Exit criteria:

- one full idea -> build -> launch -> measure cycle
- >=80% blockers auto-resolved or escalated with options

### Phase 3 (Hour 6-10): Growth sprint

- run growth templates (landing page, outreach, pricing)
- hourly re-planning from KPIs
- confidence scoring for hypotheses/decisions
- budget-aware planning

Exit criteria:

- repeated hourly growth loops complete
- measurable KPI movement with explainable action trail

### Phase 4 (Hour 10-12): Hardening and demo output

- harden retries, approvals, stop/resume
- run focused failure drills (API outage, bad tool output, missing creds)
- tune concurrency for stable run
- produce final Slack + markdown report

Exit criteria:

- final 2 hours run without manual rescue
- complete decision/action audit trail

---

## Steering, KPIs, and team

### Steering precedence

Steering levels:

1. strategic (market/segment/model)
2. tactical (weekly focus/channel/spend limits)
3. operational (approve/reject actions)

Precedence:

- explicit user steer > agent plan
- safety policy overrides both
- conflicts trigger clarification with fallback options

### KPI framework (12-hour)

1. **Business traction**: qualified leads, conversions, interviews, waitlist growth, first revenue signal.
2. **Agent performance**: task completion rate, unblock success rate, decision latency.
3. **Operational health**: error rate, tool uptime, cost per successful action.

Rule:

- if confidence drops below threshold, force immediate 30-minute strategy review

### Team shape

- 1 builder (orchestrator + Convex + Slack plumbing)
- 1 AI operator (prompts, tools, evaluation, unblock policy)
- 1 growth operator (landing page, outreach, analytics, narrative)
- can run with 2 people if infra + agent logic is combined

---

## Risks and mitigations

- **Runaway autonomy** -> action tiers, caps, approvals, kill switch.
- **Hallucinated decisions** -> evidence-linked decisions, verifier checks, confidence thresholds.
- **Tool/API fragility** -> retries, fallbacks, queue durability.
- **Trust erosion** -> clear Slack reporting, transparent rationale, reversible actions.

---

## Immediate implementation checklist (12 items)

1. Create Convex schema for `Goal`, `Task`, `Blocker`, `Decision`, `Approval`, `AgentRun`, `TaskLease`.
2. Wire Claude Agent SDK orchestrator to Vertex AI Claude endpoint.
3. Set up Modal sandbox worker image with Playwright + virtual display.
4. Stand up Slack app (events endpoint, slash commands, bot scopes).
5. Add progressive update dispatcher (heartbeat + milestone + blocker alerts).
6. Implement browser executor in Modal (max steps, timeout, screenshot verification).
7. Add `/agent status`, `/agent pause`, `/agent resume`, `/agent approve`.
8. Implement spawn manager with cap `3`, depth `1`, timeout `20m`.
9. Implement blocker detector with retry/fallback/escalation.
10. Add first launch experiment template (landing page + waitlist tracking).
11. Implement action policy tiers and budget checks.
12. Add full Convex audit logging and run continuous 12-hour autonomous session.

---

## Definition of done (hackathon MVP)

MVP is complete when:

- system runs continuously for 12 hours
- executes at least one full build + launch + measure cycle
- auto-handles common blockers and escalates edge cases
- founder can steer entirely from Slack
- medium/high-risk actions are policy-gated and auditable

---

## Task spawning contract (parent -> child)

Child request includes:

- `task_id`
- `objective`
- `allowed_tools`
- `input_context_refs` (Convex IDs, URLs, files)
- `budget_tokens`
- `max_steps`
- `deadline_at`
- `success_criteria`

Child response includes:

- `status` (`success` | `partial` | `failed` | `blocked`)
- `result_summary`
- `artifacts` (links/screenshots/files)
- `evidence`
- `confidence` (0-1)
- `handoff_recommendation`

---

## Final note

Treat this as an autonomous company execution system, not a chatbot.  
The moat is compounding memory, reliable execution, and rapid human steering loops.
