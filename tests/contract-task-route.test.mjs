import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-contract-task-'));
process.env.AIPI_DATA = temp;
process.env.AIPI_PORT = '0';
process.env.AIPI_MAX_PORT = '0';
const { mutateState, loadState } = await import('../scripts/workspace-store.mjs');
const { startDashboard } = await import('../scripts/dashboard-server.mjs');
let dashboard;
try {
  await mutateState(state => {
    state.projects = [{ id: 'test-project', name: 'Contract task test', requests: [], tasks: [], environments: [], sourceContext: { endpoints: [{ id: 'handler', method: 'GET', path: '/health', source: 'server.ts', line: 2 }], git: [], findings: [] } }];
    state.activeProjectId = 'test-project';
  });
  const contract = (await loadState()).projects[0].contracts[0];
  dashboard = await startDashboard({ executeRequest() { throw new Error('Task generation must not execute requests'); }, callTool() { throw new Error('Task generation must not dispatch an agent'); } });
  const url = `http://127.0.0.1:${dashboard.port}/api/projects/test-project/contracts/${contract.id}/task-draft`;
  const headers = { authorization: `Bearer ${dashboard.token}` };
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const first = await fetch(url, { method: 'POST', headers });
  assert.equal(first.status, 201);
  const result = await first.json();
  assert.equal(result.task.status, 'proposed');
  assert.deepEqual(result.task.artifactIds, ['endpoint:handler']);
  const second = await fetch(url, { method: 'POST', headers });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).task.id, result.task.id);
  assert.equal((await loadState()).projects[0].tasks.length, 1);
  console.log('Contract task route: authorization, persistence and deduplication passed');
} finally {
  if (dashboard) await new Promise(resolve => dashboard.server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
