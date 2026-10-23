import assert from 'node:assert/strict';
import { commerceState } from '../fixtures/workspace-commerce/state.mjs';
import { saveWorkspaceGroup, workspaceTargets } from '../packages/core/workspace-groups.mjs';
import { bindTaskWorkspace } from '../packages/core/task-workspace.mjs';
import { buildTaskContext } from '../packages/core/task-context.mjs';
import { refreshAndPrepareTaskContext } from '../packages/core/context-freshness.mjs';
import { ensureTaskVerificationPlan, executeTaskVerificationPlan } from '../packages/core/verification-runner.mjs';
import { createTaskHandoff } from '../packages/core/handoff.mjs';
import { prepareTaskDraftContext } from '../packages/core/task-context-review.mjs';

const state=commerceState();saveWorkspaceGroup(state,{name:'Commerce',projectIds:state.projects.map(p=>p.id)},'wsg_commerce');bindTaskWorkspace(state);
const [owner,orders,payments]=state.projects;
const targets=workspaceTargets(state,'wsg_commerce').filter(t=>t.kind==='page'||t.kind==='api');
const task={id:'cross',projectId:owner.id,title:'Checkout across services',description:'Update checkout and verify both integrations',intent:'full-stack',workspaceGroupId:'wsg_commerce',targetRefs:targets.map(t=>t.ref),contractIds:[],requestIds:[],artifactIds:['page:checkout'],acceptanceCriteria:['Both services accept checkout'],contextSelectionMode:'manual',testCommand:'npm test',repositoryTestCommands:{orders:{command:'npm',args:['run','test:orders']}}};
owner.tasks.push(task);
const prepared=await refreshAndPrepareTaskContext(owner,task);
assert.equal(prepared.manifest.workspace.projects.length,3);
const manifest=buildTaskContext(owner,task.id,8000);
assert.equal(manifest.contracts.filter(c=>c.id==='checkout-contract').length,2);
assert.deepEqual(manifest.contracts.map(c=>c.projectId),['orders','payments']);
const handoff=createTaskHandoff({project:owner,task,context:manifest});
assert.match(handoff.markdown,/orders/);assert.match(handoff.markdown,/payments/);
assert.equal(handoff.handoff.contractRefs.length,2);
assert.equal(handoff.handoff.contractIds.length,0);
const review=prepareTaskDraftContext(owner,{draft_id:'draft',objective:'Checkout',workspace_group_id:'wsg_commerce',target_keys:targets.map(t=>t.key)});
assert.equal(new Set(review.references.map(r=>r.projectId)).size,3);
let plan=ensureTaskVerificationPlan(owner,task);
assert.equal(new Set(plan.steps.map(s=>s.id)).size,plan.steps.length);
assert.deepEqual(plan.steps.filter(s=>s.type==='api-replay').map(s=>s.projectId),['orders','payments']);
assert.deepEqual(plan.steps.filter(s=>s.type==='test-log').map(s=>[s.projectId,s.command]),[['storefront','npm test'],['orders',{command:'npm',args:['run','test:orders']}]],'A cross-repository test command must be explicitly selected for its repository');
const replayOwners=[],commandOwners=[];
const result=await executeTaskVerificationPlan(owner,task,{targetSnapshotHash:plan.targetSnapshotHash,allowStateChangingReplay:true,
 executeApiReplay:async(request,{project})=>{replayOwners.push([project.id,request.id,project.activeEnvironmentId]);return {ok:true,passed:true,status:201,json:{ok:true}};},
 executeTestCommand:async(command,{project})=>{commandOwners.push(project.id);return {passed:true,exitCode:0};},
 validateContractResponse:()=>({passed:true})
});
assert.equal(result.receipt.result,'Verified');
assert.deepEqual(replayOwners.map(r=>r[0]),['orders','payments']);assert.deepEqual(commandOwners,['storefront','orders']);
assert.equal(result.receipt.repositoryReceipts.length,3);
assert.ok(owner.evidence.some(e=>e.projectId==='orders'));assert.ok(owner.evidence.some(e=>e.projectId==='payments'));
assert.equal(orders.verificationReceipts,undefined,'Do not attach the aggregate task to another project');
assert.equal(payments.contracts[0].state,undefined,'Do not mutate foreign contracts during isolated checks');
const previousHash=plan.targetSnapshotHash;
const duplicate = {...owner.sourceContext.artifacts[0], root:'/another-repository'};
owner.sourceContext.artifacts.push(duplicate);
assert.ok(ensureTaskVerificationPlan(owner,task).steps.some(s=>s.type==='context-unavailable'), 'Same-project multi-root ID collisions must block rather than merge');
await assert.rejects(executeTaskVerificationPlan(owner,task),/Ambiguous local identity/);
owner.sourceContext.artifacts.pop();
payments.environments[0].variables[0].value='http://127.0.0.1:4000';
plan=ensureTaskVerificationPlan(owner,task);assert.notEqual(plan.targetSnapshotHash,previousHash);
await assert.rejects(executeTaskVerificationPlan(owner,task,{targetSnapshotHash:previousHash}),/changed/);
const blocked=await executeTaskVerificationPlan(owner,task,{targetSnapshotHash:plan.targetSnapshotHash,executeTestCommand:async()=>({passed:true})});
assert.equal(blocked.receipt.result,'Verification pending');
state.workspaceGroups.find(g=>g.id==='wsg_commerce').projectIds=['storefront','orders'];
assert.ok(ensureTaskVerificationPlan(owner,task).steps.some(s=>s.type==='context-unavailable'));
await assert.rejects(executeTaskVerificationPlan(owner,task),/Unavailable context/);
console.log('Cross-repository context, duplicate IDs, handoff ownership, environment routing, approval and membership guards passed');
