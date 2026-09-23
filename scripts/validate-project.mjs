#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "skills/api-testing/SKILL.md",
  "scripts/api-forge-server.mjs",
  "scripts/aipi-mcp-bundle.mjs",
  "scripts/aipi-cli-bundle.mjs",
  "src/local-mcp.ts",
  "cloud/worker.ts",
  "packages/core/index.mjs",
  "packages/collection-schema/index.mjs",
  "packages/integration-map/index.mjs",
  "packages/test-generators/index.mjs",
  "packages/cli/bin/api-forge.mjs",
  "docs/ROADMAP.md",
  "fixtures/next-contract-mismatch/app/api/users/route.ts",
  "ui/index.html"
];

for (const relative of required) {
  await fs.access(path.join(root, relative));
}

const manifest = JSON.parse(await fs.readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
assert.equal(manifest.name, "aipi");
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.mcpServers, "./.mcp.json");
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);

const mcp = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
assert.ok(mcp.mcpServers?.aipi);
assert.ok(mcp.mcpServers.aipi.args.includes("${PLUGIN_ROOT}/scripts/aipi-mcp-bundle.mjs"));

process.stdout.write("AIPI project validation passed\n");
