# Aeon Wake Cycles

Aeon separates a long-lived objective from the short-lived model process that
advances it. An objective can exist for months or years, while each model wake is
small, bounded, auditable, and replaceable.

The wake-cycle design is based on
[Mobius](https://x.com/BhathalTanvir0/status/2023896499848114427), Tanvir
Bhathal's TreeHacks infinite-horizon agent project.

## Control Loop

Each wake executes one wake cycle:

1. **Observe** the objective, new events, plan graph, memories, outcomes, and workspace.
2. **Plan** the smallest useful next step and persist plan changes.
3. **Act** with policy-gated tools or bounded specialist sub-agents.
4. **Verify** results with tests, direct inspection, or external evidence.
5. **Reflect** into working, episodic, semantic, or procedural memory.
6. **Report** one transition: continue, wait, block, complete, or fail.

`wait` stores an optional ISO wake time or event type. No process or model call is
kept alive while an objective is dormant.

## Durable Kernel

`ObjectiveStore` is a SQLite journal with WAL mode and foreign keys. It stores:

| Record | Purpose |
| --- | --- |
| Objective | Goal, criteria, definition, policy, budgets, status, and accounting |
| Plan step | Dependency-aware work graph with attempts, evidence, and results |
| Event | External or internal wake signal with deduplication and consumption state |
| Action | Tool intent, risk, idempotency key, attempts, output, and error |
| Memory | Typed knowledge with confidence, provenance, and optional expiry |
| Outcome | Measured result and supporting evidence |
| Approval | Durable human decision attached to a risky action |
| Checkpoint | Pre-cycle snapshot for inspection and recovery |

Workers claim objectives with expiring leases. Startup recovery returns interrupted
`running` or `planning` objectives to the queue. Duplicate event and action keys are
safe across retries.

## Bounded Execution

The scheduler invokes the Claude Agent SDK once per wake with hard
`maxTurns` and `maxBudgetUsd` values. The runtime also enforces objective-wide:

- maximum total cost
- maximum wake cycles
- maximum active execution minutes
- maximum tool calls

Dormant wall-clock time is deliberately excluded from active-runtime accounting.
This lets an objective wait indefinitely without accidentally exhausting a time
budget or spending tokens.

## Policy And Approval

Every non-lifecycle action is evaluated before execution. Policies support:

- explicit tool allowlists and denylists
- per-tool and default risk levels
- approval by named tool or risk threshold
- fail-closed workspace containment
- retry/backoff configuration
- objective-wide tool-call limits

An action that requires approval transitions the objective to `waiting` for a
specific `approval.<id>.resolved` event. Approval resolution is durable, wakes the
objective, and reuses the action idempotency key so the reviewed action can proceed
without producing a second approval.

## Customization Boundary

The kernel has no CRM, support, sales, or other vertical assumptions. An SDK caller
defines the domain through:

- goal, context, success criteria, priority, and metadata
- primary and fallback model
- custom system instructions
- registered HTTP or shell tools
- specialist sub-agent definitions
- reusable playbooks and seeded plan steps
- memory retention and context limits
- budgets, risk mapping, approval gates, and retries

The `CycleExecutor` interface also keeps the durable kernel independent from the
current model adapter. The included service uses Claude, while another executor can
advance the same objective records.

## Control Plane

The versioned HTTP API is rooted at `/api/v1/objectives`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/objectives` | Create and optionally start an objective |
| `GET` | `/api/v1/objectives` | List, optionally filtered by status |
| `GET` | `/api/v1/objectives/:id` | Read objective plus plan, approvals, and outcomes |
| `POST` | `/api/v1/objectives/:id/events` | Emit a deduplicated external event |
| `POST` | `/api/v1/objectives/:id/pause` | Dormant pause until resume |
| `POST` | `/api/v1/objectives/:id/resume` | Queue another bounded wake |
| `POST` | `/api/v1/objectives/:id/cancel` | Terminal cancellation |
| `GET` | `/api/v1/objectives/:id/:ledger` | Read plan, events, memories, actions, outcomes, or approvals |
| `POST` | `/api/v1/objectives/:id/approvals/:approvalId/resolve` | Approve or reject an action |

## Status Model

```text
queued -> running -> continue -> queued
                  -> wait ------> waiting --(time/event/resume)--> queued
                  -> block -----> blocked --(resume)------------> queued
                  -> complete --> completed
                  -> fail ------> waiting (retry) | failed
any nonterminal --(cancel)------> cancelled
```

The terminal states are `completed`, `failed`, and `cancelled`. `waiting` and
`blocked` are durable idle states, not failed model processes.
