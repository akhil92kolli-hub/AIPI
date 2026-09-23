import "jsr:@supabase/functions-js/edge-runtime.d.ts"

type Field = { name: string; type: string; required?: boolean }
type Consumer = { repository: string; file: string; line?: number; fields?: Field[] }
type ContractInput = {
  organizationId: string
  repository: string
  method: string
  route: string
  revision?: string
  source?: { file?: string; line?: number } | null
  schema: { fields?: Field[] }
  consumers?: Consumer[]
}

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, OPTIONS",
}

const tools = [
  {
    name: "register_contract",
    title: "Register API contract",
    description: "Register or update one repository API contract and its known consumers in the authenticated organization's schema registry.",
    inputSchema: {
      type: "object",
      required: ["organizationId", "repository", "method", "route", "schema"],
      properties: {
        organizationId: { type: "string" }, repository: { type: "string" },
        method: { type: "string" }, route: { type: "string" }, revision: { type: "string" },
        source: { type: ["object", "null"] }, schema: { type: "object" },
        consumers: { type: "array", items: { type: "object" } },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "check_blast_radius",
    title: "Check cross-repository blast radius",
    description: "Compare a proposed API schema with the registered provider contract and report consumer repositories and exact source locations that would break.",
    inputSchema: {
      type: "object",
      required: ["organizationId", "repository", "method", "route", "schema"],
      properties: {
        organizationId: { type: "string" }, repository: { type: "string" },
        method: { type: "string" }, route: { type: "string" }, revision: { type: "string" },
        schema: { type: "object" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "list_contracts",
    title: "List registered contracts",
    description: "List API contracts visible to the authenticated user for one organization.",
    inputSchema: {
      type: "object",
      required: ["organizationId"],
      properties: { organizationId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  },
]

function normalizeRoute(route: string) {
  const value = String(route || "/").split("?")[0].replace(/\/+/g, "/")
  return value.startsWith("/") ? value : `/${value}`
}

function normalizeContract(contract: ContractInput) {
  if (!contract?.organizationId || !contract?.repository || !contract?.method || !contract?.route) {
    throw new Error("organizationId, repository, method, and route are required")
  }
  return {
    organizationId: String(contract.organizationId),
    repository: String(contract.repository),
    method: String(contract.method).toUpperCase(),
    route: normalizeRoute(contract.route),
    revision: contract.revision ? String(contract.revision) : "working-tree",
    source: contract.source ?? null,
    schema: {
      fields: (contract.schema?.fields ?? []).map((field) => ({
        name: String(field.name), type: String(field.type), required: field.required !== false,
      })),
    },
    consumers: (contract.consumers ?? []).map((consumer) => ({
      repository: String(consumer.repository), file: String(consumer.file),
      line: Number(consumer.line ?? 1),
      fields: (consumer.fields ?? []).map((field) => ({
        name: String(field.name), type: String(field.type), required: field.required !== false,
      })),
    })),
  }
}

function dataApiHeaders(request: Request) {
  const authorization = request.headers.get("authorization")
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    throw Object.assign(new Error("A Supabase user access token is required"), { status: 401 })
  }
  const apiKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")
  if (!apiKey) throw new Error("SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY is not configured")
  return { apikey: apiKey, authorization, "content-type": "application/json" }
}

async function dataApi(request: Request, path: string, init: RequestInit = {}) {
  const baseUrl = Deno.env.get("SUPABASE_URL")
  if (!baseUrl) throw new Error("SUPABASE_URL is not configured")
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: { ...dataApiHeaders(request), ...(init.headers ?? {}) },
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000)
    throw Object.assign(new Error(`Registry returned HTTP ${response.status}: ${detail}`), { status: response.status })
  }
  if (response.status === 204) return null
  return await response.json()
}

async function listContracts(request: Request, organizationId: string) {
  const query = new URLSearchParams({
    select: "organization_id,repository,method,route,revision,source_file,source_line,schema,consumers",
    organization_id: `eq.${organizationId}`,
  })
  const rows = await dataApi(request, `api_contracts?${query}`) as Record<string, unknown>[]
  return rows.map((row) => normalizeContract({
    organizationId: String(row.organization_id), repository: String(row.repository),
    method: String(row.method), route: String(row.route), revision: String(row.revision),
    source: row.source_file ? { file: String(row.source_file), line: Number(row.source_line ?? 1) } : null,
    schema: row.schema as { fields?: Field[] }, consumers: row.consumers as Consumer[],
  }))
}

function contractChanges(previous: ReturnType<typeof normalizeContract> | null, proposed: ReturnType<typeof normalizeContract>) {
  const before = new Map((previous?.schema.fields ?? []).map((field) => [field.name, field]))
  const after = new Map(proposed.schema.fields.map((field) => [field.name, field]))
  const changes: Array<Record<string, unknown>> = []
  for (const [name, field] of before) {
    const next = after.get(name)
    if (!next) changes.push({ field: name, kind: "removed", before: field.type, after: null })
    else if (field.type !== next.type) changes.push({ field: name, kind: "type-changed", before: field.type, after: next.type })
    else if (field.required !== next.required) changes.push({ field: name, kind: "required-changed", before: field.required, after: next.required })
  }
  for (const [name, field] of after) {
    if (!before.has(name) && field.required) changes.push({ field: name, kind: "required-added", before: null, after: field.type })
  }
  return changes
}

async function checkBlastRadius(request: Request, input: ContractInput) {
  const proposed = normalizeContract(input)
  const contracts = await listContracts(request, proposed.organizationId)
  const providers = contracts.filter((entry) => entry.method === proposed.method && entry.route === proposed.route)
  const baseline = providers.find((entry) => entry.repository === proposed.repository) ?? providers[0] ?? null
  const changes = contractChanges(baseline, proposed)
  const impacts: Array<Record<string, unknown>> = []
  for (const provider of providers) {
    for (const consumer of provider.consumers) {
      for (const change of changes) {
        const expected = consumer.fields.find((field) => field.name === change.field)
        const unsafe = expected && (change.kind === "removed" || change.kind === "type-changed" ||
          (change.kind === "required-changed" && change.after === false && expected.required))
        if (!unsafe) continue
        impacts.push({
          repository: consumer.repository, file: consumer.file, line: consumer.line,
          field: change.field, change: change.kind, expected: expected.type, proposed: change.after,
          message: `${String(change.field)} ${String(change.kind).replaceAll("-", " ")} will break ${consumer.repository} (${consumer.file}:${consumer.line}).`,
        })
      }
    }
  }
  return {
    safe: impacts.length === 0, organizationId: proposed.organizationId, route: proposed.route,
    method: proposed.method,
    baseline: baseline ? { repository: baseline.repository, revision: baseline.revision } : null,
    changes, impacts,
  }
}

function toolResult(data: Record<string, unknown>, text: string, isError = false) {
  return {
    content: [{ type: "text", text }], structuredContent: data,
    ...(isError ? { isError: true } : {}),
  }
}

async function dispatch(request: Request, message: Record<string, unknown>) {
  const method = String(message.method ?? "")
  const params = (message.params ?? {}) as Record<string, unknown>
  if (method === "initialize") {
    return {
      protocolVersion: String(params.protocolVersion ?? "2025-11-25"),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "aipi-remote", version: "0.1.0" },
      instructions: "Use check_blast_radius before changing a registered backend contract. Register contracts from trusted CI only.",
    }
  }
  if (method === "ping") return {}
  if (method === "tools/list") return { tools }
  if (method !== "tools/call") throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })

  const name = String(params.name ?? "")
  const args = (params.arguments ?? {}) as Record<string, unknown>
  if (name === "register_contract") {
    const contract = normalizeContract(args as unknown as ContractInput)
    const rows = await dataApi(request, "api_contracts?on_conflict=organization_id,repository,method,route", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        organization_id: contract.organizationId, repository: contract.repository,
        method: contract.method, route: contract.route, revision: contract.revision,
        source_file: contract.source?.file ?? null, source_line: contract.source?.line ?? null,
        schema: contract.schema, consumers: contract.consumers, updated_at: new Date().toISOString(),
      }),
    }) as unknown[]
    return toolResult({ contract, persisted: rows.length === 1 }, `Registered ${contract.method} ${contract.route} from ${contract.repository}.`)
  }
  if (name === "list_contracts") {
    const contracts = await listContracts(request, String(args.organizationId ?? ""))
    return toolResult({ contracts }, `${contracts.length} contract(s) registered.`)
  }
  if (name === "check_blast_radius") {
    const report = await checkBlastRadius(request, args as unknown as ContractInput)
    const summary = report.safe ? "No registered consumer breakages detected." : report.impacts.map((entry) => entry.message).join("\n")
    return toolResult({ report }, summary)
  }
  return toolResult({ error: `Unknown tool: ${name}` }, `Unknown tool: ${name}`, true)
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method === "GET") {
    return Response.json({ ok: true, service: "aipi-remote", transport: "streamable-http" }, { headers: corsHeaders })
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders })

  let message: Record<string, unknown> = {}
  try {
    message = await request.json()
    if (message.method === "notifications/initialized") return new Response(null, { status: 202, headers: corsHeaders })
    const result = await dispatch(request, message)
    return Response.json({ jsonrpc: "2.0", id: message.id ?? null, result }, {
      headers: { ...corsHeaders, "cache-control": "no-store" },
    })
  } catch (error) {
    const failure = error as Error & { code?: number; status?: number }
    return Response.json({
      jsonrpc: "2.0", id: message.id ?? null,
      error: { code: failure.code ?? -32603, message: failure.message },
    }, { status: failure.status ?? 200, headers: { ...corsHeaders, "cache-control": "no-store" } })
  }
})
