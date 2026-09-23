import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  callTool,
  dashboardResource,
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
        "Treat the AIPI dashboard as an inspection surface. Use trace_route, diff_contract, run_local_diagnostic, check_blast_radius, and generate_fixture as the evidence loop before editing code.",
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
      async (args: unknown) => await callTool(tool.name, args ?? {}) as never,
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

const runtime = await startAipiRuntime();
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
