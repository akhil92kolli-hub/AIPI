import assert from 'node:assert/strict';
import {workspaceViewMarkup, workspaceAssessmentMarkup, workspaceTaskDetailMarkup, workspaceReleaseMarkup, WORKSPACE_TABS} from '../ui/workspace-app.js';
const model={workspace:{name:'Commerce <script>',mode:'team'},projects:[{id:'prj_react',name:'React'},{id:'prj_python',name:'Python'}],tasks:[{id:'task_one',projectId:'prj_react',title:'Repair caller',status:'in_review'},{id:'task_two',projectId:'prj_python',title:'Fix API',status:'blocked'},{id:'task_cross',projectId:'',projectIds:['prj_react','prj_python'],title:'Verify contract callers',status:'open'}],contracts:[{projectId:'prj_python',method:'GET',route:'/orders'}],targets:[],capabilities:{source:'Awaiting authorized GitHub access'}};
assert.deepEqual(WORKSPACE_TABS.map(([key])=>key),['home','explore','tasks','kmaps','tools']);
const all=workspaceViewMarkup(model,'tasks');
assert.match(all,/Repair caller/);assert.match(all,/Fix API/);
assert.doesNotMatch(all,/<script>/);assert.match(all,/Commerce &lt;script&gt;/);
const filtered=workspaceViewMarkup(model,'tasks','prj_react');
assert.match(filtered,/Repair caller/);assert.doesNotMatch(filtered,/Fix API/);
assert.match(filtered,/Verify contract callers/);
assert.match(workspaceViewMarkup(model,'tasks','prj_python'),/Verify contract callers/);
assert.match(workspaceViewMarkup(model,'tools'),/Awaiting authorized GitHub access/);
assert.match(workspaceViewMarkup(model,'kmaps'),/No trusted deployment observations are available/);
const releaseView=workspaceReleaseMarkup({environment:{name:'Production'},enforcement:{state:'unavailable'},
  observations:[{projectId:'prj_react',label:'Storefront',revision:'f'.repeat(40),cohort:'Deployed'}],
  pairs:[
    {producerProjectId:'prj_python',producerLabel:'Orders',producerRevision:'b'.repeat(40),consumerProjectId:'prj_react',consumerLabel:'Storefront',consumerRevision:'f'.repeat(40),cohort:'Deployed',status:'failed',reason:'Removed total field'},
    {producerProjectId:'prj_python',producerLabel:'Orders',producerRevision:'b'.repeat(40),consumerProjectId:'prj_react',consumerLabel:'Storefront',consumerRevision:'a'.repeat(40),cohort:'Proposed',status:'passed',reason:'Candidate checks passed'},
  ]},'prj_python');
assert.match(releaseView,/Deployment gate not enforced/);
assert.match(releaseView,/Removed total field/);
assert.match(releaseView,/data-evidence-state="failed"/);
assert.match(releaseView,/data-evidence-state="passed"/);
assert.match(releaseView,/A passing proposed pair does not clear a failing deployed consumer/);
assert.doesNotMatch(workspaceReleaseMarkup({pairs:[{producerLabel:'<script>',status:'passed'}]}),/<script>/);
assert.match(workspaceViewMarkup(model,'home'),/No change has been assessed/);
assert.match(workspaceViewMarkup({...model,assessmentEntryTab:'tasks'},'home'),/Assess a linked PR in Tasks/);
const localAssessment={comparison:{baseCommit:'abc123',headCommit:'def456',totalChangedFiles:2},
  evaluatedAt:'2026-10-22T00:00:00Z',verification:{status:'failed',counts:{passed:1,failed:1,missing:1,stale:0,unknown:1},limitations:['Discovery incomplete']},
  components:[{projectId:'orders',label:'GET /orders',source:{path:'app.py',line:7},coverage:{status:'failed',checks:[{required:true,status:'failed',reason:'Contract mismatch'}]}},
    {projectId:'billing',label:'<script>',coverage:{status:'missing',checks:[{required:true,status:'missing',reason:'No check configured'}]}}],
  omitted:{components:2}};
const summary=workspaceAssessmentMarkup(localAssessment,{refreshable:true});
assert.match(summary,/data-evidence-state="failed"/, 'a known failure stays visible even when the view is bounded');
assert.match(workspaceAssessmentMarkup({...localAssessment,verification:{status:'passed'},omitted:{components:2}}),/data-evidence-state="unknown"/, 'a bounded view cannot claim an unqualified pass');
assert.match(summary,/failed: 1/);assert.match(summary,/missing: 1/);
assert.match(summary,/app.py:7/);assert.match(summary,/No check configured/);
assert.match(summary,/bounded view omits additional results/);
assert.match(summary,/data-refresh-assessment/);
assert.doesNotMatch(summary,/<script>/);
assert.match(workspaceViewMarkup({...model,assessment:localAssessment},'tasks'),/Contract mismatch/);
const candidate=workspaceAssessmentMarkup({kind:'candidate',subject:'repo <private> PR #1',comparison:{baseCommit:'abc',headCommit:'def'},
  verification:{status:'passed',limitations:['File-level candidate only'],counts:{unknown:1,missing:1}},candidateChecks:['npm test'],
  semanticComparisons:[{path:'openapi.json',status:'compared',reason:'Review consumers',changes:[{location:'GET /orders',kind:'property_removed',effect:'breaking_candidate'}]}],
  components:[{projectId:'orders',label:'Candidate API',coverage:{status:'passed'}}]});
assert.match(candidate,/data-evidence-state="unknown"/);
assert.match(candidate,/Candidate checks, not executed: npm test/);
assert.match(candidate,/Required checks —/);
assert.match(candidate,/OpenAPI structural comparison/);
assert.match(candidate,/property_removed/);
assert.match(candidate,/repo &lt;private&gt; PR #1/);
assert.doesNotMatch(candidate,/data-evidence-state="passed"/);
assert.match(workspaceAssessmentMarkup({kind:'candidate',verification:{status:'passed'},components:[]},{entryTab:'tasks'}),/Inspect linked PR in Tasks/);

// Task detail markup tests
const detailTask = {
  id: 'task_detail_1',
  title: 'Audit cross-repo contracts <script>',
  description: 'Verify checkout caller to handler contract',
  status: 'in_progress',
  projectId: 'prj_orders',
  projectName: 'Orders',
  scope: [{ projectKey: 'prj_orders' }, { projectKey: 'prj_storefront' }],
  revisionSet: [{ projectKey: 'prj_orders', commit: 'abcdef1234567890' }],
};
const detailContext = {
  decisions: [{ body: 'Use JSON Schema validation on payload' }],
  evidence: [],
  receipts: [{ result: 'passed', summary: 'E2E checkout test passed', freshness: '5m ago' }],
  comments: [{ id: 'cmt_1', body: 'Handed off to agent', createdAt: '2026-10-23T05:00:00Z' }],
};

const detailMarkup = workspaceTaskDetailMarkup(detailTask, detailContext);
assert.match(detailMarkup, /data-workspace-task-detail="task_detail_1"/);
assert.match(detailMarkup, /Audit cross-repo contracts &lt;script&gt;/);
assert.doesNotMatch(detailMarkup, /<script>/);
assert.match(detailMarkup, /data-task-status="in_progress"/);
assert.match(detailMarkup, /prj_storefront/);
assert.match(detailMarkup, /abcdef123456/);
assert.match(detailMarkup, /Use JSON Schema validation on payload/);
assert.match(detailMarkup, /E2E checkout test passed/);
assert.match(detailMarkup, /data-evidence-state="unknown">Reported passed/);
assert.match(detailMarkup, /Handed off to agent/);
assert.match(detailMarkup, /data-close-workspace-task/);
assert.match(detailMarkup, /data-task-handoff="task_detail_1"/);
assert.match(detailMarkup, /<option value="proposed"/);
assert.match(detailMarkup, /<option value="archived"/);
assert.match(detailMarkup, /Receipt labels are claims/);
const cloudDetail = workspaceTaskDetailMarkup({...detailTask, revisionSet: []}, {...detailContext, evidence: [{kind:'check',producer:'CI',freshness:'current'}]}, {canPrepareHandoff:false,selectedStatus:'blocked'});
assert.doesNotMatch(cloudDetail, /data-task-handoff=/);
assert.match(cloudDetail, /Open this task in a connected companion/);
assert.match(cloudDetail, /No source revision pinned\. Verification remains unknown/);
assert.match(cloudDetail, /check · CI/);
assert.match(cloudDetail, /<option value="blocked" selected/);

// Rendered via workspaceViewMarkup with selectedTaskId
const viewWithTask = workspaceViewMarkup(model, 'tasks', '', {
  selectedTaskId: 'task_one',
  taskContext: { decisions: [{ body: 'Selected task decision' }] },
});
assert.match(viewWithTask, /data-workspace-task-detail="task_one"/);
assert.match(viewWithTask, /Repair caller/);
assert.match(viewWithTask, /Selected task decision/);
assert.match(viewWithTask, /data-close-workspace-task/);

// UX01-UX08 tests: Work queue, independent gates, publication review dialog, unresolved citations, K-Maps evidence classes
const homeMarkup = workspaceViewMarkup({
  ...model,
  assessment: localAssessment,
  alsoAffectedOutsideProject: [{ projectId: 'prj_react', projectName: 'React', label: 'CheckoutForm.tsx', status: 'stale', reason: 'Affected downstream consumer' }],
}, 'home', 'prj_python');
assert.match(homeMarkup, /data-workspace-work-queue/);
assert.match(homeMarkup, /data-merge-check-state="failed"/);
assert.match(homeMarkup, /data-deployment-gate-state="unavailable"/);
assert.match(homeMarkup, /Also affected outside this project/);
assert.match(homeMarkup, /data-outside-project-impact/);
assert.match(homeMarkup, /data-publication-review-dialog/);
assert.match(homeMarkup, /closedby="any"/);
assert.match(homeMarkup, /Sharing records the unresolved impact\. Merge and deployment checks remain independent\./);

assert.match(candidate, /Breaking candidate/, 'structural delta effect renders plain-language badge');

const unresolvedTaskDetail = workspaceTaskDetailMarkup(
  { ...detailTask, citationStatus: 'source_citation_unresolved' },
  detailContext,
  { handoffDeliveryState: 'Saved / copied — open your agent to continue' }
);
assert.match(unresolvedTaskDetail, /Source citation unresolved/);
assert.match(unresolvedTaskDetail, /data-task-section="work"/);
assert.match(unresolvedTaskDetail, /data-task-section="context"/);
assert.match(unresolvedTaskDetail, /data-task-section="checks"/);
assert.match(unresolvedTaskDetail, /data-task-section="activity"/);
assert.match(unresolvedTaskDetail, /data-advisory-boundary="data-only"/);
assert.match(unresolvedTaskDetail, /data-prepare-context="task_detail_1"/);
assert.match(unresolvedTaskDetail, /Saved \/ copied — open your agent to continue/);

const kmapsSuggested = workspaceViewMarkup({
  ...model,
  contracts: [{ id: 'cnt_sug', projectId: 'prj_python', method: 'POST', route: '/checkout', evidenceClass: 'suggested' }],
}, 'kmaps');
assert.match(kmapsSuggested, /data-kmaps-section="contracts"/);
assert.match(kmapsSuggested, /data-evidence-class="suggested">Suggested/);
assert.match(kmapsSuggested, /data-confirm-link="cnt_sug"/);
assert.match(kmapsSuggested, /data-ignore-link="cnt_sug"/);

console.log('Shared workspace tabs, project filtering, capability states, task detail and HTML escaping passed');
