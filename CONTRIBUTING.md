# Contributing to API Forge

API Forge intentionally has no runtime package dependencies. Use Node.js 18 or later.

## Local development

```bash
npm run validate
npm test
npm run dashboard
```

The dashboard listens only on `127.0.0.1`. Set `API_FORGE_PORT` to use another port and `API_FORGE_DATA` to isolate workspace data.

## Pull requests

- Keep the MCP tools useful without the dashboard.
- Add or extend the end-to-end self-test for behavior changes.
- Do not commit API keys, certificates, request history, or workspace data.
- Treat POST, PUT, PATCH, and DELETE test requests as potentially destructive.
- Keep response capture bounded and redact credential-bearing headers and variables.

## Publishing

Validate the plugin manifest, run the self-test, and test installation in a clean Codex task before submitting a release. Public distribution should use a hosted MCP server and the portable MCP Apps UI standard; the bundled loopback dashboard is intended for local Codex development.
