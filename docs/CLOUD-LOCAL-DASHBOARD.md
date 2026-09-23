# Cloud-rendered dashboard with local AIPI execution

## Product boundary

AIPI separates presentation from privileged execution:

```text
Cloudflare-hosted dashboard shell
  └─ browser fetch to http://127.0.0.1:49152
       └─ AIPI Local Companion
            ├─ project evidence timeline
            ├─ API execution and traffic capture
            ├─ source, schema, and Git analysis
            ├─ OS credential vault
            └─ stdio MCP server ↔ Codex / AI editor
```

The Cloudflare application serves static HTML, CSS, and JavaScript. Source code, request credentials, response bodies, private network access, and the authoritative project timeline stay on the developer's machine. The hosted shell is replaceable; the local companion is the data and execution authority.

## Direct loopback release

The current release intentionally uses a direct browser-to-loopback connection:

1. `aipi open` starts the companion on `127.0.0.1:49152` or the next configured port.
2. The companion generates an ephemeral `sec_...` bearer token.
3. The CLI opens `https://app.aipi.dev?port=49152&token=...`.
4. The dashboard uses the supplied port and token for authenticated loopback requests.
5. The companion accepts only the configured dashboard origin or a local development origin, responds to Private Network Access preflights, and never binds to a public interface.

The token is held in browser session storage, is not written to project data, and expires when the companion process exits. Every `/api/*` route except `/api/connection` requires the token.

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

Install AIPI from its plugin marketplace entry, then start a new Codex task. The plugin starts the bundled local MCP process over stdio. Use `open_dashboard` to render the side-panel UI and AIPI MCP tools for analysis.

### CLI and other MCP editors

```bash
npm install --global @akhil92kolli-hub/aipi-companion
aipi open
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

During local dashboard development, use `aipi dev --app http://localhost:8788/dashboard/`. Production uses `aipi open --app https://app.aipi.dev/dashboard/`.

## Cloudflare deployment

The showcase build copies the dashboard shell into `dist/client/dashboard/` and deploys static assets plus the Hono Worker. Cloudflare must never proxy local request payloads or receive the loopback bearer token. Configure the companion's `AIPI_APP_ORIGIN` to the exact production dashboard origin.

## Next bridge phase

Direct loopback is the lowest-overhead release and works without a cloud account. An outbound bridge is a later opt-in mode for browsers that cannot reach localhost or organizations that need remote sessions:

1. The companion opens an authenticated outbound WebSocket to a Cloudflare Durable Object.
2. The dashboard joins a short-lived, user-approved pairing session.
3. The Durable Object relays typed AIPI protocol messages—not arbitrary shell commands.
4. Local policy approves each capability and redacts evidence before any optional upload.
5. Durable Objects keep only ephemeral routing state; durable team evidence goes to the schema registry with explicit retention and deletion controls.

The bridge does not replace local MCP. Codex and the IDE continue using stdio locally, preserving zero cloud overhead for normal agent work.
