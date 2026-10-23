import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

// Intentionally run the release artifacts outside the checkout. Repository
// assets and node_modules must not hide omissions from the npm tarball.
const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-package-"));
const projectRoot = path.join(temp, "sample-project");
const descriptor = path.join(temp, "daemon.json");
const children = [];
const token = "package-smoke-only";
const env = { ...process.env, AIPI_DATA: path.join(temp, "data"), AIPI_CONNECTION_FILE: descriptor,
  AIPI_PORT: "0", AIPI_MAX_PORT: "0", AIPI_TOKEN: token };
let upstream;

function start(args, options = {}) {
  const child = spawn(process.execPath, args, { cwd: projectRoot, env, stdio: ["pipe", "pipe", "pipe"], ...options });
  children.push(child);
  child.stderr.setEncoding("utf8");
  child.aipiStderr = "";
  child.stderr.on("data", (chunk) => { child.aipiStderr = `${child.aipiStderr}${chunk}`.slice(-8_000); });
  return child;
}

async function eventually(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

function rpcClient(child) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { for (const item of pending.values()) item.reject(new Error("Non-JSON output on MCP stdout")); continue; }
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    }
  });
  child.once("exit", () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`MCP exited before replying${child.aipiStderr ? `: ${child.aipiStderr.trim()}` : ""}`)); }
    pending.clear();
  });
  return {
    notify(method) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`); },
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

try {
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, "package.json"), '{"name":"package-smoke-project"}\n');
  const npm = process.env.npm_execpath;
  assert.ok(npm, "Run through npm run test:package so npm is available cross-platform");
  const { stdout } = await exec(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: repo, timeout: 60000 });
  const [packed] = JSON.parse(stdout);
  const files = new Set(packed.files.map((entry) => entry.path));
  for (const required of ["ui/index.html", "ui/app.js", "ui/app-bundle.js", "ui/change-assessment-view.js", "ui/workspace-app.js", "ui/workspace-app.css", "ui/workspace-explorer.js", "ui/styles.css", "ui/aipi-logo.svg",
    "scripts/aipi-cli-bundle.mjs", "scripts/aipi-mcp-bundle.mjs", "scripts/aipi-observer-bundle.mjs", "scripts/aipi-package-preflight.mjs",
    "packages/core/verification-package.mjs", "packages/core/change-diff.mjs", "scripts/llhttp/llhttp.wasm"]) {
    assert.ok(files.has(required), `Release package missing ${required}`);
  }
  await exec("tar", ["-xzf", path.join(temp, packed.filename), "-C", temp]);
  const installed = path.join(temp, "package");
  const metadata = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(metadata.bin["aipi-companion"], "scripts/aipi-cli-bundle.mjs", "Package-name executable must resolve to the AIPI CLI");
  const dashboardHtml = await fs.readFile(path.join(installed, "ui/index.html"), "utf8");
  assert.match(dashboardHtml, /<script src="\/app-bundle\.js"><\/script>/, "Dashboard must load the self-contained browser bundle");
  const cli = path.join(installed, "scripts/aipi-cli-bundle.mjs");
  const daemon = start([cli, "daemon"]);
  let daemonErrors = "";
  daemon.stderr.on("data", (chunk) => { daemonErrors += chunk; });
  const connection = await eventually(async () => {
    assert.equal(daemon.exitCode, null, `Packaged daemon exited: ${daemonErrors}`);
    try { return JSON.parse(await fs.readFile(descriptor, "utf8")); }
    catch (error) { if (["ENOENT"].includes(error.code) || error instanceof SyntaxError) return null; throw error; }
  }, "packaged daemon startup");
  assert.equal(connection.pid, daemon.pid, "Must test our isolated daemon, not a running checkout");
  const headers = { authorization: `Bearer ${token}` };
  const base = connection.url;
  const runCli = (args) => exec(process.execPath, [cli, ...args], { cwd: projectRoot, env, timeout: 30000 });
  const setup = await runCli(["init", "--root", projectRoot, "--no-open"]);
  const launchUrl = setup.stdout.match(/Opening (http:\/\/[^\s]+)/)?.[1];
  assert.ok(launchUrl, "init must return a usable project launch URL");
  const state = await (await fetch(`${base}/api/state`, { headers })).json();
  const project = state.projects.find((entry) => entry.sourceContext?.roots?.some((source) => source.path === projectRoot));
  assert.ok(project, "init must register this project");
  await runCli(["init", "--root", projectRoot, "--no-open"]);
  const repeated = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.equal(repeated.projects.length, state.projects.length, "Repeated init must not duplicate projects");
  assert.match(await fs.readFile(path.join(projectRoot, ".codex/config.toml"), "utf8"), /mcp_servers\.aipi/);

  const launch = await fetch(launchUrl, { redirect: "manual" });
  assert.equal(launch.status, 302);
  assert.equal(launch.headers.get("location"), `/projects/${project.id}`);
  const cookie = launch.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "Launch must establish browser authentication");
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200);
  for (const route of ["/", "/projects", `/projects/${project.id}`, `/projects/${project.id}/apis`,
    `/projects/${project.id}/map`, `/projects/${project.id}/logs`]) {
    const response = await fetch(`${base}${route}`, { headers: { cookie } });
    assert.equal(response.status, 200, `Packaged dashboard failed at ${route}`);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /id="app"/);
    assert.match(html, /<script src="\/app-bundle\.js"><\/script>/);
  }
  for (const [asset, type] of [["app.js", "javascript"], ["app-bundle.js", "javascript"], ["change-assessment-view.js", "javascript"], ["styles.css", "css"], ["aipi-logo.svg", "svg"]]) {
    const response = await fetch(`${base}/${asset}`);
    assert.equal(response.status, 200, `Packaged asset missing: ${asset}`);
    assert.ok(response.headers.get("content-type").includes(type));
    assert.equal(await response.text(), await fs.readFile(path.join(installed, "ui", asset), "utf8"));
  }

  // Use the shipped MCP entry through the CLI, not a source-module import.
  const mcp = start([cli, "mcp", "--root", projectRoot]);
  const rpc = rpcClient(mcp);
  const initialized = await rpc.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "package-smoke", version: "1.0.0" } });
  assert.ok(initialized.serverInfo);
  rpc.notify("notifications/initialized");
  const resources = await rpc.call("resources/list");
  const resource = resources.resources.find((entry) => entry.uri === "ui://api-forge/dashboard-v1.html");
  assert.ok(resource);
  const dashboard = await rpc.call("resources/read", { uri: resource.uri });
  assert.match(dashboard.contents[0].text, /id="app"/);
  assert.match(dashboard.contents[0].text, /<style>/);
  assert.match(dashboard.contents[0].text, /__API_FORGE_ORIGIN__/);
  assert.doesNotMatch(dashboard.contents[0].text, /from ["']\.\/(?:workspace-app|change-assessment-view|contract-chain|payload-lenses|workspace-explorer)\.js["']/);
  const listed = await rpc.call("tools/list");
  assert.ok(listed.tools.some((tool) => tool.name === "trace_route"));
  assert.ok(listed.tools.some((tool) => tool.name === "assess_workspace_change"));

  upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  const hook = pathToFileURL(path.join(installed, "scripts/aipi-observer-bundle.mjs")).href;
  await exec(process.execPath, ["--import", hook, "--input-type=module", "-e", `
    import http from 'node:http';
    await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:${upstream.address().port}/health', {headers: {authorization: 'Bearer test-secret'}},
        response => { response.resume(); response.on('end', resolve); }).on('error', reject);
    });
  `], { cwd: projectRoot, env: { ...env, AIPI_OBSERVER_ROOT: projectRoot }, timeout: 15000 });
  const records = await fs.readFile(path.join(projectRoot, ".api-forge/tmp/traffic.ndjson"), "utf8");
  const record = JSON.parse(records.trim().split("\n")[0]);
  assert.equal(record.response.status, 200);
  assert.deepEqual(record.response.body, { ok: true });
  assert.equal(record.request.headers.authorization, "[REDACTED]");
  console.log("Package smoke passed: isolated tarball, repeat project setup, authenticated launch, deep routes and assets, MCP dashboard resource/tools, observer capture and redaction.");
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
