import fs from "node:fs/promises";
import path from "node:path";

function js(value) {
  return JSON.stringify(value, null, 2);
}

export function generateVitestSource({ request, environment = {}, framework = "vitest" }) {
  if (!request) throw new Error("A saved request is required");
  const baseUrl = environment.baseUrl || "http://localhost:3000";
  const url = String(request.url).replace(/\{\{\s*baseUrl\s*\}\}/g, baseUrl);
  const statusAssertion = (request.assertions ?? []).find((entry) => entry.type === "status");
  const jsonAssertions = (request.assertions ?? []).filter((entry) => entry.type === "json_path" && entry.path && entry.equals !== undefined);
  const importLine = framework === "jest" ? "" : 'import { describe, expect, it } from "vitest";\n';
  const body = request.body?.content ? `,\n      body: ${js(request.body.content)}` : "";
  return `${importLine}\ndescribe(${js(request.name)}, () => {\n  it("matches the saved API Forge contract", async () => {\n    const response = await fetch(${js(url)}, {\n      method: ${js(request.method ?? "GET")}${body}\n    });\n    expect(response.status).toBe(${statusAssertion?.equals ?? 200});\n${jsonAssertions.length ? `    const payload = await response.json();\n${jsonAssertions.map((entry) => `    expect(payload${entry.path.split(".").map((part) => `[${js(part)}]`).join("")}).toEqual(${js(entry.equals)});`).join("\n")}\n` : ""}  });\n});\n`;
}

export async function writeRegressionTest({ root, target, request, environment, framework = "vitest" }) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, target);
  if (!targetPath.startsWith(`${rootPath}${path.sep}`)) throw new Error("Test target must stay inside the selected project root");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, generateVitestSource({ request, environment, framework }), { flag: "wx", mode: 0o600 });
  return targetPath;
}
