import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import app from '../cloud/worker.ts';

const secret='controller-secret-with-at-least-32-characters';
const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'test-key',
  SUPABASE_SERVICE_ROLE_KEY:'service-key',AIPI_DEPLOYMENT_CONTROLLER_SECRET:secret};
const workspaceId='8a263672-38cd-4f3d-a33a-39ef3c62c5ab';
const base=`https://aipi.test/api/deployment-controller/workspaces/${workspaceId}/environments/production`;
const originalFetch=globalThis.fetch;
const writes=[];
globalThis.fetch=async(input,init={})=>{
  const url=String(input);
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer service-key');
  if(url.includes('team_deployment_environments?'))return Response.json([{generation:2,observed_at:'2026-10-23T12:00:00Z'}]);
  if(url.includes('team_deployment_cohorts?'))return Response.json([{cohort_id:'stable',project_key:'prj_orders',
    source_id:'src_orders123',revision_commit:'a'.repeat(40),artifact_digest:`sha256:${'b'.repeat(64)}`}]);
  if(url.includes('rpc/apply_team_deployment_event')){writes.push(JSON.parse(init.body));return Response.json({generation:3,duplicate:false});}
  throw new Error(`Unexpected request ${url}`);
};
const signed=(url,body)=>{
  const timestamp=String(Date.now());
  const text=JSON.stringify(body);
  const path=new URL(url).pathname;
  const signature=createHmac('sha256',secret).update(`${timestamp}.POST.${path}.${text}`).digest('hex');
  return {method:'POST',body:text,headers:{'content-type':'application/json',
    'x-aipi-controller-timestamp':timestamp,'x-aipi-controller-signature':`sha256=${signature}`}};
};
try{
  assert.equal((await app.request(`${base}/state`,{method:'POST',body:'{}'},env)).status,401);
  const state=await app.request(`${base}/state`,signed(`${base}/state`,{}),env);
  assert.equal(state.status,200);
  assert.equal((await state.json()).generation,2);
  const event={eventId:'9ac96253-f2c1-4875-accc-ef48ab41c3e8',expectedGeneration:2,
    projectKey:'prj_orders',sourceBindingId:'src_orders123',revision:'a'.repeat(40),
    artifactDigest:`sha256:${'b'.repeat(64)}`,cohortId:'stable',active:true};
  const observed=await app.request(`${base}/observe`,signed(`${base}/observe`,event),env);
  assert.equal(observed.status,200);
  assert.equal((await observed.json()).observation.generation,3);
  assert.equal(writes[0].p_expected_generation,2);
  const stale=await app.request(`${base}/decision`,signed(`${base}/decision`,{
    expectedGeneration:1,projectKey:event.projectKey,sourceBindingId:event.sourceBindingId,
    revision:event.revision,artifactDigest:event.artifactDigest}),env);
  assert.equal((await stale.json()).status,'stale');
  const unknown=await app.request(`${base}/decision`,signed(`${base}/decision`,{
    expectedGeneration:2,projectKey:event.projectKey,sourceBindingId:event.sourceBindingId,
    revision:event.revision,artifactDigest:event.artifactDigest}),env);
  assert.equal((await unknown.json()).canDeploy,false);
}finally{globalThis.fetch=originalFetch;}
console.log('Signed deployment controller records exact cohorts and blocks stale or unproven decisions');
