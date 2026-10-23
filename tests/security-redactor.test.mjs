import assert from "node:assert/strict";
import { sanitizeEvidencePayload } from "../packages/core/security-redactor.mjs";

const longBody = "x".repeat(5000);
const sanitized = sanitizeEvidencePayload({
  requestSnapshot: {
    headers: { Authorization: "Bearer top-secret", "X-API-Key": "key" },
    bodyPreview: JSON.stringify({ email: "developer@example.com", password_hash: "hash", nested: { client_secret: "vault-value" } })
  },
  responseSnapshot: { headers: { "Set-Cookie": "session=secret" }, bodyPreview: longBody }
}, ["vault-value"]);

assert.equal(sanitized.requestSnapshot.headers.Authorization, "[REDACTED]");
assert.equal(sanitized.requestSnapshot.headers["X-API-Key"], "[REDACTED]");
assert.equal(sanitized.responseSnapshot.headers["Set-Cookie"], "[REDACTED]");
assert.match(sanitized.requestSnapshot.bodyPreview, /\[REDACTED\]/);
assert.ok(!sanitized.requestSnapshot.bodyPreview.includes("vault-value"));
assert.ok(Buffer.byteLength(sanitized.responseSnapshot.bodyPreview) <= 4096);
assert.equal(sanitized.redactionManifest.truncated, true);
assert.ok(sanitized.redactionManifest.sha256Hash);
assert.ok(sanitized.redactionManifest.redactedFields.some((field) => field.includes("password_hash")));
assert.equal(sanitized.redactionManifest.plaintextSecretsPersisted, false);
console.log("Deep evidence redaction, vault replacement, and integrity truncation passed");
