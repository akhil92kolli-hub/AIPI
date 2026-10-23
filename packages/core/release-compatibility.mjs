// Read-only compatibility preview. The protected deployment controller must
// independently enforce an accepted decision for an exact deployment attempt.
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const pairKey = (producer, consumer, environmentId) => JSON.stringify([
  environmentId, producer.projectId, producer.sourceBindingId, producer.revision, producer.artifactDigest,
  consumer.projectId, consumer.sourceBindingId, consumer.revision, consumer.artifactDigest
]);

export function evaluateReleaseCompatibility(input = {}) {
  const now = Number(input.now ?? Date.now());
  const maxObservationAgeMs = Math.max(1, Number(input.maxObservationAgeMs ?? 3600000));
  const candidate = input.candidate ?? {};
  const dependencies = Array.isArray(input.dependencies) ? input.dependencies : [];
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const proofs = Array.isArray(input.proofs) ? input.proofs : [];
  const environmentId = input.environmentId ?? null;
  const acceptedObservation = record => {
    try { return input.acceptObservation?.(record) === true; } catch { return false; }
  };
  const acceptedProof = record => {
    try { return input.acceptProof?.(record) === true; } catch { return false; }
  };
  const current = observations.filter(record => record.environmentId === environmentId
    && record.cohort === 'deployed' && sha(record.revision) && record.sourceBindingId && record.artifactDigest
    && acceptedObservation(record) && Number.isFinite(Date.parse(record.observedAt))
    && now - Date.parse(record.observedAt) >= 0 && now - Date.parse(record.observedAt) <= maxObservationAgeMs);
  const pairs = [];
  for (const dependency of dependencies) {
    if (dependency.producerProjectId !== candidate.projectId) continue;
    const consumers = current.filter(record => record.projectId === dependency.consumerProjectId
      && (!dependency.consumerSourceBindingId || record.sourceBindingId === dependency.consumerSourceBindingId));
    if (!consumers.length) {
      pairs.push({ producerProjectId: candidate.projectId, producerRevision: candidate.revision ?? null,
        consumerProjectId: dependency.consumerProjectId, consumerRevision: null, cohort: 'Unknown deployed cohort',
        status: 'unknown', reason: 'No current trusted deployment observation for this consumer.' });
      continue;
    }
    for (const consumer of consumers) {
      const producer = { projectId: candidate.projectId, sourceBindingId: candidate.sourceBindingId,
        revision: candidate.revision, artifactDigest: candidate.artifactDigest };
      const matching = proofs.filter(proof => proof.environmentId === environmentId && pairKey(proof.producer ?? {}, proof.consumer ?? {}, environmentId) === pairKey(producer, consumer, environmentId)
        && ['passed', 'failed'].includes(proof.status) && acceptedProof(proof));
      const latestTime = Math.max(...matching.map(proof => Date.parse(proof.completedAt)).filter(Number.isFinite), -Infinity);
      const latest = matching.filter(proof => Date.parse(proof.completedAt) === latestTime);
      const result = latest.length === 1 ? latest[0] : null;
      const status = result?.status ?? 'unknown';
      pairs.push({ producerProjectId: candidate.projectId, producerRevision: candidate.revision ?? null,
        consumerProjectId: consumer.projectId, consumerRevision: consumer.revision,
        cohort: consumer.cohort, status, evidenceAccepted: Boolean(result), proofId: result?.id ?? null,
        reason: result ? status === 'passed' ? 'Accepted proof covers this exact deployed pair.' : 'Accepted proof reports an incompatible deployed pair.'
          : latest.length > 1 ? 'Conflicting latest proof records need authoritative ordering.' : 'No accepted proof covers this exact deployed pair.' });
    }
  }
  if (!environmentId) pairs.push({
    producerProjectId: candidate.projectId ?? null, producerRevision: candidate.revision ?? null,
    consumerProjectId: null, consumerRevision: null, cohort: 'Environment', status: 'unknown',
    reason: 'Select a deployment environment with trusted observations.' });
  if (!sha(candidate.revision) || !candidate.sourceBindingId || !candidate.artifactDigest) pairs.push({
    producerProjectId: candidate.projectId ?? null, producerRevision: candidate.revision ?? null,
    consumerProjectId: null, consumerRevision: null, cohort: 'Candidate', status: 'unknown',
    reason: 'Candidate needs a pinned commit, source binding and built artifact digest.' });
  if (!dependencies.length || input.discoveryComplete !== true) pairs.push({
    producerProjectId: candidate.projectId ?? null, producerRevision: candidate.revision ?? null,
    consumerProjectId: null, consumerRevision: null, cohort: 'Discovery', status: 'unknown',
    reason: 'Dependency discovery is incomplete; unmapped consumers may exist.' });
  const previewReady = pairs.length > 0 && pairs.every(pair => pair.status === 'passed');
  return { workspaceId: input.workspaceId ?? null, environment: { id: environmentId, name: input.environmentName ?? environmentId ?? 'Unbound' },
    candidate: { projectId: candidate.projectId ?? null, sourceBindingId: candidate.sourceBindingId ?? null,
      revision: candidate.revision ?? null, artifactDigest: candidate.artifactDigest ?? null },
    observations: current.map(record => ({ projectId: record.projectId, sourceBindingId: record.sourceBindingId,
      revision: record.revision, artifactDigest: record.artifactDigest, cohort: record.cohort,
      cohortId: record.cohortId ?? null, observedAt: record.observedAt })),
    pairs, previewReady, canDeploy: false, enforcement: { state: 'unavailable',
      reason: 'A protected deployment controller and current deployment generation must evaluate this exact candidate before release.' } };
}
