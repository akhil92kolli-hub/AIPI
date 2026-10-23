import crypto from 'node:crypto';
import path from 'node:path';
import { assessLocalWorkspaceChange } from './change-assessment.mjs';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');

function commandFor(project, root) {
  const value = project.verification?.testCommand;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !bounded(value.command)
    || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/.test(value.command)
    || !Array.isArray(value.args) || value.args.length > 64
    || value.args.some(arg => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0'))
    || (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.length > 512))
    || (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 300_000))) return null;
  const roots = project.sourceContext?.roots ?? [];
  const registered = value.repositoryRoot
    ? roots.find(entry => entry.path === value.repositoryRoot)
    : roots.length === 1 ? roots[0] : null;
  if (!registered || registered.path !== root.path) return null;
  const cwd = path.posix.normalize((value.cwd ?? '.').replaceAll('\\', '/'));
  if (cwd === '..' || cwd.startsWith('../') || path.posix.isAbsolute(cwd) || /^[A-Za-z]:\//.test(cwd)) return null;
  return { command: value.command, args: [...value.args], cwd,
    timeoutMs: value.timeoutMs ?? 120_000, resourceId: root.resourceId ?? root.id };
}

// The reviewed plan is rebuilt from registered source roots and current
// assessment targets. The client may return only its hash as approval; it
// cannot provide a command, path, target or producer identity to execute.
export function reviewAssessmentChecks({ assessment, state, canRunProject }) {
  if (!assessment?.selection || !state || typeof canRunProject !== 'function') throw bad('A current scoped assessment and run policy are required.');
  if (assessment.selection.mode !== 'working-tree') throw bad('Historical commit comparisons need isolated checkouts before commands can run against that revision.', 409);
  if (!assessment.comparison?.diffComplete || !Array.isArray(assessment.revisionSet)
    || !Number.isInteger(assessment.selection.resourceCount)
    || assessment.revisionSet.length !== assessment.selection.resourceCount || assessment.revisionSet.length === 0) {
    throw bad('Complete source revision pins are required before reviewing checks.', 409);
  }
  const group = state.workspaceGroups?.find(entry => entry.id === assessment.workspaceId);
  if (!group) throw bad('Workspace unavailable.', 404);
  const checks = [], gaps = [];
  for (const component of assessment.components ?? []) {
    if (!group.projectIds.includes(component.projectId) || canRunProject(component.projectId, state) !== true) {
      gaps.push('Some affected checks are inaccessible.'); continue;
    }
    const project = state.projects?.find(entry => entry.id === component.projectId);
    const obligation = component.requirements?.find(entry => entry.kind === 'behavior' && entry.required !== false);
    if (!project || !obligation?.target || !obligation.configured) {
      gaps.push('An affected component has no configured behavior check.'); continue;
    }
    const source = component.source;
    const root = project.sourceContext?.roots?.find(entry => (entry.resourceId ?? entry.id) === source?.resourceId);
    const command = root && commandFor(project, root);
    if (!command || !root || !bounded(command.resourceId)) {
      gaps.push('A configured check needs a reviewed argument array and an unambiguous registered source root.'); continue;
    }
    if (obligation.target.revisionSet?.length !== assessment.revisionSet.length
      || !obligation.target.revisionSet?.every((pin, index) => JSON.stringify(pin) === JSON.stringify(assessment.revisionSet[index]))) {
      throw bad('An obligation does not match the complete assessed revision set.', 409);
    }
    checks.push({ projectId: component.projectId, componentId: component.componentId,
      requirementId: obligation.id, kind: 'behavior', sourceResourceId: command.resourceId,
      target: structuredClone(obligation.target),
      command: { command: command.command, args: command.args, cwd: command.cwd, timeoutMs: command.timeoutMs } });
  }
  checks.sort((a, b) => JSON.stringify([a.projectId, a.componentId, a.requirementId]).localeCompare(JSON.stringify([b.projectId, b.componentId, b.requirementId])));
  if (checks.length > 100) throw bad('Review at most 100 affected checks in one run.', 400);
  const selection = structuredClone(assessment.selection);
  const reviewHash = `sha256:${digest([assessment.workspaceId, assessment.changeId, selection, checks, group.version, [...group.projectIds].sort()])}`;
  return { schemaVersion: 1, workspaceId: assessment.workspaceId, changeId: assessment.changeId,
    selection, reviewHash, checks, gaps: [...new Set(gaps)],
    complete: checks.length > 0 && gaps.length === 0 && assessment.analysis?.complete === true,
    note: 'Approval runs only these commands on these exact source targets. A passing suite does not establish test relevance or complete dependency coverage.' };
}

export function signLocalAssessmentReceipt(receipt, key) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new TypeError('A separate local evidence key is required.');
  const { signature, ...unsigned } = receipt;
  return { ...unsigned, signature: crypto.createHmac('sha256', key).update(JSON.stringify(unsigned)).digest('hex') };
}

export function verifyLocalAssessmentReceipt(receipt, key) {
  if (!Buffer.isBuffer(key) || key.length < 32 || !receipt || !/^[a-f0-9]{64}$/.test(receipt.signature ?? '')) return false;
  const { signature, ...unsigned } = receipt;
  const expected = crypto.createHmac('sha256', key).update(JSON.stringify(unsigned)).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function acceptLocalAssessmentEvidence(receipt, key, artifacts) {
  if (!verifyLocalAssessmentReceipt(receipt, key) || !Array.isArray(artifacts)
    || !Array.isArray(receipt.evidenceIds) || !receipt.evidenceIds.length) return false;
  return receipt.evidenceIds.every(id => {
    const matches = artifacts.filter(artifact => artifact?.id === id);
    if (matches.length !== 1) return false;
    const { id: artifactId, ...content } = matches[0];
    return artifactId === `sha256:${digest(content)}`
      && content.workspaceId === receipt.workspaceId && content.changeId === receipt.changeId
      && content.projectId === receipt.projectId && content.componentId === receipt.componentId
      && content.requirementId === receipt.requirementId && content.runId === receipt.runId;
  });
}

const selectionInput = (assessment, state, canReadProject) => ({ state,
  workspaceId: assessment.workspaceId, projectId: assessment.selection.projectId,
  rootIndex: assessment.selection.rootIndex, baseRef: assessment.selection.baseCommit,
  ...(assessment.selection.mode === 'commits' ? { headRef: assessment.selection.headCommit } : {}),
  mode: assessment.selection.mode, changeId: assessment.changeId, canReadProject });

/** Execute a hash-approved, server-derived plan. Check logs are hashed and
 * discarded; immutable signed receipts are returned to the authorized adapter
 * for storage. A fresh assessment before and after execution detects edits. */
export async function executeReviewedAssessment({ assessment, state, canRunProject,
  approvedReviewHash, executeCheck, signingKey, shouldCancel = () => false,
  loadCurrentState = async () => state }) {
  if (!bounded(approvedReviewHash) || typeof executeCheck !== 'function'
    || typeof shouldCancel !== 'function' || typeof loadCurrentState !== 'function') throw bad('Review hash and local check executor are required.');
  const visible = current => id => canRunProject(id, current) === true;
  const startingState = await loadCurrentState();
  const fresh = await assessLocalWorkspaceChange(selectionInput(assessment, startingState, visible(startingState)));
  const plan = reviewAssessmentChecks({ assessment: fresh, state: startingState, canRunProject });
  if (approvedReviewHash !== plan.reviewHash) throw bad('The source, workspace, environment, commands or reviewed obligations changed. Review the current plan.', 409);
  const receipts = [], evidence = [];
  const runId = `assessment_run_${crypto.randomUUID()}`;
  for (const check of plan.checks) {
    if (await shouldCancel()) break;
    // A source edit during an earlier check prevents further commands from
    // running against a target the user did not review.
    const currentState = await loadCurrentState();
    const before = await assessLocalWorkspaceChange(selectionInput(assessment, currentState, visible(currentState)));
    if (reviewAssessmentChecks({ assessment: before, state: currentState, canRunProject }).reviewHash !== plan.reviewHash) break;
    const project = currentState.projects.find(entry => entry.id === check.projectId);
    const root = project.sourceContext.roots.find(entry => (entry.resourceId ?? entry.id) === check.sourceResourceId);
    let outcome;
    try { outcome = await executeCheck(project, { ...check.command, repositoryRoot: root.path }); }
    catch (error) { outcome = { passed: false, exitCode: null, errorCode: String(error.code ?? 'EXECUTOR_ERROR') }; }
    const completedAt = new Date().toISOString();
    const passed = outcome?.passed === true && outcome?.exitCode === 0 && outcome?.timedOut !== true;
    const artifact = { schemaVersion: 1, workspaceId: plan.workspaceId, changeId: plan.changeId,
      projectId: check.projectId, componentId: check.componentId, requirementId: check.requirementId,
      runId, commandFingerprint: `sha256:${digest(check.command)}`, completedAt,
      exitCode: Number.isInteger(outcome?.exitCode) ? outcome.exitCode : null,
      timedOut: outcome?.timedOut === true, durationMs: Number.isFinite(outcome?.durationMs) ? outcome.durationMs : null,
      stdoutHash: `sha256:${crypto.createHash('sha256').update(String(outcome?.stdout ?? '')).digest('hex')}`,
      stderrHash: `sha256:${crypto.createHash('sha256').update(String(outcome?.stderr ?? '')).digest('hex')}` };
    const evidenceId = `sha256:${digest(artifact)}`;
    evidence.push({ id: evidenceId, ...artifact });
    receipts.push(signLocalAssessmentReceipt({
      id: `assessment_receipt_${crypto.randomUUID()}`, workspaceId: plan.workspaceId,
      changeId: plan.changeId, projectId: check.projectId, componentId: check.componentId,
      requirementId: check.requirementId, kind: 'behavior', target: check.target,
      producerId: 'local-companion', runId, reviewHash: plan.reviewHash,
      status: passed ? 'passed' : 'failed', completedAt,
      evidenceIds: [evidenceId], exitCode: Number.isInteger(outcome?.exitCode) ? outcome.exitCode : null,
      timedOut: outcome?.timedOut === true, relevance: 'reviewed-command-only'
    }, signingKey));
  }
  const endingState = await loadCurrentState();
  const after = await assessLocalWorkspaceChange(selectionInput(assessment, endingState, visible(endingState)));
  const stillCurrent = reviewAssessmentChecks({ assessment: after, state: endingState, canRunProject }).reviewHash === plan.reviewHash;
  const ledgerAssessment = await assessLocalWorkspaceChange({ ...selectionInput(assessment, endingState, visible(endingState)),
    receipts, acceptReceipt: receipt => acceptLocalAssessmentEvidence(receipt, signingKey, evidence) });
  return { schemaVersion: 1, runId, reviewHash: plan.reviewHash, receipts, evidence,
    interrupted: receipts.length < plan.checks.length, sourceChangedDuringRun: !stillCurrent,
    ledger: ledgerAssessment.ledger, assessment: ledgerAssessment };
}
