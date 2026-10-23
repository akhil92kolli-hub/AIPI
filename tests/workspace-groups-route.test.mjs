import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commerceState } from "../fixtures/workspace-commerce/state.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-workspace-groups-"));
process.env.AIPI_DATA = path.join(temp, "data");
process.env.AIPI_PORT = "0"; process.env.AIPI_MAX_PORT = "0";
const { mutateState, loadState, DATA_FILE } = await import("../scripts/workspace-store.mjs");
const { startDashboard, ignoredWatcherPath } = await import("../scripts/dashboard-server.mjs");
let dashboard;
try {
  assert.equal(ignoredWatcherPath(temp, ".aipi/manifest.json.123.tmp"), true);
  assert.equal(ignoredWatcherPath(temp, ".aipi"), true);
  assert.equal(ignoredWatcherPath(temp, "src/checkout.ts"), false);
  const legacy = commerceState();
  for (const project of legacy.projects) { project.sourceContext.roots = []; project.sourceContext.artifacts = []; }
  await fs.mkdir(process.env.AIPI_DATA, { recursive: true });
  const original = JSON.stringify(legacy);
  await fs.writeFile(DATA_FILE, original);
  await mutateState(() => {});
  assert.equal(await fs.readFile(`${DATA_FILE}.before-workspace-groups.json`, "utf8"), original);
  assert.equal(await fs.readFile(`${DATA_FILE}.before-source-identities.json`, "utf8"), original);
  const migrated = await loadState();
  assert.equal(migrated.workspaceGroups.length, 3);
  dashboard = await startDashboard({ executeRequest: async () => ({ ok: true, passed: true, status: 201, headers: {}, body: "{}", json: {} }) });
  const headers = { authorization: `Bearer ${dashboard.token}`, "content-type": "application/json" };
  const request = async (url, method = "GET", body) => {
    const response = await fetch(`${dashboard.url}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(`${dashboard.url}/api/workspaces`)).status, 401);
  const groupId = "wsg_commerce";
  const groupInput = { name: "Commerce", projectIds: ["storefront", "orders", "payments"] };
  assert.equal((await request(`/api/workspaces/${groupId}`, "PUT", groupInput)).status, 200);
  const releasePath = `/api/workspaces/${groupId}/release-compatibility`;
  assert.equal((await fetch(`${dashboard.url}${releasePath}`)).status, 401);
  const release = await request(`${releasePath}?projectId=orders&environmentId=production`);
  assert.equal(release.status, 200);
  assert.equal(release.body.releaseCompatibility.canDeploy, false);
  assert.equal(release.body.releaseCompatibility.previewReady, false);
  assert.equal(release.body.releaseCompatibility.candidate.projectId, 'orders');
  assert.equal((await request(`${releasePath}?projectId=outside`)).status, 404);
  const identityResult=await request(`/api/workspaces/${groupId}/identity`);
  assert.equal(identityResult.status,200);
  assert.equal(identityResult.body.identity.schemaVersion,3);
  assert.match(identityResult.body.identity.workspace.id,/^[0-9a-f-]{36}$/);
  assert.equal(identityResult.body.identity.workspace.localAlias,groupId);
  assert.equal((await fetch(`${dashboard.url}/api/workspaces/${groupId}/identity`)).status,401);
  assert.equal((await request(`/api/workspaces/${groupId}/identity/projects/orders/sources`,"PUT",{id:"src_local123456",name:"Local source",kind:"local"})).status,200);
  assert.equal((await request(`/api/workspaces/${groupId}/identity/projects/not-member/sources`,"PUT",{id:"src_forbidden1234",name:"Wrong",kind:"local"})).status,404);
  assert.equal((await request(`/api/workspaces/${groupId}/identity/projects/orders/sources/checkout`,"PUT",{sourceBindingId:"src_local123456",root:"/unauthorized"})).status,403);

  assert.equal((await request(`/api/workspaces/${groupId}`, "PUT", groupInput)).body.workspace.version, 1);
  const manifestPath = `/api/workspaces/${groupId}/manifest`;
  assert.equal((await fetch(`${dashboard.url}${manifestPath}`)).status, 401);
  const exported = await request(manifestPath);
  assert.equal(exported.status, 200);
  const manifest = exported.body.manifest;
  assert.equal(manifest.schemaVersion, 2);
  manifest.resources[0].repository = { provider: "github", providerRepositoryId: "123", remote: "https://github.com/team/commerce.git", root: "services/orders" };
  assert.equal((await fetch(`${dashboard.url}${manifestPath}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(manifest) })).status, 401);
  const bound = await request(manifestPath, "PUT", manifest);
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  assert.equal(bound.body.manifest.bindingVersion, manifest.bindingVersion + 1);
  assert.equal((await request(manifestPath, "PUT", manifest)).status, 409);
  assert.equal((await loadState()).projects.find(p => p.id === manifest.resources[0].projectId).repositoryBinding.providerRepositoryId, "123");
  const checkoutPath = `/api/workspaces/${groupId}/checkouts`;
  assert.equal((await fetch(`${dashboard.url}${checkoutPath}`)).status, 401);
  assert.deepEqual((await request(checkoutPath)).body.checkouts, []);
  const search = await request(`/api/workspaces/${groupId}/targets?q=checkout&kind=apis`);
  assert.equal(search.status, 200);
  const apiTargets = search.body.items.filter((target) => target.kind === "api");
  const reviewInput = {fromKey:apiTargets[0].key,toKey:apiTargets[1].key,type:'CALLS',status:'approved',evidence:'Explicit fixture review; not inferred from duplicate routes.',reviewer:'Route test'};
  assert.equal((await fetch(`${dashboard.url}/api/workspaces/${groupId}/relationships`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(reviewInput)})).status,401);
  assert.equal((await request(`/api/workspaces/${groupId}/relationships`,'POST',reviewInput)).status,200);
  assert.equal((await request(`/api/workspaces/${groupId}/relationships`)).body.relationships.length,1);
  assert.equal((await request(`/api/workspaces/${groupId}/relationships`,'POST',reviewInput)).status,409);
  assert.equal(new Set(apiTargets.map((target) => target.ref.projectId)).size, 2);
  const ordersTarget = search.body.items.find((target) => target.kind === "request" && target.ref.projectId === "orders");
  const payload = { task: { id: "task_selection", title: "Check checkout", description: "Review checkout validation", intent: "api-contract", acceptanceCriteria: ["Checkout validation is tested"] }, selectionContext: { workspaceGroupId: groupId, targetKeys: [ordersTarget.key] } };
  const created = await request("/api/projects/orders/tasks", "POST", payload);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.task.targetRefs[0].projectId, "orders");
  assert.ok(created.body.task.requestIds.includes("checkout-request"));
  const retry = await request("/api/projects/orders/tasks", "POST", payload);
  assert.equal(retry.status, 201);
  assert.equal((await loadState()).projects.find((project) => project.id === "orders").tasks.filter((task) => task.id === "task_selection").length, 1);
  assert.equal((await request("/api/projects/storefront/tasks", "POST", payload)).status, 201);
  const conflicting = structuredClone(payload); conflicting.task.description = "Different task";
  assert.equal((await request("/api/projects/orders/tasks", "POST", conflicting)).status, 409);
  const edit = { task: { ...created.body.task, description: "Change the same task without API context" }, selectionContext: { workspaceGroupId: groupId, targetKeys: [] } };
  const edited = await request("/api/projects/orders/tasks/task_selection", "POST", edit);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.task.requestIds, [], "removed requests must not return during context preparation");
  assert.deepEqual(edited.body.task.contractIds, [], "manual selection must not auto-bind contracts");
  assert.deepEqual(edited.body.task.targetRefs, []);
  assert.ok(edited.body.task.verificationScopeChangedAt);
  assert.equal(edited.body.task.id, created.body.task.id);
  const foreign = apiTargets.find(t => t.ref.projectId === "payments");
  const crossEdit = await request("/api/projects/orders/tasks/task_selection", "POST", { ...edit, selectionContext: { workspaceGroupId: groupId, targetKeys: [foreign.key] } });
  assert.equal(crossEdit.status, 200, JSON.stringify(crossEdit.body));
  assert.equal(crossEdit.body.task.targetRefs[0].projectId, 'payments');
  assert.deepEqual(crossEdit.body.task.contractIds, [], 'Foreign IDs must not leak into owner-local context');
  const rebound = await request("/api/projects/orders/tasks/task_selection", "POST", { task: edited.body.task, selectionContext: payload.selectionContext });
  assert.equal(rebound.status, 200);
  assert.deepEqual(rebound.body.task.requestIds, ["checkout-request"]);
  const staleEdit = await request("/api/projects/orders/tasks/task_selection", "POST", { ...edit, expectedTaskUpdatedAt: "stale-version" });
  assert.equal(staleEdit.status, 409, "conflicting task edits are rejected without recreating the task");
  assert.equal((await loadState()).projects.find(p => p.id === "orders").tasks.length, 1, "editing does not recreate tasks");
  const savedGroup = (await loadState()).workspaceGroups.find((group) => group.id === groupId);
  assert.equal(savedGroup.version, 1);
  assert.equal((await request(`/api/workspaces/${groupId}`, "PUT", { name: "Changed", projectIds: ["orders"], expectedVersion: 0 })).status, 409);
  assert.equal(await fs.readFile(`${DATA_FILE}.before-workspace-groups.json`, "utf8"), original, "backup never overwritten");

  // Verify GET /api/workspaces/:workspaceId projection
  const projRes = await request(`/api/workspaces/${groupId}`);
  assert.equal(projRes.status, 200);
  const proj = projRes.body.workspaceModel;
  assert.equal(proj.workspace.id, groupId);
  assert.equal(proj.projects.length, 3);
  assert.ok(proj.tasks.some(t => t.id === "task_selection"));
  assert.ok(proj.contracts.length > 0);
  assert.ok(proj.targets.length > 0);
  assert.ok(proj.capabilities.knowledge);

  // Verify GET /api/workspaces/:workspaceId/tasks/:taskId/context
  const taskCtxRes = await request(`/api/workspaces/${groupId}/tasks/task_selection/context`);
  assert.equal(taskCtxRes.status, 200);
  assert.equal(taskCtxRes.body.task.id, "task_selection");

  // Verify POST /api/workspaces/:workspaceId/tasks/append (comment & decision)
  const appendComment = await request(`/api/workspaces/${groupId}/tasks/append`, "POST", {
    taskId: "task_selection",
    type: "comment",
    body: "Ready for cross-repo review",
    author: "Test Engineer"
  });
  assert.equal(appendComment.status, 200);
  assert.equal(appendComment.body.task.comments.length, 1);
  assert.equal(appendComment.body.task.comments[0].body, "Ready for cross-repo review");

  const appendDecision = await request(`/api/workspaces/${groupId}/tasks/append`, "POST", {
    taskId: "task_selection",
    type: "decision",
    decision: "Keep payments contract strict",
    rationale: "Prevent breaking downstream clients"
  });
  assert.equal(appendDecision.status, 200);
  assert.equal(appendDecision.body.task.decisions.length, 1);
  assert.equal(appendDecision.body.task.decisions[0].summary, "Keep payments contract strict");

  // Verify POST /api/workspaces/:workspaceId/receipts
  const receiptRes = await request(`/api/workspaces/${groupId}/receipts`, "POST", {
    taskId: "task_selection",
    projectId: "orders",
    status: "passed",
    kind: "behavior",
    producerId: "test-runner",
    evidenceIds: ["ev_123"]
  });
  assert.equal(receiptRes.status, 200);
  assert.equal(receiptRes.body.receipt.taskId, "task_selection");
  assert.equal(receiptRes.body.receipt.status, "unverified");
  assert.equal(receiptRes.body.receipt.claimedStatus, "passed");
  assert.equal(receiptRes.body.receipt.authority, "advisory");
  assert.equal(receiptRes.body.receipt.producerId, undefined, "caller cannot self-assert a trusted producer");

  console.log("Workspace HTTP auth, additive migration backup, persistence, task selection, idempotency and ownership passed");
} finally {
  if (dashboard) await new Promise((resolve) => dashboard.server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
