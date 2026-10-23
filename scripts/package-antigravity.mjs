#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugins", "aipi");
const outputDir = path.join(root, "dist", "antigravity");
const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
const mcp = JSON.parse(await readFile(path.join(source, "mcp_config.json"), "utf8"));

assert.equal(manifest.name, "aipi");
assert.ok(mcp.mcpServers?.aipi);
for (const relative of ["rules/AGENTS.md", "skills/aipi/SKILL.md", "assets/icon.svg"]) {
  await readFile(path.join(source, relative));
}

await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, "aipi.zip");
await rm(output, { force: true });
await new Promise((resolve, reject) => {
  const child = spawn("zip", ["-q", "-r", output, "."], { cwd: source, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`zip exited with ${code}`)));
});

console.log(output);
