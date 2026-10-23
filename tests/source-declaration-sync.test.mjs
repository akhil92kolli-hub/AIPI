import assert from 'node:assert/strict';
import {reconcileTeamRepositories} from '../packages/core/team-repository-reconcile.mjs';
const org='11111111-1111-4111-a111-111111111111',workspace='22222222-2222-4222-a222-222222222222',project='prj_api1234';
const server={identity:{schemaVersion:3,projects:[{id:project,sources:[]}],aliases:[]}};
let writes=0,loseAck=true,deny=false;
const bodies=[];
const fetchImpl=async(url,options={})=>{
 if(options.method==='PUT'){
  if(deny)return {ok:false,status:403};
  const sourceId=url.split('/').at(-1),body=JSON.parse(options.body);bodies.push(body);writes++;
  server.identity.projects[0].sources.push({id:sourceId,...body,version:1});
  if(loseAck){loseAck=false;throw new Error('Connection lost after server commit');}
  return {ok:true,json:async()=>({source:{source_id:sourceId,version:1}})};
 }
 return {ok:true,json:async()=>url.endsWith('/identity')?structuredClone(server):url.endsWith('/workspaces')?{workspaces:[{id:workspace}]}:{projects:[{project_key:project,version:1}]}};
};
const store={db:{prepare:()=>({all:()=>[{project_key:project,workspace_id:workspace}]})}};
function device(root){let state={projects:[{id:project,name:'API',tasks:[{id:'task_keep'}],sourceBindings:[{id:'src_local1234',name:'Local API',kind:'local',version:1}],sourceContext:{roots:[{path:root,sourceBindingId:'src_local1234'}]}}]};return {state,options:{organizationId:org,accessToken:'private-token',fetchImpl,loadState:async()=>structuredClone(state),mutateState:async fn=>fn(state),inspectGit:async()=>({})}};}
const first=device('/device-a/secret-root');await assert.rejects(reconcileTeamRepositories(store,first.options),/Connection lost/);
await reconcileTeamRepositories(store,first.options);assert.equal(writes,1,'Committed declarations survive a lost acknowledgement without duplicates');
const second=device('/device-b/different-root');await reconcileTeamRepositories(store,second.options);assert.equal(writes,1);
assert.equal(second.state.projects[0].sourceContext.roots[0].path,'/device-b/different-root');
first.state.projects[0].sourceBindings.push({id:'src_extra1234',name:'Extra folder',kind:'local',version:1});await reconcileTeamRepositories(store,first.options);await reconcileTeamRepositories(store,second.options);
assert.equal(second.state.projects[0].sourceBindings.length,2);assert.equal(second.state.projects[0].sourceContext.roots.length,1,'Metadata import cannot invent a checkout');
assert.doesNotMatch(JSON.stringify(bodies),/device-a|secret-root|different-root|private-token|\/device-b/);
assert.equal(first.state.projects[0].tasks[0].id,'task_keep');
deny=true;first.state.projects[0].sourceBindings.push({id:'src_denied1234',name:'Denied',kind:'local',version:1});await assert.rejects(reconcileTeamRepositories(store,first.options),/403/);assert.equal(first.state.projects[0].sourceBindings.length,3);
console.log('Two-device source declarations: durable lost-ack retry, new resources, private checkout paths, unchanged task ownership and revoked writes passed');
