import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openTeamSyncStore} from '../packages/core/team-sync-store.mjs';
import {syncSourceFactsOnce} from '../packages/core/team-sync-client.mjs';
import {extractOpenApiSourceFacts} from '../packages/core/source-fact-partition.mjs';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aipi-source-facts-'));
const workspaceId='8a263672-38cd-4f3d-a33a-39ef3c62c5ab';
const sourceBindingId='src_orders123';
const revision='a'.repeat(40);
let store;
try{
  store=await openTeamSyncStore(directory);
  const fact=extractOpenApiSourceFacts({workspaceId,projectKey:'prj_orders',sourceBindingId,revision,
    path:'openapi.json',content:JSON.stringify({openapi:'3.1.0',paths:{'/orders':{get:{responses:{200:{description:'ok'}}}}}})});
  const row={project_key:fact.projectKey,source_id:sourceBindingId,revision_commit:revision,path:fact.path,
    analyzer_version:fact.analyzerVersion,content_hash:fact.contentHash,fact_hash:fact.factHash,facts:fact.facts};
  const input={baseUrl:'https://aipi.test',accessToken:'session',githubUserToken:'github-user-token-1234567890',
    workspaceId,sourceBindingId,revision};
  const fetchImpl=async()=>({ok:true,json:async()=>({partitions:[row]})});
  assert.equal(await syncSourceFactsOnce(store,{...input,fetchImpl}),1);
  assert.equal(store.sourceFacts(workspaceId,sourceBindingId,revision).length,1);
  await assert.rejects(()=>syncSourceFactsOnce(store,{...input,fetchImpl:async()=>({ok:true,
    json:async()=>({partitions:[{...row,fact_hash:'0'.repeat(64)}]})})}),/integrity/);
  assert.equal(store.sourceFacts(workspaceId,sourceBindingId,revision).length,1,'invalid page leaves previous cache intact');
  await assert.rejects(()=>syncSourceFactsOnce(store,{...input,fetchImpl:async()=>({ok:false,status:403,
    json:async()=>({error:'Repository access revoked'})})}),/revoked/);
  assert.deepEqual(store.sourceFacts(workspaceId,sourceBindingId,revision),[],'revoked source cache is evicted');
}finally{store?.close();await fs.rm(directory,{recursive:true,force:true});}
console.log('Source-scoped fact cache validates hashes and evicts on lost repository grants');
