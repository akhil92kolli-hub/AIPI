import { assessLocalWorkspaceChange } from './change-assessment.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const evidenceKeyFile = dataDirectory => path.join(dataDirectory, 'assessment-evidence.key');

export async function readLocalAssessmentEvidenceKey(dataDirectory) {
  const file = evidenceKeyFile(dataDirectory);
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The local assessment evidence key is unavailable.');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('The local assessment evidence key permissions are too broad.');
  const raw = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error('The local assessment evidence key is invalid.');
  return Buffer.from(raw, 'hex');
}

export async function getOrCreateLocalAssessmentEvidenceKey(dataDirectory) {
  const existing = await readLocalAssessmentEvidenceKey(dataDirectory);
  if (existing) return existing;
  const created = crypto.randomBytes(32).toString('hex');
  try { await fs.writeFile(evidenceKeyFile(dataDirectory), created, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readLocalAssessmentEvidenceKey(dataDirectory);
}

// Assessment reads the accepted snapshot directly. The general loadState path
// hydrates/bootstrap-migrates records and can persist regenerated artifacts,
// which would violate this operation's read-only contract.
export async function readLocalAssessmentSnapshot(dataDirectory) {
  let value;
  try { value = JSON.parse(await fs.readFile(path.join(dataDirectory, 'workspace.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Initialize a local workspace before assessing changes.'), { statusCode: 404 });
    throw error;
  }
  if (!value || !Array.isArray(value.projects)) throw new Error('The local workspace snapshot is invalid.');
  return value;
}

export const CHANGE_ASSESSMENT_TOOLS = [{
  name: 'assess_workspace_change', title: 'Assess an actual workspace change',
  description: 'Read a registered local Git diff against an explicit baseline, map potential affected components through indexed/reviewed dependencies, and list unproven checks. Does not execute tests, replay APIs, fetch remote Git refs or establish deployment safety.',
  inputSchema: { type: 'object', required: ['workspace_id', 'project_id', 'base_ref'], properties: {
    workspace_id: { type: 'string', minLength: 1, maxLength: 512 }, project_id: { type: 'string', minLength: 1, maxLength: 512 },
    base_ref: { type: 'string', minLength: 1, maxLength: 512 }, head_ref: { type: 'string', minLength: 1, maxLength: 512 },
    mode: { type: 'string', enum: ['working-tree', 'staged', 'unstaged', 'commits'], default: 'working-tree' },
    root_index: { type: 'integer', minimum: 0, maximum: 31, default: 0 }, change_id: { type: 'string', minLength: 1, maxLength: 512 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
}];

export function summarizeChangeAssessment(assessment, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Assessment page limit must be between 1 and 50.');
  return { schemaVersion: assessment.schemaVersion, workspaceId: assessment.workspaceId, changeId: assessment.changeId,
    evaluatedAt: assessment.evaluatedAt, comparison: { mode: assessment.comparison.mode,
      baseCommit: assessment.comparison.baseCommit, headCommit: assessment.comparison.headCommit,
      dirty: assessment.comparison.dirty, snapshotFingerprint: assessment.comparison.snapshotFingerprint,
      diffComplete: assessment.comparison.diffComplete, totalChangedFiles: assessment.comparison.totalChangedFiles,
      files: assessment.comparison.files.slice(0, limit), gaps: assessment.comparison.gaps },
    components: assessment.components.slice(0, limit).map(component => ({
      projectId: component.projectId, componentId: component.componentId, label: component.label, kind: component.kind,
      confidence: component.confidence, changed: component.changed, changeLocation: component.changeLocation,
      source: component.source,
      paths: component.paths.slice(0, 3), candidateCheck: component.candidateCheck,
      obligations: component.requirements.map(check => ({ id: check.id, kind: check.kind, configured: check.configured,
        planHash: check.target.planHash, checkFingerprint: check.target.checkFingerprint })),
      coverage: assessment.ledger.components.find(row => row.projectId === component.projectId && row.componentId === component.componentId),
    })),
    verification: { status: assessment.ledger.status, complete: assessment.ledger.complete,
      counts: assessment.ledger.counts, limitations: assessment.ledger.limitations },
    analysis: assessment.analysis, unmappedFiles: assessment.unmappedFiles.slice(0, limit),
    omitted: { files: Math.max(0, assessment.comparison.totalChangedFiles - limit),
      components: Math.max(0, assessment.components.length - limit), unmappedFiles: Math.max(0, assessment.unmappedFiles.length - limit) },
    execution: assessment.execution, identityLimitations: assessment.identityLimitations, coverage: assessment.coverage };
}

export async function runLocalChangeAssessmentTool(state, args, canReadProject, acceptReceipt = () => false) {
  const allowed = new Set(Object.keys(CHANGE_ASSESSMENT_TOOLS[0].inputSchema.properties));
  const invalid = message => Object.assign(new TypeError(message), { statusCode: 400 });
  if (!args || typeof args !== 'object' || Object.keys(args).some(key => !allowed.has(key))) throw invalid('Unsupported change-assessment arguments.');
  const limit = args.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid('Assessment page limit must be between 1 and 50.');
  try {
    return summarizeChangeAssessment(await assessLocalWorkspaceChange({ state,
      workspaceId: args.workspace_id, projectId: args.project_id, baseRef: args.base_ref,
      headRef: args.head_ref, mode: args.mode ?? 'working-tree', rootIndex: args.root_index ?? 0,
      changeId: args.change_id, canReadProject,
      receipts: state.changeVerificationReceipts ?? [], acceptReceipt }), limit);
  } catch (error) {
    if (error instanceof TypeError && !error.statusCode) error.statusCode = 400;
    throw error;
  }
}
