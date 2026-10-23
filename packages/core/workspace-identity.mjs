import crypto from 'node:crypto';
import path from 'node:path';
import {normalizeRepositoryBinding,canonicalGithubRepositoryRemote} from './workspace-manifest.mjs';

const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
export const primarySourceId=projectId=>`src_${crypto.createHash('md5').update(`aipi:primary:${projectId}`).digest('hex').slice(0,24)}`;
const sourceId=value=>typeof value==='string'&&/^src_[A-Za-z0-9_-]{8,100}$/.test(value);
export function normalizeSourceBinding(value){
  if(!value||!sourceId(value.id)||!['local','repository','external'].includes(value.kind))fail('A source binding needs a stable ID and supported kind');
  const name=String(value.name??'').trim();if(!name||name.length>120)fail('Source name must contain 1–120 characters');
  const repository=value.repository?normalizeRepositoryBinding(value.repository):null;
  if((value.kind==='repository')!==Boolean(repository))fail('Only repository sources contain a repository identity');
  let endpoint=null;
  if(value.kind==='external'){
    let url;try{url=new URL(value.endpoint);}catch{fail('External source needs an HTTPS endpoint');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail('External endpoints cannot contain credentials, queries or fragments');
    endpoint=url.href;
  }
  const version=value.version??1;if(!Number.isSafeInteger(version)||version<1)fail('Invalid source version');
  const trackingBranch=value.trackingBranch??null,trackingCommit=value.trackingCommit??null;
  if(trackingBranch!==null&&(typeof trackingBranch!=='string'||!trackingBranch||trackingBranch.length>240||/[\x00-\x20~^:?*\[\\]/.test(trackingBranch)||trackingBranch.includes('..')))fail('Invalid tracking branch');
  if(trackingCommit!==null&&!/^[a-f0-9]{40}$/.test(trackingCommit))fail('Invalid tracking commit');
  return {id:value.id,kind:value.kind,name,repository,endpoint,version,trackingBranch,trackingCommit};
}

// Additive migration. Project ownership, task IDs and evidence refs are preserved.
// Source IDs are assigned once and persisted, never derived from checkout paths.
export function normalizeWorkspaceIdentity(state){
  let changed=state.identitySchemaVersion!==1;
  state.deviceCheckoutBindings??=[];
  if(!state.localDeviceId){state.localDeviceId=crypto.randomUUID();changed=true;}
  for(const checkout of state.deviceCheckoutBindings){if(!checkout.id){checkout.id=`cko_${crypto.randomUUID().replaceAll("-","")}`;changed=true;}if(!checkout.deviceId){checkout.deviceId=state.localDeviceId;changed=true;}}
  for(const workspace of state.workspaceGroups??[]){if(!workspace.canonicalId){workspace.canonicalId=workspace.teamWorkspaceId??crypto.randomUUID();changed=true;}}
  for(const project of state.projects??[]){
    const before=JSON.stringify([project.sourceBindings,project.sourceContext?.roots,state.deviceCheckoutBindings.filter(item=>item.projectId===project.id)]);
    project.sourceBindings??=[];
    const roots=project.sourceContext?.roots??[];
    const primary=primarySourceId(project.id);
    if(project.repositoryBinding&&!project.sourceBindings.some(source=>source.id===primary))
      project.sourceBindings.unshift(normalizeSourceBinding({id:primary,kind:'repository',name:project.name,repository:project.repositoryBinding}));
    for(const [index,root] of roots.entries()){
      let id=root.sourceBindingId;
      if(!sourceId(id)||!project.sourceBindings.some(source=>source.id===id)){
        id=index===0?primary:`src_${crypto.randomUUID().replaceAll('-','')}`;
        if(!project.sourceBindings.some(source=>source.id===id))project.sourceBindings.push(normalizeSourceBinding({id,kind:'local',name:index===0?project.name:`${root.kind??'Source'} ${index+1}`}));
        root.sourceBindingId=id;
      }
      const existing=state.deviceCheckoutBindings.find(item=>item.projectId===project.id&&item.root===root.path);
      if(existing)existing.sourceBindingId=id;
      else state.deviceCheckoutBindings.push({id:`cko_${crypto.randomUUID().replaceAll("-","")}`,deviceId:state.localDeviceId,projectId:project.id,sourceBindingId:id,root:root.path,label:null});
    }
    // Legacy primary declarations remain a compatibility input, not a second ID.
    const legacy=project.sourceBindings.find(source=>source.id===primary);
    if(legacy&&project.repositoryBinding&&JSON.stringify(legacy.repository)!==JSON.stringify(normalizeRepositoryBinding(project.repositoryBinding))){
      legacy.repository=normalizeRepositoryBinding(project.repositoryBinding);legacy.kind='repository';legacy.version++;
    }
    changed ||= before!==JSON.stringify([project.sourceBindings,project.sourceContext?.roots,state.deviceCheckoutBindings.filter(item=>item.projectId===project.id)]);
  }
  state.identitySchemaVersion=1;return changed;
}
export function workspaceIdentity(state,workspaceId){
  normalizeWorkspaceIdentity(state);
  const candidates=state.workspaceGroups?.filter(group=>[group.id,group.canonicalId,group.teamWorkspaceId].includes(workspaceId))??[];
  if(candidates.length>1)fail("Workspace identity is ambiguous",409);
  const workspace=candidates[0];
  if(!workspace)fail('Workspace not found',404);
  return {schemaVersion:3,workspace:{id:workspace.teamWorkspaceId??workspace.canonicalId,localAlias:workspace.id,cloudId:workspace.teamWorkspaceId??null,name:workspace.name,version:workspace.version},
    projects:workspace.projectIds.map(id=>{const project=state.projects.find(item=>item.id===id);if(!project)fail('Workspace references an unavailable project',409);
      return {id:project.id,name:project.name,sources:project.sourceBindings.filter(source=>!source.supersededBy).map(normalizeSourceBinding)};})};
}
export function saveSourceBinding(state,workspaceId,projectId,input){
  normalizeWorkspaceIdentity(state);
  const workspace=state.workspaceGroups?.find(group=>group.id===workspaceId);
  const project=state.projects?.find(item=>item.id===projectId);
  if(!project||!workspace?.projectIds.includes(projectId))fail('Project does not belong to this workspace',404);
  const binding=normalizeSourceBinding(input);
  const existing=project.sourceBindings.find(item=>item.id===binding.id);
  if(existing?.supersededBy)fail('This source was consolidated; use its canonical source binding',409);
  const duplicate=project.sourceBindings.find(item=>!item.supersededBy&&item.id!==binding.id&&binding.repository&&item.repository?.providerRepositoryId===binding.repository.providerRepositoryId&&item.repository?.root===binding.repository.root);
  if(duplicate){if(existing)fail('This repository directory is already connected through another source; review its attachment',409);return duplicate;}

  if(existing&&input.expectedVersion!==existing.version)fail('Source changed; reload before saving',409);
  if(existing?.repository&&(!binding.repository||existing.repository.providerRepositoryId!==binding.repository.providerRepositoryId||existing.repository.root!==binding.repository.root))
    fail('Repository identity or directory changed; add a new source binding and review references',409);
  if(existing){Object.assign(existing,binding,{version:existing.version+1});}else project.sourceBindings.push(binding);
  if(binding.id===primarySourceId(projectId))project.repositoryBinding=binding.repository;
  for(const group of state.workspaceGroups??[])if(group.projectIds.includes(projectId))group.bindingVersion=(group.bindingVersion??0)+1;
  return existing??binding;
}
export function attachSourceCheckout(state,workspaceId,projectId,input,inspection){
  normalizeWorkspaceIdentity(state);
  const workspace=state.workspaceGroups?.find(group=>group.id===workspaceId);
  const project=state.projects.find(item=>item.id===projectId);
  const source=project?.sourceBindings.find(item=>item.id===input.sourceBindingId);
  if(!workspace?.projectIds.includes(projectId)||!source)fail('Source is outside this workspace project',404);
  const root=project.sourceContext?.roots?.find(item=>path.resolve(item.path)===path.resolve(input.root??''));
  if(!root)fail('Checkout path is not authorized for this project',403);
  if(source.kind==='external')fail('External endpoints do not have checkouts');
  if(source.repository){
    const expected=canonicalGithubRepositoryRemote(source.repository.remote);
    if(!(inspection?.remotes??[]).some(remote=>[remote.fetchUrl,remote.pushUrl].some(url=>canonicalGithubRepositoryRemote(url)===expected)))fail('Checkout repository does not match source binding',409);
    if(!inspection.repositoryRoot||((path.relative(inspection.repositoryRoot,root.path).split(path.sep).join('/'))||'.')!==source.repository.root)fail('Checkout directory does not match source binding',409);
  }
  root.sourceBindingId=source.id;
  const existing=state.deviceCheckoutBindings.find(item=>item.projectId===projectId&&item.root===root.path);
  const checkout={...existing,projectId,sourceBindingId:source.id,root:root.path,repositoryRoot:inspection?.repositoryRoot??null,branch:inspection?.branch??null,commit:inspection?.commit??null};
  if(existing)Object.assign(existing,checkout);else state.deviceCheckoutBindings.push(checkout);return checkout;
}
export function normalizeSourceRevisions(revisions){
  if(!Array.isArray(revisions)||revisions.length>200)fail('A bounded source revision set is required');
  const seen=new Set();
  return revisions.map(revision=>{
    if(!/^prj_[A-Za-z0-9_-]{4,100}$/.test(revision.projectId)||!sourceId(revision.sourceBindingId)||!/^[a-f0-9]{40}$/.test(revision.commit))fail('Revision requires project, source identity and immutable commit');
    const key=`${revision.projectId}:${revision.sourceBindingId}`;if(seen.has(key))fail('Revision set repeats a source binding');seen.add(key);
    return {projectId:revision.projectId,sourceBindingId:revision.sourceBindingId,commit:revision.commit};
  });
}
