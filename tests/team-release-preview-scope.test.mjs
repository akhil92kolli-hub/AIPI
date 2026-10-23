import assert from 'node:assert/strict';
import app from '../cloud/worker.ts';

const workspaceId='8a263672-38cd-4f3d-a33a-39ef3c62c5ab';
const userId='8a263672-38cd-4f3d-a33a-39ef3c62c5ac';
const organizationId='8a263672-38cd-4f3d-a33a-39ef3c62c5ad';
const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'test-key',
  SUPABASE_SERVICE_ROLE_KEY:'service-key',GITHUB_APP_ID:'17'};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input)=>{
  const url=String(input);
  if(url.endsWith('/auth/v1/user'))return Response.json({id:userId});
  if(url.includes('/team_workspaces?'))return Response.json([{id:workspaceId,organization_id:organizationId}]);
  if(url.includes('/team_deployment_cohorts?'))return Response.json([
    {cohort_id:'stable',project_key:'prj_orders',source_id:'src_orders123',revision_commit:'a'.repeat(40),
      artifact_digest:`sha256:${'b'.repeat(64)}`,observed_at:new Date().toISOString()},
    {cohort_id:'private',project_key:'prj_hidden',source_id:'src_hidden123',revision_commit:'c'.repeat(40),
      artifact_digest:`sha256:${'d'.repeat(64)}`,observed_at:new Date().toISOString()}]);
  if(url.includes('/team_source_bindings?'))return Response.json(url.includes('src_orders123')
    ?[{project_key:'prj_orders',provider_repository_id:'55',repository_root:'.',kind:'repository'}]
    :[{project_key:'prj_hidden',provider_repository_id:'56',repository_root:'.',kind:'repository'}]);
  if(url.includes('/team_workspace_repositories?'))return Response.json(url.includes('eq.55')
    ?[{repository:'acme/orders'}]:[{repository:'acme/hidden'}]);
  if(url.includes('/team_github_installations?'))return Response.json([{installation_id:9}]);
  if(url.includes('/team_github_user_identities?'))return Response.json([{github_user_id:42}]);
  if(url.endsWith('/user'))return Response.json({id:42,login:'engineer'});
  if(url.includes('/user/installations/9/repositories?'))return Response.json({repositories:[
    {id:55,full_name:'acme/orders',permissions:{pull:true}}]});
  if(url.includes('/user/installations?'))return Response.json({installations:[
    {id:9,app_id:17,suspended_at:null}]});
  throw new Error(`Unexpected request ${url}`);
};
try{
  const response=await app.request(`https://aipi.test/api/team/workspaces/${workspaceId}/release-compatibility?environmentId=production`,
    {headers:{authorization:'Bearer test-user-token','x-aipi-github-user-token':'github-user-token-1234567890'}},env);
  assert.equal(response.status,200);
  const result=(await response.json()).releaseCompatibility;
  assert.equal(result.observations.length,1);
  assert.equal(result.observations[0].projectId,'prj_orders');
  assert.equal(Object.hasOwn(result,'restrictedScope'),false);
  assert.equal(result.canDeploy,false);
  assert.ok(!JSON.stringify(result).includes('prj_hidden'));
}finally{globalThis.fetch=originalFetch;}
console.log('Team compatibility preview includes authorized cohorts and hides restricted repository versions');
