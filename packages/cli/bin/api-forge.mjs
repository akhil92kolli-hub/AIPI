#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readRepositoryProject, writeRepositoryProject } from "../../collection-schema/index.mjs";
import { diffFrontendBackend, generateObservedVitest, guardNextProject, traceNextRoute } from "../../contract-engine/index.mjs";
import { diagnoseTraffic, readTraffic, startTrafficProxy } from "../../local-observer/index.mjs";
import { executeRequest } from "../../../scripts/api-forge-server.mjs";
import { startDashboard } from "../../../scripts/dashboard-server.mjs";
import { callTool, setAipiRuntime } from "../../../scripts/api-forge-server.mjs";

const execFileAsync = promisify(execFile);

function usage() {
  return `AIPI CLI\n\nUsage:\n  aipi init [--root .]\n  aipi mcp\n  aipi daemon [--port 49152]\n  aipi status\n  aipi doctor [--root .]\n  aipi run [--root .] -- <command> [args...]\n  aipi observe --target <url> [--port 43128] [--root .]\n  aipi open [--app https://aipi.website/dashboard/]\n  aipi pair --access-token <token> [--relay https://relay.example]\n  aipi dev [--app http://localhost:8788/dashboard/]\n  aipi trace <url> [method] [root]\n  aipi diff <frontend-file> <backend-route> [method] [root]\n  aipi diagnose <route> [method] [root]\n  aipi fixture <route> [method] [root]\n  aipi guard [root]\n  aipi export <workspace.json> <project-id> [root]\n  aipi inspect [root]\n    aipi handoff latest [project-id]
    aipi handoff copy <handoff-id>
  `;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const DEFAULT_PORT = 49152;
const MAX_PORT = 49160;
const DAEMON_PROTOCOL_VERSION = 2;
const cliPath = fileURLToPath(import.meta.url);
const connectionFile = process.env.AIPI_CONNECTION_FILE || path.join(os.homedir(), ".api-forge", "daemon.json");
const daemonLock = `${connectionFile}.lock`;

async function exists(target) {
  try { await fs.access(target); return true; }
  catch { return false; }
}

async function findProjectRoot(start = ".") {
  let current = path.resolve(start);
  const home = path.resolve(os.homedir());
  while (true) {
    if (current !== home && (await exists(path.join(current, ".git")) || await exists(path.join(current, "package.json")))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No project root found from ${path.resolve(start)}. Run AIPI from your project directory or pass --root <project-path>.`);
    current = parent;
  }
}

async function detectSourceRoots(root) {
  const candidates = [["frontend", "apps/web"], ["frontend", "web"], ["frontend", "frontend"], ["backend", "apps/api"], ["backend", "api"], ["backend", "backend"], ["database", "supabase"], ["database", "prisma"], ["tests", "tests"]];
  const roots = [];
  for (const [kind, relative] of candidates) {
    try {
      if ((await fs.stat(path.join(root, relative))).isDirectory()) roots.push({ kind, path: relative });
    } catch {}
  }
  return roots.length ? roots : [{ kind: "workspace", path: "." }];
}

async function configureMcpFile(filePath, root, vscode = false) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let config = {};
  try { config = JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const key = vscode ? "servers" : "mcpServers";
  config[key] ??= {};
  config[key].aipi = { ...(config[key].aipi ?? {}), command: "npx", args: ["-y", "@vmise/aipi-companion", "mcp", "--root", root], ...(vscode ? { type: "stdio" } : {}) };
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

async function configureCodex(root) {
  const file = path.join(root, ".codex", "config.toml");
  let content = "";
  try { content = await fs.readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Preserve existing custom server settings rather than rewriting arbitrary TOML.
  if (/^\s*\[mcp_servers\.(?:aipi|"aipi"|'aipi')(?:\.|\])/m.test(content)) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${content}\n[mcp_servers.aipi]\ncommand = "npx"\nargs = ${JSON.stringify(["-y", "@vmise/aipi-companion", "mcp", "--root", root])}\nstartup_timeout_sec = 60\n`);
}

async function connectProject(daemon, root) {
  const headers = { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" };
  const state = await fetchJson(`${daemon.url}/api/state`, { headers, timeout: 10000 });
  if (!state) throw new Error("Could not load companion state. Run the command again to reconnect.");
  let project = state.projects.find((entry) => entry.sourceContext?.roots?.some((source) => path.resolve(source.path) === root));
  if (!project) {
    project = await fetchJson(`${daemon.url}/api/projects`, { method: "POST", headers, timeout: 120000, body: JSON.stringify({ name: path.basename(root), workspacePath: root }) });
    if (!project?.id) throw new Error("Project registration failed. Companion is running; rerun setup to retry.");
  }
  const selected = await fetchJson(`${daemon.url}/api/tools/call`, { method: "POST", headers, timeout: 10000, body: JSON.stringify({ name: "select_project", arguments: { project_id: project.id } }) });
  if (!selected || selected.isError) throw new Error("Could not select the project in AIPI.");
  return project;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 450);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

async function removeConnectionDescriptor(pid) {
  try {
    const saved = JSON.parse(await fs.readFile(connectionFile, "utf8"));
    if (pid !== undefined && Number(saved?.pid) !== Number(pid)) return;
    await fs.unlink(connectionFile);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function writeConnectionDescriptor(value) {
  await fs.mkdir(path.dirname(connectionFile), { recursive: true, mode: 0o700 });
  const temporary = `${connectionFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, connectionFile);
  await fs.chmod(connectionFile, 0o600);
}

async function probeDaemon({ cleanupStale = true } = {}) {
  let descriptorFound = false;
  try {
    const saved = JSON.parse(await fs.readFile(connectionFile, "utf8"));
    descriptorFound = true;
    if (saved?.url && saved?.token) {
      const connection = await fetchJson(`${saved.url}/api/connection`, { headers: { authorization: `Bearer ${saved.token}` } });
      if (connection?.connected && connection.protocolVersion === DAEMON_PROTOCOL_VERSION) return { ...connection, token: saved.token, url: saved.url };
    }
  } catch {}
  if (descriptorFound && cleanupStale) await removeConnectionDescriptor().catch(() => {});
  const ports = new Set([Number(process.env.AIPI_PORT || process.env.API_FORGE_PORT || DEFAULT_PORT)]);
  for (let port = DEFAULT_PORT; port <= MAX_PORT; port += 1) ports.add(port);
  for (const port of ports) {
    const token = process.env.AIPI_TOKEN;
    if (!token) continue;
    const connection = await fetchJson(`http://127.0.0.1:${port}/api/connection`, { headers: { authorization: `Bearer ${token}` } });
    if (connection?.connected && connection.protocolVersion === DAEMON_PROTOCOL_VERSION) return { ...connection, token, url: `http://127.0.0.1:${connection.port || port}` };
  }
  return null;
}

async function acquireDaemonLock() {
  await fs.mkdir(path.dirname(connectionFile), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(daemonLock, { mode: 0o700 });
    await fs.writeFile(path.join(daemonLock, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const stats = await fs.stat(daemonLock);
      if (Date.now() - stats.mtimeMs > 30_000) {
        await fs.rm(daemonLock, { recursive: true, force: true });
        return acquireDaemonLock();
      }
    } catch {}
    return false;
  }
}

async function waitForDaemon(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connection = await probeDaemon({ cleanupStale: false });
    if (connection) return connection;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

async function ensureDaemon({ quiet = false } = {}) {
  const running = await probeDaemon();
  if (running) return running;
  const ownsLock = await acquireDaemonLock();
  if (!ownsLock) {
    const connection = await waitForDaemon();
    if (connection) return connection;
    if (!quiet) process.stderr.write("Another AIPI client started the daemon, but it did not become ready. Run `aipi doctor`.\n");
    return null;
  }
  try {
    const afterLock = await probeDaemon();
    if (afterLock) return afterLock;
    const child = spawn(process.execPath, [cliPath, "daemon"], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AIPI_PORT: String(process.env.AIPI_PORT || DEFAULT_PORT), AIPI_MAX_PORT: String(process.env.AIPI_MAX_PORT || MAX_PORT) }
    });
    child.unref();
    const connection = await waitForDaemon();
    if (connection) return connection;
  } finally {
    await fs.rm(daemonLock, { recursive: true, force: true }).catch(() => {});
  }
  if (!quiet) process.stderr.write("AIPI daemon did not become ready on loopback. Try `aipi dev` for details.\n");
  return null;
}

function appLaunchUrl(app, daemon, projectName) {
  const base = new URL(app);
  if (!["https:", "http:"].includes(base.protocol)) throw new Error("Dashboard URL must use HTTP or HTTPS");
  const params = new URLSearchParams({ port: String(daemon.port), token: daemon.token });
  if (projectName) params.set("project", projectName);
  base.hash = params.toString();
  return base.href;
}

function pairedAppLaunchUrl(app, pairing, projectName) {
  const base = new URL(app);
  if (base.protocol !== "https:") throw new Error("Paired dashboard URL must use HTTPS");
  const params = new URLSearchParams({ pair: pairing.sessionId, relay: pairing.websocketUrl, secret: pairing.dashboardSecret });
  if (projectName) params.set("project", projectName);
  base.hash = params.toString();
  return base.href;
}

async function createCloudPairing({ relay, accessToken, daemon }) {
  if (!accessToken) throw new Error("Cloud pairing requires an AIPI access token. Pass --access-token or set AIPI_ACCESS_TOKEN.");
  const response = await fetch(new URL("/pair/sessions", relay), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  });
  const pairing = await response.json();
  if (!response.ok) throw new Error(pairing.error || `Pairing service returned HTTP ${response.status}`);
  const connected = await fetch(`${daemon.url}/api/pairing/connect`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: pairing.sessionId, websocketUrl: pairing.websocketUrl, secret: pairing.companionSecret, expiresAt: pairing.expiresAt }),
  });
  if (!connected.ok) throw new Error(`Local companion rejected cloud pairing (${connected.status})`);
  return pairing;
}

async function main() {
  let [command = "init", ...args] = process.argv.slice(2);
  if (["-h", "--help", "help"].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  if (command === "init") {
    const root = await findProjectRoot(option(args, "--root", "."));
    const roots = await detectSourceRoots(root);
    process.chdir(root);
    let previous = {};
    try { previous = JSON.parse(await fs.readFile(path.join(root, ".aipirc.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const config = { version: 1, name: path.basename(root), root, roots, ...previous };
    await fs.writeFile(path.join(root, ".aipirc.json"), `${JSON.stringify(config, null, 2)}\n`);
    const configured = [];
    await configureMcpFile(path.join(root, ".cursor", "mcp.json"), root); configured.push("Cursor");
    await configureMcpFile(path.join(root, ".vscode", "mcp.json"), root, true); configured.push("VS Code");
    await configureCodex(root); configured.push("Codex");
    process.stdout.write(`Configured AIPI for ${configured.join(", ")}.\nProject root: ${root}\nSource roots: ${roots.map((entry) => `${entry.kind}:${entry.path}`).join(", ")}\nRestart your IDE window to activate MCP.\n`);
    if (args.includes("--config-only")) return;
    command = "open";
  }
  if (command === "daemon") {
    const existing = await probeDaemon();
    if (existing) {
      process.stdout.write(`AIPI daemon already active on ${existing.url}\n`);
      return;
    }
    const port = option(args, "--port");
    if (port) process.env.AIPI_PORT = port;
    const dashboard = await startDashboard({ executeRequest, callTool });
    setAipiRuntime(dashboard);
    await writeConnectionDescriptor({ version: 1, pid: process.pid, url: dashboard.url, port: dashboard.port, token: dashboard.token, startedAt: new Date().toISOString() });
    process.stdout.write(`AIPI daemon listening on ${dashboard.url}\n`);
    const close = () => dashboard.server.close(async () => { await removeConnectionDescriptor(process.pid).catch(() => {}); process.exit(0); });
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  if (command === "status") {
    const daemon = await probeDaemon();
    process.stdout.write(`${JSON.stringify(daemon ? { status: "online", url: daemon.url, port: daemon.port, companion: daemon.companion } : { status: "offline", recovery: "Run `aipi open` or restart the IDE MCP client." }, null, 2)}\n`);
    if (!daemon) process.exitCode = 1;
    return;
  }
  if (command === "doctor") {
    const root = await findProjectRoot(option(args, "--root", "."));
    const daemon = await probeDaemon();
    const configFiles = [path.join(root, ".aipirc.json"), path.join(root, ".cursor", "mcp.json"), path.join(root, ".vscode", "mcp.json"), path.join(root, ".codex", "config.toml")];
    const checks = [];
    for (const file of configFiles) checks.push({ check: path.relative(root, file), status: await exists(file) ? "ok" : "missing" });
    checks.push({ check: "local-companion", status: daemon ? "ok" : "offline", detail: daemon?.url ?? "Run `aipi open` to repair the connection." });
    const healthy = checks.every((entry) => entry.status === "ok");
    process.stdout.write(`${JSON.stringify({ healthy, projectRoot: root, checks }, null, 2)}\n`);
    if (!healthy) process.exitCode = 1;
    return;
  }
  if (command === "run") {
    const separator = args.indexOf("--");
    if (separator < 0 || !args[separator + 1]) throw new Error("run requires `-- <command> [args...]`");
    const root = await findProjectRoot(option(args.slice(0, separator), "--root", "."));
    process.chdir(root);
    const daemon = await ensureDaemon();
    if (!daemon) throw new Error("AIPI daemon is not available");
    const project = await connectProject(daemon, root);
    const child = spawn(args[separator + 1], args.slice(separator + 2), {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        AIPI_PROJECT_ID: project.id,
        OTEL_EXPORTER_OTLP_ENDPOINT: `${daemon.url}/api/otel`,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer%20${daemon.token}`,
      },
    });
    const signal = (name) => { if (!child.killed) child.kill(name); };
    process.once("SIGINT", () => signal("SIGINT"));
    process.once("SIGTERM", () => signal("SIGTERM"));
    process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 0)); });
    return;
  }
  if (command === "mcp") {
    process.chdir(await findProjectRoot(option(args, "--root", ".")));
    const daemon = await ensureDaemon({ quiet: true });
    if (daemon) await connectProject(daemon, process.cwd());
    const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
    const scriptsDirectory = path.basename(currentDirectory) === "scripts" ? currentDirectory : path.resolve(currentDirectory, "../../../scripts");
    const serverPath = path.join(scriptsDirectory, "aipi-mcp-bundle.mjs");
    const child = spawn(process.execPath, [serverPath], {
      stdio: "inherit",
      env: daemon ? { ...process.env, AIPI_DAEMON_URL: daemon.url, AIPI_DAEMON_TOKEN: daemon.token, AIPI_PORT: String(daemon.port) } : process.env
    });
    const signal = (name) => { if (!child.killed) child.kill(name); };
    process.once("SIGINT", () => signal("SIGINT"));
    process.once("SIGTERM", () => signal("SIGTERM"));
    const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 0)); });
    process.exitCode = exitCode;
    return;
  }
  if (command === "inspect") {
    const result = await readRepositoryProject(path.resolve(args[0] ?? "."));
    process.stdout.write(`${JSON.stringify({ project: result.project, requests: result.requests.map((entry) => ({ id: entry.id, name: entry.name, method: entry.request.method, url: entry.request.url })) }, null, 2)}\n`);
    return;
  }
  if (command === "handoff") {
    const action = args[0] ?? "latest";
    const projectId = args[1];
    if (action === "latest") {
      const state = await (await import("../../../scripts/workspace-store.mjs")).loadState();
      const id = projectId ?? state.activeProjectId;
      const result = await callTool("get_latest_handoff", { project_id: id });
      process.stdout.write(`${result.structuredContent?.handoff?.markdown ?? result.content?.[0]?.text ?? "No open AIPI handoff found."}\n`);
      return;
    }
    if (action === "copy") {
      const handoffId = args[1];
      if (!handoffId) throw new Error("handoff copy requires <handoff-id>");
      const state = await (await import("../../../scripts/workspace-store.mjs")).loadState();
      const handoff = state.handoffs?.find((entry) => entry.id === handoffId);
      if (!handoff) throw new Error(`Handoff not found: ${handoffId}`);
      const clipboard = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip";
      try {
        const child = spawn(clipboard, [], { stdio: ["pipe", "ignore", "ignore"] });
        child.stdin.end(handoff.markdown);
        await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Clipboard command exited with ${code}`))); });
        process.stdout.write(`Copied ${handoffId} to the clipboard.\n`);
      } catch (error) {
        process.stdout.write(`${handoff.markdown}\n`);
        process.stderr.write(`Clipboard unavailable: ${error.message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    throw new Error(`Unknown handoff action: ${action}`);
  }
  if (command === "observe") {
    const target = option(args, "--target");
    const root = path.resolve(option(args, "--root", "."));
    const port = Number(option(args, "--port", "43128"));
    const proxy = await startTrafficProxy({ target, root, port });
    process.stdout.write(`${JSON.stringify({ proxy: proxy.url, target: proxy.target, cache: proxy.cache }, null, 2)}\n`);
    const close = async () => { await proxy.close(); process.exit(0); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  if (command === "pair") {
    const root = await findProjectRoot(option(args, "--root", "."));
    process.chdir(root);
    const daemon = await ensureDaemon();
    if (!daemon) throw new Error("AIPI daemon is not available");
    const project = await connectProject(daemon, root);
    const relay = option(args, "--relay", process.env.AIPI_RELAY_URL || "https://aipi-remote-mcp.workers.dev");
    const accessToken = option(args, "--access-token", process.env.AIPI_ACCESS_TOKEN);
    const pairing = await createCloudPairing({ relay, accessToken, daemon });
    const app = option(args, "--app", process.env.AIPI_APP_URL || "https://aipi.website/dashboard/");
    const url = pairedAppLaunchUrl(app, pairing, project.id);
    process.stdout.write(`AIPI outbound pairing active until ${pairing.expiresAt}.\nOpening ${url.replace(pairing.dashboardSecret, "[REDACTED]")}\n`);
    if (!args.includes("--no-open")) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const openerArgs = process.platform === "win32" ? ["/c", "start", "", url.replace(/&/g, "^&")] : [url];
      try { await execFileAsync(opener, openerArgs); }
      catch { process.stderr.write("Browser could not open automatically. Rerun the pairing command to create a fresh session.\n"); }
    }
    return;
  }
  if (command === "open" || command === "dev") {
    const root = await findProjectRoot(option(args, "--root", "."));
    process.chdir(root);
    process.stdout.write("Connecting your project to AIPI…\n");
    const daemon = await ensureDaemon();
    if (!daemon) throw new Error("AIPI daemon is not available");
    const project = await connectProject(daemon, root);
    const app = option(args, "--app", process.env.AIPI_APP_URL || "https://aipi.website/dashboard/");
    const url = appLaunchUrl(app, daemon, project.id);
    process.stdout.write(`AIPI Local Companion active on ${daemon.url}\nOpening ${url}\n`);
    if (command === "open" && !args.includes("--no-open")) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const openerArgs = process.platform === "win32" ? ["/c", "start", "", url.replace(/&/g, "^&")] : [url];
      try { await execFileAsync(opener, openerArgs); }
      catch { process.stderr.write("Browser could not open automatically. Open the dashboard link above on this computer.\n"); }
    }
    return;
  }
  if (command === "trace") {
    const [url, method = "GET", root = "."] = args;
    if (!url) throw new Error("trace requires <url>");
    process.stdout.write(`${JSON.stringify(await traceNextRoute({ root: path.resolve(root), url, method }), null, 2)}\n`);
    return;
  }
  if (command === "diff") {
    const [frontendFile, backendRoute, method = "POST", root = "."] = args;
    if (!frontendFile || !backendRoute) throw new Error("diff requires <frontend-file> <backend-route>");
    const report = await diffFrontendBackend({ root: path.resolve(root), frontendFile, backendRoute, method });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.mismatches.length) process.exitCode = 1;
    return;
  }
  if (command === "diagnose") {
    const [route, method = "GET", root = "."] = args;
    if (!route) throw new Error("diagnose requires <route>");
    const [record] = await readTraffic(path.resolve(root), { route, method, limit: 1 });
    process.stdout.write(`${JSON.stringify({ record: record ?? null, diagnosis: diagnoseTraffic(record) }, null, 2)}\n`);
    if (!record || Number(record.response?.status) >= 400) process.exitCode = 1;
    return;
  }
  if (command === "fixture") {
    const [route, method = "GET", root = "."] = args;
    if (!route) throw new Error("fixture requires <route>");
    const generated = await generateObservedVitest({ root: path.resolve(root), endpoint: route, method });
    process.stdout.write(generated.content);
    return;
  }
  if (command === "guard") {
    const report = await guardNextProject({ root: path.resolve(args[0] ?? ".") });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (process.env.GITHUB_ACTIONS === "true") {
      for (const mismatch of report.mismatches) process.stdout.write(`::error file=${mismatch.frontendFile},title=AIPI contract mismatch::${mismatch.method} ${mismatch.route}: ${mismatch.field} is ${mismatch.frontend} in the frontend but ${mismatch.backend} in ${mismatch.backendFile}\n`);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(summary, `## AIPI contract guard\n\n${report.passed ? "✅ Contracts aligned" : `❌ ${report.mismatches.length} mismatch(es) found`}\n\n${report.mismatches.map((entry) => `- \`${entry.method} ${entry.route}\`: \`${entry.field}\` is **${entry.frontend}** in \`${entry.frontendFile}\`, backend expects **${entry.backend}** in \`${entry.backendFile}\`.`).join("\n")}\n`);
      }
    }
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (command === "export") {
    const [workspaceFile, projectId, root = "."] = args;
    if (!workspaceFile || !projectId) throw new Error("export requires <workspace.json> and <project-id>");
    const { readFile } = await import("node:fs/promises");
    const state = JSON.parse(await readFile(path.resolve(workspaceFile), "utf8"));
    const project = state.projects?.find((entry) => entry.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const result = await writeRepositoryProject(path.resolve(root), project);
    process.stdout.write(`Exported ${result.files.length} requests to ${result.directory}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
