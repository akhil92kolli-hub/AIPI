# AIPI Team user workflow audit — 21 October 2026

This audit distinguishes code present in the repository, deployed endpoints,
local verification, and a complete end-user workflow. The cloud UI is at
`https://aipi-team-cloud.ceo-935.workers.dev/team`; the API is at
`https://mcp.aipi.website`.

## User-facing workflow today

1. Open a repository folder in VS Code or Cursor with the AIPI extension, or
   run `aipi init` from the repository root. The extension registers the folder
   as a local AIPI project with a stable `prj_` key. `aipi init` configures MCP
   for VS Code, Cursor, and Codex and starts the local companion. The local
   dashboard can also create a project with an optional absolute source folder.
2. In the IDE, run **AIPI: Share Current Workspace with Team**. The companion
   creates a ten-minute, project-scoped ticket. The browser opens Team Cloud
   with `project`, `port`, and `ticket` in the URL fragment; no Supabase access
   token is put in the URL. Team Cloud reads a local preview of up to 200 task
   titles and statuses.
3. Sign in by email, create or select a team and workspace, review the task
   preview, and click **Connect securely**. Supabase then asks for consent on
   `aipi.website` (possibly after signing in there with the same account). The
   one-time authorization code returns to Team Cloud, which hands it to the
   companion. The companion exchanges it with PKCE, verifies the account and
   membership, registers a device, and imports task titles/statuses. The
   browser does not receive the companion's OAuth refresh token. A verified
   local GitHub binding is copied; otherwise the project can be shared without
   a repository binding.
4. Team Cloud displays shared tasks, task context, comments, decisions,
   evidence, receipts, and repository bindings. Another authenticated member
   can read these records while the first developer's companion is offline.
   The full local dashboard is a separate, optional ten-minute relay link and
   requires that developer's companion to remain online.
5. An owner or admin can invite a teammate by email from **Team members**.
   The invitee receives an email sign-in link, signs in with that same confirmed
   address, then accepts the seven-day invitation on the Team page. The seat
   limit is checked when the invitation is accepted.
6. To bind a repository manually, open **Advanced team settings → Repository
   bindings** and enter the AIPI `prj_` key, GitHub `owner/repo`, immutable
   numeric GitHub repository ID, and optional monorepo root. This is a record
   binding, not a GitHub App installation.

## Verified implementation and gaps

| Step | Current evidence | Status |
| --- | --- | --- |
| Local project and IDE registration | Extension `connect()` and CLI `connectProject()` create or reuse a local project; dashboard `POST /api/projects` supports an optional source folder. | Implemented in code; local daemon online. |
| Extension distribution | Extension 0.3.10 now packages companion 0.4.7 directly in the VSIX and checks the running daemon's Team capability before pairing. An extracted VSIX started its own companion in an isolated home and returned `teamOnboarding: 1`. | Source and VSIX verified locally; 0.3.10 installed in the current VS Code profile. Marketplace publication and a clean VS Code/Cursor acceptance run remain open. |
| Local repository identity | Portable manifest and GitHub ID lookup endpoints exist. The lookup requires `AIPI_GITHUB_TOKEN` for private repositories. The local dashboard's Git publish binding is a different feature; no portable repository binding editor was found in `ui/app.js`. | Backend present; end-user flow incomplete. |
| Team sign-in and pairing | Team page, Supabase email sign-in, project-scoped ticket, OAuth PKCE code exchange in the companion, OS vault session storage, and restart recovery exist. The new VSIX is installed in the current VS Code profile; signed-in browser acceptance is pending. Team page and API health each return HTTP 200. | Deployed UI and local source code verified; real browser sign-in and two-device acceptance pending. |
| Initial task import | `enqueueInitialTeamTasks()` imports at most 200 titles/statuses with stable operation IDs; source and paths stay local. | Implemented and unit-tested. |
| Ongoing local task sync | The companion checks linked projects every 15 seconds and queues changed task titles/statuses with cloud versions in the durable SQLite outbox. It waits for pending operations and reports conflicts. Cloud changes are cached in SQLite and exposed through bounded context APIs, but do not update local project task records. | Local-to-cloud metadata sync implemented and unit-tested; two-way task editing and a real two-device acceptance test remain open. |
| Cloud project/repository UI | Onboarding now registers the `prj_` project in the cloud workspace even without GitHub. The project list shows “GitHub not connected”; the manual binding form remains available. API checks field shape and URL/slug agreement but does not resolve the ID against GitHub. | Cloud project registration is implemented; provider identity verification and richer project navigation remain open. |
| Joining a team | Owner/admin email invitations, seven-day expiry, Supabase email sign-in, confirmed-email acceptance, and seat checks are now implemented and deployed. | Live two-person acceptance and mail deliverability remain open. |
| GitHub App | Worker routes verify that an installation ID belongs to the App, webhooks, PRs and check runs. The route does not establish that the signed-in AIPI admin controls that installation. `wrangler secret list --name aipi-remote-mcp` showed only `OPENAI_APPS_CHALLENGE`; the App ID, private key, webhook secret, and service-role key are absent. Team UI has no install/start/callback flow. | **Not operational** in the hosted Worker. |
| GitHub knowledge | Webhook code handles `pull_request` and `check_run` synchronously. No `push` ingestion, durable queue, repository backfill, automatic graph publisher, or task-specific summarizer was found. | Planned. |
| Paid pilot | Rollback-only SQL and synthetic tests exist; a real two-developer/two-repository test and separate-project restore remain open. | Not yet accepted for a paid team. |

`prj_` is the portable AIPI project key. A cloud workspace has its own UUID.
GitHub's numeric repository ID is a third identity. The setup flow must show
these as linked records rather than asking users to interchange them.

## Development plan, in dependency order

### Gate 1 — Make the shipped IDE path work

- Publish the companion with the pairing and renewal code under a new npm
  version; package and publish the matching VSIX/Cursor artifact.
- Add a minimum companion protocol/capability check in the extension so an old
  running daemon cannot silently satisfy the connection test.
- Test from a clean VS Code and Cursor profile with no source checkout or
  prestarted daemon. The IDE command must open a valid Team Cloud preview.

### Gate 2 — One project and repository wizard

- In the IDE/local dashboard, detect the Git remote and resolve its immutable
  GitHub ID through an authenticated provider path. Let the user select the
  repository and monorepo root; verify the checkout remote before saving.
- The same `prj_` identity is now registered locally and in the cloud workspace,
  including before GitHub binding. The advanced repository form can bind it later.
- Prevent accidental sharing into the first unrelated cloud workspace. Ask the
  user to choose an existing workspace or create one during pairing. The Team
  page now defaults a new pairing to a new workspace, with an explicit existing
  workspace selector. That page is deployed; signed-in browser acceptance
  remains open.
- Acceptance: bind two local projects to one cloud workspace, including a
  monorepo project, reopen from another machine, and retain both identities.

### Gate 3 — Complete team onboarding and sync

- Owner/admin email invitations with single-use acceptance and seat checks are
  deployed; verify the email and acceptance flow with two real accounts.
- Local task title/status edits now enter the durable outbox. Extend this to
  task archive/delete, decisions, comments, handoffs, and source-policy-aware
  metadata, using stable IDs and provenance.
- Hydrate cloud task changes into the local project view or show a clearly
  separate shared-task lane in the IDE; resolve conflicts and tombstones there.
- Connection state, last successful sync, pending writes, conflicts, and reconnect are shown in the local dashboard. Team Cloud has a revoke-all-companions OAuth control; mirror live sync status in Team Cloud.
- Acceptance: two developers edit the same task offline, reconnect, resolve a
  conflict, and see the same task in both IDEs and Team Cloud after a restart.

### Gate 4 — Operational GitHub App

- Configure the four Worker secrets and a GitHub App installed only on selected
  pilot repositories. Add an **Install GitHub App** button and post-install
  callback bound to the signed-in AIPI organization; verify the installing
  GitHub user's association with the installation and selected repository
  access server-side before saving it.
- Receive `installation`, `push`, `pull_request`, and `check_run` events; verify
  signatures, record delivery IDs, queue work, and reconcile missed deliveries.
  Backfill selected repository metadata and default-branch commits on install.
- Link a task to a PR and exact revision set in the UI. Publish one updated
  report showing unverified, passed, failed, and stale checks.
- Acceptance: a real two-repository PR and trusted CI run update the correct
  task without manual API calls.

### Gate 5 — Asynchronous task knowledge and pilot readiness

- Run bounded, idempotent knowledge jobs keyed by task and source revision.
  Produce an evidence-linked change digest, affected consumers, decisions,
  unresolved questions, and freshness status; keep suggestions reviewable.
- Recompute after relevant commits, task changes, or verification receipts and
  mark stale results when pins change. Show job progress and failure reasons.
- Enable off-site backup and restore into a separate Supabase project. Test the
  complete workflow with two people and two repositories before paid access.

GitHub's setup URL can return an `installation_id`, but it must be verified
server-side before binding it to an organization. GitHub recommends queueing
webhook processing and deduplicating deliveries; these are requirements for
Gate 4, not properties of the current Worker.
