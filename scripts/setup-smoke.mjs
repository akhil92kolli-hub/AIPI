import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = path.resolve("scripts/aipi-cli-bundle.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-setup-"));
await fs.writeFile(path.join(root, "package.json"), '{"name":"setup-example"}');
await fs.mkdir(path.join(root, ".vscode"));
await fs.writeFile(path.join(root, ".vscode/mcp.json"), JSON.stringify({ servers: { other: { command: "keep-me" } } }));
const projects = [];
let creations = 0;
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/connection") return res.end(JSON.stringify({ connected: true, token: "test-only", port: server.address().port }));
  assert.equal(req.headers.authorization, "Bearer test-only");
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url === "/api/state") return res.end(JSON.stringify({ projects }));
  if (req.url === "/api/projects") {
    const payload = JSON.parse(body);
    assert.equal(payload.workspacePath, root);
    creations++;
    const project = { id: "test-project", sourceContext: { roots: [{ path: root }] } };
    projects.push(project);
    return res.end(JSON.stringify(project));
  }
  assert.equal(JSON.parse(body).arguments.project_id, "test-project");
  res.end('{}');
});
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const env = { ...process.env, AIPI_PORT: String(server.address().port), AIPI_TOKEN: "test-only", AIPI_APP_URL: "https://aipi.website/dashboard/" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { stdout } = await exec(process.execPath, [cli, "init", "--root", root, "--no-open"], { env });
    assert.match(stdout, /https:\/\/aipi.website\/dashboard\/#port=.*project=test-project/);
  }
  assert.equal(creations, 1, "repeat setup must reuse project");
  const vscode = JSON.parse(await fs.readFile(path.join(root, ".vscode/mcp.json"), "utf8"));
  assert.equal(vscode.servers.other.command, "keep-me");
  assert.equal(vscode.servers.aipi.type, "stdio");
  assert.equal(vscode.servers.aipi.command, "npx");
  assert.equal(vscode.servers.aipi.args.at(-1), root);
  const codex = await fs.readFile(path.join(root, ".codex/config.toml"), "utf8");
  assert.equal(codex.match(/\[mcp_servers.aipi\]/g).length, 1);
  console.log("Setup smoke passed: registration, project selection, authenticated launch, repeat setup, config preservation.");
} finally {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
}
