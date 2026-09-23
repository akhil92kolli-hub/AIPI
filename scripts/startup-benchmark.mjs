#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const data = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-startup-"));
const startedAt = performance.now();
const child = spawn(process.execPath, [new URL("./aipi-mcp-bundle.mjs", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, API_FORGE_DATA: data, API_FORGE_PORT: "43130" },
});
const output = readline.createInterface({ input: child.stdout });

try {
  const initialized = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("AIPI startup exceeded 5 seconds")), 5000);
    output.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      resolve(message);
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "startup-benchmark", version: "1" } } })}\n`);
  await initialized;
  const startupMs = Math.round((performance.now() - startedAt) * 10) / 10;
  assert.ok(startupMs < 2000, `AIPI cold startup was ${startupMs} ms; target is under 2000 ms`);
  console.log(`AIPI cold MCP startup: ${startupMs} ms`);
} finally {
  child.kill();
  output.close();
  await fs.rm(data, { recursive: true, force: true });
}
