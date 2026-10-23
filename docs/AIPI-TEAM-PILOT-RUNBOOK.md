# AIPI Team pilot runbook

The cloud team page is `https://app.aipi.website/team` and
the API is `https://mcp.aipi.website`. The Supabase project is
`zwffmaxjbzuazopvorkv`. M5-M7 schema migrations are the source of truth under
`supabase/migrations`; the generated aggregate is `supabase/schema.sql`.

## Onboard a pilot organization

1. From VS Code or Cursor, run **AIPI: Share Current Workspace with Team** or
   click **Share with team** in the AIPI panel. From another IDE or terminal,
   run `aipi team` in the project root. The browser opens `/team` with a
   ten-minute, project-scoped ticket in the URL fragment. It removes that
   fragment from history after loading. Sign in, choose or create an
   organization, review the workspace-wide project and task preview, then click
   **Connect and sync workspace**. AIPI creates a cloud workspace if needed and
   registers its projects without asserting GitHub access. Bind each GitHub
   repository after the connecting user and App installation are verified.
   Checkout paths stay on the device.
2. Invite existing Supabase Auth users into that workspace. A trial starts with
   five seats, expires three calendar months after workspace creation, and
   allows 10,000 accepted change events per UTC month.
   Entitlements are server-owned; only an operator can upgrade a plan.
3. Choose source sharing explicitly. The default is `metadata_only`, which
   permits a bounded summary, status, metrics object, and digest in evidence
   payloads. `snippets` allows a snippet of at most 4,000 characters.
4. The browser creates a team device and passes its signed-in session to the
   local companion over the loopback handoff. The companion enqueues the
   workspace's initial task patches and starts the team change-feed session.
   The companion saves the refresh token in the OS credential vault and resumes
   sync after a restart. Reconnect from the IDE if the session is revoked. On a
   successful connection, the page offers a ten-minute live relay link to the
   full local dashboard. `aipi pair --relay https://mcp.aipi.website` remains
   available for a standalone live session; that command does not populate
   Team Cloud.
5. Publish a graph from declared/static/runtime evidence, then query impact at
   exact repository commits. AI suggestions remain separate until reviewed.

## GitHub App setup for M6

Create a GitHub App installed only on selected pilot repositories. Give it
repository **Issues: read/write**, **Pull requests: read**, **Checks: read**,
**Contents: read**, and **Metadata: read** permissions. Subscribe to `pull_request` and `check_run`
webhooks. Set webhook URL to `https://mcp.aipi.website/api/github/webhook` and
set a unique random webhook secret. Configure these Worker secrets using Wrangler:
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and
`SUPABASE_SERVICE_ROLE_KEY`. For user authorization, also configure
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_APP_CALLBACK_URL` (the Team site's `/team/github-callback` URL), and a
unique `GITHUB_OAUTH_STATE_SECRET`. Never put secrets in the public site or
repository. Apply migrations through `20261021220000_three_month_team_workspace_trial.sql`
before enabling the new routes.

Authorize the GitHub App user from Team settings, then connect the installation
with `POST /api/team/organizations/:id/github/installations` using its verified
installation ID. The browser keeps the short-lived user token for this tab's
session; a fresh authorization is needed after it expires. Repository binding,
source reads, and PR assessment recheck the user's installed repository access.
Allow each trusted CI GitHub App ID and environment using
`POST /api/team/organizations/:id/github/producers`. Signed GitHub deliveries
are deduplicated; only allowed producer app IDs become CI receipts. Associate
a PR with a changed graph node and revision set using
`POST /api/team/pull-requests/:id/target`; inspect its report with `GET .../report`.
Link the team task with `PUT /api/team/pull-requests/:id/task` using `{ "taskId": "..." }`.
`POST .../publish` is disabled until repository write capabilities and the
current-head check are enforced end to end. PR assessment returns candidate
changed nodes and explicit unknown coverage; it is not a verification receipt.

## Pilot acceptance and measurement

Use at least two repositories and two developers. A provider change should
identify the consumer, owner, source reference, and required CI checks. The
same report must show `unverified` before a trusted check, `passed` after a
successful exact-commit check, `failed` after a newer failing check, and
`stale` when the PR head or either repository pin changes. Verify that a
rejected relationship stays rejected after a graph republish.

Measure activation as organizations that bind a repository, create a task,
and produce an impact report within seven days of sign-up. Measure weekly use
as distinct authenticated users with accepted operations; log counts from
`team_accepted_operations`. For each pilot case, record investigation start
and first confirmed consumer discovery, handoff start and teammate's first
accepted operation, and manually reviewed true/false/missed dependencies.
Report median investigation and handoff time and corpus precision/recall each
week. Do not set commercial prices from synthetic tests. Pilot recruitment and
human timing measurements require real participating teams.

## Operations and recovery

Target API availability of 99.9% monthly, p95 authenticated read below 500 ms,
and p95 accepted operation below 1 s under the pilot workload. Alert when the
retention job fails, the oldest accepted change event exceeds 31 days, webhook
failures rise, or usage reaches 80% of a limit. These are pilot targets, not
measured guarantees.

Apply each migration in order and run the rollback-only verification SQL under
`supabase/verification`. The M5-M7 verifiers test graph RLS, GitHub receipt
trust/deduplication, and the pilot limits. Export an organization from the team
page before deletion. The export endpoint refuses to return a silently
truncated table and the snapshot enforces its own 10,000-entity bound. It is a
portability artifact, not a point-in-time backup. Deleting an organization
cascades its team records; the owner must type its exact name.

Follow `docs/AIPI-TEAM-RECOVERY.md` for logical restore order and incident
handling. The hosted Supabase project reported no managed backups and PITR
disabled on 20 October 2026. Enable a suitable backup plan or off-site logical
backup and rehearse a restore into a separate project before taking paid pilot
data. Store backup encryption keys separately, verify row counts and RLS on the
restored project, then cut traffic over only after a read/write smoke test.
