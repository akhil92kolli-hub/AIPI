import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { workspaceTargets, reviewWorkspaceRelationship } from '../../packages/core/workspace-groups.mjs';

const run = promisify(execFile);
export async function assessmentFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-assessment-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const projects = [];
  for (const id of ['orders', 'storefront', 'billing']) {
    const root = path.join(temp, id); await fs.mkdir(root);
    const git = async (...args) => (await run('git', ['-C', root, ...args])).stdout.trim();
    await git('init', '-q'); await git('config', 'user.name', 'AIPI fixture'); await git('config', 'user.email', 'fixture@example.test');
    await git('config', 'commit.gpgsign', 'false');
    const source = id === 'storefront' ? 'Checkout.tsx' : 'app.py';
    await fs.writeFile(path.join(root, source), id === 'storefront' ? 'export const total = 100;\n' : 'total = 100\n');
    await fs.writeFile(path.join(root, '.gitignore'), '.aipi/\n');
    await git('add', '.'); await git('commit', '-qm', 'baseline');
    const revision = await git('rev-parse', 'HEAD');
    projects.push({ id, name: id, activeEnvironmentId: 'dev', environments: [{ id: 'dev', variables: [] }],
      sourceContext: { roots: [{ id: `${id}-source`, kind: 'workspace', path: root }], gitRevision: revision,
        endpoints: id === 'orders' ? [{ id: 'shared-endpoint-id', method: 'GET', path: '/orders', root, source, line: 1 }] : [],
        frontendCalls: id !== 'orders' ? [{ id: 'shared-caller-id', method: 'GET', path: '/orders', root, source, line: 1 }] : [],
        artifacts: [], schemas: [], integrations: [] },
      contracts: id === 'orders' ? [{ id: 'orders-contract', method: 'GET', route: '/orders', currentRevisionId: 'v1',
        sourceArtifactIds: ['shared-endpoint-id'], implementation: { root, source, line: 1 } }] : [], requests: [], tasks: [] });
  }
  const state = { projects, workspaceGroups: [{ id: 'wsg_assessment123', name: 'Commerce', version: 1, projectIds: projects.map(p => p.id) }] };
  const catalog = workspaceTargets(state, 'wsg_assessment123');
  const api = catalog.find(item => item.ref.projectId === 'orders' && item.kind === 'api');
  for (const id of ['storefront', 'billing']) {
    const caller = catalog.find(item => item.ref.projectId === id && item.kind === 'consumer');
    reviewWorkspaceRelationship(state, 'wsg_assessment123', { fromKey: caller.key, toKey: api.key, type: 'CALLS', status: 'approved',
      evidence: 'Explicit fixture call site and provider review.', reviewer: 'Fixture reviewer' });
  }
  return { state, temp, root: projects[0].sourceContext.roots[0].path,
    input: { state, workspaceId: 'wsg_assessment123', projectId: 'orders', baseRef: projects[0].sourceContext.gitRevision,
      canReadProject: () => true, evaluatedAt: '2026-10-21T15:00:00Z' } };
}

