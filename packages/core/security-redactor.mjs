import crypto from "node:crypto";

const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i;
const SENSITIVE_FIELD = /^(password|password_hash|secret|client_secret|access_token|refresh_token|api_key|private_key)$/i;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function secretValues(vaultKeys) {
  return (vaultKeys ?? []).flatMap((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") return entry.value ?? entry.secret ?? [];
    return [];
  }).filter((value) => typeof value === "string" && value.length > 0);
}

function truncateUtf8(value, limit) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return { value, truncated: false, originalBytes: bytes.length };
  let preview = bytes.subarray(0, limit).toString("utf8");
  while (Buffer.byteLength(preview, "utf8") > limit) preview = preview.slice(0, -1);
  return { value: preview, truncated: true, originalBytes: bytes.length, sha256Hash: sha256(bytes) };
}

export function sanitizeEvidencePayload(payload, vaultKeys = [], options = {}) {
  const maxStringBytes = Math.max(256, Number(options.maxStringBytes) || 4096);
  const secrets = secretValues(vaultKeys);
  const redactedFields = new Set();
  const truncatedFields = [];

  const visit = (value, path = "$", parseJson = true) => {
    if (typeof value === "string") {
      if (parseJson && /^\s*[{[]/.test(value)) {
        try { return JSON.stringify(visit(JSON.parse(value), path, false)); }
        catch { /* Preserve non-JSON text and continue with literal redaction. */ }
      }
      let sanitized = value;
      for (const secret of secrets) {
        if (!sanitized.includes(secret)) continue;
        sanitized = sanitized.split(secret).join("{{VAULT_REDACTED}}");
        redactedFields.add(`${path}:vault-value`);
      }
      const truncated = truncateUtf8(sanitized, maxStringBytes);
      if (truncated.truncated) truncatedFields.push({ path, originalBytes: truncated.originalBytes, sha256Hash: truncated.sha256Hash });
      return truncated.value;
    }
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, `${path}[${index}]`, parseJson));
    if (!value || typeof value !== "object") return value;
    const headerName = String(value.key ?? value.name ?? "");
    if (SENSITIVE_HEADER.test(headerName) && Object.hasOwn(value, "value")) {
      redactedFields.add(`${path}.${headerName}`);
      return { ...value, value: "[REDACTED]" };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      const fieldPath = `${path}.${key}`;
      if (SENSITIVE_HEADER.test(key) || SENSITIVE_FIELD.test(key)) {
        redactedFields.add(fieldPath);
        return [key, "[REDACTED]"];
      }
      return [key, visit(entry, fieldPath, parseJson)];
    }));
  };

  const sanitized = visit(payload);
  const previous = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized.redactionManifest ?? {} : {};
  const hashes = truncatedFields.map((entry) => entry.sha256Hash);
  const redactionManifest = {
    ...previous,
    version: 1,
    strategy: "deep-sensitive-field-and-vault-redaction",
    redactedFields: [...new Set([...(previous.redactedFields ?? previous.redactedKeys ?? []), ...redactedFields])].sort(),
    truncated: truncatedFields.length > 0,
    originalBytes: truncatedFields.reduce((sum, entry) => sum + entry.originalBytes, 0),
    sha256Hash: hashes.length ? sha256(hashes.join(":")) : previous.sha256Hash ?? null,
    truncatedFields,
    plaintextSecretsPersisted: false
  };
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) sanitized.redactionManifest = redactionManifest;
  return sanitized;
}

export function markImportedPayloadUntrusted(value, source = "import") {
  return { ...value, untrustedData: true, untrustedSource: source };
}
