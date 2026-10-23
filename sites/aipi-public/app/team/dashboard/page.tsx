"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { workspaceViewMarkup, WORKSPACE_TABS, bindLightDismissDialog } from "../../../lib/workspace-app.js";
import { TeamWorkspaceProvider, normalizeWorkspaceModel, applyWorkspaceProjectFilter } from "../../../lib/workspace-provider.mjs";
import "./dashboard.css";

import { supabase } from "../../../lib/supabase";
const apiRoot = "https://mcp.aipi.website";
type Organization = {id:string; name:string};
type Workspace = {id:string; name:string};
type Project = {project_key:string; display_name?:string|null; repository:string|null; remote_url?:string|null;sources?:Array<{id:string;name:string;kind:string;repository:{remote:string;root:string}|null}>};
type Task = {id:string; project_key:string|null; external_id:string; title:string; description:string; status:string; version:number; scope:Array<{projectKey:string}>; revision_set:Array<{projectKey:string;commit:string}>};
type PullRequest = {id:string;task_id:string|null;repository:string;number:number;title:string;head_sha:string;state:string};
type GraphNode = {id:string;project_key:string;node_key:string;kind:string;label:string;source_ref:string|null;revision_commit:string};
type GraphEdge = {id:string;from_node_id:string;to_node_id:string;relation:string;evidence_kind:string;confirmation_state:string};
type Subscription = {plan:string;status:string;monthly_event_limit:number;trial_ends_at:string|null};
type SourceResult = {status:"available"|"unavailable";content?:string;path?:string;commit?:string;reason?:string};
type Assessment = {status:string;comparison:{baseSha:string;headSha:string};changedNodes:Array<{projectKey:string;nodeKey:string;label:string;path:string;evidenceStrength:string}>;requiredChecks:string[];coverage:{unmappedFiles:Array<{path:string;reason:string}>;uninspectableFiles:string[];renamedFiles:string[];deletedFiles:string[];generatedFiles:string[];meaning:string;restrictedScope?:boolean};impacts:Array<{report:{affected:Array<{projectKey:string;status:string;requiredChecks:string[]}>}}>;
  ledger:{status:string;counts:Record<string,number>;limitations:string[];components:Array<{projectId:string;componentId:string;status:string;checks:Array<{requirementId:string|null;status:string;reason:string;required:boolean}>;reasons:string[]}>};
  ownerCoverage:Array<{projectId:string;componentId:string;status:"identified"|"missing";ownerId:string|null}>;
  semanticComparisons:Array<{path:string;status:string;reason:string;changes:Array<{location:string;kind:string;effect:string}>}>};
type Context = {task:{id:string;title:string;description:string;status:string;version:number;revisionSet:Array<{projectKey:string;commit:string}>};decisions:Array<{id:string;body:string}>;evidence:Array<{id:string;kind:string;producer:string;freshness:string}>;receipts:Array<{id:string;summary:string;result:string;freshness:string}>;comments:Array<{id:string;body:string}>};

export default function TeamDashboardPage({requestedWorkspaceId="",requestedOrganizationId=""}:{requestedWorkspaceId?:string;requestedOrganizationId?:string} = {}) {
  const [session,setSession] = useState<Session|null>(null);
  const [authReady,setAuthReady] = useState(false);
  const [organizations,setOrganizations] = useState<Organization[]>([]);
  const [organizationId,setOrganizationId] = useState("");
  const [workspaces,setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId,setWorkspaceId] = useState("");
  const [projects,setProjects] = useState<Project[]>([]);
  const [tasks,setTasks] = useState<Task[]>([]);
  const [pullRequests,setPullRequests] = useState<PullRequest[]>([]);
  const [graphNodes,setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges,setGraphEdges] = useState<GraphEdge[]>([]);
  const [subscription,setSubscription] = useState<Subscription|null>(null);
  const [sourceProject,setSourceProject] = useState("");
  const [sourceCommit,setSourceCommit] = useState("");
  const [sourceBindingId,setSourceBindingId]=useState("");
  const [sourcePath,setSourcePath] = useState("");
  const [sourceResult,setSourceResult] = useState<SourceResult|null>(null);
  const [assessment,setAssessment] = useState<{prId:string;headSha:string;value:Assessment}|null>(null);
  const [tab,setTab] = useState("home");
  const [projectFilter,setProjectFilter] = useState("");
  const [taskId,setTaskId] = useState("");
  const [context,setContext] = useState<Context|null>(null);
  const [nextStatus,setNextStatus] = useState("");
  const [newTaskTitle,setNewTaskTitle] = useState("");
  const [newTaskProjectId,setNewTaskProjectId] = useState("");
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [updatedAt,setUpdatedAt] = useState<Date|null>(null);
  const [releaseCompatibility,setReleaseCompatibility] = useState<{workspaceId:string;projectId:string;value:unknown}|null>(null);
  const activeScope=useRef("");
  const activeTask=useRef("");
  useEffect(()=>{
    activeScope.current=`${session?.user.id??""}:${organizationId}:${workspaceId}`;
    activeTask.current=taskId;
  },[session?.user.id,organizationId,workspaceId,taskId]);
  const api = useCallback(async <T,>(path:string,method="GET",body?:unknown,githubUserToken?:string):Promise<T> => {
    const {data} = await supabase.auth.getSession();
    if (!data.session?.access_token) throw new Error("Sign in to Team Cloud first");
    const response = await fetch(`${apiRoot}${path}`,{method,headers:{authorization:`Bearer ${data.session.access_token}`,
      ...(githubUserToken?{"x-aipi-github-user-token":githubUserToken}:{}),
      ...(body === undefined ? {} : {"content-type":"application/json"})},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const result = await response.json() as T & {error?:string};
    if (!response.ok) throw new Error(result.error || `Team API returned ${response.status}`);
    return result;
  },[]);
  useEffect(() => {
    let active=true;
    void supabase.auth.getSession().then(({data})=>{if(active){setSession(data.session);setAuthReady(true);}});
    const {data} = supabase.auth.onAuthStateChange((_event,next)=>{if(active)setSession(next);});
    return()=>{active=false;data.subscription.unsubscribe();};
  },[]);
  useEffect(()=>{
    if(!session)return;
    let active=true;
    void api<{organizations:Organization[]}>("/api/team/organizations").then(result=>{
      if(!active)return;
      setOrganizations(result.organizations);
      const requested=requestedOrganizationId||new URLSearchParams(location.search).get("organization");
      const saved=localStorage.getItem("aipi-team-organization");
      setOrganizationId([requested,saved,result.organizations[0]?.id].find(id=>result.organizations.some(entry=>entry.id===id))||"");
    }).catch(cause=>{if(active)setError(cause.message);});
    return()=>{active=false;};
  },[api,session,requestedOrganizationId]);
  useEffect(()=>{
    if(!organizationId){setWorkspaces([]);setWorkspaceId("");return;}
    let active=true;
    void api<{workspaces:Workspace[]}>(`/api/team/organizations/${organizationId}/workspaces`).then(result=>{
      if(!active)return;
      setWorkspaces(result.workspaces);
      const requested=requestedWorkspaceId||new URLSearchParams(location.search).get("workspace");
      const saved=localStorage.getItem(`aipi-team-workspace:${organizationId}`);
      setWorkspaceId([requested,saved,result.workspaces[0]?.id].find(id=>result.workspaces.some(entry=>entry.id===id))||"");
    }).catch(cause=>{if(active)setError(cause.message);});
    return()=>{active=false;};
  },[api,organizationId,requestedWorkspaceId]);
  const refresh = useCallback(async(id:string)=>{
    const requestedScope=activeScope.current;
    let githubUserToken:string|undefined;
    try { const saved=JSON.parse(sessionStorage.getItem("aipi-github-app-session")||"null") as {token?:string;userId?:string;expiresAt?:string|null}|null;
      if(saved?.token&&saved.userId===session?.user.id&&(!saved.expiresAt||Date.parse(saved.expiresAt)>Date.now())) githubUserToken=saved.token;
    } catch { /* A missing GitHub session leaves bound graph data inaccessible. */ }
    const [taskResult,projectResult,prResult,graphResult,subscriptionResult,identityResult]=await Promise.all([
      api<{tasks:Task[]}>(`/api/team/workspaces/${id}/tasks`),
      api<{projects:Project[]}>(`/api/team/workspaces/${id}/projects`),
      api<{pullRequests:PullRequest[]}>(`/api/team/workspaces/${id}/pull-requests`).catch(()=>({pullRequests:[]})),
      api<{nodes:GraphNode[];edges:GraphEdge[];capabilityError?:string}>(`/api/team/workspaces/${id}/graph`,"GET",undefined,githubUserToken).catch(cause=>({nodes:[],edges:[],capabilityError:cause.message as string})),
      api<{subscription:Subscription}>(`/api/team/workspaces/${id}/subscription`),
      api<{identity:{projects:Array<{id:string;name:string;sources:Project["sources"]}>}}>(`/api/team/workspaces/${id}/identity`),
    ]);
    if(activeScope.current!==requestedScope)return;
    if(graphResult.capabilityError)setError(graphResult.capabilityError);
    setTasks(taskResult.tasks);setProjects(projectResult.projects.map(project=>({...project,sources:identityResult.identity.projects.find(item=>item.id===project.project_key)?.sources})));setPullRequests(prResult.pullRequests);setAssessment(current=>current&&prResult.pullRequests.find(pr=>pr.id===current.prId)?.head_sha===current.headSha?current:null);setGraphNodes(graphResult.nodes);setGraphEdges(graphResult.edges);setSubscription(subscriptionResult.subscription);setUpdatedAt(new Date());
  },[api,session?.user.id]);
  useEffect(()=>{
    if(!workspaceId){setTasks([]);setProjects([]);setGraphNodes([]);setGraphEdges([]);setSubscription(null);setAssessment(null);setTaskId("");return;}
    localStorage.setItem(`aipi-team-workspace:${organizationId}`,workspaceId);
    setProjectFilter("");setTaskId("");setContext(null);setAssessment(null);
    void refresh(workspaceId).catch(cause=>setError(cause.message));
    const timer=setInterval(()=>{if(document.visibilityState==="visible")void refresh(workspaceId).catch(cause=>setError(cause.message));},30000);
    return()=>clearInterval(timer);
  },[organizationId,workspaceId,refresh]);
  useEffect(()=>{
    if(!taskId||!organizationId){setContext(null);return;}
    let active=true;
    const provider=new TeamWorkspaceProvider({sessionGetter:()=>supabase.auth.getSession().then(({data})=>data.session)});
    void provider.getTaskContext(workspaceId,taskId,{organizationId,limit:25}).then((result:Context)=>{if(active){setContext(result);setNextStatus(result.task.status);}}).catch((cause:Error)=>{if(active)setError(cause.message);});
    return()=>{active=false;};
  },[organizationId,workspaceId,taskId]);
  useEffect(()=>{
    if(!workspaceId||tab!=="kmaps"){setReleaseCompatibility(null);return;}
    let active=true;
    const provider=new TeamWorkspaceProvider({sessionGetter:()=>supabase.auth.getSession().then(({data})=>data.session)});
    void provider.getReleaseCompatibility(workspaceId,{projectId:projectFilter}).then(value=>{if(active)setReleaseCompatibility({workspaceId,projectId:projectFilter,value});});
    return()=>{active=false;};
  },[workspaceId,projectFilter,tab]);
  const selectedWorkspace=workspaces.find(entry=>entry.id===workspaceId);
  const model=useMemo(()=>{
    const raw={workspace:{id:workspaceId,name:selectedWorkspace?.name||"Choose a workspace",mode:"team"},
      projects:projects.map(project=>({id:project.project_key,name:project.display_name||project.repository||project.project_key,kind:project.repository?"GitHub repository":"Local source",detail:project.remote_url||"Source requires a shared snapshot or online companion"})),
      tasks:tasks.map(task=>{const projectIds=[...new Set([task.project_key,...(task.scope||[]).map(item=>item.projectKey)].filter((id):id is string=>Boolean(id)))];return {id:task.id,externalId:task.external_id,title:task.title,description:task.description,status:task.status,projectId:task.project_key||"",projectIds,scope:task.scope,revisionSet:task.revision_set,projectName:projectIds.length>1?`${projectIds.length} projects`:projects.find(project=>project.project_key===projectIds[0])?.repository||selectedWorkspace?.name||"Team"};}),
      contracts:graphNodes.filter(node=>node.kind==="contract"||node.kind==="route").map(node=>({id:node.id,projectId:node.project_key,projectName:projects.find(project=>project.project_key===node.project_key)?.repository||node.project_key,title:node.label,evidence:`Graph node · ${node.revision_commit.slice(0,12)} · ${graphEdges.filter(edge=>edge.from_node_id===node.id||edge.to_node_id===node.id).length} dependencies`})),
      targets:graphNodes.map(node=>({id:node.id,projectId:node.project_key,projectName:projects.find(project=>project.project_key===node.project_key)?.repository||node.project_key,label:node.label,kind:node.kind,source:node.source_ref||`Commit ${node.revision_commit.slice(0,12)}`})),
      capabilities:{knowledge:"No readable graph knowledge is available. Connect your GitHub App user account or publish an accessible graph.",contracts:"No readable contract or route nodes are available for this workspace.",verify:"Cloud runner is unavailable. Verify from an authorized local companion.",source:"Inspect GitHub source at a pinned commit after connecting your GitHub App user account.",agents:"Task handoff is available in the IDE; cloud agent runs are pending.",settings:"Manage workspace resources and access in Team settings."}};
    return applyWorkspaceProjectFilter(normalizeWorkspaceModel(raw), projectFilter);
  },[workspaceId,selectedWorkspace,projects,tasks,graphNodes,graphEdges,projectFilter]);
  const currentTask=tasks.find(task=>task.id===taskId);
  const selectedPRs=pullRequests.filter(pr=>pr.task_id===taskId);
  const deviceId=async()=>{
    if(!session)throw new Error("Sign in first");
    const key=`aipi-team-device:${organizationId}:${session.user.id}`;
    const saved=localStorage.getItem(key);if(saved)return saved;
    const result=await api<{device:{id:string}}>(`/api/team/organizations/${organizationId}/devices`,"POST",{label:`Website ${crypto.randomUUID().slice(0,8)}`});
    localStorage.setItem(key,result.device.id);return result.device.id;
  };
  const teamProvider=()=>new TeamWorkspaceProvider({
    sessionGetter:()=>supabase.auth.getSession().then(({data})=>data.session),
    deviceIdGetter:deviceId,
  });
  const updateStatus=async(status:string)=>{
    if(!currentTask||!context||status===currentTask.status)return;
    setBusy(true);setError("");
    try{
      const provider=teamProvider();
      const requestedScope=activeScope.current;
      await provider.mutateTask(workspaceId,{organizationId,externalId:currentTask.external_id,patch:{status},baseVersion:currentTask.version,operationId:crypto.randomUUID()});
      if(activeScope.current!==requestedScope)return;
      await refresh(workspaceId);
      const nextContext=await provider.getTaskContext(workspaceId,taskId,{organizationId,limit:25});
      if(activeScope.current===requestedScope&&activeTask.current===taskId)setContext(nextContext);
    }catch(cause){setNextStatus(currentTask.status);setError(cause instanceof Error?cause.message:"Status update failed");}finally{setBusy(false);}
  };
  const createTask=async()=>{
    if(!workspaceId||!newTaskTitle.trim())return;
    setBusy(true);setError("");
    try{
      const requestedScope=activeScope.current;
      await teamProvider().mutateTask(workspaceId,{organizationId,externalId:`task_${crypto.randomUUID().replaceAll("-","")}`,projectKey:newTaskProjectId||projectFilter||undefined,patch:{title:newTaskTitle.trim(),status:"open"},baseVersion:0,operationId:crypto.randomUUID()});
      if(activeScope.current!==requestedScope)return;
      setNewTaskTitle("");await refresh(workspaceId);
    }catch(cause){setError(cause instanceof Error?cause.message:"Task creation failed");}finally{setBusy(false);}
  };
  const addComment=async(body:string)=>{
    if(!context||!body.trim())return;
    setBusy(true);setError("");
    try{
      const provider=teamProvider();
      const requestedScope=activeScope.current;
      await provider.appendTaskPayload(workspaceId,{organizationId,entityType:"comment",taskId:context.task.id,payload:{body:body.trim()},operationId:crypto.randomUUID()});
      if(activeScope.current!==requestedScope)return;
      const nextContext=await provider.getTaskContext(workspaceId,taskId,{organizationId,limit:25});
      if(activeScope.current===requestedScope&&activeTask.current===taskId)setContext(nextContext);
    }catch(cause){setError(cause instanceof Error?cause.message:"Comment failed");}finally{setBusy(false);}
  };
  const inspectSource=async()=>{
    const selectedSourceProject=sourceProject||projectFilter;
    if(!workspaceId||!selectedSourceProject||!sourcePath||!sourceCommit)return;
    setBusy(true);setError("");setSourceResult(null);
    try{
      const saved=JSON.parse(sessionStorage.getItem("aipi-github-app-session")||"null") as {token?:string;userId?:string;expiresAt?:string|null}|null;
      if(!saved?.token||saved.userId!==session?.user.id||(saved.expiresAt&&Date.parse(saved.expiresAt)<=Date.now()))
        throw new Error("Connect your GitHub App user account in Team settings to inspect source");
      const result=await api<SourceResult>(`/api/team/workspaces/${workspaceId}/projects/${encodeURIComponent(selectedSourceProject)}/source`,"POST",
        {githubUserToken:saved.token,commit:sourceCommit,path:sourcePath,...(sourceBindingId?{sourceBindingId}: {})});
      setSourceResult(result);
    }catch(cause){setError(cause instanceof Error?cause.message:"Source inspection failed");}finally{setBusy(false);}
  };
  const assessPr=async(prId:string)=>{
    setBusy(true);setError("");setAssessment(null);
    try{
      const saved=JSON.parse(sessionStorage.getItem("aipi-github-app-session")||"null") as {token?:string;userId?:string;expiresAt?:string|null}|null;
      if(!saved?.token||saved.userId!==session?.user.id||(saved.expiresAt&&Date.parse(saved.expiresAt)<=Date.now()))
        throw new Error("Connect your GitHub App user account in Team settings to assess this PR");
      const result=await api<{assessment:Assessment}>(`/api/team/pull-requests/${prId}/assess`,"POST",{githubUserToken:saved.token});
      setAssessment({prId,headSha:pullRequests.find(pr=>pr.id===prId)?.head_sha??result.assessment.comparison.headSha,value:result.assessment});
    }catch(cause){setError(cause instanceof Error?cause.message:"Change assessment failed");}finally{setBusy(false);}
  };
  const workspaceClick=(event:React.MouseEvent<HTMLDivElement>)=>{
    const target=event.target as HTMLElement;
    const tabButton=target.closest<HTMLElement>("[data-workspace-tab]");if(tabButton){setTab(tabButton.dataset.workspaceTab||"home");setTaskId("");return;}
    if(target.closest("[data-close-workspace-task]")){setTaskId("");setContext(null);return;}
    const taskButton=target.closest<HTMLElement>("[data-open-workspace-task]");if(taskButton){setTaskId(taskButton.dataset.openWorkspaceTask?.split(":")[1]||"");setContext(null);return;}
    if(target.closest("[data-task-handoff]")||target.closest("[data-prepare-context]")){setError("Open this task in a connected companion or IDE to prepare an agent handoff.");return;}
    if(target.closest("[data-open-publication-review]")){
      const dialog=event.currentTarget.querySelector<HTMLDialogElement>("[data-publication-review-dialog]");
      if(dialog){bindLightDismissDialog(dialog);dialog.showModal();}else{setTab("explore");}
      return;
    }
    if(target.closest('[data-publication-action="share"]')){
      const dialog=target.closest("dialog");
      dialog?.close();
      return;
    }
    const projectButton=target.closest<HTMLElement>("[data-open-workspace-project]");if(projectButton){setProjectFilter(projectButton.dataset.openWorkspaceProject||"");setTab("explore");}
  };
  const assessedPR=pullRequests.find(pr=>pr.id===assessment?.prId);
  const candidateOverview=assessment?{
    kind:"candidate",changeId:assessment.prId,subject:assessedPR?`${assessedPR.repository} PR #${assessedPR.number}`:`PR ${assessment.prId}`,
    comparison:{baseCommit:assessment.value.comparison.baseSha,headCommit:assessment.value.comparison.headSha},
    verification:{...assessment.value.ledger,status:"unknown",limitations:[...assessment.value.ledger.limitations,assessment.value.coverage.meaning,
      ...(assessment.value.coverage.unmappedFiles.length?[`${assessment.value.coverage.unmappedFiles.length} changed files have no graph mapping.`]:[]),
      ...(assessment.value.coverage.uninspectableFiles.length?[`${assessment.value.coverage.uninspectableFiles.length} files have no inspectable text patch.`]:[]),
      ...(assessment.value.coverage.renamedFiles?.length?[`${assessment.value.coverage.renamedFiles.length} renamed paths need revision-specific remapping.`]:[]),
      ...(assessment.value.coverage.deletedFiles?.length?[`${assessment.value.coverage.deletedFiles.length} deleted paths need consumer revalidation.`]:[]),
      ...(assessment.value.coverage.generatedFiles?.length?[`${assessment.value.coverage.generatedFiles.length} generated paths need source-of-truth review.`]:[])]},
    semanticComparisons:assessment.value.semanticComparisons,
    components:assessment.value.ledger.components.map(component=>{
      const changed=assessment.value.changedNodes.find(node=>node.projectKey===component.projectId&&node.nodeKey===component.componentId);
      const owner=assessment.value.ownerCoverage.find(entry=>entry.projectId===component.projectId&&entry.componentId===component.componentId);
      return {projectId:component.projectId,label:changed?.label||component.componentId,source:changed?{path:changed.path}:undefined,
        coverage:{status:component.status,checks:component.checks,reasons:[...component.reasons,
          ...(changed?[`Candidate source match: ${changed.evidenceStrength}`]:[]),
          owner?.status==="missing"?"No owner identified for this candidate component.":"Owner identified in the current graph."]}};
    }),candidateChecks:assessment.value.requiredChecks,
  }:null;
  if(!authReady)return <main className="team-dash-auth">Checking your AIPI session…</main>;
  if(!session)return <main className="team-dash-auth"><h1>Sign in to AIPI Team</h1><p>Your workspace is protected by your team account.</p><a href={workspaceId ? `/workspace/${workspaceId}/manage/general` : "/workspace"}>Sign in</a></main>;
  return <div className="team-dash shared-team-app">
    <header className="team-dash-top"><a href="/workspace" className="team-dash-brand"><span className="team-dash-mark">A</span><strong>AIPI</strong><span>WORKSPACES</span></a><div className="team-dash-topright"><span>{session.user.email}</span><a href={workspaceId ? `/workspace/${workspaceId}/manage/general` : "/workspace"}>Workspace settings</a></div></header>
    <div className="team-dash-body"><aside className="team-dash-sidebar"><h2>Workspaces</h2><label>Account<select value={organizationId} onChange={event=>{setAssessment(null);setOrganizationId(event.target.value);localStorage.setItem("aipi-team-organization",event.target.value);}}><option value="">Choose account</option>{organizations.map(entry=><option value={entry.id} key={entry.id}>{entry.name}</option>)}</select></label><label>Workspace<select value={workspaceId} onChange={event=>{setAssessment(null);setWorkspaceId(event.target.value); if(event.target.value)location.assign(`/workspace/${event.target.value}`);}}><option value="">Choose workspace</option>{workspaces.map(entry=><option value={entry.id} key={entry.id}>{entry.name}</option>)}</select></label><p>{projects.length} projects · {tasks.length} tasks</p><button onClick={()=>workspaceId&&void refresh(workspaceId).catch(cause=>setError(cause.message))} disabled={!workspaceId}>Refresh workspace</button><a href={workspaceId ? `/workspace/${workspaceId}/manage/general` : "/workspace"}>Manage projects and access</a></aside>
      <main className="team-dash-content"><div className="team-dash-content-head"><span>Team workspace {subscription?`· ${subscription.plan} · ${subscription.status.replaceAll("_"," ")}`:""} {updatedAt?`· Updated ${updatedAt.toLocaleTimeString()}`:""}</span>{subscription?.plan==="trial"&&subscription.trial_ends_at&&<span className="team-dash-trial"><time dateTime={subscription.trial_ends_at}>{new Date(subscription.trial_ends_at).getTime()<=Date.now()?"Trial ended":"Trial ends"} {new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"}).format(new Date(subscription.trial_ends_at))} UTC</time></span>}</div>{error&&<p className="team-dash-error" role="alert">{error}</p>}
        <div onClick={workspaceClick}
          onChange={event=>{
            const target=event.target as unknown as HTMLSelectElement;
            if(target.matches("[data-workspace-project-filter]")){setProjectFilter(target.value);setTaskId("");setContext(null);}
            if(target.matches("[data-task-status-select]")){setNextStatus(target.value);void updateStatus(target.value);}
          }}
          onSubmit={event=>{
            const form=(event.target as HTMLElement).closest<HTMLFormElement>("[data-task-comment-form]");
            if(!form)return;
            event.preventDefault();
            const body=new FormData(form).get("comment");
            if(typeof body==="string")void addComment(body);
          }}
          dangerouslySetInnerHTML={{__html:workspaceViewMarkup({...model,assessment:candidateOverview,assessmentEntryTab:"tasks",releaseCompatibility:releaseCompatibility?.workspaceId===workspaceId&&releaseCompatibility?.projectId===projectFilter?releaseCompatibility.value:null},tab,projectFilter,{
            selectedTaskId:tab==="tasks"&&context?.task.id===taskId?taskId:"",
            taskContext:context?.task.id===taskId?context:undefined,
            canEdit:!busy,
            isBusy:busy,
            canPrepareHandoff:false,
            selectedStatus:nextStatus,
          })}} />
        {tab==="tasks"&&taskId&&!context&&<p className="team-dash-panel" role="status">Loading task details…</p>}
        {(tab==="explore"||tab==="kmaps")&&workspaceId&&<section className="team-dash-panel shared-team-source"><h2>Inspect GitHub source</h2><p>Read a file at an immutable commit using your current GitHub App permissions. Local-only folders need an approved snapshot or an online companion.</p><form onSubmit={event=>{event.preventDefault();void inspectSource();}}><label>Project<select value={sourceProject||projectFilter} onChange={event=>{setSourceProject(event.target.value);setSourceBindingId("");setSourceResult(null);}} required><option value="">Choose repository</option>{projects.filter(project=>project.repository||project.sources?.some(source=>source.kind==="repository")).map(project=><option key={project.project_key} value={project.project_key}>{project.repository}</option>)}</select></label><label>Source binding<select value={sourceBindingId} onChange={event=>{setSourceBindingId(event.target.value);setSourceResult(null);}}><option value="">Use the only repository source</option>{(projects.find(project=>project.project_key===(sourceProject||projectFilter))?.sources??[]).filter(source=>source.kind==="repository").map(source=><option key={source.id} value={source.id}>{source.name} · {source.repository?.root}</option>)}</select></label><label>Commit SHA<input value={sourceCommit} onChange={event=>setSourceCommit(event.target.value)} pattern="[0-9a-f]{40}" maxLength={40} required placeholder="40-character commit SHA" /></label><label>Source-relative file<input value={sourcePath} onChange={event=>setSourcePath(event.target.value)} maxLength={500} required placeholder="src/api.py" /></label><button disabled={busy||!sourcePath||!sourceCommit||!(sourceProject||projectFilter)}>Open source</button></form>{sourceResult?.status==="available"?<div className="shared-team-source-result"><div>{sourceResult.path} · {sourceResult.commit?.slice(0,12)}</div><pre><code>{sourceResult.content}</code></pre></div>:sourceResult&&<p role="status">{sourceResult.reason}</p>}</section>}
        {tab==="tasks"&&workspaceId&&<form className="shared-team-create" onSubmit={event=>{event.preventDefault();void createTask();}}><label>New shared task<input value={newTaskTitle} onChange={event=>setNewTaskTitle(event.target.value)} maxLength={500} required placeholder="Task title" /></label><label>Project<select value={newTaskProjectId||projectFilter} onChange={event=>setNewTaskProjectId(event.target.value)}><option value="">Workspace wide</option>{projects.map(project=><option key={project.project_key} value={project.project_key}>{project.repository||project.project_key}</option>)}</select></label><button disabled={busy||!newTaskTitle.trim()}>Create task</button></form>}
        {tab==="tasks"&&taskId&&context&&<section className="team-dash-panel shared-team-detail"><h3>Linked pull requests</h3>{selectedPRs.map(pr=><p key={pr.id}><a href={`https://github.com/${pr.repository}/pull/${pr.number}`} target="_blank" rel="noopener noreferrer">#{pr.number} {pr.title}</a> · {pr.head_sha.slice(0,8)} <button onClick={()=>void assessPr(pr.id)} disabled={busy}>Assess changes</button></p>)}{!selectedPRs.length&&<p>No PR linked.</p>}</section>}
      </main></div><nav className="team-dash-mobile-nav" aria-label="Primary">{WORKSPACE_TABS.map(([key,label]:[string,string])=><button key={key} onClick={()=>{setTab(key);setTaskId("");}} aria-current={tab===key?"page":undefined}>{label}</button>)}</nav>
  </div>;
}
