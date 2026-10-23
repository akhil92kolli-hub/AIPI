import assert from 'node:assert/strict';
import { normalizeTaskStatus, resourceAccess, workspaceEntitlementState, workspaceResource } from '../packages/core/workspace-domain.mjs';

assert.equal(normalizeTaskStatus('in-progress'), 'in_progress');
assert.equal(normalizeTaskStatus('in-review'), 'in_review');
assert.equal(normalizeTaskStatus('awaiting-developer-review'), 'in_review');
assert.equal(workspaceEntitlementState({mode:'local'}), 'free_local');
assert.equal(workspaceEntitlementState({mode:'team',subscriptionStatus:'canceled'}), 'read_only');
assert.deepEqual(resourceAccess({workspaceRole:'developer',kind:'github_repository',githubUserRead:true,
  githubUserWrite:false,installationRead:true,installationWrite:true}), {read:true,write:false});
assert.deepEqual(resourceAccess({workspaceRole:'viewer',kind:'local_source'}), {read:true,write:false});
assert.throws(()=>workspaceResource({projectId:'prj_good',name:'A',kind:'github_repository'}));
assert.equal(workspaceResource({projectId:'prj_good',name:' A ',kind:'local_source'}).name,'A');
console.log('Workspace domain statuses, identities, entitlements and permission intersection passed');
