import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-mcp-handoff-"));
process.env.AIPI_DATA = temp;
process.env.AIPI_PORT = "0";
process.env.AIPI_MAX_PORT = "0";

const { defaultProject, loadState, mutateState } = await import("../scripts/workspace-store.mjs");
const { callToolWithTelemetry, tools } = await import("../scripts/api-forge-server.mjs");
const { ensureTaskVerificationPlan, executeTaskVerificationPlan } = await import("../packages/core/verification-runner.mjs");

try {
  const project = defaultProject("IDE handoff lifecycle");
  project.sourceContext.roots = [{ kind: "workspace", path: temp }];
  project.sourceContext.lastScannedAt = "2026-10-16T08:00:00.000Z";
  project.sourceContext.gitRevision = "revision_users";
  project.sourceContext.git = [{ root: temp, commit: "revision_users", dirty: false }];
  project.sourceContext.artifacts = [{ id: "handler", kind: "component", source: "src/handler.ts", root: temp, line: 7 }];
  project.requests = [{ id: "req_users", contractId: "contract_users", name: "List users", method: "GET", url: "{{baseUrl}}/api/users", headers: [], params: [], assertions: [{ type: "status", equals: 200 }], body: { type: "none", content: "" } }];
  project.contracts = [{ id: "contract_users", method: "GET", route: "/api/users", currentRevisionId: "revision_users", sourceRequestIds: [], sourceArtifactIds: [] }];
  project.tasks = [{
    id: "task_users", projectId: project.id, title: "Repair users contract", description: "Align the handler and response contract. INJECTED_TASK_PROSE_MARKER",
    status: "in-progress", priority: "high", artifactIds: ["component:handler"], artifactLinks: [], contractIds: ["contract_users"],
    requestIds: [], findingIds: [], evidenceIds: [], runtimeEvidenceIds: [], runtimeFindings: [], acceptanceCriteria: ["Contract verification passes."],
    milestoneIds: [], verificationReceiptIds: [], verificationRunIds: [], externalLinks: [], verificationGates: { contract: true, requestReplay: false, noExfiltration: true }
  }];
  project.verificationReceipts = [];
  await mutateState((state) => { state.projects = [project]; state.activeProjectId = project.id; state.handoffs = []; state.workspaceGroups = [{id:"wsg_mcp_facade_test",name:"MCP",projectIds:[project.id],version:1}]; });

  for (const name of ["aipi_get_cross_repo_contracts", "aipi_check_impact", "aipi_get_handoff"])
    assert.ok(tools.find(tool => tool.name === name)?.annotations.readOnlyHint, `${name} is a read-only daily entry tool`);
  const dependencies = await callToolWithTelemetry("aipi_get_cross_repo_contracts", {workspace_id:"wsg_mcp_facade_test",project_id:project.id,file_or_symbol:"src/handler.ts"});
  assert.equal(dependencies.isError,false);
  assert.equal(dependencies.structuredContent.status,"indexed");
  assert.equal(dependencies.structuredContent.target.source,"src/handler.ts");
  const missingDependency = await callToolWithTelemetry("aipi_get_cross_repo_contracts", {workspace_id:"wsg_mcp_facade_test",project_id:project.id,file_or_symbol:"missing.ts"});
  assert.equal(missingDependency.structuredContent.status,"unknown");
  const safeManifest=await callToolWithTelemetry("get_context_pack_manifest",{project_id:project.id,task_id:"task_users"});
  assert.equal(safeManifest.isError,false);
  assert.doesNotMatch(JSON.stringify(safeManifest.structuredContent.manifest),/INJECTED_TASK_PROSE_MARKER/);
  const advisoryManifest=await callToolWithTelemetry("get_context_pack_manifest",{project_id:project.id,task_id:"task_users",include_advisory:true});
  assert.match(advisoryManifest.structuredContent.manifest.advisory.task.description,/INJECTED_TASK_PROSE_MARKER/);

  const createDefinition = tools.find((tool) => tool.name === "create_handoff");
  assert.ok(createDefinition.inputSchema.properties.task_id, "task-backed handoffs are exposed through the MCP schema");
  for (const name of ["discover_task_context", "prepare_task_handoff", "review_and_run_task_verification"]) {
    const definition = tools.find((tool) => tool.name === name);
    assert.ok(definition, `${name} is exposed to Codex and MCP-capable IDEs`);
    assert.equal(definition._meta.ui.resourceUri, "ui://api-forge/dashboard-v1.html", `${name} keeps the AIPI MCP App panel attached`);
  }
  assert.ok(tools.find((tool) => tool.name === "record_handoff_dispatch"), "dispatch results have a first-class MCP operation");
  assert.ok(tools.find((tool) => tool.name === "generate_regression_test").inputSchema.properties.framework.enum.includes("node"));
  assert.ok(tools.find((tool) => tool.name === "generate_regression_test").inputSchema.properties.framework.enum.includes("pytest"));

  const discovered = await callToolWithTelemetry("discover_task_context", { project_id: project.id, task_id: "task_users" });
  assert.equal(discovered.isError, false);
  assert.equal(discovered.structuredContent.task.id, "task_users");
  const preparedHandoff = await callToolWithTelemetry("prepare_task_handoff", { project_id: project.id, task_id: "task_users", question: "Implement the bounded correction." });
  assert.equal(preparedHandoff.isError, false);
  assert.match(preparedHandoff.structuredContent.markdown, /verify_contract_revision/);

  const created = await callToolWithTelemetry("create_handoff", { project_id: project.id, task_id: "task_users", question: "Implement and verify the fix." });
  assert.equal(created.isError, false);
  const handoff = created.structuredContent.handoff;
  const boundedHandoff = await callToolWithTelemetry("aipi_get_handoff", {workspace_id:"wsg_mcp_facade_test",project_id:project.id,handoff_id:handoff.id});
  assert.equal(boundedHandoff.isError,false);
  assert.equal(boundedHandoff.structuredContent.handoff.id,handoff.id);
  assert.equal(boundedHandoff.structuredContent.handoff.markdown,undefined,"legacy handoff prose is not sent through the daily tool");
  assert.equal(handoff.id, preparedHandoff.structuredContent.handoff.id, "retrying a handoff against the same context generation does not duplicate it");
  assert.equal(handoff.contextPackGeneration, 2, "handoff is bound to the latest prepared context generation");
  assert.equal(handoff.taskId, "task_users");
  assert.deepEqual(handoff.contractIds, ["contract_users"]);
  assert.match(created.structuredContent.markdown, /verify_contract_revision/);
  assert.match(created.structuredContent.markdown, /complete_handoff/);
  assert.doesNotMatch(created.structuredContent.markdown, /authorization:/i);

  const latest = await callToolWithTelemetry("get_latest_handoff", { project_id: project.id, task_id: "task_users" });
  assert.equal(latest.structuredContent.handoff.id, handoff.id);
  const dispatch = await callToolWithTelemetry("record_handoff_dispatch", { handoff_id: handoff.id, outcome: "chat_opened", target: "vscode-chat", message: "Opened; awaiting agent response." });
  assert.equal(dispatch.isError, false);
  assert.equal(dispatch.structuredContent.handoff.dispatch.state, "chat_opened");
  const active = await callToolWithTelemetry("complete_handoff", { handoff_id: handoff.id, status: "in_progress", message: "Agent started implementation." });
  assert.equal(active.structuredContent.handoff.status, "in_progress");

  const unverified = await callToolWithTelemetry("complete_handoff", { handoff_id: handoff.id, status: "completed", verification: {} });
  assert.equal(unverified.isError, true);
  assert.match(unverified.structuredContent.error, /verified receipts/);

  await mutateState((state) => {
    const contractRevisionId = state.projects[0].contracts.find((contract) => contract.id === "contract_users").currentRevisionId;
    state.projects[0].verificationReceipts.push({ id: "receipt_stale", taskId: "task_users", contractId: "contract_users", contractRevisionId, result: "Verified", sourceRevision: "old-revision", contextPackId: handoff.contextPackId });
    state.projects[0].verificationReceipts.push({ id: "receipt_users", taskId: "task_users", contractId: "contract_users", contractRevisionId, result: "Verified", sourceRevision: "revision_users", contextPackId: handoff.contextPackId });
  });
  const staleCompletion = await callToolWithTelemetry("complete_handoff", { handoff_id: handoff.id, status: "completed", verification: { receipt_id: "receipt_stale" } });
  assert.equal(staleCompletion.isError, true, "a receipt from an older source revision cannot close the handoff");
  const forgedCompletion = await callToolWithTelemetry("complete_handoff", { handoff_id: handoff.id, status: "completed", verification: { receipt_id: "receipt_users" } });
  assert.equal(forgedCompletion.isError, true, "a current-looking receipt without an executed run cannot close the handoff");
  let executedReceiptId;
  await mutateState(async (state) => {
    const owner=state.projects[0], task=owner.tasks.find(entry=>entry.id==="task_users");
    const plan=ensureTaskVerificationPlan(owner,task);
    const executed=await executeTaskVerificationPlan(owner,task,{targetSnapshotHash:plan.targetSnapshotHash,
      contextPackId:handoff.contextPackId,handoffId:handoff.id,
      executeApiReplay:async()=>({ok:true,passed:true,status:200,json:{}}),
      validateContractResponse:()=>({passed:true})});
    assert.equal(executed.receipt.result,"Verified");
    executedReceiptId=executed.receipt.id;
  });
  const completed = await callToolWithTelemetry("complete_handoff", { handoff_id: handoff.id, status: "completed", message: "Fix verified.", verification: { receipt_id: executedReceiptId } });
  assert.equal(completed.isError, false);
  assert.equal(completed.structuredContent.handoff.status, "completed");
  assert.deepEqual(completed.structuredContent.handoff.verificationReceiptIds, [executedReceiptId]);
  assert.equal(completed.structuredContent.handoff.dispatch.state, "chat_opened", "dispatch provenance survives lifecycle updates");

  await mutateState((state) => {
    const target = state.projects[0];
    target.tasks.push({ id: "ui-task", title: "Build UI", description: "Accessible component", intent: "ui-component", artifactIds: ["component:handler"], contractIds: [], contextPackId: "ui-context", verificationPlan: { steps: [{ id: "ui-check", required: true }] }, verificationRunIds: [], verificationReceiptIds: [] });
    target.contextPacks.unshift({ id: "ui-context", taskId: "ui-task", generation: 1, sourceRevision: "revision_users", artifactIds: ["component:handler"] });
  });
  const uiHandoffResult = await callToolWithTelemetry("create_handoff", { project_id: project.id, task_id: "ui-task" });
  const uiHandoffId = uiHandoffResult.structuredContent.handoff.id;
  const prematureUiCompletion = await callToolWithTelemetry("complete_handoff", { handoff_id: uiHandoffId, status: "completed" });
  assert.equal(prematureUiCompletion.isError, true, "non-contract handoffs still require current passing task checks");
  const freshProject = (await loadState()).projects.find((entry) => entry.id === project.id);
  const uiTask = freshProject.tasks.find((entry) => entry.id === "ui-task");
  const uiPlan = ensureTaskVerificationPlan(freshProject, uiTask);
  const queued = await callToolWithTelemetry("start_task_check_job", { project_id: project.id, task_id: uiTask.id, handoff_id: uiHandoffId, idempotency_key: "ui-handoff-checks", target_snapshot_hash: uiPlan.targetSnapshotHash });
  assert.equal(queued.isError, false, JSON.stringify(queued.structuredContent));
  let uiJob;
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await callToolWithTelemetry("get_task_check_job", { project_id: project.id, task_id: uiTask.id, job_id: queued.structuredContent.job.id });
    uiJob = status.structuredContent.job;
    if (["completed", "failed", "stale", "cancelled"].includes(uiJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(uiJob.status, "completed", JSON.stringify(uiJob));
  assert.equal(uiJob.contextPackId, uiHandoffResult.structuredContent.handoff.contextPackId);
  assert.equal(uiJob.handoffId, uiHandoffId);
  assert.equal(uiJob.result, "Verified");
  const completedUiHandoff = await callToolWithTelemetry("complete_handoff", { handoff_id: uiHandoffId, status: "completed" });
  assert.equal(completedUiHandoff.isError, false, JSON.stringify(completedUiHandoff.structuredContent));

  const stored = await loadState();
  assert.ok(stored.timeline.some((event) => event.source?.ref === handoff.id && event.title === "IDE handoff completed"));
  const { commerceState } = await import('../fixtures/workspace-commerce/state.mjs');
  const { saveWorkspaceGroup, workspaceTargets } = await import('../packages/core/workspace-groups.mjs');
  const commerce = commerceState();
  saveWorkspaceGroup(commerce, { name: 'Commerce', projectIds: commerce.projects.map(p => p.id) }, 'wsg_crossrepo');
  const refs = workspaceTargets(commerce, 'wsg_crossrepo').filter(t => t.kind === 'api').map(t => t.ref);
  commerce.projects[0].tasks.push({ id: 'multi', title: 'Both backends', description: 'Verify both repositories', intent: 'full-stack', workspaceGroupId: 'wsg_crossrepo', targetRefs: refs, contractIds: [], artifactIds: [], requestIds: [] });
  await mutateState(state => { state.projects = commerce.projects; state.workspaceGroups = commerce.workspaceGroups; });
  const multi = await callToolWithTelemetry('prepare_task_handoff', { project_id: 'storefront', task_id: 'multi' });
  assert.equal(multi.isError, false, JSON.stringify(multi));
  const multiHandoff = multi.structuredContent.handoff;
  const multiManifest = await callToolWithTelemetry('get_context_pack_manifest', { project_id: 'storefront', task_id: 'multi', token_budget: 8000 });
  assert.equal(multiManifest.structuredContent.manifest.workspace.projects.length, 3);
  assert.deepEqual(multiManifest.structuredContent.manifest.contracts.map(c => c.projectId), ['orders', 'payments']);
  await mutateState(async state => {
    const owner = state.projects.find(p => p.id === 'storefront'), task = owner.tasks.find(t => t.id === 'multi');
    const plan = ensureTaskVerificationPlan(owner, task);
    await executeTaskVerificationPlan(owner, task, { targetSnapshotHash: plan.targetSnapshotHash, handoffId: multiHandoff.id, allowStateChangingReplay: true,
      executeApiReplay: async () => ({ ok: true, passed: true, status: 201, json: {} }), validateContractResponse: () => ({ passed: true }) });
  });
  const multiOwner = (await loadState()).projects.find(p => p.id === 'storefront');
  const receipt = multiOwner.verificationReceipts[0];
  assert.equal(receipt.result, 'Verified');
  const verified = await callToolWithTelemetry('complete_handoff', { handoff_id: multiHandoff.id, status: 'completed', verification: { receipt_id: receipt.id } });
  assert.equal(verified.isError, false, JSON.stringify(verified));
  await mutateState(state => { state.projects.find(p => p.id === 'payments').environments[0].variables[0].value = 'http://127.0.0.1:9999'; });
  const staleMulti = await callToolWithTelemetry('complete_handoff', { handoff_id: multiHandoff.id, status: 'completed', verification: { receipt_id: receipt.id } });
  assert.equal(staleMulti.isError, true, 'Foreign repository changes invalidate completion');
  console.log("MCP task handoff persistence and receipt-gated completion passed");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
