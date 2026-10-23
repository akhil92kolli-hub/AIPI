import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openTeamSyncStore } from "../packages/core/team-sync-store.mjs";
import { syncTeamOnce } from "../packages/core/team-sync-client.mjs";
import { startTeamSyncSession } from "../packages/core/team-realtime.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-convergence-"));
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspace = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const taskId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const deviceA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const deviceB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const actorA = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const actorB = "11111111-1111-4111-8111-111111111111";
const commentId = "22222222-2222-4222-8222-222222222222";
const events = [];
let version = 0;
let revoked = false;
const opIds = new Map();

const server = async (url, init) => {
  if (url.endsWith("/snapshot")) {
    const newest = new Map(events.map((event) => [`${event.entity_type}:${event.entity_id}`, event]));
    return Response.json({ cursor: events.at(-1)?.sequence ?? 0,
      entities: [...newest.values()].map((event) => ({ entityType: event.entity_type, entityId: event.entity_id, payload: event.payload })) });
  }
  if (url.includes("/operations/")) {
    const input = JSON.parse(init.body);
    if (revoked && input.deviceId === deviceB) return Response.json({ error: "Team access denied" }, { status: 403 });
    if (opIds.has(input.operationId)) return Response.json({ accepted: { ...opIds.get(input.operationId), was_duplicate: true } });
    if (url.endsWith("/task")) {
      if (input.baseVersion !== version) return Response.json({ error: "Task version changed" }, { status: 409 });
      version += 1;
      const sequence = events.length + 1;
      events.push({ sequence, entity_type: "task", entity_id: taskId, event_type: version === 1 ? "created" : "updated", payload: { ...(events.findLast((event) => event.entity_type === "task")?.payload ?? {}), id: taskId, workspaceId: workspace, externalId: input.externalId, ...input.patch, version } });
      const accepted = { task_id: taskId, task_version: version, change_sequence: sequence };
      opIds.set(input.operationId, accepted);
      return Response.json({ accepted: { ...accepted, was_duplicate: false } });
    }
    assert.equal(input.payload.entityType, "comment");
    const sequence = events.length + 1;
    events.push({ sequence, entity_type: "comment", entity_id: commentId, event_type: "created", payload: { id: commentId, taskId, body: input.payload.body } });
    const accepted = { entity_id: commentId, change_sequence: sequence };
    opIds.set(input.operationId, accepted);
    return Response.json({ accepted: { ...accepted, was_duplicate: false } });
  }
  const after = Number(new URL(url).searchParams.get("after"));
  const page = events.filter((event) => event.sequence > after);
  return Response.json({ events: page, nextCursor: page.at(-1)?.sequence ?? after, hasMore: false });
};

try {
  const a = await openTeamSyncStore(path.join(directory, "a"));
  const b = await openTeamSyncStore(path.join(directory, "b"));
  const enqueue = (store, operationId, deviceId, actorId, entityType, action, baseVersion, payload) => store.enqueue({
    schemaVersion: 1, operationId, organizationId: org, workspaceId: workspace,
    deviceId, actorId, entityType, action, baseVersion, payload,
  });
  const run = (store) => syncTeamOnce(store, { baseUrl: "https://mcp.aipi.website", accessToken: "session", organizationId: org, fetchImpl: server, now: Date.now() + 1000 });
  enqueue(a, "33333333-3333-4333-8333-333333333333", deviceA, actorA, "task", "upsert", 0, { externalId: "task_abcd", title: "First writer" });
  enqueue(b, "44444444-4444-4444-8444-444444444444", deviceB, actorB, "task", "upsert", 0, { externalId: "task_abcd", title: "Concurrent writer" });
  assert.equal((await run(a)).accepted, 1);
  assert.equal((await run(b)).conflicts, 1);
  assert.equal(b.entity(org, "task", taskId).payload.title, "First writer");
  enqueue(b, "55555555-5555-4555-8555-555555555555", deviceB, actorB, "task", "upsert", 1, { externalId: "task_abcd", title: "Resolved together" });
  assert.equal((await run(b)).accepted, 1);
  await run(a);
  assert.equal(a.entity(org, "task", taskId).payload.title, "Resolved together");
  assert.deepEqual(a.entity(org, "task", taskId).payload, b.entity(org, "task", taskId).payload);
  enqueue(b, "66666666-6666-4666-8666-666666666666", deviceB, actorB, "comment", "append", 0, { taskId, body: "Handoff received" });
  assert.equal((await run(b)).accepted, 1);
  await run(a);
  assert.equal(a.entity(org, "comment", commentId).payload.body, "Handoff received");
  revoked = true;
  enqueue(b, "77777777-7777-4777-8777-777777777777", deviceB, actorB, "comment", "append", 0, { taskId, body: "After revocation" });
  assert.equal((await run(b)).conflicts, 1);
  assert.equal(b.operation("77777777-7777-4777-8777-777777777777").status, "conflict");

  let invalidation;
  let syncCalls = 0;
  let removed = false;
  const fakeClient = {
    realtime: { setAuth: async () => {} },
    channel: () => ({ on(_event, _filter, callback) { invalidation = callback; return this; }, subscribe(callback) { callback("SUBSCRIBED"); return this; } }),
    removeChannel: async () => { removed = true; },
  };
  const session = await startTeamSyncSession(a, { organizationId: org, accessToken: "session", intervalMs: 60_000,
    clientFactory: () => fakeClient, sync: async () => { syncCalls += 1; return { pulled: 0 }; } });
  assert.equal(syncCalls, 1);
  invalidation();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(syncCalls, 2, "Realtime invalidation triggers a cursor pull");
  await session.stop();
  assert.equal(removed, true);
  const tokens = [];
  const saved = [];
  let refreshCount = 0;
  const refreshingClient = {
    auth: {
      setSession: async ({ access_token, refresh_token }) => ({ data: { session: { access_token, refresh_token } }, error: null }),
      getSession: async () => ({ data: { session: refreshCount++ === 0
        ? { access_token: "first", refresh_token: "refresh-first" }
        : { access_token: "second", refresh_token: "refresh-second" } }, error: null }),
    },
    realtime: { setAuth: async (token) => { tokens.push(token); } },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: async () => {},
  };
  const refreshed = await startTeamSyncSession(a, {
    organizationId: org, accessToken: "first", refreshToken: "refresh-first", intervalMs: 60_000,
    clientFactory: () => refreshingClient,
    onSession: async (next) => { saved.push(next.refresh_token); },
    sync: async (_store, { accessToken }) => ({ token: accessToken }),
  });
  await refreshed.runNow();
  assert.equal(refreshed.status().result.token, "second", "sync uses the renewed access token");
  assert.deepEqual(saved, ["refresh-second"], "rotated refresh token is persisted");
  assert.deepEqual(tokens, ["first", "second"], "Realtime auth follows the renewed session");
  await refreshed.stop();
  a.close(); b.close();
  console.log("Two devices converge after conflict, append, revocation and Realtime invalidation");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
