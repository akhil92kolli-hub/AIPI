"use client";

import { useEffect, useState } from "react";
import { SiteHeader } from "../../../components/site-shell";
import "../team.css";

type Pending = { handoff: { port: number; ticket: string; project: string }; organizationId: string;
  workspaceId: string; expectedUserId: string; projectName: string; state: string; expiresAt: number };

export default function OAuthCallbackPage() {
  const [message, setMessage] = useState("Finishing the secure connection to your IDE…");
  const [connected, setConnected] = useState(false);
  const [dashboardUrl, setDashboardUrl] = useState("/team/dashboard");
  useEffect(() => {
    let active = true;
    const finish = async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code"); const state = params.get("state");
      const denied = params.get("error");
      history.replaceState(null, "", location.pathname);
      if (denied) throw new Error("Companion authorization was cancelled. Start again from your IDE.");
      const pending = JSON.parse(localStorage.getItem("aipi-team-oauth-pending") || "null") as Pending | null;
      if (!pending || pending.expiresAt < Date.now() || !code || !state || state !== pending.state)
        throw new Error("This connection request expired. Start again from your IDE.");
      const response = await fetch(`http://127.0.0.1:${pending.handoff.port}/api/team-onboarding/oauth-complete`, {
        method: "POST", cache: "no-store", headers: { authorization: `Bearer ${pending.handoff.ticket}`, "content-type": "application/json" },
        body: JSON.stringify({ code, state, organizationId: pending.organizationId, workspaceId: pending.workspaceId,
          expectedUserId: pending.expectedUserId }),
      });
      const result = await response.json() as { imported?: number; pending?: number; conflicts?: number; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not finish companion authorization");
      localStorage.removeItem("aipi-team-oauth-pending"); localStorage.removeItem("aipi-team-handoff");
      if (active) { setDashboardUrl(`/workspace/${pending.workspaceId}/manage/general`); setConnected(true); setMessage(`${pending.projectName} is connected. ${result.imported ?? 0} tasks shared; ${result.pending ?? 0} pending, ${result.conflicts ?? 0} needing attention. Open the Team dashboard to work with shared context, or return to your IDE for local code and verification.`); }
    };
    void finish().catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "Connection failed"); });
    return () => { active = false; };
  }, []);
  return <><SiteHeader signInPath="/team" /><main className="team-page"><section className="team-card team-connect">
    <h1>{connected ? "Companion connected" : "Connect AIPI Companion"}</h1>
    <p role={connected ? "status" : "alert"}>{message}</p>
    <a className="button button-primary" href={connected ? dashboardUrl : "/team"}>{connected ? "Review workspace resources" : "Return to Team Cloud"}</a>
  </section></main></>;
}
