import { isSecretName, normalizeRoute } from "../core/index.mjs";

function attributeValue(value = {}) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return Boolean(value.boolValue);
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.bytesValue !== undefined) return "[BINARY OMITTED]";
  if (value.arrayValue?.values) return value.arrayValue.values.slice(0, 25).map(attributeValue);
  return null;
}

function attributesObject(attributes = []) {
  return Object.fromEntries(attributes.slice(0, 200).map((entry) => [entry.key, isSecretName(entry.key) ? "[REDACTED]" : attributeValue(entry.value)]));
}

function nanoDuration(start, end) {
  try {
    const duration = Number((BigInt(end || 0) - BigInt(start || 0)) / 1_000_000n);
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
  } catch { return null; }
}

function safePath(value) {
  if (!value) return null;
  try { return normalizeRoute(new URL(String(value), "http://aipi.local").pathname); }
  catch { return normalizeRoute(value); }
}

function selectedAttributes(attributes) {
  const allowed = [
    "http.request.method", "http.method", "http.route", "url.path", "http.target", "http.response.status_code", "http.status_code",
    "server.address", "server.port", "network.protocol.name", "rpc.system", "rpc.method", "error.type",
    "code.file.path", "code.filepath", "code.line.number", "code.lineno", "code.function.name", "code.function",
    "db.system", "db.system.name", "db.namespace", "db.collection.name", "db.operation.name",
  ];
  return Object.fromEntries(allowed.filter((key) => attributes[key] !== undefined).map((key) => [key, attributes[key]]));
}

export function normalizeOtelTraces(payload, { limit = 200 } = {}) {
  const spans = [];
  for (const resourceSpan of payload?.resourceSpans ?? []) {
    const resource = attributesObject(resourceSpan.resource?.attributes);
    for (const scopeSpan of resourceSpan.scopeSpans ?? resourceSpan.instrumentationLibrarySpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        if (spans.length >= limit) return spans;
        const attributes = attributesObject(span.attributes);
        const route = safePath(attributes["http.route"] ?? attributes["url.path"] ?? attributes["http.target"]);
        const method = String(attributes["http.request.method"] ?? attributes["http.method"] ?? "").toUpperCase() || null;
        const statusCode = Number(attributes["http.response.status_code"] ?? attributes["http.status_code"] ?? 0) || null;
        spans.push({
          traceId: span.traceId ?? null,
          spanId: span.spanId ?? null,
          parentSpanId: span.parentSpanId ?? null,
          name: String(span.name ?? "unnamed span").slice(0, 200),
          kind: span.kind ?? null,
          startedAtUnixNano: span.startTimeUnixNano ?? null,
          durationMs: nanoDuration(span.startTimeUnixNano, span.endTimeUnixNano),
          status: span.status?.code ?? 0,
          method,
          route,
          httpStatus: statusCode,
          code: {
            file: attributes["code.file.path"] ?? attributes["code.filepath"] ?? null,
            line: Number(attributes["code.line.number"] ?? attributes["code.lineno"] ?? 0) || null,
            function: attributes["code.function.name"] ?? attributes["code.function"] ?? null,
          },
          database: {
            system: attributes["db.system.name"] ?? attributes["db.system"] ?? null,
            namespace: attributes["db.namespace"] ?? null,
            collection: attributes["db.collection.name"] ?? null,
            operation: attributes["db.operation.name"] ?? null,
          },
          attributes: selectedAttributes(attributes),
          resource: { serviceName: resource["service.name"] ?? null, serviceVersion: resource["service.version"] ?? null },
        });
      }
    }
  }
  return spans;
}

export function summarizeOtelBatch(spans = []) {
  const routes = [...new Set(spans.filter((span) => span.route).map((span) => `${span.method ?? "*"} ${span.route}`))];
  const failures = spans.filter((span) => Number(span.httpStatus) >= 400 || Number(span.status) === 2).length;
  return { spans: spans.length, routes: routes.slice(0, 25), failures, services: [...new Set(spans.map((span) => span.resource?.serviceName).filter(Boolean))].slice(0, 25) };
}
