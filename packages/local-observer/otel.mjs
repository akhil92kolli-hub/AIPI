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

function attributesWithPrefix(attributes, prefix) {
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
}

function firstAttribute(attributes, keys) {
  for (const key of keys) if (attributes[key] !== undefined) return attributes[key];
  return null;
}

function stackFrames(span, attributes) {
  const frames = [];
  if (attributes["code.file.path"] ?? attributes["code.filepath"]) frames.push({
    file: attributes["code.file.path"] ?? attributes["code.filepath"],
    line: Number(attributes["code.line.number"] ?? attributes["code.lineno"] ?? 0) || null,
    function: attributes["code.function.name"] ?? attributes["code.function"] ?? null
  });
  for (const event of span.events ?? []) {
    const eventAttributes = attributesObject(event.attributes);
    const stack = eventAttributes["exception.stacktrace"];
    if (typeof stack !== "string") continue;
    for (const line of stack.split("\n").slice(0, 25)) {
      const match = line.match(/(?:at\s+([^\s(]+)\s+\()?(.+?):(\d+)(?::\d+)?\)?$/);
      if (match) frames.push({ function: match[1] ?? null, file: match[2], line: Number(match[3]) || null });
    }
  }
  return [...new Map(frames.map((frame) => [`${frame.file}:${frame.line}:${frame.function}`, frame])).values()];
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
        const requestHeaders = { ...attributesWithPrefix(attributes, "http.request.header."), ...attributesWithPrefix(attributes, "request.header.") };
        const responseHeaders = { ...attributesWithPrefix(attributes, "http.response.header."), ...attributesWithPrefix(attributes, "response.header.") };
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
          requestSnapshot: {
            headers: requestHeaders,
            bodyPreview: firstAttribute(attributes, ["http.request.body", "request.body", "aipi.request.body"]),
            attributes: attributesWithPrefix(attributes, "aipi.request.attribute.")
          },
          responseSnapshot: {
            status: statusCode,
            headers: responseHeaders,
            bodyPreview: firstAttribute(attributes, ["http.response.body", "response.body", "aipi.response.body"]),
            attributes: attributesWithPrefix(attributes, "aipi.response.attribute.")
          },
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
          caller: { file: firstAttribute(attributes, ["aipi.caller.file", "caller.file"]), function: firstAttribute(attributes, ["aipi.caller.function", "caller.function"]) },
          test: { file: firstAttribute(attributes, ["aipi.test.file", "test.file"]) },
          stackFrames: stackFrames(span, attributes),
          attributes: selectedAttributes(attributes),
          resource: { serviceName: resource["service.name"] ?? null, serviceVersion: resource["service.version"] ?? null },
        });
      }
    }
  }
  return spans;
}

function metricDataPoints(metric) {
  return metric.gauge?.dataPoints
    ?? metric.sum?.dataPoints
    ?? metric.histogram?.dataPoints
    ?? metric.exponentialHistogram?.dataPoints
    ?? metric.summary?.dataPoints
    ?? [];
}

function metricDurationMs(metric, point, attributes) {
  const explicit = Number(attributes["http.request.duration_ms"] ?? attributes["http.server.duration_ms"] ?? 0);
  if (explicit > 0) return explicit;
  const raw = Number(point.sum ?? point.asDouble ?? point.asInt ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return null;
  const unit = String(metric.unit ?? "").toLowerCase();
  if (unit === "s" || unit === "seconds") return raw * 1000;
  if (unit === "ms" || unit === "milliseconds") return raw;
  return /duration/i.test(metric.name ?? "") ? raw * 1000 : null;
}

export function normalizeOtelMetrics(payload, { limit = 200 } = {}) {
  const records = [];
  for (const resourceMetric of payload?.resourceMetrics ?? []) {
    const resource = attributesObject(resourceMetric.resource?.attributes);
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        for (const point of metricDataPoints(metric)) {
          if (records.length >= limit) return records;
          const attributes = attributesObject(point.attributes);
          const route = safePath(attributes["http.route"] ?? attributes["url.path"] ?? attributes["http.target"]);
          const method = String(attributes["http.request.method"] ?? attributes["http.method"] ?? "").toUpperCase() || null;
          const statusCode = Number(attributes["http.response.status_code"] ?? attributes["http.status_code"] ?? 0) || null;
          records.push({
            traceId: attributes["trace.id"] ?? null,
            spanId: `metric_${Buffer.from(`${metric.name}:${point.timeUnixNano ?? point.startTimeUnixNano ?? records.length}`).toString("base64url").slice(0, 48)}`,
            parentSpanId: null,
            name: String(metric.name ?? "unnamed metric").slice(0, 200), kind: "metric", telemetryType: "metric",
            startedAtUnixNano: point.timeUnixNano ?? point.startTimeUnixNano ?? null,
            durationMs: metricDurationMs(metric, point, attributes), status: statusCode && statusCode >= 500 ? 2 : 0,
            method, route, httpStatus: statusCode,
            requestSnapshot: {
              headers: { ...attributesWithPrefix(attributes, "http.request.header."), ...attributesWithPrefix(attributes, "request.header.") },
              bodyPreview: firstAttribute(attributes, ["http.request.body", "request.body", "aipi.request.body"]),
              attributes: attributesWithPrefix(attributes, "aipi.request.attribute.")
            },
            responseSnapshot: {
              status: statusCode,
              headers: { ...attributesWithPrefix(attributes, "http.response.header."), ...attributesWithPrefix(attributes, "response.header.") },
              bodyPreview: firstAttribute(attributes, ["http.response.body", "response.body", "aipi.response.body"]),
              attributes: attributesWithPrefix(attributes, "aipi.response.attribute.")
            },
            code: {
              file: attributes["code.file.path"] ?? attributes["code.filepath"] ?? null,
              line: Number(attributes["code.line.number"] ?? attributes["code.lineno"] ?? 0) || null,
              function: attributes["code.function.name"] ?? attributes["code.function"] ?? null
            },
            caller: { file: firstAttribute(attributes, ["aipi.caller.file", "caller.file"]), function: firstAttribute(attributes, ["aipi.caller.function", "caller.function"]) },
            test: { file: firstAttribute(attributes, ["aipi.test.file", "test.file"]) },
            database: { system: attributes["db.system.name"] ?? attributes["db.system"] ?? null, namespace: attributes["db.namespace"] ?? null, collection: attributes["db.collection.name"] ?? null, operation: attributes["db.operation.name"] ?? null },
            stackFrames: stackFrames({ events: [] }, attributes), attributes: selectedAttributes(attributes),
            metric: { name: metric.name ?? null, unit: metric.unit ?? null, value: point.asDouble ?? point.asInt ?? point.sum ?? point.count ?? null },
            resource: { serviceName: resource["service.name"] ?? null, serviceVersion: resource["service.version"] ?? null }
          });
        }
      }
    }
  }
  return records;
}

export function summarizeOtelBatch(spans = []) {
  const routes = [...new Set(spans.filter((span) => span.route).map((span) => `${span.method ?? "*"} ${span.route}`))];
  const failures = spans.filter((span) => Number(span.httpStatus) >= 400 || Number(span.status) === 2).length;
  const metrics = spans.filter((span) => span.telemetryType === "metric").length;
  return { spans: spans.length - metrics, ...(metrics ? { metrics, records: spans.length } : {}), routes: routes.slice(0, 25), failures, services: [...new Set(spans.map((span) => span.resource?.serviceName).filter(Boolean))].slice(0, 25) };
}
