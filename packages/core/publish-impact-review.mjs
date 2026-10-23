import crypto from 'node:crypto';
import path from 'node:path';
import { assessLocalWorkspaceChange } from './change-assessment.mjs';
import { normalizeWorkspaceGroups } from './workspace-groups.mjs';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// This is a local publication disclosure, not an accepted verification receipt
// or a protected deployment decision. Recompute it at submission time.
export async function buildPublishImpactReview({ state, projectId, root, plan,
  assess = assessLocalWorkspaceChange, acceptReceipt = () => false } = {}) {
  if (!state || !projectId || !root || !plan?.commit) throw new TypeError('A current publish plan and registered source are required.');
  const groups = normalizeWorkspaceGroups(state).filter(group => group.projectIds.includes(projectId));
  const assessments = [];
  const rawAssessments = [];
  const limitations = [];
  const impacts = new Map();
  const remoteRef = `refs/remotes/${plan.remoteName}/${plan.targetBranch}`;
  for (const group of groups) {
    const project = state.projects.find(item => item.id === projectId);
    const rootIndex = project?.sourceContext?.roots?.findIndex(item => path.resolve(item.path) === path.resolve(root)) ?? -1;
    if (rootIndex < 0 || !plan.targetExists) {
      limitations.push({ workspaceId: group.id, reason: rootIndex < 0
        ? 'The publishing source is not a registered workspace root.'
        : 'The target branch has no local baseline; cross-repository impact is unknown.' });
      continue;
    }
    try {
      const assessment = await assess({ state, workspaceId: group.id, projectId, rootIndex,
        baseRef: remoteRef, headRef: plan.commit, mode: 'commits',
        canReadProject: id => group.projectIds.includes(id),
        receipts: state.changeVerificationReceipts ?? [], acceptReceipt });
      rawAssessments.push(assessment);
      assessments.push({ workspaceId: group.id, version: group.version,
        scopeHash: digest([assessment.comparison.baseCommit, assessment.comparison.headCommit,
          assessment.comparison.snapshotFingerprint, assessment.revisionSet, assessment.contractRevisions,
          assessment.components.map(item => [item.projectId, item.componentId, item.paths]),
          assessment.ledger.components.map(item => [item.projectId, item.componentId, item.status]),
          assessment.analysis.gaps, group.projectIds]) });
      for (const component of assessment.components.filter(item => item.projectId !== projectId)) {
        const key = JSON.stringify([component.projectId, component.componentId]);
        const coverage = assessment.ledger.components.find(item => item.projectId === component.projectId && item.componentId === component.componentId);
        impacts.set(key, { workspaceId: group.id, projectId: component.projectId, componentId: component.componentId,
          label: component.label, source: component.source ? { path: component.source.path, line: component.source.line } : null,
          status: coverage?.status ?? 'unknown', evidence: component.confidence });
      }
      if (assessment.analysis.gaps.length || assessment.unmappedFiles.length || assessment.ledger.status !== 'passed') {
        limitations.push({ workspaceId: group.id, reason: 'Some source mappings, consumers, or verification obligations remain unproven.' });
      }
    } catch {
      limitations.push({ workspaceId: group.id, reason: 'The current workspace impact assessment could not be completed.' });
    }
  }
  if (!groups.length) limitations.push({ workspaceId: null, reason: 'No workspace contains this project; cross-repository impact is unknown.' });
  const allImpacts = [...impacts.values()].sort((a, b) => JSON.stringify([a.projectId, a.componentId]).localeCompare(JSON.stringify([b.projectId, b.componentId])));
  const scope = { projectId, root: path.resolve(root), commit: plan.commit, remoteName: plan.remoteName,
    targetBranch: plan.targetBranch, repositoryUrl: plan.repositoryUrl,
    assessments: assessments.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    limitations: limitations.sort((a, b) => String(a.workspaceId).localeCompare(String(b.workspaceId)) || a.reason.localeCompare(b.reason)),
    impacts: allImpacts.map(item => [item.workspaceId, item.projectId, item.componentId, item.status]) };
  return { fingerprint: digest(scope), rawAssessments, review: { status: limitations.length ? 'unknown' : allImpacts.some(item => item.status === 'failed') ? 'failed' :
    allImpacts.length ? 'unproven' : 'no-indexed-consumers', scope: assessments.map(item => item.workspaceId),
    impacts: allImpacts.slice(0, 30), omittedImpacts: Math.max(0, allImpacts.length - 30), limitations,
    note: 'This local assessment is a disclosure. It cannot prove all consumers or authorize merge or deployment.' } };
}

export function issuePublishReviewToken(fingerprint, secret, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || !secret) throw new TypeError('A review fingerprint and local signing secret are required.');
  const payload = Buffer.from(JSON.stringify({ fingerprint, expiresAt: now + 5 * 60_000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function acceptPublishReviewToken(token, fingerprint, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024 || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  let supplied;
  try { supplied = Buffer.from(parts[1], 'base64url'); } catch { return false; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return false;
  try {
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return value.fingerprint === fingerprint && Number.isFinite(value.expiresAt) && value.expiresAt >= now;
  } catch { return false; }
}
