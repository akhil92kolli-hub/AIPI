# AI-PI

AIPI (AI-Programming Interface) is the product showcase: from failing API to verified code fix.

## Operating model

The public website and dashboard shell are hosted on Cloudflare. The API intelligence engine remains local:

```text
Cloudflare website/dashboard
          │ optional paired session
          ▼
Local AIPI Companion ── local MCP ── Codex / IDE
          ├── source scanning
          ├── API execution
          └── logs and evidence
```

Install the companion and connect an IDE from the [installation guide](/install.html). Local-only use does not require an account or cloud connection.

## Build

```bash
npm run build
```

The production site is generated in `dist/client`, with the Worker entry point at `dist/server/index.js`.
The local dashboard shell is also bundled at `dist/client/dashboard/` and is available at `/dashboard/`. It connects to a running local companion using the `port` and `token` query parameters.

## Cloudflare Workers

Use these Git build settings:

- Build command: `npm run build`
- Deploy command: `npm run deploy`
- Root directory: `/`

The deploy script explicitly selects `wrangler.jsonc` and disables auto-configuration.
That configuration restricts static assets to `dist/client`. Do not add
`--assets .` to the deploy command: it uploads the repository root and can include
large dependency binaries such as `node_modules/workerd/bin/workerd`.
