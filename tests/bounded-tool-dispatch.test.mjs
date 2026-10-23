import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-bounded-tools-"));
process.env.AIPI_DATA = temp;
process.env.AIPI_PORT = "0";
process.env.AIPI_MAX_PORT = "0";

const { defaultProject, mutateState } = await import("../scripts/workspace-store.mjs");
const { BOUNDED_MCP_TOOL_DEFINITIONS, callToolWithTelemetry, tools } = await import("../scripts/api-forge-server.mjs");
const { startDashboard } = await import("../scripts/dashboard-server.mjs");
let dashboard;

try {
  const project = defaultProject("Bounded tools test");
  project.sourceContext.artifacts = [{ id: "source_handler", kind: "component", source: "src/handler.ts", root: temp, line: 8 }];
  project.tasks = [{ id: "task_context", title: "Inspect task context", description: "", status: "planned", artifactIds: ["component:source_handler"], requestIds: [], findingIds: [] }];
  project.contracts = [{ id: "contract_health", method: "GET", route: "/health", sourceRequestIds: [], currentRevisionId: "revision_test" }];
  await mutateState((state) => {
    state.projects = [project];
    state.activeProjectId = project.id;
  });

  const expectedTools = ["get_context_pack_manifest", "get_contract_kmap", "verify_contract_revision", "search_knowledge_graph", "traverse_upstream", "traverse_downstream", "find_graph_blind_spots", "start_task_check_job", "get_task_check_job", "cancel_task_check_job"];
  assert.ok(expectedTools.every((name) => tools.some((tool) => tool.name === name)), "bounded tools are registered in the MCP tool list");
  assert.ok(expectedTools.every((name) => BOUNDED_MCP_TOOL_DEFINITIONS.some((tool) => tool.name === name)), "bounded tools are available from the bounded definition registry");

  dashboard = await startDashboard({ callTool: callToolWithTelemetry });
  const endpoint = `http://127.0.0.1:${dashboard.port}/api/tools/call`;
  const headers = { authorization: `Bearer ${dashboard.token}`, "content-type": "application/json" };
  const call = async (payload) => {
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    return response.json();
  };

  const context = await call({ name: "get_context_pack_manifest", arguments: { project_id: project.id, task_id: "task_context" } });
  assert.equal(context.isError, false);
  assert.equal(context.structuredContent.manifest.task.id, "task_context");
  assert.equal(context.structuredContent.manifest.artifacts[0].root, temp, "bounded context preserves roots needed by IDE source links");

  const graphSearch = await call({ name: "search_knowledge_graph", arguments: { project_id: project.id, query: "Inspect task" } });
  assert.equal(graphSearch.isError, false);
  assert.ok(graphSearch.structuredContent.nodes.some((node) => node.id === "task_context"));

  const blindSpots = await call({ name: "find_graph_blind_spots", arguments: { project_id: project.id } });
  assert.equal(blindSpots.isError, false);
  assert.ok(Array.isArray(blindSpots.structuredContent.blindSpots));

  const kmap = await call({ tool: "get_contract_kmap", args: { project_id: project.id, contract_id: "contract_health" } });
  assert.equal(kmap.isError, true);
  assert.equal(kmap.structuredContent.error, "Contract not found", "the endpoint accepts the tool alias and reaches contract lookup rather than the unknown-tool fallback");

  const verify = await call({ name: "verify_contract_revision", arguments: { project_id: project.id, contract_id: "contract_health" } });
  assert.equal(verify.isError, true);
  assert.equal(verify.structuredContent.error, "Contract not found", "verification dispatch reaches contract lookup rather than the unknown-tool fallback");

  console.log("Bounded MCP tool definitions and dashboard dispatch passed");
} finally {
  if (dashboard) await new Promise((resolve) => dashboard.server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
