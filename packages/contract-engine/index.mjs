import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import { anonymizeFixtureData, normalizeRoute } from "../core/index.mjs";
import { readTraffic } from "../local-observer/index.mjs";
import { astFrontendPayload, astRouteInfo } from "./ast-index.mjs";
import { findRouteHandler } from "./route-adapters.mjs";
import { validationForHandler } from "./validation-adapters.mjs";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".prisma"]);
const IGNORED = new Set([".git", ".next", "node_modules", "dist", "build", "coverage", ".api-forge"]);

async function walk(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && !IGNORED.has(entry.name)) await visit(target);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(target);
    }
  }
  await visit(path.resolve(root));
  return files;
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

function balanced(text, start, open = "{", close = "}") {
  let depth = 0;
  let quote = "";
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote && text[index - 1] !== "\\") quote = "";
      continue;
    }
    if (["'", '"', "`"].includes(character)) { quote = character; continue; }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, index);
    }
  }
  return "";
}

function zodType(expression) {
  if (/z\.string\(\)[\s\S]*?\.uuid\(/.test(expression)) return "uuid";
  if (/z\.string\(/.test(expression)) return "string";
  if (/z\.number\(\)[\s\S]*?\.int\(/.test(expression)) return "integer";
  if (/z\.number\(/.test(expression)) return "number";
  if (/z\.boolean\(/.test(expression)) return "boolean";
  if (/z\.array\(/.test(expression)) return "array";
  if (/z\.object\(/.test(expression)) return "object";
  if (/z\.date\(/.test(expression)) return "date";
  return "unknown";
}

function parseZodFields(text) {
  const marker = /(?:const|let|var)\s+(\w+)\s*=\s*z\.object\s*\(\s*\{/g;
  const schemas = [];
  for (const match of text.matchAll(marker)) {
    const brace = match.index + match[0].lastIndexOf("{");
    const body = balanced(text, brace);
    const fields = [];
    for (const field of body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*(z\.[\s\S]*?)(?=,\s*[A-Za-z_$][\w$]*\s*:|$)/g)) {
      fields.push({ name: field[1], type: zodType(field[2]), required: !/\.optional\s*\(/.test(field[2]), validator: field[2].trim().replace(/\s+/g, " ") });
    }
    schemas.push({ name: match[1], kind: "zod", fields });
  }
  return schemas;
}

function parseTypedBodyFields(text) {
  const match = text.match(/(?:const|let)\s+\w+\s*:\s*\{([^}]+)\}\s*=\s*await\s+\w+\.json\s*\(/);
  if (!match) return [];
  return match[1].split(/[;,]/).flatMap((part) => {
    const field = part.trim().match(/^([A-Za-z_$][\w$]*)(\?)?\s*:\s*([^\s]+)/);
    return field ? [{ name: field[1], type: field[3].replace(/[|].*$/, ""), required: !field[2], validator: "TypeScript annotation" }] : [];
  });
}

function routePattern(relative) {
  const normalized = relative.replaceAll(path.sep, "/");
  const next = normalized.match(/(?:^|\/)app\/api\/(.+)\/route\.(?:js|jsx|ts|tsx)$/);
  if (next) return `/api/${next[1].replace(/\[\.\.\.([^\]]+)\]/g, ":$1*").replace(/\[([^\]]+)\]/g, ":$1")}`;
  const edge = normalized.match(/(?:^|\/)supabase\/functions\/([^/]+)\/(?:index|main)\.(?:js|ts)$/);
  return edge ? `/functions/v1/${edge[1]}` : null;
}

function genericNodeRoute(text, route, method) {
  const quotedRoute = String(route).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quotedMethod = String(method).toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`(?:request|req)\\.method\\s*===?\\s*['"]${quotedMethod}['"][\\s\\S]{0,240}?(?:pathname|url\\.pathname)\\s*===?\\s*['"]${quotedRoute}['"]|(?:pathname|url\\.pathname)\\s*===?\\s*['"]${quotedRoute}['"][\\s\\S]{0,240}?(?:request|req)\\.method\\s*===?\\s*['"]${quotedMethod}['"]`);
  return expression.exec(text) ?? new RegExp(`(?:pathname|url\\.pathname)\\s*===?\\s*['"]${quotedRoute}['"]`).exec(text);
}

function matchesRoute(pattern, route) {
  const expected = normalizeRoute(pattern).split("/").filter(Boolean);
  const actual = normalizeRoute(route).split("/").filter(Boolean);
  if (!expected.some((entry) => entry.endsWith("*")) && expected.length !== actual.length) return false;
  return expected.every((entry, index) => entry.startsWith(":") || entry === actual[index]);
}

function parsePrisma(text, source) {
  return [...text.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\}/g)].map((match) => ({
    name: match[1], kind: "prisma", source,
    fields: match[2].split("\n").flatMap((line) => {
      const field = line.trim().match(/^(\w+)\s+(String|Int|Float|Decimal|Boolean|DateTime|Json)(\?)?/);
      if (!field) return [];
      const type = field[2] === "String" && /@db\.Uuid/.test(line) ? "uuid" : ({ String: "string", Int: "integer", Float: "number", Decimal: "number", Boolean: "boolean", DateTime: "date", Json: "object" })[field[2]];
      return [{ name: field[1], type, required: !field[3] }];
    })
  }));
}

function parseDrizzle(text, source) {
  return [...text.matchAll(/(?:pgTable|sqliteTable|mysqlTable)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{/g)].map((match) => {
    const brace = match.index + match[0].lastIndexOf("{");
    const body = balanced(text, brace);
    return { name: match[1], kind: "drizzle", source, fields: [...body.matchAll(/(?:^|,)\s*(\w+)\s*:\s*(uuid|text|varchar|integer|bigint|boolean|jsonb?|timestamp)\s*\([^,]*?\)([\s\S]*?)(?=,\s*\w+\s*:|$)/g)].map((field) => ({ name: field[1], type: ({ text: "string", varchar: "string", integer: "integer", bigint: "integer", boolean: "boolean", json: "object", jsonb: "object", timestamp: "date", uuid: "uuid" })[field[2]], required: /\.notNull\s*\(/.test(field[3]) })) };
  });
}

function resourceName(route) {
  return normalizeRoute(route).split("/").filter((entry) => entry && entry !== "api" && !entry.startsWith(":"))[0]?.replace(/ies$/, "y").replace(/s$/, "").toLowerCase() ?? "";
}

export async function traceNextRoute({ root = process.cwd(), url, method = "GET" }) {
  const rootPath = path.resolve(root);
  const route = new URL(url, "http://aipi.local").pathname;
  const files = await walk(rootPath);
  for (const file of files) {
    const relative = path.relative(rootPath, file);
    const text = await fs.readFile(file, "utf8");
    const routeHandler = findRouteHandler({ file: relative, text, url: route, method });
    if (!routeHandler) continue;
    const ast = astRouteInfo({ file, text, method });
    const schemas = ast.schemas.length ? ast.schemas : parseZodFields(text);
    const typedFields = parseTypedBodyFields(text);
    const databaseModels = [];
    for (const candidate of files) {
      const source = path.relative(rootPath, candidate);
      const content = candidate === file ? text : await fs.readFile(candidate, "utf8");
      if (candidate.endsWith(".prisma")) databaseModels.push(...parsePrisma(content, source));
      if (/\.(?:ts|tsx|js|mjs)$/.test(candidate)) databaseModels.push(...parseDrizzle(content, source));
    }
    const resource = resourceName(route);
    const database = databaseModels.find((model) => model.name.toLowerCase().replace(/s$/, "") === resource) ?? databaseModels[0] ?? null;
    const fallbackValidation = schemas.length === 1 ? schemas[0] : (typedFields.length ? { name: "requestBody", kind: "typescript", fields: typedFields } : null);
    const validation = validationForHandler({ text, handler: routeHandler, schemas, fallback: fallbackValidation });
    return { stack: routeHandler.framework, adapter: routeHandler.adapter, method: method.toUpperCase(), route: routeHandler.route, handler: { file: relative, line: ast.handler?.line ?? routeHandler.line, export: routeHandler.export, parser: ast.handler ? ast.parser : routeHandler.parser }, validation, database, confidence: validation ? Math.max(routeHandler.confidence, .98) : routeHandler.confidence };
  }
  return { stack: "Unknown", method: method.toUpperCase(), route: normalizeRoute(route), handler: null, validation: null, database: null, confidence: 0 };
}

function typeFromExpression(expression, variables = {}) {
  const value = expression.trim();
  if (variables[value]) return variables[value];
  if (/^["'`]/.test(value)) return "string";
  if (/^-?\d+$/.test(value)) return "integer";
  if (/^-?\d+\.\d+$/.test(value)) return "number";
  if (/^(true|false)$/.test(value)) return "boolean";
  if (/^\[/.test(value)) return "array";
  if (/^\{/.test(value)) return "object";
  return "unknown";
}

function frontendPayload(text, backendRoute, wantedMethod) {
  const parameterTypes = Object.fromEntries([...text.matchAll(/(?:function\s+\w+|\([^)]*\)\s*=>|async\s+function\s+\w+)\s*\(([^)]*)\)/g)].flatMap((match) => [...match[1].matchAll(/(\w+)\s*:\s*(string|number|boolean|unknown)/g)].map((field) => [field[1], field[2] === "number" ? "number" : field[2]])));
  const calls = [...text.matchAll(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((match) => { const end = text.indexOf(";", match.index); const tail = text.slice(match.index, end >= 0 ? end + 1 : match.index + 1000); return { match, tail, method: tail.match(/method\s*:\s*["'`](\w+)["'`]/i)?.[1]?.toUpperCase() ?? "GET" }; });
  const call = calls.find((entry) => normalizeRoute(entry.match[1]) === normalizeRoute(backendRoute) && (!wantedMethod || entry.method === String(wantedMethod).toUpperCase())) ?? calls.find((entry) => normalizeRoute(entry.match[1]) === normalizeRoute(backendRoute)) ?? calls[0];
  if (!call) return { route: null, method: "GET", fields: [] };
  const method = call.method;
  const object = call.tail.match(/JSON\.stringify\s*\(\s*\{([\s\S]*?)\}\s*\)/)?.[1] ?? "";
  const fields = object.split(",").flatMap((part) => {
    const match = part.trim().match(/^(\w+)(?:\s*:\s*([\s\S]+))?$/);
    if (!match) return [];
    const expression = match[2] ?? match[1];
    return [{ name: match[1], type: typeFromExpression(expression, parameterTypes), expression: expression.trim() }];
  });
  return { route: call.match[1], method, fields };
}

function compatible(frontend, backend) {
  if (frontend === backend) return true;
  if (frontend === "string" && backend === "uuid") return false;
  if (frontend === "number" && backend === "integer") return false;
  return false;
}

function fieldJsonSchema(field) {
  const validator = String(field.validator ?? "");
  if (field.type === "uuid") return { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" };
  if (["string", "number", "integer", "boolean", "array", "object"].includes(field.type)) {
    const schema = { type: field.type };
    const minimum = validator.match(/\.(?:min|gte)\s*\(\s*(-?\d+(?:\.\d+)?)/)?.[1];
    const maximum = validator.match(/\.(?:max|lte)\s*\(\s*(-?\d+(?:\.\d+)?)/)?.[1];
    if (minimum !== undefined) schema[field.type === "string" ? "minLength" : field.type === "array" ? "minItems" : "minimum"] = Number(minimum);
    if (maximum !== undefined) schema[field.type === "string" ? "maxLength" : field.type === "array" ? "maxItems" : "maximum"] = Number(maximum);
    if (field.type === "string" && /\.email\s*\(/.test(validator)) schema.format = "email";
    return schema;
  }
  if (field.type === "date") return { type: "string" };
  return {};
}

export function validationJsonSchema(validation) {
  const fields = validation?.fields ?? [];
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((field) => [field.name, fieldJsonSchema(field)])),
    required: fields.filter((field) => field.required).map((field) => field.name),
    additionalProperties: validation?.additionalProperties !== false,
  };
}

export function validatePayloadAgainstTrace(trace, payload) {
  if (!trace?.validation?.fields?.length) return { checked: false, valid: null, errors: [], schema: null };
  const schema = validationJsonSchema(trace.validation);
  const validate = new Ajv({
    allErrors: true,
    strict: false,
    formats: { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  }).compile(schema);
  const valid = validate(payload);
  return {
    checked: true,
    valid: Boolean(valid),
    errors: (validate.errors ?? []).map((error) => ({ path: error.instancePath || "/", keyword: error.keyword, message: error.message, params: error.params })),
    schema,
  };
}

export async function diffFrontendBackend({ root = process.cwd(), frontendFile, backendRoute, method = "POST" }) {
  const rootPath = path.resolve(root);
  const frontendPath = path.resolve(rootPath, frontendFile);
  if (!frontendPath.startsWith(`${rootPath}${path.sep}`)) throw new Error("Frontend file must stay inside the project root");
  const frontendText = await fs.readFile(frontendPath, "utf8");
  const frontend = astFrontendPayload({ file: frontendPath, text: frontendText, backendRoute, method }) ?? frontendPayload(frontendText, backendRoute, method);
  const backend = await traceNextRoute({ root: rootPath, url: backendRoute, method });
  if (!backend.handler) throw new Error(`No ${method.toUpperCase()} handler found for ${backendRoute}`);
  const expected = new Map((backend.validation?.fields ?? []).map((field) => [field.name, field]));
  const actual = new Map(frontend.fields.map((field) => [field.name, field]));
  const mismatches = [];
  for (const [name, field] of expected) {
    const found = actual.get(name);
    if (!found && field.required) mismatches.push({ field: name, frontend: "missing", backend: field.type, issue: "missing-required-field" });
    else if (found && !compatible(found.type, field.type)) mismatches.push({ field: name, frontend: found.type, backend: field.type, issue: "type-mismatch" });
  }
  for (const [name, field] of actual) if (!expected.has(name)) mismatches.push({ field: name, frontend: field.type, backend: "not-accepted", issue: "unexpected-field" });
  const coverage = { frontendResolved: Boolean(frontend?.fields?.length), backendResolved: Boolean(backend.validation?.fields?.length), unknownFrontendFields: frontend.fields.filter((field) => field.type === "unknown").map((field) => field.name) };
  return { status: coverage.frontendResolved && coverage.backendResolved && !coverage.unknownFrontendFields.length ? (mismatches.length ? "mismatch" : "aligned") : "unverified", coverage, frontend: { file: frontendFile, route: frontend.route, method: frontend.method, fields: frontend.fields, parser: frontend.parser ?? "fallback" }, backend: { ...backend, jsonSchema: validationJsonSchema(backend.validation) }, mismatches };
}

export async function generateObservedVitest({ root = process.cwd(), endpoint, method = "GET", name = "observed API contract" }) {
  const [observed] = await readTraffic(root, { route: endpoint, method, limit: 1 });
  if (!observed) throw new Error(`No observed ${method.toUpperCase()} traffic found for ${endpoint}`);
  const status = observed.response?.status ?? 200;
  if (status < 200 || status >= 400) throw new Error(`Refusing to generate a success regression test from observed HTTP ${status}`);
  const requestBody = observed.request?.body == null ? null : anonymizeFixtureData(observed.request.body).value;
  const body = requestBody == null ? "" : `,\n      headers: { "content-type": "application/json" },\n      body: JSON.stringify(${JSON.stringify(requestBody, null, 2)})`;
  const responsePrivacy = anonymizeFixtureData(observed.response?.body);
  const responseBody = responsePrivacy.value;
  const responseAssertion = responseBody && typeof responseBody === "object" ? `\n    const payload = await response.json();\n    expect(payload).toMatchObject(${JSON.stringify(responseBody, null, 6)});` : "";
  return { observed, privacy: { anonymized: true, fields: responsePrivacy.fields }, content: `import { describe, expect, it } from "vitest";\n\ndescribe(${JSON.stringify(name)}, () => {\n  it("locks the observed ${method.toUpperCase()} ${normalizeRoute(endpoint)} contract", async () => {\n    const response = await fetch(new URL(${JSON.stringify(normalizeRoute(endpoint))}, process.env.AIPI_BASE_URL || "http://localhost:3000"), {\n      method: ${JSON.stringify(method.toUpperCase())}${body}\n    });\n    expect(response.status).toBe(${status});${responseAssertion}\n  });\n});\n` };
}

export async function guardNextProject({ root = process.cwd() } = {}) {
  const rootPath = path.resolve(root);
  const files = await walk(rootPath);
  const results = [];
  for (const file of files.filter((entry) => /\.(?:ts|tsx|js|jsx|mjs)$/.test(entry))) {
    const text = await fs.readFile(file, "utf8");
    for (const match of text.matchAll(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      const statementEnd = text.indexOf(";", match.index);
      const tail = text.slice(match.index, statementEnd >= 0 ? statementEnd + 1 : match.index + 1000);
      const method = tail.match(/method\s*:\s*["'`](\w+)["'`]/i)?.[1]?.toUpperCase() ?? "GET";
      const trace = await traceNextRoute({ root: rootPath, url: match[1], method });
      if (!trace.handler || !trace.validation?.fields?.length) continue;
      const diff = await diffFrontendBackend({ root: rootPath, frontendFile: path.relative(rootPath, file), backendRoute: match[1], method });
      results.push(diff);
    }
  }
  const mismatches = results.flatMap((entry) => entry.mismatches.map((mismatch) => ({ ...mismatch, frontendFile: entry.frontend.file, backendFile: entry.backend.handler.file, route: entry.backend.route, method: entry.backend.method })));
  const verified = results.filter((entry) => entry.status !== "unverified").length;
  const status = mismatches.length ? "failed" : verified ? "passed" : "unverified";
  return { status, passed: status === "passed", checked: results.length, verified, mismatches, note: status === "unverified" ? "No supported frontend/backend contract pair was fully resolved." : null };
}
