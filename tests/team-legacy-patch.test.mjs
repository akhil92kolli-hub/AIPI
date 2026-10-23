import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openTeamSyncStore} from '../packages/core/team-sync-store.mjs';
import {syncTeamOnce} from '../packages/core/team-sync-client.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aipi-legacy-patch-'));
const organizationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const entityId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const deviceId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actorId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
try{
 const store=await openTeamSyncStore(dir);
 store.replaceSnapshot(organizationId,[{entityType:'task',entityId,payload:{id:entityId,workspaceId,externalId:'task_example',title:'Cloud title',description:'Grounded cloud context',revisionSet:[{projectKey:'prj_orders',commit:'a'.repeat(40)}],status:'open',version:1}}],1);
 const enqueue=(operationId,payload)=>store.enqueue({schemaVersion:1,operationId,organizationId,workspaceId,deviceId,actorId,entityType:'task',action:'upsert',baseVersion:1,payload});
 enqueue('11111111-1111-4111-8111-111111111111',{externalId:'task_example',title:'Cloud title',status:'in_progress',description:'',revisionSet:[]});
 const writes=[];
 const fetchImpl=async(url,options)=>{
  if(url.includes('/operations/task')){writes.push(JSON.parse(options.body));return Response.json({accepted:{task_id:entityId,change_sequence:2}});}
  return Response.json({events:[],nextCursor:1,hasMore:false});
 };
 const result=await syncTeamOnce(store,{baseUrl:'https://mcp.aipi.website',accessToken:'session',organizationId,fetchImpl});
 assert.equal(result.accepted,1);
 assert.deepEqual(writes[0].patch,{status:'in_progress'});
 assert.doesNotMatch(JSON.stringify(writes[0]),/Grounded cloud context|revisionSet|description/);
 enqueue('22222222-2222-4222-8222-222222222222',{externalId:'task_example',title:'Different title',status:'in_progress',description:'',revisionSet:[]});
 const conflict=await syncTeamOnce(store,{baseUrl:'https://mcp.aipi.website',accessToken:'session',organizationId,fetchImpl});
 assert.equal(conflict.conflicts,1);
 assert.equal(writes.length,1);
 store.close();
 console.log('Legacy queued task writes preserve rich cloud fields and conflict on ambiguous edits');
}finally{await fs.rm(dir,{recursive:true,force:true});}
