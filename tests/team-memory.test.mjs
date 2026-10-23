import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyProjectGraphPins, hydrateProjectTeamMemory, syncProjectTeamMemory } from "../packages/core/team-memory.mjs";
import { evaluateDeploymentGate } from "../packages/core/deployment-gate.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-team-memory-"));

try {
  const project = {
    id: "project_team_memory_test",
    name: "Team memory fixture",
    sourceContext: { roots: [{ kind: "workspace", path: root }], git: [{ commit: "abc123" }] },
    requests: [{
      id: "req_contract", contractId: "contract_users", name: "List users", method: "GET", url: "{{baseUrl}}/users",
      headers: [{ key: "Authorization", value: "Bearer must-not-be-committed", enabled: true }], auth: { type: "bearer", token: "must-not-be-committed" },
      body: { type: "json", content: "" }, assertions: [{ type: "status", equals: 200 }], origin: "post-index-bootstrapper", bootstrapFingerprint: "bootstrap:request:users"
    }],
    verificationReceipts: [{ id: "receipt_users", contractId: "contract_users", sourceRevision: "abc123", result: "Verified" }],
    knowledgeGraph: { nodes: [], edges: [{ id: "edge_users", from: "contract_users", to: "schema_users", type: "VALIDATED_BY", provenance: "human-confirmed", confidence: 1, confirmationState: "confirmed" }] }
  };

  const written = await syncProjectTeamMemory(project);
  assert.equal(written.written, true);
  assert.equal(written.graphPins, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".aipi", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.files, ["graph-pins.json", "saved-requests.json", "verification-receipts.json", "team-memory.json"]);
  const saved = JSON.parse(await fs.readFile(path.join(root, ".aipi", "saved-requests.json"), "utf8"));
  assert.equal(saved.requests[0].headers[0].value, "[REDACTED]", "credential-like headers are redacted from repository memory");
  assert.equal(saved.requests[0].auth.token, undefined, "authentication secrets are never serialized");

  const freshProject = { id: project.id, name: project.name, sourceContext: project.sourceContext, requests: [], verificationReceipts: [], contracts:[{id:"contract_users",state:"Unknown",latestVerificationReceiptId:null}], knowledgeGraph: { nodes: [], edges: [] } };
  const inherited = await hydrateProjectTeamMemory(freshProject);
  assert.equal(inherited.requests.length, 1);
  assert.equal(freshProject.requests[0].id, "req_contract");
  assert.equal(freshProject.verificationReceipts[0].id, "receipt_users");
  assert.equal(freshProject.verificationReceipts[0].authority, "advisory");
  assert.equal(freshProject.contracts[0].state, "Unknown", "repository memory cannot promote contract verification state");
  assert.equal(freshProject.contracts[0].latestVerificationReceiptId, null);
  freshProject.activeEnvironmentId = "dev";
  freshProject.environments = [{id:"dev",name:"Development",services:[{baseUrl:"http://127.0.0.1:3000"}]}];
  const forgedGate = await evaluateDeploymentGate(freshProject,{id:"deploy",contractIds:["contract_users"]},{checkEnvironment:async()=>({status:204})});
  assert.equal(forgedGate.unlocked,false,"a repository-imported passing receipt must not grant deployment permission");
  assert.equal(forgedGate.preflightPassed,false);
  assert.match(forgedGate.reasons.join(" "),/not accepted by a trusted evidence producer/);
  assert.equal(applyProjectGraphPins(freshProject, inherited.graphPins), 1);
  assert.equal(freshProject.knowledgeGraph.edges[0].confirmationState, "pending");
  assert.equal(freshProject.knowledgeGraph.edges[0].confidence, 0);
  assert.equal(freshProject.knowledgeGraph.edges[0].provenance, "repository-declaration");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("Team memory tests passed");
