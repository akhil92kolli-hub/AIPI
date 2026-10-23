// Canonical WorkspaceProvider contract and implementations for AIPI One Workspace Application.
// Both Local and Team data providers conform to this contract.

const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode, status: statusCode });
};

/**
 * Formats a qualified workspace object link across Cloud, Local, and IDE surfaces.
 */
export function formatWorkspaceObjectLink({
  surface = 'local',
  workspaceId = '',
  view = 'home',
  assessmentId = null,
  generation = null,
  taskId = null,
  section = null,
  releaseId = null,
  environment = null,
} = {}) {
  if (!workspaceId) fail('workspaceId is required for object links', 400);
  if (surface === 'ide') {
    return {
      channel: 'aipi.ide.v1',
      type: 'openObject',
      payload: {
        workspaceId,
        view,
        ...(assessmentId ? { assessmentId } : {}),
        ...(generation != null ? { generation: Number(generation) } : {}),
        ...(taskId ? { taskId } : {}),
        ...(section ? { section } : {}),
        ...(releaseId ? { releaseId } : {}),
        ...(environment ? { environment } : {}),
      },
    };
  }
  const params = new URLSearchParams();
  if (view) params.set('view', view);
  if (assessmentId) params.set('assessment', assessmentId);
  if (generation != null) params.set('generation', String(generation));
  if (taskId) params.set('task', taskId);
  if (section) params.set('section', section);
  if (releaseId) params.set('release', releaseId);
  if (environment) params.set('environment', environment);
  const prefix = surface === 'cloud' || surface === 'team' ? '/workspace' : '/workspaces';
  const query = params.toString();
  return `${prefix}/${encodeURIComponent(workspaceId)}${query ? `?${query}` : ''}`;
}

/**
 * Parses a Cloud/Local object link path or IDE openObject message into a canonical reference.
 */
export function parseWorkspaceObjectLink(input) {
  if (input && typeof input === 'object' && input.type === 'openObject') {
    const p = input.payload ?? {};
    return {
      surface: 'ide',
      workspaceId: String(p.workspaceId ?? ''),
      view: String(p.view ?? 'home'),
      assessmentId: p.assessmentId ?? null,
      generation: p.generation != null ? Number(p.generation) : null,
      taskId: p.taskId ?? null,
      section: p.section ?? null,
      releaseId: p.releaseId ?? null,
      environment: p.environment ?? null,
    };
  }
  const raw = String(input ?? '').trim();
  const url = new URL(raw.startsWith('http') ? raw : `https://aipi.local${raw.startsWith('/') ? '' : '/'}${raw}`);
  const match = url.pathname.match(/^\/(workspaces?)\/([^/]+)/);
  if (!match) return null;
  const surface = match[1] === 'workspace' ? 'cloud' : 'local';
  const workspaceId = decodeURIComponent(match[2]);
  const params = url.searchParams;
  return {
    surface,
    workspaceId,
    view: params.get('view') || 'home',
    assessmentId: params.get('assessment') || null,
    generation: params.has('generation') ? Number(params.get('generation')) : null,
    taskId: params.get('task') || null,
    section: params.get('section') || null,
    releaseId: params.get('release') || null,
    environment: params.get('environment') || null,
  };
}

/**
 * Normalizes a capability entry into a structured capability object.
 */
export function normalizeCapabilityDetail(key, rawValue, mode = 'local') {
  if (rawValue && typeof rawValue === 'object') {
    return {
      availability: rawValue.availability ?? 'available',
      reasonCode: rawValue.reasonCode ?? 'ready',
      reason: rawValue.reason ?? '',
      permittedAction: rawValue.permittedAction ?? 'open',
      executionTarget: rawValue.executionTarget ?? (mode === 'team' ? 'cloud_worker' : 'companion'),
      freshness: rawValue.freshness ?? 'current',
      scope: rawValue.scope ?? key,
    };
  }
  const text = String(rawValue ?? '');
  const lower = text.toLowerCase();
  const isUnavailable = lower.includes('unavailable') || lower.includes('no readable') || lower.includes('connect ') || lower.includes('pending') || lower.includes('not connected');
  const isRestricted = lower.includes('restricted') || lower.includes('permission') || lower.includes('sign in');
  const availability = isRestricted
    ? 'restricted'
    : isUnavailable
      ? (mode === 'team' ? 'connection_required' : 'available')
      : 'available';
  const reasonCode = isRestricted
    ? 'authorization_required'
    : isUnavailable
      ? 'capability_unconfigured'
      : 'ready';
  const defaultActions = {
    knowledge: availability === 'available' ? 'Explore indexed graph' : 'Connect GitHub App or companion',
    contracts: availability === 'available' ? 'Inspect contracts' : 'Index or sync contracts',
    verify: availability === 'available' ? 'Run reviewed checks' : 'Connect a companion or select CI runner',
    source: availability === 'available' ? 'Inspect pinned source' : 'Connect repository source',
    agents: availability === 'available' ? 'Prepare context' : 'Open in connected companion',
    settings: 'Configure workspace',
    deploymentGate: mode === 'team' ? 'Preview release compatibility' : 'Preview local preflight',
  };
  return {
    availability,
    reasonCode,
    reason: text,
    permittedAction: defaultActions[key] ?? 'Inspect',
    executionTarget: mode === 'team' ? 'cloud_worker' : 'companion',
    freshness: availability === 'available' ? 'current' : 'unknown',
    scope: key,
  };
}

/**
 * Applies project focus without narrowing cross-project safety scope.
 */
export function applyWorkspaceProjectFilter(model, projectFilter) {
  if (!projectFilter) {
    return {
      ...model,
      focusedProjectId: null,
      allProjects: model.projects,
      alsoAffectedOutsideProject: [],
    };
  }
  const focusedTasks = model.tasks.filter(
    (t) => t.projectId === projectFilter || t.projectIds.includes(projectFilter)
  );
  const crossProjectTasks = model.tasks.filter(
    (t) =>
      t.projectId !== projectFilter &&
      (t.projectIds.includes(projectFilter) ||
        t.originProjectId === projectFilter ||
        (t.scope ?? []).some((s) => (s.projectKey ?? s.projectId) === projectFilter))
  );
  const assessmentOutside = (model.assessment?.components ?? []).filter(
    (c) => c.projectId && c.projectId !== projectFilter
  );
  const alsoAffectedOutsideProject = [
    ...crossProjectTasks.map((t) => ({
      kind: 'task',
      id: t.id,
      projectId: t.projectId,
      projectName: model.projects.find((p) => p.id === t.projectId)?.name ?? t.projectName ?? t.projectId,
      label: t.title,
      status: t.status,
      reason: 'Cross-project consumer repair obligation remains active outside the focused project.',
    })),
    ...assessmentOutside.map((c) => ({
      kind: 'component',
      id: c.componentId ?? c.id ?? c.label,
      projectId: c.projectId,
      projectName: model.projects.find((p) => p.id === c.projectId)?.name ?? c.projectId,
      label: c.label ?? c.componentId,
      status: c.coverage?.status ?? 'unknown',
      reason: c.coverage?.checks?.[0]?.reason ?? 'Affected downstream consumer outside focused project.',
    })),
  ];

  return {
    ...model,
    focusedProjectId: projectFilter,
    allProjects: model.projects,
    projects: model.projects.filter((p) => p.id === projectFilter),
    tasks: focusedTasks,
    contracts: model.contracts.filter((c) => c.projectId === projectFilter),
    targets: model.targets.filter((t) => t.projectId === projectFilter),
    alsoAffectedOutsideProject,
  };
}

/**
 * Normalizes any raw workspace model into the canonical shape required by the shared UI.
 */
export function normalizeWorkspaceModel(model = {}) {
  const workspace = model.workspace ?? { id: '', name: 'Workspace', mode: 'local' };
  const mode = workspace.mode === 'team' ? 'team' : 'local';
  const projects = Array.isArray(model.projects) ? model.projects : [];
  const tasks = Array.isArray(model.tasks) ? model.tasks : [];
  const contracts = Array.isArray(model.contracts) ? model.contracts : [];
  const targets = Array.isArray(model.targets) ? model.targets : [];
  const rawCapabilities = {
    knowledge: model.capabilities?.knowledge ?? 'Index a local project or synchronize Team knowledge to explore it.',
    contracts: model.capabilities?.contracts ?? 'Index local source or synchronize contracts to see the workspace K-Map.',
    verify: model.capabilities?.verify ?? 'Select an available local or authorized CI runner.',
    source: model.capabilities?.source ?? 'Select a project to inspect source.',
    agents: model.capabilities?.agents ?? 'Open a task to prepare bounded context.',
    settings: model.capabilities?.settings ?? 'Manage projects and access for this workspace.',
    ...model.capabilities,
  };
  const capabilities = Object.fromEntries(
    Object.entries(rawCapabilities).map(([k, v]) => [
      k,
      typeof v === 'object' && v !== null ? String(v.reason ?? v.permittedAction ?? '') : String(v ?? ''),
    ])
  );
  const capabilityDetails = Object.fromEntries(
    Object.keys(rawCapabilities).map((k) => [
      k,
      normalizeCapabilityDetail(k, model.capabilityDetails?.[k] ?? rawCapabilities[k], mode),
    ])
  );
  capabilityDetails.deploymentGate ??= normalizeCapabilityDetail(
    'deploymentGate',
    model.capabilityDetails?.deploymentGate ?? {
      availability: 'read_only',
      reasonCode: 'enforcement_unavailable',
      reason: 'Deployment gate not enforced — analytical preview only until a protected deployment controller is connected.',
      permittedAction: 'Preview compatibility',
      executionTarget: 'none',
      freshness: 'unknown',
      scope: 'deploymentGate',
    },
    mode
  );

  return {
    workspace: {
      id: workspace.id ?? '',
      name: workspace.name ?? 'Workspace',
      mode: workspace.mode === 'team' ? 'team' : 'local',
      organizationId: workspace.organizationId ?? workspace.organization_id ?? null,
      ...workspace,
    },
    projects: projects.map((project) => ({
      id: project.id ?? project.project_key ?? '',
      name: project.name ?? project.display_name ?? project.repository ?? project.id ?? 'Unnamed Project',
      kind: project.kind ?? (project.repository ? 'GitHub repository' : 'Local source'),
      detail: project.detail ?? project.remote_url ?? project.remote ?? 'Project source',
      repository: project.repository ?? null,
      remoteUrl: project.remoteUrl ?? project.remote_url ?? null,
      sources: Array.isArray(project.sources) ? project.sources : [],
      ...project,
    })),
    tasks: tasks.map((task) => {
      const projectIds = [
        ...new Set([
          task.projectId ?? task.project_key,
          ...(task.projectIds ?? []),
          ...(task.scope ?? []).map((s) => s.projectKey ?? s.projectId),
        ].filter(Boolean)),
      ];
      return {
        id: String(task.id ?? ''),
        externalId: task.externalId ?? task.external_id ?? task.id ?? '',
        title: String(task.title ?? ''),
        description: String(task.description ?? ''),
        status: String(task.status ?? 'open'),
        version: Number(task.version ?? 0),
        projectId: task.projectId ?? task.project_key ?? projectIds[0] ?? '',
        projectIds,
        projectName: task.projectName ?? (projectIds.length > 1 ? `${projectIds.length} projects` : 'Workspace'),
        scope: Array.isArray(task.scope) ? task.scope : projectIds.map((p) => ({ projectKey: p })),
        revisionSet: Array.isArray(task.revisionSet ?? task.revision_set) ? (task.revisionSet ?? task.revision_set) : [],
        ...task,
      };
    }),
    contracts: contracts.map((contract) => ({
      id: String(contract.id ?? ''),
      projectId: contract.projectId ?? contract.project_key ?? '',
      projectName: contract.projectName ?? contract.projectId ?? '',
      title: contract.title ?? `${contract.method ?? 'API'} ${contract.route ?? ''}`.trim(),
      method: contract.method ?? 'GET',
      route: contract.route ?? '',
      evidence: contract.evidence ?? 'Contract inventory',
      ...contract,
    })),
    targets: targets.map((target) => ({
      id: String(target.id ?? target.key ?? ''),
      projectId: target.projectId ?? target.project_key ?? '',
      projectName: target.projectName ?? target.projectId ?? '',
      label: target.label ?? target.name ?? target.route ?? target.id ?? 'Target',
      kind: target.kind ?? 'Source',
      source: target.source ?? target.file ?? 'Indexed knowledge',
      line: target.line ?? null,
      ...target,
    })),
    capabilities,
    capabilityDetails,
    focusedProjectId: model.focusedProjectId ?? null,
    alsoAffectedOutsideProject: Array.isArray(model.alsoAffectedOutsideProject) ? model.alsoAffectedOutsideProject : [],
    assessment: model.assessment ?? null,
    assessmentRefreshable: model.assessmentRefreshable ?? false,
    assessmentEntryTab: model.assessmentEntryTab ?? 'explore',
    releaseCompatibility: model.releaseCompatibility ?? null,
  };
}

/**
 * Base abstract WorkspaceProvider establishing the canonical interface for all surfaces.
 */
export class WorkspaceProvider {
  #generation = 0;

  get mode() {
    return 'base';
  }

  get currentGeneration() {
    return this.#generation;
  }

  advanceGeneration() {
    this.#generation += 1;
    return this.#generation;
  }

  async getWorkspaceProjection(_workspaceId, _options = {}) {
    fail('getWorkspaceProjection must be implemented by provider', 501);
  }

  async getTaskContext(_workspaceId, _taskId, _options = {}) {
    fail('getTaskContext must be implemented by provider', 501);
  }

  async mutateTask(_workspaceId, _operation) {
    fail('mutateTask must be implemented by provider', 501);
  }

  async appendTaskPayload(_workspaceId, _appendOperation) {
    fail('appendTaskPayload must be implemented by provider', 501);
  }

  async assessChange(_workspaceId, _changeTarget) {
    fail('assessChange must be implemented by provider', 501);
  }

  async inspectSource(_workspaceId, _sourceTarget) {
    fail('inspectSource must be implemented by provider', 501);
  }

  async reviewRelationship(_workspaceId, _reviewPayload) {
    fail('reviewRelationship must be implemented by provider', 501);
  }

  async assembleContext(_workspaceId, _taskId, _options = {}) {
    fail('assembleContext must be implemented by provider', 501);
  }

  async recordReceipt(_workspaceId, _receiptPayload) {
    fail('recordReceipt must be implemented by provider', 501);
  }

  async getReleaseCompatibility(_workspaceId, _options = {}) {
    fail('getReleaseCompatibility must be implemented by provider', 501);
  }
}

/**
 * LocalWorkspaceProvider communicates with the local AIPI Companion daemon or local memory state.
 */
export class LocalWorkspaceProvider extends WorkspaceProvider {
  #baseUrl;
  #fetchImpl;
  #localStateResolver;

  constructor({ baseUrl = 'http://127.0.0.1:62300', fetchImpl = globalThis.fetch, localStateResolver = null } = {}) {
    super();
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#fetchImpl = fetchImpl;
    this.#localStateResolver = localStateResolver;
  }

  get mode() {
    return 'local';
  }

  async #request(path, options = {}) {
    const url = `${this.#baseUrl}${path}`;
    const response = await this.#fetchImpl(url, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...options.headers,
      },
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      fail(data.error || `Local API returned HTTP ${response.status}`, response.status);
    }
    return data;
  }

  async getWorkspaceProjection(workspaceId, { projectFilter = '' } = {}) {
    const gen = this.currentGeneration;
    if (this.#localStateResolver) {
      const direct = await this.#localStateResolver(workspaceId);
      if (direct) {
        const model = normalizeWorkspaceModel(direct);
        return { ...applyWorkspaceProjectFilter(model, projectFilter), requestGeneration: gen };
      }
    }
    const data = await this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}`);
    const model = normalizeWorkspaceModel(data.workspaceModel ?? data);
    return { ...applyWorkspaceProjectFilter(model, projectFilter), requestGeneration: gen };
  }

  async getTaskContext(workspaceId, taskId, { limit = 50 } = {}) {
    return this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/context?limit=${limit}`);
  }

  async mutateTask(workspaceId, operation) {
    return this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`, {
      method: 'POST',
      body: JSON.stringify(operation),
    });
  }

  async appendTaskPayload(workspaceId, appendOperation) {
    return this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks/append`, {
      method: 'POST',
      body: JSON.stringify(appendOperation),
    });
  }

  async assessChange(workspaceId, changeTarget) {
    return this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}/change-assessment`, {
      method: 'POST',
      body: JSON.stringify(changeTarget),
    });
  }

  async inspectSource(workspaceId, sourceTarget) {
    return this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}/source`, {
      method: 'POST',
      body: JSON.stringify(sourceTarget),
    });
  }

  async reviewRelationship(workspaceId, reviewPayload) {
    return this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}/relationship-reviews`, {
      method: 'POST',
      body: JSON.stringify(reviewPayload),
    });
  }

  async assembleContext(workspaceId, taskId, options = {}) {
    return this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/context-pack`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async recordReceipt(workspaceId, receiptPayload) {
    return this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}/receipts`, {
      method: 'POST',
      body: JSON.stringify(receiptPayload),
    });
  }

  async getReleaseCompatibility(workspaceId, { projectId = '', environmentId = '' } = {}) {
    const query = new URLSearchParams({ ...(projectId ? { projectId } : {}), ...(environmentId ? { environmentId } : {}) });
    const suffix = query.size ? `?${query}` : '';
    return this.#request(`/api/workspaces/${encodeURIComponent(workspaceId)}/release-compatibility${suffix}`);
  }
}

/**
 * TeamWorkspaceProvider communicates with the AIPI Cloud Worker API and Supabase state.
 */
export class TeamWorkspaceProvider extends WorkspaceProvider {
  #baseUrl;
  #fetchImpl;
  #sessionGetter;
  #githubUserTokenGetter;
  #deviceIdGetter;

  /** @param {{baseUrl?: string, fetchImpl?: typeof fetch, sessionGetter: () => Promise<{access_token: string}|null>, githubUserTokenGetter?: (() => Promise<string|null>)|null, deviceIdGetter?: ((organizationId: string) => Promise<string>)|null}} options */
  constructor({
    baseUrl = 'https://mcp.aipi.website',
    fetchImpl = globalThis.fetch,
    sessionGetter,
    githubUserTokenGetter = null,
    deviceIdGetter = null,
  }) {
    super();
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#fetchImpl = fetchImpl;
    this.#sessionGetter = sessionGetter;
    this.#githubUserTokenGetter = githubUserTokenGetter;
    this.#deviceIdGetter = deviceIdGetter;
  }

  get mode() {
    return 'team';
  }

  async indexSourceFacts(workspaceId, sourceBindingId, {revision, path, kind = 'openapi'} = {}) {
    const githubUserToken = this.#githubUserTokenGetter ? await this.#githubUserTokenGetter() : null;
    if (!githubUserToken) fail('Connect your GitHub account to index this source', 403);
    return this.#request(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceBindingId)}/facts/index`,
      {method:'POST',body:{githubUserToken,revision,path,kind}});
  }

  async getSourceFacts(workspaceId, sourceBindingId, revision) {
    const githubUserToken = this.#githubUserTokenGetter ? await this.#githubUserTokenGetter() : null;
    if (!githubUserToken) fail('Connect your GitHub account to read this source', 403);
    return this.#request(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceBindingId)}/facts/list`,
      {method:'POST',body:{githubUserToken,revision}});
  }

  async discoverSourceConsumers(workspaceId, sourceBindingId, {revision,path} = {}) {
    const githubUserToken = this.#githubUserTokenGetter ? await this.#githubUserTokenGetter() : null;
    if (!githubUserToken) fail('Connect your GitHub account to inspect source consumers', 403);
    return this.#request(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceBindingId)}/facts/discover`,
      {method:'POST',body:{githubUserToken,revision,path}});
  }

  async getReleaseCompatibility(workspaceId, { projectId = '', environmentId = '' } = {}) {
    const query = new URLSearchParams({ ...(projectId ? { projectId } : {}), ...(environmentId ? { environmentId } : {}) });
    const suffix = query.size ? `?${query}` : '';
    const result = await this.#request(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/release-compatibility${suffix}`);
    return result.releaseCompatibility;
  }

  async #request(path, { method = 'GET', body, githubUserToken = null } = {}) {
    const session = await this.#sessionGetter();
    if (!session?.access_token) {
      fail('Sign in to Team Cloud first', 401);
    }

    const ghToken = githubUserToken ?? (this.#githubUserTokenGetter ? await this.#githubUserTokenGetter() : null);

    const headers = {
      authorization: `Bearer ${session.access_token}`,
      ...(ghToken ? { 'x-aipi-github-user-token': ghToken } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    };

    const response = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      fail(data.error || `Team API returned HTTP ${response.status}`, response.status);
    }
    return data;
  }

  async #resolveDeviceId(organizationId) {
    if (this.#deviceIdGetter) {
      return this.#deviceIdGetter(organizationId);
    }
    return 'web-client';
  }

  async getWorkspaceProjection(workspaceId, { projectFilter = '' } = {}) {
    const [tasksRes, projectsRes, graphRes, subscriptionRes, identityRes] = await Promise.all([
      this.#request(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/tasks`),
      this.#request(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/projects`),
      this.#request(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/graph`).catch((err) => ({
        nodes: [],
        edges: [],
        capabilityError: err.message,
      })),
      this.#request(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/subscription`).catch(() => ({
        subscription: null,
      })),
      this.#request(`/api/team/workspaces/${encodeURIComponent(workspaceId)}/identity`).catch(() => ({
        identity: { projects: [] },
      })),
    ]);

    const identityProjects = identityRes.identity?.projects ?? [];
    const projects = (projectsRes.projects ?? []).map((project) => ({
      id: project.project_key,
      name: project.display_name || project.repository || project.project_key,
      kind: project.repository ? 'GitHub repository' : 'Local source',
      detail: project.remote_url || 'Source requires a shared snapshot or online companion',
      repository: project.repository ?? null,
      remoteUrl: project.remote_url ?? null,
      sources: identityProjects.find((item) => item.id === project.project_key)?.sources ?? [],
    }));

    const graphNodes = graphRes.nodes ?? [];
    const graphEdges = graphRes.edges ?? [];

    const rawModel = {
      workspace: {
        id: workspaceId,
        name: 'Team Workspace',
        mode: 'team',
      },
      projects,
      tasks: (tasksRes.tasks ?? []).map((task) => ({
        id: task.id,
        externalId: task.external_id ?? task.id,
        title: task.title,
        description: task.description ?? '',
        status: task.status ?? 'open',
        version: task.version ?? 0,
        projectId: task.project_key ?? '',
        scope: task.scope ?? [],
        revisionSet: task.revision_set ?? [],
      })),
      contracts: graphNodes
        .filter((n) => n.kind === 'contract' || n.kind === 'route')
        .map((node) => ({
          id: node.id,
          projectId: node.project_key,
          projectName: projects.find((p) => p.id === node.project_key)?.name ?? node.project_key,
          title: node.label,
          evidence: `Graph node · ${node.revision_commit?.slice(0, 12) ?? 'unpinned'} · ${
            graphEdges.filter((e) => e.from_node_id === node.id || e.to_node_id === node.id).length
          } dependencies`,
        })),
      targets: graphNodes.map((node) => ({
        id: node.id,
        projectId: node.project_key,
        projectName: projects.find((p) => p.id === node.project_key)?.name ?? node.project_key,
        label: node.label,
        kind: node.kind,
        source: node.source_ref ?? `Commit ${node.revision_commit?.slice(0, 12) ?? ''}`,
      })),
      capabilities: {
        knowledge: graphRes.capabilityError ?? 'No readable graph knowledge is available. Connect GitHub App.',
        contracts: 'No readable contract or route nodes are available for this workspace.',
        verify: 'Cloud runner is unavailable. Verify from an authorized local companion.',
        source: 'Inspect GitHub source at a pinned commit after connecting your GitHub App user account.',
        agents: 'Task handoff is available in the IDE; cloud agent runs are pending.',
        settings: 'Manage workspace resources and access in Team settings.',
      },
    };

    const gen = this.currentGeneration;
    const model = normalizeWorkspaceModel(rawModel);
    return { ...applyWorkspaceProjectFilter(model, projectFilter), requestGeneration: gen };
  }

  /** @param {string} _workspaceId @param {string} taskId @param {{limit?: number, organizationId?: string}} options */
  async getTaskContext(_workspaceId, taskId, { limit = 25, organizationId } = {}) {
    if (!organizationId) {
      fail('Organization ID is required for Team task context', 400);
    }
    return this.#request(`/api/team/organizations/${encodeURIComponent(organizationId)}/tasks/${encodeURIComponent(taskId)}/context?limit=${limit}`);
  }

  /** @param {string} workspaceId @param {{organizationId: string, externalId: string, projectKey?: string, patch: Record<string, unknown>, baseVersion?: number, operationId?: string|null}} operation */
  async mutateTask(workspaceId, { organizationId, externalId, projectKey, patch, baseVersion = 0, operationId = null }) {
    if (!organizationId) {
      fail('Organization ID is required for Team task mutations', 400);
    }
    const deviceId = await this.#resolveDeviceId(organizationId);
    const opId = operationId ?? crypto.randomUUID();
    return this.#request(
      `/api/team/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/operations/task`,
      {
        method: 'POST',
        body: {
          schemaVersion: 1,
          operationId: opId,
          deviceId,
          externalId,
          ...(projectKey ? { projectKey } : {}),
          patch,
          baseVersion,
        },
      }
    );
  }

  /** @param {string} workspaceId @param {{organizationId: string, entityType: string, taskId: string, payload: Record<string, unknown>, operationId?: string|null}} operation */
  async appendTaskPayload(workspaceId, { organizationId, entityType, taskId, payload, operationId = null }) {
    if (!organizationId) {
      fail('Organization ID is required for Team append operations', 400);
    }
    const deviceId = await this.#resolveDeviceId(organizationId);
    const opId = operationId ?? crypto.randomUUID();
    return this.#request(
      `/api/team/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/operations/append`,
      {
        method: 'POST',
        body: {
          schemaVersion: 1,
          operationId: opId,
          deviceId,
          payload: {
            entityType,
            taskId,
            ...payload,
          },
        },
      }
    );
  }

  async assessChange(_workspaceId, { prId }) {
    if (!prId) fail('prId is required for Team PR change assessment', 400);
    return this.#request(`/api/team/pull-requests/${encodeURIComponent(prId)}/assess`, {
      method: 'POST',
    });
  }

  async inspectSource(workspaceId, { projectId, commit, path, sourceBindingId }) {
    return this.#request(
      `/api/team/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/source`,
      {
        method: 'POST',
        body: {
          commit,
          path,
          ...(sourceBindingId ? { sourceBindingId } : {}),
        },
      }
    );
  }

  async reviewRelationship(workspaceId, reviewPayload) {
    return this.#request(
      `/api/team/workspaces/${encodeURIComponent(workspaceId)}/relationship-reviews`,
      {
        method: 'POST',
        body: reviewPayload,
      }
    );
  }

  async assembleContext(workspaceId, taskId, options = {}) {
    return this.#request(
      `/api/team/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/context-pack`,
      {
        method: 'POST',
        body: options,
      }
    );
  }

  async recordReceipt(workspaceId, receiptPayload) {
    return this.#request(
      `/api/team/workspaces/${encodeURIComponent(workspaceId)}/receipts`,
      {
        method: 'POST',
        body: receiptPayload,
      }
    );
  }
}
