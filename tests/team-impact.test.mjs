import assert from 'node:assert/strict';
import { analyzeTeamImpact, scoreImpactCorpus } from '../packages/core/team-impact.mjs';

const one = 'a'.repeat(40), two = 'b'.repeat(40), next = 'c'.repeat(40);
const nodes = [
  { id: 'provider', project_key: 'prj_provider', node_key: 'POST /checkout', kind: 'contract', revision_commit: one },
  { id: 'consumer', project_key: 'prj_consumer', node_key: 'src/pay.ts:12', kind: 'caller', revision_commit: two, owner_id: 'owner-1' },
  { id: 'test', project_key: 'prj_consumer', node_key: 'tests/pay.test.ts:8', kind: 'test', revision_commit: two },
  { id: 'guess', project_key: 'prj_guess', node_key: 'src/guess.ts:1', kind: 'caller', revision_commit: two },
];
const revisions = [{ projectKey: 'prj_provider', commit: one }, { projectKey: 'prj_consumer', commit: two }, { projectKey: 'prj_guess', commit: two }];
const link = { id: 'edge-1', from_node_id: 'provider', to_node_id: 'consumer', relation: 'consumed_by',
  evidence_kind: 'static', confirmation_state: 'confirmed', revision_set: revisions.slice(0, 2),
  source_refs: ['src/pay.ts:12'], required_checks: ['consumer-unit'] };
const test = { id: 'edge-2', from_node_id: 'consumer', to_node_id: 'test', relation: 'tested_by',
  evidence_kind: 'runtime', confirmation_state: 'confirmed', revision_set: revisions.slice(0, 2),
  source_refs: ['tests/pay.test.ts:8'], required_checks: ['consumer-integration'] };
const guess = { id: 'edge-3', from_node_id: 'provider', to_node_id: 'guess', relation: 'consumed_by',
  evidence_kind: 'ai_suggestion', confirmation_state: 'suggested', revision_set: revisions,
  source_refs: [], required_checks: [] };
const input = { nodes, edges: [link, test, guess], changedProjectKey: 'prj_provider', changedNodeKey: 'POST /checkout', revisionSet: revisions };
const current = analyzeTeamImpact(input);
assert.deepEqual(current.affected.map((entry) => entry.projectKey), ['prj_consumer']);
assert.deepEqual(current.affected[0].requiredChecks, ['consumer-integration', 'consumer-unit']);
assert.deepEqual(current.affected[0].owners, ['owner-1']);
assert.equal(current.affected[0].status, 'confirmed');
assert.equal(current.suggestions[0].projectKey, 'prj_guess');
assert.equal(analyzeTeamImpact({ ...input, edges: [{ ...link, confirmation_state: 'rejected' }, test, guess] }).affected.length, 0);
assert.equal(analyzeTeamImpact({ ...input, revisionSet: [{ projectKey: 'prj_provider', commit: next }, ...revisions.slice(1)] }).affected[0].status, 'stale');
const score = scoreImpactCorpus([
  { input, expectedProjects: ['prj_consumer'] },
  { input: { ...input, edges: [{ ...link, confirmation_state: 'rejected' }, guess] }, expectedProjects: [] },
  { input: { ...input, edges: [link] }, expectedProjects: ['prj_consumer'] },
  { input: { ...input, edges: [test, guess] }, expectedProjects: [] },
  { input: { ...input, edges: [{ ...link, evidence_kind: 'declared' }] }, expectedProjects: ['prj_consumer'] },
  { input: { ...input, edges: [{ ...link, evidence_kind: 'runtime' }] }, expectedProjects: ['prj_consumer'] },
  { input: { ...input, edges: [{ ...guess, confirmation_state: 'confirmed' }] }, expectedProjects: ['prj_guess'] },
  { input: { ...input, edges: [{ ...guess, confirmation_state: 'rejected' }] }, expectedProjects: [] },
  { input: { ...input, revisionSet: [{ projectKey: 'prj_provider', commit: next }, ...revisions.slice(1)] }, expectedProjects: ['prj_consumer'] },
  { input: { ...input, changedNodeKey: 'GET /unknown' }, expectedProjects: [] },
]);
assert.deepEqual({ cases: score.cases, precision: score.precision, recall: score.recall, missed: score.missedDependencies }, { cases: 10, precision: 1, recall: 1, missed: 0 });
console.log('Cross-repository impact, provenance, stale pins, rejection and corpus precision passed');
