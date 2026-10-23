import assert from "node:assert/strict";
import { formatReceiptTable, impactedContractsForFiles, parseVerifyArgs, verificationExitCode } from "../scripts/aipi-verify-cli.mjs";

const project = {
  id: "prj_cli", sourceContext: {
    gitRevision: "rev-1", roots: [{ kind: "workspace", path: "/workspace" }],
    endpoints: [{ id: "endpoint_users", method: "GET", path: "/users", source: "src/users.mjs", root: "/workspace", line: 10 }],
    frontendCalls: [], integrations: [], schemas: [], artifacts: [], git: []
  },
  contracts: [{ id: "contract_users", method: "GET", route: "/users", sourceArtifactIds: ["endpoint_users"], implementation: { source: "src/users.mjs", root: "/workspace" } }],
  evidence: [], tasks: [], verificationReceipts: [], knowledgeGraph: { nodes: [], edges: [] }
};

const impact = impactedContractsForFiles(project, ["src/users.mjs"]);
assert.deepEqual(impact.contracts.map((contract) => contract.id), ["contract_users"]);
assert.ok(impact.matchedNodes.some((node) => node.type === "handler"));

assert.deepEqual(parseVerifyArgs(["--project", "prj_cli", "--files", "src/a.mjs,src/b.mjs"]), {
  project: "prj_cli", files: ["src/a.mjs", "src/b.mjs"], changed: false, approveStateChangingReplays: false
});
assert.equal(parseVerifyArgs(["--project", "prj_cli", "--changed"]).changed, true);

const rows = [{ contract: "Users", methodPath: "GET /users", gitRevision: "rev-1", replayStatus: "passed", schemaDrift: "passed", receiptId: "receipt_1", receiptResult: "Verified", contractState: "Verified" }];
const table = formatReceiptTable(rows);
assert.match(table, /\| Contract \| Method \/ Path \| Git Revision/);
assert.match(table, /receipt_1/);
assert.equal(verificationExitCode(rows), 0);
assert.equal(verificationExitCode([{ ...rows[0], receiptResult: "Failed" }]), 1);
assert.equal(verificationExitCode([{ ...rows[0], contractState: "Regressed" }]), 1);
assert.equal(verificationExitCode([{ ...rows[0], receiptResult: "Verification pending", contractState: "Verification pending" }]), 0);

console.log("Impact-radius verifier CLI regression checks passed.");
