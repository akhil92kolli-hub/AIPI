import assert from "node:assert/strict";
import { normalizeTaskIntent, supportedTaskIntents } from "../packages/core/task-intent.mjs";
import { buildCommitPack } from "../packages/core/commit-pack.mjs";
import { evaluateDeploymentGate } from "../packages/core/deployment-gate.mjs";
import { ensureTaskVerificationPlan, executeTaskVerificationPlan } from "../packages/core/verification-runner.mjs";

assert.equal(normalizeTaskIntent("fix-contract"), "api-contract");
assert.equal(normalizeTaskIntent("ui-feature"), "ui-component");
assert.ok(supportedTaskIntents().includes("commit-pr"));
assert.ok(supportedTaskIntents().includes("deployment-automation"));

const project = {
  id: "release-project", activeEnvironmentId: "dev",
  sourceContext: { gitRevision: "abc123", roots: [], artifacts: [{ id: "settings", kind: "component", source: "src/Settings.tsx" }], frontendCalls: [] },
  environments: [{ id: "dev", name: "Development", variables: [{ key: "baseUrl", value: "http://127.0.0.1:3000", enabled: true }] }],
  contracts: [{ id: "users", method: "GET", route: "/api/users", state: "Verified" }],
  evidence: [{ id: "e1", taskId: "commit", type: "test-log", sourceRevision: "abc123", result: { passed: true } }],
  verificationReceipts: [{ id: "receipt1", taskId: "commit", contractId: "users", result: "Verified", sourceRevision: "abc123", verifiedAt: "2026-10-16T00:00:00.000Z" }]
};

const commitTask = { id: "commit", title: "Prepare verified release", intent: "commit-pr", contractIds: ["users"], runtimeEvidenceIds: ["e1"], artifactIds: [] };
const pack = await buildCommitPack(project, commitTask, { workingTree: { files: [{ status: "M", path: "src/Settings.tsx" }], summary: "1 file changed" } });
assert.equal(pack.files.length, 1);
assert.equal(pack.verificationReceipt.id, "receipt1");
assert.ok(pack.estimatedTokens <= pack.tokenBudget);
assert.match(pack.prompt, /atomic commit message/);

const deploymentTask = { id: "deploy", title: "Deploy release", intent: "deployment-automation", contractIds: ["users"] };
project.verificationReceipts.unshift({ id: "receipt2", taskId: "deploy", contractId: "users", result: "Verified", sourceRevision: "abc123", verifiedAt: "2026-10-16T00:00:00.000Z" });
const gate = await evaluateDeploymentGate(project, deploymentTask, { checkEnvironment: async () => ({ status: 204 }) });
assert.equal(gate.unlocked, false, "a repository receipt label cannot unlock deployment");
assert.equal(gate.preflightPassed, false);
assert.match(gate.reasons.join(" "), /not accepted by a trusted evidence producer/);
const acceptedPreview = await evaluateDeploymentGate(project, deploymentTask, {
  checkEnvironment: async () => ({ status: 204 }),
  acceptReceipt: (receipt) => receipt.id === "receipt2"
});
assert.equal(acceptedPreview.preflightPassed, true);
assert.equal(acceptedPreview.unlocked, false, "a local preflight cannot prove deployed consumer compatibility or enforcement");
assert.equal(acceptedPreview.enforcement, "unavailable");
project.sourceContext.gitRevision = "def456";
const blocked = await evaluateDeploymentGate(project, deploymentTask, { checkEnvironment: async () => ({ status: 204 }), acceptReceipt: (receipt) => receipt.id === "receipt2" });
assert.equal(blocked.unlocked, false);
assert.match(blocked.reasons.join(" "), /does not match/);
project.sourceContext.gitRevision = "abc123";

const uiTask = { id: "ui", title: "Build settings", intent: "ui-component", contractIds: [], artifactIds: ["component:settings"] };
const uiPlan = ensureTaskVerificationPlan(project, uiTask);
assert.deepEqual(uiPlan.steps.map((step) => step.type), ["component-structure"]);
const uiVerification = await executeTaskVerificationPlan(project, uiTask);
assert.equal(uiVerification.receipt.result, "Verified");

const apiTask = { id: "api", title: "Fix API", intent: "api-contract", contractIds: [], artifactIds: [] };
const apiVerification = await executeTaskVerificationPlan(project, apiTask);
assert.equal(apiVerification.receipt.result, "Failed");
assert.match(apiVerification.checkResults[0].reason, /require at least one linked K Map contract/);

console.log("Flexible task intents, commit pack, adaptive verification, and deployment gate passed");
