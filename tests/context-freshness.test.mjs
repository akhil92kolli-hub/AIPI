import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { refreshAndPrepareTaskContext } from "../packages/core/context-freshness.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-context-freshness-"));
try {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/users.ts"), "export function users() { return []; }\n");
  const project = {
    id: "freshness-project", requests: [{ id: "request-users", contractId: "contract-users", method: "GET", url: "{{baseUrl}}/api/users" }],
    contextPacks: [], findings: [{ id: "finding-users", contractId: "contract-users", type: "untested-critical-route", status: "open", title: "GET /api/users has no indexed test" }], evidence: [], verificationReceipts: [],
    contracts: [{ id: "contract-users", method: "GET", route: "/api/users", state: "Untested", currentRevisionId: "contract-rev-1", latestVerificationReceiptId: "receipt-old", sourceArtifactIds: ["endpoint-users"], implementation: { source: "src/users.ts", line: 1 }, sourceRequestIds: ["request-users"] }],
    tasks: [{ id: "manual-task", title: "Discover and test APIs", description: "", contractIds: [], artifactIds: [], acceptanceCriteria: [], verificationReceiptIds: ["receipt-old"] }],
    sourceContext: { roots: [{ kind: "workspace", path: root }], gitRevision: "git-rev-1", lastScannedAt: "2026-10-16T00:00:00.000Z", git: [{ root, commit: "git-rev-1", dirty: false }], endpoints: [{ id: "endpoint-users", method: "GET", path: "/api/users", source: "src/users.ts", root, line: 1 }], frontendCalls: [], integrations: [], schemas: [], artifacts: [] }
  };
  const first = await refreshAndPrepareTaskContext(project, project.tasks[0]);
  assert.deepEqual(project.tasks[0].contractIds, ["contract-users"]);
  assert.ok(project.tasks[0].artifactIds.includes("endpoint:endpoint-users"));
  assert.ok(project.tasks[0].requestIds.includes("request-users"));
  assert.ok(project.tasks[0].findingIds.includes("finding-users"));
  assert.equal(project.tasks[0].acceptanceCriteria.length, 3);
  assert.equal(first.contextPack.freshness.status, "current");
  assert.equal(first.contextPack.generation, 1);
  const firstContextId = first.contextPack.id;
  assert.equal(project.tasks[0].contextPackId, firstContextId);
  assert.ok(first.contextPack.estimatedTokens > 0 && first.contextPack.estimatedTokens <= 2400);
  assert.ok(first.plan.steps.length >= 2);

  const endpointOnlyProject = structuredClone(project);
  endpointOnlyProject.contracts = [];
  endpointOnlyProject.requests = [];
  endpointOnlyProject.findings = [];
  endpointOnlyProject.contextPacks = [];
  endpointOnlyProject.tasks = [{ id: "endpoint-only-task", title: "Review GET /api/users", contractIds: [], artifactIds: [], acceptanceCriteria: [] }];
  const synthesized = await refreshAndPrepareTaskContext(endpointOnlyProject, endpointOnlyProject.tasks[0]);
  assert.equal(endpointOnlyProject.contracts.length, 1);
  assert.equal(endpointOnlyProject.contracts[0].route, "/api/users");
  assert.match(endpointOnlyProject.contracts[0].currentRevisionId, /^revision_[a-f0-9]{20}$/);
  assert.equal(synthesized.contextPack.freshness.status, "current");

  await fs.writeFile(path.join(root, "src/users.ts"), "export function users() { return [{ id: 'changed' }]; }\n");
  project.sourceContext.gitRevision = "git-rev-2";
  project.sourceContext.git[0].commit = "git-rev-2";
  const refreshed = await refreshAndPrepareTaskContext(project, project.tasks[0]);
  assert.deepEqual(refreshed.contextPack.changedArtifactIds, ["endpoint:endpoint-users"]);
  assert.ok(project.tasks[0].staleVerificationReceiptIds.includes("receipt-old"));
  assert.equal(project.contracts[0].state, "Stale");
  assert.equal(project.tasks[0].contextStatus, "current");
  assert.equal(refreshed.contextPack.gitRevision, "git-rev-2");
  assert.equal(refreshed.contextPack.generation, 2);
  assert.notEqual(refreshed.contextPack.id, firstContextId, "refresh creates a new immutable context generation");
  assert.equal(project.contextPacks.length, 2, "prior context remains persisted for existing handoffs");
  assert.equal(project.contextPacks.find((entry) => entry.id === firstContextId).supersededBy, refreshed.contextPack.id);
  console.log("Context auto-linking, freshness refresh, criteria synthesis, and receipt staleness passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
