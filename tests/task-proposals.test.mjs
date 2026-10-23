import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-task-proposals-"));
process.env.AIPI_DATA = temp;
process.env.AIPI_PORT = "0";
process.env.AIPI_MAX_PORT = "0";

const { defaultProject, loadState, mutateState } = await import("../scripts/workspace-store.mjs");
const { callToolWithTelemetry, tools } = await import("../scripts/api-forge-server.mjs");

try {
  const project = defaultProject("Proposal test");
  project.sourceContext.roots = [{ kind: "workspace", path: temp }];
  project.sourceContext.artifacts = [{ id: "settings", kind: "component", name: "SettingsPanel", source: "src/SettingsPanel.tsx", root: temp }];
  project.contracts = [{ id: "contract_settings", method: "GET", route: "/api/settings", state: "Current" }];
  project.requests = [{ id: "request_settings", contractId: "contract_settings", name: "List settings", method: "GET", url: "http://localhost/api/settings", headers: [], params: [], assertions: [], body: { type: "none", content: "" } }];
  project.sourceContext.findings = [{ id: "finding_settings", method: "GET", path: "/api/settings", type: "contract-schema-mismatch", title: "Settings response is missing a field", severity: "high" }];
  project.tasks = [];
  await mutateState((state) => { state.projects = [project]; state.activeProjectId = project.id; });
  assert.ok((await loadState()).projects[0].contracts.some((entry) => entry.id === "contract_settings"));

  const definition = tools.find((tool) => tool.name === "propose_tasks_from_context");
  assert.ok(definition, "agent task proposal tool is exposed over MCP");
  assert.equal(definition.annotations.idempotentHint, true);
  const input = {
    project_id: project.id,
    request: "Fix the settings API contract and add a regression check.",
    idempotency_key: "proposal-test-001",
    agent: "test-agent",
    proposals: [{
      title: "Align settings response with its contract",
      objective: "Fix the missing settings response field and validate the current route behavior.",
      priority: "high",
      acceptance_criteria: ["The required response field is present.", "Focused regression coverage passes."],
      artifact_ids: ["component:settings"],
      contract_ids: ["contract_settings"],
      finding_ids: ["finding_settings"],
      candidate_checks: ["Run the settings response contract check."],
      rationale: "A current indexed finding identifies the contract gap.",
      confidence: 0.91
    }]
  };

  const created = await callToolWithTelemetry("propose_tasks_from_context", input);
  assert.equal(created.isError, false, JSON.stringify(created.structuredContent));
  assert.equal(created.structuredContent.created_count, 1);
  assert.equal(created.structuredContent.proposals[0].status, "proposed");
  const afterCreate = (await loadState()).projects[0];
  const task = afterCreate.tasks[0];
  assert.equal(task.source, "agent-proposal");
  assert.equal(task.status, "proposed");
  assert.deepEqual(task.proposal.citations, ["component:settings", "contract_settings", "finding_settings"]);
  assert.equal(task.contextPackId, undefined, "proposal remains unapproved and does not imply context was prepared");

  const replay = await callToolWithTelemetry("propose_tasks_from_context", input);
  assert.equal(replay.isError, false);
  assert.equal(replay.structuredContent.replayed, true);
  assert.equal((await loadState()).projects[0].tasks.length, 1, "an MCP retry must not duplicate proposals");

  const conflictingRetry = await callToolWithTelemetry("propose_tasks_from_context", { ...input, request: "Different request" });
  assert.equal(conflictingRetry.isError, true, "a reused idempotency key cannot mutate its original batch");
  const invalidCitation = await callToolWithTelemetry("propose_tasks_from_context", {
    ...input, idempotency_key: "proposal-test-002", proposals: [{ ...input.proposals[0], artifact_ids: ["component:not-in-this-project"] }]
  });
  assert.equal(invalidCitation.isError, true, "proposal citations must belong to the selected project");
  assert.equal((await loadState()).projects[0].tasks.length, 1, "invalid proposals are not partially persisted");

  // Test proposeTasksFromAssessment across projects
  const { proposeTasksFromAssessment } = await import("../packages/core/task-proposals.mjs");
  const consumerProject = defaultProject("Consumer Storefront");
  consumerProject.id = "prj_storefront";
  consumerProject.sourceContext.roots = [{ kind: "workspace", path: temp }];
  consumerProject.sourceContext.artifacts = [{ id: "checkout_form", kind: "component", name: "CheckoutForm", source: "src/CheckoutForm.tsx", root: temp }];
  consumerProject.tasks = [];

  const mockState = {
    projects: [project, consumerProject],
  };

  const mockAssessment = {
    workspaceId: "wsg_cross_repo",
    changeId: "chg_orders_v2",
    selection: { projectId: project.id, baseCommit: "a".repeat(40) },
    components: [
      {
        projectId: consumerProject.id,
        componentId: "checkout_form",
        label: "CheckoutForm.tsx",
        kind: "caller",
        source: { path: "src/CheckoutForm.tsx", line: 42 },
        coverage: { status: "stale", checks: [{ reason: "POST /checkout schema changed" }] },
      },
    ],
  };

  const propResult = proposeTasksFromAssessment(mockState, "wsg_cross_repo", mockAssessment);
  assert.equal(propResult.proposedCount, 1);
  assert.equal(consumerProject.tasks.length, 1);
  const createdProposal = consumerProject.tasks[0];
  assert.equal(createdProposal.status, "proposed");
  assert.match(createdProposal.title, /Update Consumer Storefront consumers/);
  assert.match(createdProposal.description, /CheckoutForm\.tsx/);
  assert.deepEqual(createdProposal.artifactIds,["component:checkout_form"]);
  assert.equal(createdProposal.proposal.confidence,null,"the assessment does not invent a numeric certainty");

  const unrelatedAssessment={...mockAssessment,changeId:"chg_orders_v3",components:[{...mockAssessment.components[0],componentId:"missing-caller",label:"OtherConsumer",source:{path:"src/unindexed.ts",line:5}}]};
  const noFalseCitation=proposeTasksFromAssessment(mockState,"wsg_cross_repo",unrelatedAssessment);
  assert.equal(noFalseCitation.proposedCount,0,"an unrelated first artifact cannot be attached as a citation");
  assert.equal(noFalseCitation.unresolvedConsumers.length,1);
  assert.equal(noFalseCitation.unresolvedConsumers[0].reason,"Source citation unresolved");

  // Idempotent replay does not duplicate
  const replayedProp = proposeTasksFromAssessment(mockState, "wsg_cross_repo", mockAssessment);
  assert.equal(replayedProp.proposedCount, 0);
  assert.equal(replayedProp.replayedCount, 1);
  assert.equal(consumerProject.tasks.length, 1, "Repeated assessment does not duplicate proposed tasks");

  // Subsequent PR push with same coordination origin updates existing task rather than creating a duplicate
  const pushedAssessment = {
    ...mockAssessment,
    originRepositoryId: "repo_orders",
    prNumber: 42,
    changeId: "chg_orders_pr42_push1",
    selection: { projectId: project.id, baseCommit: "a".repeat(40), headCommit: "b".repeat(40) },
  };
  consumerProject.tasks = [];
  const prPush1 = proposeTasksFromAssessment(mockState, "wsg_cross_repo", pushedAssessment);
  assert.equal(prPush1.proposedCount, 1);
  assert.equal(consumerProject.tasks.length, 1);

  const prPush2 = proposeTasksFromAssessment(mockState, "wsg_cross_repo", {
    ...pushedAssessment,
    changeId: "chg_orders_pr42_push2",
    selection: { projectId: project.id, baseCommit: "a".repeat(40), headCommit: "c".repeat(40) },
  });
  assert.equal(prPush2.proposedCount, 0);
  assert.equal(prPush2.updatedCount, 1);
  assert.equal(consumerProject.tasks.length, 1, "Subsequent PR push appends assessment to existing coordination task");
  assert.equal(consumerProject.tasks[0].assessmentHistory.length, 2);

  console.log("AIPI MCP task proposals, cross-project impact proposal, and idempotent persistence passed");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
