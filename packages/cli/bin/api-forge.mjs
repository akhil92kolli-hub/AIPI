#!/usr/bin/env node

import path from "node:path";
import { readRepositoryProject, writeRepositoryProject } from "../../collection-schema/index.mjs";

function usage() {
  return `API Forge CLI\n\nUsage:\n  api-forge export <workspace.json> <project-id> [root]\n  api-forge inspect [root]\n`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["-h", "--help", "help"].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  if (command === "inspect") {
    const result = await readRepositoryProject(path.resolve(args[0] ?? "."));
    process.stdout.write(`${JSON.stringify({ project: result.project, requests: result.requests.map((entry) => ({ id: entry.id, name: entry.name, method: entry.request.method, url: entry.request.url })) }, null, 2)}\n`);
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
