import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-knowledge-graph-route-"));
process.env.AIPI_DATA = path.join(temp, "data");
process.env.AIPI_PORT = "0";
process.env.AIPI_MAX_PORT = "0";
const { mutateState, loadState } = await import("../scripts/workspace-store.mjs");
const { startDashboard } = await import("../scripts/dashboard-server.mjs");
let dashboard;
try {
  await mutateState((state) => {
    state.projects = [{
      id: "graph-route-project", name: "Graph route test", requests: [], tasks: [], environments: [{ id: "dev", name: "Development", variables: [] }], activeEnvironmentId: "dev",
      sourceContext: {
        roots: [{ kind: "workspace", path: temp }], gitRevision: "graph123", lastScannedAt: "2026-10-16T00:00:00.000Z", git: [],
        endpoints: [
          { id: "endpoint_users", method: "GET", path: "/api/users", source: "server/users.ts", line: 8 },
          { id: "endpoint_webhook", method: "POST", path: "/webhook/events", source: "server/webhook.ts", line: 4 }
        ],
        frontendCalls: [
          { id: "caller_users", method: "GET", path: "/api/users", source: "ui/users.ts", line: 3 },
          { id: "caller_dynamic", method: "GET", path: "/api/${resource}", source: "ui/client.ts", line: 5, resolution: "dynamic-template" }
        ],
        integrations: [{ id: "integration_users", callId: "caller_users", endpointId: "endpoint_users", method: "GET", path: "/api/users", status: "healthy", confidence: .9 }],
        schemas: [{ id: "schema_users", endpointId: "endpoint_users", name: "User", source: "server/schema.ts", fields: [] }], artifacts: []
      }
    }];
    state.activeProjectId = "graph-route-project";
  });
  await mutateState((state) => {
    state.projects[0].tasks.push({ id: "manual-discovery", title: "Discover and test APIs", description: "Map the unverified API surface", status: "active", contractIds: [], artifactIds: [], verificationReceiptIds: [] });
  });
  dashboard = await startDashboard({ executeRequest: async () => ({ ok: true, passed: true, status: 200, headers: {}, body: "{}", json: {} }) });
  const headers = { authorization: `Bearer ${dashboard.token}`, "content-type": "application/json" };

  const graphResponse = await fetch(`${dashboard.url}/api/projects/graph-route-project/graph`, { headers });
  assert.equal(graphResponse.status, 200);
  const graphPayload = await graphResponse.json();
  assert.ok(graphPayload.summary.nodes > 0);
  const missingCaller = graphPayload.blindSpots.find((spot) => spot.type === "route-missing-caller" && spot.nodeId === "endpoint_webhook");
  assert.ok(missingCaller);

  const routeContract = graphPayload.graph.nodes.find((node) => node.type === "contract" && node.route === "/api/users");
  const traversalResponse = await fetch(`${dashboard.url}/api/projects/graph-route-project/graph/traverse?nodeId=${encodeURIComponent(routeContract.id)}&direction=downstream&depth=2`, { headers });
  assert.equal(traversalResponse.status, 200);
  assert.equal((await traversalResponse.json()).focusNode.id, routeContract.id);

  const discoveryResponse = await fetch(`${dashboard.url}/api/projects/graph-route-project/tasks/manual-discovery/prepare-context`, { method: "POST", headers, body: JSON.stringify({ tokenBudget: 2400, level: "working" }) });
  assert.equal(discoveryResponse.status, 200);
  const discovery = await discoveryResponse.json();
  assert.ok(discovery.task.contractIds.length > 0);
  assert.ok(discovery.task.artifactIds.length > 0);
  assert.equal(discovery.task.contextStatus, "current");
  assert.equal(discovery.task.acceptanceCriteria.length, 3);
  assert.ok(discovery.contextPack.sourceFingerprint);
  assert.ok(discovery.task.verificationPlan?.targetSnapshotHash);

  const confirmResponse = await fetch(`${dashboard.url}/api/projects/graph-route-project/graph/edges/confirm`, {
    method: "POST", headers, body: JSON.stringify({ blindSpotId: missingCaller.id, fromNodeId: "caller_dynamic", toNodeId: "endpoint_webhook", type: "CALLS" })
  });
  assert.equal(confirmResponse.status, 200);
  const confirmed = await confirmResponse.json();
  assert.equal(confirmed.edge.provenance, "manual");
  assert.equal(confirmed.edge.confidence, 1);

  const memory = JSON.parse(await fs.readFile(path.join(temp, ".aipi", "team-memory.json"), "utf8"));
  assert.ok(memory.pinnedEdges.some((edge) => edge.fromNodeId === "caller_dynamic" && edge.toNodeId === "endpoint_webhook"));
  const reloaded = (await loadState()).projects[0];
  assert.ok(reloaded.tasks.find((task) => task.id === "manual-discovery").contractIds.length > 0);

  const mapRedirect = await fetch(`${dashboard.url}/projects/graph-route-project/map`, { redirect: "manual" });
  assert.equal(mapRedirect.headers.get("location"), "/projects/graph-route-project/kmaps?view=chains");
  const runsRedirect = await fetch(`${dashboard.url}/projects/graph-route-project/runs`, { redirect: "manual" });
  assert.equal(runsRedirect.headers.get("location"), "/projects/graph-route-project/kmaps?view=records");
  console.log("Knowledge graph HTTP routes, discovery, and team-memory pinning passed");
} finally {
  if (dashboard) await new Promise((resolve) => dashboard.server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
