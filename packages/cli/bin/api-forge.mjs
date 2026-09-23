#!/usr/bin/env node

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
import { callTool } from "../../../scripts/api-forge-server.mjs";

const execFileAsync = promisify(execFile);

function usage() {
  return `AIPI CLI\n\nUsage:\n  aipi mcp\n  aipi observe --target <url> [--port 43128] [--root .]\n  aipi open [--app https://app.aipi.dev/dashboard/]\n  aipi dev [--app http://localhost:8788/dashboard/]\n  aipi trace <url> [method] [root]\n  aipi diff <frontend-file> <backend-route> [method] [root]\n  aipi diagnose <route> [method] [root]\n  aipi fixture <route> [method] [root]\n  aipi guard [root]\n  aipi export <workspace.json> <project-id> [root]\n  aipi inspect [root]\n    aipi handoff latest [project-id]
    aipi handoff copy <handoff-id>
  `;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["-h", "--help", "help"].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  if (command === "mcp") {
    const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
    const scriptsDirectory = path.basename(currentDirectory) === "scripts" ? currentDirectory : path.resolve(currentDirectory, "../../../scripts");
    const serverPath = path.join(scriptsDirectory, "aipi-mcp-bundle.mjs");
    const child = spawn(process.execPath, [serverPath], { stdio: "inherit", env: process.env });
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
  if (command === "open" || command === "dev") {
    const dashboard = await startDashboard({ executeRequest });
    const app = option(args, "--app", process.env.AIPI_APP_URL || "https://app.aipi.dev/dashboard/");
    const url = `${app}?port=${dashboard.port}&token=${encodeURIComponent(dashboard.token)}`;
    process.stdout.write(`AIPI Local Companion active on ${dashboard.url}\nOpening ${url}\n`);
    if (command === "open") {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const openerArgs = process.platform === "win32" ? ["/c", "start", url] : [url];
      await execFileAsync(opener, openerArgs);
    }
    const close = () => dashboard.server.close(() => process.exit(0));
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
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
