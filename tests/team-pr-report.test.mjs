import assert from 'node:assert/strict';
import { composeTeamPrReport } from '../packages/core/team-pr-report.mjs';
const head = 'a'.repeat(40), consumerHead = 'b'.repeat(40), old = 'c'.repeat(40);
const pr = { provider_repository_id: '123', head_sha: head, changed_project_key: 'prj_provider', changed_node_key: 'POST /checkout' };
const revisionSet = [{ projectKey: 'prj_provider', commit: head }, { projectKey: 'prj_consumer', commit: consumerHead }];
const projects = [{ project_key: 'prj_provider', provider_repository_id: '123' }, { project_key: 'prj_consumer', provider_repository_id: '456' }];
const impact = { status: 'affected', affected: [{ projectKey: 'prj_consumer', status: 'confirmed', requiredChecks: ['consumer-unit'], sourceRefs: ['src/pay.ts:12'] }] };
const receipt = { provider_repository_id: '456', check_name: 'consumer-unit', head_sha: consumerHead, conclusion: 'success', producer_app_id: 22, environment: 'ci', source_url: 'https://github.com/acme/provider/runs/1' };
assert.equal(composeTeamPrReport({ pr, impact, receipts: [receipt], revisionSet, projects }).status, 'unverified');
assert.equal(composeTeamPrReport({ pr, impact, receipts: [receipt], revisionSet, projects,
  acceptReceipt: item => item === receipt }).status, 'passed');
assert.equal(composeTeamPrReport({ pr, impact, receipts: [receipt], revisionSet, projects,
  acceptReceipt: async () => true }).status, 'unverified');
assert.equal(composeTeamPrReport({ pr, impact: { ...impact, affected: [{ ...impact.affected[0], status: 'inferred' }] },
  receipts: [receipt], revisionSet, projects }).status, 'unverified');
assert.match(composeTeamPrReport({ pr, impact, receipts: [receipt], revisionSet, projects,
  task: { title: 'Checkout update', status: 'in_progress' } }).markdown, /Task: Checkout update \(in_progress\)/);
assert.equal(composeTeamPrReport({ pr, impact, receipts: [
  { ...receipt, observed_at: '2026-10-20T12:00:00Z' },
  { ...receipt, conclusion: 'failure', observed_at: '2026-10-20T13:00:00Z' },
], revisionSet, projects }).status, 'failed');
assert.equal(composeTeamPrReport({ pr, impact, receipts: [{ ...receipt, conclusion: 'failure' }], revisionSet, projects }).status, 'failed');
assert.equal(composeTeamPrReport({ pr, impact, receipts: [{ ...receipt, head_sha: old }], revisionSet, projects }).status, 'stale');
assert.equal(composeTeamPrReport({ pr, impact, receipts: [], revisionSet, projects }).status, 'unverified');
assert.equal(composeTeamPrReport({ pr, impact: { ...impact, status: 'stale' }, receipts: [receipt], revisionSet, projects }).status, 'stale');
assert.equal(composeTeamPrReport({ pr, impact, receipts: [receipt], revisionSet: [{ projectKey: 'prj_provider', commit: old }], projects }).status, 'stale');
const hostile = composeTeamPrReport({ pr: { ...pr, changed_node_key: 'route\n| fake |' },
  impact: { ...impact, affected: [{ ...impact.affected[0], sourceRefs: ['api.ts:12\n| forged pass | <script>'] }] },
  receipts: [], revisionSet, projects });
assert.equal(hostile.markdown.includes('\n| forged pass |'), false);
assert.match(hostile.markdown, /&lt;script&gt;/);
console.log('Two-repository PR report requires explicit accepted proof before a pass');
