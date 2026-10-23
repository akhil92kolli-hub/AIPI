import assert from 'node:assert/strict';
import {
  WorkspaceProvider,
  LocalWorkspaceProvider,
  TeamWorkspaceProvider,
  normalizeWorkspaceModel,
  formatWorkspaceObjectLink,
  parseWorkspaceObjectLink,
} from '../packages/core/workspace-provider.mjs';

// 1. Model normalization tests
{
  const emptyModel = normalizeWorkspaceModel();
  assert.equal(emptyModel.workspace.mode, 'local');
  assert.equal(emptyModel.workspace.name, 'Workspace');
  assert.deepEqual(emptyModel.projects, []);
  assert.deepEqual(emptyModel.tasks, []);
  assert.deepEqual(emptyModel.contracts, []);
  assert.deepEqual(emptyModel.targets, []);
  assert.ok(emptyModel.capabilities.knowledge);

  const raw = {
    workspace: { id: 'wsg_123', name: 'Storefront & Orders', mode: 'team' },
    projects: [
      { project_key: 'prj_storefront', display_name: 'Storefront', repository: 'acme/storefront' },
      { project_key: 'prj_orders', display_name: 'Orders', repository: 'acme/orders' },
    ],
    tasks: [
      {
        id: 'task_checkout',
        external_id: 'task_ext_checkout',
        title: 'Checkout API verification',
        status: 'in_progress',
        version: 3,
        project_key: 'prj_orders',
        scope: [{ projectKey: 'prj_orders' }, { projectKey: 'prj_storefront' }],
      },
    ],
    contracts: [
      {
        id: 'cnt_checkout',
        project_key: 'prj_orders',
        method: 'POST',
        route: '/checkout',
        evidence: 'AST route detection',
      },
    ],
    targets: [
      {
        id: 'tgt_checkout_form',
        project_key: 'prj_storefront',
        label: 'CheckoutForm.tsx',
        kind: 'caller',
        source: 'src/components/CheckoutForm.tsx',
      },
    ],
  };

  const normalized = normalizeWorkspaceModel(raw);
  assert.equal(normalized.workspace.mode, 'team');
  assert.equal(normalized.projects.length, 2);
  assert.equal(normalized.projects[0].id, 'prj_storefront');
  assert.equal(normalized.projects[0].kind, 'GitHub repository');

  assert.equal(normalized.tasks.length, 1);
  const task = normalized.tasks[0];
  assert.equal(task.id, 'task_checkout');
  assert.equal(task.externalId, 'task_ext_checkout');
  assert.deepEqual(task.projectIds.sort(), ['prj_orders', 'prj_storefront'].sort());
  assert.equal(task.projectName, '2 projects');

  assert.equal(normalized.contracts.length, 1);
  assert.equal(normalized.contracts[0].method, 'POST');
  assert.equal(normalized.contracts[0].title, 'POST /checkout');

  assert.equal(normalized.targets.length, 1);
  assert.equal(normalized.targets[0].label, 'CheckoutForm.tsx');
}

// 2. Base WorkspaceProvider contract tests
{
  const base = new WorkspaceProvider();
  assert.equal(base.mode, 'base');
  await assert.rejects(async () => base.getWorkspaceProjection('wsg_test'), /implemented by provider/);
  await assert.rejects(async () => base.getTaskContext('wsg_test', 'task_1'), /implemented by provider/);
  await assert.rejects(async () => base.mutateTask('wsg_test', {}), /implemented by provider/);
  await assert.rejects(async () => base.getReleaseCompatibility('wsg_test'), /implemented by provider/);
}

// 3. LocalWorkspaceProvider tests
{
  const mockCalls = [];
  const mockFetch = async (url, options = {}) => {
    mockCalls.push({ url, options });
    if (url.includes('/tasks/task_1/context?') || url.endsWith('/tasks/task_1/context')) {
      return {
        ok: true,
        json: async () => ({
          task: { id: 'task_1', title: 'Task 1' },
          decisions: [],
          evidence: [],
          receipts: [],
          comments: [{ id: 'cmt_1', body: 'Ready for review' }],
        }),
      };
    }
    if (url.includes('/change-assessment')) {
      return {
        ok: true,
        json: async () => ({
          assessment: { evaluatedAt: '2026-10-23T00:00:00Z', verification: { status: 'passed' } },
        }),
      };
    }
    if (url.includes('/release-compatibility')) {
      return { ok: true, json: async () => ({ releaseCompatibility: { previewReady: false, canDeploy: false } }) };
    }
    if (url.endsWith('/api/workspaces/wsg_local_1') || url.includes('/api/workspaces/wsg_local_1?')) {
      return {
        ok: true,
        json: async () => ({
          workspace: { id: 'wsg_local_1', name: 'Local Dev', mode: 'local' },
          projects: [
            { id: 'prj_1', name: 'Repo 1', kind: 'Local source' },
            { id: 'prj_2', name: 'Repo 2', kind: 'Local source' },
          ],
          tasks: [
            { id: 'task_1', projectId: 'prj_1', title: 'Task 1', status: 'open' },
            { id: 'task_2', projectId: 'prj_2', title: 'Task 2', status: 'in_review' },
            { id: 'task_cross', projectId: 'prj_1', projectIds: ['prj_1', 'prj_2'], title: 'Cross', status: 'open' },
          ],
          contracts: [{ id: 'cnt_1', projectId: 'prj_1', method: 'GET', route: '/users' }],
          targets: [{ id: 'tgt_1', projectId: 'prj_1', label: 'users.ts' }],
        }),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const local = new LocalWorkspaceProvider({ baseUrl: 'http://127.0.0.1:62300', fetchImpl: mockFetch });
  assert.equal(local.mode, 'local');

  // Full projection
  const full = await local.getWorkspaceProjection('wsg_local_1');
  assert.equal(full.projects.length, 2);
  assert.equal(full.tasks.length, 3);

  // Filtered projection
  const filteredPrj1 = await local.getWorkspaceProjection('wsg_local_1', { projectFilter: 'prj_1' });
  assert.equal(filteredPrj1.projects.length, 1);
  assert.equal(filteredPrj1.projects[0].id, 'prj_1');
  // Includes task_1 and task_cross, excludes task_2
  assert.equal(filteredPrj1.tasks.length, 2);
  assert.ok(filteredPrj1.tasks.some((t) => t.id === 'task_1'));
  assert.ok(filteredPrj1.tasks.some((t) => t.id === 'task_cross'));
  assert.ok(!filteredPrj1.tasks.some((t) => t.id === 'task_2'));

  // Task context
  const context = await local.getTaskContext('wsg_local_1', 'task_1');
  assert.equal(context.task.id, 'task_1');
  assert.equal(context.comments.length, 1);

  // Change assessment
  const assessment = await local.assessChange('wsg_local_1', { mode: 'working' });
  assert.equal(assessment.assessment.verification.status, 'passed');
  const localRelease = await local.getReleaseCompatibility('wsg_local_1', { projectId: 'prj_1' });
  assert.equal(localRelease.releaseCompatibility.canDeploy, false);
  assert.ok(mockCalls.some(call => call.url.endsWith('/release-compatibility?projectId=prj_1')));

  // Task mutation & payload append
  const mutated = await local.mutateTask('wsg_local_1', { taskId: 'task_1', status: 'in_review' });
  assert.ok(mutated.ok);
  const appended = await local.appendTaskPayload('wsg_local_1', { taskId: 'task_1', type: 'comment', body: 'Looks good' });
  assert.ok(appended.ok);

  // Relationship review
  const reviewed = await local.reviewRelationship('wsg_local_1', { fromKey: 'tgt_1', toKey: 'tgt_2', type: 'CALLS', status: 'approved' });
  assert.ok(reviewed.ok);

  // Context assembly
  const assembled = await local.assembleContext('wsg_local_1', 'task_1', { tokenBudget: 2400 });
  assert.ok(assembled.ok);

  // Receipt recording
  const receipt = await local.recordReceipt('wsg_local_1', { taskId: 'task_1', status: 'passed' });
  assert.ok(receipt.ok);

  // Direct state resolver bypass
  const directResolver = new LocalWorkspaceProvider({
    localStateResolver: async (id) => ({
      workspace: { id, name: 'Direct in-memory', mode: 'local' },
      projects: [{ id: 'prj_mem', name: 'Memory' }],
    }),
  });
  const direct = await directResolver.getWorkspaceProjection('wsg_mem');
  assert.equal(direct.workspace.name, 'Direct in-memory');
  assert.equal(direct.projects[0].id, 'prj_mem');
}

// 4. TeamWorkspaceProvider tests
{
  const mockCalls = [];
  const mockFetch = async (url, options = {}) => {
    mockCalls.push({ url, options });
    if (url.includes('/api/team/workspaces/wsg_cloud/tasks')) {
      return {
        ok: true,
        json: async () => ({
          tasks: [
            {
              id: 'task_team_1',
              external_id: 'ext_1',
              title: 'Team Task',
              status: 'open',
              version: 1,
              project_key: 'prj_api',
              scope: [{ projectKey: 'prj_api' }],
            },
          ],
        }),
      };
    }
    if (url.includes('/api/team/workspaces/wsg_cloud/projects')) {
      return {
        ok: true,
        json: async () => ({
          projects: [
            { project_key: 'prj_api', display_name: 'API Service', repository: 'team/api' },
          ],
        }),
      };
    }
    if (url.includes('/api/team/workspaces/wsg_cloud/graph')) {
      return {
        ok: true,
        json: async () => ({
          nodes: [
            { id: 'node_1', project_key: 'prj_api', kind: 'contract', label: 'GET /status', revision_commit: 'abcdef123456' },
          ],
          edges: [],
        }),
      };
    }
    if (url.includes('/api/team/workspaces/wsg_cloud/release-compatibility')) {
      return { ok: true, json: async () => ({ releaseCompatibility: { canDeploy: false,
        pairs: [{ status: 'unknown' }], enforcement: { state: 'unavailable' } } }) };
    }
    if (url.includes('/sources/src_orders123/facts/')) {
      assert.equal(options.method,'POST');
      assert.equal(JSON.parse(options.body).githubUserToken,'ghu_mock_token');
      return {ok:true,json:async()=>url.endsWith('/facts/list')?{partitions:[]}:{partition:{factHash:'abc'}}};
    }
    if (url.includes('/operations/task')) {
      const body = JSON.parse(options.body);
      assert.equal(body.schemaVersion, 1);
      assert.ok(body.operationId);
      assert.equal(body.deviceId, 'device_test_123');
      assert.equal(body.externalId, 'ext_1');
      assert.deepEqual(body.patch, { status: 'in_progress' });
      return {
        ok: true,
        json: async () => ({
          accepted: { task_id: 'task_team_1', change_sequence: 42 },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const team = new TeamWorkspaceProvider({
    baseUrl: 'https://mcp.aipi.website',
    fetchImpl: mockFetch,
    sessionGetter: async () => ({ access_token: 'valid_mock_jwt_token' }),
    githubUserTokenGetter: async () => 'ghu_mock_token',
    deviceIdGetter: async () => 'device_test_123',
  });

  assert.equal(team.mode, 'team');

  // Projection
  const teamProj = await team.getWorkspaceProjection('wsg_cloud');
  assert.equal(teamProj.workspace.mode, 'team');
  assert.equal(teamProj.projects[0].name, 'API Service');
  assert.equal(teamProj.tasks[0].title, 'Team Task');
  assert.equal(teamProj.contracts[0].title, 'GET /status');
  const teamRelease = await team.getReleaseCompatibility('wsg_cloud', { projectId: 'prj_api' });
  assert.equal(teamRelease.canDeploy, false);
  assert.equal(teamRelease.pairs[0].status, 'unknown');
  assert.ok(mockCalls.some(call => call.url.endsWith('/release-compatibility?projectId=prj_api')));
  assert.deepEqual((await team.getSourceFacts('wsg_cloud','src_orders123','a'.repeat(40))).partitions,[]);
  assert.equal((await team.indexSourceFacts('wsg_cloud','src_orders123',
    {revision:'a'.repeat(40),path:'openapi.json'})).partition.factHash,'abc');

  // Mutation
  const opResult = await team.mutateTask('wsg_cloud', {
    organizationId: 'org_123',
    externalId: 'ext_1',
    projectKey: 'prj_api',
    patch: { status: 'in_progress' },
    baseVersion: 1,
  });
  assert.equal(opResult.accepted.change_sequence, 42);

  // Unauthenticated rejection
  const unauthTeam = new TeamWorkspaceProvider({
    sessionGetter: async () => null,
  });
  await assert.rejects(async () => unauthTeam.getWorkspaceProjection('wsg_cloud'), /Sign in to Team Cloud first/);

  // Missing org rejection on mutation
  await assert.rejects(
    async () => team.mutateTask('wsg_cloud', { externalId: 'ext_1', patch: {} }),
    /Organization ID is required/
  );
}

// 5. Object link contract, structured capability details, and outside-project impact preservation
{
  const cloudLink = formatWorkspaceObjectLink({
    surface: 'cloud',
    workspaceId: '550e8400-e29b-41d4-a716-446655440000',
    view: 'explore',
    assessmentId: 'ass_123',
    generation: 4,
  });
  assert.equal(cloudLink, '/workspace/550e8400-e29b-41d4-a716-446655440000?view=explore&assessment=ass_123&generation=4');
  const parsedCloud = parseWorkspaceObjectLink(cloudLink);
  assert.equal(parsedCloud.surface, 'cloud');
  assert.equal(parsedCloud.workspaceId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(parsedCloud.view, 'explore');
  assert.equal(parsedCloud.assessmentId, 'ass_123');
  assert.equal(parsedCloud.generation, 4);

  const localLink = formatWorkspaceObjectLink({
    surface: 'local',
    workspaceId: 'wsg_commerce',
    view: 'tasks',
    taskId: 'task_99',
    section: 'checks',
  });
  assert.equal(localLink, '/workspaces/wsg_commerce?view=tasks&task=task_99&section=checks');
  const parsedLocal = parseWorkspaceObjectLink(localLink);
  assert.equal(parsedLocal.surface, 'local');
  assert.equal(parsedLocal.taskId, 'task_99');
  assert.equal(parsedLocal.section, 'checks');

  const ideMsg = formatWorkspaceObjectLink({
    surface: 'ide',
    workspaceId: 'wsg_commerce',
    view: 'kmaps',
    releaseId: 'rel_1',
    environment: 'production',
  });
  assert.equal(ideMsg.channel, 'aipi.ide.v1');
  assert.equal(ideMsg.type, 'openObject');
  const parsedIde = parseWorkspaceObjectLink(ideMsg);
  assert.equal(parsedIde.surface, 'ide');
  assert.equal(parsedIde.releaseId, 'rel_1');
  assert.equal(parsedIde.environment, 'production');

  const provider = new LocalWorkspaceProvider({
    localStateResolver: async (id) => ({
      workspace: { id, name: 'Commerce', mode: 'local' },
      projects: [
        { id: 'prj_orders', name: 'Orders' },
        { id: 'prj_storefront', name: 'Storefront' },
      ],
      tasks: [
        { id: 'task_storefront_repair', projectId: 'prj_storefront', originProjectId: 'prj_orders', title: 'Update CheckoutForm', status: 'proposed' },
      ],
      assessment: {
        changeId: 'chg_1',
        components: [
          { projectId: 'prj_storefront', componentId: 'CheckoutForm', label: 'CheckoutForm.tsx', coverage: { status: 'stale' } },
        ],
      },
    }),
  });
  provider.advanceGeneration();
  const filtered = await provider.getWorkspaceProjection('wsg_commerce', { projectFilter: 'prj_orders' });
  assert.equal(filtered.focusedProjectId, 'prj_orders');
  assert.equal(filtered.requestGeneration, 1);
  assert.ok(filtered.capabilityDetails.deploymentGate);
  assert.equal(filtered.capabilityDetails.deploymentGate.reasonCode, 'enforcement_unavailable');
  assert.equal(filtered.alsoAffectedOutsideProject.length, 2, 'Cross-project affected tasks and components remain visible when focused on Orders');
}

console.log('WorkspaceProvider contract, LocalWorkspaceProvider, and TeamWorkspaceProvider passed all assertions');
