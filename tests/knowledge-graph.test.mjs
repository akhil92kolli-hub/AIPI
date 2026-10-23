import assert from "node:assert/strict";
import { buildProjectKnowledgeGraph, discoverTaskContext, findGraphBlindSpots, promoteRuntimeEdge, traverseKnowledgeGraph } from "../packages/core/knowledge-graph.mjs";

const project = {
  id: "graph_project",
  sourceContext: {
    gitRevision: "abc123", lastScannedAt: "2026-10-16T00:00:00.000Z",
    endpoints: [
      { id: "endpoint_users", method: "POST", path: "/api/users", source: "server/users.ts", line: 20, confidence: 1 },
      { id: "endpoint_webhook", method: "POST", path: "/webhook/events", source: "server/webhook.ts", line: 8, confidence: 1 }
    ],
    frontendCalls: [
      { id: "caller_users", method: "POST", path: "/api/users", source: "ui/users.ts", line: 12, confidence: .8 },
      { id: "caller_dynamic", method: "GET", path: "/api/${resource}", source: "ui/client.ts", line: 3, resolution: "dynamic-template", confidence: .5 }
    ],
    integrations: [{ id: "integration_users", callId: "caller_users", endpointId: "endpoint_users", method: "POST", path: "/api/users", status: "healthy", confidence: .8 }],
    schemas: [{ id: "schema_users", endpointId: "endpoint_users", name: "User", source: "server/user-schema.ts", fields: [{ name: "id", type: "string" }] }],
    artifacts: [{ id: "test_users", kind: "test", endpointId: "endpoint_users", name: "users API test", source: "tests/users.test.ts" }]
  },
  contracts: [
    { id: "contract_users", method: "POST", route: "/api/users", currentRevisionId: "rev_users", sourceArtifactIds: ["endpoint_users"], implementation: { source: "server/users.ts" }, state: "Mismatched" },
    { id: "contract_webhook", method: "POST", route: "/webhook/events", currentRevisionId: "rev_webhook", sourceArtifactIds: ["endpoint_webhook"], implementation: { source: "server/webhook.ts" } }
  ],
  findings: [{ id: "finding_webhook_test", contractId: "contract_webhook", type: "untested-critical-route", title: "POST /webhook/events has no indexed test", status: "open" }],
  tasks: [{ id: "task_discovery", title: "Discover and test APIs", description: "", contractIds: [], artifactIds: [] }],
  evidence: [{ id: "evidence_users", contractId: "contract_users", type: "api-execution", sourceRevision: "abc123", origin: "verification-runner", recordedAt: "2026-10-16T00:00:00.000Z" }],
  verificationReceipts: [{ id: "receipt_users", contractId: "contract_users", result: "Verified", sourceRevision: "abc123", verifiedAt: "2026-10-16T00:00:00.000Z" }]
};

const pinned = { id: "edge_manual_dynamic", fromNodeId: "caller_dynamic", toNodeId: "endpoint_users", type: "CALLS", sourceRevision: "abc123" };
const graph = buildProjectKnowledgeGraph(project, { pinnedEdges: [pinned] });
assert.equal(graph.version, 1);
assert.ok(graph.nodes.some((node) => node.type === "handler"));
assert.ok(graph.nodes.some((node) => node.type === "receipt"));
assert.ok(graph.edges.some((edge) => edge.type === "CALLS" && edge.provenance === "manual-declaration" && edge.confidence === 0 && edge.confirmationState === "pending"));
assert.ok(!graph.edges.some((edge) => edge.type === "VERIFIED_BY" && edge.toNodeId === "receipt_users"), "receipt labels do not create verified graph edges");
assert.ok(graph.edges.some((edge) => edge.type === "TESTED_BY" && edge.fromNodeId === "contract_users"));

const blindSpots = findGraphBlindSpots(project);
assert.ok(blindSpots.some((spot) => spot.type === "route-missing-caller" && spot.nodeId === "endpoint_webhook"));
assert.ok(blindSpots.some((spot) => spot.type === "contract-missing-test" && spot.contractId === "contract_webhook"));
assert.ok(blindSpots.some((spot) => spot.type === "caller-missing-route" && spot.nodeId === "caller_dynamic"), "manual declaration does not establish an observed caller");

const traversal = traverseKnowledgeGraph(project, { nodeId: "contract_users", direction: "downstream", depth: 2 });
assert.equal(traversal.focusNode.id, "contract_users");
assert.ok(traversal.downstreamNodes.some((node) => node.type === "handler"));
assert.ok(traversal.impactRadiusCount >= 3);

const promoted = promoteRuntimeEdge(project, { contractId: "contract_webhook", handlerFile: "server/webhook.ts", testFile: "tests/webhook.runtime.test.ts", gitRevision: "abc123" });
assert.ok(promoted.every((edge) => edge.provenance === "runtime" && edge.confidence === 1 && edge.stale === false));
assert.ok(!findGraphBlindSpots(project).some((spot) => spot.type === "contract-missing-test" && spot.contractId === "contract_webhook"));

const discovery = discoverTaskContext(project, project.tasks[0]);
assert.ok(discovery.task.contractIds.length > 0 && discovery.task.contractIds.length <= 3);
assert.ok(discovery.task.affectedChainIds.length > 0);
assert.equal(discovery.task.contextStatus, "current");
assert.ok(discovery.contextPack.estimatedTokens <= 2400);

console.log("Knowledge graph, traversal, runtime promotion, and task discovery tests passed");
