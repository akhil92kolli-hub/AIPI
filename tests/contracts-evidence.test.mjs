import assert from "node:assert/strict";
import { materializeContractEvidence, stableEnvironmentFingerprint, synthesizeTaskFromFinding, synthesizeTaskFromContract } from "../packages/core/contracts-evidence.mjs";
import { resolveContractChain } from "../ui/contract-chain.js";
import { buildTaskContext } from "../packages/core/task-context.mjs";

const project = {
  id: "project_contract_loop",
  name: "Contract loop fixture",
  activeEnvironmentId: "environment_local",
  environments: [{ id: "environment_local", name: "Local", variables: [{ key: "baseUrl", value: "http://127.0.0.1:3000", enabled: true, secret: false }] }],
  requests: [{ id: "request_login", name: "Login", method: "POST", url: "{{baseUrl}}/login" }],
  tasks: [],
  verificationRuns: [],
  sourceContext: {
    lastScannedAt: "2026-10-15T00:00:00.000Z",
    git: [{ commit: "revision-a", dirty: false }],
    endpoints: [{ id: "endpoint_login", method: "POST", path: "/login", source: "src/login.ts", line: 12 }],
    frontendCalls: [], integrations: [], schemas: [], artifacts: [],
    findings: [{ id: "finding_login", title: "Login schema mismatch", type: "schema-drift", severity: "high", method: "POST", path: "/login", source: "src/login.ts", line: 12 }]
  }
};

const chainProject = structuredClone(project);
chainProject.sourceContext.findings = [];
chainProject.requests.push({ ...chainProject.requests[0], id: 'second_request' });
chainProject.sourceContext.endpoints.push({ ...chainProject.sourceContext.endpoints[0], id: 'second_endpoint', source: 'other/login.ts' });
chainProject.sourceContext.frontendCalls = [{ id: 'login_call', source: 'ui/Login.tsx', root: '/repo', line: 20 }];
chainProject.sourceContext.integrations = [{ endpointId: 'endpoint_login', callId: 'login_call' }];
chainProject.sourceContext.artifacts = [{ id: 'login_component', kind: 'component', source: 'ui/Login.tsx', root: '/repo' }, { id: 'other_test', kind: 'test', source: 'unrelated.test.ts' }, { id: 'login_test', kind: 'test', endpointId: 'endpoint_login', source: 'login.test.ts' }];
chainProject.sourceContext.schemas = [{ id: 'unrelated_schema', source: 'other.ts' }];
materializeContractEvidence(chainProject);
const contract = chainProject.contracts[0];
assert.equal(contract.sourceRequestIds.length, 2, 'all saved request references survive normalization');
assert.equal(contract.sourceArtifactIds.length, 2, 'all handler references survive normalization');
const chain = resolveContractChain(chainProject, contract);
assert.equal(chain[0].items[0].id, 'login_call');
assert.match(chain[1].items[0].relationship, /candidate/);
assert.equal(chain[3].items.length, 0, 'unrelated schema is never used as a downstream link');
assert.deepEqual(chain[5].items.map(item => item.id), ['login_test']);
const generated = synthesizeTaskFromContract(chainProject, contract.id);
assert.equal(generated.created, true);
assert.equal(generated.task.status, 'proposed');
assert.ok(generated.task.artifactIds.includes('consumer:login_call'));
assert.ok(generated.task.artifactIds.includes('endpoint:endpoint_login'));
assert.equal(synthesizeTaskFromContract(chainProject, contract.id).created, false);
assert.throws(() => synthesizeTaskFromContract(chainProject, 'missing'), /Contract not found/);

materializeContractEvidence(project, [{ id: "evidence_login", projectId: project.id, requestId: "request_login", method: "POST", url: "{{baseUrl}}/login", createdAt: "2026-10-15T00:01:00.000Z", result: { status: 422, ok: false, passed: false } }]);
assert.equal(project.contracts.length, 1, "templated requests and indexed endpoints normalize into one contract");
assert.equal(project.evidence.length, 1);
assert.equal(project.evidence[0].redactionManifest.plaintextSecretsPersisted, false);
assert.ok(project.findings.every((finding) => finding.fingerprint));
assert.equal(stableEnvironmentFingerprint(project), stableEnvironmentFingerprint(project));

const first = synthesizeTaskFromFinding(project, "finding_login");
const duplicate = synthesizeTaskFromFinding(project, "finding_login");
assert.equal(first.created, true);
assert.equal(duplicate.created, false, "repeated findings reuse the existing task draft");
assert.deepEqual(first.task.contractIds, [project.contracts[0].id]);
assert.ok(first.task.contextPackId && first.task.verificationPlanId);

const context = buildTaskContext(project, first.task.id, 2400);
assert.equal(context.telemetry.tokenBudget, 2400);
assert.ok(context.telemetry.estimatedTokens <= context.telemetry.tokenBudget);

console.log("Contracts, evidence, AI task synthesis, and bounded context tests passed");
