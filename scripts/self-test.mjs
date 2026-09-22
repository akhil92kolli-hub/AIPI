#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
const serverPath = fileURLToPath(new URL("./api-forge-server.mjs", import.meta.url));
const testData = await fs.mkdtemp(path.join(os.tmpdir(), "api-forge-test-"));
const sourceFixture = path.join(testData, "source-fixture");
await fs.mkdir(path.join(sourceFixture, "app", "api", "users"), { recursive: true });
await fs.mkdir(path.join(sourceFixture, "frontend"), { recursive: true });
await fs.mkdir(path.join(sourceFixture, "database"), { recursive: true });
await fs.writeFile(path.join(sourceFixture, "app", "api", "users", "route.ts"), "export async function GET() { return Response.json([]); }\n");
await fs.writeFile(path.join(sourceFixture, "frontend", "users.ts"), "export const users = () => fetch('/api/users');\n");
await fs.writeFile(path.join(sourceFixture, "database", "schema.sql"), "create table users (id uuid primary key);\n");
const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, API_FORGE_DATA: testData, API_FORGE_PORT: "43129" } });
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

try {
  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "self-test", version: "1" } });
  assert.equal(initialized.result.serverInfo.name, "api-forge");
  assert.equal(initialized.result.capabilities.resources.listChanged, false);

  const listed = await rpc("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).slice(0, 2), ["api_request", "run_collection"]);
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
  assert.match(dashboardHtml, /API Forge/);
  assert.match(dashboardHtml, /id="app"/);
  assert.match(dashboardHtml, /id="modal"/);
  const dashboardStyles = await fetch("http://127.0.0.1:43129/styles.css");
  assert.equal(dashboardStyles.status, 200);
  assert.match(await dashboardStyles.text(), /\.bottom-nav/);
  const dashboardApp = await fetch("http://127.0.0.1:43129/app.js");
  const dashboardAppText = await dashboardApp.text();
  assert.match(dashboardAppText, /function renderProject/);
  assert.match(dashboardAppText, /async function sendToCodex/);

  const imported = await fetch("http://127.0.0.1:43129/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: JSON.stringify({ openapi: "3.0.3", info: { title: "Test API" }, servers: [{ url: baseUrl }], paths: { "/items": { get: { summary: "List items", responses: { "200": { description: "OK" } } } } } }) })
  });
  assert.equal(imported.status, 201);
  const importedProject = await imported.json();
  assert.equal(importedProject.requests[0].name, "List items");

  const projects = await rpc("tools/call", { name: "list_projects", arguments: {} });
  assert.equal(projects.result.structuredContent.projects.length, 2);
  const projectId = projects.result.structuredContent.projects[0].id;
  const scanned = await rpc("tools/call", { name: "scan_project", arguments: { project_id: projectId, roots: [{ kind: "workspace", path: sourceFixture }] } });
  assert.equal(scanned.result.structuredContent.scan.endpoints.length, 1);
  assert.equal(scanned.result.structuredContent.scan.frontendCalls.length, 1);
  assert.equal(scanned.result.structuredContent.scan.integrations[0].status, "healthy");
  assert.equal(scanned.result.structuredContent.scan.schemas[0].name, "users");
  const endpoints = await rpc("tools/call", { name: "list_endpoints", arguments: { project_id: projectId } });
  assert.equal(endpoints.result.structuredContent.endpoints[0].path, "/api/users");
  const endpointId = endpoints.result.structuredContent.endpoints[0].id;
  const endpointEvidence = await rpc("tools/call", { name: "get_endpoint_context", arguments: { project_id: projectId, endpoint_id: endpointId } });
  assert.equal(endpointEvidence.result.structuredContent.context.consumers.length, 1);
  assert.equal(endpointEvidence.result.structuredContent.context.evidence.detectionMethod, "Next.js adapter");
  const issues = await rpc("tools/call", { name: "list_integration_issues", arguments: { project_id: projectId } });
  assert.ok(issues.result.structuredContent.issues.some((entry) => entry.type === "untested"));

  const created = await rpc("tools/call", { name: "create_request", arguments: { project_id: projectId, name: "Read generated item", method: "GET", url: `${baseUrl}/items/item-42`, assertions: [{ type: "status", equals: 200 }, { type: "json_path", path: "id", equals: "item-42" }] } });
  const requestId = created.result.structuredContent.request.id;
  const firstSavedRun = await rpc("tools/call", { name: "run_request", arguments: { project_id: projectId, request_id: requestId } });
  assert.equal(firstSavedRun.result.structuredContent.result.passed, true);
  const secondSavedRun = await rpc("tools/call", { name: "run_request", arguments: { project_id: projectId, request_id: requestId } });
  const evidence = await rpc("tools/call", { name: "get_run_evidence", arguments: { log_id: firstSavedRun.result.structuredContent.log_id } });
  assert.equal(evidence.result.structuredContent.evidence.result.status, 200);
  const comparison = await rpc("tools/call", { name: "compare_runs", arguments: { previous_log_id: firstSavedRun.result.structuredContent.log_id, current_log_id: secondSavedRun.result.structuredContent.log_id } });
  assert.equal(comparison.result.structuredContent.comparison.status.changed, false);
  const fixPlan = await rpc("tools/call", { name: "create_fix_plan", arguments: { log_id: firstSavedRun.result.structuredContent.log_id } });
  assert.equal(fixPlan.result.structuredContent.plan.requiresApproval, true);
  const generated = await rpc("tools/call", { name: "generate_regression_test", arguments: { project_id: projectId, request_id: requestId, root: sourceFixture, target: "tests/generated-api.test.mjs", framework: "vitest" } });
  assert.match(generated.result.structuredContent.target, /generated-api\.test\.mjs$/);
  assert.match(await fs.readFile(path.join(sourceFixture, "tests", "generated-api.test.mjs"), "utf8"), /matches the saved API Forge contract/);
  const exported = await rpc("tools/call", { name: "export_project", arguments: { project_id: projectId, root: sourceFixture } });
  assert.match(exported.result.structuredContent.directory, /\.api-forge$/);
  assert.equal(JSON.parse(await fs.readFile(path.join(sourceFixture, ".api-forge", "project.json"), "utf8")).version, 1);
  const verification = await rpc("tools/call", { name: "verify_changes", arguments: { project_id: projectId } });
  assert.ok(Array.isArray(verification.result.structuredContent.report.issues));
  const summary = await rpc("tools/call", { name: "get_project_summary", arguments: { project_id: projectId } });
  assert.ok(summary.result.structuredContent.summary.iterations.length > 0);
  console.log("API Forge self-test passed");
} finally {
  child.kill();
  api.close();
  await fs.rm(testData, { recursive: true, force: true });
}
