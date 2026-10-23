# AIPI product correction: one workspace application, local and Team modes

Date: 2026-10-21
Status: proposed corrective architecture and implementation backlog
Basis: source-code audit of the current companion, IDE bridge, Team website, Worker and migrations. This is not a new claim of live browser or production acceptance.

## 1. Product contract

AIPI is a workspace for understanding and completing changes across multiple projects. Its core loop is:

**Understand dependencies → scope a task → hand off bounded context → change code → run relevant checks → preserve revision-specific proof → review and integrate.**

Local and Team use the same application and domain model. The local application and extension remain free for single-user use, including local source indexing, local Git, knowledge, tasks, contracts, MCP handoff and verification. Team adds workspace synchronization, shared history, access control, GitHub integration, durable background jobs and collaboration. Each workspace has its own subscription and entitlement; an account can have several free and paid workspaces.

The application opens a workspace selector. A workspace contains projects such as repositories, subdirectories, local-only source folders and external API services. Selecting a workspace opens the same five tabs: Home, Explore, Tasks, K-Maps and Tools. A project selector filters those views without losing the workspace context. Settings manages workspace resources, local checkouts, access, subscription, provider connections and automation policy.

At 480px and below, the same application uses its compact layout. Above 480px, it progressively uses browser space for navigation, context panels and code/diff inspection. Layout depends on the available container width, including a narrow IDE webview in a large monitor. A wider viewport does not select a different product or authorize more actions.

## 2. Audited implementation gaps

| Finding | Current source evidence | Required correction |
| --- | --- | --- |
| The Team UI is a separate task application | `sites/aipi-public/app/team/dashboard/page.tsx:158` renders its own shell and task-only navigation. The existing five-tab navigation is in `ui/app.js:1091`. | Extract and deploy one application shell and feature implementations; keep website account/onboarding screens separate. |
| Workspace and project identities are mixed | `packages/core/workspace-groups.mjs:10` creates a grouping overlay. `packages/core/workspace-manifest.mjs:29` already exports multiple project resources. Team onboarding uses one `projectKey` in `packages/core/team-onboarding.mjs:8`. | Make the existing workspace group the upgrade boundary; retain project IDs as resource identities and migrate legacy aliases. |
| Billing is organization-wide | `supabase/migrations/20261020250000_team_pilot_controls.sql:3` keys entitlements by organization; usage and source policies also use organization IDs. | Introduce workspace subscriptions, entitlements, usage and sharing policy. The organization remains the ownership/billing account. |
| GitHub user permissions do not authorize Team writes | `supabase/migrations/20261020120000_team_task_operations.sql:37` checks organization role. Existing workspace read policies allow organization members. | Enforce workspace membership and per-resource capabilities derived from GitHub identity and access. Apply equally to API, RPC, Storage, Realtime and jobs. |
| Installation connection does not prove the connecting user's GitHub rights | `cloud/worker.ts:611` verifies an installation using the App identity and an AIPI owner/admin role. `20261020240000_team_github_pr.sql:72` also grants authenticated organization admins installation CRUD. | Verify the user's access to that installation/account/repository and route authoritative installation grants through a trusted broker. Remove client paths that can manufacture verification. Do not enable write automation on the present model. |
| Sync is only a task-metadata bridge | `packages/core/team-local-reconcile.mjs:17` explicitly limits synchronization to titles/statuses. The outbox supports task and append-only context records in `team-sync-store.mjs:52`. | Add domain operations and projections for the whole workspace: resources, tasks, milestones, contracts/revisions, graph, decisions, handoffs, receipts and policies. |
| Metadata sync can erase richer cloud fields | `team-local-reconcile.mjs:44` sends `description: ""` and `revisionSet: []`; the latest task RPC in `20261020200000_team_task_fingerprint.sql:80` assigns both fields. | Use explicit field patches or retain all untouched fields. Add a regression test where a local status edit preserves a cloud description and revision set. |
| Status normalization loses local states | `team-onboarding.mjs:24` does not map local `in-progress` or `in-review`, so they fall back to `open`. | Define one lifecycle with backward-compatible aliases and separate agent execution, verification and integration states. |
| Remote tasks remain a parallel list | `ui/app.js:2072` displays a separate shared lane rather than hydrating canonical task records. | One task identity and projection across devices; remote edits update the same task view, with explicit conflicts. |
| One active organization session is restored | `scripts/dashboard-server.mjs:1066` restores only the latest organization link into one session variable. | Manage authenticated sync sessions per account/organization and workspace subscriptions without cross-account data reuse. Local startup must work while cloud is unavailable. |
| Blast-radius components exist, but are disconnected | `packages/core/team-impact.mjs:5`, `team-pr-report.mjs:3` and `cloud/worker.ts:579` implement graph impact and revision-specific reporting. | Publish the actual local graph/contracts, map changed symbols/contracts from PR diffs, create check plans, execute them and present the result in the common task/PR UI. |
| Knowledge is not refreshed from general commits | `cloud/worker.ts:603` accepts only `pull_request` and `check_run` webhooks. | Add durable commit/PR ingestion, content retrieval, indexing, invalidation, recovery and optional LLM summaries. |
| GitHub code inspection is missing | The cloud page links out to repositories/PRs; it has no common source or diff provider. | Read permission-checked source at an immutable commit, expose base/head diffs, and represent binary/oversize/incomplete results honestly. |
| Provider settings and planning automation are absent | No LLM-provider execution, weekly-report, forecasting or durable milestone orchestration service was found in the audited source paths. Local milestone CRUD and agent handoff already exist. | Build these on shared tasks, events and verification after the foundation works. |

These are source findings, not a claim that the database has no additional objects or that the current production UI was visually tested. Passing component tests does not establish the complete Team product workflow.

## 3. Architecture to implement

### One domain and one presentation layer

Retain useful logic in `packages/core`, contract indexing, OTel ingestion, replay/verification, the durable outbox and MCP tools. Introduce clear runtime-neutral contracts and adapters rather than rewriting these engines.

Suggested boundaries:

- `packages/domain`: schemas, lifecycle rules, entity identities, revision references, capabilities and operation envelopes. No Node filesystem or browser dependencies.
- `packages/application`: use cases and query contracts for workspace selection, exploration, task management, K-Maps, verification and integrations.
- `packages/dashboard-ui`: shared five-tab UI, responsive layouts, source/diff viewer and feature controllers. Incrementally extract `ui/app.js`; a framework migration is not a prerequisite.
- `packages/adapters/local`: local storage, filesystem/Git, secret vault, source index and local runner.
- `packages/adapters/cloud`: authenticated Team API, Supabase persistence, source provider, cloud job dispatch and workspace synchronization.
- `packages/adapters/ide`: trusted extension bridge, editor navigation, agent capability adapters and local companion discovery.
- `cloud`: authorization broker, GitHub ingress, queries/commands and durable-job scheduling. Heavy repository builds and tests run in explicit runners, not in an HTTP request.

Use capability-aware operations such as `readSource`, `readDiff`, `requestVerification`, `openInEditor` and `dispatchTask`. A source-only browser session can request CI verification. A local companion can execute the equivalent plan locally. An offline runner produces a queued request, not a simulated success. The UI explains unavailable capabilities beside the relevant action.

### Canonical ownership

```text
Account / organization
  └─ Workspace (stable ID, mode, membership, policy, own subscription)
      ├─ Project resource (stable ID; repo / local source / external service)
      ├─ Milestones and tasks (may target several project resources)
      ├─ Contract identities and immutable revisions
      ├─ Knowledge nodes/edges and source references
      ├─ Changesets, commits, PRs, agent runs and decisions
      └─ Verification plans, executions, receipts and audit events

Device bindings: workspace/project ID → local checkout path; never an access grant.
```

Use one logical ID for an entity across local and cloud projections. Preserve `wsg_`/`prj_` legacy identifiers through aliases or explicit mappings during migration; do not regenerate task identity when a workspace is upgraded. A workspace has a remote UUID mapping if needed by existing Supabase tables. A portable `.aipi` manifest records resources and remote binding IDs, never passwords, tokens or machine-specific checkout paths.

The existing `team_*` physical tables can remain behind adapters while their model is extended. A broad table rename or destructive replacement is unnecessary. Distinguish a source artifact/contract identity from a revision of that artifact at a repository commit. Every cross-project reference carries its project/resource ID.

### Data authority and synchronization

- **Git/GitHub:** authority for source commits, branch state, diffs and GitHub approvals.
- **Supabase Postgres:** accepted shared workspace state, contracts, graph metadata, tasks, milestones, policies, knowledge provenance and audit/job records.
- **Authenticated object storage:** approved source snapshots, replay artifacts and large immutable evidence, referenced by content hash and protected by resource access. Avoid storing whole repository trees as task JSON.
- **Local storage/cache:** free local workspaces and the offline working projection of connected Team workspaces. Machine paths, local credentials and unshared dirty changes stay device-specific.
- **Realtime:** notification that durable state changed. Cursor-based pulls and replayable operations remain the recovery mechanism.

An operation includes `operationId`, `workspaceId`, `actorId`, `deviceId/runnerId`, `entityId`, `action`, `baseVersion`, schema version and changed fields. The server authenticates the actor; client-supplied actor IDs do not grant identity. One transaction authorizes the operation, checks the version, applies it and writes a durable event. Repeated operations produce one accepted result. Mutable concurrent edits become a visible conflict; comments/evidence append independently. Deletions use tombstones and retention rules.

For connected Team workspaces, the server arbitrates shared writes and local state remains a synchronized cache with a durable outbox. Free local workspaces require no server. Upgrading must not destroy the original local workspace or force every personal draft into the shared projection. Canceling the subscription stops paid cloud services according to the retention/export policy while preserving local work and export access.

Sync all agreed domain data, not secrets indiscriminately. Environments synchronize redacted configuration and secret references. Replay bodies, traces, source snippets and credentials need distinct sharing policies. Local-only projects can share approved knowledge without publishing their code. Source inspection for such a project requires an explicitly shared snapshot or its authorized companion; the browser cannot invent missing files.

### Authorization

Separate five concepts: authentication, workspace membership, repository access, paid entitlement and execution permission.

For a GitHub-backed resource, effective permission is the intersection of workspace role, current GitHub user access, installed App access and workspace policy. A paid subscription does not grant repository rights. Being an AIPI owner does not grant GitHub push rights. Cross-project tasks authorize every touched resource. Team members without access to a private repository must not receive its source, contract details or inferred graph metadata through aggregates.

Use GitHub App user authorization for interactive GitHub actions and narrowly scoped installation identity for ingestion/background services. Validate installation ownership/access at connection time; do not accept an installation ID as proof. Remove direct client CRUD on authoritative permission/installation verification records. Store expiring access snapshots on trusted server paths with revocation handling and recheck sensitive writes. RLS uses these workspace/resource grants, with authorization tests for direct RPC/REST/Storage/Realtime access as well as the Worker.

Local-only folders and external endpoints have no GitHub permission to inherit: workspace policy controls their shared metadata and authorized runners control execution. Local free Git remains fully usable without a GitHub sign-in.

Commit, push, PR creation, approval and merge are distinct permissions and actions. A policy can permit automatic commits to a task branch and PR creation after checks; merge still honors GitHub reviews/rulesets and exact-current-revision checks. Automated work uses a scoped service identity under an explicitly configured workspace policy. It must not turn an individual user's absent rights into App-wide authority.

## 4. Intended user flows

### Existing local user upgrades a workspace

1. Work offline/free in a workspace containing several resources.
2. Choose **Upgrade this workspace to Team** in workspace settings or the IDE. The handoff identifies the entire workspace and its resource manifest.
3. Browser sign-in/signup returns to the pending upgrade. Reuse secure PKCE authorization and a short-lived one-use handoff; no access token in a URL.
4. Choose the owning account and either create a Team workspace or link an existing permitted one. Show the resource list and sharing scope.
5. Connect GitHub identity and install/choose the AIPI App for selected repositories. Resolve local checkout mappings independently. Local-only and external resources are explicitly labeled.
6. Activate that workspace's subscription/trial, confirm initial synchronization and receive a progress/result screen. Retry or cancel safely without duplicate resources or tasks.
7. The same five-tab application opens on the same workspace. The IDE and browser show the same tasks/contracts/knowledge, with device-specific execution capability and visible sync state.

### Invited teammate

Accept a workspace-scoped email invitation → sign in → connect GitHub if source access is needed → see only permitted workspace resources → open browser dashboard or **Open in IDE** → select/clone local repositories → verify checkout identity → synchronize. An email invitation never grants GitHub repository access by itself.

### Cloud-first user

Sign in → create a workspace → choose GitHub repositories/external services → start its Team subscription/trial → background indexing → common five-tab dashboard. No online companion is required to browse indexed repository source and knowledge or trigger an authorized runner. An **Open locally** flow binds existing or cloned checkouts to the same resources.

### Daily change workflow

Task or milestone → scoped dependency/context pack → claim an agent run → edit on a branch → inspect diff and blast radius → run required tests/replay → collect immutable receipt → human review or configured policy → GitHub PR/merge → index the merged revision → update knowledge and reports. Every transition records actor, revision and provenance. Agent-reported completion, verification success and merged delivery are separate facts.

## 5. Corrective milestones and actionable backlog

Use R0–R7 to distinguish these corrective milestones from earlier M1–M7 records. Existing implementations are reusable components; they do not establish acceptance of these milestones.

### R0 — Lock the product model and prevent data loss

- R0.1 Define canonical Workspace, ProjectResource, Task, ContractRevision, EvidenceReceipt, Changeset and Capability schemas; document compatibility with existing IDs/statuses.
- R0.2 Change local task reconciliation to explicit patches; preserve cloud descriptions, revisions and unrelated fields.
- R0.3 Add status alias conversion and distinguish work status from verification/integration state.
- R0.4 Audit/remove unverified installation and permission-grant write paths; retain read-only operation until the verification broker exists.
- R0.5 Define free-local and per-workspace-paid feature boundaries, expiry/export behavior and resource sharing defaults.
- R0.6 Establish a fixed acceptance fixture: React frontend, two Python services, one external API, two users, two devices and an agent.

**Acceptance:** replaying a local status edit cannot erase cloud context; every existing workspace can be mapped without losing IDs; cross-organization and unauthorized installation writes are denied; the fixture is reproducible.

### R1 — One application and workspace navigation

- R1.1 Extract the current five-tab navigation, shared task views, K-Maps and UI primitives incrementally from `ui/app.js`.
- R1.2 Add an application-service/data-provider boundary around current API calls rather than copying local endpoints into the cloud page.
- R1.3 Make workspace selection first-class, with an all-projects view and explicit project filter.
- R1.4 Manage resource membership and checkout bindings through workspace/project settings, including external services.
- R1.5 Replace the separate `/team/dashboard` task application with the common application; retain onboarding/account/billing as supporting routes.
- R1.6 Verify compact layout at 380/480px and browser layouts at 768/1280/1600px, including code panels and keyboard navigation.

**Acceptance:** local browser, cloud browser and IDE render the same five tabs and equivalent task details from the same domain fixture. No copied Team-only task implementation remains as the product's main dashboard. Missing execution capabilities have an explicit state.

### R2 — Secure workspace upgrade, membership and subscriptions

- R2.1 Add workspace membership/invitations and workspace-scoped policy, entitlements, usage and subscription records.
- R2.2 Implement a billing-provider adapter and signed, idempotent billing-event handling; model trial/active/grace/read-only states.
- R2.3 Upgrade an entire workspace manifest using the existing PKCE foundation; support reconnect, resume and selection of an existing remote workspace.
- R2.4 Link GitHub user identity, verify App installation access and derive per-repository capabilities. Enforce them on server commands, database access and artifact reads.
- R2.5 Handle repository removal, installation suspension, user access changes, invitation revocation and expired sessions.
- R2.6 Replace the single active-org sync session with an account/session manager; cloud restoration must not block local startup.

**Acceptance:** two workspaces have independent entitlements; an invited user without repository write permission cannot change source through AIPI; direct Supabase requests cannot bypass that rule; revocation stops new authorized reads/writes according to the defined cache policy; free local usage still works while signed out/offline.

### R3 — Complete workspace state and source parity

- R3.1 Add synchronized operations/projections for resources, tasks, milestones, contracts/revisions, K-Map graph, decisions, handoffs, evidence and verification receipts.
- R3.2 Hydrate one canonical task view from remote changes; remove the parallel cloud-task workaround.
- R3.3 Add initial snapshot/resume, cursor recovery, schema upgrades, tombstones, explicit conflict review and selective artifact upload.
- R3.4 Build authenticated GitHub source and base/head diff providers with pagination, binary/oversize markers and immutable revision references.
- R3.5 Add local-only resource snapshot/connector capability without requiring users to share all source.
- R3.6 Share redacted environment schemas and runner/secret references, never raw secret vault contents.
- R3.7 Provide workspace change history with actor/agent identity and links to affected entities and GitHub changesets.

**Acceptance:** browser-created task/milestone/contract context appears in both IDEs; local edits and receipts return to the same cloud entity; offline edits reconcile without duplication or silent overwrites; browser Explore and K-Maps work with every companion offline; unauthorized repository data does not appear in graphs/search/history.

### R4 — Blast radius and closed-loop integration

- R4.1 Publish the actual local/CI AST and contract graph with project-qualified identities and exact revision provenance. Extend bounded graph queries beyond the current fixed corpus limits with pagination and explicit coverage.
- R4.2 Add commit/PR diff → changed symbols/routes/contracts mapping, including schema and consumer changes.
- R4.3 Produce an impact plan containing affected callers/services/tests, relationship evidence, owners and missing coverage. Distinguish confirmed, inferred, stale and unknown.
- R4.4 Reuse the verification planner to dispatch relevant checks to a local runner or GitHub Actions/self-hosted runner. Bind results to commit vectors, contract revisions, environment/config fingerprints and check-plan version.
- R4.5 Preserve AST findings, OTel observations, replay/test receipts and their different trust levels. A runtime HTTP success alone is not proof of the entire change.
- R4.6 Display the implementation chain, diff, check plan and evidence in the common UI; publish a GitHub check/report without manufacturing success from missing evidence.
- R4.7 Re-evaluate on a changed PR head, dependency revision or relevant environment. Respect merge-queue revisions when used. Cross-repository rollout is a set of dependent PRs, not an atomic multi-repository merge.
- R4.8 Validate Python parser coverage explicitly: current FastAPI route extraction is pattern-based, while TypeScript HTTP analysis uses `ts-morph`. Do not label all Python relationships AST-verified until a language adapter supplies that evidence.

**Acceptance:** removing a field from a Python response identifies the React consumer, selects its checks, detects the failure, records proof after repair and invalidates that proof when the head changes. Missing repositories/checks appear as unknown coverage. A configured GitHub merge rule consumes the current AIPI check.

**Paid product release gate:** R0–R4 pass the complete two-user/multi-project journey. This is the first release that satisfies the Team product promise.

### R5 — Asynchronous knowledge and workspace LLM settings

- R5.1 Verify and durably enqueue commit/PR/install/permission webhook events; add retries, deduplication, failed-job review and scheduled reconciliation for missed deliveries.
- R5.2 Retrieve changed source at a commit and update deterministic indexes, contract revisions and invalidation records before asking an LLM for interpretation.
- R5.3 Add provider/model configuration, per-workspace budgets, server-held Team credential references and local OS-vault credentials for free local use.
- R5.4 Add durable multi-step jobs for summaries, architectural decisions, stale-knowledge review and candidate task proposals. Every generated statement cites source commits/files and records model/run provenance.
- R5.5 Restrict retrieval and job execution to authorized resources; treat source/comments/model output as untrusted data, and keep generated relationship suggestions separate until reviewed or accepted by explicit policy.
- R5.6 Expose pending/running/failed/succeeded status, cancellation, retries, provider cost usage and freshness in the common UI.

**Acceptance:** a commit updates relevant knowledge with no user browser online, duplicate deliveries do not duplicate work, revoked repository access prevents new jobs, provider errors recover visibly, and generated claims remain traceable to the indexed commit.

### R6 — Asynchronous task/milestone execution and agent interoperability

- R6.1 Model TaskRun, runner capabilities, leases, heartbeats, cancellation, dependency blocking, retries and concurrency budgets.
- R6.2 Reuse bounded MCP context and `complete_handoff` receipt requirements; add adapters for supported IDE/agent hosts without assuming arbitrary control over any installed chat extension.
- R6.3 Execute a milestone's ready tasks on explicit local/CI/remote runners with isolated branches/worktrees and workspace-scoped credentials. Reclaim failed leases without concurrent duplicate changes.
- R6.4 Add reviewable policies for manual changes, automatic task-branch commits, PR creation and separately authorized auto-merge, always subject to repository protections.
- R6.5 Present task execution, evidence readiness, review and integration as distinct states with durable history and human intervention.

**Acceptance:** a dependent task waits for the upstream result, an agent can resume with bounded context after failure, claimed completion requires current proof, cancellation stops scheduled work, and the policy cannot bypass GitHub rights or required reviews/checks.

### R7 — Roadmaps, weekly reports and defensible estimates

- R7.1 Generate editable roadmap/milestone/task proposals from goals, the current graph, unresolved risks and team capacity. Preserve owner approval and traceable dependencies.
- R7.2 Produce weekly reports from accepted task/commit/PR/verification events with configurable timezone, audience and reporting window.
- R7.3 Show delivery forecasts as ranges and confidence based on actual throughput, cycle times, dependencies and available capacity. State insufficient history explicitly.
- R7.4 Separate development effort estimates, observed model-token/API cost and runner/infrastructure cost. Record estimation method/model and compare forecasts with actual outcomes.
- R7.5 Link report statements and estimates to source events; allow corrections and retained versions.

**Acceptance:** every completed-work claim has task/PR/receipt evidence, reports survive reruns without counting duplicate events, and cost/time ranges expose assumptions rather than presenting token heuristics as measured savings.

## 6. Acceptance and product success

Each milestone requires integrated evidence in addition to component tests. Record exact application/API/extension versions and migration state. Exercise user sign-in, invitation, upgrade, two accounts with different GitHub rights, two devices, offline changes, access revocation, cloud outage, source/diff inspection and stale receipt behavior. Test real supported Python/React cases rather than only synthetic graph fixtures. Keep free-local regression coverage as a release gate.

Prioritize measures that prove the development loop is useful:

- Time from opening a task to a grounded context pack.
- Precision/recall and explicit coverage of blast-radius results on labeled real changes.
- Percentage of relevant checks with current, trusted revision-specific evidence.
- Contract-breaking changes detected before merge, with verified examples.
- Time to a resumed teammate/agent handoff and reduction in repeated context work.
- Time to a usable Team workspace, synchronization conflicts/data loss and permission-revocation behavior.
- Weekly active Team workspaces repeatedly using context → change → verification → integration.

Do not use lines of generated summaries, task counts or speculative dollar savings as the primary proof of value. Weekly reports and forecasting follow the trustworthy engineering loop.

## 7. External design references checked

- [GitHub App acting on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user): user-mediated access is limited by user and App access. Installation identity alone is not a user's authorization.
- [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets): required checks/reviews and explicit bypass rules remain GitHub integration constraints.
- [GitHub required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks): current SHA and merge-queue revision handling matter to verification freshness.
- [GitHub webhook practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks): quick acknowledgment, durable asynchronous processing and delivery deduplication/recovery.
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security): grants and policies must protect exposed data; privileged service credentials stay server-side.
- [Cloudflare async-work guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): Queues decouple event processing; Workflows support durable dependent steps. These orchestrate runners rather than making HTTP requests a build execution environment.
