import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  callTool,
  dashboardResource,
  setAipiRuntime,
  startAipiRuntime,
  tools,
} from "../scripts/api-forge-server.mjs";

// Keep the original URI stable so existing Codex UI metadata remains valid.
const DASHBOARD_RESOURCE_URI = "ui://api-forge/dashboard-v1.html";

function createServer() {
  const server = new McpServer(
    { name: "aipi", version: "0.3.0" },
    {
      instructions:
        "Treat the AIPI dashboard as an inspection surface. For fixes, prefer analyze_and_repair_contract: retrieve a small project summary, identify one endpoint, return bounded evidence, let the editor apply the smallest correction, then verify only that affected contract. Use trace_route, diff_contract, run_local_diagnostic, check_blast_radius, and generate_fixture as focused supporting tools.",
    },
  );

  for (const tool of tools) {
    const inputSchema = z.fromJSONSchema(tool.inputSchema as never);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema,
        annotations: tool.annotations,
        _meta: tool._meta,
      },
      async (args: unknown) => await invokeTool(tool.name, args ?? {}) as never,
    );
  }

  server.registerResource(
    "aipi-dashboard",
    DASHBOARD_RESOURCE_URI,
    {
      title: "AIPI",
      description: "Inspect project setup, source coverage, environments, API inventory, and local run evidence.",
      mimeType: "text/html;profile=mcp-app",
    },
    async () => ({
      contents: [{
        uri: DASHBOARD_RESOURCE_URI,
        mimeType: "text/html;profile=mcp-app",
        text: await dashboardResource(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [runtime.url], resourceDomains: [] },
          },
        },
      }],
    }),
  );

  return server;
}

const daemonUrl = process.env.AIPI_DAEMON_URL;
const daemonToken = process.env.AIPI_DAEMON_TOKEN;
const runtime = daemonUrl
  ? setAipiRuntime({ url: daemonUrl, token: daemonToken, port: Number(process.env.AIPI_PORT || 49152) })
  : await startAipiRuntime();

async function invokeTool(name: string, args: unknown) {
  if (!daemonUrl || !daemonToken) return await callTool(name, args ?? {});
  const response = await fetch(`${daemonUrl}/api/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${daemonToken}` },
    body: JSON.stringify({ name, arguments: args ?? {} }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `AIPI daemon tool call failed (${response.status})`);
  return payload;
}

const handle = serveStdio(() => createServer(), {
  legacy: "serve",
  onerror: (error) => console.error("AIPI MCP error:", error),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await handle.close();
    process.exit(0);
  });
}
