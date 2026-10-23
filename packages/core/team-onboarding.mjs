import crypto from "node:crypto";
import {normalizeSourceBinding} from "./workspace-identity.mjs";
import path from "node:path";
import { canonicalGithubRepositoryRemote } from "./workspace-manifest.mjs";
import { beginTeamOAuth } from "./team-oauth.mjs";
import { normalizeWorkspaceGroups } from "./workspace-groups.mjs";
import { normalizeTaskStatus } from "./workspace-domain.mjs";

const PROJECT_KEY = /^prj_[A-Za-z0-9_-]{4,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function localRepositorySuggestion(project) {
  const synced = project.teamRepositorySync;
  const declared = project.repositoryBinding;
  if (synced?.status === "connected" && declared && String(synced.providerRepositoryId) === String(declared.providerRepositoryId) &&
      synced.root === declared.root && canonicalGithubRepositoryRemote(synced.remote) === canonicalGithubRepositoryRemote(declared.remote))
    return {remoteUrl:canonicalGithubRepositoryRemote(declared.remote),repositoryRoot:declared.root};
  const binding = project.gitBinding;
  const remoteUrl = canonicalGithubRepositoryRemote(binding?.repositoryUrl);
  if (!remoteUrl) return { remoteUrl: null, repositoryRoot: null };
  const sourceRoot = binding?.sourceRoot;
  const gitRoot = binding?.repositoryRoot;
  if (typeof sourceRoot !== "string" || typeof gitRoot !== "string" || !path.isAbsolute(sourceRoot) || !path.isAbsolute(gitRoot))
    return { remoteUrl, repositoryRoot: null };
  const relative = path.relative(gitRoot, sourceRoot);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return { remoteUrl, repositoryRoot: null };
  const repositoryRoot = relative ? relative.split(path.sep).join("/") : ".";
  return /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(repositoryRoot) &&
    !repositoryRoot.split("/").includes("..")
    ? { remoteUrl, repositoryRoot } : { remoteUrl, repositoryRoot: null };
}

export function teamProjectPreview(state, projectKey) {
  if (!PROJECT_KEY.test(projectKey)) throw new Error("A valid AIPI project key is required");
  const project = state.projects?.find((entry) => entry.id === projectKey);
  if (!project) throw new Error("Project is no longer available in this companion");
  const candidates = (project.tasks?.length ? project.tasks : project.summary?.tasks ?? [])
    .filter((task) => typeof task.id === "string" && typeof task.title === "string" && task.title.trim())
    .map((task) => {
      if (task.title.trim().length > 500) throw new Error(`Task ${task.id} has a title too long for Team sync`);
      return { id: task.id, title: task.title.trim(), status: teamTaskStatus(task.status) };
    });
  if (candidates.length > 200) throw new Error("This project has more than 200 tasks; paged Team import is required before upgrading it");
  if (new Set(candidates.map((task) => task.id)).size !== candidates.length) throw new Error("Duplicate local task IDs must be resolved before Team sync");
  const tasks = candidates;
  const candidate = localRepositorySuggestion(project);
  const groups=(state.workspaceGroups??[]).filter(group=>group.projectIds.includes(projectKey));
  return { projectKey, name: project.name, sources:(project.sourceBindings??[]).filter(source=>!source.supersededBy).map(normalizeSourceBinding),canonicalWorkspaceId:groups.length===1?(groups[0].teamWorkspaceId??groups[0].canonicalId??null):null, tasks, taskCount: tasks.length,
    resources: { localFolders: project.sourceContext?.roots?.length ?? 0,
      externalServices: [...new Set((project.environments ?? []).flatMap((environment) => environment.services ?? []).map((service) => service.id ?? service.variableKey).filter(Boolean))].length },
    repository: project.repositoryBinding?.identityStatus === "verified" && canonicalGithubRepositoryRemote(project.repositoryBinding.remote)
      ? { providerRepositoryId: project.repositoryBinding.providerRepositoryId,
        remoteUrl: canonicalGithubRepositoryRemote(project.repositoryBinding.remote), repositoryRoot: project.repositoryBinding.root ?? "." }
      : null,
    // A configured local Git publish remote is only a hint. Cloud must match
    // it against an installed repository and verify the signed-in user.
    candidateRemoteUrl: candidate.remoteUrl,
    candidateRepositoryRoot: candidate.repositoryRoot,
    sharing: "Task titles and statuses only. Source code, paths, secrets, and request bodies stay local." };
}

export function teamWorkspacePreview(state, workspaceGroupId) {
  const group = normalizeWorkspaceGroups(state).find((entry) => entry.id === workspaceGroupId);
  if (!group) throw new Error("Workspace is no longer available in this companion");
  const projects = group.projectIds.map((projectId) => teamProjectPreview(state, projectId));
  if (projects.reduce((total, project) => total + project.taskCount, 0) > 200)
    throw new Error("This workspace has more than 200 tasks; paged Team import is required before upgrading it");
  return { workspaceGroupId: group.id, canonicalWorkspaceId:group.teamWorkspaceId??group.canonicalId??null,name: group.name, projects,
    taskCount: projects.reduce((total, project) => total + project.taskCount, 0),
    sharing: "Task titles and statuses from every project are shared. Source, paths, secrets and request bodies remain local." };
}

export function teamTaskStatus(status) {
  return normalizeTaskStatus(status);
}

function stableUuid(value) {
  const hex = crypto.createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function teamTaskExternalId(organizationId, workspaceId, projectKey, taskId) {
  const identity = `${organizationId}:${workspaceId}:${projectKey}:${taskId}`;
  return `task_${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export function enqueueInitialTeamTasks(store, preview, { organizationId, workspaceId, deviceId, actorId }) {
  if (![organizationId, workspaceId, deviceId, actorId].every((value) => UUID.test(value))) throw new Error("Valid team IDs are required");
  for (const task of preview.tasks) {
    const identity = `${organizationId}:${workspaceId}:${preview.projectKey}:${task.id}`;
    store.enqueue({ schemaVersion: 1, operationId: stableUuid(`initial:${identity}`), organizationId,
      workspaceId, deviceId, actorId, entityType: "task", action: "patch", baseVersion: 0,
      payload: { externalId: teamTaskExternalId(organizationId, workspaceId, preview.projectKey, task.id),
        projectKey: preview.projectKey, patch: { title: task.title, status: task.status } } });
  }
  return preview.tasks.length;
}

export class TeamOnboardingTickets {
  #tickets = new Map();
  create(projectKey, now = Date.now()) {
    const selection = typeof projectKey === "string" ? {projectKey} : projectKey;
    if (!selection?.workspaceGroupId && !PROJECT_KEY.test(selection?.projectKey)) throw new Error("A valid AIPI project key is required");
    if (selection.workspaceGroupId && !/^wsg_[A-Za-z0-9_-]{8,100}$/.test(selection.workspaceGroupId)) throw new Error("A valid AIPI workspace ID is required");
    const ticket = crypto.randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { ...selection, expiresAt: now + 10 * 60_000 });
    return { ticket, ...selection, expiresAt: new Date(now + 10 * 60_000).toISOString() };
  }
  get(ticket, now = Date.now()) {
    const record = this.#tickets.get(ticket);
    if (!record || record.expiresAt <= now) { this.#tickets.delete(ticket); throw new Error("Pairing expired. Reopen Team Cloud from the IDE."); }
    return record;
  }
  beginOAuth(ticket, now = Date.now()) {
    const record = this.get(ticket, now);
    const oauth = beginTeamOAuth();
    record.oauth = { verifier: oauth.verifier, state: oauth.state };
    return { url: oauth.url, state: oauth.state };
  }
  verifyOAuth(ticket, state, now = Date.now()) {
    const record = this.get(ticket, now);
    if (!record.oauth || typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state) || state.length !== record.oauth.state.length ||
        !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(record.oauth.state)))
      throw new Error("Team authorization did not match this companion request");
    return { ...record, verifier: record.oauth.verifier };
  }
  consume(ticket, now = Date.now()) {
    const record = this.get(ticket, now);
    this.#tickets.delete(ticket);
    return record;
  }
}
