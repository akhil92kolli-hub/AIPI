# AIPI Team cloud deployment

The team UI is built from `sites/aipi-public` and published as Cloudflare Worker
`aipi-team-cloud` at `https://app.aipi.website/team`. The
Worker API remains at `https://mcp.aipi.website`; the UI calls its authenticated
team routes using a Supabase user access token. Supabase project
`zwffmaxjbzuazopvorkv` allows the exact Team `/team` URL as an Auth redirect.

After sign-in, **Open Team dashboard** leads to
`https://app.aipi.website/team/dashboard`. The desktop
dashboard shows shared workspaces, local project bindings, repository links,
tasks and their handoff context, decisions, evidence, verification receipts,
discussion, and GitHub pull requests associated with a task. Team members can
create a shared task, change its status, and add comments. GitHub PRs appear
after the GitHub App is installed and its webhook is configured for this
deployment; a repository binding alone does not fetch PRs. Cloud users can
review shared context from any browser. Source editing and local verification
still require the IDE extension or local companion.

The IDE onboarding flow requires both the updated site and the updated local
companion. The user opens **Connect to Team Cloud** from the active IDE project
or local dashboard. AIPI opens Team Cloud with a ten-minute, project-scoped
handoff ticket in the URL fragment. The user signs in, chooses or creates a
team and workspace, reviews the task preview, and selects **Connect securely**.
The companion then starts an OAuth authorization-code flow with PKCE. Supabase
shows consent at `https://aipi.website/oauth/consent`; if that site has no
session yet, the user signs in there with the same AIPI account. The one-time
code returns to `/team/oauth-callback` and is exchanged by the companion, not
by the browser. The companion checks the signed-in user, team membership,
workspace, and project before it queues task metadata. The OAuth refresh token
is stored only in the OS credential vault. Access and refresh tokens are never
put in the handoff URL or sent from Team Cloud to the local pairing endpoint.

The local dashboard shows the session state, pending writes, conflicts, and
last successful sync. A linked project with no active session is labeled
**Reconnect required**; reopening the Team flow renews authorization. Team Cloud
provides **Revoke all companion sign-ins**, which revokes the OAuth grant and
registered companion devices. The per-device revoke action disables device
writes only; use the grant control to end every companion sign-in. Initial
import shares task titles and statuses; source, paths, secrets and request
bodies stay local. Cloud tasks are cached for bounded context APIs but are not
yet written into the local project's task records. The local Tasks page shows
cloud-only tasks and status differences by stable task identity, with a link
back to the Team dashboard. The website consent origin
may require a second sign-in even when Team Cloud is already signed in.

Run `npm --prefix sites/aipi-public run deploy:team-cloud` with the Cloudflare
account that owns `aipi-team-cloud`. The build produces a Vinext Worker and
static assets, then Wrangler uploads both. Verify `/team` returns HTTP 200 and
`https://mcp.aipi.website/healthz` returns HTTP 200. The generated Wrangler
config uses a starter name; the deployment command supplies the stable Worker
name explicitly.

The previous Sites-hosted copy remains at
`https://aipi-developer-intelligence.maplecrown.chatgpt.site/team` and is older.
The Sites connector returned `project_not_found` when asked to republish it, so
use the Cloudflare Worker URL for team onboarding until that project is
reconciled. Supabase Auth on the free-tier default email provider does not allow
editing OTP email templates; the current Worker UI passes `emailRedirectTo` and
accepts either the email link or an OTP code if the provider sends one.

To validate without persistent production fixtures, run the SQL in
`supabase/verification` through the Management API. Every verification script
opens a transaction and ends with `ROLLBACK`. Run `npm run test:team-sync`,
`npm run test:cloud`, `npm run test:extension`, and
`npx tsc --noEmit --project sites/aipi-public/tsconfig.json` for the local,
remote, IDE, and UI contracts. A real team pilot should still exercise email
sign-in, two-user handoff, and reconnect from the actual supported IDEs.
