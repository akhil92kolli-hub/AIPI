const kinds = new Set(['declared', 'static', 'runtime', 'ai_suggestion']);
const active = (edge) => edge.confirmation_state !== 'rejected';
const refs = (value) => Array.isArray(value) ? value : [];

export function analyzeTeamImpact({ nodes, edges, changedProjectKey, changedNodeKey, revisionSet, maxDepth = 5 }) {
  if (!Array.isArray(nodes) || nodes.length > 500 || !Array.isArray(edges) || edges.length > 1000)
    throw new Error('Impact graph exceeds the bounded analysis size');
  if (!Array.isArray(revisionSet) || revisionSet.length > 32 || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8)
    throw new Error('A bounded revision set and depth are required');
  const revisions = new Map(revisionSet.map((entry) => [entry.projectKey, entry.commit]));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const changed = nodes.find((node) => node.project_key === changedProjectKey && node.node_key === changedNodeKey);
  if (!changed) return { status: 'unverified', reason: 'Changed node is absent from the shared graph', affected: [], suggestions: [], revisionSet };
  const adjacency = new Map();
  for (const edge of edges) {
    if (!active(edge) || !kinds.has(edge.evidence_kind) || !byId.has(edge.from_node_id) || !byId.has(edge.to_node_id)) continue;
    const list = adjacency.get(edge.from_node_id) ?? [];
    list.push(edge); adjacency.set(edge.from_node_id, list);
  }
  const affected = new Map();
  const suggestions = [];
  const queue = [{ nodeId: changed.id, path: [], seen: new Set([changed.id]) }];
  for (let cursor = 0; cursor < queue.length && cursor < 1000; cursor += 1) {
    const item = queue[cursor];
    if (item.path.length >= maxDepth) continue;
    for (const edge of adjacency.get(item.nodeId) ?? []) {
      const target = byId.get(edge.to_node_id);
      if (item.seen.has(target.id)) continue;
      const stale = refs(edge.revision_set).some((pin) => revisions.get(pin.projectKey) !== pin.commit);
      const step = { edgeId: edge.id, evidenceKind: edge.evidence_kind, confirmationState: edge.confirmation_state,
        stale, sourceRefs: refs(edge.source_refs), requiredChecks: refs(edge.required_checks) };
      const path = [...item.path, step];
      if (edge.evidence_kind === 'ai_suggestion' && edge.confirmation_state !== 'confirmed') {
        suggestions.push({ projectKey: target.project_key, nodeKey: target.node_key, path });
        continue;
      }
      if (target.project_key !== changedProjectKey) {
        const current = affected.get(target.project_key) ?? { projectKey: target.project_key, owners: new Set(), checks: new Set(), sourceRefs: new Set(), paths: [], status: 'confirmed' };
        if (target.owner_id) current.owners.add(target.owner_id);
        for (const hop of path) {
          for (const check of hop.requiredChecks) current.checks.add(check);
          for (const ref of hop.sourceRefs) current.sourceRefs.add(ref);
        }
        current.paths.push({ targetNodeKey: target.node_key, edgeIds: path.map((hop) => hop.edgeId),
          evidenceKinds: [...new Set(path.map((hop) => hop.evidenceKind))],
          status: path.some((hop) => hop.stale) ? 'stale' : path.every((hop) => hop.confirmationState === 'confirmed') ? 'confirmed' : 'inferred' });
        if (path.some((hop) => hop.stale)) current.status = 'stale';
        else if (current.status !== 'stale' && path.some((hop) => hop.confirmationState !== 'confirmed')) current.status = 'inferred';
        affected.set(target.project_key, current);
      }
      queue.push({ nodeId: target.id, path, seen: new Set([...item.seen, target.id]) });
    }
  }
  const reports = [...affected.values()].map((entry) => ({ projectKey: entry.projectKey, status: entry.status,
    owners: [...entry.owners].sort(), requiredChecks: [...entry.checks].sort(), sourceRefs: [...entry.sourceRefs].sort(),
    paths: entry.paths.sort((a, b) => a.targetNodeKey.localeCompare(b.targetNodeKey)) }))
    .sort((a, b) => a.projectKey.localeCompare(b.projectKey));
  return { status: reports.length ? reports.some((entry) => entry.status === 'stale') ? 'stale' : 'affected' : 'unverified',
    changed: { projectKey: changedProjectKey, nodeKey: changedNodeKey, revisionCommit: changed.revision_commit },
    affected: reports, suggestions, revisionSet };
}

export function scoreImpactCorpus(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('A labeled impact corpus is required');
  let truePositives = 0, falsePositives = 0, missedDependencies = 0;
  for (const item of cases) {
    const report = analyzeTeamImpact(item.input);
    const actual = new Set(report.affected.map((entry) => entry.projectKey));
    const expected = new Set(item.expectedProjects);
    for (const key of actual) expected.has(key) ? truePositives++ : falsePositives++;
    for (const key of expected) if (!actual.has(key)) missedDependencies++;
  }
  return { cases: cases.length, truePositives, falsePositives, missedDependencies,
    precision: truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : 1,
    recall: truePositives + missedDependencies ? truePositives / (truePositives + missedDependencies) : 1 };
}
