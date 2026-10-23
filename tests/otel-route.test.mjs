import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-otel-route-"));
process.env.AIPI_DATA = path.join(temp, "data");
process.env.AIPI_PORT = "0";
process.env.AIPI_MAX_PORT = "0";
const { loadState, mutateState } = await import("../scripts/workspace-store.mjs");
const { startDashboard } = await import("../scripts/dashboard-server.mjs");
let dashboard;
try {
  await mutateState((state) => {
    state.projects = [{
      id: "otel-project", name: "OTLP route test", requests: [], tasks: [], environments: [{ id: "dev", name: "Development", variables: [{ key: "baseUrl", value: "http://127.0.0.1:3000", enabled: true }] }], activeEnvironmentId: "dev",
      sourceContext: { roots: [{ kind: "workspace", path: temp }], gitRevision: "otel123", endpoints: [{ id: "users-handler", method: "POST", path: "/users/:id", source: "server.ts", line: 8 }], frontendCalls: [], integrations: [], schemas: [], artifacts: [], findings: [], git: [] }
    }];
    state.activeProjectId = "otel-project";
  });
  dashboard = await startDashboard({ executeRequest: async () => ({ ok: true, passed: true, status: 200 }) });
  const payload = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "users" } }] }, scopeSpans: [{ spans: [{
    traceId: "route-trace", spanId: "route-span", name: "POST /users/123", startTimeUnixNano: "1000000", endTimeUnixNano: "4000000",
    attributes: [
      { key: "http.request.method", value: { stringValue: "POST" } },
      { key: "url.path", value: { stringValue: "/users/123" } },
      { key: "http.response.status_code", value: { intValue: "201" } },
      { key: "http.request.header.authorization", value: { stringValue: "Bearer should-not-persist" } },
      { key: "http.request.body", value: { stringValue: "{\"password\":\"should-not-persist\"}" } },
      { key: "code.file.path", value: { stringValue: "/workspace/server.ts" } },
      { key: "code.line.number", value: { intValue: "8" } }
    ]
  }] }] }], resourceMetrics: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "users" } }] }, scopeMetrics: [{ metrics: [{ name: "http.server.request.duration", unit: "s", histogram: { dataPoints: [{ timeUnixNano: "5000000", sum: 0.025, count: 1, attributes: [
    { key: "http.request.method", value: { stringValue: "POST" } },
    { key: "http.route", value: { stringValue: "/users/:id" } },
    { key: "http.response.status_code", value: { intValue: "201" } }
  ] }] } }] }] }] };
  const response = await fetch(`${dashboard.url}/api/otel/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(response.status, 202, "loopback OTLP ingestion must not require a browser session token");
  const body = await response.json();
  assert.equal(body.accepted, 2);
  assert.equal(body.summary.spans, 1);
  assert.equal(body.summary.metrics, 1);
  assert.equal(body.evidenceIds.length, 2);
  const project = (await loadState()).projects.find((entry) => entry.id === "otel-project");
  const evidence = project.evidence.find((entry) => entry.traceId === "route-trace");
  assert.equal(evidence.type, "runtime-payload");
  assert.equal(evidence.requestSnapshot.headers.authorization, "[REDACTED]");
  assert.match(evidence.requestSnapshot.bodyPreview, /\[REDACTED\]/);
  assert.equal(body.contractIds.length, 0, `the concrete /users/123 execution must match the /users/:id contract: ${JSON.stringify(project.contracts.map((entry) => [entry.method, entry.route, entry.createdFrom]))}`);
  assert.equal(project.knowledgeGraph.edges.some((entry) => entry.type === "HANDLED_BY" && entry.provenance === "runtime"), false);
  assert.deepEqual(body.promotedEdgeIds, [], "an unauthenticated OTLP payload cannot confirm graph edges");
  console.log("OTLP HTTP ingestion, redaction and advisory runtime evidence passed");
} finally {
  if (dashboard) await new Promise((resolve) => dashboard.server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
