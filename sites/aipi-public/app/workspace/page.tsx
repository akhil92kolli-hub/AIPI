"use client";

import {useEffect,useState} from "react";
import type { Session } from "@supabase/supabase-js";
import {SiteHeader,SiteFooter} from "../../components/site-shell";
import TeamPage from "../team/page";
import "../team/team.css";

import { supabase } from "../../lib/supabase";
type Organization={id:string;name:string};
type Workspace={id:string;name:string;organization_id:string};
export default function WorkspaceLauncher(){
  const [session,setSession]=useState<Session|null>(null);
  const [ready,setReady]=useState(false);
  const [organizations,setOrganizations]=useState<Organization[]>([]);
  const [workspaces,setWorkspaces]=useState<Workspace[]>([]);
  const [organization,setOrganization]=useState("");
  const [name,setName]=useState("");
  const [teamName,setTeamName]=useState("");
  const [creating,setCreating]=useState(false);
  const [loading,setLoading]=useState(true);
  const [companion,setCompanion]=useState("http://127.0.0.1:49152");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{const hash=new URLSearchParams(location.hash.slice(1));const query=new URLSearchParams(location.search);if(hash.has("ticket")||query.has("installation_id")||query.has("github")){const saved=sessionStorage.getItem("aipi-github-install-return");const destination=query.has("installation_id")&&saved&&/^\/workspace\/[0-9a-f-]{36}\/manage\/general$/.test(saved)?saved:"/workspace/connect";if(query.has("installation_id"))sessionStorage.removeItem("aipi-github-install-return");location.replace(`${destination}${location.search}${location.hash}`);}},[]);
  useEffect(()=>{void supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true);});
    const {data}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next));return()=>data.subscription.unsubscribe();},[]);
  async function api<T>(path:string,body?:unknown):Promise<T>{
    const {data}=await supabase.auth.getSession();
    if(!data.session)throw new Error("Sign in first");
    const response=await fetch(`https://mcp.aipi.website${path}`,{method:body?"POST":"GET",headers:{authorization:`Bearer ${data.session.access_token}`,...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json() as T & {error?:string};if(!response.ok)throw new Error(result.error||"Workspace request failed");return result;
  }
  useEffect(()=>{if(!session)return;let active=true;void (async()=>{
    const result=await api<{organizations:Organization[]}>("/api/team/organizations");
    const all=await Promise.all(result.organizations.map(async org=>(await api<{workspaces:Workspace[]}>(`/api/team/organizations/${org.id}/workspaces`)).workspaces.map(workspace=>({...workspace,organization_id:org.id}))));
    if(active){setOrganizations(result.organizations);setOrganization(result.organizations[0]?.id||"");setWorkspaces(all.flat());setLoading(false);}
  })().catch(cause=>active&&(setError(cause.message),setLoading(false)));return()=>{active=false;};},[session?.user.id]);
  async function createWorkspace(){setBusy(true);setError("");try{
    let org=organization;
    if(!org){const result=await api<{organization:Organization}>("/api/team/organizations",{name:teamName.trim()});org=result.organization.id;}
    const result=await api<{workspace:Workspace}>(`/api/team/organizations/${org}/workspaces`,{name:name.trim()});
    location.assign(`/workspace/${result.workspace.id}/manage/general`);
  }catch(cause){setError(cause instanceof Error?cause.message:"Could not create workspace");}finally{setBusy(false);}}
  function chooseLocal(){try{const url=new URL(companion);if(url.protocol!=="http:"||!["127.0.0.1","localhost"].includes(url.hostname)||!url.port||url.username||url.password)throw new Error("Enter the loopback URL printed by your running companion.");url.pathname="/projects";url.search="?teamImport=1";url.hash="";location.assign(url.href);}catch(cause){setError(cause instanceof Error?cause.message:"Invalid companion URL");}}
  if(!ready)return <main className="team-main page-width">Checking your AIPI session…</main>;
  // Pairing links retain the existing, ticket-protected review and OAuth flow.
  if(!session)return <TeamPage />;
  return <div className="docs-layout"><SiteHeader signInPath="/workspace"/><main className="team-main page-width">
    <div className="team-heading"><span className="section-index">AIPI WORKSPACES</span><h1>Your workspaces</h1><p>A workspace groups projects, repositories, tasks, contracts and knowledge. Choose one to continue.</p></div>
    <div className="team-toolbar"><span>{session.user.email}</span><div className="team-toolbar-actions"><button onClick={()=>setCreating(!creating)}>Create workspace</button><a href="/workspace/connect">Account and invitations</a><button onClick={()=>void supabase.auth.signOut()}>Sign out</button></div></div>
    {loading&&<p role="status">Loading your workspaces…</p>}
    <div className="workspace-launcher-grid">{workspaces.map(workspace=><article className="team-card" key={workspace.id}><small>{organizations.find(org=>org.id===workspace.organization_id)?.name}</small><h2>{workspace.name}</h2><p>Team workspace</p><div className="team-toolbar-actions"><a className="button button-primary" href={`/workspace/${workspace.id}`}>Open workspace</a><a href={`/workspace/${workspace.id}/manage/general`}>Resources and settings</a></div></article>)}</div>
    {!loading&&!workspaces.length&&<p>No shared workspaces yet. Create one or select a project from your local companion.</p>}
    {(creating||(!loading&&!workspaces.length))&&<section className="team-card team-connect"><h2>Create a workspace</h2><form onSubmit={event=>{event.preventDefault();void createWorkspace();}}>
      {organizations.length?<label>Account<select value={organization} onChange={event=>setOrganization(event.target.value)}>{organizations.map(org=><option value={org.id} key={org.id}>{org.name}</option>)}</select></label>:<label>Team name<input value={teamName} onChange={event=>setTeamName(event.target.value)} maxLength={120} required/></label>}
      <label>Workspace name<input value={name} onChange={event=>setName(event.target.value)} maxLength={120} required/></label><button disabled={busy}>Create empty workspace</button></form>
      <h3>Start with a local project</h3><p>Use the URL printed by <code>npx @vmise/aipi-companion@latest init</code>. Select a project on that device, then review the secure cloud connection. Your other local projects are not disclosed to this website.</p>
      <form onSubmit={event=>{event.preventDefault();chooseLocal();}}><label>Running companion URL<input type="url" value={companion} onChange={event=>setCompanion(event.target.value)} required/></label><button>Select a local project</button></form>
      <p>In the IDE, open your project and use Settings → General → Connect this project to Team.</p></section>}
    {error&&<p className="team-error" role="alert">{error}</p>}
  </main><SiteFooter/></div>;
}
