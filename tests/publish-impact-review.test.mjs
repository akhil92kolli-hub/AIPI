import assert from 'node:assert/strict';
import { buildPublishImpactReview, issuePublishReviewToken, acceptPublishReviewToken } from '../packages/core/publish-impact-review.mjs';

const root = '/tmp/aipi-publish-source';
const plan = { commit: 'b'.repeat(40), remoteName: 'origin', targetBranch: 'main',
  repositoryUrl: 'https://github.com/example/orders.git', targetExists: true };
const state = { projects: [{ id: 'orders', sourceContext: { roots: [{ path: root }] } },
  { id: 'storefront', sourceContext: { roots: [{ path: '/tmp/aipi-consumer' }] } }],
workspaceGroups: [{ id: 'wsg_publish_test', projectIds: ['orders', 'storefront'], version: 1 }] };
let consumerRevision = 'f'.repeat(40);
const assess = async ({ workspaceId, projectId, rootIndex, baseRef, headRef, mode }) => {
  assert.equal(workspaceId, 'wsg_publish_test');
  assert.equal(projectId, 'orders');
  assert.equal(rootIndex, 0);
  assert.equal(baseRef, 'refs/remotes/origin/main');
  assert.equal(headRef, plan.commit);
  assert.equal(mode, 'commits');
  return { comparison: { baseCommit: 'a'.repeat(40), headCommit: headRef, snapshotFingerprint: 'snapshot' },
    revisionSet: [{ projectId: 'storefront', commit: consumerRevision }], contractRevisions: [],
    components: [{ projectId: 'storefront', componentId: 'call_1', label: 'Checkout caller', confidence: 0.8,
      source: { path: 'src/checkout.ts', line: 12 }, paths: [] }],
    ledger: { status: 'unknown', components: [{ projectId: 'storefront', componentId: 'call_1', status: 'missing' }] },
    analysis: { gaps: ['Behavior unproven'] }, unmappedFiles: [] };
};
const first = await buildPublishImpactReview({ state, projectId: 'orders', root, plan, assess });
assert.equal(first.review.impacts.length, 1);
assert.equal(first.review.impacts[0].projectId, 'storefront');
assert.equal(first.review.impacts[0].status, 'missing');
assert.equal(first.review.status, 'unknown');
assert.ok(first.review.limitations.length);
const secret = 'local-session-secret';
const token = issuePublishReviewToken(first.fingerprint, secret, 1000);
assert.equal(acceptPublishReviewToken(token, first.fingerprint, secret, 2000), true);
assert.equal(acceptPublishReviewToken(token, first.fingerprint, secret, 301001), false);
assert.equal(acceptPublishReviewToken(`${token}x`, first.fingerprint, secret, 2000), false);
consumerRevision = '1'.repeat(40);
const changed = await buildPublishImpactReview({ state, projectId: 'orders', root, plan, assess });
assert.notEqual(changed.fingerprint, first.fingerprint);
assert.equal(acceptPublishReviewToken(token, changed.fingerprint, secret, 2000), false);
const unbased = await buildPublishImpactReview({ state, projectId: 'orders', root, plan: { ...plan, targetExists: false }, assess });
assert.equal(unbased.review.status, 'unknown');
assert.equal(unbased.review.impacts.length, 0);
assert.ok(unbased.review.limitations.some(item => item.reason.includes('no local baseline')));
console.log('Git publish disclosure binds current blast radius, source and target to short-lived confirmation');
