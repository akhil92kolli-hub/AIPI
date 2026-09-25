# AIPI development roadmap

This document tracks implementation against the Local Companion + Remote MCP product plan.

## Current milestone: 0.3 foundation

Implemented:

- Local HTTP execution, assertions, variables, authentication, certificates, bounded capture, retry, and history
- OpenAPI import and local source scanning
- Next.js, Express, Supabase Edge Function, FastAPI, fetch, Axios, and SQL-table recognition
- Frontend-to-backend route matching with source locations and confidence
- Mobile inspection dashboard with Home, Project summary, APIs, Integration Map, and Runs routes
- Native Codex chat handoff through the MCP Apps bridge
- Shared redaction, route normalization, run comparison, and fix-plan logic
- Repository-native `.api-forge` JSON format with secret omission
- CLI export and inspection commands
- Endpoint evidence, integration issues, run evidence, run comparison, fix planning, verification, and project export MCP tools
- Native Vitest/Jest regression-test generation without overwrite
- Next.js contract-mismatch fixture
- Official MCP v2 stdio server with 2025/2026 protocol negotiation
- MSW socket-level Node observer and explicit browser-compatible reverse proxy
- `ts-morph` Next.js/Zod/frontend payload adapter with AJV validation
- Hono/Cloudflare remote MCP worker and Supabase RLS contract registry
- Cross-repository blast-radius tool and self-contained GitHub Action guard
- Git-aware scan baselines and changed-since-verification reporting
- Closed-loop `run_correction_workflow` evidence, fixture, rerun, and comparison orchestration
- Deterministic Supabase Edge Function route and Zod validation tracing
- Cross-platform credential storage using macOS Keychain, Linux Secret Service, or Windows Credential Manager, with opaque workspace references and no plaintext fallback
- Project evidence timeline covering runs, scans, configuration changes, agent decisions, contract verification, security, and CI signals
- Bounded `get_project_timeline` and redacted `record_project_event` MCP tools for token-efficient agent context
- Cloud-rendered dashboard shell paired with a bearer-protected loopback companion and `aipi open`/`aipi mcp` CLI flows
- Shared route-adapter registry used by MCP tracing and the dashboard for Next.js App Router, Supabase Edge Functions, Express, Hono, Fastify, FastAPI, and Node HTTP
- Authenticated OTLP/HTTP JSON ingestion with `aipi run -- <command>` for framework-neutral runtime route, source, and database evidence
- Structurally anonymized fixture and observed-test generation with explicit field preservation
- Cross-platform deterministic and loopback integration CI on Linux, macOS, and Windows
- Atomic daemon descriptors, stale-state recovery, startup locking, and `aipi status` / `aipi doctor` diagnostics

In progress for 0.3:

- Move the HTTP runner fully out of the prototype server into the shared runner package
- Add cURL and Postman import
- Add multipart and binary bodies
- Add credential lifecycle cleanup and provider migration diagnostics
- Expand validation extraction inside Express, Hono, Fastify, and FastAPI handlers
- Add PostgreSQL migration and live-local-database schema adapters

## Next milestone slices

### 0.3.1 — schema depth

- Versioned JSON Schema for project, environment, request, workflow, and run evidence files
- Import/export round-trip tests
- cURL import
- OpenAPI/OAS version ingestion and `oasdiff` compatibility classification
- Prisma/Drizzle relation, foreign-key, enum, and index extraction
- Changed-file and commit metadata

### 0.3.2 — complete correction workflow

- Expand deterministic `number` → `UUID` checks beyond literal fetch payloads
- Produce an evidence bundle naming both source lines and the migration
- Generate the correction plan with confidence and risk
- Generate and execute the regression test
- Compare the fixed run with the original failure

### 0.4 — team alpha

- OAuth 2.1 resource-server metadata and production identity
- CI contract upload keyed by repository and Git commit SHA
- GitHub App review comments and check summaries
- Versioned dependency graph with branch-to-branch blast-radius checks
- Retention, audit log, and organization administration

Billing, hosted request execution, and private runners remain deferred until private-beta demand gates are met.
