const SECRET_NAME = /(token|secret|password|authorization|cookie|api.?key|private.?key)/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;

export function isSecretName(name) {
  return SECRET_NAME.test(String(name ?? ""));
}

export function redactRecord(record = {}, headerMode = false) {
  const matcher = headerMode ? SECRET_HEADER : SECRET_NAME;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, matcher.test(key) ? "[REDACTED]" : value]));
}

export function normalizeRoute(value) {
  return String(value ?? "")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/\$\{[^}]+\}/g, ":param")
    .replace(/\[[^\]]+\]/g, ":param")
    .replace(/:[A-Za-z0-9_]+/g, ":param")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "") || "/";
}

export function compareRunEvidence(previous, current) {
  if (!previous || !current) throw new Error("Both previous and current runs are required");
  const previousResult = previous.result ?? previous;
  const currentResult = current.result ?? current;
  const previousAssertions = previousResult.assertions ?? [];
  const currentAssertions = currentResult.assertions ?? [];
  const previousPassed = previousAssertions.filter((entry) => entry.passed).length;
  const currentPassed = currentAssertions.filter((entry) => entry.passed).length;
  const statusChanged = previousResult.status !== currentResult.status;
  const latencyDeltaMs = Number(currentResult.elapsed_ms ?? 0) - Number(previousResult.elapsed_ms ?? 0);
  return {
    previousRunId: previous.id ?? null,
    currentRunId: current.id ?? null,
    status: { before: previousResult.status ?? null, after: currentResult.status ?? null, changed: statusChanged },
    success: { before: Boolean(previousResult.ok && previousResult.passed !== false), after: Boolean(currentResult.ok && currentResult.passed !== false) },
    assertions: { before: `${previousPassed}/${previousAssertions.length}`, after: `${currentPassed}/${currentAssertions.length}`, deltaPassed: currentPassed - previousPassed },
    latency: { beforeMs: previousResult.elapsed_ms ?? null, afterMs: currentResult.elapsed_ms ?? null, deltaMs: latencyDeltaMs },
    regression: Boolean(previousResult.ok && previousResult.passed !== false && (!currentResult.ok || currentResult.passed === false)),
    recovered: Boolean((!previousResult.ok || previousResult.passed === false) && currentResult.ok && currentResult.passed !== false)
  };
}

export function buildFixPlan(project, log, endpointContext = {}) {
  const result = log?.result ?? {};
  const diagnosis = result.diagnosis ?? {};
  const files = [endpointContext.consumer?.source, endpointContext.endpoint?.source, ...(endpointContext.schemas ?? []).map((entry) => entry.source)].filter(Boolean);
  const confidenceValues = [endpointContext.consumer?.confidence, endpointContext.endpoint?.confidence, ...(endpointContext.schemas ?? []).map((entry) => entry.confidence)].filter(Number.isFinite);
  const confidence = confidenceValues.length ? Math.round((confidenceValues.reduce((sum, entry) => sum + entry, 0) / confidenceValues.length) * 100) / 100 : .5;
  const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(log?.method);
  return {
    projectId: project.id,
    runId: log?.id ?? null,
    probableRootCause: diagnosis.summary ?? "The first failing layer needs confirmation from response and source evidence.",
    confidence,
    evidence: [
      result.status ? `HTTP ${result.status} in ${result.elapsed_ms ?? 0} ms` : result.error ?? "No HTTP response",
      `${result.assertions?.filter((entry) => entry.passed).length ?? 0}/${result.assertions?.length ?? 0} assertions passed`,
      ...files.map((file) => `Related source: ${file}`)
    ],
    affectedFiles: [...new Set(files)],
    changes: {
      frontend: endpointContext.consumer ? [`Review ${endpointContext.consumer.source}:${endpointContext.consumer.line}`] : [],
      backend: endpointContext.endpoint ? [`Review ${endpointContext.endpoint.source}:${endpointContext.endpoint.line}`] : [],
      schema: (endpointContext.schemas ?? []).map((entry) => `Verify ${entry.source}:${entry.line}`),
      tests: ["Add or update a native regression test for the observed request and assertions"]
    },
    verification: ["Run the affected native test", "Execute the saved API request", "Compare the new run with the failing run", "Rescan source and verify integration status"],
    risks: [unsafe ? "The request is state-changing; require approval before retrying." : "The request is safe to retry after reviewing the plan.", "Do not modify database migrations without explicit approval."],
    requiresApproval: true
  };
}
