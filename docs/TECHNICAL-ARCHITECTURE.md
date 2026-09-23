# AIPI technical architecture

## Selected stack

| Layer | Implementation | Reason |
| --- | --- | --- |
| Local runtime | TypeScript + Node.js 22 | Native fit for Next.js projects and compiler tooling. |
| Local MCP | `@modelcontextprotocol/server` v2, stdio | Official stable SDK; negotiates both 2025 and 2026 MCP eras. |
| Route and payload index | `ts-morph` | Reads exported route handlers, Zod object shapes, fetch calls, and TypeScript parameter types. |
| Runtime observer | `@mswjs/interceptors` plus explicit reverse proxy | Socket-level observation for Node clients; proxy remains available for browser traffic. |
| Contract validation | normalized JSON Schema + AJV | Deterministic, machine-readable violations shared by tools and CI. |
| Fixture generation | deterministic templates | Minimal output, stable diffs, and no repository mutation by the MCP tool. |
| Remote MCP | Hono + official MCP v2 HTTP handler on Cloudflare Workers | Web-standard, stateless edge deployment with Streamable HTTP. |
| Registry | Supabase Postgres + RLS | Versioned contracts and consumers isolated by authenticated organization owner. |
| CI | composite GitHub Action | Zero install inside the consumer repository; emits native annotations and blocks on mismatch. |

The user-facing plugin runs `scripts/aipi-mcp-bundle.mjs`, built from `src/local-mcp.ts`. The bundle is intentionally checked into the plugin source because Codex's local marketplace cache does not copy `node_modules`.

## Deterministic evidence flow

1. The observer records a bounded, redacted request and response locally.
2. `trace_route` uses the Next.js filesystem route plus the TypeScript AST to locate the exported method, Zod request schema, and nearest Prisma/Drizzle model.
3. `diff_contract` compares the frontend AST payload with the normalized backend contract.
4. AJV validates an observed or proposed payload and returns JSON Pointer paths and validation keywords.
5. `run_local_diagnostic` correlates that contract evidence with the response and first stack location.
6. `check_blast_radius` compares a proposed provider contract with registered cross-repository consumers.
7. `generate_fixture` returns a native Vitest test to the editor only after runtime evidence exists.

## Deliberate deferrals

- Oxc is deferred until repository indexing benchmarks show `ts-morph` is the bottleneck. Maintaining two AST representations now would increase drift risk.
- Prisma internals and a full PostgreSQL parser are the next schema-adapter milestone. The current wedge supports Prisma and Drizzle field extraction and keeps adapters isolated behind the normalized field model.
- `oasdiff` belongs in the registry ingestion pipeline once OpenAPI version history is stored. Local code-first checks do not need it yet.
- `@actions/core` and the GitHub App API become useful when AIPI posts or updates PR review comments. The current composite action already produces annotations and a failing check without that runtime weight.

## Two engineering lanes

### Local engine and AST

- Own the interceptor/proxy, AST adapters, normalized schema model, local MCP, fixtures, and startup budget.
- Required depth: TypeScript compiler mechanics, Node HTTP/Undici, MCP tool design, and safe process lifecycle management.

### Registry and CI

- Own Hono/Cloudflare deployment, Supabase migrations and RLS, schema versioning, cross-repo graphs, OAuth, and GitHub checks.
- Required depth: Postgres security, edge runtimes, OAuth resource servers, CI/CD, and API governance.

Shared acceptance tests live in `scripts/self-test.mjs` and `scripts/cloud-smoke.ts`; neither lane can change the normalized contract without updating both local and remote evidence tests.
