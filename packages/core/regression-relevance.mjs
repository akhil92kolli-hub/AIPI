import crypto from 'node:crypto';
import { verifyLocalAssessmentReceipt } from './assessment-proof.mjs';

const hash = value => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const keyFor = value => JSON.stringify([value.projectId, value.componentId, value.requirementId]);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const deny = message => { throw new TypeError(message); };
const orderedPins = pins => Array.isArray(pins) ? [...pins].sort((a, b) =>
  JSON.stringify([a.projectId, a.resourceId]).localeCompare(JSON.stringify([b.projectId, b.resourceId]))) : [];

function validManifest(manifest) {
  if (!manifest || manifest.kind !== 'aipi.verification-package' || manifest.schemaVersion !== 1
    || manifest.complete !== true || manifest.sourceReproducible !== true
    || !Array.isArray(manifest.resources) || !manifest.resources.length
    || !Array.isArray(manifest.checks) || !manifest.checks.length || manifest.checks.length > 100) return false;
  const { manifestHash, ...content } = manifest;
  return manifestHash === hash(content);
}

/** Sign the observed fail→pass contrast from two explicitly executed, clean-source
 * package imports. The caller must be the trusted local runner; this function
 * never executes a command or authenticates a remote CI producer. */
export function attestLocalRegressionRelevance({ knownBad, repaired, knownBadResults,
  repairedResults, knownBadReceipts, repairedReceipts, signingKey }) {
  if (!Buffer.isBuffer(signingKey) || signingKey.length < 32
    || !validManifest(knownBad) || !validManifest(repaired)
    || knownBad.workspaceId !== repaired.workspaceId || knownBad.changeId !== repaired.changeId
    || !Array.isArray(knownBadResults) || !Array.isArray(repairedResults)
    || !Array.isArray(knownBadReceipts) || !Array.isArray(repairedReceipts))
    deny('Two complete, signed-run package inputs are required.');
  const badChecks = new Map(knownBad.checks.map(check => [keyFor(check), check]));
  const repairedChecks = new Map(repaired.checks.map(check => [keyFor(check), check]));
  if (badChecks.size !== knownBad.checks.length || repairedChecks.size !== repaired.checks.length
    || badChecks.size !== repairedChecks.size) deny('The two packages must contain the same distinct checks.');
  const badOutcomes = new Map(knownBadResults.map(result => [keyFor(result), result]));
  const repairedOutcomes = new Map(repairedResults.map(result => [keyFor(result), result]));
  const failedReceipts = new Map(knownBadReceipts.map(receipt => [keyFor(receipt), receipt]));
  const receipts = new Map(repairedReceipts.map(receipt => [keyFor(receipt), receipt]));
  if (badOutcomes.size !== knownBadResults.length || repairedOutcomes.size !== repairedResults.length
    || failedReceipts.size !== knownBadReceipts.length || failedReceipts.size !== badChecks.size
    || receipts.size !== repairedReceipts.length || receipts.size !== repairedChecks.size)
    deny('Each check needs one defective run, one repaired run and one repaired receipt.');
  const contrasts = [];
  for (const [identity, fixed] of repairedChecks) {
    const broken = badChecks.get(identity), badResult = badOutcomes.get(identity), fixedResult = repairedOutcomes.get(identity);
    const failedReceipt = failedReceipts.get(identity), receipt = receipts.get(identity);
    if (!broken || !badResult || !fixedResult || !failedReceipt || !receipt
      || !same(broken.command, fixed.command)
      || !same(broken.requiredVariableNames, fixed.requiredVariableNames)
      || broken.target?.checkFingerprint !== fixed.target?.checkFingerprint
      || broken.target?.environmentId !== fixed.target?.environmentId
      || broken.target?.environmentFingerprint !== fixed.target?.environmentFingerprint
      || !same(broken.target?.contractRevisions, fixed.target?.contractRevisions)
      || !same(orderedPins(broken.target?.revisionSet).map(pin => [pin.projectId, pin.resourceId]),
        orderedPins(fixed.target?.revisionSet).map(pin => [pin.projectId, pin.resourceId]))
      || same(orderedPins(broken.target?.revisionSet), orderedPins(fixed.target?.revisionSet))
      || badResult.passed !== false || !Number.isInteger(badResult.exitCode) || badResult.exitCode === 0
      || fixedResult.passed !== true || fixedResult.exitCode !== 0
      || badResult.timedOut === true || fixedResult.timedOut === true
      || badResult.behaviorAssertionObserved !== true || fixedResult.passMarkerObserved !== true
      || !/^sha256:[a-f0-9]{64}$/.test(badResult.outputHash ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(fixedResult.outputHash ?? '')
      || !verifyLocalAssessmentReceipt(failedReceipt, signingKey)
      || failedReceipt.status !== 'failed' || !failedReceipt.evidenceIds?.length
      || !same(failedReceipt.target, broken.target)
      || !knownBad.receiptIds.includes(failedReceipt.id)
      || !verifyLocalAssessmentReceipt(receipt, signingKey)
      || receipt.status !== 'passed' || !receipt.evidenceIds?.length
      || receipt.relevance !== 'reviewed-command-only'
      || !same(receipt.target, fixed.target) || !repaired.receiptIds.includes(receipt.id))
      deny('The defect and repair must run the same reviewed check under comparable targets with signed repaired evidence.');
    contrasts.push({ projectId: fixed.projectId, componentId: fixed.componentId,
      requirementId: fixed.requirementId, receiptId: receipt.id,
      defectiveReceiptId: failedReceipt.id,
      targetHash: hash(fixed.target), defectiveOutputHash: badResult.outputHash,
      repairedOutputHash: fixedResult.outputHash, behaviorAssertionObserved: true,
      repairedPassMarkerObserved: true, defectiveExitCode: badResult.exitCode,
      repairedExitCode: fixedResult.exitCode });
  }
  const body = { schemaVersion: 1, kind: 'aipi.local-regression-relevance',
    workspaceId: repaired.workspaceId, changeId: repaired.changeId,
    knownBadManifestHash: knownBad.manifestHash, repairedManifestHash: repaired.manifestHash,
    contrasts: contrasts.sort((a, b) => keyFor(a).localeCompare(keyFor(b))),
    scope: 'The same reviewed checks failed on the defective package and passed on the repaired package; dependency discovery remains separate.' };
  const id = hash(body);
  return { ...body, id, signature: crypto.createHmac('sha256', signingKey).update(id).digest('hex') };
}

export function acceptLocalRegressionRelevance(receipt, attestation, signingKey) {
  if (!Buffer.isBuffer(signingKey) || signingKey.length < 32 || !attestation
    || attestation.kind !== 'aipi.local-regression-relevance' || attestation.schemaVersion !== 1
    || !Array.isArray(attestation.contrasts) || !attestation.contrasts.length || attestation.contrasts.length > 100
    || !/^[a-f0-9]{64}$/.test(attestation.signature ?? '')
    || !verifyLocalAssessmentReceipt(receipt, signingKey)) return false;
  const { id, signature, ...body } = attestation;
  if (id !== hash(body) || !crypto.timingSafeEqual(Buffer.from(signature, 'hex'),
    crypto.createHmac('sha256', signingKey).update(id).digest())) return false;
  return attestation.workspaceId === receipt.workspaceId && attestation.changeId === receipt.changeId
    && receipt.status === 'passed' && receipt.relevance === 'reviewed-command-only'
    && attestation.contrasts.some(item => item.projectId === receipt.projectId
      && item.componentId === receipt.componentId && item.requirementId === receipt.requirementId
      && item.receiptId === receipt.id && item.targetHash === hash(receipt.target));
}
