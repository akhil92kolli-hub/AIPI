import assert from "node:assert/strict";
import { runPostIndexBootstrapper } from "../packages/core/post-index-bootstrapper.mjs";

const project = {
  id: "project_bootstrap_test",
  name: "Bootstrap fixture",
  updatedAt: "2026-10-15T10:00:00.000Z",
  activeEnvironmentId: "env_local",
  environments: [{ id: "env_local", name: "Local", variables: [{ key: "baseUrl", value: "http://localhost:3000", enabled: true }] }],
  requests: [], collections: [{ id: "col_legacy_root", name: "Root Workflow", origin: "auto-grouped", requestIds: ["legacy_root_request"] }], tasks: [], contextPacks: [], verificationReceipts: [], findings: [], evidence: [],
  sourceContext: {
    lastScannedAt: "2026-10-15T10:00:00.000Z",
    git: [{ commit: "abc123", dirty: false }],
    endpoints: [
      { id: "ep_register", method: "POST", path: "/webhook/keycloak/user-register", source: "main.py", line: 10 },
      { id: "ep_update", method: "PATCH", path: "/webhook/keycloak/user-update", source: "main.py", line: 20 },
      { id: "ep_delete", method: "DELETE", path: "/webhook/keycloak/user-delete", source: "main.py", line: 30 },
      { id: "ep_sync", method: "GET", path: "/sync/all-users", source: "main.py", line: 40 }
    ],
    integrations: [{ id: "integration_update", endpointId: "ep_update", status: "unused-backend", method: "PATCH", path: "/webhook/keycloak/user-update" }],
    findings: [{ id: "source_finding_update", integrationId: "integration_update", type: "contract-mismatch", title: "PATCH user update is mismatched", severity: "high" }],
    frontendCalls: [], schemas: [], artifacts: [], roots: [], frameworks: []
  }
};

const first = runPostIndexBootstrapper(project);
assert.equal(first.requests, 4);
assert.equal(project.requests.length, 4);
assert.equal(project.requests.find((entry) => entry.contractId === project.contracts.find((entry) => entry.route.includes("user-register")).id).body.provenance, "schema-derived");
assert.ok(project.requests.every((entry) => entry.baselineAssertions?.contractRevisionId), "generated requests retain a contract/schema baseline assertion reference");
assert.deepEqual(project.collections.find((entry) => entry.name === "Keycloak Webhook Lifecycle").requestIds.map((id) => project.requests.find((entry) => entry.id === id).method), ["POST", "PATCH", "DELETE"]);
assert.equal(project.collections.find((entry) => entry.name === "Keycloak Webhook Lifecycle").origin, "auto-grouped");
assert.equal(project.collections.some((entry) => entry.id === "col_legacy_root"), false, "legacy single-route auto-grouped collections are removed");
const smokeSuite = project.collections.find((entry) => entry.name === "Core Smoke & Single-Route Suite");
assert.ok(smokeSuite, "single-route workflows are consolidated into the core smoke suite");
assert.deepEqual(smokeSuite.requestIds.map((id) => project.requests.find((entry) => entry.id === id).url), ["{{baseUrl}}/sync/all-users"]);
assert.equal(project.collections.filter((entry) => entry.origin === "auto-grouped" && entry.requestIds.length === 1 && entry.name !== "Core Smoke & Single-Route Suite").length, 0, "no one-step auto-grouped cards remain");
assert.ok(project.tasks.some((entry) => entry.status === "proposed" && entry.title.includes("mismatched")));
const launchReadiness = project.tasks.find((entry) => entry.kind === "launch-readiness");
assert.ok(launchReadiness, "indexing creates an immediate Launch Readiness task");
assert.equal(launchReadiness.status, "active", "Launch Readiness is visible without manual triage");
assert.ok(launchReadiness.contractIds.length > 0 && launchReadiness.contractIds.length <= 3, "Launch Readiness contains at most the three highest-risk contracts");
assert.ok(project.contextPacks.find((entry) => entry.taskId === launchReadiness.id)?.artifactIds.length > 0, "Launch Readiness begins with bounded indexed artifacts");
assert.equal(project.findings.filter((entry) => entry.title === "PATCH user update is mismatched").length, 1, "source findings are enriched instead of duplicated");
assert.equal(project.verificationReceipts.filter((entry) => entry.type === "baseline-index").length, 1);

const counts = { requests: project.requests.length, collections: project.collections.length, tasks: project.tasks.length, findings: project.findings.length, receipts: project.verificationReceipts.length };
const second = runPostIndexBootstrapper(project);
assert.equal(second.changed, false, "same index snapshot is a no-op");
assert.deepEqual({ requests: project.requests.length, collections: project.collections.length, tasks: project.tasks.length, findings: project.findings.length, receipts: project.verificationReceipts.length }, counts, "re-index does not duplicate generated artifacts");

const teammate = {
  ...structuredClone(project), id: "project_bootstrap_teammate", requests: [], collections: [], tasks: [], contextPacks: [], verificationReceipts: [], findings: [], evidence: [], contracts: [], contractRevisions: [], knowledgeGraph: { nodes: [], edges: [] }
};
runPostIndexBootstrapper(teammate);
assert.deepEqual(teammate.requests.map((entry) => entry.id).sort(), project.requests.map((entry) => entry.id).sort(), "generated request identity is stable across teammate-local project IDs");
assert.deepEqual(teammate.collections.map((entry) => entry.id).sort(), project.collections.map((entry) => entry.id).sort(), "starter collection identity is repository-portable");
assert.deepEqual(teammate.tasks.map((entry) => entry.id).sort(), project.tasks.map((entry) => entry.id).sort(), "proposed task identity is repository-portable");
assert.equal(teammate.verificationReceipts[0].id, project.verificationReceipts[0].id, "baseline receipt identity is repository-portable");

const assetProject = structuredClone(project);
assetProject.id = "project_static_asset_test";
assetProject.sourceContext.endpoints = [{ id: "ep_config", method: "GET", path: "/config.js", source: "public/config.js", line: 1 }];
assetProject.sourceContext.integrations = [];
assetProject.sourceContext.findings = [];
assetProject.requests = [];
assetProject.collections = [];
assetProject.tasks = [];
assetProject.contextPacks = [];
assetProject.verificationReceipts = [];
assetProject.findings = [];
assetProject.evidence = [];
assetProject.contracts = [{
  ...structuredClone(project.contracts[0]),
  id: "contract_config_asset",
  method: "GET",
  route: "/config.js",
  sourceArtifactIds: ["ep_config"],
  sourceRequestIds: []
}];
assetProject.contractRevisions = [];
assetProject.knowledgeGraph = { nodes: [], edges: [] };
runPostIndexBootstrapper(assetProject);
assert.equal(assetProject.collections.length, 0, "static asset routes are excluded from generated workflow collections");

const noRoutesProject = {
  id: "project_no_routes_cleanup",
  collections: [{ id: "old_single", name: "Old Workflow", origin: "auto-grouped", requestIds: ["old_request"] }],
  sourceContext: { endpoints: [] }
};
const cleanupOnly = runPostIndexBootstrapper(noRoutesProject);
assert.equal(cleanupOnly.skipped, true);
assert.equal(cleanupOnly.changed, true, "cleanup is reported even when the current index has no routes");
assert.equal(noRoutesProject.collections.length, 0, "legacy singleton cleanup runs before the no-routes early return");

project.sourceContext.lastScannedAt = "2026-10-15T11:00:00.000Z";
project.sourceContext.git[0].commit = "def456";
project.sourceContext.endpoints = project.sourceContext.endpoints.filter((entry) => entry.id === "ep_sync");
project.sourceContext.integrations = [];
project.sourceContext.findings = [];
runPostIndexBootstrapper(project);
assert.ok(project.requests.filter((entry) => entry.method !== "GET").every((entry) => entry.staleAt), "removed routes mark generated requests stale");
assert.ok(project.collections.find((entry) => entry.name === "Keycloak Webhook Lifecycle").staleAt, "removed route groups mark collections stale");
assert.equal(project.verificationReceipts.filter((entry) => entry.type === "baseline-index").length, 2, "a new immutable baseline is emitted for a new revision");

console.log("Post-index bootstrapper tests passed");
