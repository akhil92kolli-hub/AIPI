import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { breakingChangeForConsumer, contractChanges, normalizeContract, normalizeRepository, normalizeRoute } from "../contract-domain/index.js";

function keyFor(contract) {
  return `${contract.organizationId}:${normalizeRepository(contract.repository)}:${String(contract.method).toUpperCase()}:${normalizeRoute(contract.route)}:${contract.direction ?? contract.schema?.direction ?? "request"}`;
}

export class FileRegistry {
  constructor(file = path.resolve(".api-forge", "remote-registry.json")) {
    this.file = path.resolve(file);
  }

  async read() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, "utf8"));
      return { version: 2, contracts: state.contracts ?? [], versions: state.versions ?? [], audit: state.audit ?? [] };
    }
    catch (error) { if (error.code === "ENOENT") return { version: 2, contracts: [], versions: [], audit: [] }; throw error; }
  }

  async upsert(contract) {
    const state = await this.read();
    const normalized = normalizeContract(contract);
    const publishedAt = new Date().toISOString();
    const versionId = crypto.createHash("sha256").update(JSON.stringify({ organizationId: normalized.organizationId, repository: normalized.repository, method: normalized.method, route: normalized.route, revision: normalized.revision, schema: normalized.schema, consumers: normalized.consumers })).digest("hex").slice(0, 24);
    const versioned = { ...normalized, versionId, publishedAt };
    const key = keyFor(normalized);
    const index = state.contracts.findIndex((entry) => keyFor(entry) === key);
    const previous = index >= 0 ? state.contracts[index] : null;
    if (index >= 0) state.contracts[index] = versioned;
    else state.contracts.push(versioned);
    if (!state.versions.some((entry) => entry.versionId === versionId)) state.versions.push(versioned);
    state.audit.push({ id: `audit_${crypto.randomUUID().replaceAll("-", "")}`, type: "contract.published", organizationId: versioned.organizationId, repository: versioned.repository, method: versioned.method, route: versioned.route, revision: versioned.revision, versionId, previousVersionId: previous?.versionId ?? null, createdAt: publishedAt });
    state.audit = state.audit.slice(-10_000);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return versioned;
  }

  async list(organizationId) {
    const state = await this.read();
    return state.contracts.filter((entry) => !organizationId || entry.organizationId === organizationId);
  }

  async listVersions({ organizationId, repository, method, route } = {}) {
    const state = await this.read();
    return state.versions.filter((entry) => (!organizationId || entry.organizationId === organizationId) && (!repository || normalizeRepository(entry.repository) === normalizeRepository(repository)) && (!method || entry.method === String(method).toUpperCase()) && (!route || entry.route === normalizeRoute(route))).sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)));
  }

  async listAudit(organizationId, limit = 100) {
    const state = await this.read();
    return state.audit.filter((entry) => !organizationId || entry.organizationId === organizationId).slice(-Math.max(1, Math.min(Number(limit) || 100, 500))).reverse();
  }
}

export class SupabaseRegistry {
  constructor({ url, secretKey }) {
    if (!url || !secretKey) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
    this.url = url.replace(/\/$/, "");
    this.headers = { apikey: secretKey, authorization: `Bearer ${secretKey}`, "content-type": "application/json" };
  }

  async upsert(contract) {
    const value = normalizeContract(contract);
    const response = await fetch(`${this.url}/rest/v1/api_contracts?on_conflict=organization_id,repository,method,route,direction`, {
      method: "POST", headers: { ...this.headers, prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ organization_id: value.organizationId, repository: value.repository, method: value.method, route: value.route, direction: value.direction, revision: value.revision, source_file: value.source?.file ?? null, source_line: value.source?.line ?? null, schema: value.schema, consumers: value.consumers })
    });
    if (!response.ok) throw new Error(`Supabase registry returned HTTP ${response.status}: ${await response.text()}`);
    return value;
  }

  async list(organizationId) {
    const filter = organizationId ? `&organization_id=eq.${encodeURIComponent(organizationId)}` : "";
    const response = await fetch(`${this.url}/rest/v1/api_contracts?select=*${filter}`, { headers: this.headers });
    if (!response.ok) throw new Error(`Supabase registry returned HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()).map((entry) => normalizeContract({ organizationId: entry.organization_id, repository: entry.repository, method: entry.method, route: entry.route, revision: entry.revision, source: { file: entry.source_file, line: entry.source_line }, schema: entry.schema, consumers: entry.consumers }));
  }

  async listVersions({ organizationId, repository, method, route } = {}) {
    const filters = [organizationId && `organization_id=eq.${encodeURIComponent(organizationId)}`, repository && `repository=eq.${encodeURIComponent(normalizeRepository(repository))}`, method && `method=eq.${encodeURIComponent(String(method).toUpperCase())}`, route && `route=eq.${encodeURIComponent(normalizeRoute(route))}`].filter(Boolean).join("&");
    const response = await fetch(`${this.url}/rest/v1/api_contract_versions?select=*&order=created_at.desc${filters ? `&${filters}` : ""}`, { headers: this.headers });
    if (!response.ok) throw new Error(`Supabase registry versions returned HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()).map((entry) => ({ ...normalizeContract({ organizationId: entry.organization_id, repository: entry.repository, method: entry.method, route: entry.route, revision: entry.revision, source: { file: entry.source_file, line: entry.source_line }, schema: entry.schema, consumers: entry.consumers }), versionId: entry.id, contentHash: entry.content_hash, publishedAt: entry.created_at, publishedBy: entry.published_by ?? null }));
  }

  async listAudit(organizationId, limit = 100) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const response = await fetch(`${this.url}/rest/v1/registry_audit_events?select=id,event_type,repository,method,route,contract_version_id,actor_id,metadata,created_at&organization_id=eq.${encodeURIComponent(organizationId)}&order=created_at.desc&limit=${boundedLimit}`, { headers: this.headers });
    if (!response.ok) throw new Error(`Supabase registry audit returned HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()).map((entry) => ({ id: entry.id, type: entry.event_type, repository: entry.repository, method: entry.method, route: entry.route, versionId: entry.contract_version_id, actorId: entry.actor_id, metadata: entry.metadata, createdAt: entry.created_at }));
  }
}

export { contractChanges, normalizeContract } from "../contract-domain/index.js";

export async function checkBlastRadius(registry, proposed) {
  const contracts = await registry.list(proposed.organizationId);
  const route = normalizeRoute(proposed.route);
  const normalized = normalizeContract({ ...proposed, consumers: proposed.consumers ?? [] });
  const providers = contracts.filter((entry) => entry.method === normalized.method && normalizeRoute(entry.route) === route && (entry.direction ?? entry.schema?.direction ?? "request") === normalized.direction);
  const baseline = providers.find((entry) => normalizeRepository(entry.repository) === normalized.repository && (entry.direction ?? entry.schema?.direction ?? "request") === normalized.direction) ?? providers[0] ?? null;
  const changes = contractChanges(baseline, normalized);
  const impacts = [];
  for (const provider of providers) {
    for (const consumer of provider.consumers ?? []) {
      for (const change of changes) {
        const expected = consumer.fields.find((field) => field.name === change.field);
        const unsafe = breakingChangeForConsumer(change, expected);
        if (unsafe) impacts.push({ repository: consumer.repository, file: consumer.file, line: consumer.line, field: change.field, change: change.kind, expected: expected?.type ?? null, proposed: change.after, message: `${change.field} ${change.kind.replaceAll("-", " ")} will break ${consumer.repository} (${consumer.file}:${consumer.line}).` });
      }
    }
  }
  const status = !baseline ? "unverified" : impacts.length ? "breaking" : "safe";
  return { status, safe: baseline ? impacts.length === 0 : null, organizationId: proposed.organizationId, route, method: String(proposed.method).toUpperCase(), baseline: baseline ? { repository: baseline.repository, revision: baseline.revision } : null, changes, impacts, note: baseline ? null : "No registered provider baseline exists for this route." };
}

export function registryFromEnvironment(env = process.env) {
  if (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY) return new SupabaseRegistry({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY });
  return new FileRegistry(env.AIPI_REGISTRY_FILE || path.resolve(".api-forge", "remote-registry.json"));
}
