import crypto from "node:crypto";

const SECRET_NAME = /(token|secret|password|passphrase|authorization|cookie|api.?key|private.?key)/i;
const VALID_TYPES = new Set(["run", "scan", "change", "agent", "contract", "decision", "project", "security", "ci"]);
const VALID_SEVERITIES = new Set(["success", "info", "warning", "danger"]);

function bounded(value, key = "", depth = 0) {
  if (SECRET_NAME.test(key)) return "[REDACTED]";
  if (depth >= 6) return "[BOUNDED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => bounded(entry, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([entryKey, entry]) => [entryKey, bounded(entry, entryKey, depth + 1)]));
  }
  if (typeof value === "string") return value.slice(0, 4_000);
  return value;
}

export function createTimelineEvent(entry = {}) {
  const createdAt = entry.createdAt || new Date().toISOString();
  return {
    id: entry.id || `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    projectId: entry.projectId,
    createdAt,
    type: VALID_TYPES.has(entry.type) ? entry.type : "change",
    severity: VALID_SEVERITIES.has(entry.severity) ? entry.severity : "info",
    actor: String(entry.actor || "aipi").slice(0, 80),
    title: String(entry.title || "Project event").slice(0, 240),
    summary: String(entry.summary || "").slice(0, 2_000),
    tags: [...new Set((entry.tags ?? []).map((tag) => String(tag).slice(0, 60)))].slice(0, 12),
    source: bounded(entry.source ?? {}),
    evidence: bounded(entry.evidence ?? {})
  };
}

function runEvent(log) {
  const result = log.result ?? {};
  const passed = Boolean(result.ok && result.passed !== false && !result.error);
  return createTimelineEvent({
    id: `evt_${log.id}`,
    projectId: log.projectId,
    createdAt: log.createdAt,
    type: "run",
    severity: passed ? "success" : "danger",
    actor: "aipi",
    title: `${log.requestName || "API request"} ${passed ? "succeeded" : "failed"}`,
    summary: result.status ? `HTTP ${result.status} · ${log.method} ${log.url}` : (result.error || `${log.method} ${log.url}`),
    tags: [log.method, result.status ? `HTTP ${result.status}` : "network"].filter(Boolean),
    source: { kind: "run", ref: log.id, requestId: log.requestId },
    evidence: {
      status: result.status ?? null,
      elapsedMs: result.elapsed_ms ?? null,
      attempts: result.attempts ?? 1,
      assertionsPassed: (result.assertions ?? []).filter((assertion) => assertion.passed).length,
      assertionsTotal: (result.assertions ?? []).length,
      diagnosis: result.diagnosis?.category ?? null,
      contractStatus: result.contractDiff?.status ?? null
    }
  });
}

function legacyActivityEvent(entry) {
  return createTimelineEvent({
    id: entry.id ? `evt_${entry.id}` : undefined,
    projectId: entry.projectId,
    createdAt: entry.createdAt,
    type: entry.kind === "mcp" ? "agent" : entry.kind === "api" ? "scan" : entry.kind === "project" ? "project" : "change",
    severity: entry.tone,
    actor: entry.actor || (entry.kind === "mcp" ? "agent" : "aipi"),
    title: entry.title,
    summary: entry.detail || entry.summary,
    source: entry.route ? { route: entry.route } : {},
    evidence: entry.evidence
  });
}

export function migrateTimeline(state) {
  const events = [...(state.timeline ?? [])].map(createTimelineEvent);
  const ids = new Set(events.map((event) => event.id));
  for (const log of state.history ?? []) {
    const event = runEvent(log);
    if (!ids.has(event.id)) { events.push(event); ids.add(event.id); }
  }
  for (const entry of state.activity ?? []) {
    const event = legacyActivityEvent(entry);
    if (!ids.has(event.id)) { events.push(event); ids.add(event.id); }
  }
  return events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function appendTimelineEvent(state, entry) {
  state.timeline ??= [];
  const event = createTimelineEvent(entry);
  if (!event.projectId) throw new Error("Timeline events require projectId");
  if (!state.timeline.some((existing) => existing.id === event.id)) state.timeline.unshift(event);
  return event;
}

export function timelineForProject(state, projectId, options = {}) {
  const allowedTypes = new Set(options.types ?? []);
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const before = options.before ? new Date(options.before).getTime() : Number.POSITIVE_INFINITY;
  return (state.timeline ?? [])
    .filter((event) => event.projectId === projectId)
    .filter((event) => !allowedTypes.size || allowedTypes.has(event.type))
    .filter((event) => new Date(event.createdAt).getTime() < before)
    .slice(0, limit);
}

function comparableProject(project) {
  if (!project) return null;
  return {
    name: project.name,
    description: project.description,
    activeEnvironmentId: project.activeEnvironmentId,
    environments: (project.environments ?? []).map((environment) => ({ id: environment.id, name: environment.name, variables: (environment.variables ?? []).map((variable) => ({ key: variable.key, enabled: variable.enabled, secret: variable.secret, hasValue: Boolean(variable.value) })) })),
    requests: (project.requests ?? []).map((request) => ({ id: request.id, name: request.name, method: request.method, url: request.url, assertions: request.assertions?.length ?? 0, authType: request.auth?.type ?? "none" })),
    roots: (project.sourceContext?.roots ?? []).map((root) => ({ kind: root.kind, path: root.path })),
    goal: project.summary?.goal ?? ""
  };
}

export function workspaceChangeEvent(previousState, nextState) {
  const activeId = nextState.activeProjectId;
  const previous = previousState.projects?.find((project) => project.id === activeId);
  const next = nextState.projects?.find((project) => project.id === activeId);
  if (!next || JSON.stringify(comparableProject(previous)) === JSON.stringify(comparableProject(next))) return null;
  const requestDelta = (next.requests?.length ?? 0) - (previous?.requests?.length ?? 0);
  const environmentDelta = (next.environments?.length ?? 0) - (previous?.environments?.length ?? 0);
  const activeEnvironment = next.environments?.find((environment) => environment.id === next.activeEnvironmentId);
  return createTimelineEvent({
    projectId: next.id,
    type: "change",
    severity: "info",
    actor: "developer",
    title: requestDelta > 0 ? "API request added" : environmentDelta > 0 ? "Environment added" : "Project configuration updated",
    summary: requestDelta > 0 ? `${requestDelta} reusable API request${requestDelta === 1 ? "" : "s"} added.` : environmentDelta > 0 ? `${environmentDelta} environment${environmentDelta === 1 ? "" : "s"} added.` : `Configuration saved for ${next.name}.`,
    tags: [activeEnvironment?.name, `${next.requests?.length ?? 0} APIs`].filter(Boolean),
    source: { kind: "workspace", projectId: next.id },
    evidence: { requestCount: next.requests?.length ?? 0, environmentCount: next.environments?.length ?? 0, activeEnvironment: activeEnvironment?.name ?? null }
  });
}
