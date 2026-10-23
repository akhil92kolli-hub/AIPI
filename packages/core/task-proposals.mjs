import crypto from "node:crypto";
import { taskArtifacts, normalizeTasks } from "./task-context.mjs";

const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);
const uniqueStrings = (value, maxItems, maxLength = 160) => [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
const titleTokens = (value) => new Set(cleanText(value, 180).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((token) => token.length > 2));
const overlap = (left, right) => {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size >= 0.72;
};

export function persistTaskProposals(project, input) {
  normalizeTasks(project);
  const request = cleanText(input.request, 4000);
  const idempotencyKey = cleanText(input.idempotencyKey, 128);
  const proposals = Array.isArray(input.proposals) ? input.proposals.slice(0, 5) : [];
  if (!request) throw new Error("A user request is required to preserve proposal provenance.");
  if (!idempotencyKey) throw new Error("An idempotency key is required so retries cannot duplicate proposals.");
  if (!proposals.length) throw new Error("Provide between one and five task proposals.");

  const payloadHash = digest({ request, proposals });
  project.taskProposalBatches ??= [];
  const priorBatch = project.taskProposalBatches.find((batch) => batch.idempotencyKey === idempotencyKey);
  if (priorBatch) {
    if (priorBatch.payloadHash !== payloadHash) throw new Error("This idempotency key was already used for a different proposal batch.");
    return { proposals: priorBatch.taskIds.map((id) => ({ task: project.tasks.find((task) => task.id === id), created: false })).filter((entry) => entry.task), createdCount: 0, idempotencyKey, replayed: true };
  }

  const artifacts = new Set(taskArtifacts(project).map((entry) => entry.id));
  const contracts = new Set((project.contracts ?? []).map((entry) => entry.id));
  const findings = new Set([...(project.findings ?? []), ...(project.sourceContext?.findings ?? [])].map((entry) => entry.id));
  const now = new Date().toISOString();
  const results = proposals.map((raw, index) => {
    const title = cleanText(raw?.title, 180);
    const description = cleanText(raw?.objective ?? raw?.description, 2000);
    if (!title || !description) throw new Error(`Proposal ${index + 1} needs a title and objective.`);
    const artifactIds = uniqueStrings(raw.artifactIds ?? raw.artifact_ids, 30);
    const contractIds = uniqueStrings(raw.contractIds ?? raw.contract_ids, 20);
    const findingIds = uniqueStrings(raw.findingIds ?? raw.finding_ids, 20);
    if (artifactIds.some((id) => !artifacts.has(id))) throw new Error(`Proposal ${index + 1} cites an artifact outside this project's current index.`);
    if (contractIds.some((id) => !contracts.has(id))) throw new Error(`Proposal ${index + 1} references a contract outside this project.`);
    if (findingIds.some((id) => !findings.has(id))) throw new Error(`Proposal ${index + 1} cites a finding outside this project.`);
    const key = `${idempotencyKey}:${index}`;
    if (![...artifactIds, ...contractIds, ...findingIds].length) throw new Error(`Proposal ${index + 1} must cite at least one indexed artifact, contract, or finding.`);

    const priority = ["low", "medium", "high", "critical"].includes(String(raw.priority).toLowerCase()) ? String(raw.priority).toLowerCase() : "medium";
    const acceptanceCriteria = uniqueStrings(raw.acceptanceCriteria ?? raw.acceptance_criteria, 12, 500);
    if (!acceptanceCriteria.length) throw new Error(`Proposal ${index + 1} must include at least one reviewable acceptance criterion.`);
    const duplicateTaskIds = project.tasks.filter((task) => !task.archivedAt && !["done", "completed", "dismissed", "cancelled"].includes(task.status) && overlap(title, task.title)).map((task) => task.id).slice(0, 5);
    const task = {
      id: `task_${digest([project.id, key]).slice(0, 20)}`,
      projectId: project.id,
      title,
      description,
      status: "proposed",
      source: "agent-proposal",
      proposalKey: key,
      proposal: {
        request,
        createdAt: now,
        createdBy: cleanText(input.agent ?? "mcp-agent", 80),
        model: cleanText(input.model, 120) || null,
        confidence: Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : null,
        rationale: cleanText(raw.rationale, 1000),
        citations: [...artifactIds, ...contractIds, ...findingIds],
        candidateChecks: uniqueStrings(raw.candidateChecks ?? raw.candidate_checks, 8, 240),
        duplicateTaskIds
      },
      intent: cleanText(raw.intent, 48) || "discovery",
      category: cleanText(raw.category, 48) || "feature",
      priority,
      milestoneIds: [],
      contractIds,
      artifactIds,
      findingIds,
      requestIds: [],
      evidenceIds: [],
      runtimeEvidenceIds: [],
      acceptanceCriteria,
      verificationGates: { contract: contractIds.length > 0, requestReplay: false, noExfiltration: true },
      verificationReceiptIds: [],
      verificationRunIds: [],
      externalLinks: [],
      createdAt: now,
      updatedAt: now
    };
    project.tasks.push(task);
    return { task, created: true };
  });
  project.taskProposalBatches.push({ idempotencyKey, payloadHash, taskIds: results.map((entry) => entry.task.id), createdAt: now });
  project.updatedAt = now;
  return { proposals: results, createdCount: results.filter((entry) => entry.created).length, idempotencyKey };
}

export function proposeTasksFromAssessment(state, workspaceId, assessment, { agent = "change-impact-pipeline" } = {}) {
  if (!state || !workspaceId || !assessment) {
    throw new Error("State, workspaceId, and assessment are required to propose tasks from change impact.");
  }
  const providerProjectId = assessment.selection?.projectId;
  const components = Array.isArray(assessment.components) ? assessment.components : [];
  const consumerComponents = components.filter((c) => c.projectId && c.projectId !== providerProjectId);
  if (!consumerComponents.length) {
    return { proposedCount: 0, replayedCount: 0, proposals: [], message: "No downstream consumer projects affected." };
  }

  const byProject = new Map();
  for (const comp of consumerComponents) {
    const list = byProject.get(comp.projectId) ?? [];
    list.push(comp);
    byProject.set(comp.projectId, list);
  }

  const allProposals = [];
  const unresolvedConsumers = [];
  for (const [consumerProjectId, compList] of byProject.entries()) {
    const consumerProject = (state.projects ?? []).find((p) => p.id === consumerProjectId);
    if (!consumerProject) {
      unresolvedConsumers.push({
        projectId: consumerProjectId,
        projectName: consumerProjectId,
        components: compList.map((c) => ({ componentId: c.componentId, label: c.label ?? c.componentId, source: c.source ?? null })),
        status: "source_citation_unresolved",
        reason: "Source citation unresolved",
      });
      continue;
    }

    const consumerArtifacts = new Set(taskArtifacts(consumerProject).map((entry) => entry.id));
    const consumerContracts = new Set((consumerProject.contracts ?? []).map((entry) => entry.id));

    const citedArtifacts = compList.map((c) => c.componentId).filter((id) => consumerArtifacts.has(id));
    const citedContracts = compList.map((c) => c.componentId).filter((id) => consumerContracts.has(id));

    let finalArtifacts = citedArtifacts;
    if (!finalArtifacts.length && !citedContracts.length) {
      const matches = taskArtifacts(consumerProject).filter((artifact) => compList.some((component) =>
        component.source?.path && component.source.path === artifact.source));
      finalArtifacts = matches.slice(0, 5).map((artifact) => artifact.id);
    }

    if (!finalArtifacts.length && !citedContracts.length) {
      unresolvedConsumers.push({
        projectId: consumerProjectId,
        projectName: consumerProject.name ?? consumerProjectId,
        components: compList.map((c) => ({ componentId: c.componentId, label: c.label ?? c.componentId, source: c.source ?? null })),
        status: "source_citation_unresolved",
        reason: "Source citation unresolved",
      });
      continue;
    }

    const changedProviderSummary = assessment.selection?.baseCommit
      ? `revision ${String(assessment.selection.baseCommit).slice(0, 8)}`
      : "recent changes";
    const componentLabels = compList.map((c) => c.label).filter(Boolean).slice(0, 3).join(", ");
    const changeId = assessment.changeId ?? assessment.selection?.baseCommit ?? "change";
    const coordinationOrigin = assessment.originRepositoryId
      ? `${assessment.originRepositoryId}#${assessment.prNumber ?? "local"}`
      : `${providerProjectId ?? "provider"}:${assessment.prNumber ?? changeId}`;
    const coordinationKey = `coord:${digest([workspaceId, coordinationOrigin, consumerProjectId, compList.map((c) => c.componentId).sort()]).slice(0, 32)}`;
    const assessmentDigest = digest([changeId, assessment.selection?.baseCommit ?? null, assessment.selection?.headCommit ?? null, compList.map((c) => [c.componentId, c.coverage?.status ?? null])]).slice(0, 24);

    normalizeTasks(consumerProject);
    const existingCoordTask = (consumerProject.tasks ?? []).find(
      (t) => t.coordinationKey === coordinationKey && !t.archivedAt && !["done", "completed", "dismissed", "cancelled"].includes(t.status)
    );
    if (existingCoordTask) {
      if (existingCoordTask.lastAssessmentDigest === assessmentDigest) {
        allProposals.push({ task: existingCoordTask, created: false, updated: false });
      } else {
        existingCoordTask.assessmentHistory ??= [];
        existingCoordTask.assessmentHistory.push({
          changeId,
          assessmentDigest,
          baseCommit: assessment.selection?.baseCommit ?? null,
          headCommit: assessment.selection?.headCommit ?? null,
          recordedAt: new Date().toISOString(),
        });
        existingCoordTask.lastAssessmentDigest = assessmentDigest;
        existingCoordTask.updatedAt = new Date().toISOString();
        allProposals.push({ task: existingCoordTask, created: false, updated: true });
      }
      continue;
    }

    const idempotencyKey = `impact:${digest([workspaceId, changeId, consumerProjectId, compList.map((c) => c.componentId).sort()]).slice(0, 32)}`;

    const proposalInput = {
      request: `Downstream impact detected in ${consumerProject.name} from provider ${providerProjectId} ${changedProviderSummary}. Affected consumers: ${componentLabels}.`,
      idempotencyKey,
      agent,
      proposals: [
        {
          title: `Update ${consumerProject.name} consumers for ${providerProjectId} API change`,
          objective: `Verify caller contract alignment and rerun regression checks for affected components: ${componentLabels}. Originating provider change: ${changedProviderSummary}.`,
          priority: compList.some((c) => c.coverage?.status === "failed") ? "critical" : "high",
          acceptanceCriteria: [
            `Verify callers in ${consumerProject.name} match updated provider schema and endpoints.`,
            `Ensure all required consumer verification checks pass without regression.`,
          ],
          artifactIds: finalArtifacts,
          contractIds: citedContracts,
          findingIds: [],
          candidateChecks: compList.flatMap((c) => (c.coverage?.checks ?? []).map((ch) => ch.reason ?? ch.requirementId).filter(Boolean)).slice(0, 5),
          rationale: `Change assessment identified ${compList.length} downstream component(s) dependent on the modified provider contract.`,
        },
      ],
    };

    try {
      const result = persistTaskProposals(consumerProject, proposalInput);
      for (const entry of result.proposals) {
        if (entry.task) {
          entry.task.coordinationKey = coordinationKey;
          entry.task.lastAssessmentDigest = assessmentDigest;
          entry.task.assessmentHistory = [{
            changeId,
            assessmentDigest,
            baseCommit: assessment.selection?.baseCommit ?? null,
            headCommit: assessment.selection?.headCommit ?? null,
            recordedAt: new Date().toISOString(),
          }];
        }
      }
      allProposals.push(...result.proposals);
    } catch {
      continue;
    }
  }

  return {
    proposedCount: allProposals.filter((p) => p.created).length,
    replayedCount: allProposals.filter((p) => !p.created).length,
    updatedCount: allProposals.filter((p) => p.updated).length,
    proposals: allProposals,
    unresolvedConsumers,
  };
}
