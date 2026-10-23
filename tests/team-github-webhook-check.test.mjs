import assert from 'node:assert/strict';
import {createHmac,generateKeyPairSync} from 'node:crypto';
import app from '../cloud/worker.ts';

const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'test-key',
  SUPABASE_SERVICE_ROLE_KEY:'service-key',GITHUB_WEBHOOK_SECRET:'webhook-secret',GITHUB_APP_ID:'17',
  GITHUB_APP_PRIVATE_KEY:privateKey.export({type:'pkcs1',format:'pem'})};
const originalFetch=globalThis.fetch;
const calls=[];
globalThis.fetch=async(input,init={})=>{
  const url=String(input);
  calls.push({url,method:init.method??'GET',body:init.body?JSON.parse(init.body):null});
  if(url.includes('/rpc/apply_team_github_webhook'))return Response.json({processed:1,organizationId:'00000000-0000-4000-8000-000000000001'});
  if(url.includes('/rest/v1/team_github_installations?'))return Response.json([{organization_id:'00000000-0000-4000-8000-000000000001'}]);
  if(url.includes('/rest/v1/team_workspace_projects?'))return Response.json([{workspace_id:'00000000-0000-4000-8000-000000000002'}]);
  if(url.includes('/rest/v1/team_workspaces?'))return Response.json([{id:'00000000-0000-4000-8000-000000000002'}]);
  if(url.includes('/access_tokens'))return Response.json({token:'installation-token',permissions:{checks:'write'}});
  if(url.includes('/commits/')&&url.includes('/check-runs?'))return Response.json({total_count:0,check_runs:[]});
  if(url.endsWith('/check-runs')&&init.method==='POST')return Response.json({id:99});
  throw new Error(`Unexpected request ${url}`);
};
try{
  const repository={id:55,full_name:'acme/service'};
  const send=async(event,payload,delivery)=>{
    const body=JSON.stringify(payload);
    return app.request('https://aipi.test/api/github/webhook',{method:'POST',body,headers:{
      'x-github-event':event,'x-github-delivery':delivery,
      'x-hub-signature-256':`sha256=${createHmac('sha256',env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}`}},env);
  };
  const pr=await send('pull_request',{action:'opened',installation:{id:9},repository,
    pull_request:{head:{sha:'a'.repeat(40)}}},'00000000-0000-4000-8000-000000000003');
  assert.equal(pr.status,200);
  assert.equal((await pr.json()).check.conclusion,'failure');
  const merge=await send('merge_group',{action:'checks_requested',installation:{id:9},repository,
    merge_group:{head_sha:'b'.repeat(40)}},'00000000-0000-4000-8000-000000000004');
  assert.equal(merge.status,200);
  assert.equal((await merge.json()).check.headSha,'b'.repeat(40));
  const checkCalls=calls.filter(call=>call.url.endsWith('/check-runs')&&call.method==='POST');
  assert.equal(checkCalls.length,2);
  assert.deepEqual(checkCalls.map(call=>call.body.conclusion),['failure','failure']);
  assert.deepEqual(checkCalls.map(call=>call.body.head_sha),['a'.repeat(40),'b'.repeat(40)]);
}finally{globalThis.fetch=originalFetch;}
console.log('Signed PR and merge-group webhooks publish fail-closed checks on exact event heads');
