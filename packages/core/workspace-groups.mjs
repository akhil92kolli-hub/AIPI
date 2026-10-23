import crypto from "node:crypto";
import fs from 'node:fs';
import path from 'node:path';
import { taskArtifacts } from "./task-context.mjs";
import { sourceProvenanceForTarget } from './source-provenance.mjs';

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// Additive overlay: legacy projects retain ownership of every existing record.
export function normalizeWorkspaceGroups(state) {
  state.workspaceGroups ??= [];
  for (const project of state.projects ?? []) {
    if (state.workspaceGroups.some((group) => group.projectIds.includes(project.id))) continue;
    state.workspaceGroups.push({ id: `wsg_${hash(project.id)}`, name: project.name, projectIds: [project.id], version: 1, origin: "legacy-project" });
  }
  state.workspaceSchemaVersion = 1;
  return state.workspaceGroups;
}

export function workspaceGroup(state, id) {
  const group = normalizeWorkspaceGroups(state).find((entry) => entry.id === id || entry.canonicalId === id || entry.teamWorkspaceId === id);
  if (!group) fail("Workspace not found", 404);
  return group;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_ID_RE = /^(?:wsg_[a-zA-Z0-9_-]{8,100}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function saveWorkspaceGroup(state, input, id) {
  normalizeWorkspaceGroups(state);
  if (!WORKSPACE_ID_RE.test(id ?? "")) fail("A stable workspace ID is required");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) fail("Workspace name must contain 1–80 characters");
  if (!Array.isArray(input.projectIds) || !input.projectIds.length || !input.projectIds.every((value) => typeof value === "string") || input.projectIds.length > 50) fail("Choose between 1 and 50 existing projects");
  const projectIds = [...new Set(input.projectIds)].sort();
  if (projectIds.some((projectId) => !(state.projects ?? []).some((p) => p.id === projectId))) fail("A selected project is unavailable", 404);
  const existing = state.workspaceGroups.find((entry) => entry.id === id || entry.canonicalId === id);
  if (existing && existing.name === name && JSON.stringify([...existing.projectIds].sort()) === JSON.stringify(projectIds) && (!input.canonicalId || existing.canonicalId === input.canonicalId)) return existing;
  if (existing && input.expectedVersion !== existing.version) fail("Workspace membership changed. Reload before saving.", 409);
  if (!existing && input.expectedVersion != null) fail("Workspace not found", 404);
  const canonicalId = input.canonicalId ?? existing?.canonicalId ?? (UUID_RE.test(id) ? id : undefined);
  const group = {
    id: existing?.id ?? id,
    ...(canonicalId ? { canonicalId } : {}),
    ...(input.teamWorkspaceId !== undefined || existing?.teamWorkspaceId !== undefined ? { teamWorkspaceId: input.teamWorkspaceId ?? existing?.teamWorkspaceId ?? null } : {}),
    name,
    projectIds,
    version: (existing?.version ?? 0) + 1,
    origin: "developer",
    updatedAt: new Date().toISOString()
  };
  if (existing) Object.assign(existing, group);
  else state.workspaceGroups.push(group);
  return existing ?? group;
}

export const targetKey = (ref) => Buffer.from(JSON.stringify([ref.projectId, ref.kind, ref.entityId, ref.rootId ?? null, ref.serviceId ?? null])).toString("base64url");

function displayRoute(value) {
  const text = String(value ?? "");
  try { return new URL(text).pathname; } catch { return text.split(/[?#]/)[0].replace(/^(https?:\/\/)[^/@]+@/, "$1"); }
}

export function workspaceTargets(state, groupId) {
  const group = workspaceGroup(state, groupId);
  const targets = [];
  for (const projectId of group.projectIds) {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) continue; // Historical groups keep missing member IDs; never substitute another project.
    const source = project.sourceContext ?? {};
    const add = (kind, entityId, fields = {}) => {
      const evidenceKind = ['request', 'service'].includes(kind) ? 'developer-declaration' : 'extracted-code-fact';
      const provenance = sourceProvenanceForTarget(project, { root: fields.root, sourceBindingId: fields.sourceBindingId,
        contentHash: fields.contentHash, evidenceKind });
      const ref = { workspaceId: group.canonicalId ?? group.id, projectId, sourceBindingId: provenance.sourceBindingId,
        kind, entityId, rootId: fields.root ? `root_${hash([projectId, fields.root])}` : null, serviceId: fields.serviceId ?? null };
      targets.push({ ...fields, ...provenance, key: targetKey(ref), ref, projectName: project.name, kind, indexedAt: source.lastScannedAt ?? null });
    };
    for (const artifact of taskArtifacts(project)) {
      add(artifact.kind, artifact.id, { label: artifact.label, source: artifact.source, root: artifact.root,
        line: artifact.line, endLine: artifact.endLine, rangeMethod: artifact.rangeMethod,
        contentHash: artifact.contentHash, sourceBindingId: artifact.sourceBindingId,
        route: artifact.route, method: artifact.method, nativeId: artifact.nativeId, provenance: "Source index" });
    }
    for (const contract of project.contracts ?? []) {
      const endpoint = contract.sourceArtifactIds?.length === 1
        ? (source.endpoints ?? []).find(item => item.id === contract.sourceArtifactIds[0]
          && item.source === contract.implementation?.source && item.root === contract.implementation?.root) : null;
      add("api", contract.id, { label: `${contract.method} ${displayRoute(contract.route ?? contract.normalizedPath)}`, method: contract.method, route: displayRoute(contract.route ?? contract.normalizedPath), source: contract.implementation?.source, root: contract.implementation?.root, sourceBindingId: contract.sourceBindingId ?? contract.implementation?.sourceBindingId, line: contract.implementation?.line, endLine: endpoint?.endLine ?? null, rangeMethod: endpoint?.rangeMethod ?? null, contentHash: endpoint?.contentHash ?? null, serviceId: contract.serviceId, provenance: "Contract inventory" });
    }
    for (const request of project.requests ?? []) {
      add("request", request.id, { label: request.name, method: request.method, route: displayRoute(request.url), serviceId: request.serviceId, provenance: "Saved request", contractId: request.contractId });
    }
    const environment = project.environments?.find((entry) => entry.id === project.activeEnvironmentId);
    for (const service of environment?.services ?? []) {
      add("service", service.id ?? service.variableKey, { label: service.name ?? service.variableKey, serviceId: service.id ?? service.variableKey, provenance: "Environment configuration" });
    }
  }
  return targets;
}

export function searchWorkspaceTargets(state, groupId, { query = "", kind = "all", offset = 0, limit = 40 } = {}) {
  if (typeof query !== "string" || query.length > 500) fail("Search must be at most 500 characters");
  if (!["all", "ui", "apis", "services", "tests", "files"].includes(kind)) fail("Unknown target filter");
  offset = Number(offset); limit = Number(limit);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail("Invalid search page");
  const terms = query.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const allowed = { ui: ["page", "component", "consumer"], apis: ["api", "endpoint", "request"], services: ["service"], tests: ["test"], files: ["document", "schema", "model", "component", "page", "endpoint", "consumer", "test"] };
  const matches = workspaceTargets(state, groupId).filter((target) => kind === "all" || allowed[kind].includes(target.kind)).map((target) => {
    const text = [target.label, target.source, target.route, target.method, target.projectName].join(" ").normalize("NFKC").toLowerCase();
    const matched = terms.filter((term) => text.includes(term));
    const exact = terms.length > 0 && [target.route, target.label, target.source].some((value) => String(value ?? "").toLowerCase() === query.trim().toLowerCase());
    return { ...target, score: (exact ? 100 : 0) + matched.length, reason: exact ? "Exact match" : matched.length ? `Matched: ${matched.join(", ")}` : target.provenance, matches: matched.length === terms.length };
  }).filter((target) => target.matches).sort((a, b) => b.score - a.score || String(a.label).localeCompare(String(b.label)) || a.key.localeCompare(b.key));
  const group = workspaceGroup(state, groupId);
  return { group, items: matches.slice(offset, offset + limit).map(({ score, matches, ...target }) => target), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null,
    coverage: group.projectIds.map((projectId) => { const project = state.projects.find((entry) => entry.id === projectId); return { projectId, name: project?.name ?? projectId, available: Boolean(project), indexedAt: project?.sourceContext?.lastScannedAt ?? null, scanStatus: project?.sourceContext?.scanStatus ?? "not-scanned" }; }) };
}

export function getWorkspaceTarget(state, groupId, key) {
  const targets = workspaceTargets(state, groupId);
  const target = targets.find((entry) => entry.key === key);
  if (!target) fail("Target is unavailable in this workspace. Refresh the index or selection.", 404);
  const project = state.projects.find((entry) => entry.id === target.ref.projectId);
  const nativeIds = new Set([target.nativeId, target.ref.entityId].filter(Boolean));
  const links = [];
  for (const integration of project.sourceContext?.integrations ?? []) {
    const qualifier = integration.confirmationState === "inferred" ? " · unconfirmed; review destination" : "";
    if (nativeIds.has(integration.callId)) links.push({ id: integration.endpointId, reason: `Indexed API call${qualifier}`, evidenceKind: 'inferred-advisory' });
    if (nativeIds.has(integration.endpointId)) links.push({ id: integration.callId, reason: `Indexed API consumer${qualifier}`, evidenceKind: 'inferred-advisory' });
  }
  const contract = project.contracts?.find((entry) => entry.id === target.ref.entityId || entry.id === target.contractId);
  for (const id of contract?.sourceArtifactIds ?? []) links.push({ id, reason: "Contract source reference", evidenceKind: 'indexed-local' });
  for (const id of contract?.sourceRequestIds ?? []) links.push({ id, reason: "Saved contract request", evidenceKind: 'developer-declaration' });
  for (const edge of project.knowledgeGraph?.edges ?? []) {
    if (edge.stale || ['pending', 'rejected', 'inferred'].includes(edge.confirmationState)) continue;
    const from = edge.fromNodeId ?? edge.from, to = edge.toNodeId ?? edge.to;
    const evidenceKind = edge.provenance === 'static' && edge.sourceArtifactId ? 'indexed-local' : 'graph-advisory';
    if (nativeIds.has(from)) links.push({ id: to, reason: `${edge.type} · ${edge.provenance ?? "indexed"}`, evidenceKind });
    if (nativeIds.has(to)) links.push({ id: from, reason: `${edge.type} · ${edge.provenance ?? "indexed"}`, evidenceKind });
  }
  const related = targets.filter((entry) => entry.ref.projectId === target.ref.projectId && entry.key !== key).flatMap((entry) => {
    const link = links.find((item) => item.id === entry.nativeId || item.id === entry.ref.entityId);
    return link ? [{ ...entry, reason: link.reason, relationshipEvidenceKind: link.evidenceKind }] : [];
  });
  for (const review of relationshipReviews(state, groupId).filter(r => r.status === 'approved' && !r.stale)) {
    const other = review.fromKey === key ? review.toKey : review.toKey === key ? review.fromKey : null;
    const entry = targets.find(t => t.key === other);
    if (entry && !related.some(t => t.key === entry.key)) related.push({...entry, reason: `Reviewed ${review.type} · static declaration, not runtime proof`, relationshipReviewId: review.id, relationshipEvidenceKind: 'declared-advisory'});
  }
  return { target, related: related.slice(0, 30), relatedTotal: related.length, coverageNote: "Related items use indexed or explicitly reviewed links. Matching names or routes alone never establish cross-project relationships." };
}

function relationshipFingerprint(state, targets) {
  return hash(targets.map(t => {
    const p = state.projects.find(p => p.id === t.ref.projectId);
    let content = null;
    if (t.source) {
      try {
        const roots = (p.sourceContext?.roots ?? []).map(r => fs.realpathSync(r.path));
        const root = t.root ? fs.realpathSync(t.root) : roots.length === 1 ? roots[0] : null;
        if (!root || !roots.includes(root)) throw new Error('Unregistered source');
        const file = fs.realpathSync(path.resolve(root,t.source));
        if (!file.startsWith(root + path.sep) || fs.statSync(file).size > 2_000_000) throw new Error('Unavailable source');
        content = hash(fs.readFileSync(file).toString('base64'));
      } catch { content = 'unavailable'; }
    }
    const roots = (p?.sourceContext?.roots ?? []).map(r => r.path ?? r);
    const revision = p?.sourceContext?.gitRevision ?? p?.sourceContext?.git?.find(g => g.commit)?.commit ?? p?.sourceContext?.lastScannedAt;
    const targetArtifact = (p?.sourceContext?.endpoints ?? []).concat(p?.sourceContext?.frontendCalls ?? []).concat(p?.sourceContext?.artifacts ?? []).find(a => a.id === t.nativeId || a.id === t.ref.entityId);
    return [t.ref, t.source, t.line, content, roots, revision, targetArtifact, p?.contracts, p?.requests];
  }));
}

export function relationshipReviews(state, groupId) {
  const targets = workspaceTargets(state, groupId);
  return (state.relationshipReviews ?? []).filter(r => r.workspaceGroupId === groupId).map(r => {
    const pair = [targets.find(t => t.key === r.fromKey), targets.find(t => t.key === r.toKey)];
    return {...r, stale: pair.some(t => !t) || relationshipFingerprint(state, pair) !== r.fingerprint};
  });
}

export function reviewWorkspaceRelationship(state, groupId, input) {
  const targets = workspaceTargets(state, groupId);
  const pair = [targets.find(t => t.key === input.fromKey), targets.find(t => t.key === input.toKey)];
  if (pair.some(t => !t) || input.fromKey === input.toKey) fail('Choose two distinct available workspace targets');
  if (!['CALLS','IMPLEMENTS','TESTS','USES_SCHEMA'].includes(input.type)) fail('Unsupported relationship type');
  if (!['approved','rejected'].includes(input.status)) fail('Choose approved or rejected');
  if (typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 4000) fail('Provide bounded evidence explaining the relationship');
  if (typeof input.reviewer !== 'string' || !input.reviewer.trim() || input.reviewer.length > 120) fail('Reviewer attribution is required');
  const id = `relationship_${hash([groupId,input.fromKey,input.toKey,input.type])}`;
  state.relationshipReviews ??= [];
  const previous = state.relationshipReviews.find(r => r.id === id);
  if ((input.expectedVersion ?? 0) !== (previous?.version ?? 0)) fail('Relationship review changed; reload before saving',409);
  const record = {id,workspaceGroupId:groupId,fromKey:input.fromKey,toKey:input.toKey,fromRef:pair[0].ref,toRef:pair[1].ref,type:input.type,status:input.status,evidence:input.evidence.trim(),reviewer:input.reviewer.trim(),provenance:'manual-review',runtimeVerified:false,fingerprint:relationshipFingerprint(state,pair),version:(previous?.version ?? 0)+1,reviewedAt:new Date().toISOString()};
  state.relationshipReviewHistory ??= [];
  if (previous) state.relationshipReviewHistory.push(structuredClone(previous));
  state.relationshipReviews = state.relationshipReviews.filter(r => r.id !== id).concat(record);
  return record;
}

export function buildWorkspaceProjection(state, groupId) {
  const group = workspaceGroup(state, groupId);
  const memberProjects = (group.projectIds ?? [])
    .map((id) => (state.projects ?? []).find((p) => p.id === id))
    .filter(Boolean);

  const tasksMap = new Map();
  for (const project of memberProjects) {
    for (const task of project.tasks ?? []) {
      if (!tasksMap.has(task.id)) {
        tasksMap.set(task.id, {
          ...task,
          projectId: task.projectId ?? project.id,
          projectName: project.name,
          scope: task.scope ?? [{ projectKey: project.id }],
        });
      }
    }
  }

  const contracts = memberProjects.flatMap((project) =>
    (project.contracts ?? []).map((contract) => ({
      ...contract,
      projectId: project.id,
      projectName: project.name,
    }))
  );

  const targets = workspaceTargets(state, group.id);

  return {
    workspace: {
      id: group.id,
      canonicalId: group.canonicalId ?? group.id,
      name: group.name,
      mode: "local",
      version: group.version,
    },
    projects: memberProjects.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.repositoryBinding ? "GitHub repository" : "Local source",
      detail: p.repositoryBinding?.remote ?? "Local project",
      repository: p.repositoryBinding?.providerRepositoryId ?? null,
      remoteUrl: p.repositoryBinding?.remote ?? null,
      sources: p.sourceBindings ?? [],
    })),
    tasks: Array.from(tasksMap.values()),
    contracts,
    targets,
    capabilities: {
      knowledge: "Local source indexing and static relationship reviews available.",
      contracts: "Contract inventory extracted from local routes and saved requests.",
      verify: "Run checks against local service endpoints and test commands.",
      source: "Open and inspect files in trusted workspace roots.",
      agents: "Assemble bounded context and dispatch to IDE agent.",
      settings: "Manage workspace groups and linked repositories.",
    },
  };
}
