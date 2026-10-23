import assert from 'node:assert/strict';
import { assessTeamChangedFiles, scopeTeamAssessmentGraph } from '../packages/core/team-change-assessment.mjs';

const base='a'.repeat(40),head='b'.repeat(40),consumer='c'.repeat(40);
const nodes=[
  {id:'orders',project_key:'prj_orders',node_key:'POST /api/orders',kind:'contract',label:'Orders response',source_ref:'app.py:4',revision_commit:base},
  {id:'react',project_key:'prj_react',node_key:'Checkout.tsx:7',kind:'caller',label:'Checkout',source_ref:'src/Checkout.tsx:7',revision_commit:consumer},
  {id:'billing',project_key:'prj_billing',node_key:'Billing.py:9',kind:'caller',label:'Billing',source_ref:'Billing.py:9',revision_commit:consumer,owner_id:'billing-owner'},
];
const edges=[{id:'orders-react',from_node_id:'orders',to_node_id:'react',relation:'consumed_by',
  evidence_kind:'static',confirmation_state:'confirmed',revision_set:[{projectKey:'prj_orders',commit:base},{projectKey:'prj_react',commit:consumer}],
  source_refs:['src/Checkout.tsx:7'],required_checks:['react-checkout']},
  {id:'orders-billing',from_node_id:'orders',to_node_id:'billing',relation:'consumed_by',
    evidence_kind:'declared',confirmation_state:'confirmed',revision_set:[{projectKey:'prj_billing',commit:consumer}],
    source_refs:['Billing.py:9'],required_checks:['billing-contract']}];
const result=assessTeamChangedFiles({files:[{filename:'app.py',patch:'@@ -4 +4 @@'}],nodes,edges,
  projectKey:'prj_orders',baseSha:base,headSha:head,revisionSet:[{projectKey:'prj_react',commit:consumer}]});
assert.equal(result.changedNodes[0].evidenceStrength,'pattern_or_declared');
assert.deepEqual(result.requiredChecks,['billing-contract','react-checkout']);
assert.equal(result.impacts[0].report.affected.find(entry=>entry.projectKey==='prj_react').status,'stale');
assert.equal(result.coverage.meaning.includes('candidates'),true);
assert.equal(result.ledger.status,'unknown');
assert.equal(result.ledger.complete,false);
assert.equal(result.ledger.components.find(entry=>entry.projectId==='prj_react').checks[0].status,'unknown');
assert.deepEqual(result.ledger.components.find(entry=>entry.projectId==='prj_react').checks.filter(entry=>entry.requirementId).map(entry=>entry.requirementId),['react-checkout']);
assert.deepEqual(result.ledger.components.find(entry=>entry.projectId==='prj_billing').checks.filter(entry=>entry.requirementId).map(entry=>entry.requirementId),['billing-contract']);
assert.equal(result.ownerCoverage.find(entry=>entry.projectId==='prj_react').status,'missing');
assert.equal(result.ownerCoverage.find(entry=>entry.projectId==='prj_billing').status,'identified');
const revoked=scopeTeamAssessmentGraph({nodes,edges,readableProjects:new Set(['prj_orders'])});
assert.equal(revoked.restrictedScope,true);
assert.deepEqual(revoked.nodes.map(node=>node.id),['orders']);
assert.deepEqual(revoked.edges,[]);
const afterRevocation=assessTeamChangedFiles({files:[{filename:'app.py',patch:'@@ -4 +4 @@'}],
  ...revoked,projectKey:'prj_orders',baseSha:base,headSha:head,revisionSet:[],restrictedScope:revoked.restrictedScope});
assert.deepEqual(afterRevocation.impacts[0].report.affected,[]);
assert.equal(JSON.stringify(afterRevocation).includes('Checkout'),false);
assert.equal(JSON.stringify(afterRevocation).includes('react-checkout'),false);
assert.equal(afterRevocation.ledger.limitations.some(value=>value.includes('repository access')),true);
const renamedFile=assessTeamChangedFiles({files:[{filename:'renamed.py',previous_filename:'app.py',status:'renamed',patch:'@@ -4 +4 @@'}],
  nodes,edges,projectKey:'prj_orders',baseSha:base,headSha:head,revisionSet:[]});
assert.equal(renamedFile.changedNodes[0].nodeKey,'POST /api/orders');
assert.equal(renamedFile.changedNodes[0].path,'app.py');
assert.equal(renamedFile.status,'incomplete');
assert.deepEqual(renamedFile.coverage.renamedFiles,['app.py','renamed.py']);
const removedFile=assessTeamChangedFiles({files:[{filename:'app.py',status:'removed'}],
  nodes,edges,projectKey:'prj_orders',baseSha:base,headSha:head,revisionSet:[]});
assert.equal(removedFile.changedNodes[0].nodeKey,'POST /api/orders');
assert.deepEqual(removedFile.coverage.deletedFiles,['app.py']);
assert.deepEqual(removedFile.coverage.uninspectableFiles,['app.py']);
const generatedFile=assessTeamChangedFiles({files:[{filename:'generated/app.py',patch:'@@ -4 +4 @@'}],
  nodes,edges,projectKey:'prj_orders',baseSha:base,headSha:head,revisionSet:[]});
assert.deepEqual(generatedFile.coverage.generatedFiles,['generated/app.py']);
assert.equal(generatedFile.status,'incomplete');
assert.equal(assessTeamChangedFiles({files:[{filename:'unknown.py'}],nodes,edges,projectKey:'prj_orders',
  baseSha:base,headSha:head,revisionSet:[]}).status,'incomplete');
console.log('Immutable PR diff maps candidate Python contracts to React impact and unknown coverage');
