---
name: api-testing
description: Test REST and HTTP APIs using AIPI. Use for manual API testing, opening the AIPI dashboard, sending requests, debugging failures, checking authentication or certificates, importing OpenAPI or Swagger, running chained collections, inspecting logs, retrying failed requests, or validating status/body/header/latency assertions.
---

# AIPI (AI-Programming Interface)

AIPI combines a local inspection dashboard with MCP tools. Projects, environments, request definitions, documentation, and the last 500 logs share one local data store. Treat Codex chat as the control plane: the dashboard shows what is configured and what happened, while active planning, testing, diagnosis, and code correction happen through chat and tools.

## Choose the surface

- Use `open_dashboard` when the user wants to inspect projects, source coverage, environments, API inventory, or local run evidence. The rendered app can pass its current redacted context back into Codex chat with Ask Codex.
- Use `list_projects` and `get_project` before reasoning about saved configurations.
- Use `api_request` for a one-off request that does not need to be saved.
- Use `run_collection` for dependent request sequences with extraction.
- Use `get_history` and `diagnose_failure` to investigate saved runs.
- Use `get_endpoint_context` and `list_integration_issues` before proposing cross-layer corrections.
- Use `get_run_evidence`, `compare_runs`, and `create_fix_plan` for evidence-based diagnosis and review-before-mutation planning.
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
4. Recommend a narrow next check. Do not rotate credentials, weaken TLS, or resend a state-changing request without authorization.
5. Retry only when the method and failure are safe to retry or the user explicitly requested it. Prefer backoff for 408, 425, 429, 500, 502, 503, and 504.

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
- Run only user-authored scripts. The script environment is restricted for convenience but is not a security boundary for hostile code.
- Keep response capture bounded and increase it only when needed.
