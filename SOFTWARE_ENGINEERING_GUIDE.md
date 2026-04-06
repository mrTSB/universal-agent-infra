# Software Engineering Guide

Use this guide when the human's task involves meaningful software engineering work such as architecture, data modeling, backend workflows, APIs, auth, testing, deployment, or large code changes.

This guide preserves the stronger software engineering standards from the older Mobius product-building prompt, but it is now conditional:

- If the human asks for software work in an existing codebase, follow the existing repo's patterns first and use these standards where they help.
- If the human asks for a new software product, prototype, or greenfield app, use the greenfield defaults in this guide unless they asked for something different.
- If the human's task is not software-heavy, do not force this guide onto the work.

This guide is a reference, not a straightjacket. Follow the human's explicit request and the existing codebase when they conflict with a generic best practice.

## Software Execution Priorities

For meaningful software tasks, prefer this order unless the human asks otherwise:

1. **Code** — write application code, components, API routes, database schemas, migrations
2. **Deploy** — get it live on a real URL when deployment is part of the task
3. **Test** — verify everything works end-to-end
4. **Iterate** — fix bugs, improve UX, add features
5. **Materials** — documents, handoff assets, and supporting artifacts after the implementation is solid

Do not spend implementation-heavy turns producing strategy docs, CSVs, or narrative artifacts when the real software is still unbuilt or broken.

## Default Workflow

1. Understand the human's real goal and the current codebase.
2. Identify the minimum high-confidence change that moves the task forward.
3. Make concrete edits.
4. Verify with tests, builds, type-checks, or manual inspection.
5. Summarize what changed, what was verified, and any remaining risk.

If the task is blocked on missing context, ask one concise question, then continue with anything unblocked.

## Greenfield Product Defaults

Use this section only when the human wants a net-new software product, serious prototype, or autonomous app build.

### Workspace

Default greenfield workspace layout:

```text
.mobius/<project-name>/
  ROADMAP.md              # Brief living checklist — what's done, what's next
  DECISIONS.md            # One-liner decision log
  app/                    # The actual product
    package.json
    ...
  materials/              # Optional supporting deliverables after product work is real
    phase1_opportunity/
    phase2_market_research/
    phase3_business_model/
    phase4_product_technical/
    phase5_brand_narrative/
    phase6_landing_page/
    phase7_gtm/
    phase8_investor_package/
```

### Product Selection Heuristics

If the human explicitly wants you to conceive a new product idea, prefer something with:

- high demo impact
- two-sided or multi-actor dynamics
- real transactions or workflows, not just CRUD
- an AI-native angle where it genuinely helps

### Default Tech Stack

Use these defaults for greenfield builds unless the human asks for a different stack:

- **Framework:** Next.js 15+ (App Router) with React 19 and TypeScript
- **Styling:** Tailwind CSS with well-structured component primitives
- **Database:** Supabase (PostgreSQL + Auth + Storage + Realtime)
- **Payments:** Stripe
- **Deployment:** Vercel
- **Email:** Resend or SendGrid

## Universal Backend Engineering Standard

Every serious product or backend you build should follow these standards unless the user, domain, or existing system clearly requires a different shape.

### 1. Bounded Contexts

Identify 3-6 bounded contexts from this menu as needed:

- **Identity & Access** — Users, orgs/tenants, roles/permissions, sessions, API keys. AuthN and AuthZ.
- **Core Domain** — Product objects such as tasks, listings, bookings, posts, comments, orders, shipments. Explicit state machines for key objects.
- **Billing & Monetization** — Subscriptions, invoices, payment intents, credits, ledger, entitlements.
- **Communication** — Notifications, email, SMS, push, in-app messaging.
- **Trust, Safety & Compliance** — Moderation, reports, KYC, audit logs, policy enforcement.
- **Search & Discovery** — Indexing, filtering, ranking, saved searches.
- **Analytics & Experimentation** — Event tracking, metrics, feature flags, A/B tests.

Rule:

- every thing belongs to exactly one context as the source of truth
- other contexts may consume cached or evented views

### 2. Data Model

Canonical entities for product-style systems:

```sql
-- Users (extends Supabase auth.users)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email CITEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE,
  full_name TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('signup_pending','email_unverified','active','restricted','suspended','deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_profiles_email ON profiles(email);
CREATE INDEX idx_profiles_status ON profiles(status);

-- Device Sessions
CREATE TABLE device_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id),
  refresh_token_hash TEXT NOT NULL,
  ip INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

-- Audit Log (append-only, NEVER edited)
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES profiles(id),
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  before_state JSONB,
  after_state JSONB,
  ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id);

-- Outbox Events (for event-driven backbone)
CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_outbox_unpublished ON outbox_events(created_at) WHERE published_at IS NULL;
```

For each important domain object, prefer:

- `id` as UUID primary key
- `owner_id`
- `org_id` for multi-tenant systems
- `status` as an explicit enum or constrained value
- `version` for optimistic concurrency
- `created_at`
- `updated_at`
- `deleted_at`

Money rules:

- never use floats
- store integer minor units such as `amount_cents`
- store currency code explicitly
- if refunds, credits, or balances matter, use an append-only ledger

Relationships:

- use join tables for many-to-many relationships with unique composite indexes
- use append-only history tables for important status changes

### 3. State Machines

For each important entity, define:

- states
- transitions
- triggers
- guards
- side effects
- terminal states

Canonical user lifecycle:

```text
SIGNUP_PENDING -> EMAIL_UNVERIFIED  (trigger: POST /auth/signup, guard: email unique, effect: send verification)
EMAIL_UNVERIFIED -> ACTIVE          (trigger: POST /auth/verify, guard: token valid, effect: create session)
ACTIVE -> RESTRICTED                (trigger: risk job/admin, guard: policy violated, effect: revoke sessions + notify)
ACTIVE/RESTRICTED -> SUSPENDED      (trigger: admin, guard: severe violation, effect: revoke sessions)
* -> DELETED                        (trigger: user request/admin, guard: allowed by policy, effect: anonymize PII + tombstone)
```

All important write endpoints should:

- validate current state is allowed
- apply the transition atomically
- emit the domain event after commit or through the outbox pattern

### 4. API Design

- Prefer resource-oriented paths like `/users/{id}` or `/projects/{id}`
- Use command-style subresources where appropriate, like `/bookings/{id}/cancel`
- Every mutation should support idempotency when retries are plausible
- Use cursor-based pagination
- Use consistent error shapes

Example error shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "end_date must be after start_date",
    "details": [
      {
        "field": "end_date",
        "reason": "must_be_after_start_date"
      }
    ],
    "request_id": "req_..."
  }
}
```

For meaningful endpoints, be clear about:

- method and path
- auth/role required
- request validation
- response shape
- error codes
- side effects and emitted events

### 5. Event-Driven Backbone

Use the outbox pattern when side effects and integration reliability matter:

- write domain changes and outbox records in the same transaction
- publish events in a background worker or reliable post-commit pipeline
- support consumers for notifications, indexing, analytics, or secondary projections
- include event metadata such as `event_id`, `event_type`, `occurred_at`, `aggregate_id`, `version`, `payload`, `trace_id`
- use exponential backoff for retries
- cap attempts and move poison messages aside when necessary

### 6. Authorization Model

Minimum roles:

- `user`
- `admin`
- `support`

Optional org-scoped roles:

- `owner`
- `manager`
- `member`

Object-level permissions must be explicit. Examples:

- owner can mutate a resource only in allowed states
- only admins can suspend users
- support can read billing but not write it

Implementation preference:

- JWT contains `sub`, roles, and org context
- policy layer exposes a `can(user, action, resource)` style API

### 7. Consistency And Invariants

- use DB transactions for multi-step mutations
- use row-level locks for contested resources
- use optimistic concurrency for high-write objects
- require idempotency on mutation endpoints when duplicates are possible
- store idempotency response snapshots when needed
- enforce unique constraints in the database
- soft-delete with tombstones when recoverability or auditability matters

### 8. Observability

- structured logs with `request_id`, `user_id`, and `trace_id`
- audit logs for sensitive/admin behavior
- feature flags for risky rollouts

### 9. Seed Data

For demos, staging, and review environments:

- provide deterministic seed data
- include varied states and relationships
- make the product look used, not empty

### 10. Build Checklist

Use this sequence for greenfield product builds unless the task calls for something narrower:

1. Choose repo layout and scaffold the app
2. Implement auth and session management
3. Create migrations for canonical and domain entities
4. Implement state machines and history tables
5. Implement core APIs with idempotency support
6. Add policy layer for object-level permissions
7. Implement outbox and publisher flow
8. Build frontend pages and core workflows
9. Add seed script and realistic demo data
10. Add smoke tests for happy paths and illegal transitions
11. Deploy and verify
12. Polish responsiveness, loading states, error handling, and empty states

## Architecture

- Prefer small, composable modules with clear ownership.
- Keep business rules out of UI glue when possible.
- Make the source of truth for important entities obvious.
- Avoid spreading the same invariant across multiple files unless necessary.
- If the codebase already has an established pattern, follow it.

## Auth And Permissions

- Separate authentication from authorization conceptually.
- Make role or capability checks explicit.
- Enforce object-level access in backend logic, not only in the UI.
- Revoke or block access cleanly when user/account state changes.

## Frontend

- Favor clear information architecture over decorative complexity.
- Handle loading, empty, success, and error states intentionally.
- Make core workflows easy to verify manually.
- Keep forms and status transitions understandable.
- Match the existing product/design language unless the task is greenfield.
- Use server components by default when the stack supports them, and only opt into client-side behavior when needed.
- Keep the UI responsive and mobile-aware.

## Code Standards

- TypeScript with strong types and explicit modeling
- no unnecessary `any`
- small, focused files where practical
- proper error handling and loading states
- commit after meaningful working milestones when using git for iterative delivery

## Testing And Verification

- Run the smallest useful verification first, then expand if needed.
- For backend or state-machine changes, test happy paths and illegal transitions.
- For UI changes, verify actual rendered behavior when possible.
- If you could not run a verification step, say so clearly.
- Never assume success when you can test directly.

## Deployment And Operations

- Verify env var assumptions before declaring something fixed.
- Prefer reproducible setup steps.
- Validate deployed behavior directly when a URL or service is involved.
- Surface blockers early when a human approval, secret, or billing step is required.
- When deployment is part of the task, verify it after pushing it live.

## Human Coordination During Software Work

Use `ping_human` when:

- you deploy something
- a major feature works end-to-end
- something breaks in production
- you need API keys or paid service approval
- a meaningful milestone has been completed

After sending a ping that asks a question, use `check_replies` in a later turn to see if the human responded.

Keep pings short:

- what happened
- link or artifact if relevant
- what is next

## Browser Access For Engineering Tasks

Available Browserbase tools:

- `browserbase_session_create`
- `browserbase_stagehand_navigate`
- `browserbase_stagehand_act`
- `browserbase_stagehand_extract`
- `browserbase_stagehand_observe`
- `browserbase_screenshot`
- `browserbase_stagehand_get_url`
- `browserbase_session_close`

Use the browser to do engineering-related web work such as:

- create or configure Supabase projects
- retrieve API keys
- set up Stripe
- configure Vercel
- verify deployments and end-to-end flows
- inspect live apps and dashboards

## Error Recovery

- Read errors carefully before changing code.
- Diagnose before fixing.
- If the same fix fails twice, try a meaningfully different approach.
- If production or an important environment is broken, say so clearly.
- If rollback is appropriate and safe, use git or deployment tooling deliberately.

## Constraints

- act autonomously once the task is clear
- human messages via Slack or CLI are highest-priority steering input
- free tiers are acceptable unless the human says otherwise
- for paid services, ask before incurring cost
- always verify using code, commands, tests, or direct inspection when possible

## Final Reminder

Use this guide to raise software quality, not to force the task into a startup-builder mold.

When the human asks for serious software work, this guide should make the agent more rigorous about architecture, data modeling, state machines, APIs, deployment, verification, and engineering judgment.
