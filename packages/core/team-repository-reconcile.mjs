import {normalizeSourceBinding} from "./workspace-identity.mjs";
import path from "node:path";
import {canonicalGithubRepositoryRemote,normalizeRepositoryBinding} from "./workspace-manifest.mjs";

const sameBinding=(a,b)=>a&&b&&String(a.providerRepositoryId)===String(b.providerRepositoryId)&&
  canonicalGithubRepositoryRemote(a.remote)===canonicalGithubRepositoryRemote(b.remote)&&(a.root??".")===(b.root??".");

// Cloud metadata is not authority to rewrite a local checkout or Git remote.
// Apply only after matching an authorized checkout and rechecking local state.
export async function reconcileTeamRepositories(store,{organizationId,accessToken,loadState,mutateState,inspectGit,
  fetchImpl=fetch,baseUrl="https://mcp.aipi.website"}){
  if(!/^https:\/\//.test(baseUrl)||!accessToken)throw new Error("Secure Team endpoint and session required");
  const links=store.db.prepare("select * from team_project_links where organization_id = ?").all(organizationId);
  const workspaceIds=[...new Set(links.map(link=>link.workspace_id))];
  if(workspaceIds.length>50)throw new Error("Repository reconciliation exceeds the workspace limit");
  const result={linked:0,unchanged:0,conflicts:0,pending:0};
  if(!links.length)return result;
  const headers={authorization:`Bearer ${accessToken}`};
  const get=async route=>{const response=await fetchImpl(`${baseUrl}${route}`,{headers,signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Repository reconciliation access check failed (${response.status})`);return response.json();};
  const visible=await get(`/api/team/organizations/${encodeURIComponent(organizationId)}/workspaces`);
  const state=await loadState();
  const updates=[];
  for(const workspaceId of workspaceIds){
    if(!visible.workspaces?.some(workspace=>workspace.id===workspaceId))throw new Error("Linked Team workspace is no longer accessible");
    const remote=await get(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/projects`);
    if(!Array.isArray(remote.projects)||remote.projects.length>200)throw new Error("Invalid Team project list");
    const portable=await get(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/identity`);
    if(portable.identity?.schemaVersion!==3||!Array.isArray(portable.identity.projects))throw new Error("Cloud workspace identity is unavailable");
    // The persisted local registry is the durable retry source. Stable source IDs
    // make a lost acknowledgement safe to retry. Repository rights are confirmed
    // separately in the browser; a device may publish only local/endpoint metadata.
    for(const link of links.filter(item=>item.workspace_id===workspaceId)){
      const local=state.projects?.find(project=>project.id===link.project_key);
      const cloud=portable.identity.projects.find(project=>project.id===link.project_key);
      if(!local||!cloud)continue;
      for(const source of (local.sourceBindings??[]).filter(source=>!source.supersededBy)){
        if(cloud.sources.some(item=>item.id===source.id)||(portable.identity.aliases??[]).some(alias=>alias.sourceId===source.id))continue;
        const declaration={kind:source.kind==='external'?'external':'local',name:source.name,...(source.kind==='external'?{endpoint:source.endpoint}:{})};
        const response=await fetchImpl(`${baseUrl}/api/team/workspaces/${workspaceId}/projects/${encodeURIComponent(local.id)}/sources/${encodeURIComponent(source.id)}`,{
          method:'PUT',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(declaration),signal:AbortSignal.timeout(15000),
        });
        if(!response.ok)throw new Error(`Source declaration synchronization failed (${response.status})`);
        const result=await response.json();
        cloud.sources.push({id:result.source.source_id,...declaration,repository:null,version:result.source.version});
      }
    }
    for(const link of links.filter(item=>item.workspace_id===workspaceId)){
      const project=state.projects?.find(item=>item.id===link.project_key);
      if(!project)continue;
      const cloud=remote.projects.find(item=>item.project_key===project.id);
      let repository=null,status="pending",reason="Connect this project to a repository in workspace settings.";
      if(cloud?.provider_repository_id&&cloud?.remote_url){
        repository=normalizeRepositoryBinding({provider:"github",providerRepositoryId:String(cloud.provider_repository_id),remote:cloud.remote_url,root:cloud.repository_root??"."});
        if(project.repositoryBinding&&!sameBinding(project.repositoryBinding,repository)){
          status="conflict";reason="Local and cloud repository identities or project paths differ. Review the mapping before syncing knowledge.";
        }else{
          for(const root of project.sourceContext?.roots??[]){
            let inspection;try{inspection=await inspectGit(root.path);}catch{continue;}
            const relative=inspection.repositoryRoot?path.relative(inspection.repositoryRoot,root.path).split(path.sep).join("/")||".":null;
            const matches=(inspection.remotes??[]).some(item=>[item.fetchUrl,item.pushUrl].some(url=>canonicalGithubRepositoryRemote(url)===canonicalGithubRepositoryRemote(repository.remote)));
            if(matches&&relative===repository.root){status="connected";reason="Cloud binding matches an authorized local checkout.";break;}
          }
          if(status!=="connected"){status="conflict";reason="No authorized local source matches the cloud repository and project path. Add or review its checkout.";}
        }
      }else if(project.repositoryBinding){status="conflict";reason="The cloud repository binding is absent. The local mapping was preserved for review.";}
      const aliases=(portable.identity.aliases??[]).filter(alias=>alias.projectId===project.id);
      const sources=(portable.identity.projects.find(item=>item.id===project.id)?.sources??[]).map(normalizeSourceBinding);
      const sourceConflicts=sources.filter(source=>{const local=project.sourceBindings?.find(item=>item.id===source.id);return local?.repository&&(!source.repository||!sameBinding(local.repository,source.repository));}).map(source=>source.id);
      if(sourceConflicts.length){status="conflict";reason="One or more source bindings differ from the cloud declaration. Review their identities before syncing knowledge.";}
      updates.push({projectId:project.id,sources,aliases,expectedSources:JSON.stringify(project.sourceBindings??[]),expected:JSON.stringify(project.repositoryBinding??null),roots:JSON.stringify(project.sourceContext?.roots??[]),repository,
        sync:{status,reason,sourceConflicts,workspaceId,providerRepositoryId:repository?.providerRepositoryId??null,remote:repository?.remote??null,root:repository?.root??null,version:cloud?.version??null}});
    }
  }
  if(updates.every(update=>{const project=state.projects.find(item=>item.id===update.projectId);return update.aliases.every(alias=>(!(project.sourceBindings??[]).some(local=>local.id===alias.sourceId)||(project.sourceBindings??[]).find(local=>local.id===alias.sourceId)?.supersededBy===alias.canonicalSourceId))&&update.sources.every(source=>(project.sourceBindings??[]).some(local=>local.id===source.id&&JSON.stringify(normalizeSourceBinding(local))===JSON.stringify(source)))&&JSON.stringify(project.teamRepositorySync)===JSON.stringify(update.sync)&&!(update.sync.status==="connected"&&!project.repositoryBinding);})){
    for(const update of updates){if(update.sync.status==="connected")result.unchanged++;else if(update.sync.status==="conflict")result.conflicts++;else result.pending++;}
    return result;
  }
  await mutateState(next=>{
    for(const update of updates){
      const project=next.projects.find(item=>item.id===update.projectId);
      if(!project||JSON.stringify(project.repositoryBinding??null)!==update.expected||JSON.stringify(project.sourceContext?.roots??[])!==update.roots){result.conflicts++;continue;}
      if(JSON.stringify(project.sourceBindings??[])!==update.expectedSources){result.conflicts++;continue;}
      project.sourceBindings??=[];
      for(const source of update.sources){
        const local=project.sourceBindings.find(item=>item.id===source.id);
        if(!local)project.sourceBindings.push(source); // metadata only; no device path is inferred
        else if(!update.sync.sourceConflicts.includes(source.id)&&source.version>=local.version)Object.assign(local,source);
      }
      for(const alias of update.aliases){
        const old=project.sourceBindings.find(source=>source.id===alias.sourceId);
        if(old)old.supersededBy=alias.canonicalSourceId;
        for(const root of project.sourceContext?.roots??[])if(root.sourceBindingId===alias.sourceId)root.sourceBindingId=alias.canonicalSourceId;
        for(const checkout of next.deviceCheckoutBindings??[])if(checkout.projectId===project.id&&checkout.sourceBindingId===alias.sourceId)checkout.sourceBindingId=alias.canonicalSourceId;
      }
      if(update.sync.status==="connected"){
        if(!project.repositoryBinding){project.repositoryBinding=update.repository;result.linked++;
          for(const group of next.workspaceGroups??[])if(group.projectIds.includes(project.id))group.bindingVersion=(group.bindingVersion??0)+1;
        }else result.unchanged++;
      }else if(update.sync.status==="conflict")result.conflicts++;else result.pending++;
      if(JSON.stringify(project.teamRepositorySync)!==JSON.stringify(update.sync))project.teamRepositorySync=update.sync;
    }
  });
  return result;
}
