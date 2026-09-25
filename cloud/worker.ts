import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

type Env = {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  PAIRING: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
};

type PairSocket = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

declare const WebSocketPair: { new(): { 0: PairSocket; 1: PairSocket } };

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_MAX_MESSAGE_BYTES = 2_000_000;

function randomSecret(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

async function authenticatedUser(env: Env, request: Request) {
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, authorization: authorization(request) },
  });
  if (!response.ok) throw new Error("A valid AIPI account session is required for cloud pairing");
  const user = await response.json() as { id?: string };
  if (!user.id) throw new Error("Authenticated AIPI user is missing an ID");
  return user;
}

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
  const status = !baseline ? "unverified" : impacts.length ? "breaking" : "safe";
  return { status, safe: baseline ? impacts.length === 0 : null, route: input.route, method: input.method, baseline, changes: contractChanges, impacts, note: baseline ? null : "No registered provider baseline exists for this route." };
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
  server.registerTool("list_contract_versions", {
    title: "List contract versions", description: "List immutable contract publications for one repository route.",
    inputSchema: z.object({ organizationId: z.string().uuid(), repository: z.string().optional(), method: z.string().optional(), route: z.string().optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ organizationId, repository, method, route }) => {
    const query = new URLSearchParams({ select: "id,organization_id,repository,method,route,revision,source_file,source_line,schema,consumers,content_hash,published_by,created_at", organization_id: `eq.${organizationId}`, order: "created_at.desc" });
    if (repository) query.set("repository", `eq.${repository}`);
    if (method) query.set("method", `eq.${method.toUpperCase()}`);
    if (route) query.set("route", `eq.${route}`);
    const versions = await dataApi(env, request, `api_contract_versions?${query}`) as unknown[];
    return result({ versions }, `${versions.length} immutable contract version(s) found.`);
  });
  server.registerTool("list_registry_audit", {
    title: "List registry audit events", description: "List recent immutable contract publication events.",
    inputSchema: z.object({ organizationId: z.string().uuid(), limit: z.number().int().min(1).max(500).default(100) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ organizationId, limit }) => {
    const query = new URLSearchParams({ select: "id,event_type,repository,method,route,contract_version_id,actor_id,metadata,created_at", organization_id: `eq.${organizationId}`, order: "created_at.desc", limit: String(limit) });
    const events = await dataApi(env, request, `registry_audit_events?${query}`) as unknown[];
    return result({ events }, `${events.length} registry audit event(s) found.`);
  });
  server.registerTool("check_blast_radius", {
    title: "Check cross-repository blast radius",
    description: "Report registered consumer repositories and exact source locations affected by a proposed contract.",
    inputSchema: contractSchema.omit({ consumers: true }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (contract) => {
    const report = await blastRadius(env, request, { ...contract, consumers: [] });
    return result({ report }, report.status === "unverified" ? report.note! : report.safe ? "No registered consumer breakages detected." : report.impacts.map((entry) => entry.message).join("\n"));
  });
  return server;
}

let handler: McpHttpHandler | undefined;
const app = new Hono<{ Bindings: Env }>();
app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "mcp-protocol-version"] }));
app.get("/healthz", (context) => context.json({ ok: true, service: "aipi-remote", protocol: ["2025-11-25", "2026-07-28"] }));
app.post("/pair/sessions", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const sessionId = crypto.randomUUID();
    const companionSecret = randomSecret("cmp");
    const dashboardSecret = randomSecret("dash");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    const stub = context.env.PAIRING.get(context.env.PAIRING.idFromName(sessionId));
    const configured = await stub.fetch(new Request("https://pairing.internal/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, userId: user.id, companionSecret, dashboardSecret, expiresAt }),
    }));
    if (!configured.ok) throw new Error("Pairing session could not be initialized");
    const origin = new URL(context.req.url).origin.replace(/^http/, "ws");
    return context.json({
      sessionId,
      websocketUrl: `${origin}/pair/${sessionId}/socket`,
      companionSecret,
      dashboardSecret,
      expiresAt,
      transport: "websocket-relay",
      persistence: "none",
    }, 201);
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : "Pairing failed" }, 401);
  }
});
app.get("/pair/:sessionId/socket", async (context) => {
  if (context.req.header("upgrade")?.toLowerCase() !== "websocket") return context.json({ error: "WebSocket upgrade required" }, 426);
  const sessionId = context.req.param("sessionId");
  const stub = context.env.PAIRING.get(context.env.PAIRING.idFromName(sessionId));
  return stub.fetch(context.req.raw);
});
app.all("/mcp", async (context) => {
  handler ??= createMcpHandler(({ requestInfo }) => createServer(context.env, requestInfo), {
    legacy: "stateless", responseMode: "auto", onerror: (error) => console.error("AIPI remote MCP:", error),
  });
  return handler.fetch(context.req.raw);
});

export default app;

type PairState = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(timestamp: number): Promise<void>;
    deleteAll(): Promise<void>;
  };
  acceptWebSocket(socket: PairSocket): void;
  getWebSockets(tag?: string): PairSocket[];
};

async function secretHash(value: string) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class PairingSession {
  constructor(private state: PairState) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/configure" && request.method === "POST") {
      const input = await request.json() as { sessionId: string; userId: string; companionSecret: string; dashboardSecret: string; expiresAt: string };
      const expiresAt = Date.parse(input.expiresAt);
      if (!input.sessionId || !input.userId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return new Response("Invalid session", { status: 400 });
      await this.state.storage.put("session", {
        sessionId: input.sessionId,
        userId: input.userId,
        companionHash: await secretHash(input.companionSecret),
        dashboardHash: await secretHash(input.dashboardSecret),
        expiresAt,
      });
      await this.state.storage.setAlarm(expiresAt);
      return new Response(null, { status: 204 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const session = await this.state.storage.get<{ companionHash: string; dashboardHash: string; expiresAt: number }>("session");
    if (!session || session.expiresAt <= Date.now()) return new Response("Pairing session expired", { status: 410 });
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
    const credential = protocols.find((value) => /^(companion|dashboard)\./.test(value));
    const match = credential?.match(/^(companion|dashboard)\.(.+)$/);
    if (!match) return new Response("Pairing credential required", { status: 401 });
    const [, role, secret] = match;
    const expected = role === "companion" ? session.companionHash : session.dashboardHash;
    if (await secretHash(secret) !== expected) return new Response("Pairing credential rejected", { status: 403 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role });
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "aipi.pair.v1" } } as ResponseInit & { webSocket: WebSocket });
  }

  webSocketMessage(socket: PairSocket, message: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as { role?: string } | null;
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (raw.length > PAIRING_MAX_MESSAGE_BYTES) return socket.close(1009, "Message too large");
    let parsed: { type?: string };
    try { parsed = JSON.parse(raw); } catch { return socket.close(1007, "JSON required"); }
    const allowedType = attachment?.role === "dashboard" ? "request" : "response";
    if (parsed.type !== allowedType) return socket.close(1008, "Message role rejected");
    const targetRole = attachment?.role === "dashboard" ? "companion" : "dashboard";
    for (const target of this.state.getWebSockets()) {
      if ((target.deserializeAttachment() as { role?: string } | null)?.role === targetRole) target.send(raw);
    }
  }

  async alarm() {
    for (const socket of this.state.getWebSockets()) socket.close(1000, "Pairing session expired");
    await this.state.storage.deleteAll();
  }
}
