---
name: aipi-ide
description: Use AIPI inside Codex for local API engineering, persistent task context, bounded agent handoffs, test planning, and verification proof.
---

# AIPI in Codex

AIPI is a local-first IDE extension for Codex. Codex remains responsible for planning and editing repository files; AIPI's local MCP server supplies indexed context, API evidence, saved task state, and verification results.

## Install and connect

- Install AIPI from the repository's local plugin marketplace or add the companion MCP server to a project with `npx --yes --package=@vmise/aipi-companion@latest -- aipi init`.
- Run Codex as a desktop/local executor with Node.js 22 or newer. The bundled plugin MCP server runs locally over stdio; it does not call the hosted AIPI MCP endpoint.
- For a shared workspace with the VS Code extension or AIPI CLI, use the companion setup command. It starts or reuses the loopback companion at `127.0.0.1`, registers the open repository, and writes a project-local Codex MCP entry. The MCP stdio process relays to that companion and uses the same `~/.api-forge` workspace.
- Trust the repository in Codex and start a new task after enabling the plugin or MCP server.

## Work loop

1. Call `open_dashboard` when the user wants the AIPI side panel; otherwise use MCP tools directly.
2. Identify the active AIPI project and task. If a task does not exist, use the dashboard's task flow; do not invent IDs.
3. Call `discover_task_context` before proposing implementation. It searches the local index and knowledge map, then stores bounded evidence on the task.
4. Call `prepare_task_handoff` to persist a cited, token-bounded packet and the post-edit verification plan. Report that it is ready for the user or coding agent; do not imply Codex started another agent unless an explicit handoff mechanism did so.
5. Make repository changes only in response to the user's request. Use the saved plan to run the relevant tests, then call `review_and_run_task_verification` to record revision-bound evidence. State-changing API replays require explicit user authorization.
6. Use `propose_tasks_from_context` to create AI-generated task proposals only when asked. Proposals cite indexed artifacts and await developer review; they do not edit files or execute checks.

## Boundaries

- Keep repository source, request bodies, logs, and credentials on the local machine. The optional cloud contract registry is separate and receives only the metadata its tools are designed to publish.
- Distinguish static/indexed evidence from runtime observations, and call out stale or missing context.
- Never report a check as passed unless the local tool or test output confirms it. Explain skipped checks and missing prerequisites.
