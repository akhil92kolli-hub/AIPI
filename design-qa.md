# AIPI navigation and environment design QA

Source visual truth: `/var/folders/vw/g8txg3vx6q9g7rdc0j_jlldw0000gn/T/codex-clipboard-64c5ba2e-144f-4a5c-b864-09c57e443246.png`

Implementation evidence:

- Project viewport: `/Users/akhilkolli/Downloads/API-Forge/qa-project-navigation.png`
- Full Project and merged summary: `/Users/akhilkolli/Downloads/API-Forge/qa-project-summary.png`
- APIs environment selector: `/Users/akhilkolli/Downloads/API-Forge/qa-apis-environment.png`
- Side-by-side comparison: `/Users/akhilkolli/Downloads/API-Forge/qa-navigation-comparison.png`

Viewport and normalization:

- Source: 1095 × 1628 pixels.
- Project and APIs implementation captures: 1095 × 1628 pixels, matching the current Codex panel state and density.
- The full Project capture is 2192 × 4654 pixels and is supporting evidence for below-the-fold Summary content, not a density comparison target.
- Source and Project viewport were normalized to 548 pixels wide in the combined comparison while preserving their identical aspect ratio.
- State: dark theme, Starter project, Development environment, Project and APIs routes.

## Findings

No actionable P0, P1, or P2 issues remain.

- Fonts and typography: the enlarged hierarchy remains consistent; header buttons, environment labels, tab labels, and summary content are readable without truncation.
- Spacing and layout rhythm: the persistent header has three balanced actions, the bottom navigation has four equal columns, and the merged Project summary follows a clear section divider.
- Colors and tokens: Home, Upgrade, Settings, environment state, and active navigation reuse the existing charcoal, mint, coral, and neutral tokens.
- Image quality and assets: this UI has no raster product imagery or non-standard visual assets; CSS surfaces and text remain sharp at the captured density.
- Copy and content: Summary is removed as a tab and presented as Project summary. APIs names the active environment and displays its base URL beside the selector.

Focused evidence: the APIs capture verifies selector placement and URL context. Browser checks verified the Settings modal, Upgrade modal, Home navigation, four bottom tabs, and merged Project summary.

## Comparison history

### Pass 1

- P2: route changes could preserve the previous page's vertical scroll position, temporarily moving the new sticky header outside the captured viewport.
- Fix: route navigation now resets scroll position before rendering the destination.

### Final pass

- Header remained at top position 0 after Project → APIs navigation.
- Bottom navigation contains exactly Project, APIs, Map, and Runs; no Summary tab remains.
- Home, Upgrade, and Settings header actions were exercised.
- Project summary is visible on the Project route.
- No horizontal overflow was detected (`scrollWidth` equals viewport width).
- Browser console errors: none.
- Automated MCP/UI self-test: passed.

final result: passed

---

# Latest QA status — Create Task workflow

The current build under review is the Create Task sequential workflow documented in “Create Task sequential workflow QA — 16 October 2026” above.

## 16 October follow-up corrections

Source evidence: user-annotated browser captures at `962 × 1628` for `/projects/prj_0c2cca6faa59/tasks/new`.

- Removed the Stage 3 requirement to select a K Map contract or source artifact before continuing. UI, full-stack, refactor, and discovery tasks can now proceed with objective-only context.
- Added explicit `Build UI / frontend` and `Build a full-stack feature` intents while retaining API fix, planned endpoint, and discovery workflows.
- Clarified indexed search scope in-product: last completed local index across workspace files/symbols, frontend components/callers, backend handlers, schemas, tests, findings, and K Map relationships.
- Added visible search coverage metadata and a cached-browser-state fallback when companion search is unavailable.
- Indexed workspace file matches can now be selected and safely materialized into the task context only when they exist in an authorized project root's latest index.
- Acceptance criteria are intent-aware; UI-only tasks no longer receive API replay requirements.
- Regression, UI, typecheck, and production bundle builds pass.

The supplied annotations verify the pre-fix defect state. A new browser-rendered capture is still required to visually sign off the corrected Stage 1 intent list and Stage 3 workspace results at both the source viewport and a 320–420 px side-panel viewport.

final result: blocked

---

# Create Task sequential workflow QA — 16 October 2026

Source visual truth path: browser-comment screenshots 1–4 attached to the current Codex task for `/projects/prj_623e97852460/tasks/new`. The attachment transport did not expose a stable local file path.

Implementation route: `http://127.0.0.1:49157/projects/prj_623e97852460/tasks/new`

Viewport:

- Source: 980 × 1608 browser-comment capture.
- Intended implementation checks: 980 × 1608 desktop/panel view and 320–420 px IDE side-panel widths.
- State: light theme, Create Task, Stage 1 contract binding and new-contract specification.
- Density normalization: unavailable because a browser-rendered implementation capture could not be retrieved from the in-app browser tool in this text session.

## Full-view comparison evidence

The source clearly shows a P1 contract-selection failure: checkbox labels, methods, routes, states, findings, and file locations collapse into a continuous text run. The implementation replaces that region with a four-column selectable-card structure, collapses it to a three-column responsive card at 520 px, and uses a four-step sequential workflow rather than showing all form sections at once.

## Focused region comparison evidence

The selected Contract & K Map Binding region was used as the focused source. Code-level and automated checks confirm separate method badges, route/status rows, match reasons, source locations, selected states, search/loading/error states, a planned-contract provision summary, and a Stage 2 context seed. A rendered post-change screenshot was not available for a visual pixel comparison.

## Findings

- [P2] Browser-rendered visual comparison unavailable.
  Location: Create Task workflow at desktop and 320–420 px side-panel widths.
  Evidence: the source captures are available in the task, but the in-app browser could only be opened/queued and did not expose a screenshot capture capability in this session.
  Impact: spacing, wrapping, focus states, and sticky-footer overlap cannot be certified visually.
  Fix: capture the refreshed route in the in-app browser at 980 × 1608 and 360 × 800, compare it with the attached browser comments, and address any remaining wrapping or density drift.

## Automated and functional evidence

- Draft project search returns exact contract matches, open findings, source locations, and indexed source references without mutating tasks or context packs.
- Exact route matches and discovery suggestions are auto-linked.
- Fix/discovery modes cannot proceed to proof without a selected contract or source reference.
- Planned endpoints provision a Planned contract, Saved Request, collection membership, bounded Context Pack, affected chain, and verification plan.
- Full regression, UI, setup, handshake, integration, cloud, typecheck, and bundle build passed.
- The live companion was restarted on port 49157 and its authenticated search endpoint returned the expected exact `GET /health` result.

## Comparison history

### Implementation pass

- Replaced the collapsed inline option stream with route cards.
- Split task creation into Intent → Objective → Search & bind → Verify.
- Added server-backed debounced search, explicit loading/error/empty states, auto-linking, evidence gating, planned-contract specification, Context Pack estimate, and creation pipeline summary.
- Added container-responsive spacing and narrow-panel layouts.

final result: blocked

---

# Project management navigation consolidation QA

Source visual truth: browser comment screenshots for the Runtime Mesh and General management routes, captured on 15 October 2026.

Implementation route: `http://127.0.0.1:49156/projects/prj_8f42993d0e1f/manage/mesh`

## Verified behavior

- The persistent project header now shows the active environment and allows switching environments without leaving the current page.
- Choosing `+ New environment…` opens `/projects/{project_id}/manage/environments`.
- The settings icon remains the single project-management entry and opens `/manage/general`.
- The duplicate project-management title, back button, description, and companion badge were removed from the page body.
- The bottom navigation now contains exactly Home, Tasks, APIs, and Tools; the redundant Project item was removed.
- The browser console reported no warnings or errors during the final interaction pass.
- JavaScript syntax, whitespace, and browser/VS Code asset synchronization checks passed.

No actionable P0, P1, or P2 issues remain.

final result: passed

---

# Runtime Mesh and Secret Vault modal QA

Source visual truth: `/var/folders/vw/g8txg3vx6q9g7rdc0j_jlldw0000gn/T/TemporaryItems/NSIRD_screencaptureui_KFvMle/Screenshot 2026-10-15 at 12.21.22 PM.png`

Implementation route: `http://127.0.0.1:49156/projects/prj_8f42993d0e1f/manage/mesh`

## Verified behavior

- Runtime Mesh presents the loopback gateway, environment scope, service topology, port metrics, bound services, route matrix, policies, and live request telemetry in the same order as the source design.
- Starting the Runtime Mesh changes the UI from `Stopped` to `Running`, binds `127.0.0.1:8080`, and changes configured services to `Bound`.
- An unmapped path returns a mesh-owned HTTP 404 response and records diagnostic history.
- A mapped `/api/*` path forwards to the environment's `baseUrl`; an offline upstream returns a clear HTTP 502 response and records route, service, latency, and failure evidence.
- Route, gateway, synchronization, environment selection, and policy settings persist in project state.
- The Vault custom-secret dialog closes with both Close and Cancel while the required secret value is empty.
- Light-theme contrast, desktop scaling, and the compact panel layout remain consistent with the current AIPI design system.
- Browser console errors: none observed during the final interaction pass.
- JavaScript syntax checks, diff whitespace checks, CLI bundle build, and live listener checks passed.

No actionable P0, P1, or P2 issues remain.

final result: passed

---

# Latest test timestamp QA

Source visual truth: `/var/folders/vw/g8txg3vx6q9g7rdc0j_jlldw0000gn/T/TemporaryItems/NSIRD_screencaptureui_0zsfnr/Screenshot 2026-09-23 at 2.25.36 PM.png`

- Added a secondary `Last tested {date}, {time}` line below the run and match tags.
- The value uses the latest run attached to that API and is rendered as a semantic `time` element.
- APIs without run evidence display `Never tested` instead of an invented timestamp.
- Desktop alignment, 480-pixel side-panel wrapping, and zero horizontal overflow were verified.
- Browser console warnings and errors: none.
- Build, validation, local self-test, and cloud MCP smoke test: passed.

No actionable P0, P1, or P2 issues remain.

final result: passed

---

# API-scoped run evidence QA

Source visual truth:

- `/var/folders/vw/g8txg3vx6q9g7rdc0j_jlldw0000gn/T/TemporaryItems/NSIRD_screencaptureui_55BIUs/Screenshot 2026-09-23 at 1.06.32 PM.png`
- `/var/folders/vw/g8txg3vx6q9g7rdc0j_jlldw0000gn/T/TemporaryItems/NSIRD_screencaptureui_tkac5Z/Screenshot 2026-09-23 at 1.06.43 PM.png`
- `/var/folders/vw/g8txg3vx6q9g7rdc0j_jlldw0000gn/T/TemporaryItems/NSIRD_screencaptureui_milnMX/Screenshot 2026-09-23 at 1.30.16 PM.png`

## Verified behavior

- The APIs inventory shows the latest run outcome and integration match as two independent tags.
- At the narrow side-panel breakpoint, both tags remain visible and wrap below the API identity without horizontal overflow.
- The selected API shows its latest status and match status beside the request title.
- All three saved Health check runs appear inside the selected API, ordered newest first.
- Opening a run keeps APIs active in the bottom navigation and presents a `Back to API` action.
- `Back to API` returns to the same request with its run history visible.
- Browser console warnings and errors: none.
- Type check, bundle build, project validation, local self-test, and cloud MCP smoke test: passed.

No actionable P0, P1, or P2 issues remain.

final result: passed

---

# Latest QA status — Create Task workflow

The current build under review is the Create Task sequential workflow documented in “Create Task sequential workflow QA — 16 October 2026” above. Functional and automated checks pass, but the required browser-rendered implementation capture is unavailable in this text session; visual comparison remains blocked pending an in-app browser screenshot at the source viewport and one 320–420 px side-panel viewport.

final result: blocked
