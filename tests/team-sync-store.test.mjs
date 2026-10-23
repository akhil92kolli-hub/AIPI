import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openTeamSyncStore } from "../packages/core/team-sync-store.mjs";
import { resolveCachedTeamContext } from "../packages/core/team-sync-context.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-team-sync-"));
const source = path.join(directory, "workspace.json");
const legacy = { projects: [{ id: "prj_abcd", name: "API", repositoryBinding: null, tasks: [{ id: "task_abcd", title: "Inspect endpoint", status: "open" }] }], workspaceGroups: [{ id: "wsg_abcd", name: "Product", version: 1, projectIds: ["prj_abcd"] }] };
await fs.writeFile(source, JSON.stringify(legacy), { mode: 0o600 });
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspace = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const device = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const actor = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const operationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const entityId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
try {
  let store = await openTeamSyncStore(directory);
  assert.ok(store.migrationStatus());
  assert.equal(store.db.prepare("select count(*) as total from legacy_workspaces").get().total, 1);
  assert.equal(store.db.prepare("select count(*) as total from legacy_tasks").get().total, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(`${source}.before-team-sync.json`, "utf8")), legacy);
  store.db.prepare("delete from sync_meta where key = 'legacy_imported'").run();
  store.close();
  await fs.writeFile(source, JSON.stringify({ projects: [], workspaceGroups: [] }), { mode: 0o600 });
  store = await openTeamSyncStore(directory);
  assert.equal(store.db.prepare("select count(*) as total from legacy_workspaces").get().total, 1, "Interrupted import retries from its original backup");
  const envelope = { schemaVersion: 1, operationId, organizationId: org, workspaceId: workspace, deviceId: device, actorId: actor, entityType: "task", action: "upsert", baseVersion: 0, payload: { externalId: "task_abcd", title: "Inspect endpoint" } };
  store.enqueue(envelope);
  store.enqueue(envelope);
  assert.throws(() => store.enqueue({ ...envelope, payload: { externalId: "task_abcd", title: "Different write" } }), /already used/);
  assert.equal(store.dueOperations().length, 1, "Repeated local submission keeps one operation");
  const retry = store.markRetry(operationId, "Offline", Date.parse("2026-10-20T00:00:00Z"));
  assert.equal(retry.attempts, 1);
  assert.equal(retry.last_error, "Offline");
  store.close();

  store = await openTeamSyncStore(directory);
  assert.equal(store.operation(operationId).attempts, 1, "Pending writes survive restart");
  assert.equal(store.db.prepare("select count(*) as total from legacy_workspaces").get().total, 1, "Migration resumes without duplicate rows");
  assert.equal(store.applyRemotePage(org, [{ sequence: 4, entityType: "task", entityId, eventType: "created", payload: { title: "Remote" } }], 4), 4);
  assert.equal(store.entity(org, "task", entityId).payload.title, "Remote");
  assert.throws(() => store.applyRemotePage(org, [{ sequence: 3, entityType: "task", entityId, eventType: "updated", payload: { title: "Old" } }], 3), /reordered/);
  assert.equal(store.cursor(org), 4, "Rejected pages cannot move the cursor back");
  store.applyRemotePage(org, [{ sequence: 8, entityType: "task", entityId, eventType: "deleted" }], 8);
  assert.equal(store.entity(org, "task", entityId).deleted, true);
  store.replaceSnapshot(org, [{ entityType: "task", entityId, payload: { title: "Recovered" } }], 30);
  assert.equal(store.entity(org, "task", entityId).payload.title, "Recovered");
  assert.equal(store.cursor(org), 30);
  assert.equal(store.operation(operationId).status, "pending", "Snapshot recovery retains unacknowledged writes");
  store.markAccepted(operationId);
  assert.equal(store.operation(operationId).status, "accepted");
  store.replaceSnapshot(org, [
    { entityType: "workspace", entityId: workspace, payload: { id: workspace, name: "Product", projects: [{ projectKey: "prj_abcd", repository: "acme/api" }] } },
    { entityType: "task", entityId, payload: { id: entityId, workspaceId: workspace, externalId: "task_abcd", title: "Recovered", status: "open", revisionSet: [{ projectKey: "prj_abcd", commit: "a".repeat(40) }], dependencies: ["task_missing"] } },
    { entityType: "decision", entityId: "11111111-1111-4111-8111-111111111111", payload: { id: "11111111-1111-4111-8111-111111111111", taskId: entityId, body: "Use canonical route" } },
    { entityType: "receipt", entityId: "22222222-2222-4222-8222-222222222222", payload: { id: "22222222-2222-4222-8222-222222222222", taskId: entityId, result: "passed", revisionSet: [{ projectKey: "prj_abcd", commit: "a".repeat(40) }] } },
  ], 31);
  const context = resolveCachedTeamContext(store, org, entityId);
  assert.equal(context.decisions[0].body, "Use canonical route");
  assert.equal(context.receipts[0].freshness, "current");
  assert.equal(context.projects[0].repository, "acme/api");
  assert.deepEqual(context.unresolvedDependencies, ["task_missing"]);
  assert.equal(context.changeCursor, 31);

  // Milestone 3: Delta sync for contracts, graph nodes/edges, and milestones
  const contractId = "33333333-3333-4333-8333-333333333333";
  const nodeId = "44444444-4444-4444-8444-444444444444";
  const edgeId = "55555555-5555-4555-8555-555555555555";
  const milestoneId = "66666666-6666-4666-8666-666666666666";

  const deltaEvents = [
    { sequence: 32, entityType: "contract", entityId: contractId, eventType: "created", payload: { workspaceId: workspace, projectKey: "prj_abcd", method: "GET", route: "/checkout", title: "GET /checkout" } },
    { sequence: 33, entityType: "graph_node", entityId: nodeId, eventType: "created", payload: { workspaceId: workspace, projectKey: "prj_abcd", nodeKey: "checkout-handler", label: "CheckoutHandler", kind: "endpoint" } },
    { sequence: 34, entityType: "graph_edge", entityId: edgeId, eventType: "created", payload: { workspaceId: workspace, from_node_id: nodeId, to_node_id: nodeId, relation: "calls", confirmation_state: "confirmed" } },
    { sequence: 35, entityType: "milestone", entityId: milestoneId, eventType: "created", payload: { workspaceId: workspace, title: "Checkout v2 Release" } },
  ];
  store.applyRemotePage(org, deltaEvents, 35);
  assert.equal(store.cursor(org), 35);

  const cachedContracts = store.entities(org, "contract");
  assert.equal(cachedContracts.length, 1);
  assert.equal(cachedContracts[0].payload.route, "/checkout");

  // Cached projection produces canonical model for offline/local view
  const cachedProj = store.cachedWorkspaceProjection(org, workspace);
  assert.equal(cachedProj.workspace.id, workspace);
  assert.equal(cachedProj.projects[0].name, "acme/api");
  assert.equal(cachedProj.tasks.length, 1);
  assert.equal(cachedProj.contracts.length, 1);
  assert.equal(cachedProj.contracts[0].method, "GET");
  assert.equal(cachedProj.targets.length, 1);
  assert.equal(cachedProj.targets[0].label, "CheckoutHandler");
  assert.equal(cachedProj.graph.edges.length, 1);
  assert.equal(cachedProj.milestones.length, 1);

  // Outbox queuing for graph edge review
  const edgeOpId = "77777777-7777-4777-8777-777777777777";
  store.enqueue({
    schemaVersion: 1,
    operationId: edgeOpId,
    organizationId: org,
    workspaceId: workspace,
    deviceId: device,
    actorId: actor,
    entityType: "graph_edge",
    action: "review",
    baseVersion: 1,
    payload: { edgeId, confirmed: true },
  });
  assert.equal(store.operation(edgeOpId).status, "pending");
  assert.throws(() => store.enqueue({ schemaVersion: 1, operationId: "88888888-8888-4888-8888-888888888888",
    organizationId: org, workspaceId: workspace, deviceId: device, actorId: actor,
    entityType: "contract", action: "upsert", baseVersion: 0, payload: { route: "/checkout" } }), /Unsupported team operation/,
  "Writes without a cloud operation must fail at enqueue rather than becoming stuck in the outbox");

  store.close();
  console.log("Team SQLite migration, outbox restart, retries, cursor, tombstones and snapshot recovery passed");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
