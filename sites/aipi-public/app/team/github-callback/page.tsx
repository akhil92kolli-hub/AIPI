"use client";

import { useEffect, useState } from "react";
import "../dashboard/dashboard.css";

import { supabase } from "../../../lib/supabase";

export default function GithubCallbackPage() {
  const [message,setMessage] = useState("Connecting your GitHub account…");
  useEffect(()=>{
    let active=true;
    const complete=async()=>{
      const params=new URLSearchParams(location.search);
      const code=params.get("code");const state=params.get("state");const expected=sessionStorage.getItem("aipi-github-oauth-state");
      const installationId=params.get("installation_id");
      history.replaceState(null,"",location.pathname);
      // GitHub may redirect here immediately after installation when OAuth on
      // install is enabled. That request has no AIPI-issued state and must not
      // be exchanged. Preserve only the untrusted installation ID for the
      // normal user-authorized connection flow, which verifies access server-side.
      if ((!expected || state!==expected) && installationId && /^[1-9][0-9]{0,18}$/.test(installationId)) {
        sessionStorage.setItem("aipi-github-pending-installation",installationId);
        const saved=sessionStorage.getItem("aipi-github-install-return");sessionStorage.removeItem("aipi-github-install-return");
        location.replace(saved&&/^\/workspace\/[0-9a-f-]{36}\/manage\/general$/.test(saved)?saved:"/workspace/connect");
        return;
      }
      if(!code||!state||state!==expected)throw new Error("This GitHub authorization was not started from AIPI Team. Return to Team settings and choose Connect my GitHub App account.");
      sessionStorage.removeItem("aipi-github-oauth-state");
      const {data}=await supabase.auth.getSession();
      if(!data.session?.access_token)throw new Error("Your AIPI session expired. Sign in and connect GitHub again.");
      const response=await fetch("https://mcp.aipi.website/api/team/github/oauth/exchange",{method:"POST",
        headers:{authorization:`Bearer ${data.session.access_token}`,"content-type":"application/json"},
        body:JSON.stringify({code,state})});
      const result=await response.json() as {githubUser?:{id:number;login:string};githubUserToken?:string;expiresAt?:string|null;returnTo?:string;error?:string};
      if(!response.ok||!result.githubUserToken||!result.githubUser)throw new Error(result.error||"GitHub authorization failed. Return to Team settings and connect again.");
      sessionStorage.setItem("aipi-github-app-session",JSON.stringify({token:result.githubUserToken,userId:data.session.user.id,
        githubUserId:result.githubUser.id,login:result.githubUser.login,expiresAt:result.expiresAt}));
      const returnTo=result.returnTo&&(["/team","/team/dashboard","/workspace/connect"].includes(result.returnTo)||/^\/workspace\/[0-9a-f-]{36}\/manage\/general$/.test(result.returnTo))?result.returnTo:"/workspace";
      location.replace(`${returnTo}?github=connected#team-repositories`);
    };
    void complete().catch(error=>{if(active)setMessage(error instanceof Error?error.message:"GitHub authorization failed");});
    return()=>{active=false;};
  },[]);
  return <main className="team-dash-auth"><h1>GitHub connection</h1><p role="status">{message}</p><a href="/team">Team settings</a></main>;
}
