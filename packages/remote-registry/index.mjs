import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRoute } from "../core/index.mjs";

function keyFor(contract) {
  return `${contract.organizationId}:${contract.repository}:${String(contract.method).toUpperCase()}:${normalizeRoute(contract.route)}`;
}

export class FileRegistry {
  constructor(file = path.resolve(".api-forge", "remote-registry.json")) {
    this.file = path.resolve(file);
  }

  async read() {
    try { return JSON.parse(await fs.readFile(this.file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { version: 1, contracts: [] }; throw error; }
  }

  async upsert(contract) {
    const state = await this.read();
    const normalized = normalizeContract(contract);
    const key = keyFor(normalized);
    const index = state.contracts.findIndex((entry) => keyFor(entry) === key);
    if (index >= 0) state.contracts[index] = normalized;
    else state.contracts.push(normalized);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return normalized;
  }

  async list(organizationId) {
    const state = await this.read();
    return state.contracts.filter((entry) => !organizationId || entry.organizationId === organizationId);
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
    const response = await fetch(`${this.url}/rest/v1/api_contracts?on_conflict=organization_id,repository,method,route`, {
      method: "POST", headers: { ...this.headers, prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ organization_id: value.organizationId, repository: value.repository, method: value.method, route: value.route, revision: value.revision, source_file: value.source?.file ?? null, source_line: value.source?.line ?? null, schema: value.schema, consumers: value.consumers })
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
}

export function normalizeContract(contract) {
  if (!contract?.organizationId || !contract?.repository || !contract?.route || !contract?.method) throw new Error("organizationId, repository, route, and method are required");
  return { organizationId: String(contract.organizationId), repository: String(contract.repository), method: String(contract.method).toUpperCase(), route: normalizeRoute(contract.route), revision: contract.revision ? String(contract.revision) : "working-tree", source: contract.source ?? null, schema: { fields: (contract.schema?.fields ?? []).map((field) => ({ name: String(field.name), type: String(field.type), required: field.required !== false })) }, consumers: (contract.consumers ?? []).map((consumer) => ({ repository: String(consumer.repository), file: String(consumer.file), line: Number(consumer.line ?? 1), fields: (consumer.fields ?? []).map((field) => ({ name: String(field.name), type: String(field.type), required: field.required !== false })) })), updatedAt: new Date().toISOString() };
}

export function contractChanges(previous, proposed) {
  const before = new Map((previous?.schema?.fields ?? []).map((field) => [field.name, field]));
  const after = new Map((proposed?.schema?.fields ?? []).map((field) => [field.name, field]));
  const changes = [];
  for (const [name, field] of before) {
    const next = after.get(name);
    if (!next) changes.push({ field: name, kind: "removed", before: field.type, after: null });
    else if (field.type !== next.type) changes.push({ field: name, kind: "type-changed", before: field.type, after: next.type });
    else if (field.required !== next.required) changes.push({ field: name, kind: "required-changed", before: field.required, after: next.required });
  }
  for (const [name, field] of after) if (!before.has(name) && field.required) changes.push({ field: name, kind: "required-added", before: null, after: field.type });
  return changes;
}

export async function checkBlastRadius(registry, proposed) {
  const contracts = await registry.list(proposed.organizationId);
  const route = normalizeRoute(proposed.route);
  const providers = contracts.filter((entry) => entry.method === String(proposed.method).toUpperCase() && entry.route === route);
  const baseline = providers.find((entry) => entry.repository === proposed.repository) ?? providers[0] ?? null;
  const changes = contractChanges(baseline, normalizeContract({ ...proposed, consumers: proposed.consumers ?? [] }));
  const impacts = [];
  for (const provider of providers) {
    for (const consumer of provider.consumers ?? []) {
      for (const change of changes) {
        const expected = consumer.fields.find((field) => field.name === change.field);
        if (!expected) continue;
        if (["removed", "type-changed"].includes(change.kind) || (change.kind === "required-changed" && change.after === false && expected.required)) impacts.push({ repository: consumer.repository, file: consumer.file, line: consumer.line, field: change.field, change: change.kind, expected: expected.type, proposed: change.after, message: `${change.field} ${change.kind.replaceAll("-", " ")} will break ${consumer.repository} (${consumer.file}:${consumer.line}).` });
      }
    }
  }
  return { safe: impacts.length === 0, organizationId: proposed.organizationId, route, method: String(proposed.method).toUpperCase(), baseline: baseline ? { repository: baseline.repository, revision: baseline.revision } : null, changes, impacts };
}

export function registryFromEnvironment(env = process.env) {
  if (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY) return new SupabaseRegistry({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY });
  return new FileRegistry(env.AIPI_REGISTRY_FILE || path.resolve(".api-forge", "remote-registry.json"));
}
