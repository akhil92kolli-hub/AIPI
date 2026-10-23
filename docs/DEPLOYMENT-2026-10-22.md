# AIPI Cloudflare deployment

The AIPI source repository is `AIPI-AI-Programming-Interface/AIPI`. The deployed surfaces are:

| Surface | Domain | Source and command |
| --- | --- | --- |
| Website and local dashboard assets | `aipi.website`, `www.aipi.website` | `showcase/`, `npm run deploy` |
| Team dashboard | `app.aipi.website` | `sites/aipi-public/`, `npm run deploy:team-cloud` |
| Team API, MCP, and pairing broker | `mcp.aipi.website` | root `cloud/worker.ts`, `npx wrangler deploy --config wrangler.jsonc --no-autoconfig` |

`app.aipi.website` is the canonical Team origin. Requests for `/team` on the legacy `aipi-team-cloud.ceo-935.workers.dev` host redirect there, including OAuth callbacks. The IDE OAuth client still uses the registered legacy redirect URI when exchanging its code; the browser forwards that one-time callback to the canonical origin so it can read the pending pairing request stored there. Keep the legacy Worker hostname active until that OAuth client registration is migrated and tested.

The Team database is Supabase project `zwffmaxjbzuazopvorkv`. Run `supabase db push --linked --dry-run` before applying migrations. On 2026-10-22 the migrations through `20261022231000_broker_team_graph_writes.sql` were applied. The API Worker stores `SUPABASE_SERVICE_ROLE_KEY` and `GITHUB_OAUTH_STATE_SECRET` as Cloudflare secrets.

GitHub installation, repository access checks, webhooks, and user OAuth require a GitHub App plus these Worker settings: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_CALLBACK_URL`, and `GITHUB_WEBHOOK_SECRET`. The callback is `https://app.aipi.website/team/github-callback`. Test a signed-in installation and OAuth exchange before representing GitHub integration as available.
