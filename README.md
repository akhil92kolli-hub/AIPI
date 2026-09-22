# AIPI (AI-Programming Interface)

AIPI is a local-first API integration intelligence workspace for Codex, Cursor, and GitHub Copilot. It discovers endpoints, reproduces failures locally, diagnoses the responsible code from evidence, and generates native regression tests. The dashboard is an inspection surface; your existing agent remains the control plane.

## Why AIPI

Developers building with Codex often create APIs and edge functions faster than they can test, organize, and reuse them. API Forge keeps exploratory requests, repeatable collections, assertions, documentation, and failure evidence in one local workspace that both the developer and Codex can use.

## Dashboard

Ask Codex to **open my AIPI dashboard**, or run `npm run dashboard` while developing the plugin. Open the returned loopback URL in Codex's browser panel and toggle that panel while coding. The Project, APIs, Runs, and Summary routes include:

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
- A living project summary with detected libraries, goals, tasks, and iteration history

The dashboard binds only to `127.0.0.1` and defaults to `http://127.0.0.1:43127`.

## Codex tools

- `open_dashboard`
- `api_request`
- `run_collection`
- `list_projects`
- `get_project`
- `scan_project`
- `list_endpoints`
- `get_project_summary`
- `get_history`
- `diagnose_failure`
- `retry_request`
- `get_endpoint_context`
- `list_integration_issues`
- `create_request`
- `run_request`
- `get_run_evidence`
- `compare_runs`
- `create_fix_plan`
- `generate_regression_test`
- `verify_changes`
- `export_project`

The tools remain fully usable without the UI. This lets Codex test an endpoint, explain the response, run a dependent flow, inspect saved history, or diagnose a failure directly in conversation.

## Portable 0.3 foundation

The prototype now includes shared packages for redaction and evidence, repository serialization, the Integration Map, and native test generation. Exported projects use ordinary JSON files under `.api-forge/`; JSON was selected for the first portable schema because it is deterministic, dependency-free, and valid YAML 1.2 input for future YAML tooling.

```text
packages/
├── core/               redaction, route normalization, run comparison, fix plans
├── collection-schema/  repository-native project/request serialization
├── integration-map/    endpoint context and issue model
├── test-generators/    Vitest/Jest regression tests
└── cli/                repository export and inspection
```

CLI examples:

```bash
npm run cli -- inspect /path/to/project
npm run cli -- export ~/.api-forge/workspace.json <project-id> /path/to/project
```

The example in `fixtures/next-contract-mismatch` contains a Next.js route, frontend consumer, schema migration, and native test placeholder for the wedge workflow.

## Develop and test

API Forge has no runtime package dependencies and requires Node.js 18 or later.

```bash
npm run validate
npm test
npm run dashboard
```

The self-test starts a disposable local API, exercises the MCP handshake, sends a one-off request, runs a chained collection with extraction, loads the dashboard, and imports an OpenAPI document.

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

Workspace data is stored in the plugin data directory with user-only file permissions. It can contain credentials, certificates, scripts, request bodies, and logs. Remove sensitive values before sharing a project or plugin data. Scripts should be treated as trusted local code.

API Forge requires Node.js 18+ and has no runtime package dependencies.

## License

MIT
