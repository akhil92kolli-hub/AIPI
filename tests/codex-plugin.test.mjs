import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const manifest = JSON.parse(await fs.readFile(".codex-plugin/plugin.json", "utf8"));
const servers = JSON.parse(await fs.readFile(".mcp.json", "utf8"));
const marketplace = JSON.parse(await fs.readFile(".agents/plugins/marketplace.json", "utf8"));

assert.equal(manifest.name, "aipi");
assert.equal(manifest.requires_local_executor, true);
assert.equal(manifest.extensions["com.openai"].onboardingSkill, "./skills/aipi-ide/SKILL.md");
assert.ok((await fs.stat(path.join("skills/aipi-ide", "SKILL.md"))).isFile());
assert.equal(servers.mcpServers.aipi.command, "node");
assert.deepEqual(servers.mcpServers.aipi.args, ["${PLUGIN_ROOT}/scripts/aipi-mcp-bundle.mjs"]);
assert.equal(servers.mcpServers.aipi.env, undefined, "plugin MCP should share the local companion's default workspace");
assert.equal(marketplace.plugins[0].name, manifest.name);
assert.equal(marketplace.plugins[0].source.path, "./");
assert.ok((await fs.stat("scripts/aipi-mcp-bundle.mjs")).isFile());

console.log("Codex plugin manifest, local MCP wiring, onboarding skill, and marketplace entry passed.");
