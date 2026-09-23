import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { isSecretName, normalizeRoute, redactRecord } from "../core/index.mjs";

const MAX_CAPTURE_BYTES = 256_000;

export function trafficCachePath(root = process.cwd()) {
  return path.join(path.resolve(root), ".api-forge", "tmp", "traffic.ndjson");
}

export function redactCapturedHeaders(headers = {}) {
  return redactRecord(Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")])), true);
}

function safeValue(value, key = "") {
  if (isSecretName(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => safeValue(entry));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, safeValue(entry, entryKey)]));
  return value;
}

export function parseCapturedBody(buffer, contentType = "") {
  if (!buffer?.length) return null;
  const text = Buffer.from(buffer).subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
  if (/json/i.test(contentType)) {
    try { return safeValue(JSON.parse(text)); } catch {}
  }
  return text;
}

export async function appendTraffic(root, record) {
  const target = trafficCachePath(root);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.appendFile(target, `${JSON.stringify({ version: 1, ...record })}\n`, { mode: 0o600 });
  return target;
}

export async function readTraffic(root, { limit = 100, route, method } = {}) {
  let text;
  try { text = await fs.readFile(trafficCachePath(root), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const wantedRoute = route ? normalizeRoute(route) : null;
  return text.trim().split("\n").filter(Boolean).reverse().flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter((entry) => (!method || entry.request?.method === method.toUpperCase()) && (!wantedRoute || normalizeRoute(entry.request?.url) === wantedRoute)).slice(0, limit);
}

function collect(stream) {
  const chunks = [];
  let size = 0;
  stream.on("data", (chunk) => {
    if (size >= MAX_CAPTURE_BYTES) return;
    const bounded = Buffer.from(chunk).subarray(0, MAX_CAPTURE_BYTES - size);
    chunks.push(bounded);
    size += bounded.length;
  });
  return chunks;
}

export async function startTrafficProxy({ target, root = process.cwd(), host = "127.0.0.1", port = 43128 } = {}) {
  if (!target) throw new Error("A target URL is required");
  const upstream = new URL(target);
  if (!["http:", "https:"].includes(upstream.protocol)) throw new Error("Proxy target must use HTTP or HTTPS");
  const server = http.createServer((request, response) => {
    const startedAt = Date.now();
    const requestChunks = collect(request);
    const destination = new URL(request.url || "/", upstream);
    const transport = destination.protocol === "https:" ? https : http;
    const proxyRequest = transport.request(destination, { method: request.method, headers: { ...request.headers, host: destination.host } }, (proxyResponse) => {
      const responseChunks = collect(proxyResponse);
      response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
      proxyResponse.pipe(response);
      proxyResponse.on("end", () => {
        void appendTraffic(root, {
          id: `traffic_${crypto.randomUUID().replaceAll("-", "")}`,
          observedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          request: { method: request.method, url: destination.toString(), route: normalizeRoute(destination.pathname), headers: redactCapturedHeaders(request.headers), query: Object.fromEntries(destination.searchParams), body: parseCapturedBody(Buffer.concat(requestChunks), request.headers["content-type"]) },
          response: { status: proxyResponse.statusCode ?? null, headers: redactCapturedHeaders(proxyResponse.headers), body: parseCapturedBody(Buffer.concat(responseChunks), proxyResponse.headers["content-type"]) }
        }).catch(() => {});
      });
    });
    proxyRequest.on("error", (error) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "AIPI proxy could not reach the target" }));
      void appendTraffic(root, { id: `traffic_${crypto.randomUUID().replaceAll("-", "")}`, observedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, request: { method: request.method, url: destination.toString(), headers: redactCapturedHeaders(request.headers) }, response: { status: null, error: error.message } }).catch(() => {});
    });
    request.pipe(proxyRequest);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  return { url: `http://${host}:${address.port}`, target: upstream.toString(), cache: trafficCachePath(root), close: () => new Promise((resolve) => server.close(resolve)) };
}

export function diagnoseTraffic(record) {
  if (!record) return { category: "No observed traffic", message: "Run the request through `aipi observe` first.", failurePoint: null };
  const body = JSON.stringify(record.response?.body ?? record.response?.error ?? "");
  const stackLine = body.match(/(?:at\s+[^\n]+|[\w./-]+\.(?:ts|tsx|js|mjs):\d+(?::\d+)?)/)?.[0] ?? null;
  if (/ZodError|invalid_type|validation/i.test(body)) return { category: "Validation error", message: "The backend validation schema rejected the request payload.", failurePoint: stackLine };
  if (/PrismaClient|constraint|foreign key|unique constraint|not-null|null value/i.test(body)) return { category: "Database constraint error", message: "The database model or constraint rejected the backend operation.", failurePoint: stackLine };
  if (Number(record.response?.status) >= 500) return { category: "Backend failure", message: `The route returned HTTP ${record.response.status}.`, failurePoint: stackLine };
  if (Number(record.response?.status) >= 400) return { category: "Request contract error", message: `The request returned HTTP ${record.response.status}.`, failurePoint: stackLine };
  return { category: "Request completed", message: `The observed request returned HTTP ${record.response?.status ?? "unknown"}.`, failurePoint: stackLine };
}
