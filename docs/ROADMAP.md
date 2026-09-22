# API Forge development roadmap

This document tracks implementation against the comprehensive product plan. The current Codex plugin remains a working prototype while portable packages are extracted behind it.

## Current milestone: 0.3 foundation

Implemented:

- Local HTTP execution, assertions, variables, authentication, certificates, bounded capture, retry, and history
- OpenAPI import and local source scanning
- Next.js, Express, Supabase Edge Function, FastAPI, fetch, Axios, and SQL-table recognition
- Frontend-to-backend route matching with source locations and confidence
- Mobile inspection dashboard with Project, APIs, Integration Map, Runs, and Summary routes
- Native Codex chat handoff through the MCP Apps bridge
- Shared redaction, route normalization, run comparison, and fix-plan logic
- Repository-native `.api-forge` JSON format with secret omission
- CLI export and inspection commands
- Endpoint evidence, integration issues, run evidence, run comparison, fix planning, verification, and project export MCP tools
- Native Vitest/Jest regression-test generation without overwrite
- Next.js contract-mismatch fixture

In progress for 0.3:

- Move the HTTP runner fully out of the prototype server into the shared runner package
- Add cURL and Postman import
- Add multipart and binary bodies
- Add encrypted OS-backed secret storage
- Track Git revisions and changed-since-verification status
- Replace pattern matching with narrow AST adapters for Next.js, Express, and Supabase
- Extract validation types and compare request/response/schema contracts

## Next milestone slices

### 0.3.1 — deterministic contracts

- Versioned JSON Schema for project, environment, request, workflow, and run evidence files
- Import/export round-trip tests
- cURL import
- Contract extraction from Zod and TypeScript types
- Changed-file and commit metadata

### 0.3.2 — complete wedge workflow

- Detect the fixture's `number` → `UUID` mismatch deterministically
- Produce an evidence bundle naming both source lines and the migration
- Generate the correction plan with confidence and risk
- Generate and execute the regression test
- Compare the fixed run with the original failure

### 0.4 — VS Code alpha

- Activity Bar container and project overview
- Environment and collection trees
- Request editor and response panel
- Source navigation from Integration Map evidence
- Commands backed by the shared CLI/core

Cloud, team collaboration, billing, hosted requests, and private runners remain deferred until private-beta demand gates are met.
