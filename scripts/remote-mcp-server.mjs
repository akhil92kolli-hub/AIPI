#!/usr/bin/env node

import http from "node:http";
import { checkBlastRadius, registryFromEnvironment } from "../packages/remote-registry/index.mjs";

const registry = registryFromEnvironment();
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.AIPI_REMOTE_TOKEN || "";
const tools = [
  { name: "register_contract", title: "Register API contract", description: "Register or update one repository API contract and its known consumers in the organization schema registry.", inputSchema: { type: "object", required: ["organizationId", "repository", "method", "route", "schema"], properties: { organizationId: { type: "string" }, repository: { type: "string" }, method: { type: "string" }, route: { type: "string" }, revision: { type: "string" }, source: { type: "object" }, schema: { type: "object" }, consumers: { type: "array", items: { type: "object" } } }, additionalProperties: false }, annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true } },
  { name: "check_blast_radius", title: "Check cross-repository blast radius", description: "Compare a proposed API schema with the registered provider contract and report consumer repositories and exact source locations that would break.", inputSchema: { type: "object", required: ["organizationId", "repository", "method", "route", "schema"], properties: { organizationId: { type: "string" }, repository: { type: "string" }, method: { type: "string" }, route: { type: "string" }, revision: { type: "string" }, schema: { type: "object" } }, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true } },
  { name: "list_contracts", title: "List registered contracts", description: "List API contracts registered for one organization.", inputSchema: { type: "object", required: ["organizationId"], properties: { organizationId: { type: "string" } }, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true } }
];

function result(data, text, isError = false) {
  return { content: [{ type: "text", text }], structuredContent: data, ...(isError ? { isError: true } : {}) };
}

async function dispatch(message) {
  if (message.method === "initialize") return { protocolVersion: message.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "aipi-remote", version: "0.3.0" }, instructions: "Use check_blast_radius before changing a registered backend contract. Register contracts from trusted CI only." };
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params ?? {};
    if (name === "register_contract") { const contract = await registry.upsert(args); return result({ contract }, `Registered ${contract.method} ${contract.route} from ${contract.repository}.`); }
    if (name === "check_blast_radius") { const report = await checkBlastRadius(registry, args); return result({ report }, report.safe ? "No registered consumer breakages detected." : report.impacts.map((entry) => entry.message).join("\n")); }
    if (name === "list_contracts") { const contracts = await registry.list(args.organizationId); return result({ contracts }, `${contracts.length} contract(s) registered.`); }
    return result({ error: `Unknown tool: ${name}` }, `Unknown tool: ${name}`, true);
  }
  throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) { body += chunk; if (body.length > 1_000_000) throw new Error("Request too large"); }
  return JSON.parse(body || "{}");
}

export function createRemoteMcpServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/healthz") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, service: "aipi-remote" })); return; }
    if (url.pathname === "/.well-known/openai-apps-challenge" && process.env.OPENAI_APPS_CHALLENGE) { response.writeHead(200, { "content-type": "text/plain" }); response.end(process.env.OPENAI_APPS_CHALLENGE); return; }
    if (url.pathname !== "/mcp" || request.method !== "POST") { response.writeHead(404); response.end(); return; }
    if (TOKEN && request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Unauthorized" })); return; }
    try {
      const message = await readJson(request);
      const payload = message.method === "notifications/initialized" ? null : { jsonrpc: "2.0", id: message.id ?? null, result: await dispatch(message) };
      response.writeHead(payload ? 200 : 202, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(payload ? JSON.stringify(payload) : "");
    } catch (error) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: error.code ?? -32603, message: error.message } }));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createRemoteMcpServer();
  server.listen(PORT, HOST, () => process.stderr.write(`AIPI remote MCP listening on http://${HOST}:${PORT}/mcp\n`));
}
