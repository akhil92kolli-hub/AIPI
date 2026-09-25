#!/usr/bin/env node

import assert from "node:assert/strict";
import app from "../cloud/worker.ts";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
};

const health = await app.request("http://aipi.test/healthz", {}, env);
assert.equal(health.status, 200);
assert.equal((await health.json()).service, "aipi-remote");

const initialized = await app.request("http://aipi.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-user-token" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cloud-smoke", version: "1" } },
  }),
}, env);
assert.equal(initialized.status, 200);
const responseText = await initialized.text();
const jsonText = initialized.headers.get("content-type")?.includes("text/event-stream")
  ? responseText.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}"
  : responseText;
const payload = JSON.parse(jsonText);
assert.equal(payload.result?.serverInfo?.name, "aipi-remote");

const listed = await app.request("http://aipi.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-user-token" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
}, env);
assert.equal(listed.status, 200);
const listedText = await listed.text();
const listedJson = JSON.parse(listed.headers.get("content-type")?.includes("text/event-stream")
  ? listedText.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}"
  : listedText);
const toolNames = listedJson.result.tools.map((tool) => tool.name);
assert.equal(toolNames.includes("list_contract_versions"), true);
assert.equal(toolNames.includes("list_registry_audit"), true);

console.log("AIPI Cloudflare/Hono MCP smoke test passed");
