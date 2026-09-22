import { normalizeRoute } from "../core/index.mjs";

export function endpointContext(project, endpointId) {
  const source = project.sourceContext ?? {};
  const endpoint = (source.endpoints ?? []).find((entry) => entry.id === endpointId);
  if (!endpoint) return null;
  const integrations = (source.integrations ?? []).filter((entry) => entry.endpointId === endpointId);
  const consumers = integrations.map((integration) => (source.frontendCalls ?? []).find((entry) => entry.id === integration.callId)).filter(Boolean);
  const schemas = source.schemas ?? [];
  const requests = (project.requests ?? []).filter((entry) => entry.method === endpoint.method && normalizeRoute(entry.url) === normalizeRoute(endpoint.path));
  return {
    endpoint,
    consumers,
    schemas,
    integrations,
    requests: requests.map((entry) => ({ id: entry.id, name: entry.name, assertions: entry.assertions?.length ?? 0 })),
    evidence: {
      source: `${endpoint.source}:${endpoint.line}`,
      detectionMethod: endpoint.framework ? `${endpoint.framework} adapter` : "source pattern",
      confidence: endpoint.confidence ?? 0,
      lastScanAt: source.lastScannedAt ?? null,
      userConfirmed: false
    }
  };
}

export function integrationIssues(project, history = []) {
  const source = project.sourceContext ?? {};
  const issues = [...(source.findings ?? [])];
  for (const request of project.requests ?? []) {
    const latest = history.find((entry) => entry.projectId === project.id && entry.requestId === request.id);
    if (latest && (!latest.result?.ok || latest.result?.passed === false)) {
      issues.push({ id: `run:${latest.id}`, type: "failing", severity: "high", title: `${request.name} failed its latest run`, requestId: request.id, logId: latest.id });
    } else if (!latest) {
      issues.push({ id: `untested:${request.id}`, type: "untested", severity: "medium", title: `${request.name} has no recorded run`, requestId: request.id });
    }
  }
  return issues;
}
