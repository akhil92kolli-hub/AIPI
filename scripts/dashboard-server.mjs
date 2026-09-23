import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { addHistory, defaultProject, defaultRequest, loadState, mutateState, newId, publicState, saveState, variablesFor } from "./workspace-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = path.join(ROOT, "ui");
const PORT = Number(process.env.API_FORGE_PORT || 43127);
const HOST = "127.0.0.1";
let dashboardUrl = `http://${HOST}:${PORT}`;

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };

function json(response, status, payload) {
  response.writeHead(status, { "content-type": mime[".json"], "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 10_000_000) throw new Error("Request payload is too large");
  }
  return text ? JSON.parse(text) : {};
}

function rowObject(rows = []) {
  return Object.fromEntries(rows.filter((row) => row.enabled !== false && row.key).map((row) => [row.key, row.value]));
}

function applyAuth(request, headers, query) {
  const auth = request.auth ?? { type: "none" };
  if (auth.type === "bearer" && auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.type === "basic") headers.authorization = `Basic ${Buffer.from(`${auth.username ?? ""}:${auth.password ?? ""}`).toString("base64")}`;
  if (auth.type === "apiKey" && auth.key) {
    if (auth.placement === "query") query[auth.key] = auth.value ?? "";
    else headers[auth.key] = auth.value ?? "";
  }
}

function runScript(source, context, label) {
  if (!source?.trim()) return [];
  const logs = [];
  const sandbox = {
    ...context,
    console: { log: (...values) => logs.push(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")) },
    setVariable: (key, value) => { context.variables[key] = value; },
    getVariable: (key) => context.variables[key]
  };
  vm.runInNewContext(`"use strict";\n${source}`, sandbox, { timeout: 500, displayErrors: true, filename: `${label}.js` });
  return logs;
}

function prepareRequest(saved, variables) {
  const request = structuredClone(saved);
  const headers = rowObject(request.headers);
  const query = rowObject(request.params);
  applyAuth(request, headers, query);
  let body;
  let bodyType = request.body?.type ?? "json";
  const content = request.body?.content ?? "";
  if (!["GET", "HEAD"].includes(request.method) && content !== "") {
    if (bodyType === "json") {
      try { body = JSON.parse(content); } catch { body = content; bodyType = "text"; }
    } else if (bodyType === "form") {
      try { body = JSON.parse(content); } catch { body = Object.fromEntries(new URLSearchParams(content)); }
    } else body = content;
  }
  const executable = {
    name: request.name, method: request.method, url: request.url, headers, query, body, body_type: bodyType,
    variables, assertions: request.assertions ?? [], timeout_ms: request.timeoutMs ?? 30000,
    max_response_bytes: request.maxResponseBytes ?? 500000,
    ca_certificate: request.certificates?.ca || undefined,
    client_certificate: request.certificates?.clientCert || undefined,
    client_key: request.certificates?.clientKey || undefined,
    reject_unauthorized: request.certificates?.rejectUnauthorized !== false
  };
  return { request, executable };
}

function diagnosisFor(result) {
  const status = result?.status;
  const body = String(result?.body ?? result?.error ?? "");
  const suggestions = [];
  let category = "Unknown failure";
  if (!result?.error && result?.ok && result?.passed !== false) {
    return { category: "Request completed", summary: `HTTP ${status} received successfully.`, suggestions: ["Review response data and contract assertions before promoting this request into an automated collection."], retryable: false };
  }
  if (result?.error) {
    category = /certificate|self.signed|unable to verify/i.test(body) ? "TLS certificate failure" : /timed out|abort/i.test(body) ? "Timeout" : /ENOTFOUND|getaddrinfo/i.test(body) ? "DNS failure" : /ECONNREFUSED/i.test(body) ? "Connection refused" : "Network failure";
  } else if (status === 400) { category = "Invalid request"; suggestions.push("Validate the body schema, content type, and required parameters."); }
  else if (status === 401) { category = "Authentication failed"; suggestions.push("Refresh credentials and verify the Authorization scheme."); }
  else if (status === 403) { category = "Authorization denied"; suggestions.push("Check scopes, roles, tenant context, and resource ownership."); }
  else if (status === 404) { category = "Route or resource not found"; suggestions.push("Check the base URL, path variables, API version, and resource identifier."); }
  else if (status === 409) { category = "State conflict"; suggestions.push("Review idempotency keys, resource version, and existing records."); }
  else if (status === 415) { category = "Unsupported media type"; suggestions.push("Set the Content-Type expected by the endpoint."); }
  else if (status === 422) { category = "Validation failed"; suggestions.push("Inspect field-level errors and compare the payload with the API schema."); }
  else if (status === 429) { category = "Rate limited"; suggestions.push("Respect Retry-After and use exponential backoff with jitter."); }
  else if (status >= 500) { category = "Server-side failure"; suggestions.push("Retry idempotent requests, correlate server logs, and capture a request ID."); }
  else if (result && result.passed === false) { category = "Assertion failure"; suggestions.push("Compare actual response fields with the expected contract."); }
  if (/html/i.test(result?.headers?.["content-type"] ?? "") && status >= 400) suggestions.push("The response is HTML; verify gateway, proxy, and route configuration.");
  if (result?.elapsed_ms > 3000) suggestions.push("The response is slow; inspect DNS, connection, server timing, and downstream dependencies.");
  if (!suggestions.length) suggestions.push("Inspect the response body, headers, and failed assertions for the first divergence.");
  return { category, summary: `${category}${status ? ` (HTTP ${status})` : ""}.`, suggestions, retryable: Boolean(result?.error || [408, 425, 429, 500, 502, 503, 504].includes(status)) };
}

async function executeSaved(executeRequest, project, savedRequest, options = {}) {
  const variables = variablesFor(project, options.variables);
  const prepared = prepareRequest(savedRequest, variables);
  const scriptLogs = [];
  try { scriptLogs.push(...runScript(savedRequest.scripts?.pre, { request: prepared.executable, variables }, "pre-request")); }
  catch (error) { return { error: `Pre-request script failed: ${error.message}`, passed: false, scriptLogs }; }
  const retry = savedRequest.retry ?? {};
  const maxAttempts = options.maxAttempts ?? (retry.enabled ? Math.max(1, Number(retry.attempts) + 1) : 1);
  const retryStatuses = String(retry.statuses ?? "408,425,429,500,502,503,504").split(",").map(Number);
  let result;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    try { result = await executeRequest(prepared.executable, variables); }
    catch (error) { result = { error: error.message, passed: false, assertions: [] }; }
    if (attempts >= maxAttempts || (!result.error && !retryStatuses.includes(result.status))) break;
    await new Promise((resolve) => setTimeout(resolve, Number(retry.delayMs ?? 500) * attempts));
  }
  result.attempts = attempts;
  result.scriptLogs = scriptLogs;
  try { result.scriptLogs.push(...runScript(savedRequest.scripts?.post, { response: result, variables }, "post-response")); }
  catch (error) { result.postScriptError = error.message; result.passed = false; }
  result.diagnosis = diagnosisFor(result);
  return result;
}

function parseScalar(text) {
  const value = text.trim();
  if (!value) return {};
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value.startsWith("[") || value.startsWith("{")) { try { return JSON.parse(value.replaceAll("'", '"')); } catch {} }
  return value;
}

function parseLooseYaml(text) {
  const lines = text.split(/\r?\n/).map((raw) => ({ raw, indent: raw.length - raw.trimStart().length, text: raw.trim() })).filter((line) => line.text && !line.text.startsWith("#"));
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const { indent, text: line } = lines[lineIndex];
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;
    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) continue;
      const itemText = line.slice(2);
      if (itemText.includes(":")) {
        const [key, ...rest] = itemText.split(":");
        const tail = rest.join(":").trim();
        const item = { [key.trim()]: tail ? parseScalar(tail) : {} };
        parent.push(item); stack.push({ indent, value: item });
      } else parent.push(parseScalar(itemText));
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const tail = line.slice(colon + 1).trim();
    if (tail) parent[key] = parseScalar(tail);
    else {
      const next = lines.slice(lineIndex + 1).find((candidate) => candidate.indent > indent);
      parent[key] = next?.text.startsWith("- ") ? [] : {};
      stack.push({ indent, value: parent[key], parent, key });
    }
  }
  return root;
}

function exampleFromSchema(schema = {}) {
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.type === "array") return [exampleFromSchema(schema.items ?? {})];
  if (schema.type === "object" || schema.properties) return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, exampleFromSchema(value)]));
  if (schema.type === "integer" || schema.type === "number") return 0;
  if (schema.type === "boolean") return false;
  return "string";
}

function importOpenApi(spec, projectName) {
  const project = defaultProject(projectName || spec.info?.title || "Imported API");
  project.description = spec.info?.description ?? "";
  const baseUrl = spec.servers?.[0]?.url ?? (spec.host ? `${spec.schemes?.[0] ?? "https"}://${spec.host}${spec.basePath ?? ""}` : "http://localhost:3000");
  project.environments[0].variables[0].value = baseUrl;
  project.requests = [];
  for (const [route, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      const request = defaultRequest(operation.summary || operation.operationId || `${method.toUpperCase()} ${route}`);
      request.method = method.toUpperCase();
      request.url = `{{baseUrl}}${route.replace(/\{([^}]+)\}/g, "{{$1}}")}`;
      request.docs = [operation.summary, operation.description].filter(Boolean).join("\n\n");
      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
      request.params = parameters.filter((item) => item.in === "query").map((item) => ({ key: item.name, value: item.example ?? item.schema?.example ?? "", enabled: item.required === true }));
      request.headers = parameters.filter((item) => item.in === "header").map((item) => ({ key: item.name, value: item.example ?? item.schema?.example ?? "", enabled: item.required === true }));
      const bodySchema = operation.requestBody?.content?.["application/json"]?.schema ?? parameters.find((item) => item.in === "body")?.schema;
      const bodyExample = operation.requestBody?.content?.["application/json"]?.example ?? (bodySchema ? exampleFromSchema(bodySchema) : undefined);
      if (bodyExample !== undefined) request.body.content = JSON.stringify(bodyExample, null, 2);
      project.requests.push(request);
    }
  }
  if (!project.requests.length) project.requests.push(defaultRequest());
  return project;
}

async function importDocument(payload) {
  let text = payload.text;
  if (payload.url) {
    const response = await fetch(payload.url);
    if (!response.ok) throw new Error(`Import URL returned HTTP ${response.status}`);
    text = await response.text();
  }
  if (!text) throw new Error("Provide an OpenAPI/Swagger document or URL");
  let document;
  try { document = JSON.parse(text); }
  catch { document = parseLooseYaml(text); }
  if (!document.openapi && !document.swagger && !document.paths) throw new Error("The document does not look like OpenAPI or Swagger");
  return importOpenApi(document, payload.name);
}

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".sql", ".json", ".yaml", ".yml"]);
const IGNORED_DIRECTORIES = new Set([".git", ".next", "node_modules", "dist", "build", "coverage", ".turbo", ".cache"]);

async function collectSourceFiles(root, limit = 4000) {
  const files = [];
  async function visit(directory) {
    if (files.length >= limit) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(target);
      } else if (entry.isFile() && (SOURCE_EXTENSIONS.has(path.extname(entry.name)) || entry.name.startsWith(".env"))) {
        files.push(target);
      }
    }
  }
  await visit(root);
  return files;
}

function relativeSource(root, file) {
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? file : relative;
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

function normalizeRoute(value) {
  return String(value ?? "")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/\$\{[^}]+\}/g, ":param")
    .replace(/\[[^\]]+\]/g, ":param")
    .replace(/:[A-Za-z0-9_]+/g, ":param")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "") || "/";
}

function recordMatches(pattern, text, makeEntry) {
  const results = [];
  for (const match of text.matchAll(pattern)) results.push(makeEntry(match));
  return results;
}

function splitSqlColumns(value) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) { parts.push(current); current = ""; }
    else current += character;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseSqlColumns(value) {
  return splitSqlColumns(value).map((raw) => raw.trim()).filter(Boolean).flatMap((definition) => {
    if (/^(constraint|primary\s+key|foreign\s+key|unique|check)\b/i.test(definition)) return [];
    const match = definition.match(/^["'`]?([\w-]+)["'`]?\s+([^\s,]+(?:\s+(?:precision|varying))?)/i);
    if (!match) return [];
    return [{ name: match[1], type: match[2], nullable: !/\bnot\s+null\b/i.test(definition), primaryKey: /\bprimary\s+key\b/i.test(definition), hasDefault: /\bdefault\b/i.test(definition) }];
  });
}

function detectFromFile(file, root, text) {
  const relative = relativeSource(root, file);
  const endpoints = [];
  const frontendCalls = [];
  const schemas = [];
  const frameworks = new Set();

  if (/package\.json$/.test(relative)) {
    try {
      const pkg = JSON.parse(text);
      const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [dependency, framework] of [["next", "Next.js"], ["express", "Express"], ["@supabase/supabase-js", "Supabase"], ["fastify", "Fastify"], ["axios", "Axios"], ["vitest", "Vitest"], ["playwright", "Playwright"]]) {
        if (dependencies[dependency]) frameworks.add(framework);
      }
    } catch {}
  }

  const nextRoute = relative.match(/(?:^|\/)app\/api\/(.+)\/route\.(?:js|jsx|ts|tsx)$/);
  if (nextRoute) {
    frameworks.add("Next.js");
    const route = `/api/${nextRoute[1].replace(/\[([^\]]+)\]/g, ":$1")}`;
    for (const match of text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
      endpoints.push({ id: newId("ep"), method: match[1], path: route, source: relative, line: lineFor(text, match.index), framework: "Next.js", confidence: .98 });
    }
  }

  for (const entry of recordMatches(/(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi, text, (match) => ({
    id: newId("ep"), method: match[1].toUpperCase(), path: match[2], source: relative,
    line: lineFor(text, match.index), framework: "Express", confidence: .96
  }))) endpoints.push(entry);
  if (endpoints.some((entry) => entry.framework === "Express")) frameworks.add("Express");

  for (const entry of recordMatches(/@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi, text, (match) => ({
    id: newId("ep"), method: match[1].toUpperCase(), path: match[2], source: relative,
    line: lineFor(text, match.index), framework: "FastAPI", confidence: .96
  }))) endpoints.push(entry);
  if (endpoints.some((entry) => entry.framework === "FastAPI")) frameworks.add("FastAPI");

  const edgeFunction = relative.match(/(?:^|\/)supabase\/functions\/([^/]+)\/(?:index|main)\.(?:js|ts)$/);
  if (edgeFunction) {
    frameworks.add("Supabase Edge Functions");
    endpoints.push({ id: newId("ep"), method: "POST", path: `/functions/v1/${edgeFunction[1]}`, source: relative, line: 1, framework: "Supabase Edge Functions", confidence: .82 });
  }

  for (const match of text.matchAll(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const statementEnd = text.indexOf(";", match.index);
    const nearby = text.slice(match.index, statementEnd >= 0 ? statementEnd + 1 : match.index + 1000);
    const method = nearby.match(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i)?.[1]?.toUpperCase() ?? "GET";
    frontendCalls.push({ id: newId("call"), method, path: match[1], source: relative, line: lineFor(text, match.index), client: "fetch", confidence: .9 });
  }
  for (const entry of recordMatches(/axios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi, text, (match) => ({
    id: newId("call"), method: match[1].toUpperCase(), path: match[2], source: relative, line: lineFor(text, match.index), client: "Axios", confidence: .92
  }))) frontendCalls.push(entry);
  if (frontendCalls.some((entry) => entry.client === "Axios")) frameworks.add("Axios");

  if (/\.sql$/.test(relative)) {
    for (const match of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:["'`]?\w+["'`]?\.)?["'`]?([\w-]+)["'`]?\s*\(([\s\S]*?)\)\s*;/gi)) {
      schemas.push({ id: newId("schema"), name: match[1], kind: "table", source: relative, line: lineFor(text, match.index), confidence: .95, columns: parseSqlColumns(match[2]) });
    }
  }
  return { endpoints, frontendCalls, schemas, frameworks: [...frameworks] };
}

function buildIntegrations(endpoints, frontendCalls) {
  const integrations = [];
  const matchedEndpointIds = new Set();
  for (const call of frontendCalls) {
    const route = endpoints.find((endpoint) => endpoint.method === call.method && normalizeRoute(endpoint.path) === normalizeRoute(call.path));
    if (route) matchedEndpointIds.add(route.id);
    integrations.push({
      id: newId("integration"), callId: call.id, endpointId: route?.id ?? null,
      method: call.method, path: call.path,
      status: route ? "healthy" : "missing-backend",
      confidence: route ? Math.min(call.confidence, route.confidence) : call.confidence
    });
  }
  for (const endpoint of endpoints.filter((entry) => !matchedEndpointIds.has(entry.id))) {
    integrations.push({ id: newId("integration"), endpointId: endpoint.id, callId: null, method: endpoint.method, path: endpoint.path, status: "unused-backend", confidence: endpoint.confidence });
  }
  return integrations;
}

export async function scanProjectSource(projectId, requestedRoots = []) {
  const roots = [];
  for (const input of requestedRoots) {
    const rawPath = String(typeof input === "string" ? input : input.path ?? "").trim();
    if (!rawPath) continue;
    const rootPath = path.resolve(rawPath);
    const stats = await fs.stat(rootPath);
    if (!stats.isDirectory()) throw new Error(`${rootPath} is not a directory`);
    roots.push({ kind: typeof input === "string" ? "workspace" : input.kind ?? "workspace", path: rootPath });
  }
  if (!roots.length) throw new Error("Add at least one local source folder");

  const endpoints = [];
  const frontendCalls = [];
  const schemas = [];
  const frameworks = new Set();
  let filesScanned = 0;
  for (const root of roots) {
    const files = await collectSourceFiles(root.path);
    filesScanned += files.length;
    for (const file of files) {
      let text;
      try { text = await fs.readFile(file, "utf8"); } catch { continue; }
      if (text.length > 2_000_000) continue;
      const detected = detectFromFile(file, root.path, text);
      detected.endpoints.forEach((entry) => endpoints.push({ ...entry, root: root.path }));
      detected.frontendCalls.forEach((entry) => frontendCalls.push({ ...entry, root: root.path }));
      detected.schemas.forEach((entry) => schemas.push({ ...entry, root: root.path }));
      detected.frameworks.forEach((entry) => frameworks.add(entry));
    }
  }
  const integrations = buildIntegrations(endpoints, frontendCalls);
  const findings = integrations.filter((entry) => entry.status !== "healthy").map((entry) => ({
    id: newId("finding"), severity: entry.status === "missing-backend" ? "high" : "medium", type: entry.status,
    title: entry.status === "missing-backend" ? `No backend route found for ${entry.method} ${entry.path}` : `No frontend consumer found for ${entry.method} ${entry.path}`,
    integrationId: entry.id
  }));
  const scan = { roots, scanStatus: "complete", lastScannedAt: new Date().toISOString(), filesScanned, frameworks: [...frameworks], endpoints, frontendCalls, integrations, schemas, findings };
  await mutateState((state) => {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) throw new Error("Project not found");
    project.sourceContext = scan;
    project.updatedAt = new Date().toISOString();
    project.summary = {
      ...(project.summary ?? {}), libraries: [...frameworks],
      iterations: [...(project.summary?.iterations ?? []), { at: scan.lastScannedAt, label: `Scanned ${filesScanned} source files` }].slice(-20)
    };
  });
  return scan;
}

export async function startDashboard({ executeRequest }) {
  const server = http.createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url, dashboardUrl);
    try {
      if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, publicState(await loadState()));
      if (request.method === "PUT" && url.pathname === "/api/state") {
        const state = await bodyJson(request); await saveState(state); return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const payload = await bodyJson(request); const project = defaultProject(payload.name || "New project");
        const workspacePath = String(payload.workspacePath ?? "").trim();
        if (workspacePath) {
          const stats = await fs.stat(path.resolve(workspacePath));
          if (!stats.isDirectory()) return json(response, 400, { error: "Workspace path must be a directory" });
        }
        project.description = payload.goal || "";
        project.summary.goal = payload.goal || project.summary.goal;
        project.environments[0].name = payload.environmentName || "Development";
        project.environments[0].variables[0].value = payload.baseUrl || "http://localhost:3000";
        await mutateState((state) => { state.projects.push(project); state.activeProjectId = project.id; });
        if (workspacePath) await scanProjectSource(project.id, [{ kind: "workspace", path: workspacePath }]);
        const current = await loadState();
        return json(response, 201, current.projects.find((entry) => entry.id === project.id));
      }
      if (request.method === "POST" && url.pathname === "/api/import") {
        const project = await importDocument(await bodyJson(request));
        await mutateState((state) => { state.projects.push(project); }); return json(response, 201, project);
      }
      if (request.method === "POST" && url.pathname === "/api/scan") {
        const payload = await bodyJson(request);
        return json(response, 200, await scanProjectSource(payload.projectId, payload.roots));
      }
      if (request.method === "POST" && url.pathname === "/api/send") {
        const payload = await bodyJson(request); const state = await loadState();
        const project = state.projects.find((item) => item.id === payload.projectId);
        if (!project) return json(response, 404, { error: "Project not found" });
        const savedRequest = payload.request ?? project.requests.find((item) => item.id === payload.requestId);
        if (!savedRequest) return json(response, 404, { error: "Request not found" });
        const result = await executeSaved(executeRequest, project, savedRequest, { maxAttempts: payload.maxAttempts });
        const log = await addHistory({ projectId: project.id, requestId: savedRequest.id, requestName: savedRequest.name, method: savedRequest.method, url: savedRequest.url, result });
        return json(response, 200, { result, logId: log.id });
      }
      if (request.method === "POST" && url.pathname === "/api/diagnose") {
        const payload = await bodyJson(request); const state = await loadState();
        const log = state.history.find((item) => item.id === payload.logId);
        return log ? json(response, 200, diagnosisFor(log.result)) : json(response, 404, { error: "Log not found" });
      }
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, url: dashboardUrl });
      if (request.method === "GET") {
        const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const target = path.resolve(UI_DIR, relative);
        if (!target.startsWith(`${UI_DIR}${path.sep}`) && target !== path.join(UI_DIR, "index.html")) return json(response, 403, { error: "Forbidden" });
        try {
          const content = await fs.readFile(target);
          response.writeHead(200, { "content-type": mime[path.extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
          response.end(content); return;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      json(response, 404, { error: "Not found" });
    } catch (error) { json(response, 500, { error: error.message }); }
  });
  server.on("error", (error) => { if (error.code !== "EADDRINUSE") process.stderr.write(`API Forge dashboard error: ${error.message}\n`); });
  await new Promise((resolve) => {
    server.listen(PORT, HOST, () => { dashboardUrl = `http://${HOST}:${server.address().port}`; resolve(); });
    server.once("error", (error) => { if (error.code === "EADDRINUSE") resolve(); });
  });
  return { server, url: dashboardUrl };
}

export { dashboardUrl, diagnosisFor, executeSaved, importOpenApi };
