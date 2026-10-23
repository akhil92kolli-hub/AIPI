import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTaskVerificationPlan, executeTaskVerificationPlan } from "../packages/core/verification-runner.mjs";
import { hydrateAndBootstrapProject } from "../scripts/workspace-store.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-verification-"));
const project = {
  id: "project_test", name: "Verification test", activeEnvironmentId: "env_dev",
  environments: [{ id: "env_dev", name: "Development", variables: [{ key: "baseUrl", value: "https://api.example.test", enabled: true }] }],
  sourceContext: { roots: [{ kind: "workspace", path: root }], gitRevision: "abc123", endpoints: [], integrations: [], schemas: [{ id: "schema_get", fields: [] }, { id: "schema_post", fields: [] }], findings: [], git: [] },
  contracts: [
    { id: "contract_get", method: "GET", route: "/health", currentRevisionId: "rev_get", sourceRequestIds: ["request_get"], schemaIds: ["schema_get"] },
    { id: "contract_post", method: "POST", route: "/users", currentRevisionId: "rev_post", sourceRequestIds: ["request_post"], schemaIds: ["schema_post"] }
  ],
  requests: [
    { id: "request_get", contractId: "contract_get", method: "GET", url: "{{baseUrl}}/health", headers: [{ key: "Authorization", value: "Bearer secret" }], body: { type: "json", content: "" } },
    { id: "request_post", contractId: "contract_post", method: "POST", url: "{{baseUrl}}/users", headers: [{ key: "X-API-Key", value: "secret" }], body: { type: "json", content: "{}" } }
  ],
  findings: [], evidence: [], verificationReceipts: [], collections: [], tasks: []
};
const task = { id: "task_test", contractIds: ["contract_get", "contract_post"], verificationReceiptIds: [] };
project.tasks.push(task);

const firstPlan = ensureTaskVerificationPlan(project, task);
const secondPlan = ensureTaskVerificationPlan(project, task);
assert.equal(firstPlan.targetSnapshotHash, secondPlan.targetSnapshotHash);
assert.deepEqual(firstPlan.contractRevisionIds, ["rev_get", "rev_post"]);
assert.equal(firstPlan.environmentFingerprint.length, 64);
assert.deepEqual(firstPlan.stepIds, [
  "verify:contract_get:api-replay", "verify:contract_get:contract-diff",
  "verify:contract_post:api-replay", "verify:contract_post:contract-diff"
]);
assert.equal(firstPlan.steps[2].requiresStateChangeApproval, true);

const executeApiReplay = async (request) => ({
  ok: true, passed: true, status: 200,
  request: { url: request.url, headers: { Authorization: "Bearer secret", Cookie: "session=secret" }, body: request.body?.content },
  headers: { "Set-Cookie": "session=secret", "X-API-Key": "secret", "Content-Type": "application/json" },
  body: "x".repeat(5000), json: {}
});

const pending = await executeTaskVerificationPlan(project, task, { executeApiReplay });
assert.equal(pending.receipt.result, "Verification pending");
assert.match(pending.checkResults.find((entry) => entry.stepId === "verify:contract_post:api-replay").reason, /matching the frozen snapshot hash/);
assert.equal(project.contracts[0].state, "Verification pending");
const runtimeEvidence = project.evidence.find((entry) => entry.type === "api-execution");
assert.equal(runtimeEvidence.requestSnapshot.headers.Authorization, "[REDACTED]");
assert.equal(runtimeEvidence.responseSnapshot.headers["Set-Cookie"], "[REDACTED]");
assert.equal(runtimeEvidence.responseSnapshot.bodyPreview.length, 4096);
assert.deepEqual(runtimeEvidence.redactionManifest.redactedKeys, ["Authorization", "Cookie", "Set-Cookie", "X-API-Key"]);

const mismatchedApproval = await executeTaskVerificationPlan(project, task, { allowStateChangingReplay: true, targetSnapshotHash: "sha256:not-the-frozen-snapshot", executeApiReplay });
assert.equal(mismatchedApproval.receipt.result, "Verification pending", "authorization is bound to the exact frozen snapshot hash");

const verified = await executeTaskVerificationPlan(project, task, { allowStateChangingReplay: true, targetSnapshotHash: firstPlan.targetSnapshotHash, executeApiReplay });
assert.equal(verified.receipt.result, "Verified");
assert.equal(project.contracts[0].state, "Verified");
assert.equal(project.contracts[0].latestVerificationReceiptId, verified.receipt.id);
assert.equal(project.verificationReceipts[0].id, verified.receipt.id);
assert.equal(task.verificationReceiptIds[0], verified.receipt.id);
const memory = JSON.parse(await fs.readFile(path.join(root, ".aipi", "team-memory.json"), "utf8"));
assert.equal(memory.verificationReceipts[0].id, verified.receipt.id);

const testTask = { id: "task_with_tests", contractIds: ["contract_get"], verificationReceiptIds: [], testCommand: { command: "npm", args: ["test"] } };
project.tasks.push(testTask);
const testPlan = ensureTaskVerificationPlan(project, testTask);
assert.equal(testPlan.steps.at(-1).type, "test-log");
const reviewedTestPlanHash = testPlan.targetSnapshotHash;
testTask.testCommand = { command: "npm", args: ["run", "test:changed"], cwd: "." };
assert.notEqual(ensureTaskVerificationPlan(project, testTask).targetSnapshotHash, reviewedTestPlanHash, "changing the executable arguments invalidates the prior approval snapshot");
testTask.testCommand = { command: "npm", args: ["test"] };
const withTests = await executeTaskVerificationPlan(project, testTask, { executeApiReplay, executeTestCommand: async () => ({ exitCode: 0, output: "1 test passed" }) });
assert.equal(withTests.receipt.result, "Verified");
assert.equal(withTests.receipt.testEvidenceIds.length, 1);
assert.equal(project.evidence.find((entry) => entry.id === withTests.receipt.testEvidenceIds[0]).type, "test-log");
const contradictoryTestResult = await executeTaskVerificationPlan(project, testTask, {
  executeApiReplay, executeTestCommand: async () => ({ passed: false, exitCode: 0, output: "runner reported failure" })
});
assert.equal(contradictoryTestResult.checkResults.find((entry) => entry.type === "test-log").status, "failed");
assert.equal(contradictoryTestResult.receipt.result, "Failed");

// An HTTP handler is first-class implementation evidence even when it is not
// also represented as a page or component artifact.
const endpointTask = { id: "task_endpoint_structure", intent: "full-stack", contractIds: ["contract_get"], artifactIds: ["endpoint:endpoint_health"], verificationReceiptIds: [] };
project.sourceContext.endpoints = [{ id: "endpoint_health", method: "GET", path: "/health", source: "src/health.ts", line: 4 }];
project.tasks.push(endpointTask);
const endpointPlan = ensureTaskVerificationPlan(project, endpointTask);
const endpointStructure = endpointPlan.steps.find((step) => step.type === "component-structure");
assert.deepEqual(endpointStructure?.artifactIds, ["endpoint:endpoint_health"]);
assert.deepEqual(endpointStructure?.structuralKinds, ["endpoint"]);
const endpointResult = await executeTaskVerificationPlan(project, endpointTask, { executeApiReplay });
assert.equal(endpointResult.checkResults.find((entry) => entry.type === "component-structure")?.status, "passed");
assert.match(endpointResult.checkResults.find((entry) => entry.type === "component-structure")?.reason, /endpoint/);

project.findings.push({ id: "finding_mismatch", contractId: "contract_get", type: "contract-mismatch", title: "Contract mismatch", status: "open" });
const failed = await executeTaskVerificationPlan(project, task, { allowStateChangingReplay: true, targetSnapshotHash: firstPlan.targetSnapshotHash, executeApiReplay });
assert.equal(failed.receipt.result, "Failed");
assert.equal(project.contracts[0].state, "Regressed");

const staleProject = structuredClone(project);
staleProject.sourceContext.gitRevision = "def456";
staleProject.contracts[0].state = "Verified";
staleProject.contracts[0].latestVerificationReceiptId = verified.receipt.id;
await fs.writeFile(path.join(root, ".aipi", "team-memory.json"), `${JSON.stringify({ version: 1, projectId: staleProject.id, contracts: [{ id: "contract_get", state: "Verified", latestVerificationReceiptId: verified.receipt.id }], verificationReceipts: [verified.receipt] }, null, 2)}\n`);
const hydrated = await hydrateAndBootstrapProject(staleProject, []);
assert.equal(hydrated.project.contracts.find((entry) => entry.id === "contract_get").state, "Stale");

await fs.rm(root, { recursive: true, force: true });
console.log("verification runner tests passed");
