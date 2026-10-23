// Runtime-neutral workspace identities and lifecycle rules. No checkout path or
// credential is part of a shared resource declaration.
export const WORKSPACE_MODES = Object.freeze(['local', 'team']);
export const RESOURCE_KINDS = Object.freeze(['github_repository', 'local_source', 'external_service']);
export const TASK_STATUSES = Object.freeze(['proposed', 'open', 'in_progress', 'in_review', 'blocked', 'completed', 'archived']);

const TASK_ALIASES = Object.freeze({
  done: 'completed', complete: 'completed', completed: 'completed',
  'in-progress': 'in_progress', in_progress: 'in_progress', active: 'in_progress',
  'in-review': 'in_review', in_review: 'in_review', 'awaiting-developer-review': 'in_review',
  blocked: 'blocked', archived: 'archived', proposed: 'proposed', open: 'open',
});

export function normalizeTaskStatus(value) {
  return TASK_ALIASES[String(value ?? '').trim().toLowerCase()] ?? 'open';
}

export function assertWorkspaceIdentity(value) {
  if (typeof value !== 'string' || !/^wsg_[A-Za-z0-9_-]{8,100}$/.test(value))
    throw new Error('A stable AIPI workspace ID is required');
  return value;
}

export function assertProjectIdentity(value) {
  if (typeof value !== 'string' || !/^prj_[A-Za-z0-9_-]{4,100}$/.test(value))
    throw new Error('A stable AIPI project ID is required');
  return value;
}

export function workspaceResource({ projectId, name, kind, repository = null, externalService = null }) {
  assertProjectIdentity(projectId);
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('A resource name is required');
  if (!RESOURCE_KINDS.includes(kind)) throw new Error('A supported project resource kind is required');
  if (kind === 'github_repository' && (!repository || externalService)) throw new Error('A GitHub resource requires its repository binding');
  if (kind === 'external_service' && (!externalService || repository)) throw new Error('An external service requires a service declaration');
  if (kind === 'local_source' && (repository || externalService)) throw new Error('Local source has no remote binding');
  return { projectId, name: name.trim(), kind, repository, externalService };
}

export function workspaceEntitlementState({ mode, subscriptionStatus = null, trialEndsAt = null }, now = Date.now()) {
  if (mode === 'local') return 'free_local';
  if (mode !== 'team') throw new Error('Unknown workspace mode');
  if (subscriptionStatus === 'active') return 'active';
  if (subscriptionStatus === 'trialing' && trialEndsAt && Date.parse(trialEndsAt) > now) return 'trial';
  if (subscriptionStatus === 'grace') return 'grace';
  return 'read_only';
}

export function resourceAccess({ workspaceRole, kind, githubUserRead = false, githubUserWrite = false,
  installationRead = false, installationWrite = false, policyRead = true, policyWrite = true }) {
  if (!RESOURCE_KINDS.includes(kind)) return Object.freeze({ read: false, write: false });
  const member = ['owner', 'admin', 'developer', 'viewer'].includes(workspaceRole);
  const editor = ['owner', 'admin', 'developer'].includes(workspaceRole);
  const github = kind === 'github_repository';
  const read = member && policyRead && (!github || (githubUserRead && installationRead));
  const write = read && editor && policyWrite && (!github || (githubUserWrite && installationWrite));
  return Object.freeze({ read, write });
}
