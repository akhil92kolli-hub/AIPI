"use client";
import {useEffect,useState} from "react";
import {useParams} from "next/navigation";
import TeamPage from "../team/page";
import TeamDashboardPage from "../team/dashboard/page";
import { supabase } from "../../lib/supabase";
type Workspace={id:string;organization_id:string;name:string};
export default function WorkspaceRoute({settings=false}:{settings?:boolean}){
  const params=useParams<{workspaceKey:string;section?:string}>();
  const [workspace,setWorkspace]=useState<Workspace|null>(null);
  const [choices,setChoices]=useState<Workspace[]>([]);
  const [error,setError]=useState("");
  useEffect(()=>{let active=true;void (async()=>{const {data}=await supabase.auth.getSession();if(!data.session)throw new Error("Sign in to open this workspace.");
    const response=await fetch(`https://mcp.aipi.website/api/team/workspace-resolve/${encodeURIComponent(params.workspaceKey)}`,{headers:{authorization:`Bearer ${data.session.access_token}`}});
    const result=await response.json() as {workspace:Workspace;workspaces?:Workspace[];error?:string};if(!response.ok){if(active)setChoices(result.workspaces||[]);throw new Error(result.error||"Workspace unavailable");}if(active){if(settings&&params.section&&params.section!=="general"){location.replace(`/workspace/${result.workspace.id}/manage/general`);return;}setWorkspace(result.workspace);}
  })().catch(cause=>active&&setError(cause.message));return()=>{active=false;};},[params.workspaceKey,params.section,settings]);
  if(!workspace)return <main className="team-main page-width"><h1>AIPI workspace</h1><p role="status">{error||"Opening workspace…"}</p>{choices.map(choice=><p key={choice.id}><a href={`/workspace/${choice.id}${settings?"/manage/general":""}`}>{choice.name}</a></p>)}<a href="/workspace">Sign in or choose a workspace</a></main>;
  return settings?<TeamPage requestedWorkspaceId={workspace.id} requestedOrganizationId={workspace.organization_id} section={params.section||"general"}/>:<TeamDashboardPage requestedWorkspaceId={workspace.id} requestedOrganizationId={workspace.organization_id}/>;
}
