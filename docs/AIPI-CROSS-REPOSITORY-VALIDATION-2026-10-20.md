# Cross-repository relationship and IDE handoff validation

Date: 2026-10-20. Outcome: backend ownership tests pass; reviewed relationships and live cross-repository IDE handoff are not release-ready.

## Evidence collected

- Production AIPI detector, read-only: 58 candidate caller/handler links, 28 linked handlers, 21 unresolved callers. These are unconfirmed static candidates, not reviewed cross-repository links or runtime proof.
- `node tests/cross-repository-context.test.mjs`: passed ownership, ID collisions, environment routing, approval and membership guards.
- `node tests/mcp-handoff-lifecycle.test.mjs`: passed aggregate receipt completion and foreign-environment staleness checks.
- `node tests/vscode-extension-handoff.test.cjs`: passed the existing mocked extension lifecycle. This test is not a live agent run.
- Native IDE inspection: Visual Studio Code is open on AiPI; installed AIPI extension is vmise.aipi 0.3.6. Its installed source retains the single-project bridge and owner-local verification instructions described below.
- No prompt was dispatched to the IDE agent, no agent acceptance/completion was claimed, and no user task or repository access settings were changed.

## Blocking findings

1. **No reviewed cross-repository relationship path.** `getWorkspaceTarget` in `packages/core/workspace-groups.mjs` filters related targets to the selected target's project. Explicit cross-project selection works, but selection does not establish a reviewed relationship. Matching route names must continue to be insufficient evidence.
2. **IDE picker routes rejected.** Direct read-only checks of `CompanionClient.isAllowed` return false for GET `/api/workspaces` and GET `/api/workspaces/wsg_commerce/targets`. The browser picker cannot simply be assumed to work inside the extension.
3. **IDE state/source access is single-project.** `scopeState` returns only the bound project; foreign-project routes and source navigation outside that root are rejected. Do not fix this by removing the checks: use an explicit trusted workspace-root membership policy and scoped read/write authorization.
4. **Handoff instructions contradict aggregate verification.** Installed and source extension prompts append instructions to call `verify_contract_revision` for every contract with the owner project's ID. Cross-repository tasks instead need the owner task's aggregate verification plan, with each child check retaining its own project/environment. Duplicate contract IDs make the current instruction especially unsafe.
5. **Opening chat is not agent acceptance.** The adapter reports successful execution of the IDE chat command. Real validation still requires an actual agent response, use of the correct context generation, and a current aggregate receipt before completion.

## Required next implementation and acceptance

1. Persist explicit relationship reviews using qualified source/destination references, evidence citations, reviewer attribution, source fingerprints and review state. Reject missing targets; mark reviews stale when cited source or membership changes. Keep reviewed static relationships separate from runtime-verified relationships.
2. Expose reviewable related targets across repositories without silently binding them. Validate duplicate routes/IDs, rejected links, destination ambiguity and stale reviews.
3. Add narrowly scoped workspace picker/review bridge routes. Only expose authorized repository metadata; only open/edit files within explicitly trusted registered roots. Retain cross-workspace and credential protections.
4. Use the canonical aggregate handoff instructions for cross-repository tasks; remove the owner-ID-per-contract suffix. Test foreign source references and approval-bound execution across repositories in the extension harness.
5. Run an isolated, non-destructive live IDE task after the corrected extension is active. Capture task ID, context generation, handoff ID, dispatch result, agent response and aggregate receipt. A copied prompt, opened chat or mocked executor does not satisfy this gate.

This validation did not broaden IDE permissions, replace the installed extension, submit a prompt to Copilot, or mark any feature gate complete.

## Implementation follow-up

Implemented in source after the initial validation:

- Workspace relationship review API and Explore action (select exactly two targets). Explicit directed relation, evidence text, reviewer attribution, optimistic version checks and retained previous reviews. Approval/rejection is separate from runtime verification. Review attribution is entered by the local reviewer, not an authenticated team identity.
- Related-target discovery includes approved, current reviews across projects. Indexed metadata, bounded source-file hashes and workspace membership changes invalidate reviews. Reviews between selected targets travel in the task workspace snapshot and handoff, affecting verification fingerprints. Missing source content is represented as unavailable; review is a human assertion, never runtime proof.
- IDE workspace-picker and relationship routes require all registered roots of every group member to match explicitly open, trusted local IDE folders. No IDE route for changing group membership was added. Foreign project mutation routes remain blocked. Cross-repository source navigation requires an open registered root in a group containing the bound project, with realpath containment checks.
- Task preparation, dispatch and check entry points validate selected repository roots. The general state response remains owner-scoped; relationship records are accessed only through the gated group routes.
- Handoff context retains project/qualified reference IDs, workspace metadata and contracts. Prompts request the complete task verification plan and aggregate receipt rather than substituting the owner ID for foreign contracts.

Automated checks cover authenticated review routes, review conflicts/rejection/staleness/history, unopened-root denial, open registered-root access, symlink protection, aggregate handoff lifecycle and regression behavior. Source and extension builds pass. The installed extension has not been replaced; live-agent acceptance/completion and visual QA remain separate acceptance gates.

## Installation attempt and activation gate

The updated local VSIX was subsequently built and installed successfully with the VS Code CLI (`--install-extension .../extensions/vscode/dist/aipi.vsix --force`). Installed `vmise.aipi-0.3.6/src/extension.cjs` matches the repository build byte-for-byte. The version number remains 0.3.6; version display alone cannot identify this local build.

Activation and live validation remain unconfirmed. The current IDE window did not respond to command-palette/reload attempts, including the native View menu path. A new-window CLI request also did not yield an observable new window. Local browser automation is disabled in Work settings. The extension's separate user-level companion still runs the older cached package on port 49154, with its process working directory in another project. It was not stopped or replaced during this attempt; the updated preview on 55065 is a different runtime.

No IDE agent prompt was submitted, and no agent receipt or completion is claimed. Next requires a responsive/reloaded VS Code window and approval to restart the shared companion using the updated local build, preserving its existing data.

## Companion activation (2026-10-20 02:07 IST)

With the user's approval, and after they reloaded VS Code:

- Reran tests. Passed: `cross-repository-context`, `mcp-handoff-lifecycle`, `vscode-extension-handoff`, `workspace-relationship-reviews`, `workspace-groups`, `workspace-scan` and `task-context-review`. `workspace-groups-route` could not open its loopback socket in the sandbox (EPERM), so it was not counted as a pass or a regression.
- Rebuilt `scripts/aipi-cli-bundle.mjs` and `scripts/aipi-mcp-bundle.mjs`.
- Backed up `~/.api-forge/workspace.json` and `daemon.json` to `~/.api-forge/backups/2026-10-20-pre-restart/`. The backup SHA-1 matches the live file: `1efc89b1…`.
- Stopped the old npx-cached companion (PID 99077). The reloaded extension immediately started its own copy of the cached `@vmise/aipi-companion@latest` (PID 53788). **The extension always starts the published npm package, never a local build.** Stopped that copy too, then started the local build (`node scripts/aipi-cli-bundle.mjs daemon`, PID 53841) on port 49154. `daemon.json` now points to it.
- Data was preserved. Authenticated `GET /api/workspaces` returns 200, and all 10 existing projects and groups load. The companion only rebuilt team memory into `AiPI/.aipi`, which it does normally.

Still open:

- **Live agent handoff.** No registered project pair forms a frontend/backend workspace group. All existing groups are single-project legacy groups. The gate needs (a) two registered repositories in one group, both open as trusted folders in the VS Code window, and (b) a person clicking "Send to agent" in the AIPI panel, because the agent cannot drive VS Code's webview. No prompt has been dispatched. No receipt or completion is claimed.
- **Visual QA** of the Explore relationship review inside the IDE panel has not been done.
- **Persistence risk.** If the local companion stops, the extension will restart the published package, which lacks these changes. Publish the companion package, or add a dev-mode override to the extension, before relying on it.

**Update 2026-10-20 14:57 IST: this risk happened.** The local build (PID 53841) was terminated with SIGKILL (exit 137). Within seconds, VS Code windows open on `/private/tmp/aipi-ide-validation-pLeqSS9D/storefront` started two copies of the *published* companion: PID 64822 on port 49154 and PID 65008 on port 49157. `daemon.json` now points to 49157. That folder holds `orders` and `storefront` validation repositories created at 14:19. The local build is no longer active, so any IDE validation run against the current companion does not test the new source.
