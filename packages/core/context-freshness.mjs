import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildProjectKnowledgeGraph, discoverTaskContext } from "./knowledge-graph.mjs";
import { buildTaskContext, taskArtifacts } from "./task-context.mjs";
import { ensureTaskVerificationPlan, projectGitRevision } from "./verification-runner.mjs";
import { normalizeTaskIntent } from "./task-intent.mjs";
import { crossRepositoryTask, resolveTaskWorkspace, workspaceScopeSnapshot, scopeHash, reviewedTaskRelationships } from "./task-workspace.mjs";

const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const contractId = (endpoint) => `contract_${digest(`${endpoint.method}:${endpoint.path}`).slice(0, 20)}`;

export function taskContextSourceFingerprint(project) {
  const revision = projectGitRevision(project);
  const workingTrees = (project.sourceContext?.git ?? []).map((entry) => [entry.requestedRoot ?? entry.root, entry.commit, Boolean(entry.dirty), entry.workingTreeFingerprint ?? null]);
  return `sha256:${digest(JSON.stringify({ revision, workingTrees }))}`;
}

function synthesizeContractsFromEndpoints(project) {
  project.contracts ??= [];
  for (const endpoint of project.sourceContext?.endpoints ?? []) {
    const id = contractId(endpoint);
    if (project.contracts.some((entry) => entry.id === id || (entry.method === endpoint.method && entry.route === endpoint.path))) continue;
    project.contracts.push({
      id, method: endpoint.method, route: endpoint.path, state: "Untested", comparisonState: "Untested",
      sourceArtifactIds: [endpoint.id], implementation: { source: endpoint.source, line: endpoint.line },
      currentRevisionId: `revision_${digest([id, projectGitRevision(project)]).slice(0, 20)}`, sourceRequestIds: []
    });
  }
}

function authorizedRoots(project) {
  return (project.sourceContext?.roots ?? []).map((entry) => path.resolve(entry.path));
}

async function artifactSnapshot(project, artifact, previousHash) {
  if (!artifact.source) return { id: artifact.id, source: null, contentHash: artifact.contentHash ?? null, changed: Boolean(previousHash && artifact.contentHash && previousHash !== artifact.contentHash), estimatedTokens: 0 };
  const roots = authorizedRoots(project);
  const candidates = artifact.root ? [path.resolve(artifact.root, artifact.source)] : roots.map((root) => path.resolve(root, artifact.source));
  const target = candidates.find((candidate) => roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`)));
  if (!target) return { id: artifact.id, source: artifact.source, contentHash: artifact.contentHash ?? null, changed: false, unavailable: true, estimatedTokens: 0 };
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 2_000_000) return { id: artifact.id, source: artifact.source, contentHash: artifact.contentHash ?? null, changed: false, unavailable: true, estimatedTokens: 0 };
    const content = await fs.readFile(target, "utf8");
    const contentHash = digest(content);
    const lines = content.split(/\r?\n/);
    const lineStart = Math.max(1, Number(artifact.line) || 1);
    const lineEnd = Math.min(lines.length, lineStart + 23);
    const span = lines.slice(lineStart - 1, lineEnd).join("\n");
    return { id: artifact.id, kind: artifact.kind, source: artifact.source, root: artifact.root ?? roots.find((root) => target.startsWith(`${root}${path.sep}`)) ?? null, lineStart, lineEnd, contentHash, previousHash: previousHash ?? null, changed: Boolean(previousHash && previousHash !== contentHash), estimatedTokens: Math.ceil(Buffer.byteLength(span, "utf8") / 4) };
  } catch {
    return { id: artifact.id, source: artifact.source, contentHash: artifact.contentHash ?? null, previousHash: previousHash ?? null, changed: Boolean(previousHash && artifact.contentHash && previousHash !== artifact.contentHash), unavailable: true, estimatedTokens: 0 };
  }
}

function acceptanceCriteria(contracts, task = {}) {
  const intent = normalizeTaskIntent(task.intent, "discovery");
  const routes = contracts.slice(0, 3).map((contract) => `${contract.method} ${contract.route}`).join(", ");
  if (intent === "ui-component") return [
    "Confirm the UI behavior, responsive layout, keyboard flow, and accessible states match the objective.",
    "Run the relevant component, interaction, or end-to-end checks for the changed frontend surface.",
    "Record revision-linked proof for the selected source files and completed checks."
  ];
  if (intent === "full-stack" && !routes) return [
    "Confirm the frontend-to-backend flow and its loading, success, empty, and failure states.",
    "Run the relevant component, API, schema, and end-to-end checks for the affected feature.",
    "Record revision-linked proof for the selected implementation and verification checks."
  ];
  if (intent === "commit-pr") return ["Review the bounded working-tree change set for atomic scope.", "Reference only passing verification proof that matches the current revision.", "Produce a concise commit message and PR body without repository-wide grep."];
  if (intent === "deployment-automation") return ["Require a passing VerificationReceipt for the current Git revision.", "Require a 2xx health check from the active environment.", "Block deployment while linked contracts contain unverified drift."];
  if (intent === "discovery" && !routes) return [
    "Document the affected files, symbols, and relationships found in the local index.",
    "Validate the highest-risk findings against the current working tree.",
    "Record an evidence-backed recommendation or implementation plan at the current revision."
  ];
  if (!routes) return [
    "Confirm the implementation matches the stated objective.",
    "Run the relevant code, UI, integration, or API checks for the selected implementation scope.",
    "Record revision-linked proof against the prepared source context."
  ];
  return [
    `Confirm handler and schema alignment for ${routes}.`,
    `Execute the linked saved request replay in the active development or staging environment.`,
    `Record a passing VerificationReceipt at Git revision ${contracts[0]?.currentRevisionId ? "matching the prepared contract revision" : "matching the current context pack"}.`
  ];
}

export async function refreshAndPrepareTaskContext(project, task, options = {}) {
  if (!project || !task) throw new TypeError("A project and task are required.");
  if (crossRepositoryTask(project, task)) {
    const scope = resolveTaskWorkspace(project, task);
    if (scope.errors.length) throw new Error(scope.errors.join(' '));
    const previous = task.contextPack;
    const snapshots = [];
    for (const {project: member, task: local, targets} of scope.projects) {
      for (const artifact of taskArtifacts(member).filter(a=>local.artifactIds.includes(a.id))) {
        const refs = targets.filter(t=>t.ref.entityId===artifact.id && (!t.root || t.root===artifact.root));
        if (!refs.length) continue;
        const prior = previous?.includedArtifacts?.find(a=>a.projectId===member.id && a.id===artifact.id && a.root===artifact.root);
        snapshots.push({...await artifactSnapshot(member,artifact,prior?.contentHash),projectId:member.id,targetRef:refs[0].ref});
      }
    }
    const workspace = workspaceScopeSnapshot(project,task), fingerprint=scopeHash([workspace,snapshots]);
    const now = new Date().toISOString();
    const pack={id:`context_${crypto.randomUUID().replaceAll('-','').slice(0,20)}`,taskId:task.id,
      generation:(previous?.generation ?? 0)+1,previousGenerationId:previous?.id ?? null,
      workspace,targetRefs:task.targetRefs,includedArtifacts:snapshots,sourceFingerprint:fingerprint,
      sourceRevision:fingerprint,gitRevision:fingerprint,level:options.level ?? 'working',
      freshness:{status:snapshots.some(s=>s.unavailable)?'incomplete':'current',refreshedAt:now,changedArtifacts:snapshots.filter(s=>s.changed).length},createdAt:now,updatedAt:now};
    if (previous && previous.sourceFingerprint!==fingerprint) task.staleVerificationReceiptIds=[...new Set([...(task.staleVerificationReceiptIds??[]),...(task.verificationReceiptIds??[])])];
    project.contextPacks ??=[];
    const prior=project.contextPacks.find(p=>p.id===previous?.id); if(prior) prior.supersededBy=pack.id;
    project.contextPacks.unshift(pack); task.contextPack=pack; task.contextPackId=pack.id;task.contextStatus=pack.freshness.status;task.updatedAt=now;
    const manifest=buildTaskContext(project,task.id,options.tokenBudget??2400);
    manifest.id=pack.id;manifest.generation=pack.generation;manifest.freshness=pack.freshness;
    pack.estimatedTokens=manifest.telemetry.estimatedTokens;pack.tokenBudget=manifest.telemetry.tokenBudget;
    return {task,contextPack:pack,manifest,plan:ensureTaskVerificationPlan(project,task),changedArtifacts:snapshots.filter(s=>s.changed),autoLinkedContractIds:[]};
  }
  const tokenBudget = Math.max(1000, Math.min(2400, Number(options.tokenBudget) || 2400));
  synthesizeContractsFromEndpoints(project);
  const previousPack = structuredClone((project.contextPacks ?? []).find((entry) => entry.id === task.contextPackId) ?? (task.contextPackId ? null : (project.contextPacks ?? []).filter((entry) => entry.taskId === task.id).sort((a, b) => Number(b.generation ?? 0) - Number(a.generation ?? 0))[0]) ?? task.contextPack ?? {});
  buildProjectKnowledgeGraph(project, { pinnedEdges: project.knowledgeGraph?.pinnedEdges ?? [], runtimeEdges: project.knowledgeGraph?.edges?.filter((edge) => edge.provenance === "runtime") ?? [], rejectedEdgeIds: project.knowledgeGraph?.rejectedEdgeIds ?? [], ignoredBlindSpotIds: project.knowledgeGraph?.ignoredBlindSpotIds ?? [] });
  if (task.contextSelectionMode !== "manual") discoverTaskContext(project, task, { maxContracts: 3, tokenBudget });

  const inventory = taskArtifacts(project);
  const previousHashes = new Map([...(previousPack.includedArtifacts ?? []).map((entry) => [entry.id, entry.contentHash]), ...(task.artifactLinks ?? []).map((entry) => [entry.artifactId, entry.contentHash])]);
  const snapshots = [];
  let artifactTokens = 0;
  for (const artifact of inventory.filter((entry) => task.artifactIds?.includes(entry.id))) {
    const snapshot = await artifactSnapshot(project, artifact, previousHashes.get(artifact.id));
    if (artifactTokens + snapshot.estimatedTokens > tokenBudget && snapshots.length) continue;
    artifactTokens += snapshot.estimatedTokens;
    snapshots.push(snapshot);
  }

  const linkedContracts = (task.contractIds ?? []).map((id) => project.contracts.find((contract) => contract.id === id)).filter(Boolean);
  if (task.contextSelectionMode !== "manual") {
    task.requestIds = [...new Set([...(task.requestIds ?? []), ...linkedContracts.flatMap((contract) => contract.sourceRequestIds ?? []), ...(project.requests ?? []).filter((request) => task.contractIds.includes(request.contractId)).map((request) => request.id)])];
    task.findingIds = [...new Set([...(task.findingIds ?? []), ...(project.findings ?? []).filter((finding) => task.contractIds.includes(finding.contractId)).map((finding) => finding.id)])];
  }
  task.acceptanceCriteria = task.acceptanceCriteria?.length ? task.acceptanceCriteria : acceptanceCriteria(linkedContracts, task);
  const manifest = buildTaskContext(project, task.id, tokenBudget);
  const estimatedTokens = Math.min(tokenBudget, Math.max(artifactTokens, Number(manifest.telemetry?.estimatedTokens) || 0));
  const now = new Date().toISOString();
  const revision = projectGitRevision(project) || "working-tree";
  const sourceFingerprint = taskContextSourceFingerprint(project);
  const changedArtifacts = snapshots.filter((entry) => entry.changed);
  task.affectedChainIds = [...new Set(task.affectedChainIds ?? [])];
  task.artifactLinks = snapshots.map((entry) => ({ artifactId: entry.id, contentHash: entry.contentHash, root: entry.root, indexedAt: project.sourceContext?.lastScannedAt, provenance: "context-freshness" }));
  task.contextStatus = "current";
  task.updatedAt = now;
  const generation = Math.max(Number(previousPack.generation) || 0, ...((project.contextPacks ?? []).filter((entry) => entry.taskId === task.id).map((entry) => Number(entry.generation) || 0))) + 1;
  const previousId = previousPack.id ?? task.contextPackId ?? null;
  const contextPackId = `context_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const contextPack = {
    id: contextPackId, generation, previousGenerationId: previousId, taskId: task.id, level: options.level ?? previousPack.level ?? "working",
    ...(previousPack.origin ? { origin: previousPack.origin } : {}),
    ...(previousPack.bootstrapFingerprint ? { bootstrapFingerprint: previousPack.bootstrapFingerprint } : {}),
    artifactControls: { ...(previousPack.artifactControls ?? task.contextControls ?? {}) },
    reviewedRelationshipsHash: scopeHash(reviewedTaskRelationships(project, task)),
    tokenBudget, estimatedTokens, artifactIds: snapshots.map((entry) => entry.id), includedArtifacts: snapshots,
    contractIds: task.contractIds, findingIds: manifest.findings.map((entry) => entry.id), evidenceIds: manifest.evidenceIds,
    gitRevision: revision, sourceRevision: revision, sourceFingerprint, changedArtifactIds: changedArtifacts.map((entry) => entry.id),
    freshness: { status: "current", refreshedAt: now, changedArtifacts: changedArtifacts.length },
    createdAt: now, updatedAt: now
  };
  if (previousId) {
    const prior = (project.contextPacks ?? []).find((entry) => entry.id === previousId);
    if (prior) prior.supersededBy = contextPackId;
  }
  task.contextPackId = contextPackId;
  task.contextPack = contextPack;
  manifest.id = contextPackId;
  manifest.generation = generation;
  project.contextPacks ??= [];
  project.contextPacks.unshift(contextPack);

  if (changedArtifacts.length) {
    task.staleVerificationReceiptIds = [...new Set([...(task.staleVerificationReceiptIds ?? []), ...(task.verificationReceiptIds ?? [])])];
    for (const contract of linkedContracts) if (contract.latestVerificationReceiptId) contract.state = "Stale";
  }
  const plan = ensureTaskVerificationPlan(project, task);
  manifest.freshness = contextPack.freshness;
  manifest.telemetry = { ...manifest.telemetry, estimatedTokens, tokenBudget };
  return { task, contextPack, manifest, plan, changedArtifacts, autoLinkedContractIds: task.contractIds };
}

export function markStaleTaskContexts(project) {
  const current = taskContextSourceFingerprint(project);
  let stale = 0;
  for (const task of project.tasks ?? []) {
    if (crossRepositoryTask(project,task)) continue;
    const pack = (project.contextPacks ?? []).find((entry) => entry.id === task.contextPackId) ?? (project.contextPacks ?? []).filter((entry) => entry.taskId === task.id).sort((a, b) => Number(b.generation ?? 0) - Number(a.generation ?? 0))[0] ?? task.contextPack;
    if (!pack) continue;
    if (pack.sourceFingerprint && pack.sourceFingerprint === current) continue;
    task.contextStatus = "stale";
    stale += 1;
  }
  return stale;
}
