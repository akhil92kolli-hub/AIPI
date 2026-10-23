# AIPI IDE Agent Loop: Functionality and UI Plan

Current cross-surface experience and tool refinements are specified in [the 23 October UI/UX and MCP plan](AIPI-UI-UX-SURFACE-AND-MCP-PLAN-2026-10-23.md). Its five-tab shell, source-qualified context, advisory separation and evidence acceptance supersede conflicting four-tab or human-confirmation-as-proof wording below. Historical implementation notes remain historical.

## Goal

Make AIPI the durable workbench between a developer, an IDE coding agent, repository context, and verified results. Every surface (IDE panel, local MCP, and CLI) must operate on the same persisted task, context pack, handoff, job, and evidence records.

The core loop is:

```text
Describe work → discover evidence → review task/context → hand off to agent
      ↑                                              ↓
Update task ← inspect report ← run approved checks ← edit in IDE
```

The product promise is that AIPI can explain what it sent to the agent, what the agent changed, which checks actually ran, and which source revision those results describe. AIPI must not imply that a handoff started, a test passed, or an API is safe without recorded evidence.

## Current baseline

- The VS Code extension already connects a workspace to the local companion, discovers task context, prepares bounded context, writes `.aipi/active-context.md`, opens source references, attempts an IDE chat handoff, persists handoffs, and requests verification.
- The local MCP already exposes bounded context, task handoff, handoff lifecycle, contract verification, integration evidence, and other repository tools.
- The dashboard already supports tasks, milestones, context packs, plans, and persisted verification receipts.
- Task context is persisted on task/context-pack records; handoff records are stored separately. Keep this distinction visible: the pack is reusable evidence, while each handoff is an agent-specific delivery event.
- These former gaps are covered by the implementation below: IDE dispatch outcomes are persisted, AI task proposals are reviewed before creation, checks use durable jobs, and supported commands share reviewed plans across UI, MCP, and extension.

This plan complements [AIPI v2 development plan](AIPI-V2-DEVELOPMENT-PLAN.md). It narrows that broader storage, indexing, verification, and release work to the IDE-to-agent workflow requested here.

## Implementation status (2026-10-18)

- Implemented: MCP-grounded task proposals with citation validation, provenance, idempotency, duplicate warnings, a reviewable Tasks UI, and explicit user approval before proposal tasks are created.
- Implemented: repository script discovery without execution, reviewable task test-command selection, frozen-plan checks, persisted verification jobs, per-check progress, cancel requests, restart interruption handling, and MCP start/status/cancel tools.
- Implemented: IDE terminal launch validates the reviewed plan and workspace path, then stages the exact command for user inspection without running it; task UI distinguishes terminal launch from observed verification.
- Implemented: Tasks actions and review flow within the existing tabs; no navigation tabs were added, removed, renamed, or reordered. Task context generations are immutable and retained for history; handoffs are retryable and record dispatch outcomes; verification jobs reconnect to persisted progress, elapsed time, per-check results, and bounded output. Direct project-page navigation now refreshes the local session cookie so protected UI actions work without requiring a launch redirect.
- Remaining validation: exercise the complete handoff-to-proof loop with real supported IDE agents, confirm adapter-specific chat behavior in supported IDE versions, and complete manual keyboard/screen-reader accessibility QA. Automated tests cover multi-root workspace switching and local session recovery, as well as the companion, MCP, dashboard, and VS Code bridge; they cannot certify host-IDE behavior.

## Product workflow

### 1. Discover and save task context

1. The user chooses an existing task or starts with a task description.
2. The user can ask the IDE agent to discover relevant context. The agent uses AIPI MCP search and evidence tools; it returns candidate references and reasons to the shared AIPI context service instead of keeping the discovery only in chat.
3. AIPI checks ownership, source hashes, and project revision, then merges valid candidates with its own index and knowledge-graph results. It returns ranked source, route, schema, test, and finding candidates with citations.
4. The user can accept, remove, or pin candidates. AIPI labels uncertain relationships and surfaces missing or stale evidence.
5. AIPI creates a versioned context pack containing the selected evidence IDs, bounded source spans, hashes, repository revision, unresolved questions, token budget, and suggested checks.
6. The context pack is persisted before handoff. The UI reports its ID, revision, freshness, size, and any omissions; the task and pack remain available after the chat or companion restarts.

Context creation is repeatable. Refresh creates a new generation and preserves earlier generations referenced by handoffs or verification runs.

### 2. Create tasks with AI

- Provide `propose_tasks_from_context` in MCP and the IDE, backed by one shared task service. Input can be a user request, selected findings, changed files, or a saved context-pack ID.
- Return a small set of proposed tasks with title, objective, intent, priority, acceptance criteria, evidence links, likely contracts, and candidate checks. Every generated field has provenance and source citations.
- Present proposals in a review queue. The user can edit, merge, dismiss, or create them. Creating a task persists the user-approved record and starts context preparation; it does not execute tests or modify source code.
- Make creation idempotent so a retry after a timeout cannot create duplicate tasks. Preserve the original user request and proposal revision for audit.

### 3. Hand off to an IDE agent

- Offer a single `Hand off to agent` action after context review. The handoff references the persisted task and context-pack generation instead of embedding a second, drifting copy of the evidence.
- Show the selected agent target and dispatch state: ready, sending, accepted, active, needs attention, or unavailable. A saved file or clipboard is a visible fallback and must not be reported as a successful chat dispatch.
- Include task objective, acceptance criteria, bounded evidence citations, unresolved questions, repository revision, suggested checks, and AIPI MCP tool references.
- Persist handoff ID, context-pack ID, target agent/IDE, timestamps, dispatch result, and lifecycle updates. Let the agent mark work in progress or blocked and submit findings with source citations.
- Keep agent conclusions distinct from indexed facts. User confirmation or independent evidence is required before inferred graph relationships become confirmed.

### 4. Run checks with context

- Build a task-specific verification plan from acceptance criteria, linked contracts, indexed tests, and project test scripts. Show why each check is included, its target, and the context/revision it uses.
- Support named check types first: contract replay, contract/schema comparison, repository test script, and configured test command. Do not infer a command from untrusted task text or agent output.
- Resolve test commands from package-manager scripts or explicit project check configuration. Display executable, arguments, working directory, environment name, timeout, and affected files before execution.
- Route execution through one companion job service used by UI, MCP, and extension. Persist queued/running/per-check/completed/failed/cancelled/interrupted states and append each result as it arrives.
- Offer `Run in terminal` for visible, user-controlled execution and `Run checks` for the supported companion runner. The terminal action opens a workspace-scoped IDE terminal with the reviewed command; it reports launch, not test success. The runner captures bounded output and reports the actual exit status.
- Bind approval to the frozen plan hash, repository revision, environment fingerprint, and any state-changing replay decision. A plan or target change requires a fresh review. Never replay POST/PUT/PATCH/DELETE by default.
- A missing executable, timeout, cancellation, skipped required check, or interrupted operation can never produce a passing receipt. Keep execution status, coverage, and freshness as separate report fields.

### 5. Close the loop

- After edits, the agent or user can request reindex, refresh context, and rerun the same plan or review a changed plan.
- Attach results to the task, handoff, context generation, source revision, and environment fingerprint.
- Complete a contract-linked handoff only with current passing receipts for all affected contracts. Non-contract tasks require their configured required checks and acceptance review.
- Keep old failures and receipts available when new runs start. Show the exact failed/skipped checks and the smallest useful next action.

## UI direction

### Global IDE shell

- Preserve the extension's existing **Home**, **Tasks**, **K Maps**, and **Tools** tabs: do not add, remove, reorder, or replace tabs as part of this work.
- Keep each capability in the existing tab that owns its workflow: Home summarizes the workspace, Tasks owns task/context/handoff/check actions, K Maps owns API and relationship exploration, and Tools owns connection, indexing, and diagnostics.
- Keep the active project and workspace root visible in the shell. Reuse the existing project/workspace selection flow and make the current scope explicit rather than introducing a parallel navigation model.
- Add a compact health indicator within the existing Tools experience for companion state, MCP handshake, active workspace, and last index time. Do not show generic “Ready” when a dependency is unhealthy; provide a specific retry or details action beside the failed status.
- Add command-palette actions for `AIPI: Create task with AI`, `AIPI: Discover context`, `AIPI: Hand off to agent`, `AIPI: Run task checks`, and `AIPI: Open task terminal`; route each action to the relevant existing task or tab instead of creating new navigation.
- Keep keyboard focus, selected tab, and back/return routes stable when a panel refreshes or a task operation finishes.

### Home and Tasks

- Make Home a launch surface for the active workspace: index health, open tasks, pending agent handoffs, latest verification, and one clear next action. Keep task-creation entry points on Tasks rather than duplicating prominent buttons across Home and detail pages.
- On the existing Tasks page, place `Create task with AI` as the primary header action beside the existing `New Task` and `New milestone` actions. Use a clear hierarchy so AI creation does not compete visually with the ordinary task flow; avoid repeating it in every task panel.
- Add filters for status, milestone, owner, priority, context freshness, and verification state. Show proposed AI tasks separately from user-approved work.
- Provide empty states with direct actions: connect/index workspace, create a task, or import/use a sample project. Show a useful recovery action for stale context, missing links, or a disconnected companion.
- Preserve drafts and filters per project. Warn before losing an unsaved task proposal or context selection.

### Task workspace

Keep the existing single task page, its current task header, and its current **Chain & Evidence → Context Pack → Verify & Proof** flow. Improve those existing sections in place; do not add task sub-tabs, a second stage-navigation system, or a separate Agent tab.

- **Chain & Evidence:** keep `Discover task context` here, where evidence and contract links are established. Explain what discovery will inspect and show progress/results inline. If discovery is already current, offer a deliberate refresh rather than another equivalent action.
- **Context Pack:** separate persistence from delivery. Use one primary `Prepare context` / `Refresh context` button to create and save a versioned pack. Show pack freshness, generation, included evidence, token budget, omissions, and preview. Only after a saved pack exists, show `Hand off to agent` as the primary next action in this section; keep copy/open-file fallback secondary and label its actual outcome.
- **Verify & Proof:** provide one canonical `Review checks` button in the verification section. Remove duplicate `Plan checks` controls elsewhere on the same page. Review the proposed checks and command before approval; show `Run checks` only when the reviewed plan is valid and approved. Put `Open terminal` beside the specific reviewed command as a secondary action, not as a global toolbar button.
- Keep task title, task state, context freshness, and latest verification visible in the existing task header. Show repository revision and plan details in the relevant section or expandable details, not as competing header controls.
- Keep source spans, plan details, and run output in inline expandable sections or side panels. Preserve a one-click return to the originating task when opening linked source or evidence.

Use one primary action per section and put it next to the content it acts on. Never conflate discovery, saving, handoff, terminal launch, and test execution into a single button. Every click should immediately show pending/progress state, then a specific result, error, or recovery action. Disable an action only with its reason and direct resolution step; preserve existing deep links and routes.

### AI task creation

- Add `Create task with AI` to the existing Tasks page header. Support a freeform request and “derive tasks from selected evidence”; from K Maps or evidence details, offer a contextual `Create task from this` action that opens the same proposal flow with that evidence preselected.
- Show editable proposal cards containing title, objective, priority, acceptance criteria, citations, suggested contracts/files, likely tests, and confidence. Mark any generated inference separately from indexed evidence.
- Show duplicate/overlap warnings and let users merge proposals. Use explicit `Create selected tasks` to persist approved proposals; retain drafts if the user leaves the page.
- After creation, show saved task IDs and transition to context review. Do not imply that a task is ready for handoff until a context-pack generation is persisted.

### Context and handoff feedback

- Distinguish **discovered**, **selected**, **saved**, and **sent** context states. Show the context-pack ID/generation and handoff ID in a details panel with copy controls.
- Before sending, show a concise manifest preview: task, selected files/routes, evidence freshness, token estimate, omitted items, unresolved questions, and MCP instructions.
- Report actual dispatch outcomes: `Accepted by agent`, `Opened chat; awaiting agent`, `Saved locally`, `Copied to clipboard`, or `Failed`. Do not use a single ambiguous success toast.
- Keep the handoff record visible when the IDE chat is closed. Let users reopen a prior handoff and resend it without duplicating its identity or losing its original context reference.

### Run and terminal experience

- Before execution, show a review card with check list, required/optional state, command and arguments, working directory, target environment, repository revision, plan hash, timeout, and side-effect warning.
- Separate `Open terminal` from `Run checks`. Terminal launch shows the exact command and folder in a new workspace terminal and reports `Terminal opened`; only observed process results can say `Passed` or `Failed`.
- During a runner job, show queued/running state, current check, elapsed time, bounded output, cancel action, and a link back to the plan. On reconnect, restore the job from persisted state.
- After execution, show a compact result summary first, then expandable per-check output, source references, and evidence IDs. Keep skipped, timed-out, cancelled, interrupted, and unknown outcomes explicit.
- Make unsafe or non-local checks visually distinct. State-changing replay authorization must name the method, route, environment, and plan and remain unchecked by default.

### Visual and accessibility improvements

- Define shared status colors and text labels for current/stale/partial context, handoff states, check execution, coverage, and freshness. Never communicate status with color alone.
- Use consistent primary/secondary/destructive button hierarchy and avoid placing multiple equal-weight actions beside one another. Reserve primary emphasis for the next safe action.
- Standardize loading skeletons, inline errors, empty states, retry states, and success summaries across Home, Tasks, Context, Agent, and Checks.
- Ensure all controls have accessible names, logical tab order, visible focus, keyboard activation, and screen-reader announcements for async progress and completion. Keep modal focus contained and return focus to the initiating control.
- Verify narrow IDE panels, 320–420 px browser widths, high zoom, long filenames/commands, reduced motion, and light/dark themes. Allow long terminal output and citations to wrap or scroll without shifting the task actions off-screen.
- Add UI regression coverage for loading, empty, stale, failed, canceled, and completed states, plus keyboard-only task creation and handoff.

## Shared service and MCP contract

The MCP server, IDE bridge, dashboard, and CLI must call the same application services. Transport handlers should validate and translate requests, not reimplement task or runner behavior.

Define versioned operations with request IDs, idempotency keys, project/task ownership checks, expected entity revisions, typed errors, and stable result envelopes. Persist these domain records:

- `TaskProposal`: prompt reference, generated fields, citations, model/agent provenance when available, review state.
- `ContextPack`: immutable generation, selected evidence, source hashes, budget, revision, freshness, omissions.
- `Handoff`: task/context references, target, dispatch result, status, agent updates.
- `VerificationPlan`: immutable checks, required flags, target, configuration fingerprint, revision, plan hash.
- `VerificationRun` and `CheckResult`: durable progress, output references, exit/status, timing, cancellation and interruption state.
- `Approval`: actor, plan hash, target/environment, allowed operations, expiry, and one-run scope.

Keep existing MCP names stable. Add task proposal/approval and job status/cancel tools only where current tools cannot express the operation. Every MCP tool must declare its side effects, required inputs, bounded output, and typed error behavior. Resource and tool results should cite durable task, context, handoff, and run IDs.

## Delivery sequence

### Stage 0 — Reliability baseline

- Create one end-to-end capability matrix for dashboard, MCP, extension bridge, companion, and CLI.
- Exercise connect, task lookup, context discovery, context persistence, handoff dispatch/fallback, plan preview, safe checks, and receipt retrieval through the real local MCP transport.
- Fix route/version drift, stale workspace locks, ownership checks, timeout handling, and action error feedback before adding more buttons.

**Exit:** a clean launch can complete read-only context discovery and plan preview from both the IDE panel and MCP; persisted IDs agree across both surfaces; failures are visible and recoverable.

### Stage 1 — Persisted context and AI task proposals

- Formalize context-pack generations and task-proposal records.
- Add the shared task proposal service, review UI, provenance, idempotency, and draft recovery.
- Ensure the IDE and MCP see identical task/context state.

**Exit:** generated proposals can be reviewed and created once; agent-discovered candidates can be persisted into a reviewed pack; the resulting task and context are retrievable by both interfaces after restart.

### Stage 2 — Explicit agent handoff lifecycle

- Add a supported agent adapter interface and capability detection. Keep VS Code Chat dispatch, other declared IDE targets, and saved-file/clipboard fallback as distinct outcomes.
- Persist dispatch and agent lifecycle events; surface retries without duplicate handoffs.
- Add citation-backed agent findings and user review controls.

**Exit:** the UI never claims an agent accepted work unless the adapter confirms it; fallback always includes the persisted handoff reference and context file path.

### Stage 3 — Trusted test catalog and job runner

- Introduce project check configuration and script discovery with explicit trust boundaries.
- Add shared job execution, streaming progress, cancellation, restart recovery, bounded output, and frozen-plan approval.
- Support visible terminal launch separately from the companion runner.

**Exit:** run results and statuses match actual process outcomes; UI, MCP, and CLI observe the same job; unsafe/unapproved replays remain skipped.

### Stage 4 — Close-loop task reports and IDE polish

- Connect reindex, context refresh, agent updates, verification, and handoff completion.
- Refine compact panel, accessibility, keyboard navigation, source preview, empty/error/loading states, and multi-root behavior.
- Add install/restart and supported IDE/version matrix validation.

**Exit:** a representative task reaches accepted completion with linked source revision, context generation, handoff, checks, and receipts; stale evidence or missing checks cannot show complete/verified.

## End-to-end acceptance scenario

Use the existing Next.js contract-mismatch fixture:

1. Open the repo in the supported IDE and confirm AIPI binds the correct project.
2. Ask AI to propose tasks from the mismatch and review the citations.
3. Create one task and confirm AIPI persists its context pack and generation.
4. Hand off to the IDE agent; verify the agent receives the task, citations, and MCP instructions and the UI records the actual dispatch outcome.
5. Make the fixture correction through the agent and reindex.
6. Review the frozen test/contract plan; run a repository test through the visible terminal and a safe contract verification through the companion.
7. Inspect per-check results and confirm receipt revision matches the edited tree. A deliberately failing check must remain failed; an unavailable agent or interrupted run must remain unresolved rather than passing.
8. Restart the companion and confirm task, context, handoff, plan, and run history remain available without duplicate execution.

## Product measures

- Task proposal acceptance and edit rate, plus citation coverage.
- Context-pack reuse, freshness, omitted-evidence rate, and agent requests for missing context.
- Handoff dispatch success by supported target; fallback rate and duplicate-handoff rate.
- Required-check execution coverage, interrupted/unknown rate, false-pass count (target: zero), and time from task creation to accepted verified completion.
- MCP tool failures and latency by operation, with error class and retry outcome.

Do not optimize for token reduction alone. The primary measure is developer-accepted completion with trustworthy, revision-matched evidence.
