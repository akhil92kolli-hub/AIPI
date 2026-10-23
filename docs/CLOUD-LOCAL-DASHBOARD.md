# Cloud-rendered dashboard with local AIPI execution

## Product boundary

AIPI separates presentation from privileged execution:

```text
Local same-origin dashboard (default) or Cloudflare shell via outbound pairing
  └─ AIPI Local Companion on http://127.0.0.1:49152
            ├─ project evidence timeline
            ├─ API execution and traffic capture
            ├─ source, schema, and Git analysis
            ├─ OS credential vault
            └─ stdio MCP server ↔ Codex / AI editor
```

The Cloudflare application serves static HTML, CSS, and JavaScript. Source code, request credentials, response bodies, private network access, and the authoritative project timeline stay on the developer's machine. The hosted shell is replaceable; the local companion is the data and execution authority.

## Reliable local release

The current release intentionally uses a same-origin loopback dashboard:

1. `aipi open` starts or reuses the companion daemon on `127.0.0.1:49152` or the next configured port.
2. The companion generates an ephemeral session secret.
3. The CLI opens a loopback `/launch` route for the selected project.
4. That route sets an HTTP-only, SameSite cookie and redirects to the local dashboard.
5. The companion never binds to a public interface. Hosted dashboard access uses the outbound pairing bridge described below.

The cookie is local to the loopback origin, is not written to project data, and expires after four hours or when the daemon session is replaced. Every `/api/*` route requires either that cookie or the daemon bearer token.

Opening the hosted `/dashboard/` route directly is a documentation/onboarding state, not a connected workspace. Run `aipi open` for the local dashboard or `aipi pair` for an authenticated hosted session.

### How local authentication works

The daemon secret is a local session credential, not a Cloudflare login:

1. The daemon creates a cryptographically random `sec_...` token and binds only to `127.0.0.1`.
2. `aipi open` navigates to the loopback `/launch` route for the selected project.
3. The route sets an HTTP-only, SameSite cookie and immediately redirects to the local dashboard.
4. Same-origin browser requests include that cookie automatically; MCP and CLI clients use the bearer token from the protected daemon descriptor.
5. The daemon rejects missing or invalid credentials on protected API routes. Run `aipi open` again if the local browser session expires.

Cloudflare serves the public site and the paired dashboard shell. It does not receive the local daemon secret, source code, credentials, API traffic, response bodies, logs, or project evidence.

## Evidence timeline

`workspace.json` version 2 contains the canonical local `timeline`. Events are append-only project facts with bounded, redacted evidence:

- API run succeeded or failed;
- source and Git baseline scanned;
- environment, project, or request configuration changed;
- an agent recorded an implementation decision;
- a correction workflow was prepared or verified;
- a regression test was generated;
- CI or remote contract evidence was received.

Large response bodies remain in the linked run record. Timeline events store only summaries, counters, references, affected files, and contract status. MCP clients retrieve a bounded page with `get_project_timeline`; editors append meaningful decisions with `record_project_event`. This makes the timeline useful for analysis without repeatedly sending the repository or complete logs through the model context window.

## Installation paths

### Codex plugin

The repository includes a local marketplace at `.agents/plugins/marketplace.json`. From the repo root, run `codex plugin marketplace add .`, restart or refresh Codex, then install AIPI from **AIPI Local Development** in the Plugins Directory. Start a new task in a trusted local project. Codex starts the bundled MCP server (`scripts/aipi-mcp-bundle.mjs`) locally over stdio; the MCP process reads and writes the shared `~/.api-forge` workspace and does not require the cloud MCP endpoint. Use `open_dashboard` to render the MCP Apps side panel. The panel and agent share `discover_task_context`, `prepare_task_handoff`, and `review_and_run_task_verification` for the discover → handoff → proof loop.

For the same long-lived loopback companion used by the VS Code extension, initialize the project with `npx --yes --package=@vmise/aipi-companion@latest -- aipi init`. This starts or reuses the local daemon, registers the current source tree, and writes `.codex/config.toml`; Codex then runs the companion's thin stdio MCP client and shares the companion's local workspace. This route is recommended when using AIPI across multiple IDEs. The separate `plugin/aipi` bundle is the cloud contract-registry integration and does not replace the local companion.

### CLI and other MCP editors

```bash
cd /path/to/your/project
npx --yes --package=@vmise/aipi-companion@latest -- aipi init
```

For one-off execution, run:

```bash
npx --yes --package=@vmise/aipi-companion@latest -- aipi open
```

Register the local MCP server in the editor:

```json
{
  "mcpServers": {
    "aipi": {
      "command": "aipi",
      "args": ["mcp"]
    }
  }
}
```

`aipi init` writes `.aipirc.json`, injects local Cursor and VS Code MCP configuration, and records detected source-root topology. `aipi daemon` owns the loopback server, while `aipi mcp` is intentionally a thin stdio client: it checks for a running local daemon, starts one in the background if needed, then relays MCP tool calls to the daemon instead of binding a second dashboard server.

During local dashboard development, use `aipi dev --app http://localhost:8788/dashboard/`. Normal use is `aipi open`; hosted use is `aipi pair`.

## Cloudflare deployment

The showcase build copies the dashboard shell into `dist/client/dashboard/` and deploys static assets plus the Hono Worker. Cloudflare must never proxy local request payloads or receive the loopback bearer token. Configure the companion's `AIPI_APP_ORIGIN` to the exact production dashboard origin.

## Opt-in outbound pairing preview

The local same-origin dashboard remains the lowest-overhead default and works without a cloud account. The companion also includes an opt-in outbound bridge for the hosted dashboard or organizations that need an explicitly paired session:

1. An authenticated user creates a ten-minute pairing session with `aipi pair`; the CLI gives the companion and dashboard different random role secrets.
2. The companion opens an authenticated outbound WebSocket to a Cloudflare Durable Object and the dashboard joins with its separate secret.
3. The Durable Object relays typed AIPI protocol messages—not arbitrary shell commands.
4. A local allowlist permits dashboard state, timeline, scan, request, and diagnosis operations; MCP tool calls and OTLP ingestion are not relay capabilities.
5. Durable Objects keep only hashed role credentials and ephemeral routing state until expiry. They do not persist messages. Durable team contract metadata uses the schema registry's organization RLS and explicit retention controls.

The Worker must be deployed with the `PAIRING` Durable Object binding and Supabase Auth variables before this preview is usable. Until CLI PKCE login lands, pass a short-lived Supabase access token with `AIPI_ACCESS_TOKEN` rather than putting it in shell history:

```bash
AIPI_ACCESS_TOKEN="..." npx --yes --package=@vmise/aipi-companion@latest -- aipi pair \
  --relay https://your-aipi-remote-worker.example \
  --app https://aipi.website/dashboard/
```

The bridge does not replace local MCP. Codex and the IDE continue using stdio locally, preserving zero cloud overhead for normal agent work.
