import crypto from 'node:crypto';
import path from 'node:path';
import { captureChangeDiff } from './change-diff.mjs';
import { buildVerificationCoverageLedger } from './verification-coverage.mjs';
import { workspaceGroup, workspaceTargets, relationshipReviews } from './workspace-groups.mjs';
import { stableEnvironmentFingerprint } from './contracts-evidence.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idKey = (...values) => JSON.stringify(values);
const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const relativeSource = value => {
  if (!boundedText(value) || value.includes('\0') || path.posix.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) return null;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
};
const rootId = (root, index) => root.sourceBindingId ?? root.resourceId ?? root.id ?? `source-root:${index}`;

/** Read-only local application service, restricted to registered workspace roots.
 * The caller supplies a trusted project-read policy. It is intentionally not a
 * cloud authorization broker; adapters must not accept that policy from clients.
 * File mappings are conservative: this reports potentially changed contracts,
 * not semantic contract differences, and preserves stale dependency candidates.
 */
export async function assessLocalWorkspaceChange({ state, workspaceId, projectId, rootIndex = 0,
  baseRef, headRef, mode = 'working-tree', changeId, canReadProject,
  receipts = [], acceptReceipt = () => false, acceptRelevance = () => false,
  evaluatedAt = new Date().toISOString() } = {}) {
  if (!state || !boundedText(workspaceId) || !boundedText(projectId) || !boundedText(baseRef)
    || !Number.isInteger(rootIndex) || rootIndex < 0 || typeof canReadProject !== 'function'
    || (changeId !== undefined && !boundedText(changeId)) || !Number.isFinite(Date.parse(evaluatedAt))
    || !Array.isArray(receipts) || typeof acceptReceipt !== 'function' || typeof acceptRelevance !== 'function') {
    throw Object.assign(new TypeError('A workspace, registered project/root, explicit baseline and trusted read policy are required.'), { statusCode: 400 });
  }
  const working = structuredClone(state);
  const group = workspaceGroup(working, workspaceId);
  const readable = new Set(group.projectIds.filter(id => { try { return canReadProject(id) === true; } catch { return false; } }));
  if (!readable.has(projectId)) throw Object.assign(new Error('The selected change source is unavailable.'), { statusCode: 403 });
  const selectedProject = working.projects.find(project => project.id === projectId);
  if (!selectedProject?.sourceContext?.roots?.[rootIndex]) throw Object.assign(new Error('Select a registered source root for this project.'), { statusCode: 404 });
  const gaps = [];
  if (readable.size !== group.projectIds.length) gaps.push('Some workspace scope is inaccessible.');
  // Filter before computing fingerprints/review freshness: those operations may
  // inspect source bytes, so dropping output after traversal would be too late.
  working.projects = working.projects.filter(project => readable.has(project.id));
  working.relationshipReviews = (working.relationshipReviews ?? []).filter(review => readable.has(review.fromRef?.projectId) && readable.has(review.toRef?.projectId));
  group.projectIds = group.projectIds.filter(id => readable.has(id));
  const resources = [];
  for (const memberId of group.projectIds) {
    const project = working.projects.find(item => item.id === memberId);
    if (!project) { gaps.push('A registered workspace project is unavailable.'); continue; }
    const roots = project.sourceContext?.roots ?? [];
    if (!roots.length) gaps.push('A workspace resource has no available local Git checkout.');
    roots.forEach((root, index) => resources.push({ project, root, index, resourceId: rootId(root, index) }));
  }
  if (resources.length > 32) throw Object.assign(new Error('Assess at most 32 registered source roots per workspace.'), { statusCode: 400 });
  if (new Set(resources.map(resource => idKey(resource.project.id, resource.resourceId))).size !== resources.length) {
    throw Object.assign(new Error('Source resource identities are ambiguous; fix registered roots first.'), { statusCode: 409 });
  }
  const captures = [];
  let selected;
  for (const resource of resources) {
    const isSelected = resource.project.id === projectId && resource.index === rootIndex;
    try {
      const capture = await captureChangeDiff({ root: resource.root.path, projectId: resource.project.id,
        resourceId: resource.resourceId, baseRef: isSelected ? baseRef : 'HEAD',
        mode: isSelected ? mode : 'working-tree', includeLineRanges: isSelected,
        ...(isSelected && headRef !== undefined ? { headRef } : {}) });
      captures.push({ ...resource, capture });
      if (isSelected) selected = capture;
      if (!capture.diffComplete) gaps.push('A source diff or revision snapshot is incomplete.');
    } catch (error) {
      if (isSelected) throw error;
      gaps.push('A participating source revision could not be captured.');
    }
  }
  if (!selected) throw new Error('The selected source could not be assessed.');
  // Commit comparisons require selected commits for every participating repo to
  // establish historical compatibility. Current sibling snapshots are context,
  // not proof of compatibility with the historical provider version.
  if (mode === 'commits') gaps.push('Other project snapshots are current local context, not selected historical consumer versions.');
  const catalog = workspaceTargets(working, workspaceId);
  if (catalog.length > 1000) throw Object.assign(new Error('The workspace target inventory exceeds the bounded assessment size.'), { statusCode: 400 });
  const byKey = new Map(catalog.map(target => [target.key, target]));
  const refs = new Map();
  for (const target of catalog) {
    const candidates = captures.filter(resource => resource.project.id === target.ref.projectId
      && (!target.root || path.resolve(target.root) === path.resolve(resource.root.path)));
    const source = relativeSource(target.source);
    if (source && candidates.length === 1) {
      const resource = candidates[0];
      const repositoryPath = path.posix.join(resource.capture.sourcePrefix, source);
      refs.set(target.key, { resource, source, repositoryPath });
    }
  }
  const changedPaths = new Set(selected.files.flatMap(file => [file.path, file.previousPath].filter(Boolean)));
  const changed = catalog.filter(target => {
    const mapping = refs.get(target.key);
    return mapping?.resource.project.id === projectId && mapping.resource.index === rootIndex && changedPaths.has(mapping.repositoryPath);
  });
  const mappedPaths = new Set(changed.map(target => refs.get(target.key).repositoryPath));
  const unmappedFiles = [...changedPaths].filter(file => !mappedPaths.has(file));
  if (unmappedFiles.length) gaps.push('Changed paths lack indexed artifact or contract mappings.');
  if (selected.files.some(file => file.binary === true || file.status === 'T')) gaps.push('Binary or type-changing paths need separate inspection.');
  // Index coverage is not guessed from a successful scan or matching route.
  gaps.push('Impact coverage is limited to indexed file mappings and existing dependency evidence.');
  const adjacency = new Map();
  const add = (from, to, relation) => {
    if (!byKey.has(from) || !byKey.has(to) || from === to) return;
    const list = adjacency.get(from) ?? []; list.push({ to, ...relation }); adjacency.set(from, list);
  };
  const keysFor = (id, memberId) => catalog.filter(target => target.ref.projectId === memberId
    && [target.nativeId, target.ref.entityId].includes(id)).map(target => target.key);
  for (const project of working.projects) {
    for (const integration of project.sourceContext?.integrations ?? []) {
      if (integration.confirmationState === 'rejected') continue;
      const callers = keysFor(integration.callId, project.id), providers = keysFor(integration.endpointId, project.id);
      if (callers.length !== 1 || providers.length !== 1) continue;
      add(providers[0], callers[0], { id: integration.id ?? `integration:${hash([providers, callers])}`, evidenceKind: 'static',
        confidence: integration.confirmationState === 'confirmed' ? 'confirmed' : 'inferred', stale: false });
    }
    for (const contract of project.contracts ?? []) {
      const contractTargets = catalog.filter(target => target.ref.projectId === project.id && target.kind === 'api' && target.ref.entityId === contract.id);
      for (const artifactId of contract.sourceArtifactIds ?? []) for (const from of keysFor(artifactId, project.id)) {
        for (const to of contractTargets) {
          add(from, to.key, { id: `contract-source:${hash([from, to.key])}`, evidenceKind: 'static', confidence: 'confirmed', stale: false });
          add(to.key, from, { id: `contract-implementation:${hash([to.key, from])}`, evidenceKind: 'static', confidence: 'confirmed', stale: false });
        }
      }
    }
  }
  for (const review of relationshipReviews(working, workspaceId)) {
    if (review.status !== 'approved') continue;
    const relation = { id: review.id, evidenceKind: 'declared', confidence: review.stale ? 'inferred' : 'confirmed', stale: review.stale };
    // CALLS is caller -> provider, TESTS test -> implementation. Consequence
    // traversal is reverse for those relations; no route-name cross-repo join.
    if (['CALLS', 'TESTS', 'USES_SCHEMA'].includes(review.type)) add(review.toKey, review.fromKey, relation);
    else if (review.type === 'IMPLEMENTS') { add(review.fromKey, review.toKey, relation); add(review.toKey, review.fromKey, relation); }
  }
  const affected = new Map(changed.map(target => [target.key, { key: target.key, confidence: 'confirmed', paths: [] }]));
  const queue = changed.map(target => ({ key: target.key, path: [], seen: new Set([target.key]) }));
  let visited = 0;
  while (queue.length && visited++ < 2000) {
    const current = queue.shift();
    const links = adjacency.get(current.key) ?? [];
    if (current.path.length >= 5) { if (links.length) gaps.push('Dependency traversal reached its depth limit.'); continue; }
    for (const link of links) {
      if (current.seen.has(link.to)) continue;
      const chain = [...current.path, { edgeId: link.id, evidenceKind: link.evidenceKind, confidence: link.confidence, stale: link.stale }];
      const confidence = chain.every(hop => hop.confidence === 'confirmed' && !hop.stale) ? 'confirmed' : 'inferred';
      const entry = affected.get(link.to) ?? { key: link.to, confidence, paths: [] };
      if (confidence === 'inferred') entry.confidence = 'inferred';
      entry.paths.push(chain); affected.set(link.to, entry);
      queue.push({ key: link.to, path: chain, seen: new Set([...current.seen, link.to]) });
    }
  }
  if (queue.length) gaps.push('Dependency traversal reached its work limit.');
  const revisionSet = captures.flatMap(resource => resource.capture.revisionPin ? [resource.capture.revisionPin] : [])
    .sort((a, b) => idKey(a.projectId, a.resourceId).localeCompare(idKey(b.projectId, b.resourceId)));
  const contractRevisions = working.projects.flatMap(project => (project.contracts ?? []).flatMap(contract => {
    const target = catalog.find(target => target.ref.projectId === project.id && target.kind === 'api' && target.ref.entityId === contract.id);
    const mapping = target && refs.get(target.key);
    return mapping && contract.currentRevisionId ? [{ projectId: project.id, resourceId: mapping.resource.resourceId,
      contractId: contract.id, revisionId: contract.currentRevisionId }] : [];
  })).sort((a, b) => idKey(a.projectId, a.resourceId, a.contractId).localeCompare(idKey(b.projectId, b.resourceId, b.contractId)));
  const identity = changeId ?? `change_${hash([workspaceId, projectId, rootIndex, selected.baseCommit]).slice(0, 24)}`;
  const evidenceScopeHash = hash([selected.mode, selected.baseCommit, selected.headCommit,
    revisionSet, contractRevisions, selected.snapshotFingerprint,
    [...affected.values()], group.projectIds, group.version]);
  const components = [...affected.values()].map(entry => {
    const target = byKey.get(entry.key), project = working.projects.find(project => project.id === target.ref.projectId);
    const environmentId = project.activeEnvironmentId ?? project.environments?.[0]?.id;
    // A project command is a candidate suite. Its relevance to a changed
    // behavior is not established by merely finding it in configuration.
    const command = project.verification?.testCommand ?? null;
    const checkFingerprint = hash([target.ref, command, 'behavior']);
    const obligation = { id: `behavior:${hash(target.ref).slice(0, 24)}`, kind: 'behavior', required: true,
      configured: Boolean(command), target: { planHash: evidenceScopeHash, checkFingerprint, environmentId,
        environmentFingerprint: stableEnvironmentFingerprint(project), revisionSet, contractRevisions } };
    const mapping = refs.get(entry.key);
    const selectedFile = mapping?.resource.project.id === projectId && mapping.resource.index === rootIndex
      ? selected.files.find(file => file.path === mapping.repositoryPath || file.previousPath === mapping.repositoryPath) : null;
    const anchorLine = Number(target.line);
    const endLine = Number(target.endLine);
    const indexedRangeCurrent = Number.isInteger(anchorLine) && anchorLine > 0
      && Number.isInteger(endLine) && endLine >= anchorLine
      && /^[a-f0-9]{64}$/.test(target.contentHash ?? '')
      && target.contentHash === selectedFile?.baselineContentHash;
    const symbolOverlap = indexedRangeCurrent && selectedFile?.lineRanges?.some(range => range.oldLines > 0
      ? range.oldStart <= endLine && range.oldStart + range.oldLines - 1 >= anchorLine
      : range.oldStart >= anchorLine - 1 && range.oldStart <= endLine) === true;
    const lineOverlap = selectedFile?.lineRanges?.some(range => Number.isInteger(anchorLine) && anchorLine > 0
      && range.newLines > 0 && anchorLine >= range.newStart && anchorLine < range.newStart + range.newLines) === true;
    return { projectId: project.id, componentId: entry.key, label: String(target.label ?? target.kind).slice(0, 240),
      kind: target.kind, confidence: entry.confidence, changed: changed.some(item => item.key === entry.key),
      ...(selectedFile ? { changeLocation: symbolOverlap ? 'indexed-symbol-overlap'
        : lineOverlap ? 'indexed-line-overlap' : 'file-association' } : {}),
      source: mapping ? { projectId: project.id, resourceId: mapping.resource.resourceId, path: mapping.source,
        line: target.line ?? null, endLine: target.endLine ?? null,
        rangeMethod: target.rangeMethod ?? null } : null,
      paths: entry.paths.slice(0, 12), requirements: [obligation],
      candidateCheck: command ? { source: 'project.verification.testCommand', relevance: 'unassessed' } : null };
  });
  const scopedReceipts = receipts.filter(receipt => receipt?.workspaceId === workspaceId && receipt.changeId === identity);
  if (scopedReceipts.length > 10000) gaps.push('Verification receipt history exceeds the bounded assessment window.');
  const analysis = { complete: false, gaps: [...new Set(gaps)] };
  // Only the adapter can supply trusted exact-target receipts. Legacy task
  // receipts are deliberately excluded because their pins/provenance differ.
  const ledger = buildVerificationCoverageLedger({ workspaceId, changeId: identity, evaluatedAt,
    components, receipts: scopedReceipts.slice(-10000), canReadProject: id => readable.has(id), acceptReceipt,
    acceptRelevance, analysis });
  return { schemaVersion: 1, workspaceId, changeId: identity, evaluatedAt,
    selection: { projectId, rootIndex, resourceCount: resources.length, baseCommit: selected.baseCommit,
      ...(mode === 'commits' ? { headCommit: selected.headCommit } : {}), mode },
    comparison: selected, revisionSet, contractRevisions, components, unmappedFiles: unmappedFiles.slice(0, 250),
    analysis, ledger, execution: { executed: false, reason: 'Assessment only; no test or API replay executed.' },
    identityLimitations: resources.some(resource => !resource.root.sourceBindingId && !resource.root.resourceId && !resource.root.id)
      ? ['Legacy source-root indexes are device-local identities; assign stable resource IDs before sharing proof.'] : [],
    coverage: 'File-level potential impact from actual Git changes. Source associations and declared dependencies are not runtime proof.' };
}
