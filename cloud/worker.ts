import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

type Env = {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
};

const fieldSchema = z.object({ name: z.string(), type: z.string(), required: z.boolean().default(true) });
const contractSchema = z.object({
  organizationId: z.string().uuid(),
  repository: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  route: z.string().startsWith("/"),
  revision: z.string().default("working-tree"),
  source: z.object({ file: z.string(), line: z.number().int().positive() }).nullable().optional(),
  schema: z.object({ fields: z.array(fieldSchema) }),
  consumers: z.array(z.object({
    repository: z.string(), file: z.string(), line: z.number().int().positive(), fields: z.array(fieldSchema),
  })).default([]),
});

type Contract = z.infer<typeof contractSchema>;

function authorization(request?: Request) {
  const value = request?.headers.get("authorization");
  if (!value?.toLowerCase().startsWith("bearer ")) throw new Error("A Supabase user access token is required");
  return value;
}

async function dataApi(env: Env, request: Request | undefined, path: string, init: RequestInit = {}) {
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      authorization: authorization(request),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  return response.status === 204 ? null : await response.json();
}

function fromRow(row: Record<string, unknown>): Contract {
  return contractSchema.parse({
    organizationId: row.organization_id, repository: row.repository, method: row.method,
    route: row.route, revision: row.revision,
    source: row.source_file ? { file: row.source_file, line: row.source_line } : null,
    schema: row.schema, consumers: row.consumers,
  });
}

async function listContracts(env: Env, request: Request | undefined, organizationId: string) {
  const query = new URLSearchParams({
    select: "organization_id,repository,method,route,revision,source_file,source_line,schema,consumers",
    organization_id: `eq.${organizationId}`,
  });
  const rows = await dataApi(env, request, `api_contracts?${query}`) as Record<string, unknown>[];
  return rows.map(fromRow);
}

function changes(previous: Contract | null, proposed: Contract) {
  const before = new Map((previous?.schema.fields ?? []).map((field) => [field.name, field]));
  const after = new Map(proposed.schema.fields.map((field) => [field.name, field]));
  const result: Array<{ field: string; kind: string; before: unknown; after: unknown }> = [];
  for (const [name, field] of before) {
    const next = after.get(name);
    if (!next) result.push({ field: name, kind: "removed", before: field.type, after: null });
    else if (field.type !== next.type) result.push({ field: name, kind: "type-changed", before: field.type, after: next.type });
    else if (field.required !== next.required) result.push({ field: name, kind: "required-changed", before: field.required, after: next.required });
  }
  for (const [name, field] of after) if (!before.has(name) && field.required) result.push({ field: name, kind: "required-added", before: null, after: field.type });
  return result;
}

async function blastRadius(env: Env, request: Request | undefined, input: Contract) {
  const contracts = await listContracts(env, request, input.organizationId);
  const providers = contracts.filter((entry) => entry.method === input.method && entry.route === input.route);
  const baseline = providers.find((entry) => entry.repository === input.repository) ?? providers[0] ?? null;
  const contractChanges = changes(baseline, input);
  const impacts = providers.flatMap((provider) => provider.consumers.flatMap((consumer) => contractChanges.flatMap((change) => {
    const expected = consumer.fields.find((field) => field.name === change.field);
    const unsafe = expected && (change.kind === "removed" || change.kind === "type-changed" ||
      (change.kind === "required-changed" && change.after === false && expected.required));
    return unsafe ? [{
      repository: consumer.repository, file: consumer.file, line: consumer.line,
      field: change.field, change: change.kind, expected: expected.type, proposed: change.after,
      message: `${change.field} ${change.kind.replaceAll("-", " ")} will break ${consumer.repository} (${consumer.file}:${consumer.line}).`,
    }] : [];
  })));
  return { safe: impacts.length === 0, route: input.route, method: input.method, baseline, changes: contractChanges, impacts };
}

function result(data: Record<string, unknown>, text: string) {
  return { content: [{ type: "text" as const, text }], structuredContent: data };
}

function createServer(env: Env, request?: Request) {
  const server = new McpServer({ name: "aipi-remote", version: "0.3.0" }, {
    instructions: "Register contracts from trusted CI. Check blast radius before changing a provider contract.",
  });
  server.registerTool("register_contract", {
    title: "Register API contract",
    description: "Register or update one repository contract and its known consumers.",
    inputSchema: contractSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (contract) => {
    const rows = await dataApi(env, request, "api_contracts?on_conflict=organization_id,repository,method,route", {
      method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        organization_id: contract.organizationId, repository: contract.repository, method: contract.method,
        route: contract.route, revision: contract.revision, source_file: contract.source?.file ?? null,
        source_line: contract.source?.line ?? null, schema: contract.schema, consumers: contract.consumers,
        updated_at: new Date().toISOString(),
      }),
    }) as unknown[];
    return result({ contract, persisted: rows.length === 1 }, `Registered ${contract.method} ${contract.route} from ${contract.repository}.`);
  });
  server.registerTool("list_contracts", {
    title: "List registered contracts", description: "List contracts visible to the authenticated organization owner.",
    inputSchema: z.object({ organizationId: z.string().uuid() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ organizationId }) => {
    const contracts = await listContracts(env, request, organizationId);
    return result({ contracts }, `${contracts.length} contract(s) registered.`);
  });
  server.registerTool("check_blast_radius", {
    title: "Check cross-repository blast radius",
    description: "Report registered consumer repositories and exact source locations affected by a proposed contract.",
    inputSchema: contractSchema.omit({ consumers: true }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (contract) => {
    const report = await blastRadius(env, request, { ...contract, consumers: [] });
    return result({ report }, report.safe ? "No registered consumer breakages detected." : report.impacts.map((entry) => entry.message).join("\n"));
  });
  return server;
}

let handler: McpHttpHandler | undefined;
const app = new Hono<{ Bindings: Env }>();
app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "mcp-protocol-version"] }));
app.get("/healthz", (context) => context.json({ ok: true, service: "aipi-remote", protocol: ["2025-11-25", "2026-07-28"] }));
app.all("/mcp", async (context) => {
  handler ??= createMcpHandler(({ requestInfo }) => createServer(context.env, requestInfo), {
    legacy: "stateless", responseMode: "auto", onerror: (error) => console.error("AIPI remote MCP:", error),
  });
  return handler.fetch(context.req.raw);
});

export default app;
