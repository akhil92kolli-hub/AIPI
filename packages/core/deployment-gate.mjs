const revisionFor = (project) => project.sourceContext?.gitRevision ?? project.sourceContext?.git?.find((entry) => entry.commit)?.commit ?? project.sourceContext?.lastScannedAt ?? "unindexed";

export function activeEnvironmentTarget(project) {
  const environment = project.environments?.find((entry) => entry.id === project.activeEnvironmentId) ?? project.environments?.[0] ?? null;
  const service = environment?.services?.find((entry) => entry.enabled !== false && entry.baseUrl);
  const variable = environment?.variables?.find((entry) => entry.enabled !== false && /(?:base|service).*url/i.test(entry.key) && entry.value);
  return { environment, url: service?.baseUrl ?? variable?.value ?? null };
}

export async function evaluateDeploymentGate(project, task, options = {}) {
  const sourceRevision = revisionFor(project);
  const contractIds = new Set(task.contractIds ?? []);
  // Repository memory and task payloads can contain arbitrary receipt-shaped JSON.
  // Only an authorized evidence adapter may accept a receipt for this exact run.
  const claimedReceipts = (project.verificationReceipts ?? []).filter((entry) =>
    (entry.result === "Verified" || entry.status === "passed")
    && (entry.taskId === task.id || contractIds.has(entry.contractId)));
  const acceptedReceipts = claimedReceipts.filter((entry) => {
    try { return options.acceptReceipt?.(entry, { project, task, sourceRevision }) === true; }
    catch { return false; }
  });
  const receipt = acceptedReceipts.find((entry) => entry.sourceRevision === sourceRevision) ?? acceptedReceipts[0] ?? null;
  const driftedContracts = (project.contracts ?? []).filter((contract) => contractIds.has(contract.id) && /stale|mismatch|regress|drift/i.test(`${contract.state} ${contract.comparisonState}`)).map((contract) => ({ id: contract.id, method: contract.method, route: contract.route, state: contract.state ?? contract.comparisonState }));
  const revisionMatches = Boolean(receipt?.sourceRevision && receipt.sourceRevision === sourceRevision);
  const target = activeEnvironmentTarget(project);
  let health = { ok: false, status: null, url: target.url, error: target.url ? "Health checker unavailable." : "Active environment has no base URL." };
  if (target.url && typeof options.checkEnvironment === "function") {
    try {
      const result = await options.checkEnvironment(target.url, target.environment);
      const status = Number(result?.status);
      health = { ok: status >= 200 && status < 300, status: Number.isFinite(status) ? status : null, url: target.url, error: result?.error ?? null };
    } catch (error) { health = { ok: false, status: null, url: target.url, error: error.message }; }
  }
  // This local check cannot observe all deployed consumers or enforce a protected
  // deployment controller. A passing local preflight is only a preview.
  const preflightPassed = revisionMatches && health.ok && driftedContracts.length === 0;
  const unlocked = false;
  const reasons = [!receipt ? claimedReceipts.length ? "Receipt claim is not accepted by a trusted evidence producer." : "No passing VerificationReceipt is linked to this task." : !revisionMatches ? `Receipt revision ${receipt.sourceRevision} does not match ${sourceRevision}.` : null, !health.ok ? health.error ?? `Environment health returned HTTP ${health.status ?? "error"}.` : null, driftedContracts.length ? `${driftedContracts.length} linked contract(s) have unverified drift.` : null, "Deployed consumer versions and a protected deployment controller are not connected; deployment permission is unavailable."].filter(Boolean);
  return { unlocked, preflightPassed, enforcement: "unavailable", sourceRevision, receipt: receipt ? { id: receipt.id, sourceRevision: receipt.sourceRevision, verifiedAt: receipt.verifiedAt, result: receipt.result ?? receipt.status } : null, revisionMatches, environment: { id: target.environment?.id ?? null, name: target.environment?.name ?? "Unbound", ...health }, driftedContracts, reasons, checkedAt: new Date().toISOString() };
}
