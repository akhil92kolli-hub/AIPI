# AIPI Team implementation backlog

Current cross-repository priorities and acceptance are reconciled in [the trusted change and release plan](AIPI-TRUSTED-CROSS-REPO-RELEASE-PLAN-2026-10-23.md). This backlog's checkboxes record historical component implementation; they do not establish trusted context, complete sync, automatic discovery or deployment compatibility. Preserve the newer [source identity contract](AIPI-WORKFLOW-ACCEPTANCE-2026-10-23.md).

Started: 20 October 2026. Owner: AIPI engineering.
Product outcome: developers and agents can resume shared work, identify affected
repositories, and verify changes against explicit source revisions.

This backlog extends the existing local MVP. Existing workspace groups, task
context, relationship reviews, Git publishing, and verification remain in place.
Checkboxes report implementation. Deployment status is recorded under each
milestone because local code and the hosted database can advance separately.

## M1 — Portable identity and repository binding

Dependency: none. Exit: a workspace retains project IDs across machines without
sharing local paths or granting membership.

- [x] TEAM-101: Introduce schema-v2 portable workspace manifest projection.
- [x] TEAM-102: Validate GitHub repository ID, credential-free URL, and monorepo root.
- [x] TEAM-103: Add authenticated GET/PUT `/api/workspaces/:id/manifest`.
- [x] TEAM-104: Enforce membership and binding versions; invalidate other workspaces
  when a shared project's binding changes.
- [x] TEAM-105: Test atomic validation, secret/path exclusion, conflicts, and HTTP auth.
- [x] TEAM-106: Add dashboard binding editor.
- [x] TEAM-106a: Add explicit dashboard manifest export/download and guarded import.
- [x] TEAM-107: Resolve immutable repository IDs through authenticated provider lookup;
  verify the ID matches the remote before marking identity verified.
- [x] TEAM-108a: Add a device-local checkout mapping API that verifies a selected
  configured source root has the project's bound GitHub remote.
- [x] TEAM-108b: Support multiple named local worktrees per project without changing
  project IDs.
- [x] TEAM-109: Expose the portable manifest and local checkout mappings through MCP.
- [x] TEAM-108c: Add an explicit imported-manifest resolution UI.

Repository identities can be verified on demand against the GitHub API. Null
repository supports an unbound local project. Existing
Git publish bindings remain separate because they include local execution details.

## M2 — Supabase tenancy and shared records

Depends on M1 identity contract. Exit: organization and project permissions protect
every record and artifact, including indirect search/graph access.

- [x] TEAM-201: Inventory deployed schema and migration history for project
  `zwffmaxjbzuazopvorkv`; compare with checked-in SQL before proposing changes.
- [x] TEAM-202: Reconcile existing organizations, memberships, and registry tables
  with workspace/project identity; document legacy-ID mapping.
- [x] TEAM-203: Create a staged migration for workspace membership, repository
  identity, devices, tasks, decisions, evidence, and revision sets.
- [x] TEAM-204: Implement scoped roles and RLS; live rollback tests cover owners,
  viewers, cross-organization isolation, and revoked membership.
- [x] TEAM-205: Deploy authenticated Worker routes for organizations, members,
  workspaces, project bindings, tasks, decisions, evidence, and device revocation.
- [x] TEAM-206: Match local and hosted migration ledgers, exercise transactional
  logical restore, and document rollback in `docs/AIPI-TEAM-RECOVERY.md`.

Reuse existing organization membership machinery after auditing it. Do not create
a parallel role system. A portable manifest never establishes organization access.

Deployed on 20 October 2026 to Supabase project `zwffmaxjbzuazopvorkv`:
all checked-in migrations through `20261020220000_team_retention_schedule` are
recorded in `supabase_migrations.schema_migrations`. The team tables use provider
repository IDs directly, so the portable workspace binding does not depend on
a local database UUID. Legacy `api_contracts.repository` values remain text and
can be reconciled with canonical `repositories` rows during import. The hosted
project currently has zero persistent organizations and memberships. Live RLS
and handoff checks use synthetic users inside rolled-back transactions. The
Worker API is deployed to `mcp.aipi.website`. Managed backups are not currently
enabled; see the recovery document before a paid pilot.

## M3 — Durable offline synchronization

Depends on M2. Exit: reconnecting devices converge with no lost acknowledged writes.

- [x] TEAM-301: Introduce SQLite cache/outbox with a backed-up, restartable migration
  from the current JSON store; retain a recovery path.
- [x] TEAM-302: Define versioned task, context, decision, evidence, comment,
  and receipt operation envelopes with durable server deduplication.
- [x] TEAM-303: Commit records, accepted-operation acknowledgments, and ordered
  change events atomically. Workspace and repository binding changes also emit events.
- [x] TEAM-304: Implement bounded paginated pulls, tombstones, snapshot recovery,
  retry backoff, visible failures, and a daily 30-day retention job.
- [x] TEAM-305: Use optimistic task versions, append-only comments and receipts,
  and superseding decisions to resolve concurrent edits.
- [x] TEAM-306: Use Realtime to invalidate the local cache while a persistent
  outbox dispatches operations; polling recovers missed notifications.
- [x] TEAM-307: Test interrupted acknowledgments, duplicates, reordered delivery,
  expired cursors, concurrent edits, binding changes, and offline revocation.

The companion stores team state in `team-sync.sqlite` beside the local workspace
and retains unacknowledged writes across restarts. Each accepted operation has a
server acknowledgment independent of the prunable event log. A snapshot resets an
expired cursor. Workspace/project changes enter the same organization-ordered feed;
a bound repository path is never copied from a developer's local checkout. The
daily `aipi-team-change-retention` pg_cron job prunes only an acknowledged,
contiguous event prefix older than 30 days and advances the sync floor.

## M4 — Shared task context and handoffs

Depends on M3. Exit: a teammate resumes a task with current scope, decisions, and evidence.

- [x] TEAM-401: Synchronize task context, owners, decisions, and comments.
- [x] TEAM-402: Add permission-filtered, bounded `context.resolve` and decision search.
- [x] TEAM-403: Include provenance, freshness, unresolved dependencies, and revision sets.
- [x] TEAM-404: Deploy the shared-task page on Cloudflare Workers using the
  same domain API, with email-link sign-in, task creation, and comments.
- [x] TEAM-405: Verify two-user SQL handoff, local MCP cached-context delivery,
  remote MCP context tools, and compatible IDE extension packaging.

The current cloud team page is
`https://aipi-team-cloud.ceo-935.workers.dev/team` (Cloudflare Worker). Its
exact `/team` redirect is allowlisted in Supabase Auth. The older Sites copy at
`https://aipi-developer-intelligence.maplecrown.chatgpt.site/team` remains live;
the Sites connector could not resolve that project for the latest update, so
use the Worker URL. The hosted project has no persistent team users or seeded
tasks, so the two-user acceptance check used rollback-only synthetic users and
cannot substitute for a paid-pilot sign-in with real people. The pilot check
belongs to M7.

## M5 — Cross-repository impact

Depends on M4. Exit: seeded contract changes yield accurate, traceable consumer reports.

- [x] TEAM-501: Persist typed graph nodes/edges using qualified project identities.
- [x] TEAM-502: Separate declared, static, runtime, and AI-suggested evidence.
- [x] TEAM-503: Add commit-pinned revision sets and stale-evidence invalidation.
- [x] TEAM-504: Implement impact analysis with affected owners and required checks.
- [x] TEAM-505: Build a labeled test corpus; measure precision and missed dependencies.

Reuse existing relationship reviews and contract indexing; preserve explicit human
rejections and approvals. Start with GitHub and supported HTTP contract formats.
Migration `20261020230000` is live. The ten-case synthetic corpus reports
precision 1.00 and recall 1.00; these are fixture scores, not field accuracy.
The live rollback verifier passed for graph tenancy and preserved rejections.

## M6 — Verification and PR workflow

Depends on M5. Exit: a PR report distinguishes passed, failed, stale, and unverified checks.

- [x] TEAM-601: Add GitHub integration with scoped installation permissions and verified webhooks.
- [x] TEAM-602: Associate CI receipts with trusted producer, exact commits, and environment.
- [x] TEAM-603: Attach task/impact reports to PRs with deduplicated updates.
- [x] TEAM-604: Recheck applicability after commits or contract revisions change.
- [ ] TEAM-605: Demonstrate the two-repository contract-change workflow end to end.

Migrations `20261020240000` and `20261020260000` are live. The latter binds a
PR report to a task in the same workspace. The signed-webhook and GitHub App code is
deployed but the hosted Worker still needs an App ID, private key, webhook
secret, and Supabase service-role key. Until configured, webhook ingestion and
PR publication fail closed with 503. The two-repository fixture tests passed;
TEAM-605 needs a real App installation and trusted CI run on two repositories.

## M7 — Paid pilot readiness

Depends on M6. Exit: pilot teams repeatedly finish the task → impact → verification loop.

- [x] TEAM-701: Implement server-enforced entitlements, seats, and usage budgets.
- [x] TEAM-702: Add pairing/revocation UX and explicit source-sharing policies.
- [x] TEAM-703: Add onboarding, diagnostics, retention, export, and deletion.
- [ ] TEAM-704: Exercise restore and incident recovery; document service objectives.
- [ ] TEAM-705: Recruit pilot teams and measure activation, weekly use, investigation
  time, impact precision, and handoff time before fixing commercial pricing.

Migrations `20261020250000` and `20261020270000` are live. The entitlement, source-policy, plan-expiry, and
synthetic delete/restore rollback verifiers passed. The team page exposes
repository binding, plan/usage diagnostics, source policy, device revocation,
export, and owner-confirmed deletion. The logical restore drill and service
objectives are documented in `docs/AIPI-TEAM-PILOT-RUNBOOK.md`; TEAM-704 remains
open because a managed/off-site backup and a separate-project restore have not
been enabled or rehearsed. TEAM-705 requires real pilot teams and measured use.

## M8 — Two developers, one shared workspace

Exit: a developer connects from the IDE once, the companion survives a restart and
token expiry, and a teammate can read and update cloud tasks while that companion
is offline.

- [x] TEAM-801: Pass the browser's signed-in session through the scoped IDE
  pairing ticket and protect the refresh token in the local OS credential vault.
- [x] TEAM-802: Restore the most recently connected team session on companion
  restart and renew access and Realtime authentication as tokens rotate.
- [x] TEAM-803: Refresh the selected cloud task and task list while the page is
  open, preserve workspace selection, and display the last successful refresh.
- [ ] TEAM-804: Run a real two-developer acceptance test in VS Code and Cursor,
  including an expired token, companion restart, offline edits, and a teammate
  resuming the task while the originating companion is stopped.
- [ ] TEAM-805: Confirm task and repository changes from a real GitHub App
  installation, then add task-specific asynchronous knowledge processing.

The cloud page reads shared records from the hosted team API. A companion only
needs to be online for local edits and live local dashboard access. Token renewal
uses Supabase Auth and saves each rotated refresh token in the OS credential
vault. A real two-person acceptance run remains necessary before marking this
milestone complete.

## API contract for the first increment

`GET /api/workspaces/:id/manifest` returns `{ manifest }`. Save that manifest body
with `PUT` to the same route after assigning `resources[].repository`:

```json
{
  "provider": "github",
  "providerRepositoryId": "123456789",
  "remote": "https://github.com/company/platform",
  "root": "services/orders"
}
```

Send the complete resource set and unchanged `membershipVersion` / `bindingVersion`
from the GET response. A conflict returns 409 and requires reloading. The server
retains project names and membership from local state and projects only allowlisted
repository fields. Unknown projects cannot be imported through this operation.
Saving does not clone, change Git remotes, execute commands, or contact the cloud.

Validation:

```sh
node tests/workspace-manifest.test.mjs
npm run test:workspaces
npm run typecheck
```

Results on 20 October 2026: all six workspace suites passed, including manifest
unit tests and authenticated HTTP persistence/conflict tests; TypeScript checking
passed. The M2 SQL deployment and cloud API smoke test were verified separately.

Continuation result: device-local checkout mappings are stored only in the
companion state and are accepted only when the configured source root has a Git
remote matching the project's declared GitHub identity. Manifest exports do not
include these mappings.
