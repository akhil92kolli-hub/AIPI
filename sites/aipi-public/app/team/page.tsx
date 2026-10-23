"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { ArrowRight, CircleCheck, Cloud, MessageSquare, RefreshCw, ShieldCheck } from "lucide-react";
import { SiteFooter, SiteHeader } from "../../components/site-shell";
import "./team.css";
import {WorkspaceSources,type IdentityProject} from "../../components/workspace-sources";

import { supabase } from "../../lib/supabase";
const apiRoot = "https://mcp.aipi.website";
const companionOAuthClientId = "7c9f7da9-5da6-4822-aac2-c387b2b01b2e";

type Organization = { id: string; name: string };
type Workspace = { id: string; name: string; description?: string | null };
type Task = { id: string; title: string; external_id: string; status: string; owner_id: string | null; version: number };
type Device = { id: string; label: string; revoked_at: string | null; last_seen_at: string };
type TeamMember = { user_id: string; role: "owner" | "admin" | "developer" | "viewer" };
type TeamInvitation = { id: string; organization_id?: string; email: string; role: "admin" | "developer" | "viewer";
  workspace_id?:string|null; created_at: string; expires_at: string; accepted_at?: string | null };
type LocalHandoff = { project?: string; workspace?: string; port: number; ticket: string; expiresAt: number };
type LocalPreview = { sources?:IdentityProject["sources"]; canonicalWorkspaceId?:string|null; projectKey?: string; workspaceGroupId?: string; name: string; taskCount: number;
  tasks: Array<{ id: string; title: string; status: string }>;
  repository: { providerRepositoryId: string; remoteUrl: string; repositoryRoot: string } | null;
  candidateRemoteUrl?: string | null;
  candidateRepositoryRoot?: string | null;
  resources?: {localFolders:number;externalServices:number};
  projects?: Array<{sources?:IdentityProject["sources"];projectKey:string; name:string; taskCount:number;tasks:Array<{id:string;title:string;status:string}>;repository:LocalPreview["repository"];candidateRemoteUrl?:string|null;candidateRepositoryRoot?:string|null;resources?:{localFolders:number;externalServices:number}}>;
  sharing: string; link: { organization_id: string; workspace_id: string } | null };
type LocalRepositorySuggestions = { userId:string; workspaceId:string; expiresAt:number;
  projects:Array<{projectKey:string;name:string;repository:LocalPreview["repository"];candidateRemoteUrl:string|null;candidateRepositoryRoot:string|null}> };
type Pilot = { entitlement: { plan: string; seat_limit: number; monthly_event_limit: number; expires_at: string | null };
  usage: { accepted_events: number }; sourcePolicy: { sharing_mode: "metadata_only" | "snippets" | "full_source" };
  seatsUsed: number; workspaceCount: number; github: { configured: boolean; installations: Array<{ account_login: string; active: boolean }> } };
type WorkspaceSubscription = {plan:string;status:string;seat_limit:number;monthly_event_limit:number;trial_ends_at:string|null};
type GithubRepository = {id:string;fullName:string;installationId:number};
type GithubInstallation = {id:number;accountLogin:string;connected:boolean};
type GithubSession = {token:string;userId:string;githubUserId:number;login:string;expiresAt:string|null};
type Context = {
  task: { id: string; title: string; description: string; status: string; ownerId: string | null;
    revisionSet: Array<{ projectKey: string; commit: string }>; scope: Array<{ projectKey: string; target?: string }>;
    dependencies: string[]; provenance: Record<string, unknown>; version: number; updatedAt: string };
  workspace: Workspace;
  projects: Array<{ projectKey: string; repository: string | null; remoteUrl: string | null }>;
  unresolvedDependencies: string[];
  decisions: Array<{ id: string; body: string; sourceRefs: string[]; createdAt: string }>;
  comments: Array<{ id: string; body: string; createdBy: string; createdAt: string }>;
  evidence: Array<{ id: string; kind: string; producer: string; freshness: string; createdAt: string }>;
  receipts: Array<{ id: string; result: string; summary: string; freshness: string; createdAt: string }>;
  resolvedAt: string;
};

export default function TeamPage({requestedWorkspaceId="",requestedOrganizationId="",section="general"}:{requestedWorkspaceId?:string;requestedOrganizationId?:string;section?:string} = {}) {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState("");
  const [context, setContext] = useState<Context | null>(null);
  const [comment, setComment] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [pilot, setPilot] = useState<Pilot | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [workspaceMembers,setWorkspaceMembers] = useState<TeamMember[]>([]);
  const [workspaceSourcePolicy,setWorkspaceSourcePolicy] = useState<{sharing_mode:"metadata_only"|"snippets"|"full_source"}|null>(null);
  const [workspaceSubscription,setWorkspaceSubscription] = useState<{subscription:WorkspaceSubscription;usage:{accepted_events:number}}|null>(null);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<TeamInvitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "developer" | "viewer">("developer");
  const [projects, setProjects] = useState<Array<{ project_key: string; repository: string | null; provider_repository_id: string | null; repository_root?:string }>>([]);
  const [projectKey, setProjectKey] = useState("");
  const [addingResource,setAddingResource] = useState(false);
  const [attachAdditionalSource,setAttachAdditionalSource]=useState(false);
  const [identityProjects,setIdentityProjects]=useState<IdentityProject[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [availableRepositories, setAvailableRepositories] = useState<GithubRepository[]>([]);
  const [availableInstallations, setAvailableInstallations] = useState<GithubInstallation[]>([]);
  const [githubSession, setGithubSession] = useState<GithubSession | null>(null);
  const [repositoryRoot, setRepositoryRoot] = useState(".");
  const [installationId, setInstallationId] = useState("");
  const [githubSetupReturned, setGithubSetupReturned] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Context["decisions"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [handoff, setHandoff] = useState<LocalHandoff | null>(null);
  const [localPreview, setLocalPreview] = useState<LocalPreview | null>(null);
  const [localRepositorySuggestions, setLocalRepositorySuggestions] = useState<LocalRepositorySuggestions | null>(null);
  const [dashboardLink, setDashboardLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("github") === "connected") {
      queueMicrotask(() => setNotice("GitHub account connected. Confirm the App installation, then choose a repository for your AIPI project."));
      url.searchParams.delete("github");
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    const returnedInstallation = url.searchParams.get("installation_id");
    if (returnedInstallation && /^[1-9][0-9]{0,18}$/.test(returnedInstallation)) {
      sessionStorage.setItem("aipi-github-pending-installation", returnedInstallation);
      queueMicrotask(() => { setInstallationId(returnedInstallation); setGithubSetupReturned(true); });
      url.searchParams.delete("installation_id");
      url.searchParams.delete("setup_action");
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } else {
      const pendingInstallation = sessionStorage.getItem("aipi-github-pending-installation");
      if (pendingInstallation && /^[1-9][0-9]{0,18}$/.test(pendingInstallation))
        queueMicrotask(() => { setInstallationId(pendingInstallation); setGithubSetupReturned(true); });
    }
  }, []);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const project = hash.get("project"); const workspace = hash.get("workspace"); const port = Number(hash.get("port")); const ticket = hash.get("ticket");
    if (((project && /^prj_[A-Za-z0-9_-]{4,100}$/.test(project)) || (workspace && /^wsg_[A-Za-z0-9_-]{8,100}$/.test(workspace))) && Number.isInteger(port) && port > 0 && port < 65536 && ticket && /^[A-Za-z0-9_-]{40,100}$/.test(ticket)) {
      const value = { project:project||undefined, workspace:workspace||undefined, port, ticket, expiresAt: Date.now() + 10 * 60_000 };
      localStorage.setItem("aipi-team-handoff", JSON.stringify(value));
      queueMicrotask(() => setHandoff(value));
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } else {
      try { const saved = JSON.parse(localStorage.getItem("aipi-team-handoff") || "null") as LocalHandoff | null;
        if ((saved?.project || saved?.workspace) && saved?.port && saved?.ticket && saved.expiresAt > Date.now()) queueMicrotask(() => setHandoff(saved));
        else localStorage.removeItem("aipi-team-handoff");
      } catch { localStorage.removeItem("aipi-team-handoff"); }
    }
  }, []);

  useEffect(() => {
    if (!handoff) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${handoff.port}/api/team-onboarding/preview`, {
          headers: { authorization: `Bearer ${handoff.ticket}` }, cache: "no-store" });
        const result = await response.json() as LocalPreview & { error?: string };
        if (!response.ok) throw new Error(result.error || "Local companion pairing failed");
        if (!cancelled) setLocalPreview(result);
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not reach the local companion"); }
    };
    void load(); return () => { cancelled = true; };
  }, [handoff]);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.subscription.unsubscribe();
  }, []);

  const api = useCallback(async <T,>(path: string, method = "GET", body?: unknown, githubUserToken?: string): Promise<T> => {
    const { data } = await supabase.auth.getSession();
    if (!data.session?.access_token) throw new Error("Sign in to your team account first");
    const response = await fetch(`${apiRoot}${path}`, { method, headers: {
      authorization: `Bearer ${data.session.access_token}`,
      ...(githubUserToken ? { "x-aipi-github-user-token": githubUserToken } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error || `Team API returned ${response.status}`);
    return result;
  }, []);

  const execute = useCallback(async (work: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "The request failed"); }
    finally { setBusy(false); }
  }, []);

  const loadOrganizations = useCallback(async () => {
    const result = await api<{ organizations: Organization[] }>("/api/team/organizations");
    setOrganizations(result.organizations);
    setOrganizationId((current) => current && result.organizations.some((entry) => entry.id === current)
      ? current : result.organizations.find((entry) => entry.id === (requestedOrganizationId || localStorage.getItem("aipi-team-organization")))?.id ?? result.organizations[0]?.id ?? "");
  }, [api, requestedOrganizationId]);
  const loadWorkspaces = useCallback(async (selected: string) => {
    const result = await api<{ workspaces: Workspace[] }>(`/api/team/organizations/${selected}/workspaces`);
    setWorkspaces(result.workspaces);
    // A new local project must never be shared to whichever workspace happened to be
    // selected in a previous browser session. Require an explicit destination.
    const destination=new URLSearchParams(location.search).get("workspace");
    if (handoff && !localPreview?.link) { setWorkspaceId(result.workspaces.find(item=>item.id===destination)?.id??""); return; }
    setWorkspaceId((current) => current && result.workspaces.some((entry) => entry.id === current)
      ? current : result.workspaces.find((entry) => entry.id === (requestedWorkspaceId || localStorage.getItem(`aipi-team-workspace:${selected}`)))?.id ?? result.workspaces[0]?.id ?? "");
  }, [api, handoff, localPreview?.link, requestedWorkspaceId]);
  const loadTasks = useCallback(async (selected: string) => {
    const result = await api<{ tasks: Task[] }>(`/api/team/workspaces/${selected}/tasks`);
    setTasks(result.tasks);
    setTaskId((current) => current && result.tasks.some((entry) => entry.id === current)
      ? current : result.tasks[0]?.id ?? "");
  }, [api]);
  const loadContext = useCallback(async (organization: string, task: string) => {
    setContext(await api<Context>(`/api/team/organizations/${organization}/tasks/${task}/context?limit=25`));
    setLastRefreshed(new Date());
  }, [api]);
  const loadPilot = useCallback(async (organization: string) => {
    setPilot(await api<Pilot>(`/api/team/organizations/${organization}/pilot`));
    setDevices((await api<{ devices: Device[] }>(`/api/team/organizations/${organization}/devices`)).devices);
  }, [api]);
  const loadMembers = useCallback(async (organization: string) => {
    setMembers((await api<{ members: TeamMember[] }>(`/api/team/organizations/${organization}/members`)).members);
    setInvitations((await api<{ invitations: TeamInvitation[] }>(`/api/team/organizations/${organization}/invitations`)).invitations);
  }, [api]);
  const loadWorkspaceMembers = useCallback(async (workspace: string) => {
    setWorkspaceMembers((await api<{members:TeamMember[]}>(`/api/team/workspaces/${workspace}/members`)).members);
  },[api]);
  const loadWorkspaceSourcePolicy = useCallback(async (workspace:string)=>{
    setWorkspaceSourcePolicy((await api<{sourcePolicy:{sharing_mode:"metadata_only"|"snippets"|"full_source"}}>(
      `/api/team/workspaces/${workspace}/source-policy`)).sourcePolicy);
  },[api]);
  const loadWorkspaceSubscription = useCallback(async (workspace:string)=>{
    setWorkspaceSubscription(await api<{subscription:WorkspaceSubscription;usage:{accepted_events:number}}>(
      `/api/team/workspaces/${workspace}/subscription`));
  },[api]);
  const loadPendingInvitations = useCallback(async () => {
    setPendingInvitations((await api<{ invitations: TeamInvitation[] }>("/api/team/invitations/pending")).invitations);
  }, [api]);
  const loadProjects = useCallback(async (workspace: string) => {
    const loaded = (await api<{ projects: Array<{ project_key: string; repository: string | null; provider_repository_id: string | null; repository_root?:string }> }>(
      `/api/team/workspaces/${workspace}/projects`)).projects;
    setProjects(loaded); if(!loaded.length)setAddingResource(true);
    const identity=await api<{identity:{projects:typeof identityProjects}}>(`/api/team/workspaces/${workspace}/identity`);
    setIdentityProjects(identity.identity.projects);
    setProjectKey((current) => loaded.some((project) => project.project_key === current) ? current : loaded.find((project) => !project.repository)?.project_key ?? loaded[0]?.project_key ?? "");
  }, [api]);

  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (session) void execute(loadOrganizations); else { setOrganizations([]); setOrganizationId(""); } }); return () => { cancelled = true; }; }, [session, execute, loadOrganizations]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (session) void execute(loadPendingInvitations); else setPendingInvitations([]); }); return () => { cancelled = true; }; }, [session, execute, loadPendingInvitations]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (organizationId) void execute(() => loadWorkspaces(organizationId)); else { setWorkspaces([]); setWorkspaceId(""); } }); return () => { cancelled = true; }; }, [organizationId, execute, loadWorkspaces]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (organizationId) void execute(() => loadPilot(organizationId)); else { setPilot(null); setDevices([]); } }); return () => { cancelled = true; }; }, [organizationId, execute, loadPilot]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (organizationId) void execute(() => loadMembers(organizationId)); else { setMembers([]); setInvitations([]); } }); return () => { cancelled = true; }; }, [organizationId, execute, loadMembers]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (workspaceId) void execute(() => loadWorkspaceMembers(workspaceId)); else setWorkspaceMembers([]); }); return () => { cancelled = true; }; }, [workspaceId, execute, loadWorkspaceMembers]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (workspaceId) void execute(() => loadWorkspaceSourcePolicy(workspaceId)); else setWorkspaceSourcePolicy(null); }); return () => { cancelled = true; }; }, [workspaceId, execute, loadWorkspaceSourcePolicy]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (workspaceId) void execute(() => loadWorkspaceSubscription(workspaceId)); else setWorkspaceSubscription(null); }); return () => { cancelled = true; }; }, [workspaceId, execute, loadWorkspaceSubscription]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (workspaceId) void execute(() => loadTasks(workspaceId)); else { setTasks([]); setTaskId(""); } }); return () => { cancelled = true; }; }, [workspaceId, execute, loadTasks]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (workspaceId) void execute(() => loadProjects(workspaceId)); else setProjects([]); }); return () => { cancelled = true; }; }, [workspaceId, execute, loadProjects]);
  useEffect(() => {
    if (!session || !organizationId) { setGithubSession(null); setAvailableRepositories([]); setAvailableInstallations([]); return; }
    let saved: GithubSession | null = null;
    try { saved = JSON.parse(sessionStorage.getItem("aipi-github-app-session") || "null") as GithubSession | null; } catch { /* reconnect below */ }
    if (!saved?.token || saved.userId !== session.user.id || (saved.expiresAt && Date.parse(saved.expiresAt) <= Date.now())) {
      setGithubSession(null); setAvailableRepositories([]); setAvailableInstallations([]); return;
    }
    setGithubSession(saved);
    let active = true;
    if (members.some((member) => member.user_id === session.user.id && ["owner", "admin"].includes(member.role))) void api<{installations:GithubInstallation[]}>(`/api/team/organizations/${organizationId}/github/available-installations`, "GET", undefined, saved.token)
      .then((result) => { if (active) {
        setAvailableInstallations(result.installations);
        setInstallationId((current) => result.installations.some((item) => String(item.id) === current && !item.connected)
          ? current : String(result.installations.find((item) => !item.connected)?.id ?? ""));
      } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load GitHub installations"); });
    if (pilot?.github.installations.length) void api<{repositories:GithubRepository[]}>(
      `/api/team/organizations/${organizationId}/github/repositories`, "GET", undefined, saved.token)
      .then((result) => { if (active) {
        setAvailableRepositories(result.repositories);
        setSelectedRepositoryId((current) => result.repositories.some((repo) => repo.id === current) ? current : "");
      } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load GitHub repositories"); });
    else setAvailableRepositories([]);
    return () => { active = false; };
  }, [api, members, organizationId, pilot, session]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; if (organizationId && taskId) void execute(() => loadContext(organizationId, taskId)); else setContext(null); }); return () => { cancelled = true; }; }, [organizationId, taskId, execute, loadContext]);
  useEffect(() => { if (localPreview?.link && organizations.some((item) => item.id === localPreview.link?.organization_id))
    queueMicrotask(() => setOrganizationId(localPreview.link!.organization_id)); }, [localPreview, organizations]);
  useEffect(() => { if (localPreview?.link && workspaces.some((item) => item.id === localPreview.link?.workspace_id))
    queueMicrotask(() => setWorkspaceId(localPreview.link!.workspace_id)); }, [localPreview, workspaces]);
  useEffect(() => { if (organizationId) localStorage.setItem("aipi-team-organization", organizationId); }, [organizationId]);
  useEffect(() => { if (organizationId && workspaceId) localStorage.setItem(`aipi-team-workspace:${organizationId}`, workspaceId); }, [organizationId, workspaceId]);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("aipi-team-repository-suggestions") || "null") as LocalRepositorySuggestions | null;
      if (saved && session && saved.userId === session.user.id && saved.workspaceId === workspaceId && saved.expiresAt > Date.now()) {
        const current = saved;
        queueMicrotask(() => setLocalRepositorySuggestions(current));
      }
      else queueMicrotask(() => setLocalRepositorySuggestions(null));
    } catch { queueMicrotask(() => setLocalRepositorySuggestions(null)); }
  }, [session?.user.id, workspaceId]);
  useEffect(() => {
    const suggestion = localRepositorySuggestions?.projects.find((item) => item.projectKey === projectKey);
    const current = projects.find(item=>item.project_key===projectKey);
    if (addingResource || !suggestion || current?.provider_repository_id) {
      queueMicrotask(() => { setSelectedRepositoryId(addingResource ? "" : current?.provider_repository_id ?? ""); setRepositoryRoot(addingResource ? "." : current?.repository_root ?? "."); });
      return;
    }
    const suggested = availableRepositories.find((item) => suggestion.repository
      ? item.id === suggestion.repository.providerRepositoryId
      : `https://github.com/${item.fullName}`.toLowerCase() === suggestion.candidateRemoteUrl);
    queueMicrotask(() => { setSelectedRepositoryId(suggested?.id ?? ""); setRepositoryRoot(suggestion.repository?.repositoryRoot ?? suggestion.candidateRepositoryRoot ?? "."); });
  }, [availableRepositories, localRepositorySuggestions, projectKey, projects, addingResource]);
  useEffect(() => {
    if (!session || !workspaceId || location.hash !== "#team-repositories") return;
    const frame = requestAnimationFrame(() => document.getElementById("team-repositories")?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [session, workspaceId]);
  useEffect(() => {
    if (!session || !organizationId || !workspaceId) return;
    let active = true;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        await loadTasks(workspaceId);
        if (taskId) await loadContext(organizationId, taskId);
        if (active) setLastRefreshed(new Date());
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not refresh team data");
      }
    };
    const timer = window.setInterval(() => void refresh(), 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [session, organizationId, workspaceId, taskId, loadTasks, loadContext]);

  const sendCode = () => execute(async () => {
    const { error: authError } = await supabase.auth.signInWithOtp({ email: email.trim(), options: {
      shouldCreateUser: true, emailRedirectTo: `${window.location.origin}/workspace`,
    } });
    if (authError) throw authError;
    setOtpSent(true); setNotice("Check your email for a sign-in link or code.");
  });
  const verifyCode = () => execute(async () => {
    const { error: authError } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    if (authError) throw authError;
    setNotice("Team session connected.");
  });
  const createOrganization = () => execute(async () => {
    const result = await api<{ organization: Organization }>("/api/team/organizations", "POST", { name: organizationName.trim() });
    setOrganizationName(""); await loadOrganizations(); setOrganizationId(result.organization.id);
  });
  const createWorkspace = () => execute(async () => {
    const result = await api<{ workspace: Workspace }>(`/api/team/organizations/${organizationId}/workspaces`, "POST", { name: workspaceName.trim() });
    setWorkspaceName(""); await loadWorkspaces(organizationId); setWorkspaceId(result.workspace.id);
  });
  const inviteMember = () => execute(async () => {
    if (!organizationId || !workspaceId) throw new Error("Choose a workspace first");
    const normalizedEmail = inviteEmail.trim().toLowerCase();
    const result = await api<{ delivered: boolean }>(`/api/team/organizations/${organizationId}/invitations`, "POST", { email: normalizedEmail, role: inviteRole, workspaceId });
    await loadMembers(organizationId);
    setInviteEmail(""); setNotice(result.delivered
      ? `Invitation sent to ${normalizedEmail}. They can sign in and accept it here.`
      : `Invitation saved for ${normalizedEmail}, but email delivery failed. Ask them to sign in to Team Cloud to accept it.`);
  });
  const removeWorkspaceMember = (userId:string) => execute(async()=>{
    if(!workspaceId)throw new Error("Choose a workspace first");
    await api(`/api/team/workspaces/${workspaceId}/members/${userId}`,"DELETE");
    await loadWorkspaceMembers(workspaceId);
  });
  const acceptInvitation = (invitationId: string) => execute(async () => {
    const result = await api<{ organizationId: string }>(`/api/team/invitations/${invitationId}/accept`, "POST");
    await loadPendingInvitations(); await loadOrganizations(); setOrganizationId(result.organizationId);
    setNotice("Invitation accepted. Your team workspace is ready.");
  });
  const connectLocalWorkspace = () => execute(async () => {
    if (!handoff || !localPreview || !organizationId || !session) throw new Error("Sign in and choose an organization first");
    let destination = workspaceId;
    if (!destination) {
      const created = await api<{ workspace: Workspace }>(`/api/team/organizations/${organizationId}/workspaces`, "POST", { ...(localPreview.canonicalWorkspaceId?{id:localPreview.canonicalWorkspaceId}:{}),name: localPreview.name });
      destination = created.workspace.id;
      await loadWorkspaces(organizationId); setWorkspaceId(destination);
    }
    const previewProjects = localPreview.projects ?? [localPreview as LocalPreview & {projectKey:string}];
    for (const project of previewProjects) {
      // Register the whole workspace without asserting repository rights. The
      // user connects each GitHub resource after App authorization.
      await api(`/api/team/workspaces/${destination}/projects/${encodeURIComponent(project.projectKey)}`, "PUT", {name:project.name});
    }
    const existingIdentity=await api<{identity:{projects:IdentityProject[]}}>(`/api/team/workspaces/${destination}/identity`);
    for(const project of previewProjects)for(const source of project.sources??[]){
      const existing=existingIdentity.identity.projects.find(item=>item.id===project.projectKey)?.sources.find(item=>item.id===source.id);
      // Repository rights are confirmed in the separate GitHub binding flow.
      // Keep the source ID, never import device paths or silently downgrade a connected repository.
      if(existing?.repository)continue;
      await api(`/api/team/workspaces/${destination}/projects/${project.projectKey}/sources/${source.id}`,"PUT",{
        kind:source.kind==="external"?"external":"local",name:source.name,...(source.kind==="external"?{endpoint:(source as typeof source&{endpoint?:string}).endpoint}:{}),...(existing?{expectedVersion:existing.version}:{}),
      });
    }
    const suggestions: LocalRepositorySuggestions = { userId: session.user.id, workspaceId: destination,
      expiresAt: Date.now() + 60 * 60_000,
      projects: previewProjects.filter((project) => project.repository || project.candidateRemoteUrl).map((project) => ({
        projectKey: project.projectKey, name: project.name, repository: project.repository,
        candidateRemoteUrl: project.candidateRemoteUrl ?? null,
        candidateRepositoryRoot: project.candidateRepositoryRoot ?? null,
      })) };
    sessionStorage.setItem("aipi-team-repository-suggestions", JSON.stringify(suggestions));
    setLocalRepositorySuggestions(suggestions);
    const response = await fetch(`http://127.0.0.1:${handoff.port}/api/team-onboarding/oauth-start`, {
      method: "POST", cache: "no-store",
      headers: { authorization: `Bearer ${handoff.ticket}` },
    });
    const result = await response.json() as { url?: string; state?: string; error?: string };
    if (!response.ok || !result.url || !result.state) throw new Error(result.error || "Could not start secure companion authorization");
    localStorage.setItem("aipi-team-oauth-pending", JSON.stringify({ handoff, organizationId, workspaceId: destination,
      expectedUserId: session.user.id,
      projectName: localPreview.name, state: result.state, expiresAt: Date.now() + 10 * 60_000 }));
    window.location.assign(result.url);
  });
  const deviceId = async () => {
    if (!session) throw new Error("Sign in to your team account first");
    const key = `aipi-team-device:${organizationId}:${session.user.id}`;
    let id = localStorage.getItem(key);
    if (!id) {
      const created = await api<{ device: { id: string } }>(`/api/team/organizations/${organizationId}/devices`, "POST",
        { label: `Website ${crypto.randomUUID().slice(0, 8)}` });
      id = created.device.id; localStorage.setItem(key, id);
    }
    return id;
  };
  const createTask = () => execute(async () => {
    const title = newTaskTitle.trim();
    if (!title || !workspaceId) return;
    await api(`/api/team/organizations/${organizationId}/workspaces/${workspaceId}/operations/task`, "POST", {
      schemaVersion: 1, operationId: crypto.randomUUID(), deviceId: await deviceId(),
      externalId: `task_${crypto.randomUUID().replaceAll("-", "")}`, title,
      description: "", status: "open", revisionSet: [], baseVersion: 0,
    });
    setNewTaskTitle(""); await loadTasks(workspaceId);
  });
  const addComment = () => execute(async () => {
    if (!context || !session) return;
    await api(`/api/team/organizations/${organizationId}/workspaces/${workspaceId}/operations/append`, "POST", {
      schemaVersion: 1, operationId: crypto.randomUUID(), deviceId: await deviceId(),
      payload: { entityType: "comment", taskId: context.task.id, body: comment.trim() },
    });
    setComment(""); await loadContext(organizationId, context.task.id);
  });
  const searchDecisions = () => execute(async () => {
    const result = await api<{ decisions: Context["decisions"] }>(
      `/api/team/organizations/${organizationId}/decisions/search?q=${encodeURIComponent(search.trim())}&limit=20`);
    setSearchResults(result.decisions);
  });
  const githubToken = () => {
    const saved=JSON.parse(sessionStorage.getItem("aipi-github-app-session")||"null") as {token?:string;userId?:string;expiresAt?:string|null}|null;
    if(!saved?.token||saved.userId!==session?.user.id||(saved.expiresAt&&Date.parse(saved.expiresAt)<=Date.now()))
      throw new Error("Connect your GitHub App user account before selecting repositories");
    return saved.token;
  };
  const startGithub = () => execute(async () => {
    const result=await api<{url:string;state:string}>("/api/team/github/oauth/start","POST",{returnTo:requestedWorkspaceId?`/workspace/${requestedWorkspaceId}/manage/general`:"/workspace/connect"});
    sessionStorage.setItem("aipi-github-oauth-state",result.state);
    location.assign(result.url);
  });
  const connectInstallation = () => execute(async () => {
    if(!organizationId||!/^\d+$/.test(installationId))throw new Error("Enter a GitHub App installation ID");
    await api(`/api/team/organizations/${organizationId}/github/installations`,"POST",{
      installationId:Number(installationId),githubUserToken:githubToken()});
    sessionStorage.removeItem("aipi-github-pending-installation");
    setGithubSetupReturned(false);
    setInstallationId("");await loadPilot(organizationId);
    setNotice("GitHub App installation verified. Choose a repository for your AIPI project below.");
  });
  const updateSourcePolicy = (sharingMode: Pilot["sourcePolicy"]["sharing_mode"]) => execute(async () => {
    if(!workspaceId)throw new Error("Choose a workspace first");
    await api(`/api/team/workspaces/${workspaceId}/source-policy`, "PUT", { sharingMode });
    await loadWorkspaceSourcePolicy(workspaceId);
  });
  const revokeDevice = (id: string) => execute(async () => {
    await api(`/api/team/organizations/${organizationId}/devices/${id}`, "DELETE");
    if (session && localStorage.getItem(`aipi-team-device:${organizationId}:${session.user.id}`) === id)
      localStorage.removeItem(`aipi-team-device:${organizationId}:${session.user.id}`);
    await loadPilot(organizationId);
  });
  const revokeCompanionAccess = () => execute(async () => {
    const { error } = await supabase.auth.oauth.revokeGrant({ clientId: companionOAuthClientId });
    if (error) throw error;
    for (const device of devices.filter((entry) => !entry.revoked_at && entry.label.startsWith("AIPI Companion"))) {
      await api(`/api/team/organizations/${organizationId}/devices/${device.id}`, "DELETE");
    }
    await loadPilot(organizationId);
    setNotice("Companion access revoked. Reconnect from each IDE before syncing again.");
  });
  const exportOrganization = () => execute(async () => {
    const { data } = await supabase.auth.getSession();
    const response = await fetch(`${apiRoot}/api/team/organizations/${organizationId}/export`, {
      headers: { authorization: `Bearer ${data.session?.access_token ?? ""}` },
    });
    if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || "Export failed");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = `aipi-team-${organizationId}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    setNotice("Team export downloaded.");
  });
  const deleteOrganization = () => execute(async () => {
    await api(`/api/team/organizations/${organizationId}`, "DELETE", { confirmName: deleteName });
    setDeleteName(""); setPilot(null); await loadOrganizations();
    setNotice("Organization deleted.");
  });
  const canManageInstallations = members.some((member) => member.user_id === session?.user.id && ["owner", "admin"].includes(member.role));

  return <div className="docs-layout"><SiteHeader signInPath="/workspace" /><main className="team-main page-width">
    <div className="team-heading"><span className="section-index"><Cloud size={14} /> AIPI TEAM CLOUD</span>
      <h1>{requestedWorkspaceId ? workspaces.find(item=>item.id===workspaceId)?.name || "Workspace settings" : "Connect your AIPI workspace"}</h1><p>Choose a workspace, connect its projects, and continue in the same five-tab application.</p></div>
    {!authReady ? <p>Checking your team session…</p> : !session ? <section className="team-auth team-card">
      <ShieldCheck size={28} /><h2>Sign in with your team email</h2><p>This session grants access only to organizations where you are a member.</p>
      <form onSubmit={(event) => { event.preventDefault(); void (otpSent ? verifyCode() : sendCode()); }}>
        <label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        {otpSent && <label>Email code, if provided<input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value)} /></label>}
        <button className="button button-primary" disabled={busy}>{otpSent ? "Verify code" : "Send sign-in link"} <ArrowRight size={14} /></button>
      </form>
    </section> : <>
      <p><a href="/workspace">← All workspaces</a></p>
      <div className="team-toolbar"><span>Signed in as <strong>{session.user.email}</strong>{lastRefreshed && <> · Team data updated {lastRefreshed.toLocaleTimeString()}</>}</span><div className="team-toolbar-actions"><a className="button button-primary" href={workspaceId ? `/workspace/${workspaceId}` : "/workspace"}>Open workspace dashboard <ArrowRight size={14} /></a><button onClick={() => void supabase.auth.signOut()}>Sign out</button></div></div>
      {pendingInvitations.length > 0 && <section className="team-connect team-card"><h2>Team invitations</h2>
        {pendingInvitations.map((invitation) => <div key={invitation.id}><p>You have been invited as <strong>{invitation.role}</strong>. Expires {new Date(invitation.expires_at).toLocaleDateString()}.</p>
          <button className="button button-primary" disabled={busy} onClick={() => void acceptInvitation(invitation.id)}>Join team <ArrowRight size={14} /></button></div>)}
      </section>}
      {handoff && <section className="team-connect team-card"><span className="section-index">CONNECT FROM IDE</span>
        <h2>{localPreview ? `Share ${localPreview.name} with your team` : "Connecting to your local companion…"}</h2>
        {localPreview ? <><p>{localPreview.taskCount} tasks across {localPreview.projects?.length ?? 1} project{(localPreview.projects?.length ?? 1) === 1 ? "" : "s"}. {localPreview.sharing}</p>
          {(localPreview.projects ?? [localPreview as LocalPreview & {projectKey:string}]).map((project) => <details key={project.projectKey}><summary>{project.name} · {project.taskCount} tasks · {project.repository ? "GitHub repository" : "Local source"}</summary><p>{project.repository?.remoteUrl ?? "No GitHub repository connected; local source remains on this device."}</p><p>{project.resources?.localFolders ?? 0} local folders · {project.resources?.externalServices ?? 0} external services. Their paths and credentials stay local.</p><ul>{project.tasks.slice(0, 20).map((task) => <li key={task.id}>{task.title} · {task.status}</li>)}</ul></details>)}
          {!organizations.length ? <form onSubmit={(event) => { event.preventDefault(); void createOrganization(); }}>
            <label>Name your team<input required maxLength={120} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} placeholder="My team" /></label>
            <button className="button button-primary" disabled={busy}>Create team</button>
          </form> : <>
            <label>Team<select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>{organizations.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
            <label>Workspace<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              {!localPreview.link && <option value="">Create a new workspace for {localPreview.name}</option>}
              {workspaces.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select></label>
            <p>Destination: <strong>{organizations.find((item) => item.id === organizationId)?.name}</strong> / <strong>{workspaceId ? workspaces.find((item) => item.id === workspaceId)?.name : `New workspace: ${localPreview.name}`}</strong></p>
            <button className="button button-primary" disabled={busy || !organizationId} onClick={() => void connectLocalWorkspace()}>Connect securely <ArrowRight size={14} /></button>
            <p className="team-muted">You will approve this companion in the next screen. GitHub and teammate invitations can be added later.</p>
          </>}</> : <p>Keep the IDE and companion running while this page connects.</p>}
      </section>}
      {dashboardLink && <section className="team-connect team-card"><h2>Your local dashboard is paired</h2><p>Open the full AIPI dashboard for this project. This live relay expires at {new Date(dashboardLink.expiresAt).toLocaleTimeString()}; shared team tasks remain in this workspace.</p><a className="button button-primary" href={dashboardLink.url} target="_blank" rel="noreferrer">Open full dashboard <ArrowRight size={14} /></a></section>}
      {!requestedWorkspaceId && <><div className="team-grid"><aside className="team-sidebar team-card"><h2>Workspaces</h2>
        <label>Organization<select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
          {organizations.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        {!organizations.length && <form onSubmit={(event) => { event.preventDefault(); void createOrganization(); }}><label>Create organization<input required maxLength={120} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} /></label><button disabled={busy}>Create</button></form>}
        {organizationId && <><label>Workspace<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
          {handoff && !localPreview?.link && <option value="">Create a new workspace for this project</option>}
          {workspaces.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        {!workspaces.length && <form onSubmit={(event) => { event.preventDefault(); void createWorkspace(); }}><label>Create workspace<input required maxLength={120} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></label><button disabled={busy}>Create</button></form>}</>}
        {workspaceId && <div className="team-task-list"><h3>Projects</h3>
          {projects.map((project) => <p key={project.project_key}><strong>{project.project_key}</strong><br /><small>{project.repository || "GitHub not connected"}</small>{!project.repository && <><br /><a href="#team-repositories" onClick={() => setProjectKey(project.project_key)}>Connect GitHub repository</a></>}</p>)}
          {!projects.length && <p>Projects appear here when a developer connects from the IDE or local dashboard.</p>}
        </div>}
        <div className="team-task-list"><h3>Tasks</h3>{workspaceId && <form onSubmit={(event) => { event.preventDefault(); void createTask(); }}><label>New task<input required maxLength={500} value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} /></label><button disabled={busy || !newTaskTitle.trim()}>Create task</button></form>}{tasks.map((task) => <button key={task.id} className={task.id === taskId ? "selected" : ""} onClick={() => setTaskId(task.id)}><strong>{task.title}</strong><small>{task.external_id} · {task.status}</small></button>)}
          {workspaceId && !tasks.length && <p>Tasks appear here after a teammate syncs a workspace.</p>}</div>
      </aside><section className="team-detail team-card">{context ? <>
        <div className="team-detail-head"><div><span className="section-index">TASK HANDOFF · VERSION {context.task.version}</span><h2>{context.task.title}</h2><p>{context.task.description || "No description yet."}</p></div><button aria-label="Refresh task" title="Refresh task" onClick={() => void execute(() => loadContext(organizationId, taskId))}><RefreshCw size={18} /></button></div>
        <div className="team-facts"><span>Status <strong>{context.task.status}</strong></span><span>Owner <strong>{context.task.ownerId ?? "Unassigned"}</strong></span><span>Updated <strong>{new Date(context.task.updatedAt).toLocaleString()}</strong></span></div>
        <div className="team-section"><h3>Scope and dependencies</h3><p>{context.task.scope.length ? context.task.scope.map((entry) => `${entry.projectKey}${entry.target ? ` · ${entry.target}` : ""}`).join("; ") : "No targets selected."}</p>
          {context.unresolvedDependencies.length > 0 && <p className="team-warning">Unresolved: {context.unresolvedDependencies.join(", ")}</p>}
          <p className="team-muted">{context.projects.map((entry) => entry.repository || `${entry.projectKey} (GitHub not connected)`).join(" · ") || "No projects linked yet."}</p></div>
        <div className="team-section"><h3>Revision set</h3><p>{context.task.revisionSet.length ? context.task.revisionSet.map((entry) => `${entry.projectKey} @ ${entry.commit.slice(0, 12)}`).join(" · ") : "No pinned revision yet."}</p></div>
        <div className="team-section"><h3>Decisions</h3>{context.decisions.map((entry) => <article key={entry.id}><p>{entry.body}</p><small>{entry.sourceRefs.join(" · ") || "Team decision"} · {new Date(entry.createdAt).toLocaleString()}</small></article>)}{!context.decisions.length && <p>No decisions recorded.</p>}</div>
        <div className="team-section"><h3>Evidence and receipts</h3>{context.evidence.map((entry) => <article key={entry.id}><p>{entry.kind} · {entry.producer} <span className={entry.freshness === "current" ? "team-current" : "team-warning"}>{entry.freshness}</span></p><small>{new Date(entry.createdAt).toLocaleString()}</small></article>)}
          {context.receipts.map((entry) => <article key={entry.id}><p><CircleCheck size={15} /> {entry.summary} · {entry.result} <span className={entry.freshness === "current" ? "team-current" : "team-warning"}>{entry.freshness}</span></p><small>{new Date(entry.createdAt).toLocaleString()}</small></article>)}
          {!context.evidence.length && !context.receipts.length && <p>No proof attached yet.</p>}</div>
        <div className="team-section"><h3><MessageSquare size={17} /> Handoff comments</h3>{context.comments.map((entry) => <article key={entry.id}><p>{entry.body}</p><small>{new Date(entry.createdAt).toLocaleString()}</small></article>)}
          <form onSubmit={(event) => { event.preventDefault(); void addComment(); }}><label>Add a comment<textarea value={comment} onChange={(event) => setComment(event.target.value)} required maxLength={16000} /></label><button disabled={busy || !comment.trim()}>Post comment</button></form></div>
      </> : <div className="team-empty"><Cloud size={28} /><h2>Select a task</h2><p>Choose a workspace task to see its current handoff context.</p></div>}</section></div>
      {organizationId && <section className="team-search team-card"><h2>Search decisions</h2><form onSubmit={(event) => { event.preventDefault(); void searchDecisions(); }}><input value={search} minLength={2} maxLength={120} placeholder="Search current decisions" onChange={(event) => setSearch(event.target.value)} /><button disabled={busy || search.trim().length < 2}>Search</button></form>{searchResults.map((entry) => <p key={entry.id}>{entry.body}</p>)}</section>}
      </>}
      {workspaceId && <section className="team-ops team-card"><h2>Workspace members</h2>
        <p>{workspaceMembers.length} visible member{workspaceMembers.length === 1 ? "" : "s"} in this workspace</p>
        {workspaceMembers.map(member=><p key={member.user_id}>{member.user_id===session.user.id?"You":member.user_id} · {member.role} {member.role!=="owner"&&workspaceMembers.some(entry=>entry.user_id===session.user.id&&
          (entry.role==="owner"||(entry.role==="admin"&&member.role!=="admin")))&&<button type="button" disabled={busy} onClick={()=>void removeWorkspaceMember(member.user_id)}>Remove</button>}</p>)}
        {workspaceMembers.some((member) => member.user_id === session.user.id && ["owner", "admin"].includes(member.role)) && <>
          <form onSubmit={(event) => { event.preventDefault(); void inviteMember(); }}>
            <label>Invite by email<input type="email" required maxLength={320} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="developer@example.com" /></label>
            <label>Role<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}><option value="developer">Developer</option><option value="admin">Admin</option><option value="viewer">Viewer</option></select></label>
            <button disabled={busy || !inviteEmail.trim()}>Send invitation</button>
          </form>
          {invitations.filter((invitation) => !invitation.accepted_at&&invitation.workspace_id===workspaceId).map((invitation) => <p key={invitation.id}>{invitation.email} · {invitation.role} · pending until {new Date(invitation.expires_at).toLocaleDateString()}</p>)}
        </>}
      </section>}
      {workspaceId && <section id="team-repositories" className="team-ops team-card"><h2>Workspace resources &amp; sources</h2>
        <p>Your AIPI projects keep their existing identities. Select the GitHub repository that contains each project; AIPI verifies your current access before saving the binding.</p>
        {canManageInstallations && <p><a href="https://github.com/apps/aipi-team-connector/installations/new" onClick={()=>sessionStorage.setItem("aipi-github-install-return",requestedWorkspaceId?`/workspace/${requestedWorkspaceId}/manage/general`:"/workspace/connect")}>Install AIPI Team Connector on selected repositories ↗</a></p>}
        {!githubSession ? <button type="button" onClick={() => void startGithub()} disabled={busy}>Connect my GitHub account</button>
          : <p>GitHub account connected as <strong>{githubSession.login}</strong> · <button type="button" onClick={() => void startGithub()} disabled={busy}>Reconnect</button></p>}
        {githubSetupReturned && <p>GitHub App installation detected. Confirm it below to make its repositories available to this team.</p>}
        {githubSession && canManageInstallations && availableInstallations.some((item) => !item.connected) && <form onSubmit={(event)=>{event.preventDefault();void connectInstallation();}}>
          <label>GitHub App installation<select value={installationId} onChange={(event)=>setInstallationId(event.target.value)} required>
            <option value="">Choose an installation</option>{availableInstallations.filter((item) => !item.connected).map((item) => <option key={item.id} value={item.id}>{item.accountLogin}</option>)}
          </select></label><button disabled={busy || !installationId}>Connect installation to this team</button>
        </form>}
        {githubSession && canManageInstallations && !availableInstallations.length && <p>No AIPI Team Connector installation is visible to this GitHub account yet. Install the App above, then refresh this page.</p>}
        <WorkspaceSources workspaceId={workspaceId} organizationId={organizationId} projects={identityProjects} repositories={availableRepositories} githubReady={Boolean(githubSession)} api={api} githubToken={githubToken} onConnectGithub={()=>void startGithub()} onRefresh={()=>loadProjects(workspaceId)} handoff={handoff}/>
        {githubSession && Boolean(pilot?.github.installations.length) && !availableRepositories.length && <p>No repositories are available yet. Check which repositories were selected for the GitHub App installation.</p>}
      </section>}
      {organizationId && <details className="team-advanced"><summary>Advanced team settings</summary>
      {pilot && <section className="team-ops team-card"><h2>Team controls and diagnostics</h2>
        <div className="team-ops-facts">{workspaceSubscription&&<><span>Workspace plan <strong>{workspaceSubscription.subscription.plan} · {workspaceSubscription.subscription.status.replaceAll("_"," ")}</strong></span><span>Workspace seats <strong>{workspaceMembers.length} / {workspaceSubscription.subscription.seat_limit}</strong></span><span>Workspace events <strong>{workspaceSubscription.usage.accepted_events} / {workspaceSubscription.subscription.monthly_event_limit}</strong></span><span>Trial ends <strong>{workspaceSubscription.subscription.trial_ends_at ? new Date(workspaceSubscription.subscription.trial_ends_at).toLocaleDateString() : "—"}</strong></span></>}<span>Workspaces <strong>{pilot.workspaceCount}</strong></span><span>GitHub App <strong>{pilot.github.configured ? "Configured" : "Setup required"}</strong></span></div>
        <p>GitHub installations: {pilot.github.installations.map((item) => item.account_login).join(", ") || "None connected"}</p>
        {workspaceSourcePolicy&&<label>Source sharing for this workspace<select value={workspaceSourcePolicy.sharing_mode} onChange={(event) => void updateSourcePolicy(event.target.value as Pilot["sourcePolicy"]["sharing_mode"])} disabled={busy}>
          <option value="metadata_only">Metadata only</option><option value="snippets">Short snippets</option><option value="full_source">Full source</option>
        </select></label>}<p>Metadata only is the default. Workspace owners and admins can change this policy.</p>
        <h3>My devices</h3>{devices.map((device) => <p key={device.id}>{device.label} · {device.revoked_at ? "Revoked" : "Active"} {!device.revoked_at && <button onClick={() => void revokeDevice(device.id)} disabled={busy}>Revoke device writes</button>}</p>)}
        <button onClick={() => void revokeCompanionAccess()} disabled={busy}>Revoke all companion sign-ins</button>
        <p>This signs out every AIPI Companion authorized for your account and disables their registered devices. Reconnect each IDE to resume syncing.</p>
        <p>To connect another project, use <strong>AIPI: Share Current Workspace with Team</strong> in VS Code or Cursor. AIPI securely keeps its team session in your device’s credential store and restores sync when the companion restarts. Revoke a device above if it is lost.</p>
        <button onClick={() => void exportOrganization()} disabled={busy}>Download team export</button>
        <form onSubmit={(event) => { event.preventDefault(); void deleteOrganization(); }}><label>Delete organization: type its exact name<input value={deleteName} onChange={(event) => setDeleteName(event.target.value)} /></label><button disabled={busy || deleteName !== organizations.find((item) => item.id === organizationId)?.name}>Delete organization and team data</button></form>
      </section>}
      </details>}
    </>}
    {error && <p role="alert" className="team-error">{error}</p>}{notice && <p role="status" className="team-notice">{notice}</p>}
  </main><SiteFooter /></div>;
}
