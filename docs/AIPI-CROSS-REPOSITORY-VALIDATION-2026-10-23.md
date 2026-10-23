# AIPI Cross-Repository Relationship & IDE Handoff Validation Report

**Date:** 2026-10-23  
**Status:** VALIDATED IN ISOLATED ENVIRONMENT (All 9/9 Test Suites Passing)  
**Task Scope:** One Workspace Application — Analyze Once, Reuse Facts, Assemble Per Task  

---

## Executive Summary

The cross-repository IDE agent handoff loop was executed end-to-end within the isolated disposable validation fixture (`/tmp/aipi-ide-validation-pLeqSS9D/`). The entire workflow was verified:
1. **Multi-Repository Context Assembly:** Selected evidence across distinct projects (`storefront` and `orders`) preserving project ownership, repository paths, and environments.
2. **Explicit Relationship Review:** Reviewed directed `CALLS` relationship with concrete source citations; distinguished static routing configuration from runtime proof.
3. **Bounded Context Handoff:** Packaged a token-bounded context manifest (2,313 tokens) with aggregate verification instructions.
4. **Agent Acceptance & Execution:** Recorded agent acceptance without modifying read-only fixture source code (0 bytes changed, verified via SHA-256 baseline).
5. **Honest Aggregate Verification Receipt:** Executed the complete task verification plan across both repositories, recording an honest aggregate receipt (`Verification pending` with passed component structure and skipped unconfigured behavior proofs).

---

## 1. Environment & Process State Inspection

| Component | Expected State | Actual Observed State | Verification Method |
| :--- | :--- | :--- | :--- |
| **Validation Path** | `/tmp/aipi-ide-validation-pLeqSS9D/` | Mounted with `storefront` and `orders` | Direct filesystem traversal |
| **Companion Process** | Isolated process on port 62307 (PID 96508) | PID 96508 terminated; Daemon PID 92557 active on 127.0.0.1:49152 | Process table check (`ps aux`) |
| **MCP Wiring** | Fixture `.vscode/mcp.json` | Both repositories point to `scripts/aipi-mcp-bundle.mjs` | JSON inspection |
| **VS Code Workspace** | `storefront.code-workspace` | Multi-folder workspace group registered in AIPI | `workspace.json` inspection |

---

## 2. Tested Entities & Exact Identifiers

### Projects & Workspace Group
- **Workspace Group:** `wsg_ide_validation_pLeqSS9D` (*IDE validation - storefront and orders*)
- **Storefront Project:** `prj_2ea7fbf9843f` (*AIPI validation storefront*)
  - Repository Root: `/private/tmp/aipi-ide-validation-pLeqSS9D/storefront`
  - Commit: `b602f7f8fbeaaeafe099916c2a72302fe903832b`
  - Environment: `env_2227389ea7f7`
- **Orders Project:** `prj_732079529221` (*orders*)
  - Repository Root: `/private/tmp/aipi-ide-validation-pLeqSS9D/orders`
  - Commit: `fdaa37d6b7adb32906dc8cf0c5c844b232eb8c48`
  - Environment: `env_d0069b8779e8`

### Task
- **Task ID:** `task_fixture_readonly`
- **Owner Project:** `prj_732079529221` (orders)
- **Title:** `Inspect Checkout CALLS Relationship`
- **Targets:**
  - `consumer:call_e6493338bbc6754a3811a15f` (`storefront/app/components/CheckoutForm.tsx:5`)
  - `endpoint:ep_ae5d2c6dce3ac5a44e404024` (`orders/src/server.ts:7`)
- **Mode:** READ-ONLY (no source code edits allowed)

### Reviewed Relationship
- **Relationship ID:** `relationship_1f69b1c74a30c7ed61816b12`
- **Type:** `CALLS`
- **Source:** `prj_2ea7fbf9843f/consumer:call_e6493338bbc6754a3811a15f`
- **Target:** `prj_732079529221/endpoint:ep_ae5d2c6dce3ac5a44e404024`
- **Review Status:** `approved`
- **Freshness:** `stale: false`
- **Fingerprint:** `b75a34d306c33a8d204b706f`
- **Citation:**
  > *"Static source review: storefront/app/components/CheckoutForm.tsx:5 posts /checkout; storefront/next.config.mjs rewrites /checkout to localhost:4001/checkout; orders/src/server.ts:7 handles POST /checkout. Routing is configured source evidence, not runtime verification."*
- **Runtime Verification:** `runtimeVerified: false` (accurately distinguished from static review)

### Context Pack & Handoff
- **Context Pack ID:** `context_ddb0c397eeb347b88600` (Generation 2)
- **Token Count:** 2,313 / 2,400 token budget
- **Handoff ID:** `handoff_4b3d0a15ba9b`
- **Dispatch Outcome:** `accepted` by `copilot`
- **Agent Message:**
  > *"Agent accepted read-only task: inspected relationship_1f69b1c74a30c7ed61816b12 and confirmed routing evidence without modifying code."*

### Aggregate Verification Receipts
- **Aggregate Receipt ID:** `receipt_2a6bb38b83d742d4`
- **Plan Hash:** `sha256:904fa848f748f0d92502aabfe2d6e144b675120f8792230fd5497e3c12b57236`
- **Overall Result:** `Verification pending`
- **Repository Receipts:**
  - `receipt_afc27d608bc040fb` (`prj_732079529221`): `component-structure` PASSED
  - `receipt_48c14ebfc3dd4185` (`prj_2ea7fbf9843f`): `component-structure` PASSED
- **Behavior Proof Checks:**
  - `prj_732079529221:behavior-proof`: SKIPPED (*"Configure and run a test command in this repository to verify behavior. Indexed source alone is not proof."*)
  - `prj_2ea7fbf9843f:behavior-proof`: SKIPPED (*"Configure and run a test command in this repository to verify behavior. Indexed source alone is not proof."*)

---

## 3. Read-Only Fixture Integrity Verification

A strict byte-for-byte SHA-256 comparison against the baseline recorded in scratch storage confirms 0 bytes of source modification during the validation run:

| File Path | Baseline SHA-256 | Post-Validation SHA-256 | Match |
| :--- | :--- | :--- | :---: |
| `storefront/app/checkout/page.tsx` | `61316d2edeb0c719b7dca305fb82e48f4ec118f282704c1d38f6e11a352ace3a` | `61316d2edeb0c719b7dca305fb82e48f4ec118f282704c1d38f6e11a352ace3a` | PASS |
| `storefront/app/components/CheckoutForm.tsx` | `81213a45eeed73f440b8a9a936bd140011e5843c17a56b37973f8050d617e942` | `81213a45eeed73f440b8a9a936bd140011e5843c17a56b37973f8050d617e942` | PASS |
| `storefront/next.config.mjs` | `d33df15ae94efecb7706f0050c449f58b01bb4bb1023f6707145b8d6d04a54f5` | `d33df15ae94efecb7706f0050c449f58b01bb4bb1023f6707145b8d6d04a54f5` | PASS |
| `orders/src/checkout.ts` | `0490ed2d895c2256e4c3063a2d34492885afc06618e17c53d109cb99876d95c7` | `0490ed2d895c2256e4c3063a2d34492885afc06618e17c53d109cb99876d95c7` | PASS |
| `orders/src/server.ts` | `298b5349a24769b9aa25dcf0bb1b19389d63155aa6b4718d2893e2bdf8aee54b` | `298b5349a24769b9aa25dcf0bb1b19389d63155aa6b4718d2893e2bdf8aee54b` | PASS |

**Working tree state:**
- `storefront`: Working tree clean (`master`).
- `orders`: Untracked AIPI project ledger updates in `.aipi/team-memory.json` and `.aipi/verification-receipts.json` storing the newly issued receipts.

---

## 4. Key Fixes Implemented & Tested

### 1. `CompanionClient` Route Allowlist Expansion
- **Root Cause:** `CompanionClient.isAllowed` previously restricted `/api/workspaces` to sub-routes (such as `targets` and `relationships`), rejecting top-level workspace queries and task/context-pack operations.
- **Fix:** Updated regex in `extensions/vscode/src/CompanionClient.cjs` to allow all canonical workspace read, mutation, append, and context-pack routes (`GET/POST /api/workspaces/:workspaceId/*`).

### 2. Git Status Noise & Metadata Isolation
- **Root Cause:** Modifications to `.aipi/team-memory.json` and `.aipi/verification-receipts.json` caused Git working tree fingerprints to change, prematurely flagging task context as stale.
- **Fix:** Implemented `isInternalAipiPath` filter in `packages/core/git-evidence.mjs` to omit internal `.aipi` and `.api-forge` paths from Git evidence and status calculations, preserving true repository dirty-state detection without deleting files or using unreviewed `.gitignore` rules.

### 3. Misleading Status Messaging
- **Root Cause:** Tasks displayed "waiting for agent response" even after receiving a terminal `blocked`, `failed`, or `completed` receipt because the UI checked `dispatch.state === "chat_opened"` before inspecting the receipt outcome.
- **Fix:** Reordered status evaluation in `ui/app.js` and `extensions/vscode/media/app.js` so terminal states and agent messages take precedence over the initial dispatch marker.

### 4. Canonical Aggregate Verification Instructions
- **Root Cause:** Extension prompts previously instructed agents to verify contracts using the task owner's ID across all contracts, breaking cross-repository verification.
- **Fix:** Standardized handoff instructions in `packages/core/handoff.mjs`, `extensions/vscode/src/extension.cjs`, and companion bridges to direct agents to:
  1. Call `get_task_verification_plan` for the task owner;
  2. Execute the plan via `start_task_check_job` / `get_task_check_job`;
  3. Preserve each check's repository and environment;
  4. Complete handoff with aggregate receipts;
  5. Honestly report `blocked` or `failed` when proof cannot be produced.

---

## 5. Verification Suite Results

All automated suites passed with 0 failures:
- `npm test`: 9/9 test suites passing (source-index, workspaces, team-sync, regression, ui, setup, handshake, integration, cloud)
- `node tests/verification-coverage.test.mjs`: 15/15 assertions passed
- `node tests/workspace-provider.test.mjs`: Local & Team provider contracts verified
- `node tests/task-proposals.test.mjs`: Task proposal lifecycle verified
- `node tests/workspace-groups-route.test.mjs`: Multi-project workspace HTTP routes verified
- `npm run typecheck`: Passed (clean)
- `npm run build:extension`: Extension and assets bundled cleanly

---

## 6. Rollout Separation & Next Steps

### Fixed & Tested in Source
- Canonical `WorkspaceProvider` base class and projections.
- Unified dashboard server endpoints for workspaces, tasks, context packs, and receipts.
- Git status noise filter for internal `.aipi` directories.
- Status messaging precedence hierarchy.
- Aggregate cross-repository verification instructions and handoff guards.

### Validated in Isolated Environment
- Two-repository multi-project workspace (`storefront` + `orders`).
- Directed cross-repository `CALLS` relationship reviewed with source citations.
- Token-bounded context assembly and Copilot dispatch acceptance.
- Read-only source code integrity confirmed (0 bytes changed).
- Aggregate verification run recorded without fabricated proofs.

### Requirements for Safe Rollout to Shared Companion & Main Profile
1. **Shared Daemon Restart:** The running daemon on PID 92557 uses the older 0.3.10 companion bundle. Restarting the companion daemon will load the 0.4.9 bundle with the updated workspace lock and route allowlist.
2. **VS Code Extension Update:** Package and install the freshly built VSIX (`0.3.11`) into the main VS Code profile to activate the expanded `CompanionClient` routes and aggregate verification instructions.
