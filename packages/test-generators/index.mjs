import fs from "node:fs/promises";
import path from "node:path";

function js(value) {
  return JSON.stringify(value, null, 2);
}

function requestBody(request) {
  const content = request.body?.content;
  if (!content) return null;
  if (typeof content !== "string") return content;
  try { return JSON.parse(content); } catch { return content; }
}

export function generateVitestSource({ request, environment = {}, framework = "vitest" }) {
  if (!request) throw new Error("A saved request is required");
  const baseUrl = environment.baseUrl || "http://localhost:3000";
  const url = String(request.url).replace(/\{\{\s*baseUrl\s*\}\}/g, baseUrl);
  const statusAssertion = (request.assertions ?? []).find((entry) => entry.type === "status");
  const jsonAssertions = (request.assertions ?? []).filter((entry) => entry.type === "json_path" && entry.path && entry.equals !== undefined);
  const importLine = framework === "jest" ? "" : 'import { describe, expect, it } from "vitest";\n';
  const bodyValue = requestBody(request);
  const body = bodyValue == null ? "" : `,\n      headers: { "content-type": "application/json" },\n      body: JSON.stringify(${js(bodyValue)})`;
  return `${importLine}\ndescribe(${js(request.name)}, () => {\n  it("matches the saved API Forge contract", async () => {\n    const response = await fetch(${js(url)}, {\n      method: ${js(request.method ?? "GET")}${body}\n    });\n    expect(response.status).toBe(${statusAssertion?.equals ?? 200});\n${jsonAssertions.length ? `    const payload = await response.json();\n${jsonAssertions.map((entry) => `    expect(payload${entry.path.split(".").map((part) => `[${js(part)}]`).join("")}).toEqual(${js(entry.equals)});`).join("\n")}\n` : ""}  });\n});\n`;
}

export function generateNodeTestSource({ request, environment = {} }) {
  if (!request) throw new Error("A saved request is required");
  const baseUrl = environment.baseUrl || "http://localhost:3000";
  const url = String(request.url).replace(/\{\{\s*baseUrl\s*\}\}/g, baseUrl);
  const expected = (request.assertions ?? []).find((entry) => entry.type === "status")?.equals ?? 200;
  const bodyValue = requestBody(request);
  const body = bodyValue == null ? "" : `,\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify(${js(bodyValue)})`;
  return `import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest(${js(request.name)}, async () => {\n  const response = await fetch(${js(url)}, {\n    method: ${js(request.method ?? "GET")}${body}\n  });\n  assert.equal(response.status, ${expected});\n});\n`;
}

export function generatePytestSource({ request, environment = {} }) {
  if (!request) throw new Error("A saved request is required");
  const baseUrl = environment.baseUrl || "http://localhost:8000";
  const url = String(request.url).replace(/\{\{\s*baseUrl\s*\}\}/g, baseUrl);
  const expected = (request.assertions ?? []).find((entry) => entry.type === "status")?.equals ?? 200;
  const bodyValue = requestBody(request);
  const payload = bodyValue == null ? "" : `, json=${JSON.stringify(bodyValue)}`;
  const testName = String(request.name ?? "api_contract").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "api_contract";
  return `import requests\n\n\ndef test_${testName}():\n    response = requests.request(${JSON.stringify(String(request.method ?? "GET").toUpperCase())}, ${JSON.stringify(url)}${payload})\n    assert response.status_code == ${expected}\n`;
}

export async function writeRegressionTest({ root, target, request, environment, framework = "vitest" }) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, target);
  if (!targetPath.startsWith(`${rootPath}${path.sep}`)) throw new Error("Test target must stay inside the selected project root");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const source = framework === "node" ? generateNodeTestSource({ request, environment }) : framework === "pytest" ? generatePytestSource({ request, environment }) : generateVitestSource({ request, environment, framework });
  await fs.writeFile(targetPath, source, { flag: "wx", mode: 0o600 });
  return targetPath;
}
