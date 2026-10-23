import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { assessLocalWorkspaceChange } from '../packages/core/change-assessment.mjs';
import { reviewAssessmentChecks, executeReviewedAssessment, verifyLocalAssessmentReceipt, acceptLocalAssessmentEvidence } from '../packages/core/assessment-proof.mjs';
import { executeLinkedTestCommand } from '../scripts/dashboard-server.mjs';
import { assessmentFixture } from './helpers/change-assessment-fixture.mjs';

const key = crypto.randomBytes(32);

test('an actual reviewed local command yields signed failure, then an edit makes that proof stale', async t => {
  const fixture = await assessmentFixture(t);
  fixture.state.projects[0].verification = { testCommand: { command: 'node', args: ['-e',
    "const fs=require('fs'); process.exit(/total = 101\\n/.test(fs.readFileSync('app.py','utf8')) ? 0 : 2)"], cwd: '.' } };
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = "100"\n');
  const assessment = await assessLocalWorkspaceChange(fixture.input);
  const historical = await assessLocalWorkspaceChange({ ...fixture.input, mode: 'commits', headRef: 'HEAD' });
  assert.throws(() => reviewAssessmentChecks({ assessment: historical, state: fixture.state, canRunProject: () => true }), /isolated checkouts/);
  const review = reviewAssessmentChecks({ assessment, state: fixture.state, canRunProject: () => true });
  assert.ok(review.checks.length > 0);
  assert.ok(review.gaps.some(gap => gap.includes('no configured')));
  const before = structuredClone(fixture.state);
  await assert.rejects(executeReviewedAssessment({ assessment, state: fixture.state,
    canRunProject: () => true, approvedReviewHash: 'sha256:wrong', signingKey: key,
    executeCheck: (project, command) => executeLinkedTestCommand(project, command) }), /Review the current plan/);
  const result = await executeReviewedAssessment({ assessment, state: fixture.state,
    canRunProject: () => true, approvedReviewHash: review.reviewHash, signingKey: key,
    executeCheck: (project, command) => executeLinkedTestCommand(project, command) });
  assert.ok(result.receipts.length > 0);
  assert.ok(result.receipts.every(receipt => receipt.status === 'failed' && receipt.exitCode === 2));
  assert.ok(result.receipts.every(receipt => verifyLocalAssessmentReceipt(receipt, key)));
  assert.ok(result.receipts.every(receipt => acceptLocalAssessmentEvidence(receipt, key, result.evidence)));
  assert.equal(acceptLocalAssessmentEvidence(result.receipts[0], key, []), false, 'missing artifacts cannot authenticate proof');
  assert.ok(result.ledger.components.some(row => row.projectId === 'orders' && row.status === 'failed'));
  assert.equal(result.ledger.complete, false);
  assert.deepEqual(fixture.state, before, 'the domain executor returns receipts without changing caller state');
  assert.doesNotMatch(JSON.stringify(result.receipts), /require\('fs'\)|total =/);
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = 101\n');
  const stale = await assessLocalWorkspaceChange({ ...fixture.input,
    changeId: assessment.changeId, evaluatedAt: new Date().toISOString(), receipts: result.receipts,
    acceptReceipt: receipt => acceptLocalAssessmentEvidence(receipt, key, result.evidence) });
  assert.ok(stale.ledger.components.some(row => row.projectId === 'orders' && row.checks.some(check => check.status === 'stale')));
  const repairedReview = reviewAssessmentChecks({ assessment: stale, state: fixture.state, canRunProject: () => true });
  assert.notEqual(repairedReview.reviewHash, review.reviewHash);
  const repaired = await executeReviewedAssessment({ assessment: stale, state: fixture.state,
    canRunProject: () => true, approvedReviewHash: repairedReview.reviewHash, signingKey: key,
    executeCheck: (project, command) => executeLinkedTestCommand(project, command) });
  assert.ok(repaired.receipts.every(receipt => receipt.status === 'passed'));
  assert.ok(repaired.ledger.components.some(row => row.projectId === 'orders' && row.checks.some(check =>
    check.status === 'unknown' && check.reason.includes('relevance'))));
  assert.equal(repaired.ledger.complete, false, 'unconfigured consumers and incomplete dependency discovery remain visible');
});

test('forged receipts, wrong roots and unreviewed command changes cannot gain proof', async t => {
  const fixture = await assessmentFixture(t);
  fixture.state.projects[0].verification = { testCommand: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: '.' } };
  await fs.writeFile(path.join(fixture.root, 'app.py'), 'total = 101\n');
  const assessment = await assessLocalWorkspaceChange(fixture.input);
  const review = reviewAssessmentChecks({ assessment, state: fixture.state, canRunProject: () => true });
  const result = await executeReviewedAssessment({ assessment, state: fixture.state,
    canRunProject: () => true, approvedReviewHash: review.reviewHash, signingKey: key,
    executeCheck: (project, command) => executeLinkedTestCommand(project, command) });
  const forged = structuredClone(result.receipts[0]); forged.status = 'failed';
  assert.equal(verifyLocalAssessmentReceipt(forged, key), false);
  const untrusted = await assessLocalWorkspaceChange({ ...fixture.input, evaluatedAt: new Date().toISOString(),
    receipts: [forged], acceptReceipt: receipt => verifyLocalAssessmentReceipt(receipt, key) });
  assert.ok(untrusted.ledger.components.some(row => row.checks.some(check => check.status === 'unknown')));
  fixture.state.projects[0].verification.testCommand.args = ['-e', 'process.exit(3)'];
  await assert.rejects(executeReviewedAssessment({ assessment, state: fixture.state,
    canRunProject: () => true, approvedReviewHash: review.reviewHash, signingKey: key,
    executeCheck: (project, command) => executeLinkedTestCommand(project, command) }), /Review the current plan/);
  fixture.state.projects[0].verification.testCommand.repositoryRoot = fixture.state.projects[1].sourceContext.roots[0].path;
  const invalid = reviewAssessmentChecks({ assessment, state: fixture.state, canRunProject: () => true });
  assert.equal(invalid.checks.length, 0);
  assert.ok(invalid.gaps.some(gap => gap.includes('registered source root')));
});
