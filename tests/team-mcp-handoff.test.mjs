import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTeamSyncStore } from '../packages/core/team-sync-store.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-team-mcp-'));
process.env.AIPI_DATA = dataDir;
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const taskId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
try {
  const store = await openTeamSyncStore(dataDir);
  store.replaceSnapshot(organizationId, [
    { entityType: 'workspace', entityId: workspaceId, payload: { id: workspaceId, name: 'Handoff', projects: [{ projectKey: 'prj_orders', repository: 'acme/orders' }] } },
    { entityType: 'task', entityId: taskId, payload: { id: taskId, workspaceId, externalId: 'task_checkout', title: 'Trace checkout', revisionSet: [], dependencies: [] } },
  ], 7);
  store.close();
  const { callTool, tools } = await import('../scripts/api-forge-server.mjs');
  assert.ok(tools.some((tool) => tool.name === 'resolve_cached_team_task_context'));
  const result = await callTool('resolve_cached_team_task_context', { organization_id: organizationId, task_id: taskId });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.context.task.title, 'Trace checkout');
  assert.equal(result.structuredContent.context.projects[0].repository, 'acme/orders');
  assert.equal(result.structuredContent.context.changeCursor, 7);
  console.log('Local MCP agent resolves synchronized team task and repository context');
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
