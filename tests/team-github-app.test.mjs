import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { githubAppJwt, publishAipiBlockingCheck, verifyGitHubWebhook, verifyUserInstallationAccess, verifyUserRepositoryAccess } from '../packages/core/team-github-app.mjs';
const secret = 'test-secret';
const body = Buffer.from('{"action":"opened"}');
const signature = `sha256=${createHmac('sha256',secret).update(body).digest('hex')}`;
assert.equal(verifyGitHubWebhook(body,signature,secret),true);
assert.equal(verifyGitHubWebhook(Buffer.from('{"action":"closed"}'),signature,secret),false);
assert.equal(verifyGitHubWebhook(body,'sha256=bad',secret),false);
const { privateKey, publicKey } = generateKeyPairSync('rsa',{modulusLength:2048});
const jwt = githubAppJwt(42,privateKey.export({type:'pkcs1',format:'pem'}),Date.parse('2026-10-20T00:00:00Z'));
const [header,payload,signaturePart] = jwt.split('.');
assert.equal(JSON.parse(Buffer.from(payload,'base64url')).iss,'42');
assert.equal(verify('RSA-SHA256',Buffer.from(`${header}.${payload}`),publicKey,Buffer.from(signaturePart,'base64url')),true);
const githubFetch = async (url) => ({ok:true,json:async()=>url.endsWith('/user') ? {id:42,login:'engineer'} : {installations:[{id:9,app_id:17,account:{id:23,login:'acme'},suspended_at:null}]}});
assert.equal((await verifyUserInstallationAccess({installationId:9,appId:17,userToken:'user-token',fetchImpl:githubFetch})).userId,42);
await assert.rejects(()=>verifyUserInstallationAccess({installationId:10,appId:17,userToken:'user-token',fetchImpl:githubFetch}),/cannot access/);
const repositoryFetch = async (url) => ({ok:true,json:async()=>url.endsWith('/user') ? {id:42,login:'engineer'}
  : url.includes('/repositories?') ? {repositories:[{id:55,full_name:'acme/service',permissions:{pull:true,push:false}}]}
  : {installations:[{id:9,app_id:17,account:{id:23,login:'acme'},suspended_at:null}]}});
const access = await verifyUserRepositoryAccess({installationId:9,appId:17,repositoryId:'55',userToken:'user-token',fetchImpl:repositoryFetch});
assert.equal(access.canRead,true);
assert.equal(access.canWrite,false);
await assert.rejects(()=>verifyUserRepositoryAccess({installationId:9,appId:17,repositoryId:'56',userToken:'user-token',fetchImpl:repositoryFetch}),/cannot access this installed repository/);
const calls=[];
let existing=[];
const checksFetch=async(url,options={})=>{
  calls.push({url,options});
  let data;
  if(url.includes('/access_tokens'))data={token:'installation-token',permissions:{checks:'write'}};
  else if(url.includes('/commits/')&&url.includes('/check-runs'))data={total_count:existing.length,check_runs:existing};
  else if(options.method==='POST')data={id:99};
  else if(options.method==='PATCH')data={id:99};
  else throw new Error('Unexpected GitHub request');
  return {ok:true,json:async()=>data};
};
const checkInput={repository:'acme/service',headSha:'a'.repeat(40),installationId:9,repositoryId:55,appId:17,
  privateKey:privateKey.export({type:'pkcs1',format:'pem'}),summary:'Exact pair proof unavailable',
  externalId:`aipi:pr:55:${'a'.repeat(40)}`,fetchImpl:checksFetch};
assert.equal((await publishAipiBlockingCheck(checkInput)).conclusion,'failure');
assert.equal(JSON.parse(calls.find(call=>call.options.method==='POST'&&call.url.endsWith('/check-runs')).options.body).conclusion,'failure');
existing=[{id:99,external_id:checkInput.externalId,app:{id:17}}];
assert.equal((await publishAipiBlockingCheck(checkInput)).reused,true);
assert.ok(calls.some(call=>call.options.method==='PATCH'));
await assert.rejects(()=>publishAipiBlockingCheck({...checkInput,headSha:'invalid'}),/pinned GitHub check/);
console.log('GitHub webhook HMAC and app JWT signatures passed');
