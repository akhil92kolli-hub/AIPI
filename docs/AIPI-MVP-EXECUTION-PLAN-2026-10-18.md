# AIPI MVP execution plan

Date: 18 October 2026  
Status: Proposed implementation baseline; no application changes made by this document.  
Scope: Evolve the existing local companion, dashboard, MCP integration, and IDE extension.

## 1. Product goal and definition of success

A developer working across frontend repositories, backend repositories, and external APIs can select the page, component, or API they mean; assemble relevant context; give that context to their coding agent; test APIs directly; and finish the task with clear evidence of which checks passed.

The core experience is:

**Select a target → describe a change → review related context → hand off → test → review the outcome.**

Two independent entry paths must also work:

- **Test first:** open an API, send a request without an agent or task, inspect the response, and optionally attach the result to a task.
- **Describe first:** enter a task objective when the target does not exist yet or is unknown, then select suggested targets and define expected behavior.

Primary pilot user: a full-stack developer maintaining a TypeScript/JavaScript application across multiple local repositories and using an existing coding agent. The first supported implementation slice is a Next.js frontend, a supported Next.js/Node backend adapter, and an external HTTP API described by OpenAPI or a manually configured request. Runtime and host support must be published from tested versions.

MVP success means a developer can complete this loop without learning AIPI's internal data terminology or asking its author for help. It does not establish product–market fit or guarantee the whole application is correct.

### Release demonstration

Use a small commerce application with separate storefront and orders repositories plus a local payment-provider simulator:

1. Connect both repositories and the external service to one product workspace.
2. Find the checkout page without knowing its source filename.
3. Inspect its component, API client, backend handler, payment dependency, and relevant tests.
4. Select those references and describe a payment-error UI change.
5. Review exactly what the agent will receive and send it to a supported agent host.
6. Run the payment request directly with the agent disconnected.
7. Attach the failure to the task; let the agent implement a correction.
8. Run the selected API and UI checks. Show current results and any unverified acceptance criteria.
9. Restart AIPI and recover the same task, scope, context generation, handoff, and results.

Include a second backend exposing the same method/path to prove that service identities are preserved.

## 2. Evidence and implementation boundaries

This plan is based on source inspection, not a fresh end-to-end certification. The previous local preview attempt timed out; existing screenshots cannot certify the present UI. The working tree contains substantial existing modifications and untracked implementation. Phase 0 must establish the runnable baseline before estimates are treated as commitments.

| Area | Existing foundation | MVP work |
| --- | --- | --- |
| Local execution | Companion, HTTP request execution, environments, authentication, assertions, collections | Preserve; make direct testing immediately discoverable and independent of tasks/agents |
| Source context | Multiple roots per project, AST/index adapters, page/component artifacts, relationships | Aggregate selected projects into a product workspace; validate and improve page-to-component-to-service links |
| Task context | Artifact links, bounded context, inclusion/exclusion controls, saved handoffs | Start with selected targets; expose scope, reasons, missing context, and freshness plainly |
| Verification | Plans, durable jobs, results, receipts, revision/environment data | Reuse; present one coherent task flow and validate evidence across all participating repositories |
| Hosts | Browser dashboard, MCP, VS Code bridge and shared UI assets | Keep behavior consistent; validate a declared primary agent integration and honest fallback |
| Legacy organization | Project records own tasks, requests, contracts, and evidence | Add grouping and qualified references without destructive project merges |

Relevant source anchors:

- `ui/app.js`: project launcher, four-step task creation, task workspace, K Maps, request editor, route handling.
- `ui/styles.css`: shared browser and IDE styles.
- `scripts/workspace-store.mjs`: persistence, mutation coordination, normalization.
- `scripts/dashboard-server.mjs`: dashboard operations and indexing routes.
- `scripts/api-forge-server.mjs`, `src/local-mcp.ts`: execution and MCP operations.
- `packages/core/task-context.mjs`, `knowledge-graph.mjs`, `handoff.mjs`, `context-freshness.mjs`: context, links, delivery, applicability.
- `packages/core/contracts-evidence.mjs`, `verification-runner.mjs`, `verification-jobs.mjs`: results and verification lifecycle.
- `packages/contract-engine/`: parsing, routes, schemas, incremental indexing.
- `packages/integration-map/index.mjs`: endpoint context currently includes the project's schema inventory; relevance filtering needs explicit validation.
- `extensions/vscode/scripts/build.cjs`: copies shared UI assets into the extension. Generated copies must not become separate implementations.

### Relationship to existing plans

Use the existing architecture, data-model, v2, IDE-loop, and release documents as implementation references. Their historical gap lists are not an up-to-date backlog: some items have since been implemented.

This MVP proposal replaces the earlier product recommendation to make an issues inbox the primary experience. It also proposes replacing the earlier IDE-loop document's fixed tab names and task-first wizard with the navigation below. Those earlier UI restrictions describe that earlier work scope. Preserve their useful requirements for durable evidence, truthful handoff status, compatibility, and recovery. At implementation kickoff, record this plan as the chosen product baseline and reconcile contradictory documentation in one dedicated documentation change.

## 3. Scope discipline

### Required for MVP

- One product workspace connecting multiple existing AIPI project records, repository roots, and external HTTP services.
- Search and browse pages, components, endpoints, external API operations, and tests across that workspace.
- Related-context preview with source references, service ownership, provenance, and unresolved links.
- Task creation from selected targets and from a freeform objective.
- Reviewable, saved context shared by the UI and MCP.
- Direct manual API requests, saved assertions, collection execution, and run history without an LLM.
- Reliable handoff to one validated agent host, with copy/open-context fallback for other hosts.
- One task workspace joining selected scope, agent delivery, API evidence, and verification.
- Incremental freshness, restart recovery, legacy migration, and keyboard/narrow-panel usability.

### Preserve but remove from the main path

Existing milestones, advanced graphs, token telemetry, vault administration, runtime mesh settings, cloud pairing, governance, commit/release tasks, and publish controls remain reachable through secondary navigation or settings. Preserve old links and stored data. Do not delete supported capabilities to simplify the landing page.

### Deferred

New cloud collaboration/sync, issue-tracker synchronization, broad framework expansion, autonomous agent orchestration, full Postman scripting compatibility, GraphQL/gRPC/WebSocket expansion, new deployment management, and a custom secrets platform.

Clicking a running web page to identify its exact source component is also deferred. MVP uses route/name search, a page/component explorer, and the active editor selection. A browser element picker requires source-map/runtime integration and must not be represented as already solved.

Do not require a frontend framework rewrite, database replacement, or new AI search provider to ship this MVP. Undertake a storage change only if Phase 0 demonstrates that the current persistence cannot meet the required invariants.

## 4. Workspace and identity model

### User-facing vocabulary

| Term | Meaning |
| --- | --- |
| Workspace | One product or application being worked on, e.g. Commerce |
| Repository | A connected code checkout, e.g. storefront or orders |
| Service | A runnable backend or external provider, with its own environment targets |
| Target | A selectable page, component, file/symbol, API operation, or test |
| Task | An intended change with selected targets and acceptance criteria |
| Agent context | The saved information sent for that task |
| Check result | What actually ran and its outcome |

### Add an overlay instead of merging projects

Introduce a `WorkspaceGroup` application record with stable ID, name, member project IDs, member root references, and service bindings. A legacy project becomes a singleton workspace on upgrade. Users can later add other existing projects or roots. Multiple roots already stored under one project remain supported.

Keep legacy project IDs and record ownership intact. A task retains an owner project for compatibility and gains `workspaceGroupId` plus qualified target references. Cross-project reads and writes use shared services that verify workspace membership; the browser must not silently copy and combine mutable project state.

Proposed references:

```text
TargetRef = { projectId, rootId?, serviceId?, kind, entityId }
SourceSnapshot = { projectId, rootId, commit?, workingTreeHash, indexGeneration }
ServiceTarget = { serviceId, environmentId, baseUrl, credentialReference?, configVersion }
Relationship = { from: TargetRef, to: TargetRef, type, provenance, sourceEvidence, freshness }
```

Artifact identity must distinguish repositories, relative paths, symbols, and occurrences. API identity must distinguish owning service, method, and normalized path. `GET /users` in two services must remain two operations. Environment targets are configuration bindings, not new source-artifact identities.

Audit existing route-only deduplication before federating inventory: `renderKMaps` currently builds a method/path key. It cannot be reused as the identity of a workspace-wide operation.

External APIs have service/spec/request identities and optional observed callers; they do not have fictional local handlers. Link an external operation through OpenAPI import, explicit service binding, observed calls, or a developer-confirmed relationship. Same-path matching alone is insufficient.

### Cross-project execution and isolation

- A workspace environment such as Development maps each service to a concrete URL and credential reference. Display missing mappings; do not fall back to the first service or another project's base URL.
- Each request and check executes under its owning project/service configuration, even when launched from another project's task.
- Context generations capture all included source roots and relevant service configuration versions. Dirty files matter even when commit IDs match.
- Membership removal does not erase historical context or proof. Show removed targets as unavailable; require a scope change before new execution using them.
- Switching workspaces preserves separate drafts and ignores late results from the previous scope.
- Cloud repository bindings remain unchanged; grouping does not grant cloud access or publish metadata.

### Migration and rollback

1. Read schema/version and inventory existing IDs, links, secret references, and evidence counts.
2. Create a recoverable backup using the existing storage boundary.
3. Add grouping and qualified-reference fields through an idempotent migration; retain old fields and IDs during the compatibility period.
4. Normalize reads of legacy links to qualified references without rewriting immutable historical evidence.
5. Verify record counts, ownership, task/request links, and absence of dangling references before activating the new UI.
6. Publish atomically. An interruption leaves either the old readable state or a complete new state.
7. Preserve old routes. A UI feature toggle can restore the previous shell, but is not a data downgrade mechanism. Restore from the backup only through a documented procedure that accounts for work created after migration.

## 5. UI/UX specification

### Navigation and visual hierarchy

Use **Explore, Tasks, API Client** as the main workspace destinations. Put repositories/services, environment management, indexing diagnostics, advanced maps, and existing advanced tools in Workspace settings or contextual details. The workspace switcher sits in the header; a compact status indicator opens actionable connection/index details.

Display the product workspace and selected repository/service consistently. Use one dominant next action per working area. Use color plus text for status. Keep hashes, internal record names, and token accounting in details unless they explain a problem.

On desktop, use an explorer list and selected-target detail panel. In a narrow IDE pane, use list → detail with a reliable Back action and a persistent selected-context count. Never shrink three desktop columns into a 320 px panel.

### S1 — Workspace selection and onboarding

Existing users land in their last workspace. New users see **Connect code** and **Open API Client**. API testing requires neither indexing nor a coding agent.

Connection steps:

1. Name the product workspace; choose existing AIPI projects or add local roots.
2. Confirm detected repository roles and services; add an external API from OpenAPI or a base URL.
3. Index supported sources; show progress, discovered page/API counts, and unsupported or unreadable areas.
4. Open the explorer with one useful target suggested, or explain the next action if none was found.

Do not require descriptions, milestones, goals, cloud signup, or credentials for unrelated services before exploration. Preserve partial setup and allow additional repositories later.

### S2 — Explore and select

Top search prompt: **Find a page, component, API, or test**. Filters: All, Pages & Components, APIs, External Services, Tests. Search accepts a page route, display alias, filename, symbol, API path, or service name.

Every result shows a friendly name, kind, repository/service, and location. Search results must distinguish identical names across repositories. Match exact route/symbol first, then aliases and indexed text; show a short reason for the match. Do not require an LLM for basic search.

The selected target shows:

- What it is and where its source lives.
- Related components, callers, backend operations, schemas, external dependencies, and tests.
- Why each relationship exists: indexed import/call, runtime observation, or developer link.
- Missing or ambiguous relationships with **Choose target** / **Add relationship** actions.
- **Add to task**, **Open source**, and, for APIs, **Test API**.

Use a short related-items list by default. An expanded graph is optional. Users must be able to understand and select the chain without operating a graph editor.

Selected targets accumulate in a context tray. Developers can remove an item, inspect it, or start a task from it. A target can be attached to an existing task without creating a duplicate.

### S3 — Create a task from selection

Replace the mandatory four-step intent/objective/search/proof wizard with one compact composer:

- **What should change?** Required objective; suggest an editable title.
- **Selected targets.** Already populated from the explorer or active editor; add/remove controls.
- **Suggested context.** Related items with reasons, not silently included speculative dependencies.
- **How will you check it?** Suggested checks and editable acceptance criteria.
- Primary action: **Create task & review context**.

Priority, milestone, issue URL, and specialized intent live under optional details. Infer an editable work type from selected targets; do not block on classification. New-feature tasks can use planned targets with expected behavior and file locations, clearly distinct from implemented code.

Create the task once. If context assembly fails, reopen the saved task with Retry context rather than asking the developer to recreate it. A describe-first task opens the same composer with suggested targets instead of selected ones.

### S4 — Task workspace

One task page contains the objective, scope, context, delivery, and checks. Use three plainly named sections: **Context**, **Agent**, **Checks**. At narrow widths these stack; at desktop widths Context can remain alongside the active work section. Do not add another competing workflow wizard.

Illustrative desktop layout:

```text
Commerce / Fix checkout payment message      Context current
Objective: show a useful message after payment authorization fails

Selected scope                 Agent and results
storefront: /checkout          Context prepared · 2 repositories
  CheckoutForm                 Review context | Send to agent
orders: POST /checkout         Delivery: Accepted / Fallback / Failed
payments: POST /sessions
                              Checks: 2 passed · 1 failed · 1 manual
Related code / add targets     Run checks | Inspect failed response
```

Context preview shows included targets and source excerpts, reasons, omissions, unresolved dependencies, freshness, and a secondary size estimate. It is explicit about selected targets that could not fit. Pinned context that exceeds the budget requires a larger budget or a scope adjustment; it must not silently disappear.

After delivery, show the actual host result. A copied packet is **Copied**, a locally saved file is **Saved**, and an opened chat is **Opened; awaiting agent**. Do not display **Agent working** without an acknowledgment/status event supporting it.

After edits, the next action becomes **Refresh affected context** or **Run checks**, depending on freshness and the plan. Show before/after results without discarding the original failure. Completing required checks and accepting the feature are separate facts; manual visual criteria remain visible until reviewed.

### S5 — API Client

Keep the existing request engine and editor. Present a familiar request workspace:

- Collections/saved requests on the left, or a list screen in the IDE pane.
- Service/environment selector, method, URL, and **Send** at the top.
- Params, Headers, Auth, Body, Tests in the request area.
- Status, duration, response size, body, headers, and assertion results in the response area.
- **Save request**, **Run collection**, **Attach result to task**, and optional **Ask agent**.

Support an unsaved request immediately. Saving or first execution can establish request identity internally; no explicit contract-creation prerequisite is exposed to the user. Existing OpenAPI import remains accessible; document its supported subset. cURL import may follow after the required loop is proven.

Opening an API from Explore uses this same editor and preserves a return path and any task association. Editing a request invalidates applicability of its previous result without erasing history. Changing environment keeps body/draft state and visibly changes the destination.

Direct Send, saved assertion execution, response comparison, history browsing, and collection runs must make zero model calls. A task is optional. Existing state-change policies still apply, with destination and effect visible at the point of execution rather than a generic warning on every screen.

### S6 — Results and recovery

Lead with **3 of 4 required checks passed** or a specific failure. Distinguish HTTP success, assertion success, and task verification; a 200 response does not imply feature correctness.

Show skipped, timed out, interrupted, cancelled, stale, unavailable, and failed explicitly. A failed check opens its relevant request/test output in one action. A result can be attached to multiple tasks by reference; evidence is not duplicated or rewritten.

### Required interaction states

Every new surface needs loading, empty, partial, stale, disconnected, failed, and recovered states. Errors must preserve the draft and offer a concrete recovery action. Search should show “No indexed match” separately from “Repository not indexed.” Unavailable source should retain the target identity and explain why it cannot be opened.

Preserve focus, selection, scroll position, and drafts across refreshes. Provide visible focus, keyboard navigation, accessible names, async announcements, modal focus return, 200% zoom, and 320–420 px IDE layouts. Validate light/dark themes and long paths/URLs.

## 6. Functional and technical changes

### Discovery and related context

Add a shared workspace target-search operation, backed by existing project indexes. Proposed service operations are `searchWorkspaceTargets`, `getTargetContext`, and `updateWorkspaceMembership`; these are design names, not claims about existing APIs. Results carry qualified IDs, match reasons, index generations, and paging cursors.

For the supported stack, derive page → component/import → API caller → service operation → handler/schema/test relationships. Implement static import/JSX and supported client-wrapper resolution incrementally. Classify dynamic URLs, re-exports, unresolved aliases, generated clients, and unsupported patterns as partial when they cannot be resolved. Retain a useful manual linking path.

Graph expansion must be relevant and bounded: direct links first, optional neighboring dependencies second. Do not include every schema or every file in a repository merely because a route is selected. A manual link records who confirmed it and which source/configuration it described; refresh or invalidate it when those anchors change.

### Context and agent integration

Extend existing context and handoff services to accept qualified cross-project references. Preserve current MCP tool names where compatible; add optional workspace scope rather than creating parallel implementations. Old callers retain project scope. Reject targets outside the selected workspace.

Save immutable context generations before dispatch. Include objective, acceptance criteria, repository/root locations, selected source spans, relevant request/response evidence, service contracts, unresolved questions, and suggested checks. Keep full bodies and secrets out of default packets through the existing redaction boundary.

Freshness is calculated against all included roots, relevant dependency changes, request definitions, specs, and environment versions. Reindex changed dependencies before dispatch/verification. A failed refresh leaves the previous generation readable and clearly stale.

The primary host must be selected and validated in Phase 0 using existing adapters. Default pilot target is the existing Codex integration if it completes the full loop; if it cannot, publish the actual supported adapter and preserve the explicit copy/open-file path. Copy-only success cannot satisfy the automated handoff release gate.

### Requests and check execution

Use one execution path for direct UI requests, MCP calls, collections, and task checks. Keep service-target resolution in the companion, not in duplicated UI logic. Expose bounded progress/results; redact before persistence. Distinguish a request failure from an unknown outcome after interruption; do not automatically replay a potentially state-changing request to recover a UI connection.

Generate verification plans from selected behavior and related checks, not only from API contracts. A page change can require a component test and manual visual review. An external API without local source can be checked against its imported schema and a recorded response while reporting the deployment/version boundary as unknown if necessary.

Cross-repository plans enumerate command working directories and service targets per check. Existing job execution should orchestrate these checks while retaining owner-project evidence references. Bind execution to the selected source/configuration snapshots. Code changing mid-run makes applicability stale; it must not produce a current all-clear result.

### Maintainability

Keep `ui/` as the canonical shared UI. Extract target selection, task composition, API client presentation, and status rendering into small modules when touched; update the extension build to package new modules. Do not refactor the entire application before shipping the vertical slice. Keep legacy route adapters and transport handlers thin around shared services.

## 7. Delivery milestones and prioritized backlog

Effort bands are estimates in engineer-days, not elapsed promises. They assume two engineers familiar with the code and part-time design/QA support. Re-estimate after Phase 0. Milestones are dependency gates; independent implementation can proceed against agreed contracts.

| Phase | Outcome | Effort | Exit gate |
| --- | --- | --- | --- |
| P0 | Runnable baseline, support matrix, evaluated UX flow | 3–5 | Existing task/test loop reproduced; gaps classified; identity and grouping decisions documented |
| P1 | Connected workspace and migration | 7–11 | Two existing projects and an external service work together without ID/data loss or wrong-service targeting |
| P2 | Select a target and create useful context | 9–14 | Page/API selection finds the reviewed cross-repository chain and creates a recoverable task |
| P3 | Direct API Client and evidence attachment | 5–8 | Send/run/history/attach works with the agent disconnected and zero model calls |
| P4 | Complete agent-to-check loop | 7–11 | Real agent delivery, source change, refresh, checks, and restart recovery demonstrated |
| P5 | Usability, packaging, and pilot | 7–11 | Unassisted users complete the loop; release gates and migration checks pass |

Total planning range: 38–60 engineer-days. With two engineers, integration, design review, and pilot observation, allow roughly 6–9 calendar weeks rather than dividing effort mechanically. Staffing, adapter gaps, and persistence defects can change this substantially. No fixed ship date is asserted.

### Work items

| ID | Priority / phase | Deliverable | Depends on | Acceptance / proof |
| --- | --- | --- | --- | --- |
| MVP-01 | P0 / P0 | Baseline capability and host matrix | — | Record build/tests and actual browser/MCP/IDE walkthrough; mark implemented, broken, partial, untested |
| MVP-02 | P0 / P0 | Commerce fixture and expected relationships | — | Two repos, provider simulator, duplicate endpoint paths, known acceptance checks, seeded failures |
| MVP-03 | P0 / P0 | Screen flow, vocabulary, clickable UI prototype | 01 | Developer can find a target, start a task, and locate Send without explanation; preserve reference screenshots |
| MVP-04 | P0 / P1 | Workspace grouping and membership service | 01 | Singleton migration and adding/removing member projects; ownership remains stable |
| MVP-05 | P0 / P1 | Qualified artifact/API identity and service environment binding | 02, 04 | Same-named files and same-path APIs resolve independently and execute against the intended service |
| MVP-06 | P0 / P1 | Migration, compatibility, and recovery | 04, 05 | Repeat/interrupted upgrade preserves IDs, links, evidence, secret references, old routes |
| MVP-07 | P0 / P2 | Workspace search and selection tray | 03, 05 | Search spans selected projects; results have provenance and source badges; keyboard selection works |
| MVP-08 | P0 / P2 | Supported page/component relationship expansion | 02, 05 | Expected chain found; ambiguous/dynamic calls remain unresolved; manual correction persists |
| MVP-09 | P0 / P2 | Target detail and related-context UI | 07, 08 | User can inspect why, include/exclude, open source, and test API without entering a graph |
| MVP-10 | P0 / P2 | Selection-first task composer and draft recovery | 09 | Preselected targets persist; task created once; failed context assembly recovers without duplicate tasks |
| MVP-11 | P0 / P2 | Cross-project context generations and freshness | 05, 08, 10 | UI/MCP see identical scope; missing budget items are disclosed; source changes invalidate applicability |
| MVP-12 | P0 / P3 | API Client shell and standalone request entry | 03, 05 | Agent-off Send/Save/variables/assertions/history work; unsaved requests need no task |
| MVP-13 | P0 / P3 | Collection execution and result-to-task attachment | 10, 12 | Reuse existing runner; stable run references attach without duplicate evidence; request drafts survive navigation |
| MVP-14 | P0 / P4 | Unified task workspace and honest handoff state | 11, 13 | Review packet, deliver, distinguish acknowledgment/fallback/failure; reopen after host restart |
| MVP-15 | P0 / P4 | Multi-repository check plans and execution | 05, 11, 13 | Correct cwd/destination for every check; partial/stale/interrupted outcomes cannot pass |
| MVP-16 | P0 / P4 | Before/after result review and completion rules | 14, 15 | Preserve original failure; show current required checks and outstanding manual acceptance separately |
| MVP-17 | P0 / P5 | Responsive, keyboard, and async-state QA | 09–16 | Browser and narrow IDE workflows pass; no lost focus/drafts or inaccessible core action |
| MVP-18 | P0 / P5 | Package, clean install, upgrade, offline recovery | 06, 14–17 | Installed artifact uses canonical UI modules; primary supported host executes the full loop |
| MVP-19 | P0 / P5 | Pilot and outcome measurement | 18 | Observe unassisted use, false relationships, time to context, direct tests, repeat usage |
| MVP-20 | P1 / after gates | Optional cURL import / UI alias improvements / secondary host | Pilot evidence | Select only the next friction with observed demand; no expansion that blocks MVP |

Ownership: companion engineer owns 04–06, 08, 11, 15; client engineer owns 03, 07, 09–10, 12, 14, 16–17. Pair on 01–02, 13, 18–19. These are responsibilities, not an instruction to launch agents or assume staffing exists.

Critical path: baseline → identity/grouping → reliable targets/context → actual handoff and check execution → release pilot. API Client presentation can progress alongside discovery once service targeting is fixed. Avoid a large dashboard-only redesign before the fixture completes the core workflow.

## 8. Acceptance and test matrix

Use behavior tests and real host walkthroughs. Text-presence assertions and mocked dispatch success cannot certify the user journey. Existing suites are assets to extend, not proof that new cross-project behavior works.

| Scenario | Required result |
| --- | --- |
| Legacy project upgrade | Existing tasks, requests, links, evidence, settings, and URLs still work |
| Two repositories with the same filename/symbol | Selection and source opening identify the correct root |
| Two services expose `POST /checkout` | Distinct inventory entries; each executes against its configured target |
| External API has no source | Spec/request/caller information remains useful; no fabricated handler |
| Page imports component through a supported wrapper | Reviewed chain is found, with evidence for each link |
| Dynamic or ambiguous call | UI asks for a binding or reports partial coverage; no confident invented edge |
| New feature with no existing endpoint | Planned target and criteria can be saved and handed off; no claim it already exists |
| Selected item exceeds context budget | It is explicitly omitted or requests more budget; no silent scope loss |
| Frontend or backend changes after context preparation | Pack is stale; new generation required for current applicability |
| Unsaved request with no agent/index | Send returns a real result without model invocation |
| Task opened from API failure | Original request, environment, and evidence remain attached by reference |
| Rapid workspace switching / delayed response | No foreign result, secret, or draft is applied |
| Source/service member removed | Historical task remains readable; new unavailable-target execution fails clearly |
| Agent unavailable / fallback | Saved/copied/opened is distinguished from accepted/running |
| Check skipped, timed out, cancelled, interrupted | Required-check status cannot become passed |
| Source changes during checks / target build unknown | Freshness and runtime applicability are reported independently of exit status |
| Repeated click, timeout retry, companion restart | No duplicate task/handoff/run where idempotency applies; in-flight outcome recovered honestly |
| API returns 200 but assertions fail | Request transport success remains distinct from failed assertions and task state |
| UI-only change | Relevant component/manual checks can complete without a forced API contract |
| Multi-repository command plan | Every command uses its reviewed working directory; all required outcomes are represented |
| Credentials and captured bodies | Existing redaction and service credential boundaries remain effective |
| Keyboard/narrow IDE/200% zoom | Find target → task → context → Send/checks can be completed without lost controls |

Map tests to existing coverage in `tests/task-creation-pipeline.test.mjs`, `task-context.test.mjs`, `knowledge-graph.test.mjs`, `context-freshness.test.mjs`, `contracts-evidence.test.mjs`, `verification-runner.test.mjs`, `verification-route.test.mjs`, `mcp-handoff-lifecycle.test.mjs`, and `vscode-extension-handoff.test.cjs`. Add workspace grouping/identity/migration integration tests and a real browser journey for the fixture. Run the relevant suites per change, then declared release checks against the packaged artifact.

## 9. Performance, usability, and value gates

Targets below are proposed acceptance budgets to measure on a documented machine/fixture. They are not existing performance claims.

- Warm search: p95 under 500 ms across the benchmark workspace; return a bounded page, not the entire state payload.
- Local UI interaction: show pending feedback within 100 ms; long scans/jobs report progress and remain navigable.
- Context preparation from a warm index: p95 under 3 seconds for the benchmark task; expose larger-workspace timing instead of hiding delay.
- Cold setup: at least 4 of 5 pilot developers find/select their first useful target within 10 minutes without coaching; measure install/index time separately.
- Once indexed: at least 4 of 5 create an appropriately scoped task within 2 minutes of seeing the explorer.
- Direct testing: 5 of 5 send a local request and understand success/failure with the agent disconnected; all executions use zero model calls.
- On reviewed supported-stack fixtures: target at least 95% precision of automatically included relationships and 90% recall of required context; publish counts and misses. Small fixture scores do not justify universal coverage claims.
- On deliberately ambiguous/unsupported fixtures: no unresolved relationship is silently presented as confirmed.
- Verification: zero false passed-required-checks outcomes in the failure/recovery matrix.
- Pilot over two weeks: at least 3 of 5 developers voluntarily reuse AIPI for a second real task. Interview non-returning users before adding features.

Compare 10–20 representative tasks against the developers' existing workflow, recording time to correct scope, total time to accepted completion, retries, failed checks, and context corrections. Where provider usage is available, measure total task cost including retrieval and retries. Do not infer billed dollar savings from packet size alone. Record basic execution/discovery metrics locally; any pilot collection is an explicit export.

### Definition of MVP done

All P0 backlog items have linked evidence; the release demonstration works in the browser and the declared primary host; the migration/recovery and failure matrix passes; direct API execution is independent of agents; and the first unassisted pilot meets the activation gates or produces a documented limited-beta decision. Do not call the product generally released while core identity, wrong-target, data-loss, or false-pass defects remain.

## 10. Risks, decisions, and stop conditions

| Risk | Mitigation / decision |
| --- | --- |
| UI looks simpler but cross-project context remains shallow | Gate on the commerce chain and measured relationship quality before visual completion |
| Existing projects accidentally merge | Use grouping plus qualified references; no destructive consolidation |
| Route/path collisions send the wrong request | Service-aware identity and destination display are P0 gates |
| Too much context or omitted essential files | Selection controls, provenance, explicit omissions, recall measurements |
| Product expansion overwhelms MVP | Keep advanced capabilities secondary; choose post-MVP work from observed friction |
| UI/extension assets drift | One UI source, build-generated copies, packaged-artifact walkthrough |
| Agent adapters behave differently | One validated host; truthful capability reporting and fallback |
| Working tree differs substantially from prior plans | Baseline current behavior in P0; implement gaps, not historical checklist items |
| Persistence cannot safely support grouping | Prove atomicity/recovery early; evaluate a narrow persistence change only if the tests fail |
| Cross-repository background changes corrupt applicability | Per-root snapshots and dependency invalidation; retain historical outcomes as historical |

Stop release for data loss, wrong-workspace execution, credential crossing, false verification, or unrecoverable upgrade. Stop expansion and revisit the interaction model if users cannot identify the target or must routinely repair most suggested context. Stop performance claims if comparative measurement shows faster setup but more failed tasks.

## 11. First implementation batch

The first batch is deliberately a complete thin slice:

1. Establish the current runnable baseline and build the two-repository commerce fixture.
2. Implement additive workspace grouping, qualified identities, and service destination resolution with migration tests.
3. Add a minimal workspace explorer that selects one page or API and previews its actual related references.
4. Create a task from those selections using existing context/handoff services.
5. Open the selected API in the existing request editor, execute it directly, and attach its result to that task.
6. Demonstrate a real agent handoff and one applicable check result before expanding the UI.

Review this batch against the original goal: can a developer show the agent exactly what they mean across repositories and test it directly? If that is still difficult, improve the selection/context flow before adding more management screens.

## 12. Implementation checkpoint — 2026-10-18

Status: initial foundation and discovery slice implemented; the full first batch and MVP are **not complete**.

### Implemented

- Additive workspace groups over existing projects, preserving project ownership and legacy IDs. The first persisted schema upgrade saves the previous protected workspace bytes to `workspace.json.before-workspace-groups.json`; subsequent writes do not overwrite this backup.
- Authenticated group and bounded target-search/detail routes, optimistic membership updates, and project/root/service-qualified explorer references. Duplicate routes and native IDs in different projects remain distinct.
- New Explore navigation: connect existing projects, search/filter pages/components/APIs/requests/services/tests, inspect indexed relationships, and maintain a context selection. Search and selection are restored within the browser session and selections are revalidated before task creation.
- Compact task composer using the existing context and verification-plan preparation pipeline. Stable creation IDs prevent duplicate selection-driven tasks on equivalent retries. This currently supports targets from one owning project only; multi-project execution is explicitly rejected.
- Open a selected API in its owning project's existing direct request editor. Foreign-project actions are disabled in a project-pinned IDE panel.
- Isolated commerce preview (`npm run preview:mvp`) with two source repositories and local orders/payment simulators. Its index metadata is seeded: this is not evidence of automatic cross-repository relationship discovery.
- Watcher exclusion for AIPI's own `.aipi` metadata, preventing internal writes from being mistaken for source edits.
- Explorer assets included in companion packaging and IDE asset generation.

### Verification evidence

- Passed `npm run test:workspaces`: legacy normalization, protected migration backup, authenticated routes, persistence, identity collisions, pagination, membership changes, task ownership and retry idempotency.
- Passed task-creation pipeline, context freshness, workspace-lock, knowledge-graph, task-context and verification-route checks during this batch.
- Passed `npm run test:extension` (bridge test, not live IDE-agent execution), `npm run build:extension`, and `npm run test:package` (build/typecheck plus isolated tarball smoke).
- Browser walkthrough: selected the storefront checkout page, created a task with its prepared source context, returned to Explore, and opened the orders request in the correct project. Direct local execution with `{}` returned HTTP 422 and a failed assertion; `{ "amount": 20 }` produced passed execution evidence. No coding-agent dispatch was used for these requests.
- API test UI follow-up: keep the contract test route open after request execution, show the latest response, assertion results and a bounded body preview inline, and link to full evidence. The phone layout uses a tighter service/endpoint grid. Verified the new panel against the isolated preview's recorded 201 result; syntax and diff checks passed and extension UI assets were rebuilt.
- Inspected desktop and 390px explorer layout. Full keyboard, 200% zoom, live IDE and accessibility acceptance remain pending.
- Preview data is isolated from the user's normal workspace store. The already-running preview process predates the watcher fix; restart the preview to load that backend change. Existing source-change banners are not cleared retroactively.

### 2026-10-19 — Hierarchy, API Client, and real-source baseline

- Explore and the shared task picker explain workspace → repositories/services → targets; rows identify their project and available repository/service ownership.
- API Client is accessible from Home and Explore, not a separate bottom-navigation tab. API testing routes sit under K Maps in primary navigation; opening a request does not execute it and requires no task or agent.
- Target locations prioritize the nearest folder/filename or trailing endpoint segments, with full-location disclosure. Endpoint presentation removes URL credentials, query strings, and fragments.
- AIPI is the user-selected real application. The reproducible three-file baseline found zero complete caller–handler links, missing wrapper callers, false browser-route detections, and incorrect HTTP methods. See `AIPI-RELATIONSHIP-VALIDATION-2026-10-19.md`; relationship quality is not approved for release.
- Target-location tests, workspace unit/route tests, context-review unit/tool tests, syntax checks, and typecheck passed. Browser verification of this latest navigation pass remains pending after the repository moved from API-Forge to AiPI.
- Do not expand inferred relationship features until the validation report's release gate is satisfied. Cross-project binding remains explicitly limited; do not imply that browsing several projects means a task can bind all of them.

### 2026-10-19 — Task context and Tools follow-up

The latest user direction retains the four task-creation steps, superseding S3's earlier single-composer presentation for now. Step 3 embeds the workspace picker; Explore is an optional browse-first entry into that same wizard, not a separate creation dialog.

Implemented:

- Shared workspace target picker for Step 3 and saved-task editing: browse without a query, type filters, selected targets, indexed related suggestions, pagination, unavailable-reference retention, and explicit single-project binding restrictions.
- Explore selections enter the existing task wizard; Tasks has one creation action. Milestones are optional and assigned/unassigned tasks appear together.
- Context / Agent / Checks task sections, direct context editing, and removal of the speculative visual implementation chain.
- Context edits preserve task identity and criteria. Manual selections are not silently repopulated by contract discovery. Earlier proof is flagged for recheck after scope changes.
- Task-specific edit conflict checks replace global workspace-revision checks. Context preparation failure saves the task for retry rather than requiring recreation.
- MCP tools prepare_task_draft_context, submit_task_context_review, and get_task_context_review prepare bounded manual context and exchange validated agent suggestions. Suggestions require explicit inclusion. The saved task keeps the review ID so a late agent reply can be reviewed through Edit, without creating a second task.
- Continue to Verify prepares context through MCP. If the tool or agent bridge fails, manual selections and acceptance criteria remain usable. A sent/copied prompt never implies completed agent work.
- Tools (formerly MCP & Index) emphasizes companion, agent-bridge, and index status separately. Diagnostics are collapsed and graph browsing routes to K Maps. Target-specific diagnostics no longer silently choose the first contract.

Validation: workspace identity and authenticated route tests, task creation pipeline, contract-task route, task context tests, context-review unit tests, MCP tool round-trip/isolation tests, and manual-fallback UI-function test passed. Typecheck/bundled build and extension build passed. Browser QA created a frontend-only task, removed/re-added its page without changing its ID or criteria, exercised manual fallback, and confirmed Explore selection reaches Step 3.

Still gated: live IDE-agent execution, cross-project task execution/context ownership, full keyboard/zoom/accessibility acceptance, and broader regression testing. Agent suggestions are explicitly checked/refreshed, not streamed. Existing long-running companions must restart to expose the new MCP tools; the updated preview at port 55065 uses the existing preview data without resetting tasks.

### Next implementation gates, in order

2026-10-19 ticket update: Explore workspace/per-project scanning and the first relationship detector corrections are implemented. The AIPI sample now yields 58 unconfirmed candidate links across 28 handlers, with method isolation, local wrapper resolution, bounded parameter patterns, ambiguity protection, and a cache rebuild. See the updated relationship validation report for checks and remaining unsupported patterns. This completes the scoped scan/detection ticket; it does not complete the cross-repository gates below.

1. Carry qualified references through task context, handoff and verification rather than flattening them to legacy owning-project IDs. Add same-project/multi-root collision tests, cross-project command ownership and stale-membership tests before enabling multi-project tasks.
2. Resolve and display reviewed cross-project relationships, provenance and uncertainty. Replace seeded-fixture assumptions with actual indexing acceptance evidence.
3. Add an explicit attach-to-task action from the inline result panel while preserving historical outcomes.
4. Demonstrate a real handoff and applicable verification receipt in the declared primary IDE host. Automated bridge tests are not a substitute.
5. Complete restart/recovery, keyboard/zoom/narrow-panel journeys and measured pilot activation gates before describing this as a usable end-to-end MVP.

No P0 phase is declared fully complete by this checkpoint. The critical remaining product gap is cross-repository context and verification, not additional dashboard decoration.

### 2026-10-20 — Cross-repository task context implementation

- Explore and the shared create/edit picker can bind targets from multiple projects in the same workspace to one task. Legacy ID arrays remain owner-local; qualified targetRefs preserve project, root and service identity. Editing does not recreate the task.
- Context packs, MCP manifests, agent-review suggestions and handoffs preserve repository ownership. Handoffs include qualified source references and repository roots; missing workspace membership/targets blocks preparation and execution.
- Verification builds a per-project plan and executes each API request/test with its owning project and environment. Check results and evidence carry project ownership; a single aggregate receipt must cover every required repository check before handoff completion. Foreign contracts are not silently marked verified.
- Plan fingerprints include selected source-file hashes, repository/index metadata, environments and selected API configuration. Changes invalidate prior approval/completion. Indexed UI source without a configured behavior check remains pending.
- Same-project duplicate entity IDs across roots fail closed with an actionable ambiguity error. Multiple test roots require an explicit registered repositoryRoot; the runner no longer silently chooses the first root. Full root-scoped execution for colliding legacy IDs remains future work.
- Validation: workspace suites, complete regression suite, new three-project collision/routing/approval/membership tests, MCP aggregate-receipt completion/staleness tests, syntax checks and production build pass. Browser QA could not run because local browser use is disabled in Work settings. The older UI source assertion still expects the removed two-action New Task header and fails; this ticket does not restore that obsolete workflow.

Next gate: reviewed cross-project relationship provenance, then a real IDE handoff and multi-repository check run. Automated executor fixtures are not evidence of live IDE-agent completion.
