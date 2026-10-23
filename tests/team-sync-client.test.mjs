import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openTeamSyncStore } from "../packages/core/team-sync-store.mjs";
import { syncTeamOnce } from "../packages/core/team-sync-client.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-sync-client-"));
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspace = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const device = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const actor = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const operationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const taskId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
try {
  const store = await openTeamSyncStore(directory);
  store.enqueue({ schemaVersion: 1, operationId, organizationId: org, workspaceId: workspace, deviceId: device, actorId: actor, entityType: "task", action: "upsert", baseVersion: 0, payload: { externalId: "task_abcd", title: "Offline task" } });
  const startedAt = Date.now() + 1000;
  let submissions = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer user-session");
    if (url.endsWith("/snapshot")) return Response.json({ cursor: 0, entities: [] });
    if (url.includes("/operations/task")) {
      submissions += 1;
      assert.equal(JSON.parse(init.body).operationId, operationId);
      if (submissions === 1) throw new Error("Acknowledgment lost");
      return Response.json({ accepted: { task_id: taskId, task_version: 1, change_sequence: 5, was_duplicate: true } });
    }
    if (url.includes("changes?after=0")) return Response.json({ events: [{ sequence: 5, entity_type: "task", entity_id: taskId, event_type: "created", payload: { id: taskId, title: "Offline task" } }], nextCursor: 5, hasMore: false });
    return Response.json({ events: [], nextCursor: 5, hasMore: false });
  };
  const first = await syncTeamOnce(store, { baseUrl: "https://mcp.aipi.website", accessToken: "user-session", organizationId: org, fetchImpl, now: startedAt });
  assert.equal(first.retried, 1);
  assert.equal(first.pulled, 1);
  assert.equal(store.operation(operationId).status, "pending");
  const second = await syncTeamOnce(store, { baseUrl: "https://mcp.aipi.website", accessToken: "user-session", organizationId: org, fetchImpl, now: startedAt + 2000 });
  assert.equal(second.accepted, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(store.operation(operationId).status, "accepted");
  assert.equal(store.entity(org, "task", taskId).payload.title, "Offline task");
  store.close();
  console.log("Team sync recovered a lost acknowledgment without duplicate writes");

  const recovery = await openTeamSyncStore(path.join(directory, "recovery"));
  recovery.applyRemotePage(org, [{ sequence: 2, entityType: "task", entityId: taskId, eventType: "created", payload: { title: "Stale" } }], 2);
  const staleFetch = async (url) => {
    if (url.includes("changes?after=2")) return Response.json({ error: "Cursor expired" }, { status: 410 });
    if (url.endsWith("/snapshot")) return Response.json({ cursor: 8, entities: [{ entityType: "task", entityId: taskId, payload: { title: "Recovered", version: 3 } }] });
    if (url.includes("changes?after=8")) return Response.json({ events: [{ sequence: 9, entity_type: "task", entity_id: taskId, event_type: "updated", payload: { title: "Current", version: 4 } }], nextCursor: 9, hasMore: false });
    throw new Error(`Unexpected request: ${url}`);
  };
  const recovered = await syncTeamOnce(recovery, { baseUrl: "https://mcp.aipi.website", accessToken: "user-session", organizationId: org, fetchImpl: staleFetch });
  assert.equal(recovered.snapshots, 1);
  assert.equal(recovered.cursor, 9);
  assert.equal(recovery.entity(org, "task", taskId).payload.title, "Current");
  const stuckFetch = async (url) => url.endsWith("/snapshot")
    ? Response.json({ cursor: 9, entities: [] })
    : Response.json({ error: "Cursor expired" }, { status: 410 });
  const stuck = await syncTeamOnce(recovery, { baseUrl: "https://mcp.aipi.website", accessToken: "user-session", organizationId: org, fetchImpl: stuckFetch });
  assert.equal(stuck.snapshots, 1);
  assert.match(stuck.error, /did not advance/);
  recovery.replaceSnapshot(org, [{ entityType: "task", entityId: taskId, payload: { title: "Private team context" } }], 10);
  const denied = await syncTeamOnce(recovery, { baseUrl: "https://mcp.aipi.website", accessToken: "user-session", organizationId: org,
    fetchImpl: async () => Response.json({ error: "Team access denied" }, { status: 403 }) });
  assert.match(denied.error, /denied/);
  assert.equal(recovery.entity(org, "task", taskId), null, "Revoked membership removes cached shared data");
  recovery.close();
  console.log("Team sync replaced an expired cursor from a snapshot and resumed changes");

  // Test graph edge review outbox dispatch
  const graphReviewStore = await openTeamSyncStore(path.join(directory, "graph-review"));
  const edgeOpId = "12121212-1212-4212-8212-121212121212";
  const edgeId = "34343434-3434-4434-8434-343434343434";
  graphReviewStore.enqueue({
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
  let edgeReviewCalled = false;
  const edgeFetch = async (url, init) => {
    if (url.includes(`/graph/edges/${edgeId}/review`)) {
      edgeReviewCalled = true;
      assert.deepEqual(JSON.parse(init.body), { schemaVersion: 1, operationId: edgeOpId,
        deviceId: device, baseVersion: 1, confirm: true });
      return Response.json({ review: { id: edgeId, confirmationState: "confirmed",
        version: 2, operationId: edgeOpId, wasDuplicate: false } });
    }
    if (url.endsWith("/snapshot")) return Response.json({ cursor: 0, entities: [] });
    return Response.json({ events: [], nextCursor: 0, hasMore: false });
  };
  const edgeSyncResult = await syncTeamOnce(graphReviewStore, {
    baseUrl: "https://mcp.aipi.website",
    accessToken: "user-session",
    organizationId: org,
    fetchImpl: edgeFetch,
  });
  assert.equal(edgeReviewCalled, true);
  assert.equal(edgeSyncResult.accepted, 1);
  assert.equal(graphReviewStore.operation(edgeOpId).status, "accepted");
  const staleReviewId = "56565656-5656-4656-8656-565656565656";
  graphReviewStore.enqueue({ schemaVersion: 1, operationId: staleReviewId,
    organizationId: org, workspaceId: workspace, deviceId: device, actorId: actor,
    entityType: "graph_edge", action: "review", baseVersion: 1,
    payload: { edgeId, confirmed: false } });
  const staleResult = await syncTeamOnce(graphReviewStore, {
    baseUrl: "https://mcp.aipi.website", accessToken: "user-session", organizationId: org,
    fetchImpl: async (url) => url.includes(`/graph/edges/${edgeId}/review`)
      ? Response.json({ error: "GRAPH_REVIEW_VERSION_CONFLICT" }, { status: 409 })
      : url.endsWith("/snapshot") ? Response.json({ cursor: 0, entities: [] })
        : Response.json({ events: [], nextCursor: 0, hasMore: false }),
  });
  assert.equal(staleResult.conflicts, 1);
  assert.equal(graphReviewStore.operation(staleReviewId).status, "conflict",
    "A delayed review must not be retried into overwriting a newer decision");
  const incompleteAckId = "78787878-7878-4878-8878-787878787878";
  graphReviewStore.enqueue({ schemaVersion: 1, operationId: incompleteAckId,
    organizationId: org, workspaceId: workspace, deviceId: device, actorId: actor,
    entityType: "graph_edge", action: "review", baseVersion: 2,
    payload: { edgeId, confirmed: false } });
  const incompleteAck = await syncTeamOnce(graphReviewStore, {
    baseUrl: "https://mcp.aipi.website", accessToken: "user-session", organizationId: org,
    fetchImpl: async (url) => url.includes(`/graph/edges/${edgeId}/review`)
      ? Response.json({ review: { id: edgeId, confirmationState: "rejected", version: 3 } })
      : url.endsWith("/snapshot") ? Response.json({ cursor: 0, entities: [] })
        : Response.json({ events: [], nextCursor: 0, hasMore: false }),
  });
  assert.equal(incompleteAck.retried, 1);
  assert.equal(graphReviewStore.operation(incompleteAckId).status, "pending",
    "A graph response without the submitted operation ID cannot acknowledge the write");
  graphReviewStore.close();
  console.log("Team sync dispatched graph edge review outbox operations");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
