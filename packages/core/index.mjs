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

function observedType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

export function inferJsonShape(value, depth = 0) {
  const type = observedType(value);
  if (depth >= 8) return { type };
  if (type === "array") {
    const sample = value.find((entry) => entry !== null && entry !== undefined);
    return { type, sampleCount: value.length, items: sample === undefined ? null : inferJsonShape(sample, depth + 1) };
  }
  if (type === "object") {
    return { type, properties: Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, entry]) => [key, inferJsonShape(entry, depth + 1)])) };
  }
  return { type };
}

function recordFromPayload(payload) {
  if (Array.isArray(payload)) return payload.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) ?? null;
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["data", "result", "item", "record"]) {
    const nested = payload[key];
    if (Array.isArray(nested)) return nested.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) ?? null;
    if (nested && typeof nested === "object") return nested;
  }
  return payload;
}

function normalizedName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/ies$/, "y").replace(/s$/, "");
}

function schemaScore(schema, route) {
  const schemaName = normalizedName(schema.name);
  if (!schemaName) return 0;
  const tokens = normalizeRoute(route).split("/").map(normalizedName).filter(Boolean);
  return tokens.includes(schemaName) ? 1 : tokens.some((token) => token.includes(schemaName) || schemaName.includes(token)) ? .65 : .1;
}

function databaseTypeToObserved(type) {
  const value = String(type ?? "").toLowerCase();
  if (/\b(bool)/.test(value)) return "boolean";
  if (/\b(int|serial|numeric|decimal|real|double|float)/.test(value)) return "number";
  if (/\b(json|jsonb)/.test(value)) return "object";
  if (/\[\]|array/.test(value)) return "array";
  return "string";
}

export function diffObservedContract(payload, schemas = [], route = "") {
  const observed = recordFromPayload(payload);
  const ranked = schemas.map((schema) => ({ schema, score: schemaScore(schema, route) })).sort((a, b) => b.score - a.score);
  const selected = ranked[0]?.schema ?? null;
  const confidence = ranked[0]?.score ?? 0;
  const shape = inferJsonShape(payload);
  if (!selected?.columns?.length || !observed) {
    return { status: "unverified", route: normalizeRoute(route), observedShape: shape, schema: selected ? { name: selected.name, source: selected.source, line: selected.line } : null, confidence, missingRequiredFields: [], unexpectedFields: [], typeMismatches: [], note: selected ? "The selected database object has no parsed column metadata." : "No matching database schema was discovered." };
  }
  const columns = new Map(selected.columns.map((column) => [normalizedName(column.name), column]));
  const fields = new Map(Object.entries(observed).map(([key, value]) => [normalizedName(key), { key, value }]));
  const missingRequiredFields = selected.columns.filter((column) => (column.nullable === false || column.primaryKey) && !fields.has(normalizedName(column.name))).map((column) => column.name);
  const unexpectedFields = [...fields.entries()].filter(([key]) => !columns.has(key)).map(([, entry]) => entry.key);
  const typeMismatches = [];
  for (const [key, column] of columns) {
    const field = fields.get(key);
    if (!field || field.value === null) continue;
    const expected = databaseTypeToObserved(column.type);
    const actual = observedType(field.value);
    const compatibleNumber = expected === "number" && ["number", "integer"].includes(actual);
    if (expected !== actual && !compatibleNumber) typeMismatches.push({ field: column.name, expected, actual, databaseType: column.type });
  }
  const status = missingRequiredFields.length || unexpectedFields.length || typeMismatches.length ? "drift" : "aligned";
  return { status, route: normalizeRoute(route), observedShape: shape, schema: { name: selected.name, source: selected.source, line: selected.line, columns: selected.columns }, confidence, missingRequiredFields, unexpectedFields, typeMismatches };
}

function safeFixtureValue(value, key = "") {
  if (isSecretName(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => safeFixtureValue(entry));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, safeFixtureValue(entry, entryKey)]));
  return value;
}

function pythonLiteral(value, depth = 0) {
  if (depth > 12) return "None";
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => pythonLiteral(entry, depth + 1)).join(", ")}]`;
  if (typeof value === "object") return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${pythonLiteral(entry, depth + 1)}`).join(", ")}}`;
  return JSON.stringify(String(value));
}

export function generateFixtureContent(payload, { format = "json", name = "apiFixture", method = "GET", route = "/" } = {}) {
  const safe = safeFixtureValue(payload);
  const json = JSON.stringify(safe, null, 2);
  const identifier = String(name || "apiFixture").replace(/[^A-Za-z0-9_$]/g, "_").replace(/^[^A-Za-z_$]/, "_$&");
  if (format === "typescript") return { content: `export const ${identifier} = ${json} as const;\n`, extension: "ts" };
  if (format === "msw") return { content: `import { http, HttpResponse } from "msw";\n\nexport const ${identifier}Handler = http.${String(method).toLowerCase()}("${normalizeRoute(route)}", () => HttpResponse.json(${json}));\n`, extension: "ts" };
  if (format === "pytest") return { content: `${identifier} = ${pythonLiteral(safe)}\n`, extension: "py" };
  return { content: `${json}\n`, extension: "json" };
}

function uniqueIssues(items) {
  const seen = new Set();
  return items.filter((entry) => {
    const key = `${entry.type}:${entry.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function summarizeProjectEvidence(project, history = []) {
  const source = project.sourceContext ?? {};
  const backend = [];
  const frontend = [];
  const schema = [];
  for (const finding of source.findings ?? []) {
    if (finding.type === "missing-backend") backend.push({ type: finding.type, severity: finding.severity, title: finding.title, evidence: `Source scan ${source.lastScannedAt ?? "not dated"}` });
    if (finding.type === "unused-backend") frontend.push({ type: finding.type, severity: finding.severity, title: `Frontend has no detected consumer for ${finding.title.replace(/^No frontend consumer found for\s*/i, "")}`, evidence: finding.title });
  }
  const projectHistory = history.filter((entry) => entry.projectId === project.id);
  for (const log of projectHistory) {
    const result = log.result ?? {};
    if (Number(result.status) >= 500) backend.push({ type: "server-failure", severity: "high", title: `${log.requestName} returned HTTP ${result.status}`, evidence: `Run ${log.id}` });
    if ([400, 404, 415, 422].includes(Number(result.status))) frontend.push({ type: "request-contract", severity: "high", title: `${log.requestName} requires request or route correction`, evidence: `HTTP ${result.status} in run ${log.id}` });
    const diff = result.contractDiff;
    if (diff?.status === "drift") schema.push({ type: "schema-drift", severity: "high", title: `${log.requestName} differs from ${diff.schema?.name ?? "database schema"}`, evidence: `${diff.missingRequiredFields.length} missing, ${diff.unexpectedFields.length} unexpected, ${diff.typeMismatches.length} type mismatches`, logId: log.id });
  }
  if ((source.endpoints?.length ?? 0) > 0 && !(source.schemas?.length ?? 0)) schema.push({ type: "schema-unavailable", severity: "medium", title: "No database schema evidence is connected", evidence: "Connect SQL migrations or schema files before claiming end-to-end alignment." });
  const corrections = { backend: uniqueIssues(backend), frontend: uniqueIssues(frontend), schema: uniqueIssues(schema) };
  const issueCount = corrections.backend.length + corrections.frontend.length + corrections.schema.length;
  return {
    corrections,
    evidence: { lastScanAt: source.lastScannedAt ?? null, tracedRuns: projectHistory.filter((entry) => entry.result?.trace).length, contractDiffs: projectHistory.filter((entry) => entry.result?.contractDiff).length },
    status: issueCount ? "needs-attention" : (source.lastScannedAt ? "aligned-from-current-evidence" : "insufficient-evidence"),
    recommendedNextActions: [corrections.backend[0] && "Review the highest-severity backend requirement.", corrections.frontend[0] && "Correct the frontend request against the discovered backend route.", corrections.schema[0] && "Review the observed contract against the database schema.", !issueCount && "Trace a representative route to refresh runtime evidence."].filter(Boolean)
  };
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
