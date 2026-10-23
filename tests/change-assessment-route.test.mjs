import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assessmentFixture } from './helpers/change-assessment-fixture.mjs';

const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-assessment-route-'));
process.env.AIPI_DATA = data;
process.env.AIPI_PORT = '0'; process.env.AIPI_MAX_PORT = '0';
const { mutateState, DATA_FILE } = await import('../scripts/workspace-store.mjs');
const { callToolWithTelemetry: callTool, tools, BOUNDED_MCP_TOOL_DEFINITIONS } = await import('../scripts/api-forge-server.mjs');
const { startDashboard } = await import('../scripts/dashboard-server.mjs');

test('registered MCP and authenticated local API assess actual diffs without running or changing project state', async t => {
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const fixture = await assessmentFixture(t);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = "100"\n');
  await mutateState(state => {
    state.projects = fixture.state.projects;
    state.workspaceGroups = fixture.state.workspaceGroups;
    state.relationshipReviews = fixture.state.relationshipReviews;
    state.activeProjectId = 'orders';
  });
  const before = await fs.readFile(DATA_FILE, 'utf8');
  const definition = tools.find(tool => tool.name === 'assess_workspace_change');
  assert.equal(definition.annotations.readOnlyHint, true);
  assert.ok(BOUNDED_MCP_TOOL_DEFINITIONS.some(tool => tool.name === definition.name));
  const args = { workspace_id: 'wsg_assessment123', project_id: 'orders', base_ref: fixture.input.baseRef, limit: 10 };
  const toolResult = await callTool(definition.name, args);
  assert.equal(toolResult.isError, false, JSON.stringify(toolResult));
  assert.ok(toolResult.structuredContent.components.some(component => component.projectId === 'billing'));
  assert.equal(toolResult.structuredContent.execution.executed, false);
  assert.equal(toolResult.structuredContent.verification.complete, false);
  assert.equal(await fs.readFile(DATA_FILE, 'utf8'), before, 'MCP assessment must not invoke state hydration or persistence');
  const dashboard = await startDashboard({ callTool });
  t.after(() => dashboard.server.close());
  const afterStartup = await fs.readFile(DATA_FILE, 'utf8');
  const url = `${dashboard.url}/api/workspaces/wsg_assessment123/change-assessment`;
  const unauthenticated = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  assert.equal(unauthenticated.status, 401);
  const headers = { authorization: `Bearer ${dashboard.token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${dashboard.url}/change-assessment-view.js`, { headers })).status, 200);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(args) });
  assert.equal(response.status, 200, await response.clone().text());
  const assessment = (await response.json()).assessment;
  assert.equal(assessment.changeId, toolResult.structuredContent.changeId);
  assert.equal(assessment.comparison.snapshotFingerprint, toolResult.structuredContent.comparison.snapshotFingerprint);
  assert.equal(assessment.execution.executed, false);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...args, workspace_id: 'wsg_other' }) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...args, limit: 0 }) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...args, mode: 'unreviewed' }) })).status, 400);
  assert.equal((await callTool(definition.name, { ...args, project_id: 'foreign-project' })).isError, true);
  assert.equal((await callTool(definition.name, { ...args, root: '/arbitrary/path' })).isError, true);
  assert.equal((await callTool(definition.name, { ...args, limit: 0 })).isError, true);
  const bounded = await callTool(definition.name, { ...args, limit: 1 });
  assert.equal(bounded.structuredContent.components.length, 1);
  assert.ok(bounded.structuredContent.omitted.components > 0);
  assert.equal(await fs.readFile(DATA_FILE, 'utf8'), afterStartup, 'read-only assessment must not persist source scans, tasks, approvals or receipts');

  await mutateState(state => {
    state.projects.find(project => project.id === 'orders').verification = {
      testCommand: { command: 'node', args: ['-e', 'process.exit(3)'], cwd: '.', timeoutMs: 10_000 },
    };
  });
  const reviewUrl = `${url}/review`, executeUrl = `${url}/execute`;
  assert.equal((await fetch(reviewUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })).status, 401);
  assert.equal((await fetch(executeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })).status, 401);
  const reviewResponse = await fetch(reviewUrl, { method: 'POST', headers, body: JSON.stringify(args) });
  assert.equal(reviewResponse.status, 200, await reviewResponse.clone().text());
  const review = (await reviewResponse.json()).review;
  assert.ok(review.checks.length > 0);
  assert.ok(review.gaps.some(gap => gap.includes('no configured')));
  const packageUrl = `${url}/package`;
  assert.equal((await fetch(packageUrl, { method: 'POST', headers,
    body: JSON.stringify({ ...args, review_hash: review.reviewHash }) })).status, 400);
  assert.equal((await fetch(packageUrl, { method: 'POST', headers,
    body: JSON.stringify({ ...args, review_hash: 'sha256:wrong', share_source: true }) })).status, 409);
  const packageResponse = await fetch(packageUrl, { method: 'POST', headers,
    body: JSON.stringify({ ...args, review_hash: review.reviewHash, share_source: true }) });
  assert.equal(packageResponse.status, 200, await packageResponse.clone().text());
  const manifest = (await packageResponse.json()).manifest;
  assert.equal(manifest.sourceReproducible, false, 'dirty source requires an approved content snapshot');
  assert.equal(manifest.complete, false);
  assert.doesNotMatch(JSON.stringify(manifest), /aipi-assessment-/);
  assert.equal((await fetch(executeUrl, { method: 'POST', headers,
    body: JSON.stringify({ ...args, review_hash: 'sha256:wrong' }) })).status, 409);
  const runResponse = await fetch(executeUrl, { method: 'POST', headers,
    body: JSON.stringify({ ...args, review_hash: review.reviewHash }) });
  assert.equal(runResponse.status, 200, await runResponse.clone().text());
  const run = await runResponse.json();
  assert.ok(run.run.receipts.length > 0);
  assert.ok(run.run.receipts.every(receipt => receipt.status === 'failed'));
  assert.equal(run.assessment.verification.status, 'failed');
  assert.ok(run.assessment.components.some(component => component.coverage?.checks?.some(check => check.status === 'failed')));
  assert.ok((await fs.readFile(path.join(data, 'assessment-evidence.key'), 'utf8')).length === 64);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(data, 'assessment-evidence.key'))).mode & 0o077, 0);
  const persisted = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  assert.equal(persisted.changeVerificationReceipts.length, run.run.receipts.length);
  assert.equal(persisted.changeVerificationEvidence.length, run.run.receipts.length);
  const freshTool = await callTool(definition.name, args);
  assert.equal(freshTool.structuredContent.verification.status, 'failed', 'MCP reads the same signed evidence');
});
