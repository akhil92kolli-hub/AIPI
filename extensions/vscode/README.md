# AIPI - API Intelligence for VS Code and Cursor

AIPI's IDE extension embeds the same local-first workspace application as the AIPI web dashboard. It adapts responsively to a narrow sidebar and can also open as a wide editor tab.

## What works

- Binds automatically to the workspace containing the active editor.
- Starts the bundled local companion automatically when needed; the **Install & start companion** action retries setup without requiring terminal commands.
- Restarts a missing or stale companion connection through the companion's shared startup lock, so multiple IDE windows reuse the same local process.
- Supports concurrent IDE windows and multi-root workspaces through idempotent workspace registration against the shared local companion.
- Refreshes the current panel in place instead of reloading the entire webview.
- Registers or scans only that workspace through the authenticated loopback companion.
- Provides the full project Home, project settings, environments, source management, task and milestone creation/editing, K Maps, contract evidence, saved requests, MCP tools and index coverage UI.
- Uses the dashboard's shared JavaScript, styles and visual assets so the browser and IDE experiences stay compatible as the product evolves.
- Runs the three-stage flow: discover task context, prepare and send the bounded handoff, then review and execute the verification plan.
- Opens K Map source references at the indexed file and line in the IDE editor.
- Persists the task handoff in AIPI, writes it to `.aipi/active-context.md`, copies it, and opens up to three referenced source files.
- Opens the supported VS Code or Cursor coding-agent chat so the agent can edit files and call AIPI MCP tools.
- Requires `verify_contract_revision` after edits and a matching verified receipt before `complete_handoff` can close contract-linked work.
- Keeps the prepared prompt on disk and on the clipboard when an IDE chat command is unavailable.
- Rejects source navigation, state updates and task operations outside the current workspace/project.
- Keeps the daemon token in the extension host; it never enters webview HTML or messages.

The extension does not perform cloud synchronization itself. Run **AIPI: Share Current Workspace with Team**, or click **Upgrade to Team**, to open a short-lived, project-scoped browser handoff. Sign in there, choose an organization and destination workspace, review the task preview, and connect the bundled companion to Team Cloud. After pairing, task title/status edits sync from the local companion; source code stays local by default. An older running companion must be stopped before this action can continue; the extension will not replace a busy process.

For local companion development, set `aipi.companion.launchCommand` in VS Code's user settings to an array such as `["/usr/local/bin/node", "/path/to/AiPI/scripts/aipi-cli-bundle.mjs", "daemon"]`. A direct `daemon` command stays running; other launchers must exit after starting the companion. Repository workspace settings cannot supply this command. Set `aipi.companion.autoStart` to `false` to manage the companion yourself. The AIPI Companion output shows the descriptor's address and PID, without its token. A timeout or uncertain connection does not trigger a replacement.

These safeguards apply only to updated AIPI clients. Older installed extensions or MCP launchers may still start older companions that do not coordinate writes; do not use mixed versions with the same workspace data. Restarting or upgrading existing services is a separate operational step.

For an isolated development instance, start the VS Code extension host and local CLI with matching `AIPI_CONNECTION_FILE` and `AIPI_DATA` environment variables pointing to a separate descriptor and data directory. Configure the test MCP server with the same variables. Isolation protects the normal workspace only if every test process uses these separate paths; it does not make old and new writers safe when pointed at the same data.

## Run from source

1. Use Node.js 22 or newer.
2. In this directory, run `npm install` and `npm run build`.
3. Open `extensions/vscode` in VS Code or Cursor and press F5 with **Run AIPI extension** selected.
4. Open a local project folder in the Extension Development Host.
5. Select the AIPI activity-bar icon. The extension starts its bundled companion on first use; Node.js 22 or newer must be available on `PATH`.

You can move the AIPI view to the secondary sidebar through the IDE's normal **Move View** action. Use **AIPI: Open Workspace in Editor** for a wide editor-tab layout.
All full-workspace actions stay inside the native webview panel; the extension does not expose or navigate to the companion's loopback URL.

## Package

Run `npm run package`. The build refreshes the bundled companion from this source tree and writes the installable VSIX to `dist/aipi.vsix`. Version 0.3.10 includes companion 0.4.7.

To publish to the Visual Studio Marketplace, the `vmise` publisher must be authorized and logged in locally with `npx vsce login vmise`; then run `npx vsce publish --packagePath dist/aipi.vsix`. Never put a publisher token in the repository or chat.

## Message-passing bridge

The shared dashboard webview and extension host communicate through the scoped `aipi.ide.v1` bridge:

- `request` / `response` for scoped commands and companion operations;
- `event` for workspace, editor, source-freshness and refresh changes;
- `stream` for handoff lifecycle phases and completion state.

The webview has no network permission. All companion traffic, source access, clipboard access, companion setup and coding-agent chat dispatch run in the trusted extension host.

## Security boundaries

- Workspace Trust and a local `file:` workspace are required.
- Source paths are resolved through `realpath` and must remain inside the bound workspace.
- `.aipi/active-context.md` cannot be a symlink or escape the `.aipi` directory.
- Companion routes and MCP tools use explicit allowlists.
- Project state responses remain scoped to the active IDE workspace; protected credential values never return from the companion.
- The side panel does not silently execute state-changing API requests.
