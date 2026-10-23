import crypto from "node:crypto";
import { materializeContractEvidence } from "./contracts-evidence.mjs";

const hash = (value, length = 24) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
const nowFor = (project) => project.sourceContext?.lastScannedAt ?? project.updatedAt ?? new Date().toISOString();
const sourceRevisionFor = (project) => project.sourceContext?.git?.find((entry) => entry.commit)?.commit ?? project.sourceContext?.lastScannedAt ?? "unindexed";
const routePath = (value = "/") => {
  const withoutBase = String(value).replace(/^\{\{[^}]+\}\}/, "");
  try { return new URL(withoutBase || "/", "http://aipi.local").pathname.replace(/\/$/, "") || "/"; }
  catch { return withoutBase.split(/[?#]/)[0].replace(/\/$/, "") || "/"; }
};
const artifactFingerprint = (kind, value) => `bootstrap:${kind}:${hash(value, 32)}`;
function persistBootstrapContextGeneration(project, taskId, previousId, fingerprint, fields, timestamp) {
  project.contextPacks ??= [];
  const previous = project.contextPacks.find((entry) => entry.id === previousId) ?? null;
  if (previous?.bootstrapFingerprint === fingerprint) return previous;
  const generation = Math.max(0, ...project.contextPacks.filter((entry) => entry.taskId === taskId).map((entry) => Number(entry.generation) || 0)) + 1;
  const id = previous ? `context_auto_${hash([taskId, fingerprint], 16)}` : previousId;
  const existing = project.contextPacks.find((entry) => entry.id === id);
  if (existing) return existing;
  if (previous) previous.supersededBy = id;
  const pack = { ...fields, id, taskId, generation, previousGenerationId: previous?.id ?? null, createdAt: timestamp, updatedAt: timestamp };
  project.contextPacks.unshift(pack);
  return pack;
}
const titleCase = (value) => String(value).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const smokeSuiteName = "Core Smoke & Single-Route Suite";
const isStaticAssetRoute = (value = "") => /(?:config\.js|\.map|\.css|\.ico)(?:$|[?#])/i.test(String(value));
const collectionRequestIds = (collection) => Array.isArray(collection.executionOrder) && collection.executionOrder.length
  ? collection.executionOrder
  : Array.isArray(collection.requestIds) ? collection.requestIds : [];

function mockValue(field = {}) {
  if (field.example !== undefined) return field.example;
  if (field.default !== undefined) return field.default;
  const name = String(field.name ?? "value").toLowerCase();
  const type = String(field.type ?? field.schema?.type ?? "string").toLowerCase();
  if (type === "uuid" || name.endsWith("id")) return "00000000-0000-4000-8000-000000000001";
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "array") return [];
  if (type === "object") return {};
  if (type === "date" || type === "datetime") return "2026-01-01T00:00:00.000Z";
  if (name.includes("email")) return "developer@example.com";
  return `sample-${name || "value"}`;
}

function schemaForEndpoint(project, endpoint) {
  const schemas = project.sourceContext?.schemas ?? [];
  const sameEndpoint = schemas.find((schema) => schema.endpointId === endpoint?.id);
  const sameSource = schemas.find((schema) => endpoint?.source && schema.source === endpoint.source);
  const resource = routePath(endpoint?.path).split("/").filter(Boolean).filter((part) => !part.startsWith(":") && part !== "api").at(-1)?.replace(/s$/, "").toLowerCase();
  const byName = resource && schemas.find((schema) => String(schema.name ?? "").replace(/s$/, "").toLowerCase() === resource);
  return sameEndpoint ?? sameSource ?? byName ?? null;
}

function requestDefinition(project, contract, endpoint, fingerprint, timestamp) {
  const schema = schemaForEndpoint(project, endpoint);
  const fields = schema?.fields ?? schema?.columns ?? endpoint?.validation?.fields ?? endpoint?.schema?.fields ?? [];
  const method = String(contract.method ?? "GET").toUpperCase();
  const path = routePath(contract.route).replace(/\{([^}]+)\}|:([A-Za-z0-9_]+)/g, (_, braced, colon) => `{{${braced ?? colon}}}`);
  const body = Object.fromEntries(fields.filter((field) => !field.generated && !field.primaryKey).map((field) => [field.name, mockValue(field)]));
  return {
    id: `req_auto_${hash(fingerprint, 16)}`,
    projectId: project.id,
    contractId: contract.id,
    name: `${method} ${contract.route}`,
    method,
    url: `{{baseUrl}}${path}`,
    params: [],
    headers: ["POST", "PUT", "PATCH"].includes(method) ? [{ key: "Content-Type", value: "application/json", enabled: true }] : [],
    auth: { type: "none", token: "", username: "", password: "", key: "", value: "", placement: "header" },
    body: { type: "json", content: ["GET", "HEAD"].includes(method) ? "" : JSON.stringify(body, null, 2), provenance: "schema-derived", schemaId: schema?.id ?? null },
    certificates: { ca: "", clientCert: "", clientKey: "", rejectUnauthorized: true },
    scripts: { pre: "", post: "" },
    docs: `Auto-generated from ${endpoint?.source ?? "the indexed contract"}${endpoint?.line ? `:${endpoint.line}` : ""}. Review path variables and authentication before the first replay.`,
    assertions: [{ type: "status", equals: method === "POST" ? 201 : method === "DELETE" ? 204 : 200 }, { type: "response_time", less_than_ms: 3000 }],
    baselineAssertions: { acceptedStatuses: method === "POST" ? [200, 201] : method === "DELETE" ? [200, 204] : [200], contractRevisionId: contract.currentRevisionId, schemaId: schema?.id ?? null },
    retry: { enabled: false, attempts: 2, delayMs: 500, statuses: "408,425,429,500,502,503,504" },
    origin: "post-index-bootstrapper",
    bootstrapFingerprint: fingerprint,
    sourceRevision: sourceRevisionFor(project),
    generatedAt: timestamp,
    updatedAt: timestamp
  };
}

function groupKeyFor(contract) {
  const parts = routePath(contract.route).split("/").filter(Boolean).filter((part) => !part.startsWith(":") && !part.startsWith("{") && part !== "api");
  if (!parts.length) return "root";
  if (["webhook", "hooks"].includes(parts[0]) && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function collectionName(key) {
  if (key === "webhook/keycloak" || key === "hooks/keycloak") return "Keycloak Webhook Lifecycle";
  if (key === "sync") return "User Sync Workflow";
  const parts = key.split("/");
  return `${parts.map(titleCase).join(" ")} ${parts[0] === "webhook" || parts[0] === "hooks" ? "Lifecycle" : "Workflow"}`;
}

function lifecycleRank(contract) {
  const value = `${contract.method} ${contract.route}`.toLowerCase();
  if (/register|create|signup|invite|\bpost\b/.test(value)) return 10;
  if (/update|patch|\bput\b/.test(value)) return 20;
  if (/sync/.test(value)) return 30;
  if (/\bget\b|list|search|read/.test(value)) return 40;
  if (/delete|remove/.test(value)) return 50;
  return 35;
}

function linkedTestIds(project, endpoint, contract) {
  const routeTokens = routePath(contract.route).split("/").filter(Boolean).filter((part) => !part.startsWith(":"));
  return (project.sourceContext?.artifacts ?? []).filter((artifact) => artifact.kind === "test" && (
    artifact.endpointId === endpoint?.id ||
    (artifact.source && endpoint?.source && artifact.source === endpoint.source) ||
    routeTokens.some((token) => token.length > 3 && `${artifact.name ?? ""} ${artifact.source ?? ""}`.toLowerCase().includes(token.toLowerCase()))
  )).map((artifact) => artifact.id);
}

function findingCandidates(project, discoveredContracts) {
  const source = project.sourceContext ?? {};
  const candidates = [];
  const indexedFindings = [...(source.findings ?? []), ...(project.findings ?? []).filter((entry) => entry.origin !== "post-index-bootstrapper")];
  for (const raw of indexedFindings) {
    const integration = (source.integrations ?? []).find((entry) => entry.id === raw.integrationId);
    const endpointId = raw.endpointId ?? integration?.endpointId;
    const contract = discoveredContracts.find((entry) => entry.id === raw.contractId || entry.sourceArtifactIds?.includes(endpointId) || (raw.method === entry.method && routePath(raw.path) === entry.route));
    if (!contract || !/(mismatch|drift|missing|unresolved|incompatible|contract-failure)/i.test(`${raw.type} ${raw.title}`)) continue;
    candidates.push({ contract, raw, kind: raw.type ?? "contract-mismatch", severity: raw.severity ?? "high", title: raw.title ?? `${contract.method} ${contract.route} contract mismatch` });
  }
  for (const contract of discoveredContracts) {
    const endpoint = (source.endpoints ?? []).find((entry) => contract.sourceArtifactIds?.includes(entry.id));
    if (["GET", "HEAD", "OPTIONS"].includes(contract.method) || linkedTestIds(project, endpoint, contract).length) continue;
    candidates.push({ contract, raw: {}, kind: "untested-critical-route", severity: "medium", title: `${contract.method} ${contract.route} has no indexed test` });
  }
  return candidates;
}

function upsertOwned(list, desired, fingerprint, timestamp) {
  const index = list.findIndex((entry) => entry.bootstrapFingerprint === fingerprint);
  if (index < 0) { list.push(desired); return { value: desired, created: true, changed: true }; }
  const current = list[index];
  const preserved = current.origin === "post-index-bootstrapper" ? { createdAt: current.createdAt ?? desired.createdAt } : {};
  const next = { ...current, ...desired, ...preserved };
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  list[index] = next;
  return { value: next, created: false, changed };
}

function markMissingOwnedStale(list, activeFingerprints, timestamp) {
  let changed = false;
  for (const entry of list) {
    if ((entry.origin !== "post-index-bootstrapper" && entry.generatedBy !== "post-index-bootstrapper") || !entry.bootstrapFingerprint || activeFingerprints.has(entry.bootstrapFingerprint) || entry.staleAt) continue;
    entry.staleAt = timestamp;
    entry.bootstrapState = "stale";
    changed = true;
  }
  return changed;
}

function restoreBootstrapFindings(project, previous) {
  for (const entry of previous) {
    const current = project.findings.find((candidate) => candidate.id === entry.id);
    if (current) Object.assign(current, { ...entry, ...current, bootstrapFingerprint: entry.bootstrapFingerprint, generatedBy: "post-index-bootstrapper" });
    else project.findings.push(entry);
  }
}

export function runPostIndexBootstrapper(project, { history = [] } = {}) {
  if (!project?.id) return { changed: false, skipped: true, reason: "no-indexed-routes" };
  const before = JSON.stringify(project);
  if (Array.isArray(project.collections)) {
    project.collections = project.collections.filter((collection) => collection.origin !== "auto-grouped"
      || collection.name === smokeSuiteName
      || collectionRequestIds(collection).length !== 1);
  }
  if (!(project.sourceContext?.endpoints?.length > 0)) {
    return { changed: JSON.stringify(project) !== before, skipped: true, reason: "no-indexed-routes" };
  }
  const previousBootstrapEvidence = (project.evidence ?? []).filter((entry) => entry.origin === "post-index-bootstrapper");
  const previousBootstrapFindings = (project.findings ?? []).filter((entry) => entry.origin === "post-index-bootstrapper" || entry.generatedBy === "post-index-bootstrapper");
  materializeContractEvidence(project, history);
  project.evidence.push(...previousBootstrapEvidence.filter((entry) => !project.evidence.some((candidate) => candidate.id === entry.id)));
  restoreBootstrapFindings(project, previousBootstrapFindings);
  project.requests ??= [];
  project.collections ??= [];
  project.tasks ??= [];
  project.contextPacks ??= [];
  project.verificationReceipts ??= [];
  const timestamp = nowFor(project);
  const revision = sourceRevisionFor(project);
  let discoveredContracts = (project.contracts ?? []).filter((contract) => contract.sourceArtifactIds?.length);
  const report = { changed: false, skipped: false, requests: 0, collections: 0, findings: 0, tasks: 0, receipts: 0 };

  const activeRequestFingerprints = new Set();
  for (const contract of discoveredContracts) {
    const endpoint = (project.sourceContext.endpoints ?? []).find((entry) => contract.sourceArtifactIds.includes(entry.id));
    const fingerprint = artifactFingerprint("request", [contract.method, contract.route]);
    activeRequestFingerprints.add(fingerprint);
    const existingManual = project.requests.find((request) => request.origin !== "post-index-bootstrapper" && request.contractId === contract.id)
      ?? project.requests.find((request) => request.origin !== "post-index-bootstrapper" && String(request.method).toUpperCase() === contract.method && routePath(request.url) === contract.route);
    if (existingManual) {
      existingManual.contractId ??= contract.id;
      contract.sourceRequestIds = [...new Set([...(contract.sourceRequestIds ?? []), existingManual.id])];
      continue;
    }
    const legacyGenerated = project.requests.find((request) => request.origin === "post-index-bootstrapper" && (request.contractId === contract.id || (String(request.method).toUpperCase() === contract.method && routePath(request.url) === contract.route)));
    if (legacyGenerated) legacyGenerated.bootstrapFingerprint = fingerprint;
    const generated = requestDefinition(project, contract, endpoint, fingerprint, timestamp);
    generated.createdAt = project.requests.find((entry) => entry.bootstrapFingerprint === fingerprint)?.createdAt ?? timestamp;
    const result = upsertOwned(project.requests, generated, fingerprint, timestamp);
    contract.sourceRequestIds = [...new Set([...(contract.sourceRequestIds ?? []), result.value.id])];
    if (result.created) report.requests += 1;
  }
  report.changed = markMissingOwnedStale(project.requests, activeRequestFingerprints, timestamp) || report.changed;
  materializeContractEvidence(project, history);
  project.evidence.push(...previousBootstrapEvidence.filter((entry) => !project.evidence.some((candidate) => candidate.id === entry.id)));
  restoreBootstrapFindings(project, previousBootstrapFindings);
  discoveredContracts = (project.contracts ?? []).filter((contract) => contract.sourceArtifactIds?.length);

  const groups = new Map();
  for (const contract of discoveredContracts) {
    if (isStaticAssetRoute(contract.route)) continue;
    const request = project.requests.find((entry) => entry.contractId === contract.id || (entry.method === contract.method && routePath(entry.url) === contract.route));
    if (!request) continue;
    const key = groupKeyFor(contract);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ contract, request });
  }
  const activeCollectionFingerprints = new Set();
  const singleStepRequestIds = [];
  for (const [key, entries] of groups) {
    entries.sort((left, right) => lifecycleRank(left.contract) - lifecycleRank(right.contract) || left.contract.route.localeCompare(right.contract.route));
    if (entries.length === 1) {
      singleStepRequestIds.push(entries[0].request.id);
      continue;
    }
    const fingerprint = artifactFingerprint("collection", key);
    activeCollectionFingerprints.add(fingerprint);
    const expectedName = collectionName(key);
    const existing = project.collections.find((entry) => entry.bootstrapFingerprint === fingerprint)
      ?? project.collections.find((entry) => entry.origin === "auto-grouped" && entry.name === expectedName);
    if (existing) existing.bootstrapFingerprint = fingerprint;
    const desired = {
      ...existing,
      id: existing?.id ?? `col_auto_${hash(fingerprint, 16)}`,
      projectId: project.id,
      name: expectedName,
      requestIds: entries.map((entry) => entry.request.id),
      stopOnFailure: true,
      origin: "auto-grouped",
      generatedBy: "post-index-bootstrapper",
      bootstrapFingerprint: fingerprint,
      sourceRevision: revision,
      generatedAt: timestamp,
      updatedAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
      staleAt: null,
      bootstrapState: "current"
    };
    const index = project.collections.findIndex((entry) => entry.id === desired.id);
    if (index < 0) { project.collections.push(desired); report.collections += 1; }
    else project.collections[index] = desired;
  }
  if (singleStepRequestIds.length) {
    const fingerprint = artifactFingerprint("collection", smokeSuiteName);
    activeCollectionFingerprints.add(fingerprint);
    const existing = project.collections.find((entry) => entry.bootstrapFingerprint === fingerprint)
      ?? project.collections.find((entry) => entry.origin === "auto-grouped" && entry.name === smokeSuiteName);
    if (existing) existing.bootstrapFingerprint = fingerprint;
    const desired = {
      ...existing,
      id: existing?.id ?? `col_auto_${hash(fingerprint, 16)}`,
      projectId: project.id,
      name: smokeSuiteName,
      requestIds: [...new Set(singleStepRequestIds)],
      stopOnFailure: false,
      origin: "auto-grouped",
      generatedBy: "post-index-bootstrapper",
      bootstrapFingerprint: fingerprint,
      sourceRevision: revision,
      generatedAt: timestamp,
      updatedAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
      staleAt: null,
      bootstrapState: "current"
    };
    const index = project.collections.findIndex((entry) => entry.id === desired.id);
    if (index < 0) { project.collections.push(desired); report.collections += 1; }
    else project.collections[index] = desired;
  }
  report.changed = markMissingOwnedStale(project.collections, activeCollectionFingerprints, timestamp) || report.changed;

  const candidates = findingCandidates(project, discoveredContracts);
  const activeFindingFingerprints = new Set();
  for (const candidate of candidates) {
    const fingerprint = artifactFingerprint("finding", [candidate.kind, candidate.contract.method, candidate.contract.route]);
    activeFindingFingerprints.add(fingerprint);
    const existingFinding = project.findings.find((entry) => entry.bootstrapFingerprint === fingerprint)
      ?? project.findings.find((entry) => entry.id === candidate.raw.id)
      ?? project.findings.find((entry) => entry.contractId === candidate.contract.id && entry.type === candidate.kind && entry.title === candidate.title);
    if (existingFinding) existingFinding.bootstrapFingerprint = fingerprint;
    const findingId = existingFinding?.id ?? `finding_auto_${hash(fingerprint, 16)}`;
    const finding = {
      id: findingId, projectId: project.id, contractId: candidate.contract.id, contractRevisionId: candidate.contract.currentRevisionId,
      type: candidate.kind, title: candidate.title, severity: candidate.severity, origin: existingFinding?.origin ?? "post-index-bootstrapper", generatedBy: "post-index-bootstrapper", sourceRevision: revision,
      location: candidate.raw.source ? `${candidate.raw.source}:${candidate.raw.line ?? 1}` : candidate.contract.route,
      evidenceIds: existingFinding?.evidenceIds ?? [], fingerprint: existingFinding?.fingerprint ?? fingerprint, bootstrapFingerprint: fingerprint, status: "open", updatedAt: timestamp, createdAt: existingFinding?.createdAt ?? timestamp, staleAt: null, bootstrapState: "current"
    };
    const findingResult = upsertOwned(project.findings, finding, fingerprint, timestamp);
    if (findingResult.created) report.findings += 1;

    const taskFingerprint = artifactFingerprint("task", fingerprint);
    const verificationPlanId = `verifyplan_auto_${hash(taskFingerprint, 16)}`;
    const endpointIds = candidate.contract.sourceArtifactIds ?? [];
    const endpoint = project.sourceContext.endpoints.find((entry) => endpointIds.includes(entry.id));
    const requestIds = project.requests.filter((entry) => entry.contractId === candidate.contract.id || (entry.method === candidate.contract.method && routePath(entry.url) === candidate.contract.route)).map((entry) => entry.id);
    const artifactIds = [...endpointIds.map((id) => `endpoint:${id}`), ...linkedTestIds(project, endpoint, candidate.contract).map((id) => `test:${id}`)];
    const existingTask = project.tasks.find((entry) => entry.bootstrapFingerprint === taskFingerprint)
      ?? project.tasks.find((entry) => entry.origin === "post-index-bootstrapper" && (entry.originFindingId === findingId || entry.diagnosis === candidate.title));
    if (existingTask) existingTask.bootstrapFingerprint = taskFingerprint;
    const previousContextPackId = existingTask?.contextPackId ?? null;
    const contextFingerprint = artifactFingerprint("context", taskFingerprint);
    const previousContextPack = project.contextPacks.find((entry) => entry.id === previousContextPackId);
    const contextPackId = previousContextPack && previousContextPack.bootstrapFingerprint !== contextFingerprint
      ? `context_auto_${hash([existingTask.id, contextFingerprint], 16)}`
      : previousContextPack?.id ?? previousContextPackId ?? `context_auto_${hash(taskFingerprint, 16)}`;
    const task = {
      ...existingTask,
      id: existingTask?.id ?? `task_auto_${hash(taskFingerprint, 16)}`, projectId: project.id,
      title: `Resolve ${candidate.title}`, description: `Review the indexed contract gap for ${candidate.contract.method} ${candidate.contract.route}, correct the affected chain, and prove the fix at revision ${revision}.`, diagnosis: candidate.title,
      source: "finding", origin: "post-index-bootstrapper", originFindingId: findingId, originFindingFingerprint: fingerprint, bootstrapFingerprint: taskFingerprint,
      status: existingTask?.status && existingTask.status !== "stale" ? existingTask.status : "proposed", category: "bug", priority: candidate.severity === "high" ? "high" : "medium",
      assignee: existingTask?.assignee ?? "", dueDate: existingTask?.dueDate ?? "", milestoneIds: existingTask?.milestoneIds ?? [],
      contractIds: [candidate.contract.id], findingIds: [findingId], evidenceIds: existingTask?.evidenceIds ?? [], runtimeEvidenceIds: existingTask?.runtimeEvidenceIds ?? [], artifactIds,
      requestIds, acceptanceCriteria: ["The affected contract comparison passes.", "The synthesized request replays with its baseline assertions passing.", "Relevant tests pass at the same source revision."],
      contextPackId, verificationPlanId, verificationReceiptIds: existingTask?.verificationReceiptIds ?? [], verificationRunIds: existingTask?.verificationRunIds ?? [], externalLinks: existingTask?.externalLinks ?? [], runtimeFindings: existingTask?.runtimeFindings ?? [],
      dispatchMode: existingTask?.dispatchMode ?? "developer", verificationGates: { contract: true, requestReplay: true, noExfiltration: true },
      sourceRevision: revision, updatedAt: timestamp, createdAt: existingTask?.createdAt ?? timestamp, staleAt: null, bootstrapState: "current"
    };
    const taskIndex = project.tasks.findIndex((entry) => entry.id === task.id);
    if (taskIndex < 0) { project.tasks.push(task); report.tasks += 1; }
    else project.tasks[taskIndex] = task;
    findingResult.value.taskId = task.id;
    findingResult.value.status = task.status === "proposed" ? "task-drafted" : "task-approved";
    const pack = persistBootstrapContextGeneration(project, task.id, previousContextPackId ?? contextPackId, contextFingerprint, { level: "working", tokenBudget: 2400, artifactIds, findingIds: [findingId], evidenceIds: task.evidenceIds, requestIds, contractIds: [candidate.contract.id], sourceRevision: revision, sourceFingerprint: contextFingerprint, bootstrapFingerprint: contextFingerprint, origin: "post-index-bootstrapper", artifactControls: previousContextPack?.artifactControls ?? {} }, timestamp);
    task.contextPackId = pack.id;
  }
  const riskWeight = { critical: 50, high: 40, medium: 25, low: 10 };
  const launchContracts = [...new Map(candidates.slice().sort((left, right) => (riskWeight[right.severity] ?? 0) - (riskWeight[left.severity] ?? 0) || `${left.contract.method} ${left.contract.route}`.localeCompare(`${right.contract.method} ${right.contract.route}`)).map((entry) => [entry.contract.id, entry.contract])).values()].slice(0, 3);
  let launchTaskFingerprint = null;
  if (launchContracts.length) {
    launchTaskFingerprint = artifactFingerprint("task", ["launch-readiness", ...launchContracts.map((entry) => `${entry.method}:${entry.route}`)]);
    const existing = project.tasks.find((entry) => entry.bootstrapFingerprint === launchTaskFingerprint)
      ?? project.tasks.find((entry) => entry.origin === "post-index-bootstrapper" && entry.kind === "launch-readiness" && !entry.staleAt);
    const contractIds = launchContracts.map((entry) => entry.id);
    const findingIds = project.findings.filter((entry) => contractIds.includes(entry.contractId) && !entry.staleAt).map((entry) => entry.id);
    const requestIds = project.requests.filter((entry) => contractIds.includes(entry.contractId) && !entry.staleAt).map((entry) => entry.id);
    const artifactIds = [...new Set(launchContracts.flatMap((contract) => {
      const endpoint = project.sourceContext.endpoints.find((entry) => contract.sourceArtifactIds?.includes(entry.id));
      return [...(contract.sourceArtifactIds ?? []).map((id) => `endpoint:${id}`), ...linkedTestIds(project, endpoint, contract).map((id) => `test:${id}`)];
    }))];
    const previousContextPackId = existing?.contextPackId ?? null;
    const contextFingerprint = artifactFingerprint("context", launchTaskFingerprint);
    const previousContextPack = project.contextPacks.find((entry) => entry.id === previousContextPackId);
    const contextPackId = previousContextPack && previousContextPack.bootstrapFingerprint !== contextFingerprint
      ? `context_auto_${hash([existing.id, contextFingerprint], 16)}`
      : previousContextPack?.id ?? previousContextPackId ?? `context_auto_${hash(launchTaskFingerprint, 16)}`;
    const launchTask = {
      ...existing, id: existing?.id ?? `task_auto_${hash(launchTaskFingerprint, 16)}`, projectId: project.id, kind: "launch-readiness",
      title: "Launch Readiness", description: `Review the ${launchContracts.length} highest-risk API contract${launchContracts.length === 1 ? "" : "s"}, correct the caller-to-handler chain, and capture revision-linked proof.`, diagnosis: "Highest-risk contracts selected automatically from the current source index.",
      source: "post-index-bootstrapper", origin: "post-index-bootstrapper", bootstrapFingerprint: launchTaskFingerprint,
      status: existing?.status && !["stale", "proposed"].includes(existing.status) ? existing.status : "active", category: "verification", priority: "high",
      assignee: existing?.assignee ?? "", dueDate: existing?.dueDate ?? "", milestoneIds: existing?.milestoneIds ?? [], contractIds, findingIds, requestIds, artifactIds,
      evidenceIds: existing?.evidenceIds ?? [], runtimeEvidenceIds: existing?.runtimeEvidenceIds ?? [], verificationReceiptIds: existing?.verificationReceiptIds ?? [], verificationRunIds: existing?.verificationRunIds ?? [], externalLinks: existing?.externalLinks ?? [], runtimeFindings: existing?.runtimeFindings ?? [],
      acceptanceCriteria: ["Confirm the caller, route, and handler chain for each selected contract.", "Replay the linked requests with their baseline assertions.", "Persist a passing VerificationReceipt at the indexed Git revision."],
      contextPackId, verificationPlanId: existing?.verificationPlanId ?? `verifyplan_auto_${hash(launchTaskFingerprint, 16)}`, dispatchMode: existing?.dispatchMode ?? "developer", verificationGates: { contract: true, requestReplay: true, noExfiltration: true }, sourceRevision: revision,
      updatedAt: timestamp, createdAt: existing?.createdAt ?? timestamp, staleAt: null, bootstrapState: "current"
    };
    const taskIndex = project.tasks.findIndex((entry) => entry.id === launchTask.id);
    if (taskIndex < 0) { project.tasks.push(launchTask); report.tasks += 1; } else project.tasks[taskIndex] = launchTask;
    const pack = persistBootstrapContextGeneration(project, launchTask.id, previousContextPackId ?? contextPackId, contextFingerprint, { level: "working", tokenBudget: 2400, artifactIds, findingIds, evidenceIds: launchTask.evidenceIds, requestIds, contractIds, sourceRevision: revision, sourceFingerprint: contextFingerprint, bootstrapFingerprint: contextFingerprint, origin: "post-index-bootstrapper", artifactControls: previousContextPack?.artifactControls ?? {} }, timestamp);
    launchTask.contextPackId = pack.id;
  }
  report.changed = markMissingOwnedStale(project.findings, activeFindingFingerprints, timestamp) || report.changed;
  const activeTaskFingerprints = new Set([...activeFindingFingerprints].map((fingerprint) => artifactFingerprint("task", fingerprint)));
  if (launchTaskFingerprint) activeTaskFingerprints.add(launchTaskFingerprint);
  report.changed = markMissingOwnedStale(project.tasks, activeTaskFingerprints, timestamp) || report.changed;

  const inventory = discoveredContracts.map((contract) => ({ id: contract.id, method: contract.method, route: contract.route, revisionId: contract.currentRevisionId, definitionHash: project.contractRevisions.find((entry) => entry.id === contract.currentRevisionId)?.definitionHash ?? null })).sort((a, b) => `${a.method} ${a.route}`.localeCompare(`${b.method} ${b.route}`));
  const receiptFingerprint = artifactFingerprint("baseline-receipt", [revision, inventory]);
  const snapshotHash = `sha256:${hash(inventory, 64)}`;
  const existingBaseline = project.verificationReceipts.find((entry) => entry.bootstrapFingerprint === receiptFingerprint)
    ?? project.verificationReceipts.find((entry) => entry.type === "baseline-index" && entry.sourceRevision === revision && entry.snapshotHash === snapshotHash);
  if (existingBaseline) existingBaseline.bootstrapFingerprint = receiptFingerprint;
  if (!existingBaseline) {
    const receiptId = `receipt_baseline_${hash(receiptFingerprint, 16)}`;
    project.verificationReceipts.push({ id: receiptId, projectId: project.id, type: "baseline-index", status: "recorded", immutable: true, origin: "post-index-bootstrapper", bootstrapFingerprint: receiptFingerprint, sourceRevision: revision, contractCount: inventory.length, schemaCount: project.sourceContext.schemas?.length ?? 0, requestCount: discoveredContracts.length, snapshotHash, contractInventory: inventory, verifiedAt: timestamp, createdAt: timestamp });
    project.evidence.push({ id: `evidence_${receiptId}`, projectId: project.id, type: "baseline-index", origin: "post-index-bootstrapper", bootstrapFingerprint: artifactFingerprint("baseline-evidence", receiptFingerprint), sourceRevision: revision, recordedAt: timestamp, snapshotHash, contractCount: inventory.length, schemaCount: project.sourceContext.schemas?.length ?? 0, receiptId, redactionManifest: { version: 1, strategy: "metadata-only", fields: [], plaintextSecretsPersisted: false } });
    report.receipts += 1;
  }
  const graph = project.knowledgeGraph ?? { nodes: [], edges: [] };
  for (const task of project.tasks) graph.nodes.push({ id: task.id, type: "task", label: task.title, detail: task.status });
  for (const finding of project.findings) graph.nodes.push({ id: finding.id, type: "finding", label: finding.title, detail: finding.severity });
  for (const evidence of project.evidence.filter((entry) => entry.origin === "post-index-bootstrapper")) graph.nodes.push({ id: evidence.id, type: "evidence", label: "Baseline contract snapshot", detail: evidence.sourceRevision });
  for (const task of project.tasks) for (const contractId of task.contractIds ?? []) graph.edges.push({ id: `edge_${hash([contractId, task.id])}`, from: contractId, to: task.id, type: "CREATED_TASK", provenance: task.source ?? "manual", confidence: 1, sourceRevision: revision, confirmationState: "confirmed" });
  for (const finding of project.findings) if (finding.contractId) graph.edges.push({ id: `edge_${hash([finding.id, finding.contractId])}`, from: finding.contractId, to: finding.id, type: "FAILED_WITH", provenance: finding.origin, confidence: 1, sourceRevision: revision, confirmationState: "confirmed" });
  project.knowledgeGraph = {
    nodes: [...new Map(graph.nodes.map((entry) => [entry.id, entry])).values()].sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`)),
    edges: [...new Map(graph.edges.map((entry) => [entry.id, entry])).values()].sort((left, right) => left.id.localeCompare(right.id))
  };
  report.changed ||= JSON.stringify(project) !== before;
  return report;
}
