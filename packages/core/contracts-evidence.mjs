import crypto from "node:crypto";
import { resolveContractChain } from "../../ui/contract-chain.js";

const hash = (value, length = 24) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
const normalizeRoute = (value = "/") => {
  const templated = String(value).replace(/^\{\{[^}]+\}\}/, "");
  try { return new URL(templated || "/", "http://aipi.local").pathname.replace(/\/$/, "") || "/"; }
  catch { return String(value).split(/[?#]/)[0].replace(/\/$/, "") || "/"; }
};
const revisionFor = (project) => project.sourceContext?.git?.find((entry) => entry.commit)?.commit
  ?? project.sourceContext?.lastScannedAt
  ?? "unindexed";

export function stableEnvironmentFingerprint(project, environmentId = project.activeEnvironmentId) {
  const environment = project.environments?.find((entry) => entry.id === environmentId) ?? project.environments?.[0] ?? null;
  if (!environment) return hash([project.id, null], 64);
  const snapshot = {
    id: environment.id,
    name: environment.name,
    variables: (environment.variables ?? []).filter((entry) => entry.enabled !== false).map((entry) => ({
      key: entry.key,
      secret: Boolean(entry.secret),
      valueDigest: hash(entry.secret ? entry.credentialRefId ?? entry.key : entry.value ?? "", 32)
    })).sort((a, b) => a.key.localeCompare(b.key)),
    services: (environment.services ?? []).filter((entry) => entry.enabled !== false).map((entry) => ({
      id: entry.id,
      variableKey: entry.variableKey,
      baseUrlDigest: hash(entry.baseUrl ?? "", 32)
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  };
  return hash(snapshot, 64);
}

export function findingFingerprint(finding) {
  return hash([finding.contractId ?? null, finding.type, finding.location ?? finding.source ?? null, finding.sourceRevision ?? null], 32);
}

export function materializeContractEvidence(project, history = []) {
  const source = project.sourceContext ?? {};
  const sourceRevision = revisionFor(project);
  const durableEvidence = (project.evidence ?? []).filter((entry) => ["post-index-bootstrapper", "verification-runner", "otel-live"].includes(entry.origin));
  const previousContracts = new Map((project.contracts ?? []).flatMap((contract) => [
    [contract.id, contract],
    [`${contract.method ?? "GET"} ${normalizeRoute(contract.route ?? contract.normalizedRoute)}`, contract]
  ]));
  const contractByKey = new Map();
  for (const request of project.requests ?? []) {
    const route = normalizeRoute(request.url);
    const key = `${request.method ?? "GET"} ${route}`;
    const previous = previousContracts.get(request.contractId) ?? previousContracts.get(key) ?? {};
    contractByKey.set(key, { ...previous, id: request.contractId ?? previous.id ?? `contract_${hash(key)}`, projectId: project.id, method: request.method ?? "GET", route, normalizedRoute: route, name: request.name, sourceRequestIds: [...new Set([...(contractByKey.get(key)?.sourceRequestIds ?? previous.sourceRequestIds ?? []), request.id])], sourceArtifactIds: [], createdFrom: "saved-request" });
  }
  for (const endpoint of source.endpoints ?? []) {
    const route = normalizeRoute(endpoint.path);
    const key = `${endpoint.method ?? "GET"} ${route}`;
    const existing = contractByKey.get(key);
    const previous = existing ?? previousContracts.get(key) ?? {};
    contractByKey.set(key, { ...previous, id: previous.id ?? `contract_${hash(key)}`, projectId: project.id, method: endpoint.method ?? "GET", route, normalizedRoute: route, name: previous.name ?? key, sourceRequestIds: previous.sourceRequestIds ?? [], sourceArtifactIds: [...new Set([...(previous.sourceArtifactIds ?? []), endpoint.id].filter(Boolean))], implementation: { root: endpoint.root ?? null, source: endpoint.source ?? null, line: endpoint.line ?? null, framework: endpoint.framework ?? null }, createdFrom: existing ? "request-and-index" : "source-index" });
  }
  for (const runtimeContract of (project.contracts ?? []).filter((contract) => contract.createdFrom === "otel-live")) {
    const key = `${runtimeContract.method ?? "GET"} ${normalizeRoute(runtimeContract.route ?? runtimeContract.normalizedRoute)}`;
    if (!contractByKey.has(key)) contractByKey.set(key, runtimeContract);
  }
  project.contracts = [...contractByKey.values()].map((contract) => ({ ...contract, currentRevisionId: `contractrev_${hash([contract.id, sourceRevision])}`, updatedAt: source.lastScannedAt ?? project.updatedAt ?? null }));
  project.contractRevisions = project.contracts.map((contract) => ({ id: contract.currentRevisionId, contractId: contract.id, projectId: project.id, sourceRevision, definitionHash: hash([contract.method, contract.route, contract.implementation]), createdAt: source.lastScannedAt ?? project.updatedAt ?? new Date(0).toISOString() }));

  const projectHistory = history.filter((entry) => entry.projectId === project.id);
  project.evidence = projectHistory.map((entry) => {
    const route = normalizeRoute(entry.result?.request?.url ?? entry.url);
    const contract = contractByKey.get(`${entry.method ?? "GET"} ${route}`) ?? project.contracts.find((item) => (item.sourceRequestIds ?? []).includes(entry.requestId));
    const result = entry.result ?? {};
    const redactedFields = ["authorization", "cookie", "set-cookie", "password", "token", "secret", "api-key"];
    return {
      id: entry.id,
      projectId: project.id,
      contractId: contract?.id ?? null,
      contractRevisionId: contract?.currentRevisionId ?? null,
      type: "api-execution",
      origin: "local-companion",
      sourceRevision,
      environmentFingerprint: stableEnvironmentFingerprint(project),
      recordedAt: entry.createdAt,
      request: { id: entry.requestId, method: entry.method, route },
      result: { status: result.status ?? null, ok: Boolean(result.ok), passed: result.passed !== false && !result.error, elapsedMs: result.elapsed_ms ?? null },
      redactionManifest: { version: 1, strategy: "credential-reference-and-sensitive-field-redaction", fields: redactedFields, plaintextSecretsPersisted: false }
    };
  });
  project.evidence.push(...durableEvidence.filter((entry) => !project.evidence.some((candidate) => candidate.id === entry.id)));

  const findings = [];
  for (const item of source.findings ?? []) {
    const contract = project.contracts.find((entry) => entry.sourceArtifactIds?.includes(item.endpointId) || (item.method === entry.method && normalizeRoute(item.path) === entry.route));
    const finding = { id: item.id ?? `finding_${hash(item)}`, projectId: project.id, contractId: contract?.id ?? null, contractRevisionId: contract?.currentRevisionId ?? null, type: item.type ?? "index-gap", title: item.title ?? "Indexed contract gap", severity: item.severity ?? "medium", origin: "source-index", sourceRevision, location: item.source ? `${item.source}:${item.line ?? 1}` : null, evidenceIds: [] };
    findings.push({ ...finding, fingerprint: findingFingerprint(finding), status: "open" });
  }
  for (const evidence of project.evidence) {
    if (evidence.origin === "otel-live") continue;
    if (!evidence.result || !evidence.request) continue;
    if (evidence.result.passed && Number(evidence.result.status ?? 200) < 400) continue;
    const finding = { id: `finding_${hash([evidence.contractId, evidence.id])}`, projectId: project.id, contractId: evidence.contractId, contractRevisionId: evidence.contractRevisionId, type: Number(evidence.result.status) >= 500 ? "runtime-server-failure" : "runtime-contract-failure", title: `${evidence.request.method} ${evidence.request.route} returned ${evidence.result.status ?? "an execution error"}`, severity: Number(evidence.result.status) >= 500 ? "high" : "medium", origin: "runtime", sourceRevision, location: evidence.request.route, evidenceIds: [evidence.id], status: "open" };
    findings.push({ ...finding, fingerprint: findingFingerprint(finding) });
  }
  const previous = new Map((project.findings ?? []).map((entry) => [entry.fingerprint ?? findingFingerprint(entry), entry]));
  project.findings = [...new Map(findings.map((entry) => [entry.fingerprint, { ...entry, ...(previous.get(entry.fingerprint) ?? {}), evidenceIds: [...new Set([...(previous.get(entry.fingerprint)?.evidenceIds ?? []), ...entry.evidenceIds])] }])).values()];

  const nodes = [];
  const edges = [];
  for (const contract of project.contracts) nodes.push({ id: contract.id, type: "contract", label: `${contract.method} ${contract.route}`, detail: contract.implementation?.source ?? "Saved contract" });
  for (const call of source.frontendCalls ?? []) nodes.push({ id: call.id, type: "caller", label: call.source ?? call.route ?? "Caller", detail: call.line ? `Line ${call.line}` : null });
  for (const schema of source.schemas ?? []) nodes.push({ id: schema.id, type: "schema", label: schema.name ?? schema.source, detail: schema.source });
  for (const task of project.tasks ?? []) nodes.push({ id: task.id, type: "task", label: task.title, detail: task.status });
  for (const finding of project.findings) nodes.push({ id: finding.id, type: "finding", label: finding.title, detail: finding.severity });
  for (const evidence of project.evidence) nodes.push({ id: evidence.id, type: "evidence", label: evidence.request ? `${evidence.request.method} ${evidence.request.route}` : (evidence.type ?? "Evidence"), detail: evidence.result?.status ? `HTTP ${evidence.result.status}` : evidence.result ? "Execution error" : (evidence.summary ?? "Recorded evidence") });
  for (const integration of source.integrations ?? []) {
    const endpoint = (source.endpoints ?? []).find((entry) => entry.id === integration.endpointId);
    const contract = endpoint && project.contracts.find((entry) => entry.method === endpoint.method && entry.route === normalizeRoute(endpoint.path));
    if (integration.callId && contract) edges.push({ id: integration.id ?? `edge_${hash(integration)}`, from: integration.callId, to: contract.id, type: "CALLS", provenance: "static-index", confidence: integration.confidence ?? .5, sourceRevision, confirmationState: integration.confirmationState ?? "inferred" });
  }
  for (const finding of project.findings) if (finding.contractId) edges.push({ id: `edge_${hash([finding.id, finding.contractId])}`, from: finding.contractId, to: finding.id, type: "FAILED_WITH", provenance: finding.origin, confidence: 1, sourceRevision, confirmationState: "confirmed" });
  for (const evidence of project.evidence) if (evidence.contractId) edges.push({ id: `edge_${hash([evidence.contractId, evidence.id])}`, from: evidence.contractId, to: evidence.id, type: "OBSERVED_BY", provenance: "runtime", confidence: 1, sourceRevision, confirmationState: "confirmed" });
  for (const task of project.tasks ?? []) for (const contractId of task.contractIds ?? []) edges.push({ id: `edge_${hash([contractId, task.id])}`, from: contractId, to: task.id, type: "CREATED_TASK", provenance: task.source ?? "manual", confidence: 1, sourceRevision, confirmationState: "confirmed" });
  project.knowledgeGraph = { nodes: [...new Map(nodes.map((entry) => [entry.id, entry])).values()], edges: [...new Map(edges.map((entry) => [entry.id, entry])).values()] };
  return project;
}

export function synthesizeTaskFromFinding(project, findingId) {
  const finding = project.findings?.find((entry) => entry.id === findingId);
  if (!finding) throw new Error("Finding not found");
  const existing = (project.tasks ?? []).find((task) => task.originFindingFingerprint === finding.fingerprint && !task.archivedAt);
  if (existing) return { task: existing, created: false };
  const contract = project.contracts?.find((entry) => entry.id === finding.contractId);
  const now = new Date().toISOString();
  const id = `task_${hash([project.id, finding.fingerprint, now], 12)}`;
  const contextPackId = `context_${hash([id, finding.sourceRevision])}`;
  const verificationPlanId = `verifyplan_${hash([id, finding.contractRevisionId])}`;
  const task = {
    id, projectId: project.id, title: `Resolve ${finding.title}`, description: `Restore the affected contract and prove the fix against revision ${finding.sourceRevision}.`, diagnosis: finding.title,
    source: "finding", originFindingId: finding.id, originFindingFingerprint: finding.fingerprint, status: "proposed", category: "bug", priority: finding.severity === "high" ? "high" : "medium", assignee: "", dueDate: "", milestoneIds: [],
    contractIds: [finding.contractId].filter(Boolean), findingIds: [finding.id], evidenceIds: [...(finding.evidenceIds ?? [])], runtimeEvidenceIds: [...(finding.evidenceIds ?? [])], artifactIds: [], requestIds: contract?.sourceRequestIds ?? [], acceptanceCriteria: ["The failing request replays successfully.", "The normalized contract comparison passes.", "Impacted tests pass for the same source revision."],
    contextPackId, verificationPlanId, verificationReceiptIds: [], verificationRunIds: [], externalLinks: [], runtimeFindings: [], dispatchMode: "developer", verificationGates: { contract: true, requestReplay: true, noExfiltration: true }, createdAt: now, updatedAt: now
  };
  project.tasks ??= [];
  project.tasks.push(task);
  project.contextPacks ??= [];
  project.contextPacks.push({ id: contextPackId, taskId: id, level: "working", tokenBudget: 2400, artifactControls: {}, findingIds: [finding.id], evidenceIds: finding.evidenceIds ?? [], createdAt: now, updatedAt: now });
  finding.status = "task-drafted";
  finding.taskId = id;
  return { task, created: true };
}

export function synthesizeTaskFromContract(project, contractId) {
  const contract = project.contracts?.find(item => item.id === contractId);
  if (!contract) throw Object.assign(new Error("Contract not found"), { statusCode: 404 });
  const finding = project.findings?.find(item => item.contractId === contractId && item.status !== "resolved");
  const existing = (project.tasks ?? []).find(task => !task.archivedAt && !["done", "completed", "cancelled"].includes(task.status) && task.contractIds?.includes(contractId));
  if (existing) return { task: existing, created: false };
  const references = resolveContractChain(project, contract).flatMap(group => group.items);
  if (finding) {
    const result = synthesizeTaskFromFinding(project, finding.id);
    result.task.artifactIds = [...new Set([...result.task.artifactIds, ...references.map(item => item.artifactId)])];
    return result;
  }
  const now = new Date().toISOString();
  const id = `task_${hash([project.id, contractId, now], 12)}`;
  const task = {
    id, projectId: project.id, title: `Review and implement ${contract.method} ${contract.route}`,
    description: "Review the indexed implementation, confirm missing relationships, and implement the required correction. Inspect context before agent handoff.",
    diagnosis: "No linked failure is recorded. Confirm the intended behavior and acceptance criteria before making changes.",
    source: "contract", status: "proposed", category: "feature", priority: "medium",
    contractIds: [contractId], artifactIds: [...new Set(references.map(item => item.artifactId))],
    requestIds: contract.sourceRequestIds ?? [], evidenceIds: (project.evidence ?? []).filter(item => item.contractId === contractId).map(item => item.id),
    findingIds: [], milestoneIds: [], verificationReceiptIds: [], verificationRunIds: [], runtimeEvidenceIds: [], runtimeFindings: [], externalLinks: [],
    acceptanceCriteria: ["Confirm the expected contract behavior.", "Review and resolve implementation gaps.", "Compare the contract and run relevant tests at the current source revision."],
    verificationGates: { contract: true, requestReplay: Boolean(contract.sourceRequestIds?.length), noExfiltration: true },
    dispatchMode: "developer", contextPackId: `context_${hash([id, contract.currentRevisionId])}`, verificationPlanId: `verifyplan_${hash([id, contractId])}`,
    createdAt: now, updatedAt: now
  };
  project.tasks ??= []; project.tasks.push(task);
  project.contextPacks ??= [];
  project.contextPacks.push({ id: task.contextPackId, taskId: id, level: "working", tokenBudget: 2400, artifactControls: {}, evidenceIds: task.evidenceIds, createdAt: now, updatedAt: now });
  return { task, created: true };
}
