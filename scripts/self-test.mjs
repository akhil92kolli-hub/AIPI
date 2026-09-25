#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffFrontendBackend, generateObservedVitest, guardNextProject, traceNextRoute, validatePayloadAgainstTrace } from "../packages/contract-engine/index.mjs";
import { diagnoseTraffic, readTraffic, startTrafficProxy } from "../packages/local-observer/index.mjs";
import { checkBlastRadius, FileRegistry } from "../packages/remote-registry/index.mjs";
import { createRemoteMcpServer } from "./remote-mcp-server.mjs";
import { createLinuxSecretServiceVault, createWindowsCredentialVault, hydrateStateSecrets, isSecretReference, protectStateSecrets, redactStateSecrets } from "../packages/core/secret-vault.mjs";
import { createTimelineEvent, migrateTimeline } from "../packages/core/timeline.mjs";

const api = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/items" && request.method === "POST") {
    response.writeHead(201);
    response.end(JSON.stringify({ id: "item-42", created: true }));
    return;
  }
  if (request.url === "/items/item-42" && request.method === "GET") {
    response.writeHead(200);
    response.end(JSON.stringify({ id: "item-42", name: "demo" }));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const address = api.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const serverPath = fileURLToPath(new URL("./aipi-mcp-bundle.mjs", import.meta.url));
const observerHookPath = fileURLToPath(new URL("./aipi-observer-hook.mjs", import.meta.url));
const testData = await fs.mkdtemp(path.join(os.tmpdir(), "api-forge-test-"));
const sourceFixture = path.join(testData, "source-fixture");
await fs.mkdir(path.join(sourceFixture, "app", "api", "users"), { recursive: true });
await fs.mkdir(path.join(sourceFixture, "frontend"), { recursive: true });
await fs.mkdir(path.join(sourceFixture, "database"), { recursive: true });
await fs.mkdir(path.join(sourceFixture, "prisma"), { recursive: true });
await fs.mkdir(path.join(sourceFixture, "supabase", "functions", "create-user"), { recursive: true });
await fs.writeFile(path.join(sourceFixture, "app", "api", "users", "route.ts"), 'import { z } from "zod";\nconst createUser = z.object({ customerId: z.string().uuid() });\nexport async function GET() { return Response.json([]); }\nexport async function POST(request: Request) { return Response.json(createUser.parse(await request.json())); }\n');
await fs.writeFile(path.join(sourceFixture, "frontend", "users.ts"), "export const users = () => fetch('/api/users');\nexport async function createUser(customerId: number) { return fetch('/api/users', { method: 'POST', body: JSON.stringify({ customerId }) }); }\n");
await fs.writeFile(path.join(sourceFixture, "database", "schema.sql"), "create table users (id uuid primary key);\n");
await fs.writeFile(path.join(sourceFixture, "prisma", "schema.prisma"), "model User {\n id String @id @db.Uuid\n customerId String @db.Uuid\n}\n");
await fs.writeFile(path.join(sourceFixture, "supabase", "functions", "create-user", "index.ts"), 'import { z } from "zod";\nconst payload = z.object({ customerId: z.string().uuid() });\nDeno.serve(async (request) => Response.json(payload.parse(await request.json())));\n');
const registryFile = path.join(testData, "registry.json");
const dashboardToken = "self-test-session-token";
const dashboardHeaders = { authorization: `Bearer ${dashboardToken}`, "content-type": "application/json" };
const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, API_FORGE_DATA: testData, API_FORGE_PORT: "43129", AIPI_REGISTRY_FILE: registryFile, AIPI_TOKEN: dashboardToken } });
const output = readline.createInterface({ input: child.stdout });
const pending = new Map();
output.on("line", (line) => {
  const message = JSON.parse(line);
  const callback = pending.get(message.id);
  if (callback) {
    pending.delete(message.id);
    callback(message);
  }
});

let nextId = 1;
function rpc(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 3000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

let observer;
let remoteServer;
try {
  const sanitizedTimelineEvent = createTimelineEvent({ projectId: "prj_test", title: "Safe evidence", evidence: { apiToken: "must-not-leak", nested: { password: "also-secret", count: 2 } } });
  assert.equal(sanitizedTimelineEvent.evidence.apiToken, "[REDACTED]");
  assert.equal(sanitizedTimelineEvent.evidence.nested.password, "[REDACTED]");
  const migratedTimeline = migrateTimeline({ history: [{ id: "log_test", projectId: "prj_test", createdAt: new Date().toISOString(), method: "GET", url: "/health", result: { ok: true, status: 200, assertions: [] } }] });
  assert.equal(migratedTimeline[0].type, "run");
  assert.equal(migratedTimeline[0].source.ref, "log_test");

  const memorySecrets = new Map();
  const fakeVault = {
    provider: "test-vault",
    service: "test",
    async set(reference, value) { memorySecrets.set(reference, value); },
    async get(reference) { return memorySecrets.get(reference); }
  };
  const secretFixture = {
    projects: [{
      id: "prj_secret",
      environments: [{ id: "env_secret", variables: [{ key: "API_TOKEN", value: "environment-secret", enabled: true, secret: true }] }],
      requests: [{ id: "req_secret", auth: { token: "bearer-secret", password: "basic-secret", value: "api-key-secret" }, certificates: { clientKey: "private-key-secret" } }]
    }]
  };
  const protectedFixture = await protectStateSecrets(secretFixture, { vault: fakeVault });
  const protectedJson = JSON.stringify(protectedFixture);
  for (const value of ["environment-secret", "bearer-secret", "basic-secret", "api-key-secret", "private-key-secret"]) assert.doesNotMatch(protectedJson, new RegExp(value));
  assert.equal(isSecretReference(protectedFixture.projects[0].environments[0].variables[0].value), true);
  const hydratedFixture = await hydrateStateSecrets(protectedFixture, { vault: fakeVault });
  assert.equal(hydratedFixture.projects[0].requests[0].auth.token, "bearer-secret");
  const redactedFixture = redactStateSecrets(hydratedFixture);
  assert.equal(redactedFixture.projects[0].environments[0].variables[0].value, "[REDACTED]");
  assert.equal(redactedFixture.projects[0].requests[0].certificates.clientKey, "[REDACTED]");

  const providerReference = "aipi-secret://provider-contract-test";
  const linuxCalls = [];
  const linuxVault = createLinuxSecretServiceVault({
    binary: "/usr/bin/secret-tool",
    async run(command, args, options = {}) {
      linuxCalls.push({ command, args, options });
      if (args[0] === "lookup") return { stdout: "linux-secret\n", stderr: "" };
      return { stdout: "", stderr: "" };
    }
  });
  await linuxVault.set(providerReference, "linux-secret");
  assert.equal(linuxCalls[0].options.input, "linux-secret");
  assert.doesNotMatch(JSON.stringify(linuxCalls[0].args), /linux-secret/);
  assert.equal(await linuxVault.get(providerReference), "linux-secret");
  await linuxVault.delete(providerReference);
  assert.equal(linuxCalls[2].args[0], "clear");

  const windowsCalls = [];
  const windowsVault = createWindowsCredentialVault({
    binary: "powershell.exe",
    async run(command, args, options = {}) {
      windowsCalls.push({ command, args, options });
      if (options.env?.AIPI_CREDENTIAL_ACTION === "get") return { stdout: Buffer.from("windows-secret", "utf8").toString("base64"), stderr: "" };
      return { stdout: "", stderr: "" };
    }
  });
  await windowsVault.set(providerReference, "windows-secret");
  assert.equal(windowsCalls[0].options.input, "windows-secret");
  assert.doesNotMatch(JSON.stringify(windowsCalls[0].args), /windows-secret/);
  assert.equal(await windowsVault.get(providerReference), "windows-secret");
  await windowsVault.delete(providerReference);
  assert.equal(windowsCalls[2].options.env.AIPI_CREDENTIAL_ACTION, "delete");

  const tracedSource = await traceNextRoute({ root: sourceFixture, url: "/api/users", method: "POST" });
  assert.equal(tracedSource.handler.file, "app/api/users/route.ts");
  assert.equal(tracedSource.validation.fields[0].type, "uuid");
  assert.equal(tracedSource.database.source, "prisma/schema.prisma");
  assert.equal(tracedSource.handler.parser, "ts-morph");
  const tracedEdge = await traceNextRoute({ root: sourceFixture, url: "/functions/v1/create-user", method: "POST" });
  assert.equal(tracedEdge.stack, "Supabase Edge Functions");
  assert.equal(tracedEdge.validation.fields[0].type, "uuid");
  const invalidPayload = validatePayloadAgainstTrace(tracedSource, { customerId: 42 });
  assert.equal(invalidPayload.valid, false);
  assert.equal(invalidPayload.errors[0].keyword, "type");
  const directDiff = await diffFrontendBackend({ root: sourceFixture, frontendFile: "frontend/users.ts", backendRoute: "/api/users", method: "POST" });
  assert.deepEqual(directDiff.mismatches[0], { field: "customerId", frontend: "number", backend: "uuid", issue: "type-mismatch" });
  const guard = await guardNextProject({ root: sourceFixture });
  assert.equal(guard.passed, false);

  observer = await startTrafficProxy({ target: baseUrl, root: sourceFixture, port: 0 });
  const observedResponse = await fetch(`${observer.url}/items/item-42`);
  assert.equal(observedResponse.status, 200);
  await observedResponse.text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [observed] = await readTraffic(sourceFixture, { route: "/items/item-42", method: "GET" });
  assert.equal(observed.response.status, 200);
  assert.equal(diagnoseTraffic(observed).category, "Request completed");
  const observedTest = await generateObservedVitest({ root: sourceFixture, endpoint: "/items/item-42", method: "GET" });
  assert.match(observedTest.content, /locks the observed GET/);
  const hookChild = spawn(process.execPath, ["--import", observerHookPath, "--eval", `await fetch(${JSON.stringify(`${baseUrl}/items/item-42`)}, { headers: { authorization: "Bearer should-not-leak" } }); await new Promise((resolve) => setTimeout(resolve, 80));`], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, AIPI_OBSERVER_ROOT: sourceFixture },
  });
  const hookExit = await new Promise((resolve) => hookChild.once("exit", resolve));
  assert.equal(hookExit, 0);
  const [hookObserved] = await readTraffic(sourceFixture, { route: "/items/item-42", method: "GET", limit: 1 });
  assert.equal(hookObserved.source, "msw-http-interceptor");
  assert.equal(hookObserved.request.headers.authorization, "[REDACTED]");

  const registry = new FileRegistry(registryFile);
  await registry.upsert({ organizationId: "org_demo", repository: "payments-api", method: "POST", route: "/api/checkout", revision: "abc123", schema: { fields: [{ name: "payment_id", type: "uuid", required: true }] }, consumers: [{ repository: "ios-app-repo", file: "Checkout.swift", line: 42, fields: [{ name: "payment_id", type: "uuid", required: true }] }, { repository: "billing-dashboard-repo", file: "src/checkout.ts", line: 18, fields: [{ name: "payment_id", type: "uuid", required: true }] }] });
  const blast = await checkBlastRadius(registry, { organizationId: "org_demo", repository: "payments-api", method: "POST", route: "/api/checkout", schema: { fields: [] } });
  assert.equal(blast.safe, false);
  assert.deepEqual(blast.impacts.map((entry) => entry.repository), ["ios-app-repo", "billing-dashboard-repo"]);

  remoteServer = createRemoteMcpServer();
  await new Promise((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
  const remoteUrl = `http://127.0.0.1:${remoteServer.address().port}/mcp`;
  const remoteResponse = await fetch(remoteUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  const remotePayload = await remoteResponse.json();
  assert.ok(remotePayload.result.tools.some((tool) => tool.name === "check_blast_radius"));

  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "self-test", version: "1" } });
  assert.equal(initialized.result.serverInfo.name, "aipi");
  assert.equal(typeof initialized.result.capabilities.resources.listChanged, "boolean");

  const listed = await rpc("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).slice(0, 2), ["api_request", "run_collection"]);
  assert.ok(["trace_route", "diff_contract", "run_local_diagnostic", "generate_fixture", "check_blast_radius", "get_secret_storage_status", "get_project_timeline", "record_project_event", "analyze_and_repair_contract"].every((name) => listed.result.tools.some((tool) => tool.name === name)));
  const secretStatus = await rpc("tools/call", { name: "get_secret_storage_status", arguments: {} });
  assert.equal(secretStatus.result.structuredContent.status.plaintextFallback, false);
  const dashboardTool = listed.result.tools.find((tool) => tool.name === "open_dashboard");
  assert.equal(dashboardTool._meta.ui.resourceUri, "ui://api-forge/dashboard-v1.html");

  const resources = await rpc("resources/list");
  assert.equal(resources.result.resources[0].mimeType, "text/html;profile=mcp-app");
  const resource = await rpc("resources/read", { uri: "ui://api-forge/dashboard-v1.html" });
  assert.equal(resource.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.result.contents[0].text, /window\.__API_FORGE_ORIGIN__/);
  assert.match(resource.result.contents[0].text, /sendFollowUpMessage/);

  const single = await rpc("tools/call", {
    name: "api_request",
    arguments: {
      method: "GET",
      url: `${baseUrl}/items/item-42`,
      assertions: [
        { type: "status", equals: 200 },
        { type: "json_path", path: "id", equals: "item-42" }
      ]
    }
  });
  assert.equal(single.result.structuredContent.passed, true);

  const collection = await rpc("tools/call", {
    name: "run_collection",
    arguments: {
      collection: {
        name: "create and read",
        variables: { baseUrl },
        requests: [
          {
            name: "create",
            method: "POST",
            url: "{{baseUrl}}/items",
            body: { name: "demo" },
            assertions: [{ type: "status", equals: 201 }],
            extract: { itemId: "id" }
          },
          {
            name: "read",
            method: "GET",
            url: "{{baseUrl}}/items/{{itemId}}",
            assertions: [{ type: "json_path", path: "name", equals: "demo" }]
          }
        ]
      }
    }
  });
  assert.equal(collection.result.structuredContent.passed, true);
  assert.equal(collection.result.structuredContent.completed, 2);

  const dashboard = await rpc("tools/call", { name: "open_dashboard", arguments: {} });
  assert.equal(dashboard.result.structuredContent.url, "http://127.0.0.1:43129");
  const dashboardPage = await fetch("http://127.0.0.1:43129/");
  assert.equal(dashboardPage.status, 200);
  const dashboardHtml = await dashboardPage.text();
  assert.match(dashboardHtml, /AIPI/);
  assert.match(dashboardHtml, /id="app"/);
  assert.match(dashboardHtml, /id="modal"/);
  const dashboardStyles = await fetch("http://127.0.0.1:43129/styles.css");
  assert.equal(dashboardStyles.status, 200);
  assert.match(await dashboardStyles.text(), /\.bottom-nav/);
  const dashboardApp = await fetch("http://127.0.0.1:43129/app.js");
  const dashboardAppText = await dashboardApp.text();
  assert.match(dashboardAppText, /function renderProject/);
  assert.match(dashboardAppText, /function renderHome/);
  assert.match(dashboardAppText, /function selectProject/);
  assert.match(dashboardAppText, /async function sendToCodex/);
  assert.match(dashboardAppText, /function openCreateProjectModal/);
  assert.match(dashboardAppText, /function openCreateEnvironmentModal/);
  assert.match(dashboardAppText, /function openEditProjectModal/);
  assert.match(dashboardAppText, /function renderProjectSummary/);
  assert.match(dashboardAppText, /function timelineEvent/);
  assert.match(dashboardAppText, /Project source of truth/);
  assert.match(dashboardAppText, /data-timeline-filter/);
  assert.match(dashboardAppText, /id="apiEnvironmentSelect"/);
  assert.match(dashboardAppText, /class="mobile-header"/);
  assert.doesNotMatch(dashboardAppText, /\["summary", "Summary"\]/);

  const createdProjectResponse = await fetch("http://127.0.0.1:43129/api/projects", {
    method: "POST",
    headers: dashboardHeaders,
    body: JSON.stringify({ name: "Created project", goal: "Verify project creation", environmentName: "Local", baseUrl, workspacePath: sourceFixture })
  });
  assert.equal(createdProjectResponse.status, 201);
  const createdProject = await createdProjectResponse.json();
  assert.equal(createdProject.summary.goal, "Verify project creation");
  assert.equal(createdProject.environments[0].name, "Local");
  assert.equal(createdProject.environments[0].variables[0].value, baseUrl);
  assert.equal(createdProject.sourceContext.scanStatus, "complete");

  const otelResponse = await fetch("http://127.0.0.1:43129/api/otel/v1/traces", {
    method: "POST",
    headers: dashboardHeaders,
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "fixture-api" } }] }, scopeSpans: [{ spans: [{ traceId: "trace-1", spanId: "span-1", name: "GET /api/users", startTimeUnixNano: "1000000", endTimeUnixNano: "4000000", attributes: [{ key: "http.request.method", value: { stringValue: "GET" } }, { key: "http.route", value: { stringValue: "/api/users" } }, { key: "http.response.status_code", value: { intValue: "200" } }] }] }] }] })
  });
  assert.equal(otelResponse.status, 202);
  assert.equal((await otelResponse.json()).accepted, 1);
  const authenticatedState = await (await fetch("http://127.0.0.1:43129/api/state", { headers: dashboardHeaders })).json();
  assert.equal(authenticatedState.projects.find((entry) => entry.id === createdProject.id).sourceContext.runtimeTraces[0].route, "/api/users");

  const imported = await fetch("http://127.0.0.1:43129/api/import", {
    method: "POST",
    headers: dashboardHeaders,
    body: JSON.stringify({ text: JSON.stringify({ openapi: "3.0.3", info: { title: "Test API" }, servers: [{ url: baseUrl }], paths: { "/items": { get: { summary: "List items", responses: { "200": { description: "OK" } } } } } }) })
  });
  assert.equal(imported.status, 201);
  const importedProject = await imported.json();
  assert.equal(importedProject.requests[0].name, "List items");

  const projects = await rpc("tools/call", { name: "list_projects", arguments: {} });
  assert.equal(projects.result.structuredContent.projects.length, 3);
  const projectId = projects.result.structuredContent.projects[0].id;
  const toolProject = await rpc("tools/call", { name: "create_project", arguments: { name: "Tool-created project", goal: "Exercise native project creation", environment_name: "Preview", base_url: baseUrl } });
  assert.equal(toolProject.result.structuredContent.project.environments[0].name, "Preview");
  const selectedProject = await rpc("tools/call", { name: "select_project", arguments: { project_id: projectId } });
  assert.equal(selectedProject.result.structuredContent.project_id, projectId);
  const selectedProjects = await rpc("tools/call", { name: "list_projects", arguments: {} });
  assert.equal(selectedProjects.result.structuredContent.active_project_id, projectId);
  const scanned = await rpc("tools/call", { name: "scan_project", arguments: { project_id: projectId, roots: [{ kind: "workspace", path: sourceFixture }] } });
  assert.equal(scanned.result.structuredContent.scan.endpoints.length, 3);
  assert.equal(scanned.result.structuredContent.scan.git.length, 1);
  assert.equal(scanned.result.structuredContent.scan.frontendCalls.length, 2);
  assert.equal(scanned.result.structuredContent.scan.integrations[0].status, "healthy");
  assert.equal(scanned.result.structuredContent.scan.schemas[0].name, "users");
  assert.equal(scanned.result.structuredContent.scan.schemas[0].columns[0].name, "id");
  assert.equal(scanned.result.structuredContent.scan.schemas[0].columns[0].primaryKey, true);
  const endpoints = await rpc("tools/call", { name: "list_endpoints", arguments: { project_id: projectId } });
  assert.equal(endpoints.result.structuredContent.endpoints[0].path, "/api/users");
  const endpointId = endpoints.result.structuredContent.endpoints[0].id;
  const endpointEvidence = await rpc("tools/call", { name: "get_endpoint_context", arguments: { project_id: projectId, endpoint_id: endpointId } });
  assert.ok(endpointEvidence.result.structuredContent.context.consumers.length >= 1);
  assert.equal(endpointEvidence.result.structuredContent.context.evidence.detectionMethod, "Next.js App Router adapter");
  const issues = await rpc("tools/call", { name: "list_integration_issues", arguments: { project_id: projectId } });
  assert.ok(issues.result.structuredContent.issues.some((entry) => entry.type === "untested"));

  const created = await rpc("tools/call", { name: "create_request", arguments: { project_id: projectId, name: "Read generated item", method: "GET", url: `${baseUrl}/items/item-42`, assertions: [{ type: "status", equals: 200 }, { type: "json_path", path: "id", equals: "item-42" }] } });
  const requestId = created.result.structuredContent.request.id;
  const firstSavedRun = await rpc("tools/call", { name: "run_request", arguments: { project_id: projectId, request_id: requestId } });
  assert.equal(firstSavedRun.result.structuredContent.result.passed, true);
  const secondSavedRun = await rpc("tools/call", { name: "run_request", arguments: { project_id: projectId, request_id: requestId } });
  const boundedAnalysis = await rpc("tools/call", { name: "analyze_and_repair_contract", arguments: { project_id: projectId, request_id: requestId } });
  assert.equal(boundedAnalysis.result.structuredContent.endpoint.id, requestId);
  assert.equal(boundedAnalysis.result.structuredContent.scope.requestId, requestId);
  assert.ok(boundedAnalysis.result.structuredContent.telemetry.estimatedTokens < 1200);
  assert.equal(JSON.stringify(boundedAnalysis.result.structuredContent).includes("demo"), false);
  const boundedVerification = await rpc("tools/call", { name: "analyze_and_repair_contract", arguments: { project_id: projectId, request_id: requestId, verify_after_changes: true } });
  assert.equal(boundedVerification.result.structuredContent.verification.scope.requestId, requestId);
  assert.equal(boundedVerification.result.structuredContent.verification.passed, false);
  assert.equal(boundedVerification.result.structuredContent.verification.outcome, "unverified");
  const traced = await rpc("tools/call", { name: "trace_route", arguments: { project_id: projectId, request_id: requestId } });
  assert.equal(traced.result.structuredContent.evidence.response.status, 200);
  assert.ok(traced.result.structuredContent.evidence.trace.timing.totalMs >= 0);
  assert.equal(traced.result.structuredContent.evidence.contract.status, "unverified");
  const contractDiff = await rpc("tools/call", { name: "diff_contract", arguments: { log_id: traced.result.structuredContent.evidence.logId, schema_name: "users" } });
  assert.ok(contractDiff.result.structuredContent.diff.unexpectedFields.includes("name"));
  const fixture = await rpc("tools/call", { name: "generate_fixture", arguments: { log_id: traced.result.structuredContent.evidence.logId, format: "msw", name: "itemResponse" } });
  assert.equal(fixture.result.structuredContent.fixture.writesFiles, false);
  assert.match(fixture.result.structuredContent.fixture.content, /HttpResponse\.json/);
  assert.equal(fixture.result.structuredContent.fixture.privacy.anonymized, true);
  assert.doesNotMatch(fixture.result.structuredContent.fixture.content, /"id"\s*:\s*"item-42"|"name"\s*:\s*"demo"/);
  const directTrace = await rpc("tools/call", { name: "trace_route", arguments: { url: "/api/users", method: "POST", root: sourceFixture } });
  assert.equal(directTrace.result.structuredContent.trace.validation.fields[0].type, "uuid");
  const directContract = await rpc("tools/call", { name: "diff_contract", arguments: { frontend_file: "frontend/users.ts", backend_route: "/api/users", method: "POST", root: sourceFixture } });
  assert.equal(directContract.result.structuredContent.diff.mismatches[0].backend, "uuid");
  const diagnostic = await rpc("tools/call", { name: "run_local_diagnostic", arguments: { root: sourceFixture, request_payload: { url: `${observer.url}/items/item-42`, method: "GET", replay: false } } });
  assert.equal(diagnostic.result.structuredContent.diagnosis.category, "Request completed");
  const observedFixture = await rpc("tools/call", { name: "generate_fixture", arguments: { endpoint: "/items/item-42", method: "GET", root: sourceFixture, test_framework: "vitest" } });
  assert.match(observedFixture.result.structuredContent.fixture.content, /from "vitest"/);
  const blastTool = await rpc("tools/call", { name: "check_blast_radius", arguments: { organizationId: "org_demo", repository: "payments-api", method: "POST", route: "/api/checkout", schema: { fields: [] } } });
  assert.equal(blastTool.result.structuredContent.report.impacts.length, 2);
  const stateChanging = await rpc("tools/call", { name: "create_request", arguments: { project_id: projectId, name: "Create item safely", method: "POST", url: `${baseUrl}/items` } });
  const blockedTrace = await rpc("tools/call", { name: "trace_route", arguments: { project_id: projectId, request_id: stateChanging.result.structuredContent.request.id } });
  assert.equal(blockedTrace.result.isError, true);
  assert.match(blockedTrace.result.structuredContent.error, /allow_state_change=true/);
  const evidence = await rpc("tools/call", { name: "get_run_evidence", arguments: { log_id: firstSavedRun.result.structuredContent.log_id } });
  assert.equal(evidence.result.structuredContent.evidence.result.status, 200);
  const comparison = await rpc("tools/call", { name: "compare_runs", arguments: { previous_log_id: firstSavedRun.result.structuredContent.log_id, current_log_id: secondSavedRun.result.structuredContent.log_id } });
  assert.equal(comparison.result.structuredContent.comparison.status.changed, false);
  const fixPlan = await rpc("tools/call", { name: "create_fix_plan", arguments: { log_id: firstSavedRun.result.structuredContent.log_id } });
  assert.equal(fixPlan.result.structuredContent.plan.requiresApproval, true);
  const correctionBundle = await rpc("tools/call", { name: "run_correction_workflow", arguments: { log_id: firstSavedRun.result.structuredContent.log_id } });
  assert.equal(correctionBundle.result.structuredContent.workflow.phase, "ready-for-editor");
  assert.equal(correctionBundle.result.structuredContent.workflow.regressionFixture.writesFiles, false);
  assert.ok(["current", "stale", "unavailable"].includes(correctionBundle.result.structuredContent.workflow.freshness.status));
  const correctionVerification = await rpc("tools/call", { name: "run_correction_workflow", arguments: { log_id: firstSavedRun.result.structuredContent.log_id, verify_after_changes: true } });
  assert.equal(correctionVerification.result.structuredContent.workflow.phase, "unverified");
  assert.equal(correctionVerification.result.structuredContent.workflow.verification.passed, false);
  const generated = await rpc("tools/call", { name: "generate_regression_test", arguments: { project_id: projectId, request_id: requestId, root: sourceFixture, target: "tests/generated-api.test.mjs", framework: "vitest" } });
  assert.match(generated.result.structuredContent.target, /generated-api\.test\.mjs$/);
  assert.match(await fs.readFile(path.join(sourceFixture, "tests", "generated-api.test.mjs"), "utf8"), /matches the saved API Forge contract/);
  const recordedEvent = await rpc("tools/call", { name: "record_project_event", arguments: { project_id: projectId, type: "decision", title: "Keep API response stable", summary: "The editor retained the response contract after diagnosis.", files: ["app/api/users/route.ts"], evidence: { apiToken: "timeline-secret", rationale: "Avoid breaking consumers" } } });
  assert.equal(recordedEvent.result.structuredContent.event.evidence.apiToken, "[REDACTED]");
  const timeline = await rpc("tools/call", { name: "get_project_timeline", arguments: { project_id: projectId, limit: 100 } });
  const timelineTypes = new Set(timeline.result.structuredContent.events.map((event) => event.type));
  assert.equal(timelineTypes.has("scan"), true);
  assert.equal(timelineTypes.has("run"), true);
  assert.equal(timelineTypes.has("change"), true);
  assert.equal(timelineTypes.has("decision"), true);
  assert.equal(timeline.result.structuredContent.events.some((event) => JSON.stringify(event).includes("timeline-secret")), false);
  const exported = await rpc("tools/call", { name: "export_project", arguments: { project_id: projectId, root: sourceFixture } });
  assert.match(exported.result.structuredContent.directory, /\.api-forge$/);
  assert.equal(JSON.parse(await fs.readFile(path.join(sourceFixture, ".api-forge", "project.json"), "utf8")).version, 1);
  const verification = await rpc("tools/call", { name: "verify_changes", arguments: { project_id: projectId } });
  assert.ok(Array.isArray(verification.result.structuredContent.report.issues));
  assert.ok(["current", "stale", "unavailable"].includes(verification.result.structuredContent.report.freshness.status));
  const summary = await rpc("tools/call", { name: "get_project_summary", arguments: { project_id: projectId } });
  assert.ok(summary.result.structuredContent.summary.iterations.length > 0);
  assert.equal(summary.result.structuredContent.summary.corrections.schema.some((entry) => entry.type === "schema-drift"), false);
  assert.ok(summary.result.structuredContent.summary.evidence.tracedRuns >= 1);
  console.log("API Forge self-test passed");
} finally {
  child.kill();
  api.close();
  if (observer) await observer.close();
  if (remoteServer) await new Promise((resolve) => remoteServer.close(resolve));
  await fs.rm(testData, { recursive: true, force: true });
}
