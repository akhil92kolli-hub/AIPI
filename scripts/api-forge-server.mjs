#!/usr/bin/env node

import readline from "node:readline";
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDashboard, diagnosisFor, executeSaved, scanProjectSource } from "./dashboard-server.mjs";
import { addHistory, defaultProject, defaultRequest, loadState, mutateState, newId, variablesFor } from "./workspace-store.mjs";
import { buildFixPlan, compareRunEvidence, diffObservedContract, generateFixtureContent, inferJsonShape, normalizeRoute, redactRecord, summarizeProjectEvidence } from "../packages/core/index.mjs";
import { endpointContext, integrationIssues } from "../packages/integration-map/index.mjs";
import { writeRepositoryProject } from "../packages/collection-schema/index.mjs";
import { writeRegressionTest } from "../packages/test-generators/index.mjs";
import { diffFrontendBackend, generateObservedVitest, traceNextRoute, validatePayloadAgainstTrace } from "../packages/contract-engine/index.mjs";
import { diagnoseTraffic, readTraffic } from "../packages/local-observer/index.mjs";
import { checkBlastRadius, registryFromEnvironment } from "../packages/remote-registry/index.mjs";

const SERVER = { name: "api-forge", version: "0.3.0" };
const PROTOCOL_VERSION = "2025-11-25";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = path.join(ROOT, "ui");
const DASHBOARD_RESOURCE_URI = "ui://api-forge/dashboard-v1.html";
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const SECRET_NAME = /(token|secret|password|authorization|cookie|api.?key)/i;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const assertionSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["status", "header", "json_path", "body_contains", "response_time"] },
    equals: {},
    exists: { type: "boolean" },
    contains: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    less_than_ms: { type: "number" }
  },
  additionalProperties: false
};

const requestProperties = {
  name: { type: "string", description: "Optional request name." },
  method: { type: "string", enum: METHODS, default: "GET" },
  url: { type: "string", description: "Absolute HTTP(S) URL. Supports {{variable}} placeholders." },
  headers: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
  query: { type: "object", additionalProperties: {} },
  body: { description: "JSON value or text request body." },
  body_type: { type: "string", enum: ["json", "text", "form"], default: "json" },
  variables: { type: "object", additionalProperties: {} },
  assertions: { type: "array", items: assertionSchema },
  timeout_ms: { type: "integer", minimum: 100, maximum: 120000, default: 30000 },
  max_response_bytes: { type: "integer", minimum: 1024, maximum: 5000000, default: 250000 },
  ca_certificate: { type: "string", description: "Optional PEM CA certificate for this request." },
  client_certificate: { type: "string", description: "Optional PEM client certificate for mutual TLS." },
  client_key: { type: "string", description: "Optional PEM client private key for mutual TLS." },
  reject_unauthorized: { type: "boolean", default: true, description: "Verify the server certificate. Disable only for explicitly authorized development systems." }
};

export const tools = [
  {
    name: "api_request",
    title: "Send API request",
    description: "Send one HTTP request with variable substitution and declarative assertions. Common credential headers are redacted from reports.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: requestProperties,
      additionalProperties: false
    },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: "run_collection",
    title: "Run API collection",
    description: "Run a sequence of HTTP requests, extract JSON response values, and reuse them as {{variables}} in later requests.",
    inputSchema: {
      type: "object",
      required: ["collection"],
      properties: {
        collection: {
          type: "object",
          required: ["requests"],
          properties: {
            name: { type: "string" },
            variables: { type: "object", additionalProperties: {} },
            requests: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                required: ["url"],
                properties: {
                  ...requestProperties,
                  extract: {
                    type: "object",
                    description: "Map new variable names to simple JSON paths in this response.",
                    additionalProperties: { type: "string" }
                  }
                },
                additionalProperties: false
              }
            }
          },
          additionalProperties: false
        },
        variables: { type: "object", description: "Run-level variables override collection variables.", additionalProperties: {} },
        stop_on_failure: { type: "boolean", default: true },
        timeout_ms: { type: "integer", minimum: 100, maximum: 120000, default: 30000 },
        max_response_bytes: { type: "integer", minimum: 1024, maximum: 5000000, default: 250000 }
      },
      additionalProperties: false
    },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: "scan_project",
    title: "Scan project API integrations",
    description: "Scan user-selected local source folders for frontend API calls, backend routes, database tables, frameworks, and integration gaps. Saves only derived local metadata in API Forge.",
    inputSchema: {
      type: "object",
      required: ["project_id", "roots"],
      properties: {
        project_id: { type: "string" },
        roots: {
          type: "array", minItems: 1, maxItems: 8,
          items: {
            type: "object", required: ["path"],
            properties: { kind: { type: "string", enum: ["workspace", "frontend", "backend", "database", "schemas", "tests", "docs"] }, path: { type: "string" } },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    annotations: { openWorldHint: false, readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "list_endpoints",
    title: "List discovered endpoints",
    description: "List endpoints, frontend consumers, integration status, source locations, and confidence from the latest local project scan.",
    inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "get_project_summary",
    title: "Get API project summary",
    description: "Return project goals, detected libraries, API inventory, integration health, tasks, implementation status, and recent iterations.",
    inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "get_endpoint_context",
    title: "Get endpoint integration context",
    description: "Return one endpoint's implementation, frontend consumers, schemas, saved requests, source evidence, and confidence.",
    inputSchema: { type: "object", required: ["project_id", "endpoint_id"], properties: { project_id: { type: "string" }, endpoint_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "list_integration_issues",
    title: "List API integration issues",
    description: "List missing, unused, untested, and failing API integrations with their saved source or run evidence.",
    inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "create_request",
    title: "Create saved API request",
    description: "Create a reusable request in an API Forge project from explicit method, URL, assertions, and documentation.",
    inputSchema: { type: "object", required: ["project_id", "name", "method", "url"], properties: { project_id: { type: "string" }, name: { type: "string" }, method: { type: "string", enum: METHODS }, url: { type: "string" }, assertions: { type: "array", items: assertionSchema }, documentation: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  {
    name: "run_request",
    title: "Run saved API request",
    description: "Execute a saved API Forge request in its active environment and record local run evidence.",
    inputSchema: { type: "object", required: ["project_id", "request_id"], properties: { project_id: { type: "string" }, request_id: { type: "string" }, max_attempts: { type: "integer", minimum: 1, maximum: 10 } }, additionalProperties: false },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: "get_run_evidence",
    title: "Get redacted run evidence",
    description: "Return a bounded, credential-redacted evidence bundle for one saved run, including assertions and diagnosis.",
    inputSchema: { type: "object", required: ["log_id"], properties: { log_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "trace_route",
    title: "Trace an API route",
    description: "Map a URL to its Next.js App Router handler, Zod validation schema, and Prisma or Drizzle model. With project_id and request_id, also execute the saved request through AIPI's local test hook and capture runtime evidence.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string", enum: METHODS, default: "GET" }, root: { type: "string" }, project_id: { type: "string" }, request_id: { type: "string" }, allow_state_change: { type: "boolean", default: false }, max_attempts: { type: "integer", minimum: 1, maximum: 3, default: 1 } }, additionalProperties: false },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: "diff_contract",
    title: "Diff observed API contract",
    description: "Deterministically compare a frontend fetch payload with a Next.js backend validation schema, or compare a saved run with the nearest database table. Returns exact field mismatches without changing files.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" }, frontend_file: { type: "string" }, backend_route: { type: "string" }, method: { type: "string", enum: METHODS, default: "POST" }, root: { type: "string" }, log_id: { type: "string" }, schema_name: { type: "string", description: "Optional discovered table name for saved-run comparison." } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "generate_fixture",
    title: "Generate fixture from observed traffic",
    description: "Generate a deterministic Vitest test from successfully observed local traffic, or create a redacted data fixture from a saved run. Returns content for the AI editor and does not write files.",
    inputSchema: { type: "object", properties: { endpoint: { type: "string" }, method: { type: "string", enum: METHODS, default: "GET" }, root: { type: "string" }, test_framework: { type: "string", enum: ["vitest"], default: "vitest" }, log_id: { type: "string" }, format: { type: "string", enum: ["json", "typescript", "msw", "pytest"], default: "json" }, name: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "run_local_diagnostic",
    title: "Replay and diagnose a local request",
    description: "Replay an explicit local HTTP request or analyze the latest observed request, classify validation/database/backend failures, and return the exact handler and failure evidence. State-changing methods require allow_state_change=true.",
    inputSchema: { type: "object", required: ["request_payload"], properties: { root: { type: "string" }, request_payload: { type: "object", required: ["url"], properties: { url: { type: "string" }, method: { type: "string", enum: METHODS, default: "GET" }, headers: { type: "object" }, body: {}, replay: { type: "boolean", default: true } }, additionalProperties: false }, allow_state_change: { type: "boolean", default: false } }, additionalProperties: false },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  {
    name: "check_blast_radius",
    title: "Check cross-repository blast radius",
    description: "Compare a proposed backend contract with the team schema registry and report consumer repositories, files, and lines that would break.",
    inputSchema: { type: "object", required: ["organizationId", "repository", "method", "route", "schema"], properties: { organizationId: { type: "string" }, repository: { type: "string" }, method: { type: "string" }, route: { type: "string" }, revision: { type: "string" }, schema: { type: "object" } }, additionalProperties: false },
    annotations: { openWorldHint: true, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "compare_runs",
    title: "Compare API runs",
    description: "Compare status, success, assertions, and latency between two saved API Forge runs.",
    inputSchema: { type: "object", required: ["previous_log_id", "current_log_id"], properties: { previous_log_id: { type: "string" }, current_log_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "create_fix_plan",
    title: "Create evidence-based API fix plan",
    description: "Create a review-before-mutation fix plan from a saved run and its related frontend, backend, and schema evidence.",
    inputSchema: { type: "object", required: ["log_id"], properties: { log_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "generate_regression_test",
    title: "Generate native regression test",
    description: "Write a new Vitest or Jest test for a saved request inside a configured project source root. Never overwrites an existing file.",
    inputSchema: { type: "object", required: ["project_id", "request_id", "root", "target"], properties: { project_id: { type: "string" }, request_id: { type: "string" }, root: { type: "string" }, target: { type: "string" }, framework: { type: "string", enum: ["vitest", "jest"], default: "vitest" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  {
    name: "verify_changes",
    title: "Verify API integration state",
    description: "Summarize current integration issues and latest request results after code or configuration changes without executing unsafe requests.",
    inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "export_project",
    title: "Export repository-native API project",
    description: "Export project metadata, environments without secret values, and saved requests to a .api-forge directory under a configured source root.",
    inputSchema: { type: "object", required: ["project_id", "root"], properties: { project_id: { type: "string" }, root: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "open_dashboard",
    title: "Open API Forge dashboard",
    description: "Render the API Forge project, environment, source, API inventory, and local run evidence dashboard. Use chat and API Forge tools for active work.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: {
      ui: { resourceUri: DASHBOARD_RESOURCE_URI },
      "openai/outputTemplate": DASHBOARD_RESOURCE_URI,
      "openai/toolInvocation/invoking": "Opening API Forge…",
      "openai/toolInvocation/invoked": "API Forge is ready."
    }
  },
  {
    name: "list_projects",
    title: "List API projects",
    description: "List saved API Forge projects, environments, and request counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "create_project",
    title: "Create API project",
    description: "Create a local API Forge project with an environment and optional source roots, then make it active.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, goal: { type: "string" }, environment_name: { type: "string" }, base_url: { type: "string" }, roots: { type: "array", maxItems: 8, items: { type: "object", required: ["path"], properties: { kind: { type: "string", enum: ["workspace", "frontend", "backend", "database", "schemas", "tests", "docs"] }, path: { type: "string" } }, additionalProperties: false } } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  {
    name: "select_project",
    title: "Select active API project",
    description: "Set the active API Forge project used when the dashboard next opens.",
    inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "get_project",
    title: "Get API project",
    description: "Read one API Forge project so Codex can review its requests, docs, variables, assertions, and configuration.",
    inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "get_history",
    title: "Get API test history",
    description: "Read recent API Forge request logs and diagnostics.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "diagnose_failure",
    title: "Diagnose API failure",
    description: "Analyze a saved API Forge log and suggest likely causes and targeted next checks.",
    inputSchema: { type: "object", required: ["log_id"], properties: { log_id: { type: "string" } }, additionalProperties: false },
    annotations: { openWorldHint: false, readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "retry_request",
    title: "Retry failed API request",
    description: "Retry the saved request associated with an API Forge log, applying its retry policy and recording a new log.",
    inputSchema: { type: "object", required: ["log_id"], properties: { log_id: { type: "string" }, max_attempts: { type: "integer", minimum: 1, maximum: 10, default: 2 } }, additionalProperties: false },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }
];

function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function substitute(value, variables) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (exact && Object.hasOwn(variables, exact[1])) return variables[exact[1]];
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
      if (!Object.hasOwn(variables, key)) throw new Error(`Missing variable: ${key}`);
      const replacement = variables[key];
      return replacement === null || replacement === undefined ? "" : String(replacement);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, variables)]));
  }
  return value;
}

function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, SECRET_HEADER.test(key) ? "[REDACTED]" : value]));
}

function redactVariables(variables) {
  return Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, SECRET_NAME.test(key) ? "[REDACTED]" : value]));
}

function getPath(value, path) {
  if (!path || path === "$") return value;
  const segments = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

function sameValue(actual, expected) {
  if (typeof actual === "object" || typeof expected === "object") {
    try { return JSON.stringify(actual) === JSON.stringify(expected); } catch { return false; }
  }
  return actual === expected;
}

function evaluateAssertions(assertions, response) {
  return (assertions ?? []).map((assertion, index) => {
    let actual;
    let passed = false;
    let expected;
    switch (assertion.type) {
      case "status":
        actual = response.status;
        expected = assertion.equals;
        passed = sameValue(actual, expected);
        break;
      case "header": {
        const key = String(assertion.name ?? "").toLowerCase();
        actual = response.headers[key];
        if (assertion.exists !== undefined) {
          expected = assertion.exists ? "header exists" : "header absent";
          passed = assertion.exists ? actual !== undefined : actual === undefined;
        } else if (assertion.contains !== undefined) {
          expected = `contains ${assertion.contains}`;
          passed = String(actual ?? "").includes(String(assertion.contains));
        } else {
          expected = assertion.equals;
          passed = sameValue(actual, assertion.equals);
        }
        break;
      }
      case "json_path":
        actual = getPath(response.json, assertion.path);
        if (assertion.exists !== undefined) {
          expected = assertion.exists ? "value exists" : "value absent";
          passed = assertion.exists ? actual !== undefined : actual === undefined;
        } else if (assertion.contains !== undefined) {
          expected = `contains ${assertion.contains}`;
          passed = Array.isArray(actual)
            ? actual.some((entry) => sameValue(entry, assertion.contains))
            : String(actual ?? "").includes(String(assertion.contains));
        } else {
          expected = assertion.equals;
          passed = sameValue(actual, assertion.equals);
        }
        break;
      case "body_contains":
        actual = response.body;
        expected = `contains ${assertion.contains ?? ""}`;
        passed = actual.includes(String(assertion.contains ?? ""));
        break;
      case "response_time":
        actual = response.elapsed_ms;
        expected = `< ${assertion.less_than_ms} ms`;
        passed = Number.isFinite(assertion.less_than_ms) && actual < assertion.less_than_ms;
        break;
      default:
        actual = null;
        expected = "supported assertion type";
        passed = false;
    }
    return { index, type: assertion.type, passed, actual, expected };
  });
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      const remaining = Math.max(0, maxBytes - size);
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      truncated = true;
      await reader.cancel();
      break;
    }
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated };
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function nodeRequest(url, options, maxBytes, redirectsLeft = 5, redirects = []) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timing = { socketAssignedMs: null, dnsMs: null, tcpMs: null, tlsMs: null, firstByteMs: null, totalMs: null };
    let lookupStarted;
    let connectStarted;
    let tlsStarted;
    let remoteAddress = null;
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, options, (response) => {
      timing.firstByteMs = Math.round((performance.now() - started) * 10) / 10;
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirectsLeft > 0) {
        response.resume();
        const target = new URL(response.headers.location, url);
        const redirected = { ...options };
        if (status === 303 || ((status === 301 || status === 302) && options.method === "POST")) {
          redirected.method = "GET"; redirected.body = undefined;
          delete redirected.headers?.["content-length"];
        }
        resolve(nodeRequest(target, redirected, maxBytes, redirectsLeft - 1, [...redirects, { status, from: url.toString(), to: target.toString() }]));
        return;
      }
      const chunks = [];
      let bytes = 0;
      let truncated = false;
      response.on("data", (chunk) => {
        if (bytes >= maxBytes) { truncated = true; return; }
        const remaining = maxBytes - bytes;
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) truncated = true;
      });
      response.on("end", () => {
        timing.totalMs = Math.round((performance.now() - started) * 10) / 10;
        resolve({
          status, statusText: response.statusMessage ?? "", headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
          body: Buffer.concat(chunks).toString("utf8"), truncated, finalUrl: url.toString(),
          trace: { protocol: url.protocol.replace(":", ""), host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), remoteAddress, redirects, timing }
        });
      });
    });
    request.on("socket", (socket) => {
      timing.socketAssignedMs = Math.round((performance.now() - started) * 10) / 10;
      lookupStarted = performance.now();
      socket.once("lookup", () => { timing.dnsMs = Math.round((performance.now() - lookupStarted) * 10) / 10; connectStarted = performance.now(); });
      if (!connectStarted) connectStarted = performance.now();
      socket.once("connect", () => { timing.tcpMs = Math.round((performance.now() - connectStarted) * 10) / 10; remoteAddress = socket.remoteAddress ?? null; tlsStarted = performance.now(); });
      socket.once("secureConnect", () => { timing.tlsMs = Math.round((performance.now() - tlsStarted) * 10) / 10; });
    });
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms`)));
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

export async function executeRequest(input, inheritedVariables = {}) {
  const variables = { ...inheritedVariables, ...(input.variables ?? {}) };
  const method = String(input.method ?? "GET").toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`Unsupported method: ${method}`);

  const substitutedUrl = String(substitute(input.url, variables));
  const url = new URL(substitutedUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed");
  for (const [key, value] of Object.entries(substitute(input.query ?? {}, variables))) {
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, String(entry)));
    else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = normalizeHeaders(substitute(input.headers ?? {}, variables));
  let body;
  let requestBodyValue;
  if (input.body !== undefined && !["GET", "HEAD"].includes(method)) {
    const substitutedBody = substitute(input.body, variables);
    requestBodyValue = substitutedBody;
    if (input.body_type === "form") {
      body = new URLSearchParams(Object.entries(substitutedBody ?? {}).map(([key, value]) => [key, String(value)]));
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (input.body_type === "text" || typeof substitutedBody === "string") {
      body = String(substitutedBody);
      if (input.body_type === "text" && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "text/plain; charset=utf-8";
    } else {
      body = JSON.stringify(substitutedBody);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    }
  }

  const timeoutMs = input.timeout_ms ?? 30000;
  const maxBytes = input.max_response_bytes ?? 250000;
  const startedAt = performance.now();
  const bodyValue = body instanceof URLSearchParams ? body.toString() : body;
  if (bodyValue !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) headers["content-length"] = Buffer.byteLength(bodyValue);
  const response = await nodeRequest(url, {
    method, headers, body: bodyValue, timeoutMs,
    ca: input.ca_certificate || undefined,
    cert: input.client_certificate || undefined,
    key: input.client_key || undefined,
    rejectUnauthorized: input.reject_unauthorized !== false
  }, maxBytes);
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  const captured = { text: response.body, truncated: response.truncated };
  const responseHeaders = response.headers;
  let json;
  try { json = captured.text ? JSON.parse(captured.text) : undefined; } catch { json = undefined; }
  const result = {
    name: input.name ?? `${method} ${url.pathname}`,
    request: { method, url: response.finalUrl, headers: redactHeaders(headers), ...(requestBodyValue === undefined ? {} : { bodyShape: inferJsonShape(requestBodyValue) }) },
    status: response.status,
    status_text: response.statusText,
    ok: response.status >= 200 && response.status < 300,
    elapsed_ms: elapsedMs,
    headers: redactHeaders(responseHeaders),
    body: captured.text,
    json,
    truncated: captured.truncated,
    trace: response.trace
  };
  result.assertions = evaluateAssertions(input.assertions, { ...result, headers: responseHeaders });
  result.passed = result.assertions.every((assertion) => assertion.passed);
  return result;
}

function requestSummary(result) {
  const checks = result.assertions.length
    ? `${result.assertions.filter((item) => item.passed).length}/${result.assertions.length} assertions passed`
    : "no assertions";
  const failed = result.assertions.filter((item) => !item.passed)
    .map((item) => `- ${item.type}: expected ${JSON.stringify(item.expected)}, got ${JSON.stringify(item.actual)}`)
    .join("\n");
  return `${result.name}: HTTP ${result.status} in ${result.elapsed_ms} ms; ${checks}${result.truncated ? "; response truncated" : ""}${failed ? `\n${failed}` : ""}`;
}

function toolResult(data, summary, isError = false) {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: data,
    isError
  };
}

export async function dashboardResource() {
  const [html, css, javascript] = await Promise.all([
    fs.readFile(path.join(UI_DIR, "index.html"), "utf8"),
    fs.readFile(path.join(UI_DIR, "styles.css"), "utf8"),
    fs.readFile(path.join(UI_DIR, "app.js"), "utf8")
  ]);
  const safeJavascript = javascript.replaceAll("</script", "<\\/script");
  return html
    .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
    .replace('<script type="module" src="/app.js"></script>', `<script>window.__API_FORGE_ORIGIN__=${JSON.stringify(dashboardRuntime.url)};<\/script><script type="module">${safeJavascript}<\/script>`);
}

function findProject(state, projectId) {
  return state.projects.find((entry) => entry.id === projectId);
}

function configuredRoot(project, requestedRoot) {
  const requested = path.resolve(String(requestedRoot ?? ""));
  const match = (project.sourceContext?.roots ?? []).find((entry) => path.resolve(entry.path) === requested);
  if (!match) throw new Error("Select a root already configured in this API Forge project");
  return requested;
}

function analysisRoot(project, requestedRoot) {
  if (requestedRoot && project) return configuredRoot(project, requestedRoot);
  if (requestedRoot) return path.resolve(requestedRoot);
  const first = project?.sourceContext?.roots?.[0]?.path;
  return first ? path.resolve(first) : process.cwd();
}

async function remoteBlastRadius(args) {
  const url = process.env.AIPI_REMOTE_MCP_URL;
  if (!url) return checkBlastRadius(registryFromEnvironment(), args);
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(process.env.AIPI_REMOTE_TOKEN ? { authorization: `Bearer ${process.env.AIPI_REMOTE_TOKEN}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: "check_blast_radius", arguments: args } }) });
  if (!response.ok) throw new Error(`Remote AIPI MCP returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.result?.structuredContent?.report;
}

function contextForLog(project, log) {
  const endpoint = (project.sourceContext?.endpoints ?? []).find((entry) => entry.method === log.method && normalizeRoute(entry.path) === normalizeRoute(log.url));
  const context = endpoint ? endpointContext(project, endpoint.id) : null;
  return context ? { endpoint: context.endpoint, consumer: context.consumers[0] ?? null, schemas: context.schemas, integrations: context.integrations } : {};
}

function responsePayload(result = {}) {
  if (result.json !== undefined) return result.json;
  try { return result.body ? JSON.parse(result.body) : undefined; }
  catch { return undefined; }
}

function contractDiffFor(project, result, schemaName) {
  const schemas = schemaName ? (project.sourceContext?.schemas ?? []).filter((entry) => entry.name.toLowerCase() === String(schemaName).toLowerCase()) : project.sourceContext?.schemas ?? [];
  return diffObservedContract(responsePayload(result), schemas, result.request?.url ?? "");
}

function redactedRun(log) {
  const result = log.result ?? {};
  let json = result.json;
  if (json && !Array.isArray(json) && typeof json === "object") json = redactRecord(json);
  return {
    id: log.id, projectId: log.projectId, requestId: log.requestId, requestName: log.requestName, method: log.method, url: log.url, createdAt: log.createdAt,
    result: {
      status: result.status ?? null, status_text: result.status_text, ok: result.ok, passed: result.passed, elapsed_ms: result.elapsed_ms,
      headers: redactRecord(result.headers ?? {}, true),
      body: json ? JSON.stringify(json).slice(0, 20_000) : String(result.body ?? result.error ?? "").slice(0, 20_000),
      truncated: Boolean(result.truncated || String(result.body ?? "").length > 20_000),
      assertions: result.assertions ?? [], diagnosis: result.diagnosis ?? diagnosisFor(result), attempts: result.attempts ?? 1,
      trace: result.trace ?? null, contractDiff: result.contractDiff ?? null
    }
  };
}

export async function callTool(name, args) {
  if (name === "api_request") {
    try {
      const result = await executeRequest(args ?? {});
      return toolResult(result, requestSummary(result), !result.passed);
    } catch (error) {
      return toolResult({ error: error.message }, `API request failed: ${error.message}`, true);
    }
  }

  if (name === "run_collection") {
    const collection = args?.collection;
    if (!collection || !Array.isArray(collection.requests)) return toolResult({ error: "collection.requests is required" }, "Collection is missing requests.", true);
    const variables = { ...(collection.variables ?? {}), ...(args.variables ?? {}) };
    const results = [];
    const stopOnFailure = args.stop_on_failure ?? true;
    for (let index = 0; index < collection.requests.length; index += 1) {
      const entry = collection.requests[index];
      try {
        const result = await executeRequest({
          ...entry,
          timeout_ms: entry.timeout_ms ?? args.timeout_ms,
          max_response_bytes: entry.max_response_bytes ?? args.max_response_bytes
        }, variables);
        const extracted = {};
        for (const [variableName, path] of Object.entries(entry.extract ?? {})) {
          const value = getPath(result.json, path);
          if (value === undefined) {
            result.assertions.push({ type: "extract", passed: false, actual: undefined, expected: `JSON path ${path}` });
            result.passed = false;
          } else {
            variables[variableName] = value;
            extracted[variableName] = SECRET_NAME.test(variableName) ? "[REDACTED]" : value;
          }
        }
        results.push({ ...result, extracted });
        if (!result.passed && stopOnFailure) break;
      } catch (error) {
        results.push({ name: entry.name ?? `Request ${index + 1}`, passed: false, error: error.message, assertions: [] });
        if (stopOnFailure) break;
      }
    }
    const passed = results.length === collection.requests.length && results.every((result) => result.passed);
    const report = {
      name: collection.name ?? "API collection",
      passed,
      completed: results.length,
      total: collection.requests.length,
      variables: redactVariables(variables),
      results
    };
    const summary = `${report.name}: ${passed ? "PASS" : "FAIL"} (${report.completed}/${report.total} requests completed)\n${results.map(requestSummarySafe).join("\n")}`;
    return toolResult(report, summary, !passed);
  }

  if (name === "open_dashboard") {
    return toolResult({ url: dashboardRuntime.url, mode: "inspection" }, `API Forge is ready. Inspect saved setup and evidence in the dashboard; continue active work in Codex chat.`);
  }

  if (name === "scan_project") {
    try {
      const scan = await scanProjectSource(args?.project_id, args?.roots ?? []);
      const healthy = scan.integrations.filter((entry) => entry.status === "healthy").length;
      return toolResult({ scan }, `Scanned ${scan.filesScanned} files: ${scan.endpoints.length} backend endpoints, ${scan.frontendCalls.length} frontend calls, ${healthy} matched integrations, and ${scan.findings.length} findings.`);
    } catch (error) {
      return toolResult({ error: error.message }, `Project scan failed: ${error.message}`, true);
    }
  }

  if (name === "get_endpoint_context") {
    const state = await loadState();
    const project = findProject(state, args?.project_id);
    if (!project) return toolResult({ error: "Project not found" }, "Project not found.", true);
    const context = endpointContext(project, args?.endpoint_id);
    return context ? toolResult({ context }, `${context.endpoint.method} ${context.endpoint.path}: ${context.consumers.length} consumer(s), ${context.schemas.length} schema object(s), confidence ${context.evidence.confidence}.`) : toolResult({ error: "Endpoint not found" }, "Endpoint not found.", true);
  }

  if (name === "list_integration_issues") {
    const state = await loadState();
    const project = findProject(state, args?.project_id);
    if (!project) return toolResult({ error: "Project not found" }, "Project not found.", true);
    const issues = integrationIssues(project, state.history);
    return toolResult({ issues }, `${issues.length} integration issue${issues.length === 1 ? "" : "s"}: ${issues.filter((entry) => entry.severity === "high").length} high severity.`);
  }

  if (name === "create_request") {
    let created;
    await mutateState((state) => {
      const project = findProject(state, args?.project_id);
      if (!project) throw new Error("Project not found");
      created = { ...defaultRequest(args.name), id: newId("req"), name: args.name, method: args.method, url: args.url, assertions: args.assertions ?? [], docs: args.documentation ?? "" };
      project.requests.push(created);
      project.updatedAt = new Date().toISOString();
    });
    return toolResult({ request: created }, `Created ${created.method} ${created.url} as ${created.name}.`);
  }

  if (name === "run_request") {
    const state = await loadState();
    const project = findProject(state, args?.project_id);
    const savedRequest = project?.requests.find((entry) => entry.id === args?.request_id);
    if (!project || !savedRequest) return toolResult({ error: "Saved request not found" }, "Saved request not found.", true);
    const result = await executeSaved(executeRequest, project, savedRequest, { maxAttempts: args?.max_attempts });
    const log = await addHistory({ projectId: project.id, requestId: savedRequest.id, requestName: savedRequest.name, method: savedRequest.method, url: savedRequest.url, result });
    return toolResult({ result, log_id: log.id }, result.error ? `Request failed: ${result.error}` : requestSummary(result), Boolean(result.error || !result.passed));
  }

  if (name === "get_run_evidence") {
    const state = await loadState();
    const log = state.history.find((entry) => entry.id === args?.log_id);
    return log ? toolResult({ evidence: redactedRun(log) }, `${log.requestName}: saved evidence from ${log.createdAt}.`) : toolResult({ error: "Log not found" }, "Log not found.", true);
  }

  if (name === "trace_route") {
    const state = await loadState();
    const project = findProject(state, args?.project_id);
    if (args?.url) {
      try {
        const trace = await traceNextRoute({ root: analysisRoot(project, args.root), url: args.url, method: args.method ?? "GET" });
        return toolResult({ trace }, trace.handler ? `${trace.method} ${trace.route} maps to ${trace.handler.file}:${trace.handler.line}; validation ${trace.validation?.kind ?? "not found"}; database ${trace.database?.source ?? "not found"}.` : `No Next.js App Router handler found for ${trace.method} ${trace.route}.`, !trace.handler);
      } catch (error) { return toolResult({ error: error.message }, `Route trace failed: ${error.message}`, true); }
    }
    const savedRequest = project?.requests.find((entry) => entry.id === args?.request_id);
    if (!project || !savedRequest) return toolResult({ error: "Project or saved request not found" }, "Project or saved request not found.", true);
    const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(savedRequest.method);
    if (unsafe && args?.allow_state_change !== true) return toolResult({ error: "State-changing request requires allow_state_change=true", method: savedRequest.method }, `Trace blocked: ${savedRequest.method} can change external state. Set allow_state_change=true only after explicit authorization.`, true);
    const result = await executeSaved(executeRequest, project, savedRequest, { maxAttempts: args?.max_attempts ?? 1 });
    result.contractDiff = contractDiffFor(project, result);
    const log = await addHistory({ projectId: project.id, requestId: savedRequest.id, requestName: savedRequest.name, method: savedRequest.method, url: savedRequest.url, result, traceKind: "route" });
    const context = contextForLog(project, { ...log, url: result.request?.url ?? log.url });
    const evidence = { logId: log.id, request: { id: savedRequest.id, name: savedRequest.name, method: savedRequest.method, url: result.request?.url }, response: { status: result.status ?? null, ok: Boolean(result.ok), elapsedMs: result.elapsed_ms ?? null, shape: inferJsonShape(responsePayload(result)) }, trace: result.trace ?? null, contract: result.contractDiff, source: context };
    return toolResult({ evidence }, `${savedRequest.method} ${normalizeRoute(result.request?.url ?? savedRequest.url)} traced in ${result.elapsed_ms ?? 0} ms: HTTP ${result.status ?? "error"}; contract ${result.contractDiff.status}; ${context.endpoint ? `backend ${context.endpoint.source}:${context.endpoint.line}` : "no backend source match"}.`, Boolean(result.error));
  }

  if (name === "diff_contract") {
    if (args?.frontend_file && args?.backend_route) {
      try {
        const state = await loadState();
        const project = findProject(state, args?.project_id);
        const report = await diffFrontendBackend({ root: analysisRoot(project, args.root), frontendFile: args.frontend_file, backendRoute: args.backend_route, method: args.method ?? "POST" });
        return toolResult({ diff: report }, report.mismatches.length ? `${report.mismatches.length} mismatch(es): ${report.mismatches.map((entry) => `${entry.field} frontend=${entry.frontend} backend=${entry.backend}`).join("; ")}` : "Frontend payload and backend validation schema are aligned.");
      } catch (error) { return toolResult({ error: error.message }, `Contract diff failed: ${error.message}`, true); }
    }
    const state = await loadState();
    const log = state.history.find((entry) => entry.id === args?.log_id);
    const project = findProject(state, log?.projectId);
    if (!log || !project) return toolResult({ error: "Run or project not found" }, "Run or project not found.", true);
    const diff = contractDiffFor(project, log.result ?? {}, args?.schema_name);
    return toolResult({ log_id: log.id, project_id: project.id, diff }, `Contract ${diff.status}${diff.schema ? ` against ${diff.schema.name}` : ""}: ${diff.missingRequiredFields.length} missing required, ${diff.unexpectedFields.length} unexpected, ${diff.typeMismatches.length} type mismatches.`);
  }

  if (name === "generate_fixture") {
    if (args?.endpoint) {
      try {
        const generated = await generateObservedVitest({ root: analysisRoot(null, args.root), endpoint: args.endpoint, method: args.method ?? "GET", name: args.name ?? "observed API contract" });
        const stem = normalizeRoute(args.endpoint).split("/").filter(Boolean).join("-") || "api";
        return toolResult({ fixture: { format: "vitest", suggestedPath: `tests/${stem}.contract.test.ts`, content: generated.content, source: { trafficId: generated.observed.id, observedAt: generated.observed.observedAt }, writesFiles: false } }, `Generated a Vitest regression test from observed ${String(args.method ?? "GET").toUpperCase()} ${normalizeRoute(args.endpoint)} traffic. AIPI did not write files.`);
      } catch (error) { return toolResult({ error: error.message }, `Fixture generation failed: ${error.message}`, true); }
    }
    const state = await loadState();
    const log = state.history.find((entry) => entry.id === args?.log_id);
    if (!log) return toolResult({ error: "Run not found" }, "Run not found.", true);
    const payload = responsePayload(log.result ?? {});
    if (payload === undefined) return toolResult({ error: "The run has no JSON response to turn into a fixture" }, "The run has no JSON response to turn into a fixture.", true);
    const format = args?.format ?? "json";
    const stem = String(args?.name || log.requestName || "api-fixture").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "api-fixture";
    const generated = generateFixtureContent(payload, { format, name: args?.name || "apiFixture", method: log.method, route: log.result?.request?.url ?? log.url });
    const fixture = { format, suggestedPath: `fixtures/${stem}.${generated.extension}`, content: generated.content, source: { logId: log.id, projectId: log.projectId, status: log.result?.status ?? null, observedAt: log.createdAt }, writesFiles: false };
    return toolResult({ fixture }, `Generated a redacted ${format} fixture from run ${log.id}. AIPI did not write files; the AI editor can save it to ${fixture.suggestedPath}.`);
  }

  if (name === "run_local_diagnostic") {
    const request = args?.request_payload ?? {};
    const method = String(request.method ?? "GET").toUpperCase();
    const root = analysisRoot(null, args?.root);
    if (!["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname)) return toolResult({ error: "run_local_diagnostic accepts localhost targets only" }, "Diagnostic blocked: use api_request for explicitly authorized external systems.", true);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && args?.allow_state_change !== true && request.replay !== false) return toolResult({ error: "State-changing replay requires allow_state_change=true" }, `Diagnostic replay blocked: ${method} can change local state.`, true);
    let record = (await readTraffic(root, { route: request.url, method, limit: 1 }))[0] ?? null;
    if (request.replay !== false) {
      const replay = await executeRequest({ url: request.url, method, headers: request.headers ?? {}, body: request.body, body_type: typeof request.body === "string" ? "text" : "json" });
      record = { id: `diagnostic_${crypto.randomUUID().replaceAll("-", "")}`, observedAt: new Date().toISOString(), request: { method, url: request.url, headers: redactHeaders(request.headers ?? {}), body: request.body }, response: { status: replay.status ?? null, headers: replay.headers ?? {}, body: replay.json ?? replay.body ?? replay.error } };
    }
    const diagnosis = diagnoseTraffic(record);
    const trace = await traceNextRoute({ root, url: request.url, method });
    const contractValidation = validatePayloadAgainstTrace(trace, request.body ?? record?.request?.body);
    return toolResult({ diagnosis, trace, contractValidation, evidence: record }, `${diagnosis.category}: ${diagnosis.message}${trace.handler ? ` Handler ${trace.handler.file}:${trace.handler.line}.` : ""}${contractValidation.checked && !contractValidation.valid ? ` ${contractValidation.errors.length} request contract violation(s).` : ""}`, Number(record?.response?.status) >= 400 || !record);
  }

  if (name === "check_blast_radius") {
    try {
      const report = await remoteBlastRadius(args);
      return toolResult({ report }, report.safe ? "No registered consumer breakages detected." : report.impacts.map((entry) => entry.message).join("\n"));
    } catch (error) { return toolResult({ error: error.message }, `Blast-radius check failed: ${error.message}`, true); }
  }

  if (name === "compare_runs") {
    const state = await loadState();
    const previous = state.history.find((entry) => entry.id === args?.previous_log_id);
    const current = state.history.find((entry) => entry.id === args?.current_log_id);
    if (!previous || !current) return toolResult({ error: "One or both logs were not found" }, "One or both logs were not found.", true);
    const comparison = compareRunEvidence(previous, current);
    return toolResult({ comparison }, comparison.recovered ? "The current run recovered from the previous failure." : comparison.regression ? "The current run is a regression." : `Run status ${comparison.status.changed ? "changed" : "is unchanged"}; latency delta ${comparison.latency.deltaMs} ms.`);
  }

  if (name === "create_fix_plan") {
    const state = await loadState();
    const log = state.history.find((entry) => entry.id === args?.log_id);
    const project = findProject(state, log?.projectId);
    if (!log || !project) return toolResult({ error: "Log or project not found" }, "Log or project not found.", true);
    const plan = buildFixPlan(project, log, contextForLog(project, log));
    return toolResult({ plan }, `${plan.probableRootCause} Review ${plan.affectedFiles.length} affected file(s) before mutation.`);
  }

  if (name === "generate_regression_test") {
    const state = await loadState();
    const project = findProject(state, args?.project_id);
    const request = project?.requests.find((entry) => entry.id === args?.request_id);
    if (!project || !request) return toolResult({ error: "Project or request not found" }, "Project or request not found.", true);
    const root = configuredRoot(project, args.root);
    const environment = variablesFor(project);
    const target = await writeRegressionTest({ root, target: args.target, request, environment: { baseUrl: environment.baseUrl }, framework: args.framework ?? "vitest" });
    return toolResult({ target, framework: args.framework ?? "vitest" }, `Generated a native regression test at ${target}.`);
  }

  if (name === "verify_changes") {
    const state = await loadState();
    const project = findProject(state, args?.project_id);
    if (!project) return toolResult({ error: "Project not found" }, "Project not found.", true);
    const issues = integrationIssues(project, state.history);
    const latestRuns = (project.requests ?? []).map((request) => state.history.find((entry) => entry.projectId === project.id && entry.requestId === request.id)).filter(Boolean);
    const report = { projectId: project.id, lastScanAt: project.sourceContext?.lastScannedAt ?? null, integrations: project.sourceContext?.integrations ?? [], issues, latestRuns: latestRuns.map((entry) => ({ id: entry.id, requestId: entry.requestId, passed: Boolean(entry.result?.ok && entry.result?.passed !== false), status: entry.result?.status ?? null })) };
    return toolResult({ report }, `${report.integrations.filter((entry) => entry.status === "healthy").length} healthy integrations, ${issues.length} open issues, ${report.latestRuns.filter((entry) => entry.passed).length}/${report.latestRuns.length} latest runs passing.`);
  }

  if (name === "export_project") {
    const state = await loadState();
    const project = findProject(state, args?.project_id);
    if (!project) return toolResult({ error: "Project not found" }, "Project not found.", true);
    const root = configuredRoot(project, args.root);
    const exported = await writeRepositoryProject(root, project);
    return toolResult({ directory: exported.directory, files: exported.files }, `Exported ${exported.files.length} request definitions to ${exported.directory}.`);
  }

  if (name === "list_endpoints") {
    const state = await loadState();
    const project = state.projects.find((entry) => entry.id === args?.project_id);
    if (!project) return toolResult({ error: "Project not found" }, "Project not found.", true);
    const source = project.sourceContext ?? {};
    return toolResult({ endpoints: source.endpoints ?? [], frontend_calls: source.frontendCalls ?? [], integrations: source.integrations ?? [], findings: source.findings ?? [] }, `${source.endpoints?.length ?? 0} endpoints and ${source.integrations?.length ?? 0} integrations found in ${project.name}.`);
  }

  if (name === "get_project_summary") {
    const state = await loadState();
    const project = state.projects.find((entry) => entry.id === args?.project_id);
    if (!project) return toolResult({ error: "Project not found" }, "Project not found.", true);
    const source = project.sourceContext ?? {};
    const history = state.history.filter((entry) => entry.projectId === project.id);
    const intelligence = summarizeProjectEvidence(project, history);
    const summary = {
      project: { id: project.id, name: project.name, description: project.description, goal: project.summary?.goal },
      libraries: project.summary?.libraries ?? [], tasks: project.summary?.tasks ?? [], iterations: project.summary?.iterations ?? [],
      inventory: { endpoints: source.endpoints?.length ?? 0, frontend_calls: source.frontendCalls?.length ?? 0, integrations: source.integrations?.length ?? 0, schemas: source.schemas?.length ?? 0, runs: history.length },
      health: { healthy: source.integrations?.filter((entry) => entry.status === "healthy").length ?? 0, findings: source.findings?.length ?? 0, last_scan: source.lastScannedAt ?? null, status: intelligence.status },
      corrections: intelligence.corrections,
      evidence: intelligence.evidence,
      recommended_next_actions: intelligence.recommendedNextActions
    };
    return toolResult({ summary }, `${project.name}: ${summary.health.status}. Backend ${summary.corrections.backend.length}, frontend ${summary.corrections.frontend.length}, schema ${summary.corrections.schema.length}; ${summary.inventory.endpoints} endpoints and ${summary.inventory.runs} observed runs.`);
  }

  if (name === "list_projects") {
    const state = await loadState();
    const projects = state.projects.map((project) => ({ id: project.id, name: project.name, description: project.description, active: project.id === state.activeProjectId, requests: project.requests.length, environments: project.environments.map((environment) => ({ id: environment.id, name: environment.name })) }));
    return toolResult({ projects, active_project_id: state.activeProjectId }, `${projects.length} API Forge project${projects.length === 1 ? "" : "s"}; ${projects.find((entry) => entry.active)?.name ?? "none"} is active.`);
  }

  if (name === "create_project") {
    for (const root of args?.roots ?? []) {
      const stats = await fs.stat(path.resolve(root.path));
      if (!stats.isDirectory()) return toolResult({ error: `${root.path} is not a directory` }, `${root.path} is not a directory.`, true);
    }
    const newProject = defaultProject(args.name);
    newProject.description = args.goal ?? "";
    newProject.summary.goal = args.goal || newProject.summary.goal;
    newProject.environments[0].name = args.environment_name || "Development";
    newProject.environments[0].variables[0].value = args.base_url || "http://localhost:3000";
    await mutateState((state) => {
      state.projects.push(newProject);
      state.activeProjectId = newProject.id;
    });
    if (args?.roots?.length) await scanProjectSource(newProject.id, args.roots);
    return toolResult({ project: newProject }, `Created and selected project ${newProject.name}${args?.roots?.length ? ` with ${args.roots.length} source root(s)` : ""}.`);
  }

  if (name === "select_project") {
    let selected;
    await mutateState((state) => {
      selected = findProject(state, args?.project_id);
      if (!selected) throw new Error("Project not found");
      state.activeProjectId = selected.id;
    });
    return toolResult({ project_id: selected.id, name: selected.name }, `Selected ${selected.name} as the active API Forge project.`);
  }

  if (name === "get_project") {
    const state = await loadState();
    const project = state.projects.find((item) => item.id === args?.project_id);
    return project ? toolResult({ project }, `Loaded project ${project.name}.`) : toolResult({ error: "Project not found" }, "Project not found.", true);
  }

  if (name === "get_history") {
    const state = await loadState();
    const history = state.history.filter((entry) => !args?.project_id || entry.projectId === args.project_id).slice(0, args?.limit ?? 20);
    return toolResult({ history }, `${history.length} API request log${history.length === 1 ? "" : "s"}.`);
  }

  if (name === "diagnose_failure") {
    const state = await loadState();
    const log = state.history.find((entry) => entry.id === args?.log_id);
    if (!log) return toolResult({ error: "Log not found" }, "Log not found.", true);
    const diagnosis = diagnosisFor(log.result);
    return toolResult({ log_id: log.id, diagnosis }, `${diagnosis.summary}\n${diagnosis.suggestions.map((item) => `- ${item}`).join("\n")}`);
  }

  if (name === "retry_request") {
    const state = await loadState();
    const log = state.history.find((entry) => entry.id === args?.log_id);
    const project = state.projects.find((entry) => entry.id === log?.projectId);
    const savedRequest = project?.requests.find((entry) => entry.id === log?.requestId);
    if (!log || !project || !savedRequest) return toolResult({ error: "Saved request not found" }, "The saved request for this log was not found.", true);
    const result = await executeSaved(executeRequest, project, savedRequest, { maxAttempts: args?.max_attempts ?? 2 });
    const retryLog = await addHistory({ projectId: project.id, requestId: savedRequest.id, requestName: savedRequest.name, method: savedRequest.method, url: savedRequest.url, result, retryOf: log.id });
    return toolResult({ result, log_id: retryLog.id }, result.error ? `Retry failed: ${result.error}` : requestSummary(result), Boolean(result.error || !result.passed));
  }

  return toolResult({ error: `Unknown tool: ${name}` }, `Unknown tool: ${name}`, true);
}

function requestSummarySafe(result) {
  return result.error ? `${result.name}: ERROR ${result.error}` : requestSummary(result);
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "notifications/initialized") return;
  if (message.id === undefined) return;
  try {
    if (message.method === "initialize") {
      send(jsonRpc(message.id, {
        protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER,
        instructions: "Treat the API Forge UI as an inspection surface. Use chat and tools for API work. Use api_request for one REST call and run_collection for chained tests. Requests can change external state."
      }));
      return;
    }
    if (message.method === "ping") {
      send(jsonRpc(message.id, {}));
      return;
    }
    if (message.method === "tools/list") {
      send(jsonRpc(message.id, { tools }));
      return;
    }
    if (message.method === "resources/list") {
      send(jsonRpc(message.id, { resources: [{ uri: DASHBOARD_RESOURCE_URI, name: "API Forge dashboard", title: "API Forge", description: "Inspect project setup, source coverage, environments, API inventory, and local run evidence.", mimeType: "text/html;profile=mcp-app" }] }));
      return;
    }
    if (message.method === "resources/read") {
      if (message.params?.uri !== DASHBOARD_RESOURCE_URI) {
        send(jsonRpcError(message.id, -32002, `Resource not found: ${message.params?.uri}`));
        return;
      }
      send(jsonRpc(message.id, { contents: [{
        uri: DASHBOARD_RESOURCE_URI,
        mimeType: "text/html;profile=mcp-app",
        text: await dashboardResource(),
        _meta: { ui: { prefersBorder: false, csp: { connectDomains: [dashboardRuntime.url], resourceDomains: [] } } }
      }] }));
      return;
    }
    if (message.method === "tools/call") {
      send(jsonRpc(message.id, await callTool(message.params?.name, message.params?.arguments ?? {})));
      return;
    }
    send(jsonRpcError(message.id, -32601, `Method not found: ${message.method}`));
  } catch (error) {
    send(jsonRpcError(message.id, -32603, error.message));
  }
}

let dashboardRuntime = { url: `http://127.0.0.1:${process.env.API_FORGE_PORT || 43127}` };

export async function startAipiRuntime() {
  dashboardRuntime = await startDashboard({ executeRequest });
  return dashboardRuntime;
}

if (process.argv[1] && path.basename(process.argv[1]) === "api-forge-server.mjs" && fileURLToPath(import.meta.url) === process.argv[1]) {
  await startAipiRuntime();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  input.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try { void handle(JSON.parse(trimmed)); }
    catch (error) { send(jsonRpcError(null, -32700, "Parse error", error.message)); }
  });
}
