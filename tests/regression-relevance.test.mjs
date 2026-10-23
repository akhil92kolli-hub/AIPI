import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { signLocalAssessmentReceipt } from '../packages/core/assessment-proof.mjs';
import { attestLocalRegressionRelevance, acceptLocalRegressionRelevance } from '../packages/core/regression-relevance.mjs';
import { buildVerificationCoverageLedger } from '../packages/core/verification-coverage.mjs';

const hash = value => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const key = crypto.randomBytes(32);
const pin = commit => [{ projectId: 'orders', resourceId: 'root', commit, dirty: false }];
const target = commit => ({ planHash: `plan-${commit}`, checkFingerprint: 'check-one',
  environmentId: 'dev', environmentFingerprint: 'env-one', revisionSet: pin(commit), contractRevisions: [] });
const check = commit => ({ projectId: 'orders', componentId: 'orders-api', requirementId: 'behavior-one',
  resourceId: 'root', command: { executable: 'node', args: ['--test'], cwd: '.', timeoutMs: 1000 },
  requiredVariableNames: ['ORDERS_URL'], target: target(commit) });
function manifest(commit) {
  const body = { schemaVersion: 1, kind: 'aipi.verification-package', workspaceId: 'workspace-one',
    changeId: 'change-one', resources: [{ projectId: 'orders', resourceId: 'root', commit }],
    checks: [check(commit)], receiptIds: commit === 'fixed' ? ['receipt-fixed'] : ['receipt-bad'],
    complete: true, sourceReproducible: true };
  return { ...body, manifestHash: hash(body) };
}
const bad = manifest('bad'), fixed = manifest('fixed');
const outcome = (passed, commit) => ({ projectId: 'orders', componentId: 'orders-api',
  requirementId: 'behavior-one', passed, exitCode: passed ? 0 : 1,
  behaviorAssertionObserved: !passed, passMarkerObserved: passed,
  outputHash: hash(`output-${commit}`) });
const repairedReceipt = signLocalAssessmentReceipt({ id: 'receipt-fixed', workspaceId: 'workspace-one',
  changeId: 'change-one', projectId: 'orders', componentId: 'orders-api', requirementId: 'behavior-one',
  producerId: 'local-companion', kind: 'behavior', completedAt: '2026-10-22T11:00:00Z',
  evidenceIds: ['artifact-one'], status: 'passed', relevance: 'reviewed-command-only', target: target('fixed') }, key);
const failedReceipt = signLocalAssessmentReceipt({ ...repairedReceipt, id: 'receipt-bad',
  status: 'failed', target: target('bad') }, key);
const args = () => ({ knownBad: bad, repaired: fixed, knownBadResults: [outcome(false, 'bad')],
  repairedResults: [outcome(true, 'fixed')], knownBadReceipts: [failedReceipt],
  repairedReceipts: [repairedReceipt], signingKey: key });

test('signed second-checkout contrast promotes only the exact repaired check', () => {
  const attestation = attestLocalRegressionRelevance(args());
  assert.equal(acceptLocalRegressionRelevance(repairedReceipt, attestation, key), true);
  assert.equal(acceptLocalRegressionRelevance({ ...repairedReceipt, id: 'other' }, attestation, key), false);
  assert.equal(acceptLocalRegressionRelevance(repairedReceipt, { ...attestation, changeId: 'other' }, key), false);
  const ledger = buildVerificationCoverageLedger({ workspaceId: 'workspace-one', changeId: 'change-one',
    evaluatedAt: '2026-10-22T12:00:00Z', analysis: { complete: false, gaps: ['consumer discovery incomplete'] },
    components: [{ projectId: 'orders', componentId: 'orders-api', confidence: 'confirmed',
      requirements: [{ id: 'behavior-one', kind: 'behavior', target: target('fixed') }] }],
    receipts: [repairedReceipt],
    canReadProject: () => true, acceptReceipt: () => true,
    acceptRelevance: receipt => acceptLocalRegressionRelevance(receipt, attestation, key) });
  assert.equal(ledger.components[0].checks[0].status, 'passed');
  assert.equal(ledger.status, 'unknown');
});

test('non-comparable commands, sources, outcomes and unsigned receipts are refused', () => {
  for (const mutate of [
    value => { value.knownBadResults[0].passed = true; },
    value => { value.repairedResults[0].exitCode = 1; },
    value => { value.knownBadResults[0].behaviorAssertionObserved = false; },
    value => { value.repairedResults[0].passMarkerObserved = false; },
    value => { value.repairedReceipts[0].signature = '0'.repeat(64); },
    value => { value.knownBadReceipts[0].status = 'passed'; },
    value => { value.knownBad.checks[0].command.args = ['different']; },
    value => { value.knownBad.checks[0].target.environmentFingerprint = 'other'; },
    value => { value.knownBad.checks[0].target.revisionSet = pin('fixed'); },
  ]) {
    const value = structuredClone(args());
    value.signingKey = key;
    mutate(value);
    assert.throws(() => attestLocalRegressionRelevance(value));
  }
});
