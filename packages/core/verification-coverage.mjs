// Read-only domain projection. Callers must authenticate/authorize the source
// records before projection; a matching hash or producer label is not trust.
// No network, filesystem, execution, persistence, or user-supplied commands.
const states = ['passed', 'failed', 'missing', 'stale', 'unknown'];
const kinds = new Set(['behavior', 'contract', 'structure']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const array = (value, limit) => Array.isArray(value) && value.length <= limit;
const key = (...parts) => JSON.stringify(parts);
const aggregate = values => values.includes('failed') ? 'failed'
  : values.includes('stale') ? 'stale' : values.includes('unknown') ? 'unknown'
    : !values.length || values.includes('missing') ? 'missing' : 'passed';
const countsFor = rows => Object.fromEntries(states.map(state => [state, rows.filter(row => row.status === state).length]));
const unique = values => new Set(values).size === values.length;

// Whitelist pin fields. Full source, environment values, local paths and raw
// executor logs must never be copied into this domain projection.
function normalizedTarget(value) {
  if (!value || !text(value.planHash) || !text(value.checkFingerprint)
    || !text(value.environmentId) || !text(value.environmentFingerprint)
    || !array(value.revisionSet, 64) || !value.revisionSet.length
    || !array(value.contractRevisions, 512)) return null;
  const revisions = [];
  for (const pin of value.revisionSet) {
    if (!pin || !text(pin.projectId) || !text(pin.resourceId)
      || !text(pin.commit) || typeof pin.dirty !== 'boolean'
      || (pin.dirty && !text(pin.workingTreeFingerprint))) return null;
    revisions.push({ projectId: pin.projectId, resourceId: pin.resourceId,
      commit: pin.commit, dirty: pin.dirty,
      workingTreeFingerprint: pin.dirty ? pin.workingTreeFingerprint : null });
  }
  if (!unique(revisions.map(pin => key(pin.projectId, pin.resourceId)))) return null;
  revisions.sort((a, b) => key(a.projectId, a.resourceId).localeCompare(key(b.projectId, b.resourceId)));
  const contracts = [];
  for (const pin of value.contractRevisions) {
    if (!pin || !text(pin.projectId) || !text(pin.resourceId)
      || !text(pin.contractId) || !text(pin.revisionId)) return null;
    contracts.push({ projectId: pin.projectId, resourceId: pin.resourceId,
      contractId: pin.contractId, revisionId: pin.revisionId });
  }
  if (!unique(contracts.map(pin => key(pin.projectId, pin.resourceId, pin.contractId)))) return null;
  if (contracts.some(pin => !revisions.some(revision => revision.projectId === pin.projectId && revision.resourceId === pin.resourceId))) return null;
  contracts.sort((a, b) => key(a.projectId, a.resourceId, a.contractId).localeCompare(key(b.projectId, b.resourceId, b.contractId)));
  return { planHash: value.planHash, checkFingerprint: value.checkFingerprint,
    environmentId: value.environmentId, environmentFingerprint: value.environmentFingerprint,
    revisionSet: revisions, contractRevisions: contracts };
}

function decide(requirement, component, input, evaluatedAt, receiptIndex) {
  if (requirement.configured === false) return { status: 'missing', reason: 'Select and review an executable check for this obligation.' };
  const target = normalizedTarget(requirement.target);
  if (!target || !target.revisionSet.some(pin => pin.projectId === component.projectId)) {
    return { status: 'unknown', reason: 'Required execution target is incomplete.' };
  }
  for (const pin of target.revisionSet) {
    let allowed = false;
    try { allowed = input.canReadProject(pin.projectId) === true; } catch { /* deny */ }
    if (!allowed) return { status: 'unknown', reason: 'The full execution target is not accessible.' };
  }
  const matching = receiptIndex.get(key(component.projectId, component.componentId, requirement.id)) ?? [];
  const trusted = matching.filter(receipt => {
    // The transport/runner adapter validates producer provenance, permissions,
    // artifact availability and receipt integrity. Strict true disallows an
    // accidentally async predicate from granting trust to every Promise.
    try { return input.acceptReceipt(receipt) === true; } catch { return false; }
  });
  if (!trusted.length) return { status: matching.length ? 'unknown' : 'missing',
    reason: matching.length ? 'No acceptable producer evidence is available.' : 'This required check has no execution receipt.' };
  const normalized = trusted.map(receipt => ({
    receipt, target: normalizedTarget(receipt.target), completedAt: Date.parse(receipt.completedAt),
  }));
  if (normalized.some(entry => !text(entry.receipt.id) || !text(entry.receipt.producerId)
    || !entry.target || !Number.isFinite(entry.completedAt) || entry.completedAt > evaluatedAt
    || !array(entry.receipt.evidenceIds, 256) || entry.receipt.evidenceIds.some(id => !text(id)))) {
    return { status: 'unknown', reason: 'Accepted receipt records have incomplete or ambiguous execution metadata.' };
  }
  const signatures = new Map();
  for (const entry of normalized) {
    const signature = key(entry.target, entry.completedAt, entry.receipt.kind, entry.receipt.status,
      entry.receipt.producerId, [...new Set(entry.receipt.evidenceIds)].sort());
    if (signatures.has(entry.receipt.id) && signatures.get(entry.receipt.id) !== signature) {
      return { status: 'unknown', reason: 'Conflicting records use the same receipt identity.' };
    }
    signatures.set(entry.receipt.id, signature);
  }
  const current = normalized.filter(entry => key(entry.target) === key(target));
  if (!current.length) return { status: 'stale', reason: 'Available receipts apply to a different source, contract, plan, check or environment.' };
  current.sort((a, b) => b.completedAt - a.completedAt);
  const latest = current[0];
  const tied = current.filter(entry => entry.completedAt === latest.completedAt);
  if (new Set(tied.map(entry => entry.receipt.id)).size > 1) {
    return { status: 'unknown', reason: 'Concurrent receipt results need authoritative ordering.' };
  }
  const receipt = latest.receipt;
  const reference = { receiptId: receipt.id, producerId: receipt.producerId, completedAt: new Date(latest.completedAt).toISOString() };
  if (receipt.kind !== requirement.kind) return {
    ...reference, status: 'unknown', reason: 'The receipt does not establish the required kind of verification.' };
  if (['skipped', 'cancelled', 'pending'].includes(receipt.status)) return {
    ...reference, status: 'missing', reason: 'The latest attempt did not complete this required check.' };
  if (!['passed', 'failed'].includes(receipt.status)
    || !array(receipt.evidenceIds, 256) || !receipt.evidenceIds.length
    || receipt.evidenceIds.some(id => !text(id))) return {
    ...reference, status: 'unknown', reason: 'An executed check result with evidence references is required.' };
  if (receipt.kind === 'behavior' && receipt.status === 'passed' && receipt.relevance === 'reviewed-command-only') {
    let relevant = false;
    try { relevant = input.acceptRelevance?.(receipt) === true; } catch { /* deny */ }
    if (!relevant) return { ...reference, status: 'unknown',
      reason: 'The reviewed check passed, but its relevance to this affected behavior remains unproven.',
      evidenceIds: [...new Set(receipt.evidenceIds)] };
  }
  return { ...reference, status: receipt.status,
    reason: receipt.status === 'passed' ? receipt.kind === 'behavior' && receipt.relevance === 'reviewed-command-only'
      ? 'This check passed for the exact target and has accepted defect/repair relevance evidence.'
      : 'This check passed for the exact reviewed target.' : 'This check failed for the exact reviewed target.',
    evidenceIds: [...new Set(receipt.evidenceIds)] };
}

/**
 * Build an honest, bounded coverage ledger from pre-authorized records.
 * canReadProject and acceptReceipt are required synchronous trusted callbacks.
 * This function is a projection, never an authorization or merge/deploy gate.
 * Components require a behavior obligation unless requiresBehavior === false
 * was explicitly selected by the application for a non-behavioral change.
 * analysis.complete describes discovery coverage, not passing test results.
 */
export function buildVerificationCoverageLedger(input) {
  if (!input || !text(input.workspaceId) || !text(input.changeId)
    || !array(input.components, 1000) || !array(input.receipts, 10000)
    || typeof input.canReadProject !== 'function' || typeof input.acceptReceipt !== 'function'
    || (input.acceptRelevance !== undefined && typeof input.acceptRelevance !== 'function')) {
    throw new TypeError('Scoped coverage inputs and explicit access/evidence policies are required.');
  }
  const evaluatedAt = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAt)) throw new TypeError('A valid evaluation timestamp is required.');
  let restrictedScope = false;
  const receiptIndex = new Map();
  for (const receipt of input.receipts) {
    if (!receipt || receipt.workspaceId !== input.workspaceId || receipt.changeId !== input.changeId) continue;
    const identity = key(receipt.projectId, receipt.componentId, receipt.requirementId);
    const entries = receiptIndex.get(identity) ?? [];
    entries.push(receipt); receiptIndex.set(identity, entries);
  }
  const components = [];
  const componentKeys = new Set();
  for (const component of input.components) {
    let allowed = false;
    try { allowed = component && input.canReadProject(component.projectId) === true; } catch { /* deny */ }
    if (!allowed) { restrictedScope = true; continue; }
    if (!text(component.projectId) || !text(component.componentId)
      || !array(component.requirements, 256)) throw new TypeError('Invalid authorized component or obligation list.');
    const identity = key(component.projectId, component.componentId);
    if (componentKeys.has(identity)) throw new TypeError('Duplicate authorized component identity.');
    componentKeys.add(identity);
    const requirementIds = new Set();
    const checks = component.requirements.map(requirement => {
      if (!requirement || !text(requirement.id) || requirementIds.has(requirement.id)) {
        throw new TypeError('Invalid or duplicate authorized obligation identity.');
      }
      requirementIds.add(requirement.id);
      return { requirementId: requirement.id, kind: kinds.has(requirement.kind) ? requirement.kind : 'unknown',
        required: requirement.required !== false,
        ...(kinds.has(requirement.kind) ? decide(requirement, component, input, evaluatedAt, receiptIndex)
          : { status: 'unknown', reason: 'The required check classification is unsupported.' }) };
    });
    if (!checks.some(check => check.required)) checks.push({ requirementId: null, kind: 'unknown', required: true,
      status: 'missing', reason: 'No required checks are configured for this affected component.' });
    if (component.requiresBehavior !== false && !checks.some(check => check.required && check.kind === 'behavior')) {
      checks.push({ requirementId: null, kind: 'behavior', required: true, status: 'missing',
        reason: 'Behavior verification is required; structural or indexing evidence alone is insufficient.' });
    }
    const required = checks.filter(check => check.required);
    const reasons = [];
    if (component.confidence !== 'confirmed') reasons.push('This component impact has not been confirmed.');
    components.push({ projectId: component.projectId, componentId: component.componentId,
      status: aggregate([...required.map(check => check.status), ...(reasons.length ? ['unknown'] : [])]),
      checks, reasons, counts: countsFor(required) });
  }
  const limitations = [];
  if (!components.length) limitations.push('No readable affected components with required verification are available.');
  if (restrictedScope) limitations.push('Some change scope is inaccessible; full coverage cannot be established.');
  if (input.analysis?.complete !== true || !array(input.analysis?.gaps, 1000) || input.analysis.gaps.length) {
    // Intentionally do not project source gap labels/paths that may disclose an
    // unauthorized resource. Adapters may expose separately authorized details.
    limitations.push('Dependency discovery is incomplete or has unresolved analysis gaps.');
  }
  const checks = components.flatMap(component => component.checks.filter(check => check.required));
  const allRequiredChecksPassed = checks.length > 0 && checks.every(check => check.status === 'passed');
  const status = aggregate([...components.map(component => component.status), ...(limitations.length ? ['unknown'] : [])]);
  return { schemaVersion: 1, workspaceId: input.workspaceId, changeId: input.changeId,
    evaluatedAt: new Date(evaluatedAt).toISOString(), status, complete: status === 'passed',
    allRequiredChecksPassed, components, limitations, counts: countsFor(checks),
    scope: 'Results cover only the listed checks and exact execution targets; they do not establish universal safety.' };
}
