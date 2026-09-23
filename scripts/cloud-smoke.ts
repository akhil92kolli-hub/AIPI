import assert from "node:assert/strict";
import app from "../cloud/worker.js";

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
const payload = JSON.parse(jsonText) as { result?: { serverInfo?: { name?: string } } };
assert.equal(payload.result?.serverInfo?.name, "aipi-remote");

console.log("AIPI Cloudflare/Hono MCP smoke test passed");
