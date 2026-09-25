export const PAIRING_PROTOCOL = "aipi.pair.v1";
export const PAIRING_MAX_MESSAGE_BYTES = 2_000_000;

const ALLOWED = new Map([
  ["GET", new Set(["/health", "/api/connection", "/api/state", "/api/timeline"])],
  ["PUT", new Set(["/api/state"])],
  ["POST", new Set(["/api/projects", "/api/import", "/api/scan", "/api/send", "/api/diagnose"])],
]);

export function pairingSubprotocol(role, secret) {
  if (!new Set(["companion", "dashboard"]).has(role)) throw new Error("Invalid pairing role");
  if (!/^[A-Za-z0-9_-]{24,160}$/.test(String(secret))) throw new Error("Invalid pairing secret");
  return `${role}.${secret}`;
}
export function validatePairingRequest(value) {
  if (!value || value.type !== "request" || typeof value.id !== "string") throw new Error("Invalid pairing request envelope");
  const method = String(value.method ?? "GET").toUpperCase();
  const url = new URL(String(value.path ?? ""), "http://aipi.local");
  if (!url.pathname.startsWith("/") || url.origin !== "http://aipi.local") throw new Error("Invalid local request path");
  if (!ALLOWED.get(method)?.has(url.pathname)) throw new Error(`${method} ${url.pathname} is not available through dashboard pairing`);
  if (value.body !== undefined && JSON.stringify(value.body).length > PAIRING_MAX_MESSAGE_BYTES) throw new Error("Pairing request body is too large");
  return { type: "request", id: value.id, method, path: `${url.pathname}${url.search}`, body: value.body };
}

export function validatePairingResponse(value) {
  if (!value || value.type !== "response" || typeof value.id !== "string" || !Number.isInteger(value.status)) throw new Error("Invalid pairing response envelope");
  return value;
}
