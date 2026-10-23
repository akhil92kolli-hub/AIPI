function decodeUtf8Base64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length > 16384) return null;
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!decoded || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) return null;
  return decoded;
}

function parseJwtToken(value) {
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  try {
    const header = JSON.parse(decodeUtf8Base64(parts[0]));
    const claims = JSON.parse(decodeUtf8Base64(parts[1]));
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") return null;
    return { header, claims };
  } catch {
    return null;
  }
}

function scanPayloadStrings(payload, predicate) {
  const matches = [];
  const visit = (value, path, depth) => {
    if (matches.length >= 20 || depth > 5) return;
    if (typeof value === "string") {
      const match = predicate(value);
      if (match) matches.push({ path, ...match });
    } else if (Array.isArray(value)) {
      value.slice(0, 40).forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
    } else if (value && typeof value === "object") {
      Object.entries(value).slice(0, 60).forEach(([key, entry]) => visit(entry, path ? `${path}.${key}` : key, depth + 1));
    }
  };
  visit(payload, "$", 0);
  return matches;
}

export function extractJwtTokens(payload) {
  return scanPayloadStrings(payload, (value) => parseJwtToken(value));
}

export function extractBase64TextFields(payload) {
  return scanPayloadStrings(payload, (value) => {
    if (value.length < 16 || value.length > 22000 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
    try {
      const decoded = decodeUtf8Base64(value);
      return decoded ? { decoded: decoded.slice(0, 1200), truncated: decoded.length > 1200 } : null;
    } catch {
      return null;
    }
  });
}
