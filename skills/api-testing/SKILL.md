---
name: api-testing
description: Test REST and HTTP APIs using AIPI. Use for manual API testing, opening the AIPI dashboard, sending requests, debugging failures, checking authentication or certificates, importing OpenAPI or Swagger, running chained collections, inspecting logs, retrying failed requests, or validating status/body/header/latency assertions.
---

# AIPI (AI-Programming Interface)

AIPI combines a local inspection dashboard with MCP tools. Projects, environments, request definitions, documentation, and the last 500 logs share one local data store. Treat Codex chat as the control plane: the dashboard shows what is configured and what happened, while active planning, testing, diagnosis, and code correction happen through chat and tools.

## Choose the surface

- Use `open_dashboard` when the user wants to inspect projects, source coverage, environments, API inventory, or local run evidence. The rendered app can pass its current redacted context back into Codex chat with Ask Codex.
- Use `list_projects` and `get_project` before reasoning about saved configurations.
- Use `create_project` to create a named local workspace with its initial environment and optional source roots. Use `select_project` when the user asks to make an existing project active in the dashboard.
- Use `api_request` for a one-off request that does not need to be saved.
- Use `run_collection` for dependent request sequences with extraction.
- Use `get_history` and `diagnose_failure` to investigate saved runs.
- Use `get_endpoint_context` and `list_integration_issues` before proposing cross-layer corrections.
- Prefer `analyze_and_repair_contract` for the standard correction loop: retrieve a compact project summary, select one relevant saved endpoint, return bounded redacted evidence, prepare an editor-controlled correction, and verify only that endpoint after edits. This is the default token-efficient path.
- Use `get_run_evidence`, `compare_runs`, and `create_fix_plan` for evidence-based diagnosis and review-before-mutation planning.
- Use `trace_route(url, method, root)` first when the user names a route. For Next.js App Router projects its `ts-morph` adapter deterministically returns the handler, Zod/TypeScript request contract, and Prisma/Drizzle model. The legacy saved-request form can also run the lightweight local test hook; state-changing methods require `allow_state_change=true`.
- Use `diff_contract(frontend_file, backend_route, method, root)` to compare a TypeScript-AST frontend fetch payload with the backend JSON Schema contract without sending traffic. Prefer its exact mismatch array over an inferred prose diagnosis.
- Use `run_local_diagnostic(request_payload)` to inspect the most recent captured request or replay it on loopback. Never replay a state-changing request unless `allow_state_change=true`.
- Use `generate_fixture(endpoint, method, root, test_framework="vitest")` after a successful observed request to return a deterministic native regression test. It intentionally returns content to the editor rather than writing a repository file.
- Use `check_blast_radius` before changing a registered backend contract. Cite every affected repository, file, and line returned by the remote registry; do not claim unregistered consumers are safe.
- Use `generate_regression_test` only after the user approves a target inside a configured project root. It creates a new native test and never overwrites an existing file.
- Use `verify_changes` after edits to summarize scan and run state. It does not execute unsafe requests.
- Use `export_project` when the user wants repository-native `.api-forge` definitions. Secret values are intentionally omitted.
- Use `retry_request` only when the user authorized retrying the operation. Remember that POST, PUT, PATCH, and DELETE can change external state.

## Inspection dashboard

The dashboard shows:

- Projects, request collections, environments, and variables
- Bearer, Basic, API-key header, and API-key query authentication
- Params, headers, JSON/text/form bodies, and declarative assertions
- Custom CA certificates plus mTLS client certificate and key
- Pre-request and post-response scripts with a 500 ms limit
- Endpoint documentation and OpenAPI/Swagger JSON or YAML import by paste, file, or URL
- Persistent request history, response inspection, failure diagnosis, and configurable automatic retry

Certificates, credentials, scripts, projects, and logs are stored locally. Tell users to remove credentials before sharing a project or plugin data.

When an Ask Codex follow-up includes a project ID, request ID, or log ID, use the matching API Forge read tools to fetch authoritative state. Do not ask the user to restate saved context. The handoff intentionally includes environment variable names but never values, authentication fields, request bodies, or full response bodies.

## Diagnostic workflow

1. Read the project and recent history rather than asking the user to restate configuration already stored in API Forge.
2. Identify the first failing layer: URL/variables, DNS/connectivity, TLS, authentication, authorization, request validation, media type, rate limit, server error, contract assertion, or latency.
3. Use the response status, headers, body, elapsed time, failed assertions, attempt count, and script output as evidence.
4. When runtime behavior or schema alignment is unclear, trace the route, compare the relevant frontend call, and use captured traffic or a loopback-only diagnostic to locate the first failure.
5. Before editing a registered provider schema, check its cross-repository blast radius. An empty registry means “no registered impact found,” not proof that no consumer exists.
6. Recommend a narrow next check. Separate backend problems, frontend corrections, and schema issues, and cite the source file, run ID, traffic record, schema object, or remote consumer location supporting each item.
7. After a successful correction, generate a native fixture from observed evidence and run the project’s own verification command.
8. Retry only when the method and failure are safe to retry or the user explicitly requested it. Prefer backoff for 408, 425, 429, 500, 502, 503, and 504.

### Bounded contract workflow

Use this sequence when a developer asks to diagnose or correct one API integration:

1. Call `analyze_and_repair_contract` with `project_id` and, when known, `request_id` or `route`.
2. Use its `projectSummary`, `endpoint`, `evidence`, `scope`, and `correction` fields; do not request entire source files or complete logs.
3. Apply the smallest source change in the AI editor. AIPI returns plans and fixtures but does not silently rewrite application code.
4. Call `analyze_and_repair_contract` again with `verify_after_changes=true`. State-changing methods additionally require `allow_state_change=true`.
5. Report the affected route, before/after contract status, affected files, and `telemetry.estimatedTokens`. The verification scope must remain limited to the selected request and its related source evidence.

## Collection shape

```json
{
  "name": "Example flow",
  "variables": { "baseUrl": "https://api.example.com" },
  "requests": [
    {
      "name": "Create item",
      "method": "POST",
      "url": "{{baseUrl}}/items",
      "headers": { "content-type": "application/json" },
      "body": { "name": "demo" },
      "assertions": [
        { "type": "status", "equals": 201 },
        { "type": "json_path", "path": "id", "exists": true }
      ],
      "extract": { "itemId": "id" }
    },
    {
      "name": "Read item",
      "method": "GET",
      "url": "{{baseUrl}}/items/{{itemId}}",
      "assertions": [{ "type": "status", "equals": 200 }]
    }
  ]
}
```

Supported assertions are `status`, `header`, `json_path`, `body_contains`, and `response_time`. JSON paths use simple dot notation with array indexes such as `data.items.0.id`.

## Guardrails

- Prefer loopback, development, staging, or explicitly authorized hosts.
- Never print credentials. API Forge redacts common credential headers in tool reports, but project configuration can still contain secrets.
- Never send secrets to an inferred host.
- Treat `.api-forge/tmp/traffic.ndjson` as sensitive local evidence. It is redacted and bounded, but it may still describe private endpoints and payload shapes.
- Register contracts from trusted CI or an authenticated user context. Never use a service-role credential in an editor-facing remote MCP client.
- Run only user-authored scripts. The script environment is restricted for convenience but is not a security boundary for hostile code.
- Keep response capture bounded and increase it only when needed.
