import { HttpRequestInterceptor } from "@mswjs/interceptors/http";
import { appendTraffic, parseCapturedBody, redactCapturedHeaders, redactCapturedQuery, redactCapturedUrl } from "../packages/local-observer/index.mjs";

const root = process.env.AIPI_OBSERVER_ROOT || process.cwd();
const observeAll = process.env.AIPI_OBSERVER_ALL === "true";
const allowedHosts = new Set((process.env.AIPI_OBSERVER_HOSTS || "localhost,127.0.0.1,::1").split(",").map((entry) => entry.trim()).filter(Boolean));
const pending = new Map();

function isAllowed(url) {
  try { return observeAll || allowedHosts.has(new URL(url).hostname); }
  catch { return false; }
}

async function capturedBody(message) {
  if (!message || ["GET", "HEAD"].includes(message.method)) return null;
  const declaredLength = Number(message.headers.get("content-length") || 0);
  if (declaredLength > 256_000) return `[BODY OMITTED: ${declaredLength} bytes]`;
  try {
    return parseCapturedBody(Buffer.from(await message.clone().arrayBuffer()), message.headers.get("content-type") || "");
  } catch {
    return "[UNAVAILABLE STREAM]";
  }
}

const interceptor = new HttpRequestInterceptor();

interceptor.on("request", async ({ request, requestId }) => {
  if (!isAllowed(request.url)) return;
  const url = new URL(request.url);
  pending.set(requestId, {
    startedAt: Date.now(),
    request: {
      method: request.method,
      url: redactCapturedUrl(request.url),
      route: url.pathname,
      query: redactCapturedQuery(Object.fromEntries(url.searchParams)),
      headers: redactCapturedHeaders(Object.fromEntries(request.headers)),
      body: await capturedBody(request),
    },
  });
});

interceptor.on("response", async ({ response, request, requestId }) => {
  if (!isAllowed(request.url)) return;
  const observed = pending.get(requestId) ?? {
    startedAt: Date.now(),
    request: { method: request.method, url: redactCapturedUrl(request.url), headers: redactCapturedHeaders(Object.fromEntries(request.headers)) },
  };
  pending.delete(requestId);
  await appendTraffic(root, {
    id: `traffic_${crypto.randomUUID().replaceAll("-", "")}`,
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - observed.startedAt,
    source: "msw-http-interceptor",
    request: observed.request,
    response: {
      status: response.status,
      headers: redactCapturedHeaders(Object.fromEntries(response.headers)),
      body: await capturedBody(response),
    },
  });
});

interceptor.apply();
process.once("exit", () => interceptor.dispose());
