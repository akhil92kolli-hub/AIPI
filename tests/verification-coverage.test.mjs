import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVerificationCoverageLedger as build } from '../packages/core/verification-coverage.mjs';

const pin = (projectId = 'orders') => ({ projectId, resourceId: 'repository', commit: 'commit-a', dirty: false });
const target = (projectId = 'orders') => ({ planHash: 'plan-v1', checkFingerprint: 'check-v1',
  environmentId: 'development', environmentFingerprint: 'env-v1', revisionSet: [pin(projectId)], contractRevisions: [] });
const requirement = (projectId = 'orders') => ({ id: 'consumer-test', kind: 'behavior', target: target(projectId) });
const component = (projectId = 'orders') => ({ projectId, componentId: 'checkout', confidence: 'confirmed', requirements: [requirement(projectId)] });
const receipt = (projectId = 'orders', overrides = {}) => ({ id: `receipt-${projectId}`, workspaceId: 'commerce', changeId: 'change-1',
  projectId, componentId: 'checkout', requirementId: 'consumer-test', producerId: 'authorized-test-runner',
  target: target(projectId), completedAt: '2026-10-21T12:00:00Z', kind: 'behavior', status: 'passed', evidenceIds: ['evidence-1'], ...overrides });
const input = (overrides = {}) => ({ workspaceId: 'commerce', changeId: 'change-1', evaluatedAt: '2026-10-21T13:00:00Z',
  analysis: { complete: true, gaps: [] }, components: [component()], receipts: [receipt()],
  canReadProject: () => true, acceptReceipt: record => record.producerId === 'authorized-test-runner', ...overrides });
const row = value => value.components[0].checks[0];

test('exact accepted evidence passes without mutating inputs or exposing executor fields', () => {
  const value = input(); value.receipts[0].stdout = 'sensitive log';
  value.receipts[0].target.environmentValues = { TOKEN: 'sensitive value' };
  const before = structuredClone({ components: value.components, receipts: value.receipts });
  const result = build(value);
  assert.equal(result.status, 'passed'); assert.equal(result.complete, true);
  assert.equal(result.allRequiredChecksPassed, true); assert.equal(result.counts.passed, 1);
  assert.deepEqual({ components: value.components, receipts: value.receipts }, before);
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
});

test('React consumer pass, Python producer failure and unconfigured Billing stay separate', () => {
  const orders = receipt('orders', { status: 'failed' });
  const result = build(input({ components: [component('react'), component('orders'), { ...component('billing'), requirements: [] }],
    receipts: [receipt('react'), orders] }));
  assert.deepEqual(result.components.map(item => item.status), ['passed', 'failed', 'missing']);
  assert.equal(result.status, 'failed'); assert.equal(result.complete, false);
});

test('no scope, no checks, optional checks and indexing-only checks cannot imply behavioral completion', () => {
  assert.equal(build(input({ components: [] })).complete, false);
  assert.equal(build(input({ components: [{ ...component(), requirements: [] }] })).status, 'missing');
  assert.equal(build(input({ components: [{ ...component(), requirements: [{ ...requirement(), required: false }] }] })).complete, false);
  const structure = { ...requirement(), kind: 'structure' };
  const result = build(input({ components: [{ ...component(), requirements: [structure] }], receipts: [receipt('orders', { kind: 'structure' })] }));
  assert.equal(result.status, 'missing'); assert.equal(result.components[0].checks.at(-1).kind, 'behavior');
  assert.equal(build(input({ components: [{ ...component(), requiresBehavior: false, requirements: [structure] }], receipts: [receipt('orders', { kind: 'structure' })] })).status, 'passed');
  assert.equal(build(input({ receipts: [receipt('orders', { kind: 'structure' })] })).status, 'unknown');
  assert.equal(build(input({ receipts: [receipt('orders', { status: 'recorded', type: 'baseline-index', evidenceIds: [] })] })).status, 'unknown');
});

test('every execution-target dimension invalidates prior proof, including a dirty edit at the same commit', () => {
  for (const change of [
    t => { t.planHash = 'plan-v2'; }, t => { t.checkFingerprint = 'different-command'; },
    t => { t.environmentId = 'staging'; }, t => { t.environmentFingerprint = 'new-env'; },
    t => { t.revisionSet[0].commit = 'commit-b'; },
    t => { t.revisionSet[0].dirty = true; t.revisionSet[0].workingTreeFingerprint = 'dirty-a'; },
    t => { t.revisionSet.push(pin('billing')); },
    t => { t.contractRevisions.push({ projectId: 'orders', resourceId: 'repository', contractId: 'order', revisionId: 'contract-b' }); },
  ]) {
    const value = input(); change(value.components[0].requirements[0].target);
    assert.equal(build(value).status, 'stale');
  }
  const value = input();
  for (const t of [value.components[0].requirements[0].target, value.receipts[0].target]) {
    t.revisionSet[0].dirty = true; t.revisionSet[0].workingTreeFingerprint = 'dirty-a';
  }
  assert.equal(build(value).status, 'passed');
  value.components[0].requirements[0].target.revisionSet[0].workingTreeFingerprint = 'dirty-b';
  assert.equal(build(value).status, 'stale');
});

test('revision and contract pin ordering is immaterial; duplicate or unqualified pins are unknown', () => {
  const value = input();
  for (const t of [value.components[0].requirements[0].target, value.receipts[0].target]) {
    t.revisionSet.push(pin('react'));
    t.contractRevisions.push(...['orders', 'react'].map(projectId => ({ projectId, resourceId: 'repository', contractId: 'shared-id', revisionId: 'v1' })));
  }
  value.receipts[0].target.revisionSet.reverse(); value.receipts[0].target.contractRevisions.reverse();
  assert.equal(build(value).status, 'passed');
  value.components[0].requirements[0].target.revisionSet.push(pin());
  assert.equal(build(value).status, 'unknown');
  const unqualified = input(); delete unqualified.receipts[0].target.revisionSet[0].resourceId;
  assert.equal(build(unqualified).status, 'unknown');
});

test('receipt namespace is workspace + change + project + component + requirement', () => {
  for (const field of ['workspaceId', 'changeId', 'projectId', 'componentId', 'requirementId']) {
    const value = input(); value.receipts[0][field] = 'different';
    assert.equal(build(value).status, 'missing', field);
  }
  const value = input({ components: [component('orders'), component('billing')], receipts: [receipt('orders')] });
  assert.deepEqual(build(value).components.map(item => item.status), ['passed', 'missing']);
});

test('a current failure wins over older passes, while an obsolete-target run cannot replace a current result', () => {
  const currentFailure = receipt('orders', { id: 'failed', status: 'failed', completedAt: '2026-10-21T12:01:00Z' });
  assert.equal(build(input({ receipts: [receipt(), currentFailure] })).status, 'failed');
  const obsolete = receipt('orders', { id: 'old-target', status: 'failed', completedAt: '2026-10-21T12:02:00Z', target: { ...target(), planHash: 'obsolete' } });
  assert.equal(build(input({ receipts: [obsolete, receipt()] })).status, 'passed');
  for (const status of ['cancelled', 'skipped', 'pending']) {
    const result = build(input({ receipts: [receipt(), { ...currentFailure, status }] }));
    assert.equal(result.status, 'missing'); assert.equal(row(result).receiptId, 'failed');
  }
});

test('duplicate retries are harmless; receipt conflicts and unordered concurrent results remain unknown', () => {
  const first = receipt();
  assert.equal(build(input({ receipts: [first, structuredClone(first)] })).status, 'passed');
  assert.equal(build(input({ receipts: [first, { ...first, status: 'failed' }] })).status, 'unknown');
  assert.equal(build(input({ receipts: [first, { ...first, kind: 'structure' }] })).status, 'unknown');
  assert.equal(build(input({ receipts: [first, { ...first, id: 'concurrent', status: 'failed' }] })).status, 'unknown');
});

test('missing pins, missing artifacts, future timestamps and legacy receipts cannot become current proof', () => {
  for (const overrides of [
    { target: null }, { evidenceIds: [] }, { evidenceIds: null }, { status: 'Verified' },
    { completedAt: 'invalid' }, { completedAt: '2026-10-22T00:00:00Z' }, { producerId: '' },
  ]) assert.equal(build(input({ receipts: [receipt('orders', overrides)] })).status, 'unknown');
  const value = input(); delete value.components[0].requirements[0].target.revisionSet[0].dirty;
  assert.equal(build(value).status, 'unknown');
});

test('trusted callback rejects forged producers, artifact denial and async predicate mistakes', () => {
  assert.equal(build(input({ receipts: [receipt('orders', { producerId: 'forged' })] })).status, 'unknown');
  assert.equal(build(input({ acceptReceipt: () => false })).status, 'unknown');
  assert.equal(build(input({ acceptReceipt: () => { throw new Error('artifact denied'); } })).status, 'unknown');
  assert.equal(build(input({ acceptReceipt: async () => true })).status, 'unknown');
  assert.equal(build(input({ acceptReceipt: () => 'true' })).status, 'unknown');
});

test('passing a reviewed command alone leaves behavior relevance unproven', () => {
  const value = input({ receipts: [receipt('orders', { relevance: 'reviewed-command-only' })] });
  const result = build(value);
  assert.equal(result.status, 'unknown');
  assert.match(row(result).reason, /relevance/);
  assert.equal(row(result).receiptId, value.receipts[0].id);
  assert.equal(build(input({ receipts: [receipt('orders', { relevance: 'reviewed-command-only', status: 'failed' })] })).status, 'failed');
});

test('restricted resources and analysis gap details do not leak through aggregate output', () => {
  const hidden = { ...component('private-billing'), componentId: 'confidential-payment-routing', requirements: [{ id: 'secret' }] };
  const result = build(input({ components: [component(), hidden], receipts: [receipt(), receipt('private-billing')],
    canReadProject: id => id === 'orders', analysis: { complete: false, gaps: ['private-billing/confidential.py'] } }));
  assert.equal(result.status, 'unknown'); assert.equal(result.complete, false);
  assert.equal(result.allRequiredChecksPassed, true);
  assert.equal(result.components.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-billing|confidential|secret/);
  assert.equal(build(input({ canReadProject: async () => true })).components.length, 0);
});

test('unknown discovery or inferred impact cannot turn passing checks into complete coverage', () => {
  for (const analysis of [undefined, { complete: true }, { complete: false, gaps: [] }, { complete: true, gaps: ['unsupported-language'] }]) {
    const result = build(input({ analysis })); assert.equal(result.status, 'unknown'); assert.equal(result.complete, false);
  }
  assert.equal(build(input({ components: [{ ...component(), confidence: 'inferred' }] })).status, 'unknown');
});

test('a readable component cannot expose receipts for a revision set containing inaccessible projects', () => {
  const value = input({ canReadProject: id => id === 'orders', acceptReceipt: () => { throw new Error('must not be evaluated'); } });
  for (const t of [value.components[0].requirements[0].target, value.receipts[0].target]) t.revisionSet.push(pin('restricted-project'));
  const result = build(value);
  assert.equal(result.status, 'unknown');
  assert.equal(row(result).receiptId, undefined);
  assert.doesNotMatch(JSON.stringify(result), /restricted-project|evidence-1/);
});

test('access and evidence policy, bounded identities and explicit time are mandatory', () => {
  for (const overrides of [{ canReadProject: undefined }, { acceptReceipt: undefined }, { workspaceId: '' }, { evaluatedAt: '' }, { components: null }]) {
    assert.throws(() => build(input(overrides)), TypeError);
  }
  assert.throws(() => build(input({ components: [component(), component()] })), /Duplicate/);
  assert.throws(() => build(input({ components: [{ ...component(), requirements: [requirement(), requirement()] }] })), /duplicate/);
});
