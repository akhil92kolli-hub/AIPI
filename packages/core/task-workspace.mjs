import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceTargets, targetKey, relationshipReviews } from './workspace-groups.mjs';

// Runtime association only: never serialize another project's state into a task.
const workspaces = new WeakMap();
export function bindTaskWorkspace(state) {
  for (const project of state.projects ?? []) workspaces.set(project, state);
  for (const project of state.projects ?? []) for (const task of project.tasks ?? []) {
    if (crossRepositoryTask(project, task) && task.contextPack?.workspace && scopeHash(task.contextPack.workspace) !== scopeHash(workspaceScopeSnapshot(project, task))) {
      task.contextStatus = 'stale';
      task.staleVerificationReceiptIds = [...new Set([...(task.staleVerificationReceiptIds ?? []), ...(task.verificationReceiptIds ?? [])])];
    }
    if (!crossRepositoryTask(project, task) && task.contextPack?.reviewedRelationshipsHash && task.contextPack.reviewedRelationshipsHash !== scopeHash(reviewedTaskRelationships(project, task))) {
      task.contextStatus = 'stale';
    }
  }
  return state;
}
export function taskWorkspace(project) { return workspaces.get(project); }
export const hasWorkspaceTargets = task => Boolean(task.workspaceGroupId && task.targetRefs?.length);
export const crossRepositoryTask = (project, task) => (task.targetRefs ?? []).some(ref => ref.projectId !== project.id);
export const scopeHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A review is evidence, not an implicit selection or permission to edit another repository.
export function reviewedTaskRelationships(project, task) {
  const state = taskWorkspace(project);
  if (!state) return [];
  const explicit = new Set((task.artifactIds ?? []).filter(id => task.contextControls?.[id] !== 'exclude'));
  const results = [];
  for (const group of state.workspaceGroups ?? []) {
    if (!group.projectIds.includes(project.id)) continue;
    const targets = workspaceTargets(state, group.id);
    for (const review of relationshipReviews(state, group.id)) {
      if (review.status !== 'approved' || review.stale || review.fromRef.projectId === review.toRef.projectId) continue;
      const local = [review.fromRef, review.toRef].find(ref => ref.projectId === project.id && explicit.has(ref.entityId));
      const from = targets.find(target => target.key === review.fromKey);
      const to = targets.find(target => target.key === review.toKey);
      if (!local || !from || !to) continue;
      const describe = target => ({ref:target.ref, projectName:target.projectName, root:target.root ?? null, source:target.source ?? null, line:target.line ?? null, label:target.label});
      results.push({id:review.id, workspaceGroupId:group.id, type:review.type, reviewer:review.reviewer,
        reviewedAt:review.reviewedAt, version:review.version, evidence:review.evidence, provenance:review.provenance,
        runtimeVerified:false, from:describe(from), to:describe(to)});
    }
  }
  return results.sort((a,b) => a.id.localeCompare(b.id));
}
function sourceHash(project,target) {
  if(!target.source) return null;
  try {
    const roots=(project.sourceContext?.roots??[]).map(r=>fs.realpathSync(r.path));
    const root=target.root?fs.realpathSync(target.root):roots.length===1?roots[0]:null;
    if(!root || !roots.includes(root)) return 'unavailable-root';
    const file=fs.realpathSync(path.resolve(root,target.source));
    if(!file.startsWith(root+path.sep)) return 'outside-root';
    const stat=fs.statSync(file);if(!stat.isFile()||stat.size>2_000_000)return 'unavailable-file';
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {return 'unavailable-file';}
}

export function resolveTaskWorkspace(project, task) {
  const state = taskWorkspace(project);
  if (!hasWorkspaceTargets(task)) return { projects: [{ project, task }], targets: [], errors: [] };
  const group = state?.workspaceGroups?.find(g => g.id === task.workspaceGroupId);
  if (!group?.projectIds.includes(project.id)) return { projects: [], targets: [], errors: ['Task workspace membership is unavailable. Reconnect the workspace and review context.'] };
  const catalog = workspaceTargets(state, group.id), targets = [], errors = [];
  for (const ref of task.targetRefs) {
    const target = catalog.find(t => t.key === targetKey(ref));
    if (!target || target.kind === 'service') errors.push(`Unavailable context: ${ref.projectId} / ${ref.kind} / ${ref.entityId}. Review the selection.`);
    else targets.push(target);
  }
  const ids = [...new Set([project.id, ...targets.map(t => t.ref.projectId)])];
  const projects = ids.map(id => {
    const member = state.projects.find(p => p.id === id);
    const selected = targets.filter(t => t.ref.projectId === id);
    for (const target of selected) {
      const candidates = catalog.filter(t => t.ref.projectId === id && t.kind === target.kind && t.ref.entityId === target.ref.entityId);
      if (candidates.length > 1) errors.push(`Ambiguous local identity in ${id}: ${target.ref.entityId}. Assign unique indexed IDs across roots before verification.`);
    }
    const local = id === project.id;
    const contracts = selected.filter(t => t.kind === 'api').map(t => t.ref.entityId);
    const requests = selected.filter(t => t.kind === 'request').map(t => t.ref.entityId);
    for (const requestId of requests) {
      const request = member.requests?.find(r => r.id === requestId);
      const contract = member.contracts?.find(c => c.id === request?.contractId || c.sourceRequestIds?.includes(requestId));
      if (contract) contracts.push(contract.id);
    }
    const artifacts = selected.filter(t => !['api','request'].includes(t.kind)).map(t => t.ref.entityId);
    return { project: member, task: { ...task, projectId: id, targetRefs: [], workspaceGroupId: null,
      contractIds: [...new Set([...contracts, ...(local ? task.contractIds ?? [] : [])])],
      requestIds: [...new Set([...requests, ...(local ? task.requestIds ?? [] : [])])],
      artifactIds: [...new Set([...artifacts, ...(local ? task.artifactIds ?? [] : [])])],
      findingIds: local ? task.findingIds : [], runtimeEvidenceIds: [], runtimeFindings: [],
      // Commands remain repository-owned. A foreign repository receives one
      // only when the task explicitly selected it for that project.
      testCommand: task.repositoryTestCommands?.[id] ?? (local ? task.testCommand : null),
      verificationTestCommand: local ? task.verificationTestCommand : null,
      intent: contracts.length ? artifacts.length ? 'full-stack' : 'api-contract' : artifacts.length ? 'ui-component' : task.intent,
      verificationPlan: null, verificationPlanId: null
    }, targets: selected };
  });
  return { projects, targets, errors };
}

export function workspaceScopeSnapshot(project, task) {
  const scope = resolveTaskWorkspace(project, task);
  const state = taskWorkspace(project);
  const keys = new Set((task.targetRefs ?? []).map(targetKey));
  const relationships = state?.workspaceGroups?.some(g => g.id === task.workspaceGroupId) ? relationshipReviews(state,task.workspaceGroupId).filter(r => keys.has(r.fromKey) && keys.has(r.toKey)) : [];
  return { workspaceGroupId: task.workspaceGroupId, targetRefs: task.targetRefs, errors: scope.errors,
    relationships,
    projects: scope.projects.map(({ project: p, task: t }) => ({ projectId:p.id, name:p.name,
      roots:(p.sourceContext?.roots ?? []).map(r=>({kind:r.kind,path:r.path})),
      indexedAt:p.sourceContext?.lastScannedAt ?? null, git:p.sourceContext?.git ?? [],
      gitRevision:p.sourceContext?.gitRevision ?? null, environmentId:p.activeEnvironmentId ?? null,
      // Hash configuration, never put values or credentials in the manifest.
      configurationHash:scopeHash([p.environments, t.contractIds.map(id=>p.contracts?.find(c=>c.id===id)),t.requestIds.map(id=>p.requests?.find(r=>r.id===id))]),
      artifacts:scope.targets.filter(v=>v.ref.projectId===p.id).map(v=>({ref:v.ref,root:v.root,source:v.source,line:v.line,contentHash:sourceHash(p,v)}))
    })) };
}
