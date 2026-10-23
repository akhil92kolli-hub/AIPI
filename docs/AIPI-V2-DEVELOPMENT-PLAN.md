# AIPI v2 development plan

Date: 9 October 2026

Basis: the supplied 21-page *AIPI v2 Design, Development & Deployment Specification*, revision 2.1, plus inspection of the current working tree. The PDF is a requirements baseline; it explicitly does not certify implementation and says editable prototype/screenshots remain pending. This plan does not authorize a deployment, publication, external message, or production migration.

## Outcome and first release boundary

Deliver one dependable local loop: create/select project, connect a repository, index supported code, create a task, inspect and correct proposed relationships, retrieve context through MCP, edit in an IDE, reindex, run an approved verification plan, and inspect a report tied to source and environment.

Retain standalone API exploration. Local inspection and verification must work without cloud login or a connected agent. Demonstrate failed, partial, stale, and successful required-check outcomes. A successful report means its required checks passed; it does not establish whole-feature correctness.

Treat the existing implementation as a starting slice. Existing green regression tests are useful baseline evidence, but do not prove the twenty screens, state machines, graph coverage, and deployment contracts in the PDF.

## Review of the specification

The strongest requirements are shared application services (pp. 2–3), project-selection correctness (p. 4), relationship provenance and snapshots (pp. 10–11), and explicit verification truth (pp. 8, 14). Preserve these as release gates.

Adjust delivery in four ways:

1. Establish operation contracts, transactional storage and evidence ownership before adding more task screens. Otherwise jobs, context packs, and reports will require another data migration later.
2. Treat twenty screens as twenty user states, not twenty mandatory standalone pages. Use compact detail views and contextual panels; keep verification inside task navigation.
3. Prove the workflow in the existing local browser interface first, then package the shared UI in a supported IDE host. A native IDE extension is a distinct deliverable; current MCP dashboard integration does not establish that extension exists.
4. Keep index freshness and coverage distinct. “Index once” means reuse a published generation and update changed dependencies. It cannot promise that an initial scan remains authoritative forever.

Recommended initial stack: TypeScript/JavaScript, the existing Next.js contract fixture, supported fetch/Axios patterns, and selected Zod contracts. Validate the supported subset before advertising coverage; dynamic clients and unknown edges remain partial.

## Current capability versus required completion

| Area / PDF screens | Current evidence | Development gap |
| --- | --- | --- |
| Connection and project selection, S01–S03 | Local companion, authentication, project CRUD, routes | Idempotent create; invalid-ID errors; project-scoped drafts; stale-response rejection; restore safe route |
| Sources and index, S04–S05 | Incremental file metadata cache; route adapters; new pattern-derived page/component/test/doc/model artifacts | Authorized canonical roots; excludes; durable scan jobs; index generations; parser/symbol relationships; cancellation; coverage states |
| Environments and integrations, S06–S07 | Variables, secret vault, named direct service URLs, provider URL references | First-class service/auth resolution; explicit connection policy; authenticated provider import; deduplication and sync conflicts |
| Home and tasks, S08–S11 | Task records, criteria, milestones, manual links and findings | Per-project filters; contextual return routes; discovering/partial states; ranked candidate discovery |
| Context and artifacts, S12–S14 | Bounded MCP context, paginated artifact search, copyable handoff | Durable/versioned context packs; typed graph edges; bounded source spans; native source opening; validated agent assertions |
| APIs and diagnosis, S15–S17 | Existing API editor, requests, logs and diagnosis | Preserve through browser regression; resolve service policy consistently; append-only sanitized execution records; task attachment flows |
| Verification, S18–S19 | Request/contract replay wrapper, fingerprints and report records | Frozen plans; required/optional checks; actual task test runner; durable progress/cancel/recovery; separate execution, coverage and freshness |
| Tools/host/release, S20 | Settings, capture/MCP/cloud-related components exist | Unified settings and lifecycle; tested IDE package; supported-host matrix; retention/recovery/clean-install gates |

## Concrete risks to close first

These are source observations, not reproduced exploit claims.

| Priority | Observation | Required correction and proof |
| --- | --- | --- |
| P0 | `ui/app.js` selects the first project/request when lookup fails. | Missing or foreign IDs must fail explicitly. Exercise invalid routes and rapid A → B → A switches; no request or credential crosses the project boundary. |
| P0 | `scripts/api-forge-server.mjs` redirect recursion copies request options, including headers, without an origin-specific credential decision in that path. | Apply destination policy on every redirect; strip origin-bound credentials across origins; prove using two local fixture origins. |
| P0 | `/api/projects` creates a new ID on each submission; no persisted idempotency contract is present in that handler. | Repeated submission with the same key returns one project; source-scan failure does not make retry create a second project. |
| P0 | Whole-project state replacement can replace `verificationRuns` alongside editable project fields. | Move evidence behind append-only service operations; project/task edits cannot modify prior execution records. |
| P1 | State is `workspace.json`, with process-local mutation queues. | Introduce a single writer and transactional repository boundary; retain a backup and rehearse migration/recovery before replacing storage. |
| P1 | Scan status is set to `complete` even though metrics can record unreadable or skipped files. | Publish ready/partial/failed states from coverage; retain the previous usable generation after failure or cancellation. |
| P1 | Stable artifact hashes include absolute root/path and lack a symbol occurrence discriminator. | Introduce repository identity, relative paths and distinct symbols/occurrences; represent renames with explicit remapping or tombstones. |
| P1 | Incremental cache fast path trusts size and truncated modification time. | Ensure changed content is detected under coarse timestamps or preserved mtimes; validate content before verification snapshots. |
| P1 | `linkedTaskArtifacts` expands manual links through integration and same-file relationships. | Label these reasons separately; add real import/call/validation/test edges before claiming complete implementation paths. |
| P1 | Context packs are generated responses with approximate byte/4 budgeting, not persistent versioned records. | Persist generation and snapshot identity; rank before truncation; include cursors and count the complete serialized response. |
| P1 | Environment fingerprint key is random per companion process. | Introduce stable non-secret configuration versions and protected credential-version references, so applicability can be assessed after restart without exposing secrets. |
| P1 | Verification plans are regenerated at execution; approval is a boolean; report is appended only at the end. | Persist frozen plan and snapshot; bind approval to their digest; persist run start and each result; recover interrupted/unknown outcomes. |
| P1 | Verification aggregation is failed/partial/stale and task regression tests are always skipped. | Implement required-check aggregation with freshness separate; execute a supported test catalog; never upgrade an absent result into Passed. |

## Delivery backlog and dependency order

### M0 — Stabilize the current application

Scope: PDF P0 and immediate safety/correctness items.

- AIPI-001: produce a capability matrix from actual UI, CLI, MCP, scanner and cloud interfaces. Preserve public tool names and API behaviors.
- AIPI-002: remove silent project/request fallback, validate entity ownership and carry request generations through async UI actions.
- AIPI-003: make create idempotent, prevent duplicate submit, and preserve drafts per project.
- AIPI-004: enforce redirect/credential policy and document retry/unknown-outcome semantics.
- AIPI-005: protect historical evidence from general state edits and add focused regression coverage.

Exit: reproducible build; existing suite passes; targeted project-switch, duplicate-create, redirect and evidence-integrity checks pass. Capture current API Explorer behavior as the preservation baseline.

### M1 — Shared contracts and durable local state

Depends on M0's inventory; draft contracts can begin during stabilization.

- Define versioned operation envelopes, typed errors, request IDs, expected entity versions and idempotency keys. Derive actor identity from session.
- Extract project/task/index/verification services from transport handlers. UI, CLI and MCP call the same functions.
- Define Project, Repository, Artifact, Relationship, Task, Milestone, Finding, Evidence, ContextPack, VerificationPlan, Run, CheckResult, Job and Approval ownership.
- Select a SQLite driver compatible with the declared Node/OS/architecture matrix through a packaging spike. Do not change supported runtime requirements implicitly.
- Introduce schema migrations, foreign keys, project indexes and a workspace writer lease. Import JSON into a new database, compare record counts/IDs and secret references, preserve the original, then switch atomically.
- Keep secrets in the existing protected store; persist handles and credential versions only. Add backup, corruption detection and restore procedures.

Exit: migration preserves user data; concurrent clients cannot lose updates; interrupted migration recovers; evidence cannot be rewritten through mutable project operations.

### M2 — Coherent navigation and supported implementation graph

Depends on M1 contracts. UI and index implementation can progress independently against those contracts.

UI work:

- Implement Home / Tasks / APIs / Project / Tools; place Map/Index inside Project and logs with APIs/Tools as appropriate. Preserve deep links with redirects/adapters.
- Keep the global project switcher distinct from Project Home. Create opens Sources only after receiving persisted identity.
- Add project-scoped return routes for task → request → response → task, draft recovery, empty/not-found/loading/error states.
- Implement the S01–S20 states progressively in the shared UI; validate 320, 360 and 420 px, compact fallback, keyboard and 200% zoom.

Index work:

- Canonicalize authorized roots, enforce boundaries and excludes, and never execute repository code while scanning.
- Use existing AST/route infrastructure for the selected framework subset. Store `imports`, `renders`, `calls`, `implements`, `validates`, `tests` and contract-consumer relationships with evidence and producer version.
- Track unresolved dynamic calls as questions. Do not infer a schema association solely because it shares a file.
- Publish complete generations atomically. Add changed-file updates, branch/deletion/rename invalidation, scan cancellation and visible coverage gaps.
- Persist assertions independently by provenance; manual confirmation and agent inference must not overwrite observed/static evidence.

Exit: golden fixtures map a supported page → component → API client → route → contract → test path; an ambiguous fixture remains explicitly unresolved; deletion/rename/branch changes do not leave apparently current dangling links.

### M3 — Useful, measurable task context through MCP

Depends on usable M2 graph and M1 snapshots.

- Rank candidates using task text, explicit links, issue metadata and changed artifacts; show why each candidate was selected.
- Persist context packs with IDs, versions, generation, snapshots, selected relationships, unresolved questions and suggested checks.
- Fetch artifact detail and bounded source spans only on demand, validating path, hash and project ownership. Provide pagination for omitted evidence.
- Reserve output budget for metadata, freshness and tool-envelope overhead. Report token estimates honestly; measure actual provider usage when observable.
- Extend existing MCP tools rather than add duplicate names. Add typed handoff and agent-finding submission with source/span validation and inference provenance.
- Preserve copyable handoff as the fallback; show agent running only after a supported adapter acknowledgment.

Exit: UI and MCP retrieve the same pack and snapshot; foreign/stale/fabricated references are rejected or explicitly stale; representative task evaluation measures required-artifact recall as well as response size.

### M4 — Real task verification and recovery

Depends on M1 jobs/policy and M3 scoped checks.

- Persist plans with check IDs, required/optional flags, source snapshot, target identity, environment version and plan hash.
- Bind authorization to actor, project, plan, destination, credential scope, expiry and permitted uses. A changed plan requires a new decision.
- Use a supported check catalog for saved API requests, contract validation and native regression tests. Resolve executable/arguments through trusted adapters; no arbitrary shell from task text or agent findings.
- Record run start before execution and append each check result durably. Expose progress, cancel requested/acknowledged, timeout and interrupted/unknown outcomes.
- Freeze or validate source/configuration throughout execution; record target build as unknown when it cannot be attested.
- Separate execution status, coverage and freshness. Passed requires at least one required check, all required checks passed with applicable evidence, and no missing required results.
- Retain historical failure evidence, sanitization before persistence, bounded capture and retention. Export sanitized reports without automatically posting PR comments.

Exit: a fixture-driven demo produces failed, partial, passed-required-checks and stale reports; missing executable, skipped required test, source change, timeout and restart never falsely pass or repeat an unsafe operation.

### M5 — IDE host and local release readiness

Host scaffolding can start after M1; release depends on M2–M4.

- Package a supported IDE extension with a typed host bridge, root-validated source navigation, theme tokens, CSP and workspace-trust handling.
- Run the companion beside the repository, including remote workspace placement when supported. Reuse compatible instances through leases; closing one window must not terminate another window's work.
- Publish exact supported host/runtime versions after testing. Browser-only IDEs require an explicitly supported runtime arrangement.
- Build immutable package artifacts, then test installation, init/open, upgrades, uninstall/retention and restore on declared platforms.

Exit: clean-machine install and upgrade evidence; narrow panel/browser walkthrough; agent/cloud offline flows pass; release notes distinguish supported, partial and unavailable capabilities.

### M6 — Provider import, optional teams and remote access

Depends on local completion; authenticated provider sandbox work may run earlier without making local release depend on it.

- Select one provider based on pilot users. Implement read-only authenticated import, scoped credentials, pagination, rate limits, idempotent external IDs and explicit conflict rules.
- Distinguish service credentials from issue-provider credentials. Add proxy policy only with allowlisted destinations and redirect/DNS/internal-address tests; local private destinations require explicit scoped exceptions.
- Extend the existing cloud schema after audit. Add selected metadata/summaries through an atomic outbox, deduplicated events, expected versions and tombstones.
- Validate organization/project authorization, revoked membership, offline retries and backup/restore in separate staging fixtures.
- Pair device/project/read scope before considering remote execution. Validate expiry, replay denial, disconnect/reconnect and revocation during active sessions.
- Declare whether the relay can inspect payloads; make no end-to-end encryption claim without implementation and tests.

Exit: provider and cloud failure cases preserve local work; cross-project/tenant requests fail; revoked sessions cannot begin queued operations. Live provider credentials, staging environments and release authority are prerequisites for live validation, not assumptions.

## First implementation batch

Implement AIPI-002, AIPI-003, AIPI-004 and AIPI-005 first. In the same batch, write the operation/evidence contracts and JSON migration inventory for M1. Do not begin by adding all twenty screen routes or every tracker adapter.

The next demo milestone combines M1–M4 around the existing Next.js fixture. Prove one task and one supported stack before expanding adapter coverage. A browser demo of this milestone can precede the native extension release.

Suggested ownership: companion/backend owns contracts, persistence and jobs; index work owns adapters and graph; client work owns navigation and host; verification/security owns execution policy and truth rules; release/integrations owns packaging, providers and staging. These are responsibilities, not an assumption about available staff. Estimate dates after M0 identifies platform coverage and migration effort.

## Measurement and release gates

Compare paired tasks on the same repository snapshot and agent/model configuration with and without AIPI. Include warm/cold index cost, context/output/tool tokens where observable, retries and developer review time. Report sample size and task difficulty.

Primary metric: time and total cost to developer-accepted verified completion. Guardrails: required-artifact recall, false relationship rate, successful verification coverage and escaped integration errors. Token reduction without preserved correctness is not a win. Do not publish a percentage-saving promise before the benchmark.

Required local release evidence: source boundary and project isolation, crash recovery, migration/restore, supported index fixtures, MCP contracts, request editor/browser flow, actual task tests, and honest result aggregation. Full platform/tenant/relay gates apply before the corresponding distribution or remote feature is released.

## Source map and review limits

- PDF pp. 4–8: navigation and S01–S20; pp. 10–14: data, snapshots, operation/MCP contracts and verification; pp. 15–18: IDE/runtime/cloud/deployment; pp. 19–21: phases, acceptance and open decisions.
- `ui/app.js`: current project/request resolution, routing, drafts, task UI and handoff.
- `scripts/workspace-store.mjs`: JSON persistence, normalization and process-local write queues.
- `scripts/dashboard-server.mjs`: project creation, scanning, artifact IDs, state replacement and source-pattern detection.
- `packages/contract-engine/incremental-index.mjs`: stat/hash cache and atomic per-file cache publication.
- `packages/core/task-context.mjs`: manual-link expansion, budgets, process-scoped fingerprints and preview checks.
- `scripts/api-forge-server.mjs`: MCP handlers, redirects and verification execution/aggregation.

This review read the full PDF text, inspected representative rendered pages, and inspected relevant current source. It did not audit the live cloud, benchmark token savings, or visually certify the running UI. Prior test passes are baseline evidence only.

## Progress update after implementation batch

The first stabilization batch is now implemented in the working tree. Project creation through the dashboard and MCP uses a shared idempotent service; repeated requests with the same creation key return one persisted project. State replacement preserves verification history, UI project lookups no longer fall back to another project/request, late responses are rejected after a project switch, and automatic redirects to another origin are blocked before credentials are forwarded. The running local companion has been restarted with these changes.

Validation completed after the batch: `npm run build`, the full `npm test` suite, and a focused project-creation idempotency smoke check. The remaining M0 work is to add dedicated regression fixtures for cross-origin redirects, project-switch races and evidence-preservation conflicts; these are required before calling M0 complete.
