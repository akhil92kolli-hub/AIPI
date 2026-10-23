import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openTeamSyncStore } from "../packages/core/team-sync-store.mjs";
import { rememberLinkedTasks, reconcileLocalTeamTasks } from "../packages/core/team-local-reconcile.mjs";
import { teamProjectPreview, teamTaskExternalId } from "../packages/core/team-onboarding.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-local-team-"));
const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deviceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const actorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const projectKey = "prj_orders";
const task = { id: "task_checkout", title: "Fix checkout", status: "open", description: "private source notes" };
const state = { projects: [{ id: projectKey, name: "Orders", tasks: [task] }] };
try {
  const store = await openTeamSyncStore(directory);
  store.saveProjectLink(projectKey, organizationId, workspaceId, deviceId, actorId);
  rememberLinkedTasks(store, teamProjectPreview(state, projectKey));
  assert.equal(reconcileLocalTeamTasks(store, state).queued, 0);
  const externalId = teamTaskExternalId(organizationId, workspaceId, projectKey, task.id);
  const cloudId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  store.replaceSnapshot(organizationId, [{ entityType: "task", entityId: cloudId,
    payload: { id: cloudId, workspaceId, externalId, title: task.title, status: "open", description: "cloud context", revisionSet: [{projectKey, commit:"a".repeat(40)}], version: 1 } }], 1);
  task.title = "Fix checkout retry";
  const firstEdit = reconcileLocalTeamTasks(store, state);
  assert.equal(firstEdit.queued, 1);
  assert.deepEqual(firstEdit.organizationIds, [organizationId]);
  const pending = store.dueOperationsFor(organizationId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].base_version, 1);
  assert.equal(pending[0].action, "patch");
  assert.deepEqual(pending[0].payload.patch, {title:task.title});
  assert.doesNotMatch(JSON.stringify(pending[0].payload), /private source notes/);
  task.status = "done";
  assert.equal(reconcileLocalTeamTasks(store, state).waiting, 1, "newer edits wait while the preceding write is unacknowledged");
  store.markAccepted(pending[0].operation_id);
  store.applyRemotePage(organizationId, [{ sequence: 2, entityType: "task", entityId: cloudId,
    eventType: "updated", payload: { id: cloudId, workspaceId, externalId, title: "Fix checkout retry", status: "open", description: "cloud context", revisionSet: [{projectKey, commit:"a".repeat(40)}], version: 2 } }], 2);
  assert.equal(reconcileLocalTeamTasks(store, state).queued, 1);
  assert.equal(store.dueOperationsFor(organizationId)[0].base_version, 2);
  assert.deepEqual(store.dueOperationsFor(organizationId)[0].payload.patch, {status:"completed"});
  store.close();
  console.log("Local task edits enter the durable team outbox with cloud versions and metadata-only payloads");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
