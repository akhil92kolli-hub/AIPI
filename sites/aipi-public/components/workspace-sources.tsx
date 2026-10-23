"use client";

import {useEffect,useState} from "react";

type Repository={id:string;fullName:string;installationId:number};
type Source={id:string;name:string;kind:"local"|"repository"|"external";version:number;trackingBranch?:string|null;trackingCommit?:string|null;repository:{providerRepositoryId:string;remote:string;root:string}|null};
export type IdentityProject={id:string;name:string;sources:Source[]};
type Api=<T,>(path:string,method?:string,body?:unknown,githubUserToken?:string)=>Promise<T>;
type Handoff={port:number;ticket:string;expiresAt:number};

export function WorkspaceSources({workspaceId,organizationId,projects,repositories,githubReady,api,githubToken,onConnectGithub,onRefresh,handoff}:{workspaceId:string;organizationId:string;projects:IdentityProject[];repositories:Repository[];githubReady:boolean;api:Api;githubToken:()=>string;onConnectGithub:()=>void;onRefresh:()=>Promise<void>;handoff:Handoff|null}){
 const [mode,setMode]=useState<"choose"|"local"|"github"|null>(null);
 const [target,setTarget]=useState("new");const [sourceId,setSourceId]=useState("");
 const [repositoryId,setRepositoryId]=useState("");const [branch,setBranch]=useState("");const [branches,setBranches]=useState<string[]>([]);
 const [name,setName]=useState("");const [root,setRoot]=useState(".");const [companion,setCompanion]=useState(handoff?`http://127.0.0.1:${handoff.port}`:"http://127.0.0.1:49152");
 const [busy,setBusy]=useState(false);const [loadingBranches,setLoadingBranches]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");
 const [gitStatus,setGitStatus]=useState<Record<string,string>>({});
 useEffect(()=>{try{const draft=JSON.parse(sessionStorage.getItem(`aipi-source-draft:${workspaceId}`)||"null");if(draft?.signature){const saved=JSON.parse(draft.signature);setMode("github");setTarget(saved.target);setSourceId(saved.sourceId);setRepositoryId(saved.repositoryId);setRoot(saved.root);setBranch(saved.branch);setName(saved.name);}}catch{/* A stale draft cannot authorize any write. */}},[workspaceId]);
 const selected=repositories.find(repo=>repo.id===repositoryId);
 const project=projects.find(project=>project.id===target);const existing=project?.sources.find(source=>source.id===sourceId);
 const title=(project:IdentityProject)=>project.name!==project.id?project.name:project.sources.find(source=>source.repository)?.name.split('/').at(-1)??"Local project";
 useEffect(()=>{setBranches([]);if(!repositoryId||!githubReady)return;let active=true;setLoadingBranches(true);setError("");
  void api<{defaultBranch:string;branches:Array<{name:string}>;hasMore:boolean}>(`/api/team/workspaces/${workspaceId}/repository-options`,"POST",{repositoryId,githubUserToken:githubToken()}).then(result=>{
   if(active){setBranches(result.branches.map(branch=>branch.name));setBranch(current=>current||existing?.trackingBranch||result.defaultBranch);}
  }).catch(cause=>active&&setError(cause.message)).finally(()=>active&&setLoadingBranches(false));return()=>{active=false;};
 },[api,repositoryId,workspaceId,githubReady,existing?.trackingBranch]);
 function openGithub(projectId="new",source?:Source){try{githubToken();}catch{onConnectGithub();return;}setMode("github");setTarget(projectId);setSourceId(source?.id??"");setRepositoryId(source?.repository?.providerRepositoryId??"");setRoot(source?.repository?.root??".");setBranch(source?.trackingBranch??"");setName(source?.name??"");setError("");setNotice("");}
 function chooseLocal(){try{
  const url=new URL(companion);if(url.protocol!=="http:"||!["127.0.0.1","localhost"].includes(url.hostname)||!url.port||url.username||url.password)throw new Error("Use the loopback URL printed by your running companion.");
  url.pathname="/projects";url.search=new URLSearchParams({teamImport:"1",teamWorkspace:workspaceId,teamOrganization:organizationId}).toString();url.hash="";location.assign(url.href);
 }catch(cause){setError(cause instanceof Error?cause.message:"Invalid companion URL");}}
 async function save(){if(!selected||!branch.trim())return;setBusy(true);setError("");setNotice("");try{
  // Persist operation IDs before the first write, including across a page refresh.
  const key=`aipi-source-draft:${workspaceId}`;const signature=JSON.stringify({target,sourceId,repositoryId,root:root.trim()||".",branch:branch.trim(),name:name.trim()});
  let draft:{signature:string;projectId:string;sourceId:string}|null=null;try{draft=JSON.parse(sessionStorage.getItem(key)||"null");}catch{}
  if(!draft||draft.signature!==signature){draft={signature,projectId:target==="new"?`prj_${crypto.randomUUID().replaceAll("-","").slice(0,12)}`:target,sourceId:sourceId||`src_${crypto.randomUUID().replaceAll("-","")}`};sessionStorage.setItem(key,JSON.stringify(draft));}
  if(target==="new"){
   await api(`/api/team/workspaces/${workspaceId}/projects/${draft.projectId}`,"PUT",{name:name.trim()||selected.fullName.split('/').at(-1)});
   const identity=await api<{identity:{projects:IdentityProject[]}}>(`/api/team/workspaces/${workspaceId}/identity`);
   draft.sourceId=identity.identity.projects.find(project=>project.id===draft!.projectId)!.sources[0].id;sessionStorage.setItem(key,JSON.stringify(draft));
  }
  const result=await api<{source:{source_id:string}}>(`/api/team/workspaces/${workspaceId}/projects/${draft.projectId}/sources/${draft.sourceId}`,"PUT",{
   kind:"repository",name:name.trim()||selected.fullName,trackingBranch:branch.trim(),githubUserToken:githubToken(),...(existing?{expectedVersion:existing.version}:{}),
   repository:{providerRepositoryId:selected.id,repository:selected.fullName,remoteUrl:`https://github.com/${selected.fullName}`,repositoryRoot:root.trim()||"."},
  });
  sessionStorage.removeItem(key);await onRefresh();setMode(null);setNotice(result.source.source_id!==draft.sourceId?"This repository and directory are already connected. The existing source was kept.":`${selected.fullName} connected. Tracking ${branch.trim()}.`);
 }catch(cause){setError(cause instanceof Error?cause.message:"Could not connect repository");}finally{setBusy(false);}}
 async function checkCheckout(projectId:string,source:Source){const key=`${projectId}:${source.id}`;if(!handoff||handoff.expiresAt<=Date.now()){setMode("local");setNotice("Select this project in the local companion to authorize a fresh checkout check.");return;}
  setGitStatus(current=>({...current,[key]:"Checking remote branch…"}));try{
   const query=new URLSearchParams({projectKey:projectId,sourceBindingId:source.id,branch:source.trackingBranch||""});
   const response=await fetch(`http://127.0.0.1:${handoff.port}/api/team-onboarding/git-status?${query}`,{headers:{authorization:`Bearer ${handoff.ticket}`},cache:"no-store"});
   const result=await response.json() as {error?:string;status:string;dirty:boolean;localCommit?:string;remoteCommit?:string;checkedAt:string};if(!response.ok)throw new Error(result.error||"Checkout unavailable on this device");
   const labels:Record<string,string>={up_to_date:"Local HEAD matches GitHub",ahead:"Local commits are not pushed",behind:"GitHub has newer commits; fetch and pull/rebase in your IDE",diverged:"Local and remote history diverged; review in your IDE",different:"GitHub and local HEAD differ; fetch in your IDE to compare",unknown:"Remote state could not be verified"};
   setGitStatus(current=>({...current,[key]:`${labels[result.status]??result.status}${result.dirty?" · Uncommitted changes stay local":""} · Checked ${new Date(result.checkedAt).toLocaleTimeString()}`}));
  }catch(cause){setGitStatus(current=>({...current,[key]:cause instanceof Error?cause.message:"Checkout check failed"}));}}
 return <div className="workspace-sources">
  <div className="source-heading"><div><h3>Projects</h3><p>A project can use several repositories or local folders. Connect each source once.</p></div><button type="button" onClick={()=>{setMode("choose");setError("");}}>Add project</button></div>
  {!projects.length&&<p>No projects yet. Add one from your local companion or GitHub.</p>}
  {projects.map(project=><article className="source-project" key={project.id}><div className="source-heading"><h3>{title(project)}</h3><button type="button" onClick={()=>openGithub(project.id)}>Add repository</button></div>
   {project.sources.map(source=><div className="source-card" key={source.id}><strong>{source.repository?source.repository.remote.replace("https://github.com/",""):source.name}</strong><span>{source.kind==="repository"?`GitHub · ${source.trackingBranch||"Branch not selected"}${source.repository?.root!=="."?` · ${source.repository?.root}`:""}`:source.kind==="local"?"Local folder · GitHub optional":"External endpoint"}</span>
    <div className="source-actions">{source.kind==="local"&&<button type="button" onClick={()=>openGithub(project.id,source)}>Connect to GitHub</button>}{source.kind==="repository"&&<><button type="button" onClick={()=>openGithub(project.id,source)}>Change tracking branch</button><button type="button" onClick={()=>void checkCheckout(project.id,source)}>Check local checkout</button></>}</div>
    {gitStatus[`${project.id}:${source.id}`]&&<p role="status">{gitStatus[`${project.id}:${source.id}`]}</p>}
    <details><summary>Identity details</summary><small>Project: {project.id}<br/>Source: {source.id}</small>{source.trackingCommit&&<p>Last verified GitHub commit: <code>{source.trackingCommit.slice(0,12)}</code></p>}</details>
   </div>)}
  </article>)}
  {mode&&<section className="source-wizard" aria-label="Add or connect a project"><div className="source-heading"><h3>{mode==="choose"?"Where is your project?":mode==="local"?"Select a local project":"Connect a GitHub repository"}</h3><button type="button" onClick={()=>setMode(null)}>Cancel</button></div>
   {mode==="choose"&&<div className="source-choices"><button type="button" onClick={()=>setMode("local")}><strong>From local companion or IDE</strong><span>Select an existing project and review what is shared.</span></button><button type="button" onClick={()=>openGithub()}><strong>From GitHub</strong><span>Create a project from an installed repository.</span></button></div>}
   {mode==="local"&&<form className="source-form" onSubmit={event=>{event.preventDefault();chooseLocal();}}><p>Start AIPI in your IDE or repository. Open its companion URL below, select “Use this project”, then confirm this workspace in the cloud. Local source code stays on your device.</p><label>Running companion URL<input type="url" value={companion} onChange={event=>setCompanion(event.target.value)} required/></label><button>Select a local project</button></form>}
   {mode==="github"&&(!githubReady?<p><button type="button" onClick={onConnectGithub}>Connect GitHub to continue</button></p>:!repositories.length?<p>No installed repositories are available to this account. Connect or update the AIPI GitHub App installation above, then return here.</p>:<form className="source-form" onSubmit={event=>{event.preventDefault();void save();}}>
    <label>Add to<select value={target} disabled={Boolean(sourceId)} onChange={event=>{setTarget(event.target.value);setSourceId("");}}><option value="new">New project</option>{projects.map(project=><option key={project.id} value={project.id}>{title(project)}</option>)}</select></label>
    <label>{target==="new"?"Project name":"Source name"}<input value={name} onChange={event=>setName(event.target.value)} maxLength={120} placeholder={selected?.fullName.split('/').at(-1)||"Payments API"}/></label>
    <label>GitHub repository<select value={repositoryId} disabled={Boolean(existing?.repository)} onChange={event=>{setRepositoryId(event.target.value);setBranch("");}} required><option value="">Choose a repository</option>{repositories.map(repo=><option key={repo.id} value={repo.id}>{repo.fullName}</option>)}</select></label>
    <label>Tracking branch<input list="source-branches" value={branch} onChange={event=>setBranch(event.target.value)} maxLength={240} required disabled={!repositoryId||loadingBranches} placeholder={loadingBranches?"Loading branches…":"main"}/><datalist id="source-branches">{branches.map(branch=><option key={branch} value={branch}/>)}</datalist><small>AIPI follows this branch. Checks and knowledge refer to exact commits.</small></label>
    <label>Folder inside repository<input value={root} onChange={event=>setRoot(event.target.value)} disabled={Boolean(existing?.repository)} placeholder="." required/><small>Use “.” for the whole repository, or a monorepo folder such as apps/api.</small></label>
    <p>Connecting reads repository metadata. It does not clone, commit, pull, or push your local code.</p><button disabled={busy||loadingBranches||!repositoryId||!branch.trim()}>{busy?"Connecting…":existing?.repository?"Save tracking branch":existing?"Connect primary repository":"Connect repository"}</button>
   </form>)}
  </section>}
  {error&&<p className="team-error" role="alert">{error}</p>}{notice&&<p className="team-notice" role="status">{notice}</p>}
 </div>;
}
