import { analyzeTeamImpact } from './team-impact.mjs';
import { buildVerificationCoverageLedger } from './verification-coverage.mjs';

function sourcePath(value) {
  const source = String(value ?? '').replace(/#L\d+(?:-L\d+)?$/, '').replace(/:\d+(?::\d+)?$/, '');
  return source.replace(/^\.\//, '');
}

// Authorization is checked by the caller against the current repository grants.
// Prune before traversal so a path through an inaccessible project cannot leak
// node names, source references, owners, or inferred relationships.
export function scopeTeamAssessmentGraph({ nodes, edges, readableProjects }) {
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !(readableProjects instanceof Set))
    throw new TypeError('A bounded graph and current readable project set are required');
  const scopedNodes = nodes.filter((node) => readableProjects.has(node.project_key));
  const ids = new Set(scopedNodes.map((node) => node.id));
  return { nodes: scopedNodes, edges: edges.filter((edge) => ids.has(edge.from_node_id) && ids.has(edge.to_node_id)),
    restrictedScope: scopedNodes.length !== nodes.length };
}

export function assessTeamChangedFiles({ files, nodes, edges, projectKey, baseSha, headSha, revisionSet,
  repositoryRoot = '.', truncated = false, workspaceId = 'team-workspace', changeId = `${projectKey}:${headSha}`,
  restrictedScope = false }) {
  if (!Array.isArray(files) || files.length > 300 || !Array.isArray(nodes) || !Array.isArray(edges) ||
      !/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha))
    throw new Error('A bounded immutable comparison and graph are required');
  const root = repositoryRoot === '.' ? '' : `${repositoryRoot.replace(/\/$/, '')}/`;
  const scoped = nodes.filter((node) => node.project_key === projectKey);
  const changed = [];
  const unmapped = [];
  const uninspectable = [];
  const renamed = [];
  const deleted = [];
  const generated = [];
  for (const file of files) {
    const name = String(file.filename ?? '');
    const status = String(file.status ?? 'modified');
    const previous = status === 'renamed' ? String(file.previous_filename ?? '') : '';
    const candidates = status === 'renamed' ? [previous,name] : [name];
    for (const candidate of new Set(candidates)) {
      if (!candidate || !candidate.startsWith(root)) continue;
      const relative = candidate.slice(root.length);
      if (!relative || relative.split('/').some(part => part === '.' || part === '..')) continue;
      if (!file.patch) uninspectable.push(relative);
      if (status === 'renamed') renamed.push(relative);
      if (status === 'removed') deleted.push(relative);
      if (/(?:^|\/)(?:dist|build|generated|node_modules)\//i.test(relative) || /(?:\.generated\.|\.g\.)[^/]+$/i.test(relative))
        generated.push(relative);
      const matches = scoped.filter((node) => sourcePath(node.source_ref) === relative);
      if (!matches.length) unmapped.push({ path: relative, reason: file.patch ? 'No graph node matches this file' : 'No text patch or graph node is available' });
      for (const node of matches) changed.push({ projectKey, nodeKey: node.node_key, kind: node.kind,
        label: node.label, path: relative, mapping: 'file_candidate', fileStatus: status,
        evidenceStrength: relative.endsWith('.py') ? 'pattern_or_declared' : 'indexed_source',
        sourceRevision: node.revision_commit, proposedRevision: headSha });
    }
  }
  const unique = [...new Map(changed.map((item) => [`${item.projectKey}:${item.nodeKey}`, item])).values()];
  const proposed = [...revisionSet.filter((entry) => entry.projectKey !== projectKey), { projectKey, commit: headSha }];
  const impacts = unique.map((node) => ({ node, report: analyzeTeamImpact({ nodes, edges,
    changedProjectKey: projectKey, changedNodeKey: node.nodeKey, revisionSet: proposed }) }));
  const requiredChecks = [...new Set(impacts.flatMap(({report}) => report.affected.flatMap((entry) => entry.requiredChecks)))].sort();
  const candidates = new Map();
  const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
  for (const node of unique) candidates.set(`${node.projectKey}:${node.nodeKey}`, {
    projectId: node.projectKey, componentId: node.nodeKey, confidence: 'candidate', owner: scoped.find((entry) => entry.node_key === node.nodeKey)?.owner_id ?? null,
    requirements: [], requiresBehavior: true });
  for (const { report } of impacts) for (const affected of report.affected) {
    for (const path of affected.paths) {
      const identity = `${affected.projectKey}:${path.targetNodeKey}`;
      const target = nodes.find((entry) => entry.project_key === affected.projectKey && entry.node_key === path.targetNodeKey);
      const component = candidates.get(identity) ?? { projectId: affected.projectKey, componentId: path.targetNodeKey,
        confidence: 'candidate', owner: target?.owner_id ?? null, requirements: [], requiresBehavior: true };
      const pathChecks = path.edgeIds.flatMap((id) => edgesById.get(id)?.required_checks ?? []);
      for (const check of pathChecks) if (typeof check === 'string' && !component.requirements.some((entry) => entry.id === check))
        component.requirements.push({ id: check, kind: 'behavior', required: true, configured: true });
      candidates.set(identity, component);
    }
  }
  const components = [...candidates.values()];
  const ownerCoverage = components.map(({ projectId, componentId, owner }) => ({ projectId, componentId,
    status: owner ? 'identified' : 'missing', ownerId: owner }));
  const ledger = buildVerificationCoverageLedger({ workspaceId, changeId, evaluatedAt: new Date().toISOString(),
    components, receipts: [], canReadProject: () => true, acceptReceipt: () => false,
    analysis: { complete: false, gaps: [restrictedScope ? 'restricted-project' : 'candidate-dependency-discovery'] } });
  if (restrictedScope) ledger.limitations.push('Some project relationships were omitted because current repository access could not be verified.');
  return { status: truncated || files.length === 300 || unmapped.length || uninspectable.length ||
      renamed.length || deleted.length || generated.length || !unique.length ? 'incomplete' : 'candidates',
    comparison: { baseSha, headSha, projectKey }, changedNodes: unique, impacts, requiredChecks,
    ledger, ownerCoverage,
    coverage: { comparedFiles: files.length, mappedNodes: unique.length, unmappedFiles: unmapped, uninspectableFiles: uninspectable,
      renamedFiles: [...new Set(renamed)], deletedFiles: [...new Set(deleted)], generatedFiles: [...new Set(generated)],
      truncated: Boolean(truncated || files.length === 300), restrictedScope,
      meaning: 'File matches identify candidates; contract semantics, independent consumer coverage and checks remain unproven.' } };
}
