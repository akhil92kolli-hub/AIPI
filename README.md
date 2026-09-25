# AIPI (AI-Programming Interface)

AIPI is a local-first API integration intelligence workspace for Codex, Cursor, and GitHub Copilot. It discovers endpoints, reproduces failures locally, diagnoses the responsible code from evidence, and generates native regression tests. The dashboard is an inspection surface; your existing agent remains the control plane.

## Why AIPI

Developers building with Codex often create APIs and edge functions faster than they can test, organize, and reuse them. AIPI keeps exploratory requests, repeatable collections, assertions, documentation, and failure evidence in one local workspace that both the developer and Codex can use.

## Product architecture

```text
AI editor / Codex
  │
  ├─ Local Companion (developer machine)
  │    ├─ traffic proxy or Node fetch hook
  │    ├─ route + schema tracer
  │    ├─ contract diff and local diagnostic
  │    ├─ Vitest fixture generator
  │    └─ inspection dashboard
  │
  └─ Remote MCP Service (authenticated team context)
       ├─ Supabase contract registry with RLS
       ├─ cross-repository blast-radius check
       └─ CI contract guardrail
```

The local companion does not replace the editor. It supplies deterministic evidence and lets Codex handle chat, repository edits, review, and verification. The remote service stores contracts and consumer locations—not captured payload bodies.

The implementation decisions, evidence pipeline, deferred adapters, and two-engineer ownership split are documented in `docs/TECHNICAL-ARCHITECTURE.md`.

## Dashboard

Ask Codex to **open my AIPI dashboard**, run `aipi open`, or run `npm run dashboard` while developing the plugin. Open the returned loopback URL in Codex's browser panel and toggle that panel while coding. The Project, APIs, Map, and Logs routes include:

- Projects, requests, environments, and variables
- Bearer, Basic, and API-key authentication
- Params, headers, JSON/text/form bodies, and tests
- CA certificates and mTLS client credentials
- Pre-request and post-response scripts
- Request documentation
- OpenAPI 3.x and Swagger 2 JSON/YAML import from a file, pasted document, or URL
- Persistent history, response details, Codex-oriented diagnosis, and automatic retry
- Local source folders grouped as frontend, backend, database, schemas, tests, or documentation
- Automatic recognition of common frontend calls, backend routes, database tables, and integration gaps
- A living Project summary separating backend problems, frontend corrections, schema issues, evidence freshness, goals, tasks, and iteration history

The local companion binds only to `127.0.0.1` and defaults to `http://127.0.0.1:49152`. `aipi open` starts or reuses the daemon, creates a short-lived session token, and opens the cloud dashboard with the local connection parameters. Visiting `/dashboard/` directly shows the shell only; use `aipi open` so the URL includes `#port=...&token=...`.

## Deployment and installation model

AIPI is local-first by design. Cloudflare hosts the public website, documentation, and dashboard shell. The local AIPI Companion runs the MCP server, scans source code, executes API requests, and stores logs and evidence on the developer's machine. An optional outbound pairing bridge can connect the cloud dashboard to an approved local companion without opening an inbound port.

Install and initialize the companion:

```bash
cd /path/to/your/project
npx @vmise/aipi-companion init
```

For one-off execution, use:

```bash
npx @vmise/aipi-companion open --app https://aipi.website/dashboard/
```

Setup configures project-local MCP connections for Codex, Cursor and VS Code, starts or reuses the companion, registers the source folder, and opens the project's cloud dashboard. Running the package without arguments performs the same setup. No global installation is needed. Reload your IDE after first setup and accept its project trust prompt if shown. Codex project configuration applies to trusted projects ([configuration documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).

For automation, `init --no-open` performs setup without launching a browser; `init --config-only` only writes configuration. Existing project settings and unrelated MCP entries are preserved. Plain `npm install` only downloads the package; use the command above to launch setup.

The generated Cursor MCP entry looks like:

```json
{
  "mcpServers": {
    "aipi": {
      "command": "npx",
      "args": ["-y", "@vmise/aipi-companion", "mcp", "--root", "/path/to/your/project"]
    }
  }
}
```

`aipi init` writes `.aipirc.json`, detects common source roots such as `apps/web`, `apps/api`, `prisma`, and `supabase`, and injects the AIPI MCP entry into local Cursor and VS Code config. `aipi daemon` owns the loopback server, while `aipi mcp` is a thin client: it reuses an existing daemon or starts one silently before serving MCP over stdio.

Use `aipi status` for a quick connection check and `aipi doctor --root .` to verify the project and IDE configuration. To collect framework-neutral OpenTelemetry evidence while running a development process, use:

```bash
npx @vmise/aipi-companion run -- npm run dev
```

This starts or reuses the companion, selects the current project, and supplies an authenticated local OTLP/HTTP JSON endpoint to the child process. The application still needs its normal OpenTelemetry SDK or auto-instrumentation package; AIPI does not inject third-party instrumentation into source code.

See the hosted [installation guide](https://aipi.website/install.html) for the cloud dashboard, pairing flow, data boundary, and troubleshooting model.

## Codex tools

- `open_dashboard`
- `api_request`
- `run_collection`
- `list_projects`
- `create_project`
- `select_project`
- `get_project`
- `scan_project`
- `list_endpoints`
- `get_project_summary`
- `get_project_timeline`
- `record_project_event`
- `analyze_and_repair_contract`
- `get_history`
- `diagnose_failure`
- `retry_request`
- `get_endpoint_context`
- `list_integration_issues`
- `create_request`
- `run_request`
- `get_run_evidence`
- `trace_route`
- `diff_contract`
- `run_local_diagnostic`
- `generate_fixture`
- `check_blast_radius`
- `compare_runs`
- `create_fix_plan`
- `run_correction_workflow`
- `generate_regression_test`
- `verify_changes`
- `export_project`

The tools remain fully usable without the UI. This lets Codex trace actual traffic, compare observed response contracts with database schema, generate editor-ready fixtures, and summarize cross-layer corrections directly in conversation. `get_project_timeline` provides bounded, high-signal context instead of sending entire logs or repositories into the model, while `record_project_event` preserves agent decisions and implemented changes as redacted local evidence. Fixture generation returns content without writing files so the developer's AI editor stays in control of repository changes.

`run_correction_workflow` is the closed-loop entry point. Its first call returns the failing evidence, affected files, Git freshness, fix plan, and a non-writing regression fixture. After the editor applies the correction, call it again with `verify_after_changes=true` to rerun the saved request, persist new evidence, and compare the result with the original run. State-changing methods remain blocked until `allow_state_change=true` is explicitly authorized.

## Local Companion

The prototype now includes shared packages for redaction and evidence, repository serialization, the Integration Map, and native test generation. Exported projects use ordinary JSON files under `.api-forge/`; JSON was selected for the first portable schema because it is deterministic, dependency-free, and valid YAML 1.2 input for future YAML tooling.

```text
packages/
├── core/               redaction, route normalization, run comparison, fix plans
├── collection-schema/  repository-native project/request serialization
├── contract-engine/    Next.js, Node HTTP, Supabase + Zod tracing and deterministic diffs
├── integration-map/    endpoint context and issue model
├── local-observer/     redacted loopback request/response capture
├── remote-registry/    file/Supabase registry and blast-radius engine
├── test-generators/    Vitest/Jest regression tests
└── cli/                repository export and inspection
```

CLI examples:

```bash
npm run cli -- inspect /path/to/project
npm run cli -- export ~/.api-forge/workspace.json <project-id> /path/to/project
npm run cli -- trace /api/users POST /path/to/project
npm run cli -- diff src/create-user.ts /api/users POST /path/to/project
npm run cli -- diagnose /api/users POST /path/to/project
npm run cli -- fixture /api/users POST /path/to/project
npm run cli -- guard /path/to/project
```

### Capture actual local traffic

Run an explicit proxy in front of an already-running local app:

```bash
npm run observe -- --target http://127.0.0.1:3000 --port 43128 --root /path/to/project
```

Point the frontend at `http://127.0.0.1:43128`. Redacted request/response evidence is appended to `.api-forge/tmp/traffic.ndjson`.

For Node applications whose traffic uses global `fetch`, load the zero-config hook instead:

```bash
AIPI_OBSERVER_ROOT=/path/to/project \
  node --import /absolute/path/to/API-Forge/scripts/aipi-observer-hook.mjs server.mjs
```

The observer removes authorization, cookies, API keys, passwords, tokens, and common secret fields. Captured evidence is still sensitive local data and should not be committed.

The example in `fixtures/next-contract-mismatch` contains a Next.js App Router handler, Zod validation, Prisma model, and an intentional frontend `number` versus backend `uuid` mismatch.

## CI contract guardrail

The repository ships a composite GitHub Action and a working example workflow. In another repository:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: akhil92kolli-hub/AIPI@main
    with:
      root: .
```

The guard scans supported frontend/backend pairs, emits GitHub annotations for exact mismatches, and exits non-zero when a contract is violated. Pin a release tag or commit SHA in production.

## Remote MCP service

For a zero-infrastructure demo, run the Node Streamable HTTP server backed by a local JSON registry:

```bash
npm run mcp:remote
# http://127.0.0.1:8788/mcp
```

Set `AIPI_REGISTRY_FILE` to move the demo registry or `AIPI_REMOTE_TOKEN` to require a static bearer token. For server-side Supabase access, set `SUPABASE_URL` and `SUPABASE_SECRET_KEY`; never expose that secret to an editor client.

The production remote service lives in `cloud/worker.ts`: Hono hosts the official MCP v2 Streamable HTTP handler on Cloudflare Workers and forwards the caller's Supabase access token to the Data API, so row-level security limits every contract to an organization owned by that user. `supabase/functions/aipi-mcp` remains a Supabase Edge Function deployment adapter for teams that prefer to keep compute and data on one platform.

```bash
supabase db push
supabase functions deploy aipi-mcp
# or deploy the Hono worker after setting its Supabase secrets
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_PUBLISHABLE_KEY
npx wrangler deploy
```

The deployed function is available at `https://<project-ref>.supabase.co/functions/v1/aipi-mcp`. A public Codex/ChatGPT marketplace release should place a stable custom HTTPS `/mcp` endpoint in front of it and complete OAuth, domain verification, publisher verification, privacy/terms metadata, and OpenAI review. The checked-in implementation is deployment-ready infrastructure, not evidence that those external approvals have been completed.

Remote client configuration is illustrated in `.mcp.remote.example.json`. The local Codex plugin continues to use `.mcp.json` and requires no cloud account.

## Develop and test

AIPI requires Node.js 22 or later. Production dependencies are deliberately limited to the official MCP v2 server, `ts-morph`, MSW interceptors, AJV, Zod, and Hono. The Codex plugin launches a self-contained bundle, so it does not depend on `node_modules` being copied into the plugin cache.

```bash
npm run validate
npm run build
npm run test:regression
npm run test:integration
npm test
npm run benchmark:startup
npm run demo:aipi
npm run dashboard
```

The port-free regression test validates adapters, AST extraction, Zod constraints, traffic redaction, fixture anonymization, and honest unknown blast-radius status without opening a network socket. The integration test additionally starts disposable local and remote APIs, captures traffic, traces the demo route, detects its contract mismatch, diagnoses a runtime failure, generates a Vitest fixture, verifies cross-repository blast radius, exercises both MCP handshakes, loads the dashboard, and imports an OpenAPI document. GitHub Actions runs both layers independently on Linux, macOS, and Windows.

Source scans now capture the Git commit, branch, working-tree state, and changed files for every configured root. Project summaries and verification tools report whether the current repository still matches the evidence baseline.

`npm run demo:aipi` prints a deterministic product story: the traced handler/schema/model, the local `number → uuid` mismatch, and both registered consumer repositories affected by the proposed breaking change.

`npm run benchmark:startup` enforces the Local Companion's cold MCP handshake target of under two seconds.

## Plugin architecture

```text
Codex / ChatGPT
  ├─ API testing skill
  └─ local MCP server
       ├─ agent tools and structured results
       ├─ shared workspace store
       └─ loopback dashboard
```

The bundled dashboard is exposed as an MCP Apps UI resource and also runs on loopback for local development. Ask Codex actions use the native chat bridge when hosted by Codex and copy redacted context when opened standalone.

## Install for local Codex testing

Place the project in a local plugin marketplace, install `api-forge`, then start a new Codex task so the skill and MCP tools are loaded. The plugin manifest is in `.codex-plugin/plugin.json`, and the local MCP process is configured by `.mcp.json`.

## Storage and security

Workspace data is stored in the plugin data directory with user-only file permissions. Saved environment secrets, request authentication values, and mTLS client private keys use the native credential facility available on the host: macOS Keychain, Linux Secret Service through `secret-tool`, or Windows Credential Manager through the built-in Windows PowerShell API bridge. All providers use the `com.aipi.companion` service identity. `workspace.json` contains only opaque `aipi-secret://...` references, and AIPI has no plaintext credential fallback. Existing plaintext values are migrated the next time the workspace is saved. Use the `get_secret_storage_status` MCP tool to verify the active provider.

Request bodies, response logs, public certificates, and scripts remain local workspace data and may still be sensitive. Remove sensitive payloads before sharing plugin data. Scripts should be treated as trusted local code. Linux installations need the `secret-tool` executable and an unlocked desktop keyring. On an unsupported or unavailable provider, AIPI refuses to persist new credential values.

AIPI requires Node.js 22+ for the local companion and MSW's current socket-level HTTP interceptor.

## License

MIT
