import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assessLocalWorkspaceChange } from '../packages/core/change-assessment.mjs';

import { assessmentFixture } from './helpers/change-assessment-fixture.mjs';

const execute = promisify(execFile);

test('actual Python diff reaches React and Billing through reviewed dependencies with explicit missing checks', async t => {
  const fixture = await assessmentFixture(t);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = "100"\n');
  const before = structuredClone(fixture.state);
  const result = await assessLocalWorkspaceChange(fixture.input);
  assert.equal(result.comparison.dirty, true); assert.equal(result.comparison.files[0].path, 'app.py');
  assert.deepEqual([...new Set(result.components.map(item => item.projectId))].sort(), ['billing', 'orders', 'storefront']);
  assert.ok(result.components.some(item => item.projectId === 'orders' && item.kind === 'api' && item.changed));
  assert.ok(result.components.some(item => item.projectId === 'orders' && item.kind === 'api'
    && item.changeLocation === 'indexed-line-overlap'));
  for (const item of result.components.filter(item => item.projectId !== 'orders')) {
    assert.equal(item.confidence, 'inferred', 'source edits invalidate the old reviewed dependency fingerprint');
    assert.ok(item.paths.some(chain => chain.some(hop => hop.evidenceKind === 'declared' && hop.stale)));
    assert.ok(item.source.path === 'Checkout.tsx' || item.source.path === 'app.py');
  }
  assert.ok(result.ledger.components.every(item => item.checks.some(check => check.status === 'missing')));
  assert.equal(result.ledger.complete, false); assert.equal(result.execution.executed, false);
  assert.equal(result.revisionSet.length, 3); assert.equal(result.contractRevisions.length, 1);
  assert.deepEqual(fixture.state, before, 'assessment must not edit tasks, source indexes, reviews or receipts');
  assert.doesNotMatch(JSON.stringify(result), /total =|Fixture reviewer|Explicit fixture|aipi-assessment-/);
});

test('a registered source binding is the revision identity even when a legacy root ID exists', async t => {
  const fixture = await assessmentFixture(t);
  const orders = fixture.state.projects.find(item => item.id === 'orders');
  orders.sourceContext.roots[0].sourceBindingId = 'src_ordersprimary';
  orders.sourceBindings = [{ id: 'src_ordersprimary', kind: 'local', name: 'Orders source', version: 1 }];
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = 200\n');
  const result = await assessLocalWorkspaceChange(fixture.input);
  assert.equal(result.revisionSet.find(item => item.projectId === 'orders').resourceId, 'src_ordersprimary');
  assert.ok(result.components.filter(item => item.projectId === 'orders').every(item =>
    item.requirements[0].target.revisionSet.some(pin => pin.projectId === 'orders' && pin.resourceId === 'src_ordersprimary')));
});

test('baseline-matched Python handler ranges identify changed symbols without hiding same-file candidates', async t => {
  const fixture = await assessmentFixture(t);
  const baseline = "@app.get('/orders')\ndef orders():\n    return {'total': 100}\n\n@app.get('/health')\ndef health():\n    return {'ok': True}\n";
  await fs.writeFile(path.join(fixture.root, 'app.py'), baseline);
  await execute('git', ['-C', fixture.root, 'add', 'app.py']);
  await execute('git', ['-C', fixture.root, 'commit', '-qm', 'indexed handlers']);
  const revision = (await execute('git', ['-C', fixture.root, 'rev-parse', 'HEAD'])).stdout.trim();
  const project = fixture.state.projects.find(item => item.id === 'orders');
  const contentHash = crypto.createHash('sha256').update(baseline).digest('hex');
  project.sourceContext.gitRevision = revision;
  project.sourceContext.endpoints = [
    { id: 'shared-endpoint-id', method: 'GET', path: '/orders', root: fixture.root, source: 'app.py', line: 1, endLine: 3, rangeMethod: 'python-indentation-heuristic', contentHash },
    { id: 'health-endpoint-id', method: 'GET', path: '/health', root: fixture.root, source: 'app.py', line: 5, endLine: 7, rangeMethod: 'python-indentation-heuristic', contentHash },
  ];
  project.contracts[0].implementation.line = 1;
  project.contracts.push({ id: 'health-contract', method: 'GET', route: '/health', currentRevisionId: 'v1',
    sourceArtifactIds: ['health-endpoint-id'], implementation: { root: fixture.root, source: 'app.py', line: 5 } });
  fixture.input.baseRef = revision;
  await fs.writeFile(path.join(fixture.root, 'app.py'), baseline.replace("'total': 100", "'total': '100'"));
  const result = await assessLocalWorkspaceChange(fixture.input);
  const orders = result.components.filter(item => item.projectId === 'orders');
  assert.equal(result.comparison.files[0].baselineContentHash, contentHash);
  assert.ok(orders.some(item => item.label.includes('/orders') && item.changeLocation === 'indexed-symbol-overlap'));
  assert.ok(orders.some(item => item.label.includes('/orders') && item.source.rangeMethod === 'python-indentation-heuristic'));
  assert.ok(orders.some(item => item.label.includes('/health') && item.changeLocation === 'file-association'));
  project.sourceContext.endpoints[0].contentHash = '0'.repeat(64);
  const stale = await assessLocalWorkspaceChange(fixture.input);
  assert.ok(stale.components.some(item => item.kind === 'endpoint' && item.label.includes('/orders')
    && item.changeLocation === 'file-association'));
});

test('staged assessment retains only index changes and pins the index snapshot', async t => {
  const fixture = await assessmentFixture(t);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = 200\n');
  await execute('git', ['-C', fixture.root, 'add', 'app.py']);
  const first = await assessLocalWorkspaceChange({ ...fixture.input, mode: 'staged' });
  assert.equal(first.comparison.mode, 'staged');
  assert.ok(first.components.some(item => item.kind === 'api' && item.changed));
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = 300\n');
  await fs.writeFile(path.join(fixture.root, 'untracked.py'), 'new = True\n');
  const second = await assessLocalWorkspaceChange({ ...fixture.input, mode: 'staged' });
  assert.equal(second.comparison.snapshotFingerprint, first.comparison.snapshotFingerprint);
  assert.equal(second.components[0].requirements[0].target.planHash,
    first.components[0].requirements[0].target.planHash);
  assert.ok(!second.comparison.files.some(file => file.path === 'untracked.py'));
  await execute('git', ['-C', fixture.root, 'add', 'app.py']);
  const third = await assessLocalWorkspaceChange({ ...fixture.input, mode: 'staged' });
  assert.notEqual(third.comparison.snapshotFingerprint, first.comparison.snapshotFingerprint);
  assert.notEqual(third.components[0].requirements[0].target.planHash,
    first.components[0].requirements[0].target.planHash);
});

test('unstaged assessment selects index-to-worktree differences without including untracked paths', async t => {
  const fixture = await assessmentFixture(t);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = 200\n');
  await execute('git', ['-C', fixture.root, 'add', 'app.py']);
  const stagedOnly = await assessLocalWorkspaceChange({ ...fixture.input, mode: 'unstaged' });
  assert.deepEqual(stagedOnly.comparison.files, []);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = 300\n');
  await fs.writeFile(path.join(fixture.root, 'untracked.py'), 'new = True\n');
  const result = await assessLocalWorkspaceChange({ ...fixture.input, mode: 'unstaged' });
  const combined = await assessLocalWorkspaceChange(fixture.input);
  assert.equal(result.comparison.mode, 'unstaged');
  assert.deepEqual(result.comparison.files.map(file => file.path), ['app.py']);
  assert.ok(result.components.some(item => item.kind === 'api' && item.changed));
  assert.equal(result.ledger.complete, false);
  assert.notEqual(result.comparison.snapshotFingerprint, stagedOnly.comparison.snapshotFingerprint);
  assert.notEqual(result.components[0].requirements[0].target.planHash,
    combined.components[0].requirements[0].target.planHash, 'comparison modes must not share a receipt target');
});

test('assessment identity survives further edits but its plan target changes; sibling edits invalidate the target too', async t => {
  const fixture = await assessmentFixture(t);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = "100"\n');
  const first = await assessLocalWorkspaceChange(fixture.input);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = "200"\n');
  const second = await assessLocalWorkspaceChange(fixture.input);
  assert.equal(first.changeId, second.changeId);
  assert.notEqual(first.components[0].requirements[0].target.planHash, second.components[0].requirements[0].target.planHash);
  await fs.writeFile(path.join(fixture.temp, 'billing', 'app.py'), 'total = 200\n');
  const third = await assessLocalWorkspaceChange(fixture.input);
  assert.notEqual(second.components[0].requirements[0].target.planHash, third.components[0].requirements[0].target.planHash);
});

test('denied project data is excluded before review freshness, traversal and output', async t => {
  const fixture = await assessmentFixture(t);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = "100"\n');
  const result = await assessLocalWorkspaceChange({ ...fixture.input, canReadProject: id => id !== 'billing' });
  assert.ok(result.analysis.gaps.some(item => item.includes('inaccessible')));
  assert.equal(result.ledger.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /billing/);
  await assert.rejects(assessLocalWorkspaceChange({ ...fixture.input, canReadProject: () => false }), /unavailable/);
});

test('unmapped paths, rejected reviews and ambiguous IDs cannot manufacture relationships', async t => {
  const fixture = await assessmentFixture(t);
  await fs.writeFile(path.join(fixture.root, 'unknown.py'), 'mystery = True\n');
  let result = await assessLocalWorkspaceChange(fixture.input);
  assert.ok(result.unmappedFiles.includes('unknown.py')); assert.equal(result.components.length, 0); assert.equal(result.ledger.complete, false);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = "100"\n');
  fixture.state.relationshipReviews.forEach(review => { review.status = 'rejected'; });
  result = await assessLocalWorkspaceChange(fixture.input);
  assert.ok(result.components.every(item => item.projectId === 'orders'));
  assert.equal(result.revisionSet.length, 3, 'namespace is preserved even when graph links are rejected');
});

test('configuration supplies only a candidate; absent current evidence stays unproven', async t => {
  const fixture = await assessmentFixture(t);
  fixture.state.projects[0].verification = { testCommand: { command: 'python3', args: ['-m', 'unittest'] } };
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = "100"\n');
  const result = await assessLocalWorkspaceChange(fixture.input);
  assert.ok(result.components.filter(item => item.projectId === 'orders').every(item => item.candidateCheck?.relevance === 'unassessed'));
  assert.equal(result.ledger.complete, false);
  assert.ok(result.ledger.components[0].checks.every(check => check.status !== 'passed'));
  assert.doesNotMatch(JSON.stringify(result), /python3|unittest/);
});
