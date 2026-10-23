import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { breakingChangeForConsumer, contractChanges, normalizeContract, normalizeRepository, normalizeRoute } from "../packages/contract-domain/index.js";
import { analyzeTeamImpact } from "../packages/core/team-impact.mjs";
import { assessTeamChangedFiles, scopeTeamAssessmentGraph } from "../packages/core/team-change-assessment.mjs";
import { compareOpenApiJson } from "../packages/core/team-contract-comparison.mjs";
import { discoverPinnedGeneratedConsumers, extractGeneratedClientFacts, extractOpenApiSourceFacts } from "../packages/core/source-fact-partition.mjs";
import { composeTeamPrReport } from "../packages/core/team-pr-report.mjs";
import { evaluateReleaseCompatibility } from "../packages/core/release-compatibility.mjs";
import { githubRepositoryRequest, publishAipiBlockingCheck, verifyGitHubWebhook, verifyUserInstallationAccess, verifyUserRepositoryAccess } from "../packages/core/team-github-app.mjs";

type Env = {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_CALLBACK_URL?: string;
  GITHUB_OAUTH_STATE_SECRET?: string;
  AIPI_DEPLOYMENT_CONTROLLER_SECRET?: string;
  OPENAI_APPS_CHALLENGE?: string;
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

class CloudIdentityConfigurationError extends Error {}
class SupabaseDataError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function assertCloudIdentity(env: Env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    throw new CloudIdentityConfigurationError("AIPI cloud identity is not fully configured");
  }
}

function randomSecret(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const decodeBase64url = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
async function githubOAuthState(env: Env, payload: Record<string, unknown>) {
  if (!env.GITHUB_OAUTH_STATE_SECRET) throw new CloudIdentityConfigurationError("GitHub OAuth state signing is not configured");
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GITHUB_OAUTH_STATE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))));
  return `${body}.${signature}`;
}
function validGithubReturnPath(value:unknown):value is string {
 return typeof value==='string'&&(["/team","/team/dashboard","/workspace/connect"].includes(value)||/^\/workspace\/[0-9a-f-]{36}\/manage\/general$/.test(value));
}
async function verifyGithubOAuthState(env: Env, value: string, userId: string) {
  if (!env.GITHUB_OAUTH_STATE_SECRET || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
    throw new SupabaseDataError(403, "GitHub authorization state is invalid");
  const [body, signature] = value.split(".");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GITHUB_OAUTH_STATE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, decodeBase64url(signature), new TextEncoder().encode(body)))
    throw new SupabaseDataError(403, "GitHub authorization state is invalid");
  const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(body))) as { userId?:string; expiresAt?:number; returnTo?:string };
  if (payload.userId !== userId || !payload.expiresAt || payload.expiresAt <= Date.now() ||
      !validGithubReturnPath(payload.returnTo))
    throw new SupabaseDataError(403, "GitHub authorization state expired or belongs to another user");
  return payload;
}

async function authenticatedUser(env: Env, request: Request) {
  assertCloudIdentity(env);
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, authorization: authorization(request) },
  });
  if (!response.ok) throw new Error("A valid AIPI account session is required");
  const user = await response.json() as { id?: string; email?: string; identities?: Array<{ provider?: string; id?: string; identity_data?: { id?: string | number; sub?: string | number } }> };
  if (!user.id) throw new Error("Authenticated AIPI user is missing an ID");
  return user;
}

const fieldSchema = z.object({ name: z.string(), type: z.string(), required: z.boolean().default(true) });
const contractSchema = z.object({
  organizationId: z.string().uuid(),
  repository: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  route: z.string().startsWith("/"),
  direction: z.enum(["request", "response"]).default("request"),
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
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    let code: string | undefined;
    try { code = (JSON.parse(detail) as { code?: string }).code; } catch {}
    if (code === "40001") throw new SupabaseDataError(409, "Task version changed; reload before retrying");
    if (code === "23505") throw new SupabaseDataError(409, "An invitation for this email already exists");
    if (detail.includes("TEAM_USAGE_LIMIT")) throw new SupabaseDataError(429, "Monthly team event budget reached");
    if (detail.includes("TEAM_SEAT_LIMIT")) throw new SupabaseDataError(403, "Team seat limit reached");
    if (detail.includes("TEAM_PLAN_EXPIRED")) throw new SupabaseDataError(403, "Team plan expired");
    if (detail.includes("SOURCE_SHARING_POLICY_DENIED")) throw new SupabaseDataError(403, "Source-sharing policy denied this evidence");
    if (code === "42501" || code === "28000") throw new SupabaseDataError(403, "Team access denied");
    throw new SupabaseDataError(response.status, `Database request failed: ${detail}`);
  }
  return response.status === 204 ? null : await response.json();
}

async function serviceDataApi(env: Env, path: string, init: RequestInit = {}) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new CloudIdentityConfigurationError("Team service broker is not configured");
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init, headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const detail=(await response.text()).slice(0,300);
    if (detail.includes('40001')) throw new SupabaseDataError(409,'Deployment generation or event identity changed');
    throw new SupabaseDataError(response.status,`Database request failed: ${detail}`);
  }
  // PostgREST's default return=minimal can succeed with 201 and an empty body.
  // Treating that as JSON made a completed GitHub authorization look like an
  // "Invalid team request" after the identity row had already been saved.
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function hasLinkedGithubUser(env: Env, request: Request, userId: string, githubUserId: number) {
  const rows = await dataApi(env, request,
    `team_github_user_identities?select=github_user_id&user_id=eq.${userId}&limit=1`) as Array<{github_user_id:number}>;
  return rows.length === 1 && Number(rows[0].github_user_id) === githubUserId;
}

async function exportTable(env: Env, request: Request, path: string) {
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, authorization: authorization(request), prefer: "count=exact" },
  });
  if (!response.ok) throw new SupabaseDataError(response.status, "Team export query failed");
  const count = response.headers.get("content-range")?.split("/")[1];
  if (!count || !/^\d+$/.test(count)) throw new SupabaseDataError(502, "Team export count unavailable");
  if (Number(count) > 1000) throw new SupabaseDataError(413, "Team export exceeds the per-table limit");
  return await response.json() as Record<string, unknown>[];
}

function fromRow(row: Record<string, unknown>): Contract {
  return normalizeContract(contractSchema.parse({
    organizationId: row.organization_id, repository: row.repository, method: row.method,
    route: row.route, revision: row.revision,
    source: row.source_file ? { file: row.source_file, line: row.source_line } : null,
    direction: row.direction ?? (row.schema as { direction?: string } | null)?.direction,
    schema: row.schema, consumers: row.consumers,
  })) as Contract;
}

async function listContracts(env: Env, request: Request | undefined, organizationId: string) {
  const query = new URLSearchParams({
    select: "organization_id,repository,method,route,direction,revision,source_file,source_line,schema,consumers",
    organization_id: `eq.${organizationId}`,
  });
  const rows = await dataApi(env, request, `api_contracts?${query}`) as Record<string, unknown>[];
  return rows.map(fromRow);
}

async function blastRadius(env: Env, request: Request | undefined, input: Contract) {
  const proposed = normalizeContract(input) as Contract;
  const contracts = await listContracts(env, request, proposed.organizationId);
  const providers = contracts.filter((entry) => entry.method === proposed.method && normalizeRoute(entry.route) === proposed.route && entry.direction === proposed.direction);
  const baseline = providers.find((entry) => normalizeRepository(entry.repository) === proposed.repository) ?? providers[0] ?? null;
  const changes = contractChanges(baseline, proposed);
  const impacts = providers.flatMap((provider) => provider.consumers.flatMap((consumer) => changes.flatMap((change) => {
    const expected = consumer.fields.find((field) => field.name === change.field);
    const unsafe = breakingChangeForConsumer(change, expected);
    return unsafe ? [{
      repository: consumer.repository, file: consumer.file, line: consumer.line,
      field: change.field, change: change.kind, expected: expected?.type ?? null, proposed: change.after,
      message: `${change.field} ${change.kind.replaceAll("-", " ")} will break ${consumer.repository} (${consumer.file}:${consumer.line}).`,
    }] : [];
  })));
  const status = !baseline ? "unverified" : impacts.length ? "breaking" : "safe";
  return { status, safe: baseline ? impacts.length === 0 : null, route: proposed.route, method: proposed.method, direction: proposed.direction, baseline, changes, impacts, note: baseline ? null : "No registered provider baseline exists for this route." };
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
    const normalized = normalizeContract(contract) as Contract;
    const rows = await dataApi(env, request, "api_contracts?on_conflict=organization_id,repository,method,route,direction", {
      method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        organization_id: normalized.organizationId, repository: normalized.repository, method: normalized.method,
        route: normalized.route, direction: normalized.direction, revision: normalized.revision, source_file: normalized.source?.file ?? null,
        source_line: normalized.source?.line ?? null, schema: normalized.schema, consumers: normalized.consumers,
        updated_at: new Date().toISOString(),
      }),
    }) as unknown[];
    return result({ contract: normalized, persisted: rows.length === 1 }, `Registered ${normalized.method} ${normalized.route} from ${normalized.repository}.`);
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
    inputSchema: z.object({ organizationId: z.string().uuid(), repository: z.string().optional(), method: z.string().optional(), route: z.string().optional(), direction: z.enum(["request", "response"]).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ organizationId, repository, method, route, direction }) => {
    const query = new URLSearchParams({ select: "id,organization_id,repository,method,route,direction,revision,source_file,source_line,schema,consumers,content_hash,published_by,created_at", organization_id: `eq.${organizationId}`, order: "created_at.desc" });
    if (repository) query.set("repository", `eq.${normalizeRepository(repository)}`);
    if (method) query.set("method", `eq.${method.toUpperCase()}`);
    if (route) query.set("route", `eq.${normalizeRoute(route)}`);
    if (direction) query.set("direction", `eq.${direction}`);
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
  server.registerTool("list_organization_members", {
    title: "List organization members",
    description: "List organization members and their production registry roles.",
    inputSchema: z.object({ organizationId: z.string().uuid() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ organizationId }) => {
    const query = new URLSearchParams({ select: "organization_id,user_id,role,created_at,updated_at", organization_id: `eq.${organizationId}`, order: "created_at.asc" });
    const members = await dataApi(env, request, `organization_memberships?${query}`) as unknown[];
    return result({ members }, `${members.length} organization member(s) found.`);
  });
  server.registerTool("resolve_team_task_context", {
    title: "Resolve shared task context",
    description: "Read a bounded team handoff with task scope, decisions, comments, evidence freshness, receipts and unresolved dependencies. Requires organization membership.",
    inputSchema: z.object({ organizationId: z.uuid(), taskId: z.uuid(), limit: z.number().int().min(1).max(50).default(25) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ organizationId, taskId, limit }) => {
    const context = await dataApi(env, request, "rpc/resolve_team_task_context", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_task_id: taskId, p_limit: limit }),
    }) as Record<string, unknown>;
    return result({ context }, `Resolved shared context for task ${taskId}.`);
  });
  server.registerTool("search_team_decisions", {
    title: "Search current team decisions",
    description: "Search current, non-superseded decisions visible to the authenticated organization member.",
    inputSchema: z.object({ organizationId: z.uuid(), query: z.string().trim().min(2).max(120), limit: z.number().int().min(1).max(50).default(25) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ organizationId, query, limit }) => {
    const decisions = await dataApi(env, request, "rpc/search_team_decisions", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_query: query, p_limit: limit }),
    }) as unknown[];
    return result({ decisions }, `${decisions.length} current decision(s) found.`);
  });
  server.registerTool("set_retention_policy", {
    title: "Set organization retention policy",
    description: "Set contract-version and registry-audit retention windows. Requires organization owner or admin role.",
    inputSchema: z.object({ organizationId: z.string().uuid(), contractVersionDays: z.number().int().min(7).max(3650), auditEventDays: z.number().int().min(7).max(3650) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ organizationId, contractVersionDays, auditEventDays }) => {
    const rows = await dataApi(env, request, "organization_retention_policies?on_conflict=organization_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ organization_id: organizationId, contract_version_days: contractVersionDays, audit_event_days: auditEventDays, updated_at: new Date().toISOString() }),
    }) as unknown[];
    return result({ policy: rows[0] ?? null }, "Organization retention policy updated.");
  });
  server.registerTool("apply_retention_policy", {
    title: "Apply organization retention policy",
    description: "Delete expired registry audit events and old contract versions while preserving the latest version of every route. Requires explicit owner/admin invocation.",
    inputSchema: z.object({ organizationId: z.string().uuid(), confirm: z.literal(true) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ organizationId }) => {
    const rows = await dataApi(env, request, "rpc/apply_organization_retention", { method: "POST", body: JSON.stringify({ p_organization_id: organizationId }) }) as unknown[];
    return result({ organizationId, deleted: rows[0] ?? { deleted_versions: 0, deleted_audit_events: 0 } }, "Organization retention policy applied.");
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
app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "x-aipi-github-user-token"] }));
const teamWorkspaceInput = z.object({ id:z.uuid().optional(), name: z.string().trim().min(1).max(120), description: z.string().max(4000).nullable().optional() }).strict();
const teamProjectInput = z.object({
  projectKey: z.string().regex(/^prj_[A-Za-z0-9_-]{4,100}$/),
  providerRepositoryId: z.string().regex(/^[1-9][0-9]{0,29}$/),
  repository: z.string().min(1).max(240),
  remoteUrl: z.url().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/),
  repositoryRoot: z.string().regex(/^(\.|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/)
    .refine((root) => root === "." || root.split("/").every((segment) => segment !== "." && segment !== ".."))
    .default("."),
}).strict();
const teamUnboundProjectInput = z.object({ projectKey: teamProjectInput.shape.projectKey,name:z.string().trim().min(1).max(120).optional() }).strict();
const graphNodeInput = z.object({ projectKey: z.string().regex(/^prj_[A-Za-z0-9_-]{4,100}$/), nodeKey: z.string().min(1).max(500),
  kind: z.enum(["contract", "route", "caller", "test", "task", "schema"]), label: z.string().min(1).max(500),
  sourceRef: z.string().max(1000).optional(), revisionCommit: z.string().regex(/^[0-9a-f]{40}$/), ownerId: z.uuid().nullable().optional() }).strict();
const graphEdgeInput = z.object({ fromProjectKey: graphNodeInput.shape.projectKey, fromNodeKey: graphNodeInput.shape.nodeKey,
  toProjectKey: graphNodeInput.shape.projectKey, toNodeKey: graphNodeInput.shape.nodeKey,
  relation: z.enum(["consumed_by", "tested_by", "depends_on"]), evidenceKind: z.enum(["declared", "static", "runtime", "ai_suggestion"]),
  evidenceKey: z.string().min(1).max(500), revisionSet: z.array(z.object({ projectKey: graphNodeInput.shape.projectKey,
    commit: graphNodeInput.shape.revisionCommit }).strict()).min(1).max(32),
  sourceRefs: z.array(z.string().max(1000)).max(100).default([]), requiredChecks: z.array(z.string().max(200)).max(50).default([]) }).strict();
const graphBatchInput = z.object({ nodes: z.array(graphNodeInput).max(200), edges: z.array(graphEdgeInput).max(500) }).strict();
const impactInput = z.object({ changedProjectKey: graphNodeInput.shape.projectKey, changedNodeKey: graphNodeInput.shape.nodeKey,
  revisionSet: graphEdgeInput.shape.revisionSet, maxDepth: z.number().int().min(1).max(8).default(5) }).strict();
const teamDeviceInput = z.object({ label: z.string().trim().min(1).max(120) }).strict();
const teamOrganizationInput = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const teamMemberInput = z.object({ userId: z.uuid(), role: z.enum(["admin", "developer", "viewer"]) }).strict();
const teamInviteInput = z.object({ email: z.email().max(320).transform((value) => value.trim().toLowerCase()),
  role: z.enum(["admin", "developer", "viewer"]).default("developer"), workspaceId: z.uuid() }).strict();
const teamRevision = z.object({ projectKey: z.string().regex(/^prj_[A-Za-z0-9_-]{4,100}$/),
  sourceBindingId: z.string().regex(/^src_[A-Za-z0-9_-]{8,100}$/).optional(),
  commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict();
const teamTaskStatusInput = z.enum(["proposed", "open", "in_progress", "in_review", "blocked", "completed", "archived"]);
const teamTaskPatchInput = z.object({ title: z.string().trim().min(1).max(500).optional(), description: z.string().max(16000).optional(), status: teamTaskStatusInput.optional(), revisionSet: z.array(teamRevision).max(32).optional() }).strict().refine((value) => Object.keys(value).length > 0);
const teamOperationInput = z.object({ schemaVersion: z.literal(1), operationId: z.uuid(), deviceId: z.uuid(), externalId: z.string().regex(/^task_[A-Za-z0-9_-]{4,100}$/), projectKey: z.string().regex(/^prj_[A-Za-z0-9_-]{4,100}$/).optional(), patch: teamTaskPatchInput.optional(), title: z.string().trim().min(1).max(500).optional(), description: z.string().max(16000).optional(), status: teamTaskStatusInput.optional(), revisionSet: z.array(teamRevision).max(32).optional(), baseVersion: z.number().int().min(0) }).strict().refine((value) => Boolean(value.patch || value.title), 'A task patch or title is required');
const teamAppendPayload = z.discriminatedUnion("entityType", [
  z.object({ entityType: z.literal("decision"), taskId: z.uuid().nullable().optional(), body: z.string().trim().min(1).max(16000), sourceRefs: z.array(z.string().max(500)).max(100).default([]), supersedesId: z.uuid().nullable().optional() }).strict(),
  z.object({ entityType: z.literal("evidence"), taskId: z.uuid().nullable().optional(), kind: z.enum(["declared", "static", "runtime", "verification", "ai_suggestion"]), producer: z.string().trim().min(1).max(160), revisionSet: z.array(teamRevision).max(32).default([]), payload: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 64000) }).strict(),
  z.object({ entityType: z.literal("comment"), taskId: z.uuid(), body: z.string().trim().min(1).max(16000) }).strict(),
  z.object({ entityType: z.literal("receipt"), taskId: z.uuid(), result: z.enum(["passed", "failed", "inconclusive"]), summary: z.string().trim().min(1).max(4000), revisionSet: z.array(teamRevision).max(32).default([]), sourceRefs: z.array(z.string().max(500)).max(100).default([]) }).strict(),
]);
const teamAppendInput = z.object({ schemaVersion: z.literal(1), operationId: z.uuid(), deviceId: z.uuid(), payload: teamAppendPayload }).strict();
const teamContextOperationInput = z.object({ schemaVersion: z.literal(1), operationId: z.uuid(), deviceId: z.uuid(), taskId: z.uuid(), baseVersion: z.number().int().positive(), ownerId: z.uuid().nullable(), scope: z.array(z.object({ projectKey: z.string().regex(/^prj_[A-Za-z0-9_-]{4,100}$/), target: z.string().max(500).optional() }).strict()).max(32), dependencies: z.array(z.string().regex(/^task_[A-Za-z0-9_-]{4,100}$/)).max(100), provenance: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 8000) }).strict();

function teamError(error: unknown): Response {
  if (error instanceof CloudIdentityConfigurationError) return Response.json({ error: error.message }, { status: 503 });
  if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "Invalid team request" }, { status: 400 });
  if (error instanceof SupabaseDataError) return Response.json({ error: error.message }, { status: error.status === 401 ? 401 : error.status === 403 ? 403 : error.status === 409 ? 409 : error.status === 413 ? 413 : error.status === 429 ? 429 : error.status >= 500 ? 502 : 400 });
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

app.get("/api/team/organizations", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const query = new URLSearchParams({ select: "id,name,owner_id,created_at", order: "created_at.asc", limit: "200" });
    return context.json({ organizations: await dataApi(context.env, context.req.raw, `organizations?${query}`) });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const input = teamOrganizationInput.parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw, "organizations?select=id,name,owner_id,created_at", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify({ name: input.name, owner_id: user.id }) }) as unknown[];
    return context.json({ organization: rows[0] }, 201);
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/members", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const query = new URLSearchParams({ select: "organization_id,user_id,role,created_at,updated_at", organization_id: `eq.${organizationId}`, order: "created_at.asc", limit: "200" });
    return context.json({ members: await dataApi(context.env, context.req.raw, `organization_memberships?${query}`) });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/members", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const input = teamMemberInput.parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw, "organization_memberships?select=organization_id,user_id,role,created_at,updated_at", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify({ organization_id: organizationId, user_id: input.userId, role: input.role }) }) as unknown[];
    return context.json({ member: rows[0] }, 201);
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/invitations", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const query = new URLSearchParams({ select: "id,workspace_id,email,role,created_at,expires_at,accepted_at", organization_id: `eq.${organizationId}`, order: "created_at.desc", limit: "200" });
    return context.json({ invitations: await dataApi(context.env, context.req.raw, `team_email_invitations?${query}`) });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/invitations", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const input = teamInviteInput.parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw,
      "team_email_invitations?select=id,workspace_id,email,role,created_at,expires_at,accepted_at", {
        method: "POST", headers: { prefer: "return=representation" },
        body: JSON.stringify({ organization_id: organizationId, workspace_id: input.workspaceId,
          email: input.email, role: input.role, invited_by: user.id }),
      }) as unknown[];
    const invitation = rows[0] as { id: string } | undefined;
    if (!invitation) throw new SupabaseDataError(502, "Invitation was not saved");
    const redirect = new URL("https://app.aipi.website/team");
    redirect.searchParams.set("invitation", invitation.id);
    const emailResponse = await fetch(`${context.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect.href)}`, {
      method: "POST", headers: { apikey: context.env.SUPABASE_PUBLISHABLE_KEY, "content-type": "application/json" },
      body: JSON.stringify({ email: input.email, create_user: true }),
    });
    return context.json({ invitation, delivered: emailResponse.ok }, 201);
  } catch (error) { return teamError(error); }
});
app.get("/api/team/invitations/pending", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    if (!user.email) throw new Error("A verified email account is required");
    const query = new URLSearchParams({ select: "id,organization_id,workspace_id,email,role,created_at,expires_at", email: `eq.${user.email.toLowerCase()}`, accepted_at: "is.null", expires_at: `gt.${new Date().toISOString()}`, limit: "50" });
    return context.json({ invitations: await dataApi(context.env, context.req.raw, `team_email_invitations?${query}`) });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/invitations/:invitationId/accept", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const invitationId = z.uuid().parse(context.req.param("invitationId"));
    const organizationId = await dataApi(context.env, context.req.raw, "rpc/accept_team_email_invitation", {
      method: "POST", body: JSON.stringify({ p_invitation_id: invitationId }),
    });
    return context.json({ organizationId });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/pilot", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const [entitlements, usage, policies, members, workspaces, installations] = await Promise.all([
      dataApi(context.env, context.req.raw, `team_entitlements?select=plan,seat_limit,monthly_event_limit,expires_at&organization_id=eq.${organizationId}&limit=1`),
      dataApi(context.env, context.req.raw, `team_usage_months?select=month_start,accepted_events&organization_id=eq.${organizationId}&order=month_start.desc&limit=1`),
      dataApi(context.env, context.req.raw, `team_source_policies?select=sharing_mode,updated_at&organization_id=eq.${organizationId}&limit=1`),
      dataApi(context.env, context.req.raw, `organization_memberships?select=user_id&organization_id=eq.${organizationId}&limit=10001`),
      dataApi(context.env, context.req.raw, `team_workspaces?select=id&organization_id=eq.${organizationId}&limit=10001`),
      dataApi(context.env, context.req.raw, `team_github_installations?select=installation_id,account_login,active&organization_id=eq.${organizationId}&limit=100`),
    ]) as [any[], any[], any[], any[], any[], any[]];
    if (!entitlements.length || !policies.length || members.length > 10000 || workspaces.length > 10000)
      return context.json({ error: "Pilot diagnostics unavailable or too large" }, 404);
    return context.json({ entitlement: entitlements[0], usage: usage[0] ?? { accepted_events: 0 },
      sourcePolicy: policies[0], seatsUsed: members.length, workspaceCount: workspaces.length,
      github: { configured: Boolean(context.env.GITHUB_APP_ID && context.env.GITHUB_APP_PRIVATE_KEY && context.env.GITHUB_WEBHOOK_SECRET && context.env.SUPABASE_SERVICE_ROLE_KEY), installations } });
  } catch (error) { return teamError(error); }
});
app.put("/api/team/organizations/:organizationId/source-policy", async (context) => {
  return context.json({ error: "Source sharing is managed per workspace" }, 410);
});
app.get("/api/team/organizations/:organizationId/export", async (context) => {
  try {
    const user=await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const visibleWorkspaces=await dataApi(context.env,context.req.raw,
      `team_workspaces?select=id&organization_id=eq.${organizationId}&limit=201`) as Array<{id:string}>;
    if (visibleWorkspaces.length>200) return context.json({error:"Export exceeds workspace limit"},413);
    const allWorkspaces=await serviceDataApi(context.env,
      `team_workspaces?select=id&organization_id=eq.${organizationId}&limit=201`) as Array<{id:string}>;
    if (allWorkspaces.length>200) return context.json({error:"Export exceeds workspace limit"},413);
    if (allWorkspaces.some(workspace=>!visibleWorkspaces.some(visible=>visible.id===workspace.id)))
      return context.json({error:"Full export requires membership in every workspace"},403);
    const ids=visibleWorkspaces.map(workspace=>workspace.id);
    const boundProjects=ids.length?await dataApi(context.env,context.req.raw,
      `team_workspace_projects?select=workspace_id,project_key,provider_repository_id,repository&workspace_id=in.(${ids.join(",")})&limit=65`) as
      Array<{workspace_id:string;project_key:string;provider_repository_id:string|null;repository:string|null}>:[];
    if (boundProjects.length>64) return context.json({error:"Export exceeds project authorization limit"},413);
    const repositories=boundProjects.filter(project=>project.provider_repository_id&&project.repository);
    const allowedRepositoryIds=new Set<string>();
    if (repositories.length) {
      const githubUserToken=context.req.header("x-aipi-github-user-token");
      if (!context.env.GITHUB_APP_ID || !githubUserToken || githubUserToken.length<20 || githubUserToken.length>500)
        return context.json({error:"Current access to every bound repository is required for a full export"},403);
      const active=await dataApi(context.env,context.req.raw,
        `team_github_installations?select=installation_id&organization_id=eq.${organizationId}&active=eq.true&limit=21`) as
        Array<{installation_id:number}>;
      if (active.length>20) return context.json({error:"Export exceeds installation authorization limit"},413);
      for (const project of repositories) {
        let allowed=false;
        for (const installation of active) {
          try {
            const access=await verifyUserRepositoryAccess({installationId:Number(installation.installation_id),
              appId:context.env.GITHUB_APP_ID,repositoryId:project.provider_repository_id,userToken:githubUserToken});
            if (access.canRead && String(access.repository.full_name).toLowerCase()===project.repository?.toLowerCase() &&
                await hasLinkedGithubUser(context.env,context.req.raw,user.id!,access.userId)) {allowed=true;break;}
          } catch { /* A grant must be established from the current user token. */ }
        }
        if (!allowed) return context.json({error:"Current access to every bound repository is required for a full export"},403);
        allowedRepositoryIds.add(String(project.provider_repository_id));
      }
    }
    const [organizations, members, pilot, policy, subscriptions, usage, devices, snapshot, installations, producers, pullRequests, receipts] = await Promise.all([
      dataApi(context.env, context.req.raw, `organizations?select=id,name,owner_id,created_at&id=eq.${organizationId}&limit=1`),
      exportTable(context.env, context.req.raw, `organization_memberships?select=organization_id,user_id,role,created_at&organization_id=eq.${organizationId}&limit=1000`),
      dataApi(context.env, context.req.raw, `team_entitlements?select=*&organization_id=eq.${organizationId}&limit=1`),
      dataApi(context.env, context.req.raw, `team_source_policies?select=*&organization_id=eq.${organizationId}&limit=1`),
      exportTable(context.env, context.req.raw, `team_workspace_subscriptions?select=workspace_id,organization_id,plan,status,seat_limit,monthly_event_limit,trial_started_at,trial_ends_at,current_period_ends_at&organization_id=eq.${organizationId}&limit=201`),
      exportTable(context.env, context.req.raw, `team_usage_months?select=*&organization_id=eq.${organizationId}&limit=1000`),
      exportTable(context.env, context.req.raw, `team_devices?select=id,user_id,label,revoked_at,created_at,last_seen_at&organization_id=eq.${organizationId}&limit=1000`),
      dataApi(context.env, context.req.raw, "rpc/get_team_snapshot", { method: "POST", body: JSON.stringify({ p_organization_id: organizationId }) }),
      exportTable(context.env, context.req.raw, `team_github_installations?select=installation_id,account_login,active,connected_at&organization_id=eq.${organizationId}&limit=1000`),
      exportTable(context.env, context.req.raw, `team_ci_producers?select=app_id,name,environment,enabled&organization_id=eq.${organizationId}&limit=1000`),
      exportTable(context.env, context.req.raw, `team_pull_requests?select=*&organization_id=eq.${organizationId}&limit=1000`),
      serviceDataApi(context.env, `team_ci_receipts?select=*&organization_id=eq.${organizationId}&limit=1001`),
    ]) as [any[], any[], any[], any[], Array<{workspace_id:string}>, any[], any[], any, any[], any[], any[], any[]];
    if (!organizations.length) return context.json({ error: "Organization unavailable" }, 404);
    const workspaceIds = (snapshot.entities as Array<{ entityType: string; entityId: string }>).filter((entry) => entry.entityType === "workspace").map((entry) => entry.entityId);
    if (workspaceIds.length > 200) return context.json({ error: "Export exceeds workspace limit" }, 413);
    if (workspaceIds.some(id=>!ids.includes(id))) return context.json({error:"Workspace access changed during export; retry"},409);
    if (subscriptions.length !== ids.length || subscriptions.some(row=>!ids.includes(row.workspace_id)))
      return context.json({error:"Workspace trial data changed during export; retry"},409);
    if (receipts.length>1000) return context.json({error:"Export exceeds receipt limit"},413);
    const workspaceFilter = `workspace_id=in.(${workspaceIds.join(",")})`;
    const [graphNodes, graphEdges] = workspaceIds.length ? await Promise.all([
      serviceDataApi(context.env, `team_graph_nodes?select=*&${workspaceFilter}&limit=1001`),
      serviceDataApi(context.env, `team_graph_edges?select=*&${workspaceFilter}&limit=1001`),
    ]) as [any[], any[]] : [[], []];
    if (graphNodes.length>1000||graphEdges.length>1000) return context.json({error:"Export exceeds graph limit"},413);
    const knownProjects=new Set(boundProjects.map(project=>`${project.workspace_id}:${project.project_key}`));
    if (graphNodes.some(node=>!knownProjects.has(`${node.workspace_id}:${node.project_key}`)))
      return context.json({error:"Project access changed during export; retry"},409);
    const exportedNodeIds=new Set(graphNodes.map(node=>node.id));
    if (graphEdges.some(edge=>!exportedNodeIds.has(edge.from_node_id)||!exportedNodeIds.has(edge.to_node_id)))
      return context.json({error:"Graph references an unexportable node; review workspace integrity"},409);
    const scopedPrs=pullRequests.filter(pr=>allowedRepositoryIds.has(String(pr.provider_repository_id)));
    const scopedReceipts=receipts.filter(receipt=>allowedRepositoryIds.has(String(receipt.provider_repository_id)));
    const result = { format: "aipi-team-export-v1", exportedAt: new Date().toISOString(), organization: organizations[0],
      members, entitlement: pilot[0], sourcePolicy: policy[0], subscriptions, usage, devices, snapshot, graphNodes, graphEdges,
      installations, producers, pullRequests:scopedPrs, receipts:scopedReceipts };
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="aipi-team-${organizationId}.json"`, "cache-control": "no-store" } });
  } catch (error) { return teamError(error); }
});
app.delete("/api/team/organizations/:organizationId", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const { confirmName } = z.object({ confirmName: z.string().min(1).max(120) }).strict().parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw,
      `organizations?select=id,name,owner_id&id=eq.${organizationId}&limit=1`) as Array<{ id: string; name: string; owner_id: string }>;
    if (!rows.length || rows[0].owner_id !== user.id) return context.json({ error: "Organization owner required" }, 403);
    if (rows[0].name !== confirmName) return context.json({ error: "Organization name does not match" }, 400);
    const deleted = await dataApi(context.env, context.req.raw,
      `organizations?select=id&id=eq.${organizationId}&owner_id=eq.${user.id}`, {
        method: "DELETE", headers: { prefer: "return=representation" },
      }) as unknown[];
    if (!deleted.length) return context.json({ error: "Organization was not deleted" }, 409);
    return context.json({ deleted: true, organizationId });
  } catch (error) { return teamError(error); }
});

app.get("/api/team/organizations/:organizationId/workspaces", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const query = new URLSearchParams({ select: "id,organization_id,name,description,version,created_at,updated_at", organization_id: `eq.${organizationId}`, order: "created_at.asc", limit: "200" });
    const workspaces = await dataApi(context.env, context.req.raw, `team_workspaces?${query}`);
    return context.json({ workspaces });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/workspaces", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const input = teamWorkspaceInput.parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw, "team_workspaces?select=id,organization_id,name,description,version,created_at,updated_at", {
      method: "POST", headers: { prefer: "return=representation" },
      body: JSON.stringify({ ...(input.id?{id:input.id}:{}),organization_id: organizationId, created_by: user.id, name: input.name, description: input.description ?? null }),
    }) as unknown[];
    return context.json({ workspace: rows[0] }, 201);
  } catch (error) { return teamError(error); }
});
// Resolve portable project links only through rows visible to this user (RLS).
// A project can belong to several workspaces; never pick one arbitrarily.
app.get("/api/team/workspace-resolve/:key", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const key = context.req.param("key");
    let workspaceIds: string[];
    if (z.uuid().safeParse(key).success) workspaceIds = [key];
    else {
      z.string().regex(/^prj_[A-Za-z0-9_-]{4,100}$/).parse(key);
      const projects = await dataApi(context.env, context.req.raw,
        `team_workspace_projects?select=workspace_id&project_key=eq.${encodeURIComponent(key)}&limit=201`) as Array<{workspace_id:string}>;
      if (projects.length > 200) return context.json({error:"Choose a workspace from the launcher"}, 409);
      workspaceIds = [...new Set(projects.map(project => project.workspace_id))];
    }
    if (!workspaceIds.length) return context.json({error:"This project has not been shared to an accessible cloud workspace. Connect it from the local companion or IDE first."}, 404);
    const workspaces = await dataApi(context.env, context.req.raw,
      `team_workspaces?select=id,organization_id,name&id=in.(${workspaceIds.join(",")})&limit=201`) as Array<{id:string;organization_id:string;name:string}>;
    if (!workspaces.length) return context.json({error:"Workspace unavailable for this account"}, 404);
    if (workspaces.length !== 1) return context.json({error:"This project belongs to multiple workspaces. Choose one.",workspaces}, 409);
    return context.json({workspace:workspaces[0]});
  } catch (error) { return teamError(error); }
});
app.get("/api/team/workspaces/:workspaceId/identity", async context => {
  try {
    await authenticatedUser(context.env,context.req.raw);
    const workspaceId=z.uuid().parse(context.req.param("workspaceId"));
    const workspaces=await dataApi(context.env,context.req.raw,`team_workspaces?select=id,name,version&id=eq.${workspaceId}&limit=1`) as Record<string,unknown>[];
    if(!workspaces.length)return context.json({error:"Workspace unavailable"},404);
    const [projects,sources,repositories]=await Promise.all([
      dataApi(context.env,context.req.raw,`team_workspace_projects?select=project_key,display_name&workspace_id=eq.${workspaceId}&limit=201`),
      dataApi(context.env,context.req.raw,`team_source_bindings?select=*&workspace_id=eq.${workspaceId}&limit=501`),
      dataApi(context.env,context.req.raw,`team_workspace_repositories?select=*&workspace_id=eq.${workspaceId}&limit=201`),
    ]) as [Array<{project_key:string;display_name:string|null}>,Record<string,any>[],Record<string,any>[]];
    if(projects.length>200||sources.length>500||repositories.length>200)return context.json({error:"Identity view exceeds bounded size"},413);
    return context.json({identity:{schemaVersion:3,workspace:workspaces[0],aliases:sources.filter(source=>source.superseded_by).map(source=>({projectId:source.project_key,sourceId:source.source_id,canonicalSourceId:source.superseded_by})),projects:projects.map(project=>({id:project.project_key,name:project.display_name??project.project_key,
      sources:sources.filter(source=>source.project_key===project.project_key&&!source.superseded_by).map(source=>{const repo=repositories.find(repo=>repo.provider_repository_id===source.provider_repository_id);return {
        id:source.source_id,name:source.name,kind:source.kind,version:source.version,endpoint:source.external_endpoint,trackingBranch:source.tracking_branch,trackingCommit:source.tracking_commit,
        repository:repo?{provider:"github",providerRepositoryId:repo.provider_repository_id,remote:repo.remote_url,root:source.repository_root}:null};})}))}},200,{"cache-control":"no-store"});
  }catch(error){return teamError(error);}
});
app.put("/api/team/workspaces/:workspaceId/projects/:projectKey/sources/:sourceId",async context=>{
  try{
    const user=await authenticatedUser(context.env,context.req.raw);
    const workspaceId=z.uuid().parse(context.req.param("workspaceId"));
    const projectKey=teamProjectInput.shape.projectKey.parse(context.req.param("projectKey"));
    const sourceId=z.string().regex(/^src_[A-Za-z0-9_-]{8,100}$/).parse(context.req.param("sourceId"));
    const input=z.object({name:z.string().trim().min(1).max(120),kind:z.enum(["local","repository","external"]),
      repository:teamProjectInput.omit({projectKey:true}).optional(),endpoint:z.url().optional(),expectedVersion:z.number().int().positive().optional(),
      trackingBranch:z.string().min(1).max(240).optional(),githubUserToken:z.string().min(20).max(500).optional()}).strict().parse(await context.req.json());
    if((input.kind==="repository")!==Boolean(input.repository)||(input.kind==="external")!==Boolean(input.endpoint))return context.json({error:"Source kind and binding fields do not match"},400);
    if(input.trackingBranch&&!input.repository)return context.json({error:"Only repository sources track branches"},400);
    if(input.endpoint){const endpoint=new URL(input.endpoint);if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)return context.json({error:"Use a credential-free HTTPS endpoint without query or fragment"},400);}
    const workspaces=await dataApi(context.env,context.req.raw,`team_workspaces?select=organization_id&id=eq.${workspaceId}&limit=1`) as Array<{organization_id:string}>;
    if(!workspaces.length)return context.json({error:"Workspace unavailable"},404);
    let trackingCommit:string|null=null;
    if(input.repository){
      if(!input.githubUserToken||!context.env.GITHUB_APP_ID)return context.json({error:"Current GitHub user access is required"},403);
      if(new URL(input.repository.remoteUrl).pathname.slice(1).toLowerCase()!==input.repository.repository.toLowerCase())return context.json({error:"Repository URL and name differ"},400);
      const installations=await dataApi(context.env,context.req.raw,`team_github_installations?select=installation_id&organization_id=eq.${workspaces[0].organization_id}&active=eq.true&limit=100`) as Array<{installation_id:number}>;
      let allowed=false;
      for(const installation of installations){try{
        const access=await verifyUserRepositoryAccess({installationId:Number(installation.installation_id),appId:context.env.GITHUB_APP_ID,repositoryId:input.repository.providerRepositoryId,userToken:input.githubUserToken});
        if(access.canRead&&String(access.repository.full_name).toLowerCase()===input.repository.repository.toLowerCase()&&await hasLinkedGithubUser(context.env,context.req.raw,user.id!,access.userId)){allowed=true;break;}
      }catch{/* try another explicitly connected installation */}}
      if(!allowed)return context.json({error:"Current repository and installation access are required"},403);
    }
    if(input.repository&&input.trackingBranch){
      const branch=await githubRepositoryRequest(`/repos/${input.repository.repository.split('/').map(encodeURIComponent).join('/')}/branches/${encodeURIComponent(input.trackingBranch)}`,input.githubUserToken!) as {commit?:{sha?:string}};
      if(!branch.commit?.sha||!/^[a-f0-9]{40}$/.test(branch.commit.sha))return context.json({error:"Choose an existing GitHub branch"},400);
      trackingCommit=branch.commit.sha;
      if(input.repository.repositoryRoot!=="."){
        const directory=await githubRepositoryRequest(`/repos/${input.repository.repository.split('/').map(encodeURIComponent).join('/')}/contents/${input.repository.repositoryRoot.split('/').map(encodeURIComponent).join('/')}?ref=${trackingCommit}`,input.githubUserToken!);
        if(!Array.isArray(directory))return context.json({error:"The project directory does not exist on this branch"},400);
      }
    }
    const source=await serviceDataApi(context.env,"rpc/save_team_source",{method:"POST",body:JSON.stringify({p_actor_id:user.id,p_workspace_id:workspaceId,p_project_key:projectKey,p_source_id:sourceId,
      p_name:input.name,p_kind:input.kind,p_provider_repository_id:input.repository?.providerRepositoryId??null,p_repository:input.repository?.repository??null,
      p_remote_url:input.repository?.remoteUrl??null,p_repository_root:input.repository?.repositoryRoot??".",p_external_endpoint:input.endpoint??null,p_expected_version:input.expectedVersion??null,p_tracking_branch:input.trackingBranch??null,p_tracking_commit:trackingCommit})});
    return context.json({source});
  }catch(error){return teamError(error);}
});
app.post("/api/team/workspaces/:workspaceId/repository-options",async context=>{
 try{
  const user=await authenticatedUser(context.env,context.req.raw);
  const workspaceId=z.uuid().parse(context.req.param("workspaceId"));
  const input=z.object({repositoryId:teamProjectInput.shape.providerRepositoryId,githubUserToken:z.string().min(20).max(500)}).strict().parse(await context.req.json());
  const workspaces=await dataApi(context.env,context.req.raw,`team_workspaces?select=organization_id&id=eq.${workspaceId}&limit=1`) as Array<{organization_id:string}>;
  if(!workspaces.length)return context.json({error:"Workspace unavailable"},404);
  const installations=await dataApi(context.env,context.req.raw,`team_github_installations?select=installation_id&organization_id=eq.${workspaces[0].organization_id}&active=eq.true&limit=100`) as Array<{installation_id:number}>;
  for(const installation of installations){
   let access;try{access=await verifyUserRepositoryAccess({installationId:Number(installation.installation_id),appId:context.env.GITHUB_APP_ID!,repositoryId:input.repositoryId,userToken:input.githubUserToken});}catch{continue;}
   if(!access.canRead||!await hasLinkedGithubUser(context.env,context.req.raw,user.id!,access.userId))continue;
   const repo=access.repository.full_name.split('/').map(encodeURIComponent).join('/');
   const branches=await githubRepositoryRequest(`/repos/${repo}/branches?per_page=100`,input.githubUserToken) as Array<{name:string;commit:{sha:string}}>;
   if(!Array.isArray(branches))return context.json({error:"GitHub branches unavailable"},502);
   return context.json({defaultBranch:access.repository.default_branch??"main",branches:branches.map(branch=>({name:branch.name,commit:branch.commit.sha})),hasMore:branches.length===100},200,{"cache-control":"no-store"});
  }
  return context.json({error:"Current repository and App access are required"},403);
 }catch(error){return teamError(error);}
});
app.get("/api/team/workspaces/:workspaceId/projects", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const query = new URLSearchParams({ select: "workspace_id,project_key,display_name,provider,provider_repository_id,repository,remote_url,repository_root,version", workspace_id: `eq.${workspaceId}`, order: "project_key.asc", limit: "200" });
    const projects = await dataApi(context.env, context.req.raw, `team_workspace_projects?${query}`);
    return context.json({ projects });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/workspaces/:workspaceId/release-compatibility", async (context) => {
  try {
    const user=await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    await assertReadableTeamWorkspace(context.env, context.req.raw, workspaceId);
    const projectId = context.req.query("projectId") ?? "";
    const environmentId = context.req.query("environmentId") ?? "";
    if (projectId.length > 160 || environmentId.length > 160) return context.json({ error: "Invalid compatibility scope" }, 400);
    if (projectId) {
      const query = new URLSearchParams({ select: "project_key", workspace_id: `eq.${workspaceId}`, project_key: `eq.${projectId}`, limit: "1" });
      const projects = await dataApi(context.env, context.req.raw, `team_workspace_projects?${query}`) as unknown[];
      if (projects.length !== 1) return context.json({ error: "Project unavailable" }, 404);
    }
    const githubUserToken=context.req.header('x-aipi-github-user-token')??'';
    const observations=[];
    if(environmentId && githubUserToken){
      const cohorts=await serviceDataApi(context.env,
        `team_deployment_cohorts?select=cohort_id,project_key,source_id,revision_commit,artifact_digest,observed_at&workspace_id=eq.${workspaceId}&environment_id=eq.${encodeURIComponent(environmentId)}&active=eq.true&limit=101`) as
        Array<{cohort_id:string;project_key:string;source_id:string;revision_commit:string;artifact_digest:string;observed_at:string}>;
      if(cohorts.length>100)return context.json({error:'Deployment cohorts exceed bounded preview size'},413);
      const allowed=new Map<string,boolean>();
      for(const record of cohorts){
        if(!allowed.has(record.source_id)){
          try{await authorizedFactSource(context.env,context.req.raw,workspaceId,record.source_id,user.id!,githubUserToken);
            allowed.set(record.source_id,true);}
          catch{allowed.set(record.source_id,false);}
        }
        if(!allowed.get(record.source_id))continue;
        observations.push({environmentId,projectId:record.project_key,sourceBindingId:record.source_id,
          revision:record.revision_commit,artifactDigest:record.artifact_digest,cohort:'deployed',
          cohortId:record.cohort_id,observedAt:record.observed_at,controllerAuthenticated:true});
      }
    }
    const releaseCompatibility = evaluateReleaseCompatibility({ workspaceId, environmentId: environmentId || null,
      candidate: { projectId: projectId || null }, dependencies: [], observations, proofs: [],
      discoveryComplete: false, acceptObservation: (record:{controllerAuthenticated?:boolean})=>record.controllerAuthenticated===true,
      acceptProof: () => false });
    return context.json({ releaseCompatibility }, 200, { "cache-control": "no-store" });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/workspaces/:workspaceId/subscription", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const [subscriptions, usage] = await Promise.all([
      dataApi(context.env, context.req.raw,
        `team_workspace_subscriptions?select=workspace_id,plan,status,seat_limit,monthly_event_limit,trial_ends_at,current_period_ends_at&workspace_id=eq.${workspaceId}&limit=1`),
      dataApi(context.env, context.req.raw,
        `team_workspace_usage_months?select=month_start,accepted_events&workspace_id=eq.${workspaceId}&order=month_start.desc&limit=1`),
    ]) as [Record<string, unknown>[], Record<string, unknown>[]];
    if (!subscriptions.length) return context.json({ error: "Workspace subscription unavailable" }, 404);
    return context.json({ subscription: subscriptions[0], usage: usage[0] ?? { accepted_events: 0 } });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/workspaces/:workspaceId/members", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const members = await dataApi(context.env, context.req.raw,
      `team_workspace_memberships?select=user_id,role,created_at&workspace_id=eq.${workspaceId}&order=created_at.asc&limit=200`);
    return context.json({ members });
  } catch (error) { return teamError(error); }
});
app.delete("/api/team/workspaces/:workspaceId/members/:userId", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const targetId = z.uuid().parse(context.req.param("userId"));
    await dataApi(context.env, context.req.raw, "rpc/remove_team_workspace_member", { method: "POST",
      body: JSON.stringify({ p_workspace_id: workspaceId, p_user_id: targetId }) });
    return context.json({ removed: true, userId: targetId });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/workspaces/:workspaceId/source-policy", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const rows = await dataApi(context.env, context.req.raw,
      `team_workspace_source_policies?select=workspace_id,sharing_mode,updated_at&workspace_id=eq.${workspaceId}&limit=1`) as unknown[];
    if (!rows.length) return context.json({ error: "Workspace source policy unavailable" }, 404);
    return context.json({ sourcePolicy: rows[0] });
  } catch (error) { return teamError(error); }
});
app.put("/api/team/workspaces/:workspaceId/source-policy", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const { sharingMode } = z.object({ sharingMode: z.enum(["metadata_only","snippets","full_source"]) }).strict().parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw,
      `team_workspace_source_policies?workspace_id=eq.${workspaceId}&select=workspace_id,sharing_mode,updated_at`, {
        method: "PATCH", headers: { prefer: "return=representation" },
        body: JSON.stringify({ sharing_mode: sharingMode, updated_by: user.id, updated_at: new Date().toISOString() }),
      }) as unknown[];
    if (!rows.length) return context.json({ error: "Workspace owner or admin required" }, 403);
    return context.json({ sourcePolicy: rows[0] });
  } catch (error) { return teamError(error); }
});
app.put("/api/team/workspaces/:workspaceId/projects/:projectKey", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const projectKey = context.req.param("projectKey");
    const body = await context.req.json();
    const unbound = Object.keys(body).every(key=>key==="name");
    const unboundInput = unbound ? teamUnboundProjectInput.parse({ projectKey,...body }) : null;
    const { githubUserToken, ...projectBody } = body;
    const boundInput = unbound ? null : teamProjectInput.parse({ ...projectBody, projectKey });
    if (boundInput && boundInput.repository.toLowerCase() !== new URL(boundInput.remoteUrl).pathname.slice(1).toLowerCase()) {
      return context.json({ error: "Repository name must match the GitHub URL" }, 400);
    }
    if (boundInput) {
      if (!context.env.GITHUB_APP_ID) return context.json({ error: "GitHub App is not configured" }, 503);
      z.string().min(20).max(500).parse(githubUserToken);
      const workspaces = await dataApi(context.env, context.req.raw,
        `team_workspaces?select=organization_id&id=eq.${workspaceId}&limit=1`) as Array<{organization_id:string}>;
      if (!workspaces.length) return context.json({ error: "Workspace unavailable" }, 404);
      const organizationId = workspaces[0].organization_id;
      const members = await dataApi(context.env, context.req.raw,
        `team_workspace_memberships?select=role&workspace_id=eq.${workspaceId}&user_id=eq.${user.id}&limit=1`) as Array<{role:string}>;
      if (!members.length || !["owner","admin","developer"].includes(members[0].role))
        return context.json({ error: "Workspace write access is required" }, 403);
      const installations = await dataApi(context.env, context.req.raw,
        `team_github_installations?select=installation_id&organization_id=eq.${organizationId}&active=eq.true&limit=100`) as Array<{installation_id:number}>;
      let authorized = false;
      for (const installation of installations) {
        try {
          const access = await verifyUserRepositoryAccess({ installationId: Number(installation.installation_id),
            appId: context.env.GITHUB_APP_ID, repositoryId: boundInput.providerRepositoryId, userToken: githubUserToken });
          if (access.canRead && String(access.repository.full_name).toLowerCase() === boundInput.repository.toLowerCase() &&
              await hasLinkedGithubUser(context.env, context.req.raw, user.id!, access.userId)) { authorized = true; break; }
        } catch { /* Another installation may have the repository. */ }
      }
      if (!authorized) return context.json({ error: "Verified GitHub user and installation access is required" }, 403);
      const project = await serviceDataApi(context.env, "rpc/bind_team_repository_project", {
        method: "POST", body: JSON.stringify({ p_actor_id: user.id, p_workspace_id: workspaceId,
          p_project_key: boundInput.projectKey, p_provider_repository_id: boundInput.providerRepositoryId,
          p_repository: boundInput.repository, p_remote_url: boundInput.remoteUrl,
          p_repository_root: boundInput.repositoryRoot }),
      });
      return context.json({ project });
    }
    const rows = await dataApi(context.env, context.req.raw, "team_workspace_projects?on_conflict=workspace_id,project_key", {
      method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ workspace_id: workspaceId, project_key: unboundInput!.projectKey,display_name:unboundInput!.name??null }),
    }) as unknown[];
    return context.json({ project: rows[0] ?? null });
  } catch (error) { return teamError(error); }
});
async function assertLegacyGraphSourceScope(env:Env,request:Request,workspaceId:string,projectKeys:Set<string>){
  if(!projectKeys.size)return;
  const sources=await dataApi(env,request,`team_source_bindings?select=project_key,kind,provider_repository_id&workspace_id=eq.${workspaceId}&superseded_by=is.null&limit=501`) as Array<{project_key:string;kind:string;provider_repository_id:string|null}>;
  if(sources.length>500)throw new SupabaseDataError(413,"Workspace source registry exceeds graph assessment bounds");
  for(const projectKey of projectKeys){const bindings=sources.filter(source=>source.project_key===projectKey);
    if(bindings.length>1)throw new SupabaseDataError(409,"This project has multiple source bindings. Source-aware graph synchronization is required before assessing its changes.");
  }
}
async function scopedTeamGraph(env: Env, request: Request, workspaceId: string, userId: string,
  nodes: Record<string, unknown>[], edges: Record<string, unknown>[], githubUserToken?: string) {
  const graphProjects = new Set(nodes.map(node=>String(node.project_key)));
  await assertLegacyGraphSourceScope(env,request,workspaceId,graphProjects);
  if (graphProjects.size>32) throw new SupabaseDataError(413,"Graph projects exceed bounded repository authorization size");
  const projects = await dataApi(env,request,
    `team_workspace_projects?select=project_key,provider_repository_id,repository&workspace_id=eq.${workspaceId}&limit=201`) as
      Array<{project_key:string;provider_repository_id:string|null;repository:string|null}>;
  if (projects.length>200) throw new SupabaseDataError(413,"Workspace projects exceed bounded repository authorization size");
  const readableProjects = new Set(projects.filter(project=>!project.provider_repository_id && graphProjects.has(project.project_key))
    .map(project=>project.project_key));
  if (githubUserToken && env.GITHUB_APP_ID) {
    const workspaces = await dataApi(env,request,`team_workspaces?select=organization_id&id=eq.${workspaceId}&limit=1`) as
      Array<{organization_id:string}>;
    if (!workspaces.length) throw new SupabaseDataError(404,"Workspace unavailable");
    const installations = await dataApi(env,request,
      `team_github_installations?select=installation_id&organization_id=eq.${workspaces[0].organization_id}&active=eq.true&limit=21`) as
      Array<{installation_id:number}>;
    if (installations.length>20) throw new SupabaseDataError(413,"GitHub installations exceed bounded authorization size");
    for (const project of projects) {
      if (!graphProjects.has(project.project_key) || !project.provider_repository_id || !project.repository) continue;
      for (const installation of installations) {
        try {
          const access = await verifyUserRepositoryAccess({installationId:Number(installation.installation_id),
            appId:env.GITHUB_APP_ID,repositoryId:project.provider_repository_id,userToken:githubUserToken});
          if (access.canRead && String(access.repository.full_name).toLowerCase()===project.repository.toLowerCase() &&
              await hasLinkedGithubUser(env,request,userId,access.userId)) { readableProjects.add(project.project_key); break; }
        } catch { /* Current grant not established; omit this project. */ }
      }
    }
  }
  return scopeTeamAssessmentGraph({nodes,edges,readableProjects});
}
async function assertReadableTeamWorkspace(env: Env, request: Request, workspaceId: string) {
  const rows = await dataApi(env,request,`team_workspaces?select=id&id=eq.${workspaceId}&limit=1`) as unknown[];
  if (rows.length!==1) throw new SupabaseDataError(404,"Workspace unavailable");
}
async function authorizedFactSource(env:Env,request:Request,workspaceId:string,sourceId:string,userId:string,userToken:string,write=false){
  await assertReadableTeamWorkspace(env,request,workspaceId);
  if(!env.GITHUB_APP_ID || !userToken || userToken.length<20 || userToken.length>500)
    throw new SupabaseDataError(403,"Current GitHub repository access is required");
  const sources=await dataApi(env,request,
    `team_source_bindings?select=project_key,provider_repository_id,repository_root,kind&workspace_id=eq.${workspaceId}&source_id=eq.${sourceId}&superseded_by=is.null&limit=1`) as
      Array<{project_key:string;provider_repository_id:string|null;repository_root:string;kind:string}>;
  const source=sources[0];
  if(!source || source.kind!=="repository" || !source.provider_repository_id)
    throw new SupabaseDataError(404,"Repository source unavailable");
  const [repositories,workspaces]=await Promise.all([
    dataApi(env,request,`team_workspace_repositories?select=repository&workspace_id=eq.${workspaceId}&provider_repository_id=eq.${source.provider_repository_id}&limit=1`),
    dataApi(env,request,`team_workspaces?select=organization_id&id=eq.${workspaceId}&limit=1`),
  ]) as [Array<{repository:string}>,Array<{organization_id:string}>];
  if(!repositories[0] || !workspaces[0])throw new SupabaseDataError(404,"Repository identity unavailable");
  if(write){
    const [workspaceRoles,organizationRoles]=await Promise.all([
      dataApi(env,request,`team_workspace_memberships?select=role&workspace_id=eq.${workspaceId}&user_id=eq.${userId}&limit=1`),
      dataApi(env,request,`organization_memberships?select=role&organization_id=eq.${workspaces[0].organization_id}&user_id=eq.${userId}&limit=1`),
    ]) as [Array<{role:string}>,Array<{role:string}>];
    if(!['owner','admin','developer'].includes(workspaceRoles[0]?.role) ||
       !['owner','admin','developer'].includes(organizationRoles[0]?.role))
      throw new SupabaseDataError(403,'Workspace and organization write access is required');
  }
  const installations=await dataApi(env,request,
    `team_github_installations?select=installation_id&organization_id=eq.${workspaces[0].organization_id}&active=eq.true&limit=21`) as Array<{installation_id:number}>;
  if(installations.length>20)throw new SupabaseDataError(413,"GitHub installations exceed authorization bounds");
  let authorized=false;
  for(const installation of installations){
    try{const grant=await verifyUserRepositoryAccess({installationId:Number(installation.installation_id),
      appId:env.GITHUB_APP_ID,repositoryId:source.provider_repository_id,userToken});
      if((write?grant.canWrite:grant.canRead) && String(grant.repository.full_name).toLowerCase()===repositories[0].repository.toLowerCase() &&
        await hasLinkedGithubUser(env,request,userId,grant.userId)){authorized=true;break;}
    }catch{/* Another installation may have the source. */}
  }
  if(!authorized)throw new SupabaseDataError(403,"Current GitHub repository access is required");
  return {...source,repository:repositories[0].repository};
}
app.post("/api/team/workspaces/:workspaceId/sources/:sourceId/facts/index",async context=>{
  try{
    const user=await authenticatedUser(context.env,context.req.raw);
    const workspaceId=z.uuid().parse(context.req.param("workspaceId"));
    const sourceId=z.string().regex(/^src_[A-Za-z0-9_-]{8,100}$/).parse(context.req.param("sourceId"));
    const input=z.object({githubUserToken:z.string().min(20).max(500),revision:z.string().regex(/^[0-9a-f]{40}$/),
      path:z.string().min(1).max(500),kind:z.enum(['openapi','generated_client']).default('openapi')}).strict().parse(await context.req.json());
    if(input.path.split("/").some(part=>!part||part==="."||part==="..") || /[\\\u0000-\u001f]/.test(input.path))
      return context.json({error:"A safe repository-relative path is required"},400);
    const source=await authorizedFactSource(context.env,context.req.raw,workspaceId,sourceId,user.id!,input.githubUserToken,true);
    const repository=source.repository.split("/").map(encodeURIComponent).join("/");
    const fullPath=(source.repository_root==="."?input.path:`${source.repository_root}/${input.path}`)
      .split("/").map(encodeURIComponent).join("/");
    const file=await githubRepositoryRequest(`/repos/${repository}/contents/${fullPath}?ref=${input.revision}`,
      input.githubUserToken) as {type?:string;size?:number;encoding?:string;content?:string};
    if(file.type!=="file"||!Number.isSafeInteger(file.size)||file.size!>200_000||file.encoding!=="base64"||!file.content)
      return context.json({error:"Bounded OpenAPI source unavailable"},422);
    const bytes=Uint8Array.from(atob(file.content.replace(/\s/g,"")),character=>character.charCodeAt(0));
    if(bytes.byteLength>200_000)return context.json({error:"OpenAPI source exceeds limit"},413);
    const content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    let fact;
    if(input.kind==='generated_client'){
      let manifest;
      try{manifest=JSON.parse(content);}catch{return context.json({error:"Generated-client manifest is invalid JSON"},422);}
      const fileList=manifest?.generatedFiles;
      if(!Array.isArray(fileList)||!fileList.length||fileList.length>20)
        return context.json({error:"Generated-client manifest file list is invalid"},422);
      const generatedFiles=[];
      for(const item of fileList){
        const relative=item?.path;
        if(typeof relative!=="string"||relative.length>500||relative.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\u0000-\u001f]/.test(relative))
          return context.json({error:"Generated-client manifest has an unsafe path"},422);
        const generatedPath=(source.repository_root==='.'?relative:`${source.repository_root}/${relative}`)
          .split('/').map(encodeURIComponent).join('/');
        const generated=await githubRepositoryRequest(`/repos/${repository}/contents/${generatedPath}?ref=${input.revision}`,
          input.githubUserToken) as {type?:string;size?:number;encoding?:string;content?:string};
        if(generated.type!=="file"||!Number.isSafeInteger(generated.size)||generated.size!>50_000||generated.encoding!=="base64"||!generated.content)
          return context.json({error:"Generated-client file unavailable or too large"},422);
        const fileBytes=Uint8Array.from(atob(generated.content.replace(/\s/g,'')),character=>character.charCodeAt(0));
        if(fileBytes.byteLength>50_000)return context.json({error:"Generated-client file exceeds limit"},413);
        generatedFiles.push({path:relative,content:new TextDecoder('utf-8',{fatal:true}).decode(fileBytes)});
      }
      fact=extractGeneratedClientFacts({workspaceId,projectKey:source.project_key,sourceBindingId:sourceId,
        revision:input.revision,path:input.path,content,files:generatedFiles});
    }else fact=extractOpenApiSourceFacts({workspaceId,projectKey:source.project_key,sourceBindingId:sourceId,
      revision:input.revision,path:input.path,content});
    const key=`workspace_id=eq.${workspaceId}&source_id=eq.${sourceId}&revision_commit=eq.${input.revision}&path=eq.${encodeURIComponent(input.path)}&analyzer_version=eq.${fact.analyzerVersion}`;
    const existing=await serviceDataApi(context.env,`team_source_fact_partitions?select=content_hash,fact_hash&${key}`) as Array<{content_hash:string;fact_hash:string}>;
    if(existing.length && (existing[0].content_hash!==fact.contentHash||existing[0].fact_hash!==fact.factHash))
      return context.json({error:"Immutable fact partition conflicts with this source revision"},409);
    if(!existing.length)await serviceDataApi(context.env,"team_source_fact_partitions",{method:"POST",body:JSON.stringify({
      workspace_id:workspaceId,project_key:source.project_key,source_id:sourceId,revision_commit:input.revision,
      path:input.path,analyzer_version:fact.analyzerVersion,content_hash:fact.contentHash,fact_hash:fact.factHash,facts:fact.facts})});
    return context.json({partition:fact},200,{"cache-control":"no-store"});
  }catch(error){return teamError(error);}
});
app.post("/api/team/workspaces/:workspaceId/sources/:sourceId/facts/list",async context=>{
  try{
    const user=await authenticatedUser(context.env,context.req.raw);
    const workspaceId=z.uuid().parse(context.req.param("workspaceId"));
    const sourceId=z.string().regex(/^src_[A-Za-z0-9_-]{8,100}$/).parse(context.req.param("sourceId"));
    const input=z.object({githubUserToken:z.string().min(20).max(500),revision:z.string().regex(/^[0-9a-f]{40}$/)}).strict().parse(await context.req.json());
    await authorizedFactSource(context.env,context.req.raw,workspaceId,sourceId,user.id!,input.githubUserToken);
    const rows=await serviceDataApi(context.env,
      `team_source_fact_partitions?select=project_key,source_id,revision_commit,path,analyzer_version,content_hash,fact_hash,facts,indexed_at&workspace_id=eq.${workspaceId}&source_id=eq.${sourceId}&revision_commit=eq.${input.revision}&limit=201`) as unknown[];
    if(rows.length>200)return context.json({error:"Source fact result exceeds limit"},413);
    return context.json({partitions:rows},200,{"cache-control":"no-store"});
  }catch(error){return teamError(error);}
});
app.post("/api/team/workspaces/:workspaceId/sources/:sourceId/facts/discover",async context=>{
  try{
    const user=await authenticatedUser(context.env,context.req.raw);
    const workspaceId=z.uuid().parse(context.req.param('workspaceId'));
    const sourceId=z.string().regex(/^src_[A-Za-z0-9_-]{8,100}$/).parse(context.req.param('sourceId'));
    const input=z.object({githubUserToken:z.string().min(20).max(500),revision:z.string().regex(/^[0-9a-f]{40}$/),
      path:z.string().min(1).max(500)}).strict().parse(await context.req.json());
    await authorizedFactSource(context.env,context.req.raw,workspaceId,sourceId,user.id!,input.githubUserToken);
    const rows=await serviceDataApi(context.env,
      `team_source_fact_partitions?select=project_key,source_id,revision_commit,path,analyzer_version,content_hash,fact_hash,facts&workspace_id=eq.${workspaceId}&source_id=eq.${sourceId}&revision_commit=eq.${input.revision}&path=eq.${encodeURIComponent(input.path)}&analyzer_version=eq.openapi-json-v1&limit=1`) as Array<Record<string,any>>;
    if(!rows.length)return context.json({error:'Pinned producer fact partition is not indexed'},404);
    const producer={workspaceId,projectKey:rows[0].project_key,sourceBindingId:sourceId,revision:input.revision,
      path:input.path,contentHash:rows[0].content_hash,facts:rows[0].facts};
    const sources=await dataApi(context.env,context.req.raw,
      `team_source_bindings?select=source_id&workspace_id=eq.${workspaceId}&kind=eq.repository&superseded_by=is.null&limit=33`) as Array<{source_id:string}>;
    if(sources.length>32)return context.json({error:'Workspace exceeds bounded consumer discovery scope'},413);
    const clients=[];
    for(const source of sources){
      if(source.source_id===sourceId)continue;
      try{await authorizedFactSource(context.env,context.req.raw,workspaceId,source.source_id,user.id!,input.githubUserToken);}
      catch{continue;}
      const partitions=await serviceDataApi(context.env,
        `team_source_fact_partitions?select=project_key,source_id,revision_commit,path,content_hash,fact_hash,facts&workspace_id=eq.${workspaceId}&source_id=eq.${source.source_id}&analyzer_version=eq.generated-client-v1&limit=101`) as Array<Record<string,any>>;
      if(partitions.length>100)return context.json({error:'Consumer fact partition result exceeds bound'},413);
      for(const row of partitions)clients.push({workspaceId,projectKey:row.project_key,sourceBindingId:row.source_id,
        revision:row.revision_commit,path:row.path,contentHash:row.content_hash,factHash:row.fact_hash,facts:row.facts});
    }
    const candidates=discoverPinnedGeneratedConsumers(producer,clients);
    return context.json({candidates,discoveryComplete:false,
      reason:'Indexed generated-client manifests are candidate links; unindexed or inaccessible sources may contain additional consumers.'},
      200,{'cache-control':'no-store'});
  }catch(error){return teamError(error);}
});
app.get("/api/team/workspaces/:workspaceId/graph", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const githubUserToken = context.req.header("x-aipi-github-user-token");
    if (githubUserToken && (githubUserToken.length<20 || githubUserToken.length>500))
      return context.json({error:"Invalid GitHub user token"},400);
    await assertReadableTeamWorkspace(context.env,context.req.raw,workspaceId);
    const [nodes, edges] = await Promise.all([
      serviceDataApi(context.env,
        `team_graph_nodes?select=id,project_key,node_key,kind,label,source_ref,revision_commit,updated_at&workspace_id=eq.${workspaceId}&order=updated_at.desc&limit=501`),
      serviceDataApi(context.env,
        `team_graph_edges?select=id,from_node_id,to_node_id,relation,evidence_kind,evidence_key,confirmation_state,version,revision_set,source_refs,required_checks&workspace_id=eq.${workspaceId}&limit=1001`),
    ]);
    if ((nodes as unknown[]).length > 500 || (edges as unknown[]).length > 1000)
      return context.json({ error: "Workspace graph exceeds the current view limit" }, 413);
    const scoped = await scopedTeamGraph(context.env,context.req.raw,workspaceId,user.id!,
      nodes as Record<string,unknown>[],edges as Record<string,unknown>[],githubUserToken);
    return context.json(scoped,200,{"cache-control":"no-store"});
  } catch (error) { return teamError(error); }
});
app.post("/api/team/workspaces/:workspaceId/projects/:projectKey/source", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    if (!context.env.GITHUB_APP_ID) return context.json({ error: "GitHub App is not configured" }, 503);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const projectKey = graphNodeInput.shape.projectKey.parse(context.req.param("projectKey"));
    const input = z.object({ githubUserToken: z.string().min(20).max(500),
      commit: z.string().regex(/^[0-9a-f]{40}$/), path: z.string().min(1).max(500), sourceBindingId:z.string().regex(/^src_[A-Za-z0-9_-]{8,100}$/).optional() }).strict().parse(await context.req.json());
    if (input.path.split("/").some((part) => !part || part === "." || part === "..") || /[\\\u0000-\u001f]/.test(input.path))
      return context.json({ error: "A safe repository-relative file path is required" }, 400);
    let resolvedSourceId=input.sourceBindingId;
    if(resolvedSourceId){const aliases=await dataApi(context.env,context.req.raw,`team_source_bindings?select=superseded_by&workspace_id=eq.${workspaceId}&project_key=eq.${projectKey}&source_id=eq.${resolvedSourceId}&limit=1`) as Array<{superseded_by:string|null}>;resolvedSourceId=aliases[0]?.superseded_by??resolvedSourceId;}
    const sources=await dataApi(context.env,context.req.raw,`team_source_bindings?select=source_id,provider_repository_id,repository_root&superseded_by=is.null&workspace_id=eq.${workspaceId}&project_key=eq.${projectKey}&kind=eq.repository${resolvedSourceId?`&source_id=eq.${resolvedSourceId}`:""}&limit=2`) as Array<{source_id:string;provider_repository_id:string;repository_root:string}>;
    if(sources.length!==1)return context.json({error:sources.length?"Choose a source binding for this project":"Repository source unavailable"},sources.length?409:404);
    const rows=await dataApi(context.env,context.req.raw,`team_workspace_repositories?select=provider_repository_id,repository&workspace_id=eq.${workspaceId}&provider_repository_id=eq.${sources[0].provider_repository_id}&limit=1`) as Array<{provider_repository_id:string;repository:string}>;
    if(!rows.length)return context.json({error:"Repository identity unavailable"},404);
    const workspaceRows = await dataApi(context.env, context.req.raw,
      `team_workspaces?select=organization_id&id=eq.${workspaceId}&limit=1`) as Array<{organization_id:string}>;
    if (!workspaceRows.length) return context.json({ error: "Workspace unavailable" }, 404);
    const installations = await dataApi(context.env, context.req.raw,
      `team_github_installations?select=installation_id&organization_id=eq.${workspaceRows[0].organization_id}&active=eq.true&limit=100`) as Array<{installation_id:number}>;
    let authorized = false;
    for (const installation of installations) {
      try {
        const access = await verifyUserRepositoryAccess({ installationId: Number(installation.installation_id),
          appId: context.env.GITHUB_APP_ID, repositoryId: rows[0].provider_repository_id, userToken: input.githubUserToken });
        if (!access.canRead || String(access.repository.full_name).toLowerCase() !== rows[0].repository.toLowerCase()) continue;
        if (!await hasLinkedGithubUser(context.env, context.req.raw, user.id!, access.userId))
          return context.json({ error: "Link this GitHub identity to your AIPI account" }, 403);
        authorized = true; break;
      } catch { /* A different installation may contain the repository. */ }
    }
    if (!authorized) return context.json({ error: "Current GitHub repository access is required" }, 403);
    const repository = rows[0].repository.split("/").map(encodeURIComponent).join("/");
    const path = (sources[0].repository_root === "." ? input.path : `${sources[0].repository_root}/${input.path}`).split("/").map(encodeURIComponent).join("/");
    const file = await githubRepositoryRequest(`/repos/${repository}/contents/${path}?ref=${input.commit}`,
      input.githubUserToken) as {type?:string;size?:number;encoding?:string;content?:string;sha?:string};
    if (file.type !== "file" || !Number.isSafeInteger(file.size) || file.size! > 200_000 || file.encoding !== "base64" || !file.content)
      return context.json({ status: "unavailable", reason: "Binary, large, or non-file content is not available in this view" });
    const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), (character) => character.charCodeAt(0));
    if (bytes.byteLength > 200_000) return context.json({ status: "unavailable", reason: "File exceeds the source view limit" });
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return context.json({ status: "unavailable", reason: "Binary content is not available in this view" }); }
    return context.json({ status: "available", projectKey, sourceBindingId:sources[0].source_id, path: input.path, commit: input.commit, blobSha: file.sha, content });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/workspaces/:workspaceId/graph/publish", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const input = graphBatchInput.parse(await context.req.json());
    await assertReadableTeamWorkspace(context.env,context.req.raw,workspaceId);
    const githubUserToken=context.req.header("x-aipi-github-user-token");
    const projectKeys=[...new Set([...input.nodes.map(node=>node.projectKey),
      ...input.edges.flatMap(edge=>[edge.fromProjectKey,edge.toProjectKey])])];
    if (projectKeys.length>32) return context.json({error:"Graph batch spans too many projects"},413);
    const candidateNodes=projectKeys.map((projectKey,index)=>({id:`candidate-${index}`,project_key:projectKey}));
    const scoped=await scopedTeamGraph(context.env,context.req.raw,workspaceId,user.id!,candidateNodes,[],githubUserToken);
    if (scoped.restrictedScope) return context.json({error:"Current repository access is required for every graph project"},403);
    const published = await serviceDataApi(context.env, "rpc/broker_publish_team_graph", {
      method: "POST", body: JSON.stringify({ p_actor_id:user.id,p_workspace_id:workspaceId,
        p_nodes: input.nodes, p_edges: input.edges }),
    });
    return context.json({ published });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/workspaces/:workspaceId/graph/edges/:edgeId/review", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const edgeId = z.uuid().parse(context.req.param("edgeId"));
    const input = z.object({ schemaVersion: z.literal(1), operationId: z.uuid(), deviceId: z.uuid(),
      baseVersion: z.number().int().positive(), confirm: z.boolean() }).strict().parse(await context.req.json());
    await assertReadableTeamWorkspace(context.env,context.req.raw,workspaceId);
    const matching = await serviceDataApi(context.env,
      `team_graph_edges?select=id,from_node_id,to_node_id&workspace_id=eq.${workspaceId}&id=eq.${edgeId}&limit=1`) as
      Array<{id:string;from_node_id:string;to_node_id:string}>;
    if (!matching.length) return context.json({ error: "Graph edge is not in this workspace" }, 404);
    const endpoints=await serviceDataApi(context.env,
      `team_graph_nodes?select=id,project_key&workspace_id=eq.${workspaceId}&id=in.(${matching[0].from_node_id},${matching[0].to_node_id})&limit=2`) as Record<string,unknown>[];
    const scoped=await scopedTeamGraph(context.env,context.req.raw,workspaceId,user.id!,endpoints,[],
      context.req.header("x-aipi-github-user-token"));
    if (endpoints.length!==2 || scoped.restrictedScope)
      return context.json({error:"Current repository access is required for both graph endpoints"},403);
    const review = await serviceDataApi(context.env, "rpc/broker_review_team_graph_edge_operation", {
      method: "POST", body: JSON.stringify({ p_actor_id:user.id,p_workspace_id:workspaceId,
        p_device_id:input.deviceId,p_operation_id:input.operationId,
        p_edge_id: edgeId, p_confirm: input.confirm, p_base_version:input.baseVersion }),
    });
    return context.json({ review });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/workspaces/:workspaceId/impact", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const githubUserToken = context.req.header("x-aipi-github-user-token");
    if (githubUserToken && (githubUserToken.length<20 || githubUserToken.length>500))
      return context.json({error:"Invalid GitHub user token"},400);
    const input = impactInput.parse(await context.req.json());
    await assertReadableTeamWorkspace(context.env,context.req.raw,workspaceId);
    const [nodes, edges] = await Promise.all([
      serviceDataApi(context.env, `team_graph_nodes?select=*&workspace_id=eq.${workspaceId}&limit=501`),
      serviceDataApi(context.env, `team_graph_edges?select=*&workspace_id=eq.${workspaceId}&limit=1001`),
    ]) as [Record<string, unknown>[], Record<string, unknown>[]];
    const scoped = await scopedTeamGraph(context.env,context.req.raw,workspaceId,user.id!,nodes,edges,githubUserToken);
    if (!scoped.nodes.some(node=>node.project_key===input.changedProjectKey && node.node_key===input.changedNodeKey))
      return context.json({error:"Changed graph target is unavailable under current repository access"},403);
    return context.json({ report: analyzeTeamImpact({ nodes:scoped.nodes, edges:scoped.edges, ...input }),
      restrictedScope:scoped.restrictedScope },200,{"cache-control":"no-store"});
  } catch (error) {
    if (error instanceof Error && /bounded analysis size/.test(error.message)) return context.json({ error: error.message }, 413);
    return teamError(error);
  }
});
app.post("/api/github/webhook", async (context) => {
  try {
    if (!context.env.GITHUB_WEBHOOK_SECRET || !context.env.SUPABASE_SERVICE_ROLE_KEY)
      return context.json({ error: "GitHub webhook is not configured" }, 503);
    const body = new Uint8Array(await context.req.arrayBuffer());
    if (body.byteLength > 1_000_000) return context.json({ error: "Webhook body is too large" }, 413);
    if (!verifyGitHubWebhook(body, context.req.header("x-hub-signature-256"), context.env.GITHUB_WEBHOOK_SECRET))
      return context.json({ error: "Invalid GitHub webhook signature" }, 401);
    const deliveryId = z.uuid().parse(context.req.header("x-github-delivery"));
    const event = z.enum(["pull_request", "check_run", "merge_group"]).parse(context.req.header("x-github-event"));
    const payload = JSON.parse(new TextDecoder().decode(body));
    const result = await serviceDataApi(context.env, "rpc/apply_team_github_webhook", {
      method: "POST", body: JSON.stringify({ p_delivery_id: deliveryId, p_event: event, p_payload: payload }),
    }) as {organizationId?:string;processed?:number;duplicate?:boolean};
    let check=null;
    if((event==="pull_request" && ["opened","reopened","synchronize","edited"].includes(payload.action)) ||
       (event==="merge_group" && payload.action==="checks_requested")){
      if(!context.env.GITHUB_APP_ID || !context.env.GITHUB_APP_PRIVATE_KEY)
        return context.json({error:"GitHub App check publisher is not configured"},503);
      const repositoryId=String(payload.repository?.id??"");
      const repository=String(payload.repository?.full_name??"");
      const installationId=Number(payload.installation?.id);
      const headSha=event==="pull_request"?payload.pull_request?.head?.sha:payload.merge_group?.head_sha;
      if(!/^[1-9][0-9]{0,29}$/.test(repositoryId)||!/^[0-9a-f]{40}$/.test(headSha??""))
        return context.json({error:"GitHub event lacks a pinned repository head"},400);
      const installation=await serviceDataApi(context.env,
        `team_github_installations?select=organization_id&installation_id=eq.${installationId}&active=eq.true&limit=1`) as Array<{organization_id:string}>;
      if(!installation.length)return context.json({error:"GitHub installation is inactive"},403);
      const workspaceSources=await serviceDataApi(context.env,
        `team_workspace_projects?select=workspace_id&provider_repository_id=eq.${repositoryId}&limit=101`) as Array<{workspace_id:string}>;
      if(workspaceSources.length>100)return context.json({error:"GitHub source mapping exceeds bounds"},413);
      const workspaces=await serviceDataApi(context.env,
        `team_workspaces?select=id&organization_id=eq.${installation[0].organization_id}&limit=501`) as Array<{id:string}>;
      if(workspaces.length>500)return context.json({error:"GitHub workspace mapping exceeds bounds"},413);
      const registered=new Set(workspaces.map(item=>item.id));
      if(workspaceSources.some(item=>registered.has(item.workspace_id))){
        check=await publishAipiBlockingCheck({repository,headSha,installationId,repositoryId,
          appId:context.env.GITHUB_APP_ID,privateKey:context.env.GITHUB_APP_PRIVATE_KEY,
          externalId:`aipi:${event==="pull_request"?"pr":"queue"}:${repositoryId}:${headSha}`,
          summary:event==="merge_group"
            ? "Merge-group head has not completed an exact cross-repository assessment and release compatibility proof."
            : "PR head has not completed an exact cross-repository assessment and release compatibility proof."});
      }
    }
    return context.json({ delivery: result, check });
  } catch (error) { return teamError(error); }
});
async function controllerPayload(env:Env,request:Request) {
  const secret=env.AIPI_DEPLOYMENT_CONTROLLER_SECRET;
  const timestamp=request.headers.get('x-aipi-controller-timestamp')??'';
  const signature=request.headers.get('x-aipi-controller-signature')??'';
  if(!secret || secret.length<32)throw new CloudIdentityConfigurationError('Protected deployment controller is not configured');
  if(!/^[0-9]{13}$/.test(timestamp) || Math.abs(Date.now()-Number(timestamp))>300_000 ||
      !/^sha256=[0-9a-f]{64}$/.test(signature))
    throw new SupabaseDataError(401,'Invalid deployment controller signature');
  const bytes=new Uint8Array(await request.arrayBuffer());
  if(bytes.length>8192)throw new SupabaseDataError(413,'Deployment controller request exceeds limit');
  const body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const signed=`${timestamp}.${request.method}.${new URL(request.url).pathname}.${body}`;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const received=Uint8Array.from(signature.slice(7).match(/../g)!,pair=>parseInt(pair,16));
  if(!await crypto.subtle.verify('HMAC',key,received,new TextEncoder().encode(signed)))
    throw new SupabaseDataError(401,'Invalid deployment controller signature');
  return JSON.parse(body);
}
const deploymentEventInput=z.object({eventId:z.uuid(),expectedGeneration:z.number().int().min(0),
  projectKey:z.string().regex(/^prj_[A-Za-z0-9_-]{4,100}$/),
  sourceBindingId:z.string().regex(/^src_[A-Za-z0-9_-]{8,100}$/),revision:z.string().regex(/^[0-9a-f]{40}$/),
  artifactDigest:z.string().regex(/^sha256:[0-9a-f]{64}$/),cohortId:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  active:z.boolean()}).strict();
const controllerScope=(context:any)=>({workspaceId:z.uuid().parse(context.req.param('workspaceId')),
  environmentId:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).parse(context.req.param('environmentId'))});
app.post('/api/deployment-controller/workspaces/:workspaceId/environments/:environmentId/state',async context=>{
  try{
    const {workspaceId,environmentId}=controllerScope(context);
    z.object({}).strict().parse(await controllerPayload(context.env,context.req.raw));
    const stateQuery=`team_deployment_environments?select=generation,observed_at&workspace_id=eq.${workspaceId}&environment_id=eq.${environmentId}&limit=1`;
    const states=await serviceDataApi(context.env,stateQuery) as Array<{generation:number;observed_at:string|null}>;
    const cohorts=await serviceDataApi(context.env,
      `team_deployment_cohorts?select=cohort_id,project_key,source_id,revision_commit,artifact_digest,generation,observed_at&workspace_id=eq.${workspaceId}&environment_id=eq.${environmentId}&active=eq.true&limit=201`) as unknown[];
    const current=await serviceDataApi(context.env,stateQuery) as Array<{generation:number;observed_at:string|null}>;
    if((states[0]?.generation??0)!==(current[0]?.generation??0))
      return context.json({error:'Deployment generation changed during snapshot; retry'},409);
    if(cohorts.length>200)return context.json({error:'Deployment cohort scope exceeds bound'},413);
    return context.json({workspaceId,environmentId,generation:states[0]?.generation??0,observedAt:states[0]?.observed_at??null,
      cohorts},200,{'cache-control':'no-store'});
  }catch(error){return teamError(error);}
});
app.post('/api/deployment-controller/workspaces/:workspaceId/environments/:environmentId/observe',async context=>{
  try{
    const {workspaceId,environmentId}=controllerScope(context);
    const input=deploymentEventInput.parse(await controllerPayload(context.env,context.req.raw));
    const {eventId,expectedGeneration,...payload}=input;
    const observation=await serviceDataApi(context.env,'rpc/apply_team_deployment_event',{method:'POST',body:JSON.stringify({
      p_event_id:eventId,p_workspace_id:workspaceId,p_environment_id:environmentId,
      p_expected_generation:expectedGeneration,p_controller_id:'aipi-protected-controller',p_payload:payload})});
    return context.json({observation},200,{'cache-control':'no-store'});
  }catch(error){return teamError(error);}
});
app.post('/api/deployment-controller/workspaces/:workspaceId/environments/:environmentId/decision',async context=>{
  try{
    const {workspaceId,environmentId}=controllerScope(context);
    const input=z.object({expectedGeneration:z.number().int().min(0),projectKey:z.string().regex(/^prj_[A-Za-z0-9_-]{4,100}$/),
      sourceBindingId:z.string().regex(/^src_[A-Za-z0-9_-]{8,100}$/),revision:z.string().regex(/^[0-9a-f]{40}$/),
      artifactDigest:z.string().regex(/^sha256:[0-9a-f]{64}$/)}).strict().parse(await controllerPayload(context.env,context.req.raw));
    const states=await serviceDataApi(context.env,
      `team_deployment_environments?select=generation&workspace_id=eq.${workspaceId}&environment_id=eq.${environmentId}&limit=1`) as Array<{generation:number}>;
    const generation=states[0]?.generation??0;
    return context.json({workspaceId,environmentId,candidate:input,generation,canDeploy:false,
      status:generation===input.expectedGeneration?'unknown':'stale',
      reason:generation===input.expectedGeneration
        ? 'Accepted exact-version coexistence proofs and complete consumer discovery are unavailable.'
        : 'Deployment generation changed; refresh observations and reassess.'},200,{'cache-control':'no-store'});
  }catch(error){return teamError(error);}
});
app.post("/api/team/github/oauth/start", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    if (!context.env.GITHUB_APP_CLIENT_ID || !context.env.GITHUB_APP_CLIENT_SECRET || !context.env.GITHUB_APP_CALLBACK_URL)
      return context.json({ error: "GitHub App user authorization is not configured" }, 503);
    const { returnTo } = z.object({ returnTo: z.string().refine(validGithubReturnPath) }).strict().parse(await context.req.json());
    const state = await githubOAuthState(context.env, { userId: user.id, returnTo, expiresAt: Date.now() + 10 * 60_000,
      nonce: randomSecret("oauth") });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", context.env.GITHUB_APP_CLIENT_ID);
    url.searchParams.set("redirect_uri", context.env.GITHUB_APP_CALLBACK_URL);
    url.searchParams.set("state", state);
    return context.json({ url: url.toString(), state });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/github/oauth/exchange", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    if (!context.env.GITHUB_APP_CLIENT_ID || !context.env.GITHUB_APP_CLIENT_SECRET || !context.env.GITHUB_APP_CALLBACK_URL)
      return context.json({ error: "GitHub App user authorization is not configured" }, 503);
    const { code, state } = z.object({ code: z.string().min(8).max(500), state: z.string().min(40).max(2000) }).strict().parse(await context.req.json());
    const pending = await verifyGithubOAuthState(context.env, state, user.id!);
    const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: context.env.GITHUB_APP_CLIENT_ID, client_secret: context.env.GITHUB_APP_CLIENT_SECRET,
        code, redirect_uri: context.env.GITHUB_APP_CALLBACK_URL }) });
    const exchange = await response.json() as { access_token?:string; expires_in?:number; error?:string };
    if (!response.ok || !exchange.access_token || exchange.error)
      return context.json({ error: "GitHub authorization could not be exchanged" }, 403);
    const githubResponse = await fetch("https://api.github.com/user", { headers: {
      authorization: `Bearer ${exchange.access_token}`, accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10", "user-agent": "AIPI-Team" } });
    if (!githubResponse.ok) return context.json({ error: "GitHub user identity could not be verified" }, 403);
    const githubUser = await githubResponse.json() as { id?:number; login?:string };
    if (!Number.isSafeInteger(githubUser.id) || !githubUser.login)
      return context.json({ error: "GitHub user identity is invalid" }, 403);
    const previous = await serviceDataApi(context.env, `team_github_user_identities?select=github_user_id&user_id=eq.${user.id}&limit=1`) as Array<{github_user_id:number}>;
    if (previous.length && Number(previous[0].github_user_id) !== githubUser.id)
      return context.json({ error: "This AIPI account is already linked to another GitHub user" }, 409);
    await serviceDataApi(context.env, "team_github_user_identities?on_conflict=user_id", { method: "POST",
      headers: { prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: user.id, github_user_id: githubUser.id,
        github_login: githubUser.login, verified_at: new Date().toISOString() }) });
    return context.json({ githubUser: { id: githubUser.id, login: githubUser.login },
      githubUserToken: exchange.access_token,
      expiresAt: Number.isFinite(exchange.expires_in) ? new Date(Date.now() + exchange.expires_in! * 1000).toISOString() : null,
      returnTo: pending.returnTo }, 200, { "cache-control": "no-store" });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/github/installations", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    if (!context.env.GITHUB_APP_ID)
      return context.json({ error: "GitHub App is not configured" }, 503);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const { installationId, githubUserToken } = z.object({ installationId: z.number().int().positive(), githubUserToken: z.string().min(20).max(500) }).strict().parse(await context.req.json());
    const members = await dataApi(context.env, context.req.raw,
      `organization_memberships?select=role&organization_id=eq.${organizationId}&user_id=eq.${user.id}&limit=1`) as Array<{ role: string }>;
    if (!members.length || !["owner", "admin"].includes(members[0].role)) return context.json({ error: "Owner or admin required" }, 403);
    let userAccess: Awaited<ReturnType<typeof verifyUserInstallationAccess>>;
    try {
      userAccess = await verifyUserInstallationAccess({ installationId, appId: context.env.GITHUB_APP_ID, userToken: githubUserToken });
    } catch {
      return context.json({ error: "This GitHub account cannot access that AIPI App installation. Reconnect GitHub or check the installation owner." }, 403);
    }
    if (!await hasLinkedGithubUser(context.env, context.req.raw, user.id!, userAccess.userId))
      return context.json({ error: "Link this GitHub identity to your AIPI account before connecting an installation" }, 403);
    // GitHub's user-installations endpoint already verifies the installation
    // belongs to this App and is accessible to this GitHub user. A second App
    // JWT request added a separate credential failure to this user flow.
    if (!userAccess.installation.account?.login)
      return context.json({ error: "GitHub installation could not be verified" }, 400);
    const existing = await serviceDataApi(context.env, `team_github_installations?select=organization_id&installation_id=eq.${installationId}`) as Array<{organization_id:string}>;
    if (existing.length && existing[0].organization_id !== organizationId) return context.json({ error: "Installation belongs to another AIPI organization" }, 409);
    const rows = await serviceDataApi(context.env, "team_github_installations?on_conflict=installation_id", {
      method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ installation_id: installationId, organization_id: organizationId,
        account_login: userAccess.installation.account.login, active: true, connected_by: user.id,
        github_user_id: userAccess.userId, github_user_login: userAccess.userLogin, verified_at: new Date().toISOString() }),
    }) as unknown[];
    return context.json({ installation: rows[0] }, 201);
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/github/available-installations", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    if (!context.env.GITHUB_APP_ID) return context.json({ error: "GitHub App is not configured" }, 503);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const githubUserToken = z.string().min(20).max(500).parse(context.req.header("x-aipi-github-user-token"));
    const members = await dataApi(context.env, context.req.raw,
      `organization_memberships?select=role&organization_id=eq.${organizationId}&user_id=eq.${user.id}&limit=1`) as Array<{role:string}>;
    if (!members.length || !["owner", "admin"].includes(members[0].role)) return context.json({ error: "Owner or admin required" }, 403);
    const githubResponse = await fetch("https://api.github.com/user", { headers: {
      authorization: `Bearer ${githubUserToken}`, accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10", "user-agent": "AIPI-Team" } });
    if (!githubResponse.ok) return context.json({ error: "GitHub session expired. Connect your GitHub account again." }, 401);
    const githubUser = await githubResponse.json() as {id?:number};
    if (!Number.isSafeInteger(githubUser.id) ||
        !await hasLinkedGithubUser(context.env, context.req.raw, user.id!, githubUser.id!))
      return context.json({ error: "Link this GitHub account to your AIPI account first" }, 403);
    const connected = await dataApi(context.env, context.req.raw,
      `team_github_installations?select=installation_id&organization_id=eq.${organizationId}&active=eq.true&limit=101`) as Array<{installation_id:number}>;
    if (connected.length > 100) return context.json({ error: "Too many connected installations" }, 413);
    const connectedIds = new Set(connected.map((installation) => Number(installation.installation_id)));
    const installations: Array<{id:number;accountLogin:string;connected:boolean}> = [];
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, { headers: {
        authorization: `Bearer ${githubUserToken}`, accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10", "user-agent": "AIPI-Team" } });
      if (!response.ok) return context.json({ error: "GitHub installations could not be loaded. Reconnect your GitHub account." }, 502);
      const result = await response.json() as {installations?:Array<{id?:number;app_id?:number;account?:{login?:string};suspended_at?:string|null}>};
      if (!Array.isArray(result.installations)) return context.json({ error: "GitHub installation list is invalid" }, 502);
      for (const installation of result.installations) {
        if (Number.isSafeInteger(installation.id) && Number(installation.app_id) === Number(context.env.GITHUB_APP_ID) &&
            installation.account?.login && !installation.suspended_at)
          installations.push({ id: installation.id!, accountLogin: installation.account.login,
            connected: connectedIds.has(installation.id!) });
      }
      if (result.installations.length < 100) break;
    }
    return context.json({ installations }, 200, { "cache-control": "no-store" });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/github/repositories", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    if (!context.env.GITHUB_APP_ID) return context.json({ error: "GitHub App is not configured" }, 503);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const githubUserToken = z.string().min(20).max(500).parse(context.req.header("x-aipi-github-user-token"));
    const members = await dataApi(context.env, context.req.raw,
      `organization_memberships?select=role&organization_id=eq.${organizationId}&user_id=eq.${user.id}&limit=1`) as Array<{role:string}>;
    if (!members.length) return context.json({ error: "Team access denied" }, 403);
    const userResponse = await fetch("https://api.github.com/user", { headers: {
      authorization: `Bearer ${githubUserToken}`, accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10", "user-agent": "AIPI-Team" } });
    if (!userResponse.ok) return context.json({ error: "GitHub session expired. Connect your GitHub account again." }, 401);
    const githubUser = await userResponse.json() as {id?:number;login?:string};
    if (!Number.isSafeInteger(githubUser.id) || !githubUser.login ||
        !await hasLinkedGithubUser(context.env, context.req.raw, user.id!, githubUser.id!))
      return context.json({ error: "Link this GitHub account to your AIPI account first" }, 403);
    const installations = await dataApi(context.env, context.req.raw,
      `team_github_installations?select=installation_id,account_login&organization_id=eq.${organizationId}&active=eq.true&limit=21`) as Array<{installation_id:number;account_login:string}>;
    if (installations.length > 20) return context.json({ error: "Too many installations to list" }, 413);
    const repositories: Array<{id:string;fullName:string;installationId:number}> = [];
    for (const installation of installations) {
      try {
        await verifyUserInstallationAccess({ installationId: Number(installation.installation_id),
          appId: context.env.GITHUB_APP_ID, userToken: githubUserToken });
      } catch { continue; }
      for (let page = 1; page <= 5; page++) {
        const response = await fetch(`https://api.github.com/user/installations/${installation.installation_id}/repositories?per_page=100&page=${page}`, {
          headers: { authorization: `Bearer ${githubUserToken}`, accept: "application/vnd.github+json",
            "x-github-api-version": "2026-03-10", "user-agent": "AIPI-Team" } });
        if (!response.ok) return context.json({ error: "GitHub repositories could not be loaded. Reconnect your GitHub account." }, 502);
        const data = await response.json() as {repositories?:Array<{id?:number;full_name?:string;permissions?:{pull?:boolean;push?:boolean;admin?:boolean}}>};
        if (!Array.isArray(data.repositories)) return context.json({ error: "GitHub repository list is invalid" }, 502);
        for (const repository of data.repositories) {
          if (Number.isSafeInteger(repository.id) && repository.full_name &&
              (repository.permissions?.pull || repository.permissions?.push || repository.permissions?.admin))
            repositories.push({ id: String(repository.id), fullName: repository.full_name,
              installationId: Number(installation.installation_id) });
        }
        if (data.repositories.length < 100) break;
      }
    }
    return context.json({ githubUser: { id: githubUser.id, login: githubUser.login }, repositories }, 200,
      { "cache-control": "no-store" });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/github/producers", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const input = z.object({ appId: z.number().int().positive(), name: z.string().min(1).max(200),
      environment: z.string().min(1).max(120) }).strict().parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw, "team_ci_producers?on_conflict=organization_id,app_id,environment", {
      method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ organization_id: organizationId, app_id: input.appId, name: input.name,
        environment: input.environment, enabled: true, configured_by: user.id }),
    }) as unknown[];
    return context.json({ producer: rows[0] }, 201);
  } catch (error) { return teamError(error); }
});
app.post("/api/team/pull-requests/:prId/target", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const prId = z.uuid().parse(context.req.param("prId"));
    const input = impactInput.parse(await context.req.json());
    const target = await dataApi(context.env, context.req.raw, "rpc/set_team_pr_target", {
      method: "POST", body: JSON.stringify({ p_pr_id: prId, p_changed_project_key: input.changedProjectKey,
        p_changed_node_key: input.changedNodeKey, p_revision_set: input.revisionSet }),
    });
    return context.json({ target });
  } catch (error) { return teamError(error); }
});
app.put("/api/team/pull-requests/:prId/task", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const prId = z.uuid().parse(context.req.param("prId"));
    const { taskId } = z.object({ taskId: z.uuid().nullable() }).strict().parse(await context.req.json());
    const task = await dataApi(context.env, context.req.raw, "rpc/set_team_pr_task", {
      method: "POST", body: JSON.stringify({ p_pr_id: prId, p_task_id: taskId }),
    });
    return context.json({ task });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/pull-requests/:prId/assess", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    if (!context.env.GITHUB_APP_ID) return context.json({ error: "GitHub App is not configured" }, 503);
    const prId = z.uuid().parse(context.req.param("prId"));
    const { githubUserToken } = z.object({ githubUserToken: z.string().min(20).max(500) }).strict().parse(await context.req.json());
    const prs = await dataApi(context.env, context.req.raw,
      `team_pull_requests?select=id,organization_id,workspace_id,installation_id,provider_repository_id,repository,number,base_sha,head_sha,revision_set&id=eq.${prId}&limit=1`) as Array<Record<string, any>>;
    if (!prs.length) return context.json({ error: "Pull request unavailable" }, 404);
    const pr = prs[0];
    const installation = await dataApi(context.env, context.req.raw,
      `team_github_installations?select=installation_id&installation_id=eq.${pr.installation_id}&organization_id=eq.${pr.organization_id}&active=eq.true&limit=1`) as unknown[];
    if (!installation.length) return context.json({ error: "GitHub installation is inactive" }, 403);
    let access;
    try { access = await verifyUserRepositoryAccess({ installationId: Number(pr.installation_id),
      appId: context.env.GITHUB_APP_ID, repositoryId: pr.provider_repository_id, userToken: githubUserToken }); }
    catch { return context.json({ error: "Current GitHub repository access is required" }, 403); }
    if (!access.canRead || String(access.repository.full_name).toLowerCase() !== String(pr.repository).toLowerCase() ||
        !await hasLinkedGithubUser(context.env, context.req.raw, user.id!, access.userId))
      return context.json({ error: "Current GitHub repository access is required" }, 403);
    const projectRows = await dataApi(context.env, context.req.raw,
      `team_workspace_projects?select=project_key,repository_root&workspace_id=eq.${pr.workspace_id}&provider_repository_id=eq.${pr.provider_repository_id}&limit=2`) as Array<{project_key:string;repository_root:string}>;
    if (projectRows.length !== 1) return context.json({ error: "PR repository does not map to one workspace project" }, 409);
    const repository = String(pr.repository).split("/").map(encodeURIComponent).join("/");
    const livePr = await githubRepositoryRequest(`/repos/${repository}/pulls/${pr.number}`, githubUserToken) as
      {head?:{sha?:string};base?:{sha?:string}};
    if (!/^[0-9a-f]{40}$/.test(livePr.head?.sha??"") || !/^[0-9a-f]{40}$/.test(livePr.base?.sha??""))
      return context.json({ error: "GitHub did not return a current PR revision" }, 502);
    if (livePr.head?.sha!==pr.head_sha || livePr.base?.sha!==pr.base_sha)
      return context.json({ error: "PR revision changed; wait for the GitHub webhook to update AIPI, then assess the current head",
        currentHead: livePr.head?.sha, currentBase: livePr.base?.sha }, 409, { "cache-control": "no-store" });
    const comparison = await githubRepositoryRequest(`/repos/${repository}/compare/${pr.base_sha}...${pr.head_sha}?per_page=100&page=1`,
      githubUserToken) as {files?:Array<{filename:string;previous_filename?:string;status?:string;patch?:string}>;total_commits?:number};
    if (!Array.isArray(comparison.files)) return context.json({ error: "GitHub comparison has no file coverage" }, 502);
    const [nodes,edges,workspaceProjects,activeInstallations] = await Promise.all([
      serviceDataApi(context.env, `team_graph_nodes?select=*&workspace_id=eq.${pr.workspace_id}&limit=501`),
      serviceDataApi(context.env, `team_graph_edges?select=*&workspace_id=eq.${pr.workspace_id}&limit=1001`),
      dataApi(context.env, context.req.raw, `team_workspace_projects?select=project_key,provider_repository_id,repository&workspace_id=eq.${pr.workspace_id}&limit=201`),
      dataApi(context.env, context.req.raw, `team_github_installations?select=installation_id&organization_id=eq.${pr.organization_id}&active=eq.true&limit=21`),
    ]) as [Record<string, unknown>[],Record<string, unknown>[],Array<{project_key:string;provider_repository_id:string|null;repository:string|null}>,Array<{installation_id:number}>];
    if (nodes.length>500||edges.length>1000) return context.json({ error: "Workspace graph exceeds bounded assessment size" }, 413);
    if (workspaceProjects.length>200||activeInstallations.length>20)
      return context.json({ error: "Workspace repository grants exceed bounded assessment size" }, 413);
    const graphProjects = new Set(nodes.map((node) => String(node.project_key)));
    if (graphProjects.size>32) return context.json({ error: "Graph projects exceed bounded repository authorization size" }, 413);
    const readableProjects = new Set<string>([projectRows[0].project_key]);
    for (const project of workspaceProjects) {
      if (!graphProjects.has(project.project_key) || readableProjects.has(project.project_key) ||
          !project.provider_repository_id || !project.repository) continue;
      for (const candidate of activeInstallations) {
        try {
          const grant = await verifyUserRepositoryAccess({ installationId: Number(candidate.installation_id),
            appId: context.env.GITHUB_APP_ID, repositoryId: project.provider_repository_id, userToken: githubUserToken });
          if (grant.canRead && String(grant.repository.full_name).toLowerCase()===project.repository.toLowerCase() &&
              await hasLinkedGithubUser(context.env, context.req.raw, user.id!, grant.userId)) {
            readableProjects.add(project.project_key); break;
          }
        } catch { /* Keep inaccessible repository graph data out of this response. */ }
      }
    }
    await assertLegacyGraphSourceScope(context.env,context.req.raw,pr.workspace_id,new Set(nodes.map(node=>String(node.project_key))));
    const scoped = scopeTeamAssessmentGraph({ nodes, edges, readableProjects });
    const contractFiles = comparison.files.filter((file) => /(?:^|\/)(?:openapi|swagger)[^/]*\.json$/i.test(file.filename));
    const semanticComparisons = [];
    for (const file of contractFiles.slice(0, 5)) {
      if (file.filename.split("/").some((part) => !part || part === "." || part === "..")) continue;
      const path = file.filename.split("/").map(encodeURIComponent).join("/");
      try {
        const load = async (commit: string) => {
          const item = await githubRepositoryRequest(`/repos/${repository}/contents/${path}?ref=${commit}`, githubUserToken) as
            {type?:string;size?:number;encoding?:string;content?:string};
          if (item.type!=="file" || !Number.isSafeInteger(item.size) || item.size!>200_000 || item.encoding!=="base64" || !item.content)
            throw new Error("Contract source is unavailable or exceeds the bounded comparison size");
          const bytes = Uint8Array.from(atob(item.content.replace(/\s/g,"")), character=>character.charCodeAt(0));
          return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
        };
        semanticComparisons.push(compareOpenApiJson(await load(pr.base_sha),await load(pr.head_sha),{path:file.filename}));
      } catch { semanticComparisons.push({path:file.filename,status:"unknown",reason:"Both authorized OpenAPI revisions could not be inspected",changes:[]}); }
    }
    const assessment = assessTeamChangedFiles({ files: comparison.files, nodes: scoped.nodes, edges: scoped.edges,
      projectKey: projectRows[0].project_key, repositoryRoot: projectRows[0].repository_root,
      baseSha: pr.base_sha, headSha: pr.head_sha, revisionSet: Array.isArray(pr.revision_set)?pr.revision_set:[],
      workspaceId: pr.workspace_id, changeId: pr.id, restrictedScope: scoped.restrictedScope,
      truncated: comparison.files.length>=300 || (comparison.total_commits??0)>250 });
    if (contractFiles.length>5) assessment.ledger.limitations.push("Additional OpenAPI files exceed the bounded semantic comparison size.");
    return context.json({ assessment: {...assessment,semanticComparisons} }, 200, { "cache-control": "no-store" });
  } catch (error) { return teamError(error); }
});

async function teamPrReport(env: Env, request: Request, prId: string, userId: string, githubUserToken?: string) {
  if (!env.GITHUB_APP_ID || !githubUserToken || githubUserToken.length<20 || githubUserToken.length>500)
    throw new SupabaseDataError(403,"Current GitHub repository access is required");
  const rows = await dataApi(env, request, `team_pull_requests?select=*&id=eq.${prId}&limit=1`) as Array<Record<string, any>>;
  if (!rows.length) return null;
  const pr = rows[0];
  const workspaceId = pr.workspace_id;
  const installation = await dataApi(env,request,
    `team_github_installations?select=installation_id&installation_id=eq.${pr.installation_id}&organization_id=eq.${pr.organization_id}&active=eq.true&limit=1`) as unknown[];
  if (!installation.length) throw new SupabaseDataError(403,"GitHub installation is inactive");
  let sourceAccess;
  try { sourceAccess = await verifyUserRepositoryAccess({installationId:Number(pr.installation_id),
    appId:env.GITHUB_APP_ID,repositoryId:pr.provider_repository_id,userToken:githubUserToken}); }
  catch { throw new SupabaseDataError(403,"Current GitHub repository access is required"); }
  if (!sourceAccess.canRead || String(sourceAccess.repository.full_name).toLowerCase()!==String(pr.repository).toLowerCase() ||
      !await hasLinkedGithubUser(env,request,userId,sourceAccess.userId))
    throw new SupabaseDataError(403,"Current GitHub repository access is required");
  const repository = String(pr.repository).split('/').map(encodeURIComponent).join('/');
  const livePr = await githubRepositoryRequest(`/repos/${repository}/pulls/${pr.number}`, githubUserToken) as
    {head?:{sha?:string};base?:{sha?:string}};
  if (!/^[0-9a-f]{40}$/.test(livePr.head?.sha??'') || !/^[0-9a-f]{40}$/.test(livePr.base?.sha??''))
    throw new SupabaseDataError(502,"GitHub did not return a current PR revision");
  if (livePr.head?.sha!==pr.head_sha || livePr.base?.sha!==pr.base_sha)
    throw new SupabaseDataError(409,"PR revision changed; wait for the GitHub webhook and assess the current head");
  const [nodes, edges, projects, receipts, taskRows] = await Promise.all([
    serviceDataApi(env, `team_graph_nodes?select=*&workspace_id=eq.${workspaceId}&limit=501`),
    serviceDataApi(env, `team_graph_edges?select=*&workspace_id=eq.${workspaceId}&limit=1001`),
    dataApi(env, request, `team_workspace_projects?select=project_key,provider_repository_id,repository&workspace_id=eq.${workspaceId}&limit=201`),
    serviceDataApi(env, `team_ci_receipts?select=*&organization_id=eq.${pr.organization_id}&limit=1001`),
    pr.task_id ? dataApi(env, request, `team_tasks?select=id,title,status,owner_id,updated_at&id=eq.${pr.task_id}&workspace_id=eq.${workspaceId}&limit=1`) : Promise.resolve([]),
  ]) as [Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[]];
  if (nodes.length > 500 || edges.length > 1000 || receipts.length > 1000 || projects.length>200)
    throw new SupabaseDataError(413, "PR report exceeds bounded graph or receipt limit");
  const scoped = await scopedTeamGraph(env,request,workspaceId,userId,nodes,edges,githubUserToken);
  const readable = new Set(scoped.nodes.map(node=>String(node.project_key)));
  if (pr.changed_project_key && !readable.has(pr.changed_project_key))
    throw new SupabaseDataError(403,"Changed graph target is unavailable under current repository access");
  const scopedProjects = projects.filter(project=>readable.has(String(project.project_key)));
  const repositoryIds = new Set(scopedProjects.map(project=>String(project.provider_repository_id)));
  const scopedReceipts = receipts.filter(receipt=>repositoryIds.has(String(receipt.provider_repository_id)));
  const scopedRevisions = (Array.isArray(pr.revision_set)?pr.revision_set:[]).filter((entry:{projectKey:string})=>readable.has(entry.projectKey));
  const impact = pr.changed_project_key && pr.changed_node_key
    ? analyzeTeamImpact({ nodes:scoped.nodes, edges:scoped.edges, changedProjectKey: pr.changed_project_key,
      changedNodeKey: pr.changed_node_key, revisionSet: scopedRevisions })
    : { status: "unverified", affected: [], suggestions: [], reason: "PR has no changed contract target" };
  const task = taskRows[0] ?? null;
  const report = composeTeamPrReport({ pr, impact, receipts:scopedReceipts, projects:scopedProjects,
    revisionSet:scopedRevisions, task });
  return { pr:{...pr,revision_set:scopedRevisions}, task, impact, report, restrictedScope:scoped.restrictedScope };
}
app.get("/api/team/pull-requests/:prId/report", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const result = await teamPrReport(context.env, context.req.raw, z.uuid().parse(context.req.param("prId")),
      user.id!,context.req.header("x-aipi-github-user-token"));
    return result ? context.json(result,200,{"cache-control":"no-store"}) : context.json({ error: "PR not found" }, 404);
  } catch (error) { return teamError(error); }
});
app.post("/api/team/pull-requests/:prId/publish", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    z.uuid().parse(context.req.param("prId"));
    return context.json({ error: "GitHub publishing requires verified per-user repository capability" }, 503);
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/devices", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const devices = await dataApi(context.env, context.req.raw,
      `team_devices?select=id,label,revoked_at,created_at,last_seen_at&organization_id=eq.${organizationId}&user_id=eq.${user.id}&order=created_at.desc&limit=100`);
    return context.json({ devices });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/devices", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const input = teamDeviceInput.parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw, "team_devices?select=id,organization_id,user_id,label,created_at,revoked_at", {
      method: "POST", headers: { prefer: "return=representation" },
      body: JSON.stringify({ organization_id: organizationId, user_id: user.id, label: input.label }),
    }) as unknown[];
    return context.json({ device: rows[0] }, 201);
  } catch (error) { return teamError(error); }
});
app.delete("/api/team/organizations/:organizationId/devices/:deviceId", async (context) => {
  try {
    const user = await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const deviceId = z.uuid().parse(context.req.param("deviceId"));
    const query = new URLSearchParams({ id: `eq.${deviceId}`, organization_id: `eq.${organizationId}`, user_id: `eq.${user.id}`, revoked_at: "is.null", select: "id,revoked_at" });
    const rows = await dataApi(context.env, context.req.raw, `team_devices?${query}`, { method: "PATCH", headers: { prefer: "return=representation" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) }) as unknown[];
    if (!rows.length) return context.json({ error: "Device unavailable or already revoked" }, 404);
    return context.json({ device: rows[0] });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/workspaces/:workspaceId/tasks", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const query = new URLSearchParams({ select: "id,workspace_id,project_key,external_id,title,description,status,owner_id,scope,revision_set,version,created_by,created_at,updated_at", workspace_id: `eq.${workspaceId}`, order: "updated_at.desc", limit: "200" });
    return context.json({ tasks: await dataApi(context.env, context.req.raw, `team_tasks?${query}`) });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/workspaces/:workspaceId/pull-requests", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const query = new URLSearchParams({ select: "id,task_id,repository,number,title,state,head_sha,updated_at",
      workspace_id: `eq.${workspaceId}`, order: "updated_at.desc", limit: "100" });
    return context.json({ pullRequests: await dataApi(context.env, context.req.raw, `team_pull_requests?${query}`) });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/workspaces/:workspaceId/tasks", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    z.uuid().parse(context.req.param("workspaceId"));
    return context.json({ error: "Use the organization task operation endpoint with a device and operation ID" }, 410);
  } catch (error) { return teamError(error); }
});
app.patch("/api/team/workspaces/:workspaceId/tasks/:taskId", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    z.uuid().parse(context.req.param("workspaceId"));
    z.uuid().parse(context.req.param("taskId"));
    return context.json({ error: "Use the organization task operation endpoint with a device and operation ID" }, 410);
  } catch (error) { return teamError(error); }
});
app.get("/api/team/workspaces/:workspaceId/decisions", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const query = new URLSearchParams({ select: "id,workspace_id,task_id,body,source_refs,created_by,created_at", workspace_id: `eq.${workspaceId}`, order: "created_at.desc", limit: "200" });
    return context.json({ decisions: await dataApi(context.env, context.req.raw, `team_decisions?${query}`) });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/workspaces/:workspaceId/decisions", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    z.uuid().parse(context.req.param("workspaceId"));
    return context.json({ error: "Use the organization append operation endpoint" }, 410);
  } catch (error) { return teamError(error); }
});
app.get("/api/team/workspaces/:workspaceId/evidence", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const query = new URLSearchParams({ select: "id,workspace_id,task_id,kind,producer,revision_set,payload,created_by,created_at", workspace_id: `eq.${workspaceId}`, order: "created_at.desc", limit: "200" });
    return context.json({ evidence: await dataApi(context.env, context.req.raw, `team_evidence?${query}`) });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/workspaces/:workspaceId/evidence", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    z.uuid().parse(context.req.param("workspaceId"));
    return context.json({ error: "Use the organization append operation endpoint" }, 410);
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/workspaces/:workspaceId/operations/task", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const input = teamOperationInput.parse(await context.req.json());
    const patch = input.patch ?? { ...(input.title === undefined ? {} : {title:input.title}),
      ...(input.description === undefined ? {} : {description:input.description}),
      ...(input.status === undefined ? {} : {status:input.status}),
      ...(input.revisionSet === undefined ? {} : {revisionSet:input.revisionSet}) };
    const rows = await dataApi(context.env, context.req.raw, "rpc/apply_team_task_patch_operation", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_workspace_id: workspaceId, p_device_id: input.deviceId, p_operation_id: input.operationId, p_external_id: input.externalId, p_patch: patch, p_base_version: input.baseVersion, p_project_key: input.projectKey ?? null }),
    }) as unknown[];
    return context.json({ accepted: rows[0] });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/workspaces/:workspaceId/operations/append", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const input = teamAppendInput.parse(await context.req.json());
    const { entityType, ...payload } = input.payload;
    const rows = await dataApi(context.env, context.req.raw, "rpc/apply_team_append_operation", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_workspace_id: workspaceId,
        p_device_id: input.deviceId, p_operation_id: input.operationId, p_entity_type: entityType, p_payload: payload }),
    }) as unknown[];
    return context.json({ accepted: rows[0] });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/workspaces/:workspaceId/operations/task-context", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const workspaceId = z.uuid().parse(context.req.param("workspaceId"));
    const input = teamContextOperationInput.parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw, "rpc/apply_team_task_context_operation", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_workspace_id: workspaceId,
        p_device_id: input.deviceId, p_operation_id: input.operationId, p_task_id: input.taskId,
        p_base_version: input.baseVersion, p_owner_id: input.ownerId, p_scope: input.scope,
        p_dependencies: input.dependencies, p_provenance: input.provenance }),
    }) as unknown[];
    return context.json({ accepted: rows[0] });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/changes", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const after = z.coerce.number().int().min(0).parse(context.req.query("after") ?? "0");
    const limit = z.coerce.number().int().min(1).max(100).parse(context.req.query("limit") ?? "100");
    const page = await dataApi(context.env, context.req.raw, "rpc/get_team_change_page", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_after: after, p_limit: limit }),
    }) as { expired: boolean; events: unknown[]; nextCursor: number; hasMore: boolean };
    if (page.expired) return context.json({ error: "Change cursor expired; fetch a team snapshot" }, 410);
    return context.json({ events: page.events, nextCursor: page.nextCursor, hasMore: page.hasMore });
  } catch (error) { return teamError(error); }
});
app.post("/api/team/organizations/:organizationId/changes/prune", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const input = z.object({ before: z.iso.datetime({ offset: true }), limit: z.number().int().min(1).max(10000).default(1000) }).strict().parse(await context.req.json());
    const rows = await dataApi(context.env, context.req.raw, "rpc/prune_team_change_events", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_before: input.before, p_limit: input.limit }),
    }) as unknown[];
    return context.json({ retention: rows[0] });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/tasks/:taskId/context", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const taskId = z.uuid().parse(context.req.param("taskId"));
    const limit = z.coerce.number().int().min(1).max(50).parse(context.req.query("limit") ?? "25");
    const result = await dataApi(context.env, context.req.raw, "rpc/resolve_team_task_context", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_task_id: taskId, p_limit: limit }),
    });
    return context.json(result);
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/decisions/search", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const query = z.string().trim().min(2).max(120).parse(context.req.query("q"));
    const limit = z.coerce.number().int().min(1).max(50).parse(context.req.query("limit") ?? "25");
    const decisions = await dataApi(context.env, context.req.raw, "rpc/search_team_decisions", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_query: query, p_limit: limit }),
    });
    return context.json({ decisions });
  } catch (error) { return teamError(error); }
});
app.get("/api/team/organizations/:organizationId/snapshot", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
    const organizationId = z.uuid().parse(context.req.param("organizationId"));
    const snapshot = await dataApi(context.env, context.req.raw, "rpc/get_team_snapshot", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId }),
    });
    return context.json(snapshot);
  } catch (error) { return teamError(error); }
});
app.get("/oauth/consent", (context) => {
  const destination = new URL(context.req.url);
  destination.pathname = "/oauth/consent/";
  return context.redirect(destination.toString(), 307);
});
app.get("/healthz", (context) => context.json({
  ok: true,
  service: "aipi-remote",
  cloudIdentityConfigured: Boolean(context.env.SUPABASE_URL && context.env.SUPABASE_PUBLISHABLE_KEY),
  protocol: ["2025-11-25", "2026-07-28"],
}));
app.get("/.well-known/openai-apps-challenge", (context) => {
  if (!context.env.OPENAI_APPS_CHALLENGE) return context.text("Not found", 404);
  return context.text(context.env.OPENAI_APPS_CHALLENGE);
});
app.get("/.well-known/oauth-protected-resource", (context) => {
  if (!context.env.SUPABASE_URL) return context.json({ error: "AIPI cloud identity is not fully configured" }, 503);
  return context.json({
    resource: new URL("/mcp", context.req.url).href,
    authorization_servers: [`${context.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://aipi.website/docs.html",
  });
});
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
    const status = error instanceof CloudIdentityConfigurationError ? 503 : 401;
    return context.json({ error: error instanceof Error ? error.message : "Pairing failed" }, status);
  }
});
app.get("/pair/:sessionId/socket", async (context) => {
  if (context.req.header("upgrade")?.toLowerCase() !== "websocket") return context.json({ error: "WebSocket upgrade required" }, 426);
  const sessionId = context.req.param("sessionId");
  const stub = context.env.PAIRING.get(context.env.PAIRING.idFromName(sessionId));
  return stub.fetch(context.req.raw);
});
app.all("/mcp", async (context) => {
  try {
    await authenticatedUser(context.env, context.req.raw);
  } catch (error) {
    if (error instanceof CloudIdentityConfigurationError) {
      return context.json({ error: error.message }, 503);
    }
    const metadata = new URL("/.well-known/oauth-protected-resource", context.req.url).href;
    return context.json({ error: error instanceof Error ? error.message : "Authentication required" }, 401, {
      "www-authenticate": `Bearer resource_metadata="${metadata}"`,
    });
  }
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
