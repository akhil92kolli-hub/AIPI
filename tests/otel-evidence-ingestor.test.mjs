import assert from "node:assert/strict";
import { ingestOtelEvidence } from "../packages/core/otel-evidence-ingestor.mjs";
import { normalizeOtelTraces } from "../packages/local-observer/otel.mjs";

const project = {
  id: "prj_otel", activeEnvironmentId: "env_local",
  environments: [{ id: "env_local", variables: [{ key: "baseUrl", value: "http://127.0.0.1:3000", enabled: true }] }],
  sourceContext: { gitRevision: "abc123", endpoints: [], frontendCalls: [], integrations: [], schemas: [], artifacts: [], git: [] },
  contracts: [], contractRevisions: [], requests: [], evidence: [], findings: [], tasks: [], contextPacks: [], verificationReceipts: [],
  knowledgeGraph: { nodes: [], edges: [], pinnedEdges: [], rejectedEdgeIds: [] }
};

const span = {
  traceId: "trace-1", spanId: "span-1", name: "POST /users", method: "POST", route: "/users", httpStatus: 422,
  durationMs: 18, status: 2, code: { file: "src/users.mjs", line: 42, function: "createUser" },
  database: { collection: "users" }, resource: { serviceName: "users-api" },
  requestSnapshot: { headers: { Authorization: "Bearer secret", "X-API-Key": "key" }, bodyPreview: JSON.stringify({ email: "a@example.com", password: "hunter2" }) },
  responseSnapshot: { headers: { "Set-Cookie": "session=secret" }, bodyPreview: JSON.stringify({ detail: "invalid", access_token: "token" }) }
};

const first = ingestOtelEvidence(project, [span], { recordedAt: "2026-10-16T00:00:00.000Z" });
assert.equal(first.processed, 1);
assert.equal(first.contractsCreated.length, 1);
assert.equal(project.contracts[0].createdFrom, "otel-live");
assert.equal(project.evidence.length, 1);
assert.equal(project.evidence[0].type, "runtime-payload");
assert.equal(project.evidence[0].provenance, "otel-live");
assert.equal(project.evidence[0].requestSnapshot.headers.Authorization, "[REDACTED]");
assert.equal(project.evidence[0].requestSnapshot.headers["X-API-Key"], "[REDACTED]");
assert.match(project.evidence[0].requestSnapshot.bodyPreview, /\[REDACTED\]/);
assert.equal(project.evidence[0].responseSnapshot.headers["Set-Cookie"], "[REDACTED]");
assert.ok(project.evidence[0].redactionManifest.redactedFields.length >= 4);
assert.equal(Object.isFrozen(project.evidence[0]), true);
assert.equal(project.findings.length, 1);
assert.equal(project.findings[0].type, "runtime-schema-failure");
assert.equal(project.tasks.length, 1);
assert.equal(project.tasks[0].status, "proposed");
assert.deepEqual(project.tasks[0].evidenceIds, [project.evidence[0].id]);
assert.equal(project.knowledgeGraph.edges.some((edge) => edge.type === "HANDLED_BY" && edge.provenance === "runtime"), false, "failed executions must not prove an implementation edge");
assert.ok(project.knowledgeGraph.edges.some((edge) => edge.type === "OBSERVED_BY" && edge.confirmationState === "pending"));
assert.ok(project.knowledgeGraph.edges.some((edge) => edge.type === "CREATED_TASK" && edge.toNodeId === project.tasks[0].id));

ingestOtelEvidence(project, [span], { recordedAt: "2026-10-16T00:01:00.000Z" });
assert.equal(project.evidence.length, 1, "replayed OTLP span IDs must not duplicate immutable evidence");
assert.equal(project.findings.length, 1, "failure findings must be fingerprint-deduplicated");
assert.equal(project.tasks.length, 1, "proposed tasks must be fingerprint-deduplicated");
assert.equal(project.findings[0].occurrenceCount, 2);

ingestOtelEvidence(project, [{ ...span, traceId: "trace-2", spanId: "span-2", httpStatus: 200, status: 0 }], { recordedAt: "2026-10-16T00:02:00.000Z" });
assert.equal(project.knowledgeGraph.edges.some((edge) => edge.type === "HANDLED_BY" && edge.provenance === "runtime"), false, "an unauthenticated OTLP success cannot confirm graph edges");

const normalized = normalizeOtelTraces({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] }, scopeSpans: [{ spans: [{
  traceId: "t2", spanId: "s2", name: "checkout", startTimeUnixNano: "1000000", endTimeUnixNano: "3000000",
  attributes: [
    { key: "http.request.method", value: { stringValue: "POST" } },
    { key: "http.route", value: { stringValue: "/checkout" } },
    { key: "http.response.status_code", value: { intValue: "500" } },
    { key: "http.request.header.authorization", value: { stringValue: "Bearer secret" } },
    { key: "http.request.body", value: { stringValue: "{\"password\":\"secret\"}" } },
    { key: "code.file.path", value: { stringValue: "src/checkout.mjs" } },
    { key: "code.line.number", value: { intValue: "12" } }
  ]
}] }] }] });
assert.equal(normalized[0].method, "POST");
assert.equal(normalized[0].httpStatus, 500);
assert.equal(normalized[0].requestSnapshot.headers.authorization, "[REDACTED]");
assert.equal(normalized[0].requestSnapshot.bodyPreview, "{\"password\":\"secret\"}");
assert.deepEqual(normalized[0].stackFrames[0], { file: "src/checkout.mjs", line: 12, function: null });

console.log("OTLP evidence ingestor regression checks passed.");
