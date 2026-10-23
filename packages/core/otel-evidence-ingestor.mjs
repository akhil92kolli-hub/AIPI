import crypto from "node:crypto";
import { findingFingerprint, synthesizeTaskFromFinding } from "./contracts-evidence.mjs";
import { buildProjectKnowledgeGraph, promoteRuntimeEdge } from "./knowledge-graph.mjs";
import { sanitizeEvidencePayload } from "./security-redactor.mjs";
import { projectGitRevision } from "./verification-runner.mjs";

const hash = (value, length = 24) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
const nowIso = () => new Date().toISOString();

function routePath(value = "/") {
  try { return new URL(String(value), "http://aipi.local").pathname.replace(/\/$/, "") || "/"; }
  catch { return String(value).split(/[?#]/)[0].replace(/\/$/, "") || "/"; }
}

function routePattern(value = "/") {
  return routePath(value).replace(/:\w+|\{[^}]+\}/g, "{param}");
}

function inferredRouteTemplate(value = "/") {
  return routePath(value).split("/").map((part) => /^\d+$/.test(part) || /^[0-9a-f]{24}$/i.test(part) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part) ? ":id" : part).join("/") || "/";
}

function templateMatches(template, actual) {
  const escaped = routePath(template).split("/").map((part) => {
    if (/^:\w+$|^\{[^}]+\}$/.test(part)) return "[^/]+";
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return new RegExp(`^${escaped}/?$`).test(routePath(actual));
}

export function matchOtelRecordToContract(project, span) {
  const method = String(span.method ?? "GET").toUpperCase();
  return (project.contracts ?? []).find((contract) => String(contract.method ?? "GET").toUpperCase() === method
    && (routePattern(contract.route ?? contract.normalizedRoute) === routePattern(span.route) || templateMatches(contract.route ?? contract.normalizedRoute, span.route)));
}

function ensureContract(project, span, revision, recordedAt) {
  const existing = matchOtelRecordToContract(project, span);
  if (existing) return { contract: existing, created: false };
  const method = String(span.method ?? "GET").toUpperCase();
  const route = inferredRouteTemplate(span.route ?? "/");
  const id = `contract_otel_${hash([project.id, method, route])}`;
  const contract = {
    id, projectId: project.id, method, route, normalizedRoute: routePattern(route), name: `${method} ${route}`,
    sourceRequestIds: [], sourceArtifactIds: [], schemaIds: [], createdFrom: "otel-live", state: "Observed",
    implementation: span.code?.file ? { root: null, source: span.code.file, line: span.code.line ?? null, framework: "otel-live" } : null,
    currentRevisionId: `contractrev_${hash([id, revision])}`, updatedAt: recordedAt
  };
  project.contracts ??= [];
  project.contracts.push(contract);
  project.contractRevisions ??= [];
  project.contractRevisions.push({
    id: contract.currentRevisionId, contractId: id, projectId: project.id, sourceRevision: revision,
    definitionHash: hash([method, route, contract.implementation], 64), createdAt: recordedAt, origin: "otel-live"
  });
  return { contract, created: true };
}

function snapshotsFor(span) {
  const request = span.requestSnapshot ?? {};
  const response = span.responseSnapshot ?? {};
  return {
    requestSnapshot: {
      method: span.method ?? request.method ?? null,
      route: span.route ?? request.route ?? null,
      headers: request.headers ?? {},
      bodyPreview: request.bodyPreview ?? request.body ?? "",
      attributes: request.attributes ?? {}
    },
    responseSnapshot: {
      status: span.httpStatus ?? response.status ?? null,
      headers: response.headers ?? {},
      bodyPreview: response.bodyPreview ?? response.body ?? "",
      attributes: response.attributes ?? {}
    }
  };
}

function evidenceFor(project, contract, span, revision, recordedAt) {
  const spanIdentity = span.spanId || hash([span.name, span.startedAtUnixNano, span.method, span.route]);
  const id = `evidence_otel_${hash([project.id, span.traceId, spanIdentity])}`;
  const status = Number(span.httpStatus ?? span.responseSnapshot?.status ?? 0) || null;
  const snapshots = snapshotsFor(span);
  return sanitizeEvidencePayload({
    id, projectId: project.id, contractId: contract.id, contractRevisionId: contract.currentRevisionId ?? null,
    type: "runtime-payload", origin: "otel-live", provenance: "otel-live", immutable: true,
    sourceRevision: revision, environmentFingerprint: project.activeEnvironmentId ?? "default", recordedAt,
    traceId: span.traceId ?? null, spanId: span.spanId ?? null, parentSpanId: span.parentSpanId ?? null,
    request: { id: null, method: String(span.method ?? contract.method ?? "GET").toUpperCase(), route: routePath(span.route ?? contract.route) },
    ...snapshots,
    stackFrames: span.stackFrames ?? (span.code?.file ? [{ file: span.code.file, line: span.code.line ?? null, function: span.code.function ?? null }] : []),
    result: { status, passed: status == null ? Number(span.status ?? 0) !== 2 : status < 400, elapsedMs: span.durationMs ?? null },
    resource: span.resource ?? {}, untrustedData: true, untrustedSource: "otel"
  });
}

function upsertFailureFinding(project, contract, evidence, revision, recordedAt) {
  const status = Number(evidence.result?.status ?? 0);
  if (status !== 422 && status < 500) return { finding: null, created: false, task: null };
  const type = status === 422 ? "runtime-schema-failure" : "runtime-server-failure";
  const candidate = {
    projectId: project.id, contractId: contract.id, contractRevisionId: contract.currentRevisionId ?? null,
    type, title: `${contract.method} ${contract.route} returned HTTP ${status}`,
    severity: status >= 500 ? "high" : "medium", origin: "otel-live", generatedBy: "otel-evidence-ingestor",
    sourceRevision: revision, location: contract.route, evidenceIds: [evidence.id], status: "open"
  };
  candidate.fingerprint = findingFingerprint(candidate);
  project.findings ??= [];
  let finding = project.findings.find((entry) => entry.fingerprint === candidate.fingerprint);
  const created = !finding;
  if (!finding) {
    finding = { ...candidate, id: `finding_otel_${hash(candidate.fingerprint)}`, firstSeenAt: recordedAt, lastSeenAt: recordedAt, occurrenceCount: 1 };
    project.findings.unshift(finding);
  } else {
    finding.evidenceIds = [...new Set([evidence.id, ...(finding.evidenceIds ?? [])])];
    finding.lastSeenAt = recordedAt;
    finding.occurrenceCount = Number(finding.occurrenceCount ?? 1) + 1;
    if (["resolved", "dismissed", "closed"].includes(String(finding.status).toLowerCase())) finding.status = "open";
  }
  const taskResult = synthesizeTaskFromFinding(project, finding.id);
  taskResult.task.status = taskResult.task.status === "proposed" ? "proposed" : taskResult.task.status;
  taskResult.task.evidenceIds = [...new Set([evidence.id, ...(taskResult.task.evidenceIds ?? [])])];
  taskResult.task.runtimeEvidenceIds = [...new Set([evidence.id, ...(taskResult.task.runtimeEvidenceIds ?? [])])];
  taskResult.task.updatedAt = recordedAt;
  return { finding, created, task: taskResult.task, taskCreated: taskResult.created };
}

export function ingestOtelEvidence(project, spans = [], options = {}) {
  if (!project) throw new TypeError("A project is required.");
  const revision = options.gitRevision ?? projectGitRevision(project);
  const recordedAt = options.recordedAt ?? nowIso();
  const runtimeEdges = project.knowledgeGraph?.edges?.filter((edge) => edge.provenance === "runtime") ?? [];
  buildProjectKnowledgeGraph(project, { pinnedEdges: project.knowledgeGraph?.pinnedEdges ?? [], runtimeEdges, rejectedEdgeIds: project.knowledgeGraph?.rejectedEdgeIds ?? [] });
  project.evidence ??= [];
  const result = { processed: 0, evidenceRecords: [], contractsCreated: [], findings: [], tasks: [], promotedEdges: [] };
  const runtimeLinks = [];

  for (const span of spans) {
    if (!span?.route || !span?.method) continue;
    result.processed += 1;
    const { contract, created } = ensureContract(project, span, revision, recordedAt);
    if (created) result.contractsCreated.push(contract);
    const evidence = evidenceFor(project, contract, span, revision, recordedAt);
    const existingEvidence = project.evidence.find((entry) => entry.id === evidence.id);
    const persistedEvidence = existingEvidence ?? evidence;
    if (!existingEvidence) project.evidence.unshift(Object.freeze(evidence));
    result.evidenceRecords.push(persistedEvidence);
    if (persistedEvidence.result?.passed && options.acceptRuntimeObservation?.(persistedEvidence) === true) runtimeLinks.push({
      contractId: contract.id, handlerFile: span.code?.file, callerFile: span.caller?.file,
      testFile: span.test?.file, dbModel: span.database?.collection || span.database?.namespace,
      gitRevision: revision, observedAt: recordedAt, runtimeEvidenceId: persistedEvidence.id
    });
    const failure = upsertFailureFinding(project, contract, persistedEvidence, revision, recordedAt);
    if (failure.finding) result.findings.push(failure.finding);
    if (failure.task) result.tasks.push(failure.task);
  }

  buildProjectKnowledgeGraph(project, {
    pinnedEdges: project.knowledgeGraph?.pinnedEdges ?? [],
    runtimeEdges,
    rejectedEdgeIds: project.knowledgeGraph?.rejectedEdgeIds ?? []
  });
  for (const link of runtimeLinks) result.promotedEdges.push(...promoteRuntimeEdge(project, link));
  return {
    ...result,
    evidenceRecords: [...new Map(result.evidenceRecords.map((entry) => [entry.id, entry])).values()],
    findings: [...new Map(result.findings.map((entry) => [entry.id, entry])).values()],
    tasks: [...new Map(result.tasks.map((entry) => [entry.id, entry])).values()],
    promotedEdges: [...new Map(result.promotedEdges.map((entry) => [entry.id, entry])).values()]
  };
}
