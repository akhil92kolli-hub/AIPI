import { workspaceGroup } from "./workspace-groups.mjs";

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// This portable declaration never contains checkout paths or grants membership.
export function normalizeRepositoryBinding(input) {
  if (input === null) return null;
  if (!object(input) || input.provider !== "github") fail("A GitHub repository binding or null is required");
  if (typeof input.providerRepositoryId !== "string" || !/^[1-9]\d{0,29}$/.test(input.providerRepositoryId)) fail("A stable GitHub repository ID is required");
  if (typeof input.remote !== "string") fail("A credential-free GitHub HTTPS URL is required");
  const match = input.remote.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  if (!match || [match[1], match[2]].some(value => value === "." || value === "..")) fail("A credential-free GitHub HTTPS URL is required");
  const name = match[2].replace(/\.git$/, "");
  if (!name || name === "." || name === "..") fail("A repository name is required");
  const root = input.root ?? ".";
  if (typeof root !== "string" || root.length > 500 || (root !== "." && !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(root)) || root.split("/").some(part => part === ".." || (part === "." && root !== "."))) {
    fail("Repository root must be a relative path without traversal");
  }
  return {
    provider: "github",
    providerRepositoryId: input.providerRepositoryId,
    remote: `https://github.com/${match[1]}/${name}`,
    root,
    identityStatus: "declared"
  };
}

export function exportWorkspaceManifest(state, workspaceId) {
  const group = workspaceGroup(state, workspaceId);
  return {
    schemaVersion: 2,
    workspaceId: group.id,
    name: group.name,
    membershipVersion: group.version,
    bindingVersion: group.bindingVersion ?? 0,
    resources: [...group.projectIds].sort().map(projectId => {
      const project = state.projects.find(entry => entry.id === projectId);
      if (!project) fail("A workspace project is unavailable", 409);
      return {
        projectId,
        name: project.name,
        repository: project.repositoryBinding ? normalizeRepositoryBinding(project.repositoryBinding) : null
      };
    })
  };
}

export function saveWorkspaceManifest(state, workspaceId, input) {
  const group = workspaceGroup(state, workspaceId);
  if (!object(input) || input.schemaVersion !== 2 || input.workspaceId !== workspaceId) fail("Unsupported manifest or mismatched workspace ID");
  if (input.membershipVersion !== group.version || input.bindingVersion !== (group.bindingVersion ?? 0)) fail("Workspace changed. Reload its manifest before saving.", 409);
  if (!Array.isArray(input.resources) || input.resources.length !== group.projectIds.length) fail("Manifest must contain exactly the existing workspace projects");
  const seen = new Set();
  const updates = input.resources.map(resource => {
    if (!object(resource) || !group.projectIds.includes(resource.projectId) || seen.has(resource.projectId)) fail("Manifest contains an unknown or duplicate project");
    seen.add(resource.projectId);
    const project = state.projects.find(entry => entry.id === resource.projectId);
    if (!project) fail("A workspace project is unavailable", 409);
    const repository = normalizeRepositoryBinding(resource.repository);
    const current = project.repositoryBinding;
    // Re-saving an unchanged portable declaration must not discard the
    // identity proof obtained from GitHub. Any actual change needs recheck.
    const unchanged = repository && current?.identityStatus === "verified" &&
      current.provider === repository.provider &&
      current.providerRepositoryId === repository.providerRepositoryId &&
      canonicalGithubRepositoryRemote(current.remote) === canonicalGithubRepositoryRemote(repository.remote) &&
      current.root === repository.root;
    return { project, repository: unchanged ? current : repository };
  });
  for (const { project, repository } of updates) {
    const current = project.repositoryBinding;
    if (current && (!repository || current.providerRepositoryId !== repository.providerRepositoryId || current.root !== repository.root))
      fail("Repository identity or directory changed; add a new source binding and review references", 409);
  }
  const changed = updates.filter(({ project, repository }) => JSON.stringify(project.repositoryBinding ?? null) !== JSON.stringify(repository));
  if (changed.length) {
    for (const { project, repository } of changed) project.repositoryBinding = repository;
    // Projects can appear in several workspaces: invalidate every affected manifest.
    for (const candidate of state.workspaceGroups) {
      if (changed.some(({ project }) => candidate.projectIds.includes(project.id))) candidate.bindingVersion = (candidate.bindingVersion ?? 0) + 1;
    }
  }
  return exportWorkspaceManifest(state, workspaceId);
}

export function canonicalGithubRepositoryRemote(value) {
  const remote = String(value ?? "").trim();
  const ssh = remote.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  const https = remote.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  const match = ssh ?? https;
  return match ? `https://github.com/${match[1].toLowerCase()}/${match[2].replace(/\.git$/, "").toLowerCase()}` : null;
}

export async function verifyGithubRepositoryIdentity(binding, { fetchImpl = fetch, token = "" } = {}) {
  const declared = normalizeRepositoryBinding(binding);
  const headers = { accept: "application/vnd.github+json", "user-agent": "aipi-companion" };
  if (token) headers.authorization = "Bearer " + token;
  let response;
  try { response = await fetchImpl("https://api.github.com/repositories/" + encodeURIComponent(declared.providerRepositoryId), { headers }); }
  catch { fail("GitHub identity verification is unavailable", 503); }
  if (!response.ok) {
    if (response.status === 404) fail("GitHub repository ID was not found or is not visible to this companion", 404);
    fail("GitHub identity verification failed (" + response.status + ")", 502);
  }
  const repository = await response.json();
  const remote = canonicalGithubRepositoryRemote(repository.html_url);
  if (!remote || remote !== canonicalGithubRepositoryRemote(declared.remote)) fail("GitHub repository ID does not match the declared repository URL", 409);
  return { ...declared, identityStatus: "verified", verifiedAt: new Date().toISOString(), providerName: repository.full_name ?? null };
}

export function workspaceCheckoutBindings(state, workspaceId) {
  const group = workspaceGroup(state, workspaceId);
  state.deviceCheckoutBindings ??= [];
  return state.deviceCheckoutBindings
    .filter(entry => group.projectIds.includes(entry.projectId))
    .map(({ projectId, root, label, repositoryRoot, remoteName, branch, commit, verifiedAt }) => ({ projectId, root, label, repositoryRoot, remoteName, branch, commit, verifiedAt }));
}

export function saveWorkspaceCheckoutBinding(state, workspaceId, input, inspection) {
  const group = workspaceGroup(state, workspaceId);
  if (!object(input) || !group.projectIds.includes(input.projectId)) fail("Choose a project in this workspace");
  const project = state.projects.find(entry => entry.id === input.projectId);
  if (!project?.repositoryBinding) fail("Bind this project to a repository before mapping a local checkout", 409);
  const expected = canonicalGithubRepositoryRemote(project.repositoryBinding.remote);
  const remotes = (inspection?.remotes ?? []).map(entry => ({
    name: entry.name,
    remote: canonicalGithubRepositoryRemote(entry.pushUrl || entry.fetchUrl)
  }));
  const match = remotes.find(entry => entry.remote === expected);
  if (!match) fail("The selected checkout does not contain the project's bound GitHub repository", 409);
  const root = String(input.root ?? "").trim();
  const label = String(input.label ?? "").trim();
  const repositoryRoot = String(inspection.repositoryRoot ?? "").trim();
  if (!root || !repositoryRoot || !String(inspection.commit ?? "").match(/^[0-9a-f]{40}$/)) fail("A checked-out Git repository is required", 409);
  if (label && (label.length > 80 || !/^[\w .:/-]+$/u.test(label))) fail("Checkout label must contain at most 80 plain characters");
  state.deviceCheckoutBindings ??= [];
  const index = state.deviceCheckoutBindings.findIndex(entry => entry.projectId === project.id && entry.root === root);
  const record = {
    ...(index >= 0 ? state.deviceCheckoutBindings[index] : {}),
    projectId: project.id, root, label: label || null, repositoryRoot, remoteName: match.name,
    branch: inspection.branch ?? "detached", commit: inspection.commit,
    verifiedAt: new Date().toISOString()
  };
  if (index >= 0) state.deviceCheckoutBindings[index] = record; else state.deviceCheckoutBindings.push(record);
  return record;
}
