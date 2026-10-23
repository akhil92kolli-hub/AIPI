import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-team-status-"));
process.env.AIPI_DATA = path.join(temp, "data");
process.env.AIPI_PORT = "0";
process.env.AIPI_MAX_PORT = "0";
const { startDashboard } = await import("../scripts/dashboard-server.mjs");
const { openTeamSyncStore } = await import("../packages/core/team-sync-store.mjs");
const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workspaceA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const workspaceB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const device = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const actor = "ffffffff-ffff-4fff-8fff-ffffffffffff";
let dashboard;
let store;
try {
  dashboard = await startDashboard();
  store = await openTeamSyncStore(process.env.AIPI_DATA);
  for (const [organizationId, workspaceId, projectId, operationId] of [
    [orgA, workspaceA, "prj_alpha", "11111111-1111-4111-8111-111111111111"],
    [orgB, workspaceB, "prj_beta", "22222222-2222-4222-8222-222222222222"],
  ]) {
    store.saveProjectLink(projectId, organizationId, workspaceId, device, actor);
    store.enqueue({ schemaVersion: 1, operationId, organizationId, workspaceId, deviceId: device,
      actorId: actor, entityType: "task", action: "patch", baseVersion: 0,
      payload: { externalId: `task-${projectId}`, patch: { title: projectId } } });
  }
  const status = async (query) => {
    const response = await fetch(`${dashboard.url}/api/team-sync/status?${query}`, {
      headers: { authorization: `Bearer ${dashboard.token}` },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await status("")).pending, 2);
  assert.equal((await status(`organizationId=${orgA}`)).pending, 1);
  const alpha = await status("projectId=prj_alpha");
  assert.equal(alpha.pending, 1);
  assert.equal(alpha.link.organizationId, orgA);
  assert.equal(alpha.sessionActive, false);
  assert.equal(alpha.realtime, null, "one account does not inherit another account's status");
  assert.equal((await status("projectId=prj_beta")).link.organizationId, orgB);
  assert.equal((await fetch(`${dashboard.url}/api/team-sync/status`)).status, 401);
  const malformedDisconnect = await fetch(`${dashboard.url}/api/team-sync/disconnect`, {
    method: "POST", headers: { authorization: `Bearer ${dashboard.token}`, "content-type": "application/json" },
    body: JSON.stringify({ organizationId: "unknown" }),
  });
  assert.equal(malformedDisconnect.status, 400);
  console.log("Team sync status scopes pending operations and session state to the selected account");
} finally {
  store?.close();
  if (dashboard) await new Promise((resolve) => dashboard.server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
