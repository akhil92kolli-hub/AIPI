import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { captureChangeDiff } from './change-diff.mjs';

const sha = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const limited = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
const resourceKey = (projectId, resourceId) => JSON.stringify([projectId, resourceId]);
const portablePath = value => {
  if (typeof value !== 'string' || value.length > 512 || value.includes('\0') || path.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
};

// Secrets in configured command arguments are impossible to identify reliably.
// Portable export therefore needs an explicit per-project source-sharing flag.
// The exported command remains visible for human review and must never run on
// import until a new local approval has been granted.
export function createVerificationPackageManifest({ assessment, review, state,
  canShareProject = () => false, receiptIds = [] }) {
  if (!assessment?.workspaceId || !review?.reviewHash || !state
    || review.workspaceId !== assessment.workspaceId || review.changeId !== assessment.changeId
    || typeof canShareProject !== 'function' || !Array.isArray(receiptIds) || receiptIds.length > 256) {
    fail('A current assessment, reviewed plan and sharing policy are required.');
  }
  const group = state.workspaceGroups?.find(item => item.id === assessment.workspaceId);
  if (!group) fail('Workspace unavailable.', 404);
  const resources = [];
  const gaps = [...review.gaps];
  for (const pin of assessment.revisionSet ?? []) {
    if (!group.projectIds.includes(pin.projectId) || canShareProject(pin.projectId, state) !== true) {
      gaps.push('A participating resource is not approved for package sharing.');
      continue;
    }
    const project = state.projects?.find(item => item.id === pin.projectId);
    const root = project?.sourceContext?.roots?.find(item => (item.resourceId ?? item.id) === pin.resourceId);
    if (!root) { gaps.push('A participating source root is unavailable.'); continue; }
    if (pin.dirty) gaps.push('Dirty source needs an approved content snapshot; a fingerprint cannot reproduce it.');
    resources.push({ projectId: pin.projectId, resourceId: pin.resourceId, commit: pin.commit,
      dirty: pin.dirty, workingTreeFingerprint: pin.workingTreeFingerprint ?? null,
      sourceKind: root.kind ?? 'workspace', bindingRequired: true });
  }
  const resourceKeys = new Set(resources.map(item => resourceKey(item.projectId, item.resourceId)));
  const checks = [];
  for (const check of review.checks ?? []) {
    if (!resourceKeys.has(resourceKey(check.projectId, check.sourceResourceId))) {
      gaps.push('A reviewed check has no shareable source resource.'); continue;
    }
    const cwd = portablePath(check.command?.cwd ?? '.');
    if (!cwd || !limited(check.command?.command)
      || !Array.isArray(check.command?.args) || check.command.args.some(arg => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0'))) {
      gaps.push('A reviewed command cannot be represented as a portable argument array.'); continue;
    }
    const declaredVariables = state.projects.find(item => item.id === check.projectId)?.verification?.requiredEnvironmentVariables;
    checks.push({ projectId: check.projectId, resourceId: check.sourceResourceId,
      componentId: check.componentId, requirementId: check.requirementId, kind: check.kind,
      command: { executable: check.command.command, args: [...check.command.args], cwd,
        timeoutMs: check.command.timeoutMs }, target: structuredClone(check.target),
      requiredVariableNames: [...new Set(Array.isArray(declaredVariables) ? declaredVariables : [])]
        .filter(name => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)).sort() });
  }
  resources.sort((a, b) => resourceKey(a.projectId, a.resourceId).localeCompare(resourceKey(b.projectId, b.resourceId)));
  checks.sort((a, b) => JSON.stringify([a.projectId, a.componentId, a.requirementId]).localeCompare(JSON.stringify([b.projectId, b.componentId, b.requirementId])));
  const uniqueGaps = [...new Set(gaps)];
  const manifest = { schemaVersion: 1, kind: 'aipi.verification-package', workspaceId: assessment.workspaceId,
    changeId: assessment.changeId, reviewHash: review.reviewHash, comparison: {
      mode: assessment.comparison.mode, baseCommit: assessment.comparison.baseCommit,
      headCommit: assessment.comparison.headCommit }, resources, checks,
    receiptIds: [...new Set(receiptIds.filter(limited))].sort(),
    sourceReproducible: resources.length === assessment.revisionSet.length && resources.every(item => !item.dirty),
    complete: uniqueGaps.length === 0 && checks.length > 0 && resources.length === assessment.revisionSet.length,
    gaps: uniqueGaps,
    importPolicy: 'Validate checkout pins and prerequisites; never auto-install or auto-run imported commands.' };
  return { ...manifest, manifestHash: sha(JSON.stringify(manifest)) };
}

async function executableAvailable(name, env) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/.test(name)) return false;
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean).slice(0, 100);
  for (const dir of dirs) {
    try { await fs.access(path.join(dir, name), fs.constants.X_OK); return true; }
    catch { /* next directory */ }
  }
  return false;
}

async function containedCwd(root, relative) {
  const normalized = portablePath(relative);
  if (!normalized || !limited(root)) return false;
  try {
    const realRoot = await fs.realpath(root);
    const realCwd = await fs.realpath(path.resolve(realRoot, normalized));
    const inside = path.relative(realRoot, realCwd);
    return inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside);
  } catch { return false; }
}

/** Read-only import preflight. Bindings come from the importing user's local
 * checkout selection. No command, dependency installer or imported script is
 * executed. Absolute bindings never appear in returned diagnostics. */
export async function diagnoseVerificationPackage(manifest, bindings, { env = process.env } = {}) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== 'aipi.verification-package'
    || !Array.isArray(manifest.resources) || manifest.resources.length > 64
    || !Array.isArray(manifest.checks) || manifest.checks.length > 100
    || !Array.isArray(bindings) || bindings.length > 64) fail('A bounded verification package and checkout bindings are required.');
  const { manifestHash, ...unsigned } = manifest;
  if (manifestHash !== sha(JSON.stringify(unsigned))) fail('Verification package content changed after export.', 409);
  const bindingMap = new Map();
  for (const binding of bindings) {
    const key = resourceKey(binding?.projectId, binding?.resourceId);
    if (bindingMap.has(key)) fail('Duplicate local checkout binding.');
    bindingMap.set(key, binding?.root);
  }
  const resources = [], checks = [], gaps = [...manifest.gaps];
  for (const resource of manifest.resources) {
    const key = resourceKey(resource.projectId, resource.resourceId);
    const root = bindingMap.get(key);
    if (!limited(root)) { resources.push({ projectId: resource.projectId, resourceId: resource.resourceId,
      status: 'missing', correction: 'Bind this resource to a local checkout.' }); continue; }
    try {
      const capture = await captureChangeDiff({ root, projectId: resource.projectId, resourceId: resource.resourceId,
        baseRef: resource.commit });
      const matches = capture.diffComplete && capture.headCommit === resource.commit && capture.dirty === resource.dirty
        && (!resource.dirty || capture.revisionPin?.workingTreeFingerprint === resource.workingTreeFingerprint);
      resources.push({ projectId: resource.projectId, resourceId: resource.resourceId,
        status: matches ? 'ready' : 'stale', correction: matches ? null : 'Use the exact committed source and approved snapshot for this resource.' });
    } catch {
      resources.push({ projectId: resource.projectId, resourceId: resource.resourceId,
        status: 'unknown', correction: 'Select an accessible Git checkout containing the pinned commit.' });
    }
  }
  for (const check of manifest.checks) {
    const missingVariables = (check.requiredVariableNames ?? []).filter(name => !Object.prototype.hasOwnProperty.call(env, name));
    const executable = await executableAvailable(check.command?.executable, env);
    const source = resources.find(item => item.projectId === check.projectId && item.resourceId === check.resourceId);
    const cwdValid = await containedCwd(bindingMap.get(resourceKey(check.projectId, check.resourceId)), check.command?.cwd);
    const available = source?.status === 'ready' && executable && cwdValid && missingVariables.length === 0;
    checks.push({ projectId: check.projectId, resourceId: check.resourceId, componentId: check.componentId,
      requirementId: check.requirementId, status: available ? 'ready' : 'missing',
      missingVariableNames: missingVariables, executableAvailable: executable, cwdContained: cwdValid,
      correction: available ? null : !executable ? 'Install or select the required executable locally.'
        : !cwdValid ? 'Select an existing command directory inside the bound checkout.'
          : missingVariables.length ? 'Provide the named environment variables locally.' : 'Bind the exact source revision first.' });
  }
  const ready = manifest.complete && manifest.sourceReproducible
    && resources.length > 0 && resources.every(item => item.status === 'ready')
    && checks.length > 0 && checks.every(item => item.status === 'ready');
  return { schemaVersion: 1, manifestHash, ready, resources, checks, gaps,
    note: 'Preflight checks inputs only. Reproduction requires explicit local review and execution; no check ran.' };
}
