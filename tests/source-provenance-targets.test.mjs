import assert from 'node:assert/strict';
import { sourceProvenanceForTarget } from '../packages/core/source-provenance.mjs';
import { getWorkspaceTarget, workspaceTargets } from '../packages/core/workspace-groups.mjs';

const project = { id: 'prj_orders', name: 'Orders', requests: [], contracts: [{ id: 'contract_ambiguous', method: 'GET', route: '/orders' }],
  sourceBindings: [{ id: 'src_first12345678', kind: 'local', version: 1 }, { id: 'src_second12345678', kind: 'local', version: 1 }],
  sourceContext: { roots: [{ path: '/tmp/aipi-orders-first', sourceBindingId: 'src_first12345678' },
    { path: '/tmp/aipi-orders-second', sourceBindingId: 'src_second12345678' }],
    git: [{ root: '/tmp/aipi-orders-first', commit: 'a'.repeat(40) }, { root: '/tmp/aipi-orders-second', commit: 'b'.repeat(40) }],
    endpoints: [{ id: 'first', root: '/tmp/aipi-orders-first', source: 'api.ts', method: 'GET', path: '/first', contentHash: '1'.repeat(64) },
      { id: 'second', root: '/tmp/aipi-orders-second', source: 'api.ts', method: 'GET', path: '/second', contentHash: '2'.repeat(64) }],
    frontendCalls: [], schemas: [], artifacts: [], integrations: [] },
  knowledgeGraph: { edges: [{ id: 'claimed', type: 'CALLS', fromNodeId: 'first', toNodeId: 'second',
    confirmationState: 'pending', provenance: 'manual-declaration', confidence: 0 }] } };
const state = { projects: [project], workspaceGroups: [{ id: 'wsg_provenance_test', projectIds: [project.id], version: 1 }] };
const targets = workspaceTargets(state, 'wsg_provenance_test');
const first = targets.find(item => item.nativeId === 'first');
const second = targets.find(item => item.nativeId === 'second');
assert.equal(first.ref.workspaceId, 'wsg_provenance_test');
assert.equal(first.ref.sourceBindingId, 'src_first12345678');
assert.equal(first.revision, 'a'.repeat(40));
assert.equal(first.contentHash, '1'.repeat(64));
assert.equal(first.analyzerVersion, 'source-index:4');
assert.equal(first.provenanceStatus, 'pinned');
assert.equal(second.ref.sourceBindingId, 'src_second12345678');
assert.equal(second.revision, 'b'.repeat(40));
const ambiguous = targets.find(item => item.ref.entityId === 'contract_ambiguous');
assert.equal(ambiguous.ref.sourceBindingId, null);
assert.equal(ambiguous.provenanceStatus, 'incomplete');
assert.equal(sourceProvenanceForTarget(project, { root: '/tmp/aipi-orders-first', sourceBindingId: 'src_second12345678' }).sourceBindingId, null);
assert.equal(getWorkspaceTarget(state, 'wsg_provenance_test', first.key).related.some(item => item.nativeId === 'second'), false,
  'a pending repository declaration cannot appear as an indexed dependency');
console.log('Workspace targets retain portable source pins and exclude pending graph declarations');
