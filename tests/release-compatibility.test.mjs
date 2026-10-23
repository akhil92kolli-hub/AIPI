import assert from 'node:assert/strict';
import { evaluateReleaseCompatibility } from '../packages/core/release-compatibility.mjs';

const now = Date.parse('2026-10-23T10:00:00Z');
const producer = { projectId: 'orders', sourceBindingId: 'src_orders', revision: 'b'.repeat(40), artifactDigest: 'sha256:backend1' };
const frontend = revision => ({ projectId: 'storefront', sourceBindingId: 'src_storefront', revision, artifactDigest: `sha256:${revision.slice(0,8)}` });
const deployedF0 = { ...frontend('0'.repeat(40)), environmentId: 'production', cohort: 'deployed', observedAt: '2026-10-23T09:59:00Z' };
const proposedF1 = { ...frontend('1'.repeat(40)), environmentId: 'production', cohort: 'proposed', observedAt: '2026-10-23T09:59:00Z' };
const proofs = [
  { id: 'proof_b1_f0', environmentId: 'production', producer, consumer: deployedF0, status: 'failed', completedAt: '2026-10-23T09:58:00Z' },
  { id: 'proof_b1_f1', environmentId: 'production', producer, consumer: proposedF1, status: 'passed', completedAt: '2026-10-23T09:58:00Z' }
];
const input = { workspaceId: 'wsg_commerce', environmentId: 'production', candidate: producer,
  dependencies: [{ producerProjectId: 'orders', consumerProjectId: 'storefront' }],
  observations: [deployedF0, proposedF1], proofs, discoveryComplete: true, now,
  acceptObservation: () => true, acceptProof: () => true };

const blocked = evaluateReleaseCompatibility(input);
assert.equal(blocked.pairs.length, 1, 'a proposed frontend does not replace the deployed F0 cohort');
assert.equal(blocked.pairs[0].consumerRevision, '0'.repeat(40));
assert.equal(blocked.pairs[0].status, 'failed');
assert.equal(blocked.previewReady, false);
assert.equal(blocked.canDeploy, false);

const rolling = evaluateReleaseCompatibility({ ...input, observations: [deployedF0, { ...proposedF1, cohort: 'deployed' }] });
assert.deepEqual(rolling.pairs.map(pair => pair.status), ['failed', 'passed'], 'both active cohorts must pass during rollout');
assert.equal(rolling.previewReady, false);

const migrated = evaluateReleaseCompatibility({ ...input, observations: [{ ...proposedF1, cohort: 'deployed' }] });
assert.equal(migrated.pairs[0].status, 'passed');
assert.equal(migrated.previewReady, true);
assert.equal(migrated.canDeploy, false, 'the preview cannot grant a protected deployment decision');

const forged = evaluateReleaseCompatibility({ ...input, acceptObservation: () => false });
assert.equal(forged.pairs[0].status, 'unknown');
const untrustedProof = evaluateReleaseCompatibility({ ...input, acceptProof: () => false });
assert.equal(untrustedProof.pairs[0].status, 'unknown');
const stale = evaluateReleaseCompatibility({ ...input, now: now + 7200000 });
assert.equal(stale.pairs[0].status, 'unknown');
const undiscovered = evaluateReleaseCompatibility({ ...input, discoveryComplete: false });
assert.equal(undiscovered.previewReady, false);
assert.ok(undiscovered.pairs.some(pair => pair.reason.includes('discovery is incomplete')));
const noEnvironment = evaluateReleaseCompatibility({ ...input, environmentId: null });
assert.equal(noEnvironment.previewReady, false);
assert.ok(noEnvironment.pairs.some(pair => pair.cohort === 'Environment'));

console.log('Release compatibility keeps active cohorts, accepted proof and protected enforcement separate');
