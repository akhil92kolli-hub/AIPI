import crypto from "node:crypto";
import { saveTeamMemory } from "./team-memory.mjs";
import { stableEnvironmentFingerprint } from "./contracts-evidence.mjs";
import { promoteRuntimeEdge } from "./knowledge-graph.mjs";
import { sanitizeEvidencePayload } from "./security-redactor.mjs";
import { normalizeTaskIntent } from "./task-intent.mjs";
import { evaluateDeploymentGate } from "./deployment-gate.mjs";
import { crossRepositoryTask, resolveTaskWorkspace, workspaceScopeSnapshot, scopeHash } from "./task-workspace.mjs";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"]);
const isoNow = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function projectGitRevision(project) {
  return project.sourceContext?.gitRevision
    ?? project.sourceContext?.git?.find((entry) => entry.commit)?.commit
    ?? project.sourceContext?.lastScannedAt
    ?? "unindexed";
}

function activeEnvironment(project) {
  return project.environments?.find((entry) => entry.id === project.activeEnvironmentId)
    ?? project.environments?.[0]
    ?? { id: "default" };
}

function environmentTargets(environment) {
  const serviceUrls = (environment.services ?? []).filter((entry) => entry.enabled !== false).map((entry) => entry.baseUrl);
  const variableUrls = (environment.variables ?? []).filter((entry) => entry.enabled !== false && /(?:base|service).*url/i.test(entry.key)).map((entry) => entry.value);
  return [...serviceUrls, ...variableUrls].filter(Boolean);
}

function isLocalEnvironment(environment) {
  const targets = environmentTargets(environment);
  if (!targets.length) return false;
  return targets.every((value) => {
    try { return ["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname); }
    catch { return false; }
  });
}

function configuredTestCommand(project, task) {
  // A workspace task may opt into one reviewed command per repository.  Never
  // borrow another repository's command merely because the task spans both.
  return task.repositoryTestCommands?.[project.id] ?? task.testCommand ?? task.verificationTestCommand ?? project.verification?.testCommand ?? null;
}

function linkedStructuralArtifacts(project, task) {
  const selected = new Set(task.artifactIds ?? []);
  const entries = [
    ...(project.sourceContext?.artifacts ?? []).map(entry => ({ ...entry, kind: entry.kind ?? "artifact", taskArtifactId: `${entry.kind ?? "artifact"}:${entry.id}` })),
    ...(project.sourceContext?.frontendCalls ?? []).map(entry => ({ ...entry, kind: "consumer", taskArtifactId: `consumer:${entry.id}` })),
    ...(project.sourceContext?.endpoints ?? []).map(entry => ({ ...entry, kind: "endpoint", taskArtifactId: `endpoint:${entry.id}` }))
  ];
  const allowed = new Set(["component", "page", "consumer", "test", "endpoint"]);
  return entries.filter(entry => allowed.has(entry.kind) && (selected.has(entry.id) || selected.has(entry.taskArtifactId)));
}

function structuralSummary(artifacts) {
  const counts = new Map();
  for (const artifact of artifacts) counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`).join(", ");
}

function requestForContract(project, contract, task) {
  const requestIds = new Set(contract?.sourceRequestIds ?? []);
  return (project.requests ?? []).find(request => task?.requestIds?.includes(request.id) && (requestIds.has(request.id) || request.contractId === contract?.id))
    ?? (project.requests ?? []).find((request) => requestIds.has(request.id))
    ?? (project.requests ?? []).find((request) => request.contractId === contract?.id)
    ?? null;
}

function isUnresolvedMismatch(finding, contractId) {
  if (finding.contractId !== contractId || ["resolved", "dismissed", "closed"].includes(String(finding.status).toLowerCase())) return false;
  const description = `${finding.type ?? ""} ${finding.title ?? ""}`;
  return /(contract|schema).*(mismatch|drift|incompat)|(mismatch|drift|incompat).*(contract|schema)/i.test(description);
}

function redactHeaders(headers, redactedKeys) {
  if (Array.isArray(headers)) {
    return headers.map((header) => {
      const key = String(header?.key ?? header?.name ?? "");
      if (!SENSITIVE_HEADERS.has(key.toLowerCase())) return { ...header };
      redactedKeys.add(key);
      return { ...header, value: "[REDACTED]" };
    });
  }
  if (!headers || typeof headers !== "object") return headers ?? {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) return [key, value];
    redactedKeys.add(key);
    return [key, "[REDACTED]"];
  }));
}

function bodyPreview(value) {
  if (value == null) return "";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.slice(0, 4096);
}

function responsePayload(result) {
  if (result?.json !== undefined) return result.json;
  try { return typeof result?.body === "string" ? JSON.parse(result.body) : result?.body; }
  catch { return undefined; }
}

function linkedSchemas(project, contract) {
  const endpoints = (project.sourceContext?.endpoints ?? []).filter((entry) => contract.sourceArtifactIds?.includes(entry.id));
  const endpointIds = new Set(endpoints.map((entry) => entry.id));
  const sources = new Set(endpoints.map((entry) => entry.source).filter(Boolean));
  return (project.sourceContext?.schemas ?? []).filter((schema) => endpointIds.has(schema.endpointId) || sources.has(schema.source) || contract.schemaIds?.includes(schema.id));
}

function defaultContractValidation(project, contract, replayResult) {
  const unresolved = (project.findings ?? []).filter((finding) => isUnresolvedMismatch(finding, contract.id));
  if (unresolved.length) return { passed: false, findingIds: unresolved.map((finding) => finding.id), reason: `${unresolved.length} unresolved schema or contract mismatch finding(s).` };
  const schemas = linkedSchemas(project, contract);
  if (!schemas.length) return { skipped: true, passed: false, reason: "No indexed response schema is linked to this contract." };
  const payload = responsePayload(replayResult);
  if (payload === undefined) return { passed: false, reason: "The replay response could not be parsed for schema validation." };
  const candidate = Array.isArray(payload) ? payload[0] : payload;
  const fields = [...new Map(schemas.flatMap((schema) => schema.fields ?? schema.columns ?? []).filter((field) => field.name).map((field) => [field.name, field])).values()];
  const requiredFields = fields.filter((field) => field.required !== false && field.nullable !== true).map((field) => field.name);
  const missingFields = requiredFields.filter((field) => !candidate || typeof candidate !== "object" || !(field in candidate));
  const typeMismatches = fields.filter((field) => candidate && typeof candidate === "object" && field.name in candidate && candidate[field.name] != null).flatMap((field) => {
    const expected = String(field.type ?? field.schema?.type ?? "").toLowerCase();
    const value = candidate[field.name];
    const matches = !expected
      || (["integer", "number", "float", "double"].includes(expected) && typeof value === "number")
      || (["boolean", "bool"].includes(expected) && typeof value === "boolean")
      || (["array", "list"].includes(expected) && Array.isArray(value))
      || (["object", "record", "json"].includes(expected) && typeof value === "object" && !Array.isArray(value))
      || (["string", "uuid", "date", "datetime"].includes(expected) && typeof value === "string");
    return matches ? [] : [{ field: field.name, expected, actual: Array.isArray(value) ? "array" : typeof value }];
  });
  const passed = missingFields.length === 0 && typeMismatches.length === 0;
  return { passed, schemaIds: schemas.map((schema) => schema.id), missingFields, typeMismatches, reason: missingFields.length ? `Response is missing required schema field(s): ${missingFields.join(", ")}.` : typeMismatches.length ? `Response field type mismatch: ${typeMismatches.map((entry) => `${entry.field} expected ${entry.expected}, received ${entry.actual}`).join("; ")}.` : null };
}

function replayEvidence(project, task, contract, request, result, revision, environmentId) {
  const redactedKeys = new Set();
  const requestSnapshot = {
    method: request?.method ?? contract.method,
    url: result?.request?.url ?? request?.url ?? contract.route,
    headers: redactHeaders(result?.request?.headers ?? request?.headers ?? {}, redactedKeys),
    bodyPreview: bodyPreview(result?.request?.body ?? request?.body?.content ?? request?.body)
  };
  const responseSnapshot = {
    status: result?.status ?? null,
    headers: redactHeaders(result?.headers ?? result?.response?.headers ?? {}, redactedKeys),
    bodyPreview: bodyPreview(result?.body ?? result?.json ?? result?.response?.body ?? result?.error)
  };
  return {
    id: newId("evidence"), projectId: project.id, taskId: task.id, contractId: contract.id,
    contractRevisionId: contract.currentRevisionId ?? null, type: "api-execution", origin: "verification-runner",
    sourceRevision: revision, environmentFingerprint: environmentId, recordedAt: isoNow(),
    request: { id: request?.id ?? null, method: request?.method ?? contract.method, route: contract.route },
    requestSnapshot, responseSnapshot,
    result: { status: result?.status ?? null, passed: result?.passed !== false && result?.ok !== false && !result?.error, error: result?.error ?? null, elapsedMs: result?.elapsed_ms ?? result?.elapsedMs ?? null },
    redactionManifest: { version: 1, redactedKeys: [...redactedKeys].sort((a, b) => a.localeCompare(b)), plaintextSecretsPersisted: false }
  };
}

export function ensureTaskVerificationPlan(project, task) {
  if (!project || !task) throw new TypeError("A project and task are required.");
  if (crossRepositoryTask(project, task)) {
    const scope=resolveTaskWorkspace(project,task), snapshot=workspaceScopeSnapshot(project,task);
    const members=scope.projects.filter(p=>p.targets.length || p.task.testCommand || p.task.verificationTestCommand);
    const plans=members.map(({project:member,task:local})=>({projectId:member.id,projectName:member.name,...ensureTaskVerificationPlan(member,local)}));
    const steps=plans.flatMap(p=>p.steps.map(s=>({...s,id:`${p.projectId}:${s.id}`,localStepId:s.id,projectId:p.projectId,projectName:p.projectName,environmentId:p.environmentId})));
    for(const p of plans) if(p.steps.some(s=>s.type==='component-structure') && !p.steps.some(s=>s.type==='test-log')) steps.push({id:`${p.projectId}:behavior-proof`,type:'behavior-proof',projectId:p.projectId,projectName:p.projectName,required:true});
    for(const [i,error] of scope.errors.entries()) steps.push({id:`workspace:missing:${i}`,type:'context-unavailable',reason:error,required:true});
    const targetSnapshotHash=`sha256:${scopeHash([task.id,task.contextPackId,task.description,task.acceptanceCriteria,snapshot,plans.map(p=>p.targetSnapshotHash),steps])}`;
    task.verificationPlan={id:task.verificationPlanId??newId('verifyplan'),taskId:task.id,intent:task.intent,
      workspace:snapshot,repositoryPlans:plans,steps,stepIds:steps.map(s=>s.id),targetSnapshotHash,
      gitRevision:projectGitRevision(project),environmentId:project.activeEnvironmentId,
      environmentFingerprint:scopeHash(plans.map(p=>[p.projectId,p.environmentFingerprint])),nonLocalEnvironment:plans.some(p=>p.nonLocalEnvironment),
      createdAt:task.verificationPlan?.createdAt??isoNow(),updatedAt:isoNow()};
    task.verificationPlanId=task.verificationPlan.id;return task.verificationPlan;
  }
  const gitRevision = projectGitRevision(project);
  const environment = activeEnvironment(project);
  const environmentId = environment.id;
  const environmentFingerprint = stableEnvironmentFingerprint(project, environmentId);
  const nonLocalEnvironment = !isLocalEnvironment(environment);
  const contracts = (task.contractIds ?? []).map((id) => project.contracts?.find((contract) => contract.id === id)).filter(Boolean);
  const intent = normalizeTaskIntent(task.intent);
  const apiVerification = ["api-contract", "new-contract", "full-stack"].includes(intent);
  const steps = apiVerification ? contracts.flatMap((contract) => {
    const request = requestForContract(project, contract, task);
    const method = String(request?.method ?? contract.method ?? "GET").toUpperCase();
    return [
      {
        id: `verify:${contract.id}:api-replay`, type: "api-replay", contractId: contract.id,
        requestId: request?.id ?? null, method, required: true,
        requiresStateChangeApproval: STATE_CHANGING_METHODS.has(method)
      },
      { id: `verify:${contract.id}:contract-diff`, type: "contract-diff", contractId: contract.id, required: true, requiresStateChangeApproval: false }
    ];
  }) : [];
  const structuralArtifacts = linkedStructuralArtifacts(project, task);
  const structuralArtifactIds = structuralArtifacts.map((entry) => entry.taskArtifactId);
  if (intent === "ui-component") steps.push({ id: `verify:${task.id}:component-structure`, type: "component-structure", contractId: null, artifactIds: structuralArtifactIds, structuralKinds: [...new Set(structuralArtifacts.map(entry => entry.kind))], required: true, requiresStateChangeApproval: false });
  if (intent === "full-stack" && structuralArtifacts.length) steps.push({ id: `verify:${task.id}:component-structure`, type: "component-structure", contractId: contracts[0]?.id ?? null, artifactIds: structuralArtifactIds, structuralKinds: [...new Set(structuralArtifacts.map(entry => entry.kind))], required: true, requiresStateChangeApproval: false });
  if (["api-contract", "new-contract"].includes(intent) && !contracts.length) steps.push({ id: `verify:${task.id}:api-contract-required`, type: "api-contract-required", contractId: null, required: true, requiresStateChangeApproval: false });
  if (intent === "full-stack" && !contracts.length) steps.push({ id: `verify:${task.id}:api-contract-required`, type: "api-contract-required", contractId: null, required: true, requiresStateChangeApproval: false });
  if (intent === "commit-pr") steps.push({ id: `verify:${task.id}:receipt-proof`, type: "receipt-proof", contractId: contracts[0]?.id ?? null, required: true, requiresStateChangeApproval: false });
  if (intent === "deployment-automation") steps.push({ id: `verify:${task.id}:deployment-preflight`, type: "deployment-preflight", contractId: contracts[0]?.id ?? null, required: true, requiresStateChangeApproval: false });
  if (intent === "discovery") steps.push({ id: `verify:${task.id}:indexed-evidence`, type: "indexed-evidence", contractId: contracts[0]?.id ?? null, artifactIds: task.artifactIds ?? [], required: true, requiresStateChangeApproval: false });
  const testCommand = configuredTestCommand(project, task);
  if (testCommand) steps.push({ id: `verify:${task.id}:test-log`, type: "test-log", contractId: contracts[0]?.id ?? null, required: true, requiresStateChangeApproval: false, command: testCommand });
  const stepIds = steps.map((step) => step.id);
  const contractRevisionIds = contracts.map((contract) => contract.currentRevisionId ?? null);
  const targetSnapshotHash = `sha256:${digest({
    taskId: task.id, title: task.title ?? "", description: task.description ?? "", contextPackId: task.contextPackId ?? null,
    intent, acceptanceCriteria: task.acceptanceCriteria ?? [], artifactIds: task.artifactIds ?? [],
    contractIds: task.contractIds ?? [], testCommand: configuredTestCommand(project, task) ?? null,
    gitRevision, contractRevisionIds, environmentFingerprint,
    steps: steps.map((step) => ({
      id: step.id, type: step.type, contractId: step.contractId ?? null,
      requestId: step.requestId ?? null, method: step.method ?? null,
      artifactIds: step.artifactIds ?? [], structuralKinds: step.structuralKinds ?? [], command: step.command ?? null,
      required: step.required !== false, requiresStateChangeApproval: step.requiresStateChangeApproval === true
    }))
  })}`;
  const previous = task.verificationPlan ?? {};
  task.verificationPlan = {
    id: task.verificationPlanId ?? previous.id ?? newId("verifyplan"), taskId: task.id,
    intent, gitRevision, contractRevisionIds, environmentId, environmentFingerprint, nonLocalEnvironment, stepIds, steps, targetSnapshotHash,
    createdAt: previous.createdAt ?? isoNow(), updatedAt: isoNow()
  };
  task.verificationPlanId = task.verificationPlan.id;
  return task.verificationPlan;
}

export async function executeTaskVerificationPlan(project, task, options = {}) {
  if (crossRepositoryTask(project,task)) return executeWorkspaceVerification(project,task,options);
  const plan = ensureTaskVerificationPlan(project, task);
  const startRevision = projectGitRevision(project);
  const checkResults = [];
  const evidenceIds = [];
  const replayResults = new Map();
  const testEvidenceIds = [];
  let cancelled = false;
  const recordCheckResult = async (result) => {
    checkResults.push(result);
    await options.onCheckResult?.(result);
  };
  let replayEvidenceId = null;
  let diffEvidenceId = null;

  project.evidence ??= [];
  if (!plan.steps.length) {
    await recordCheckResult({ stepId: "verification-plan", type: "verification-plan", contractId: null, status: "failed", reason: "No linked contracts are available for verification." });
  }
  for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
    const step = plan.steps[stepIndex];
    if (await options.shouldCancel?.()) {
      cancelled = true;
      for (const pendingStep of plan.steps.slice(stepIndex)) await recordCheckResult({ stepId: pendingStep.id, type: pendingStep.type, contractId: pendingStep.contractId ?? null, status: "skipped", reason: "Verification job cancelled before this check started." });
      break;
    }
    await options.onProgress?.({ currentStepId: step.id, currentStepType: step.type, completedChecks: checkResults.length, totalChecks: plan.steps.length });
    const contract = project.contracts?.find((entry) => entry.id === step.contractId);
    if (step.type === "component-structure") {
      const linked = linkedStructuralArtifacts(project, task).filter((artifact) => step.artifactIds?.includes(artifact.taskArtifactId));
      const passed = linked.length > 0;
      await recordCheckResult({ stepId: step.id, type: step.type, contractId: step.contractId, status: passed ? "passed" : "failed", reason: passed ? `Linked indexed implementation evidence: ${structuralSummary(linked)}.` : "Link an indexed endpoint, component, page, frontend caller, or test before verifying implementation structure." });
      continue;
    }
    if (step.type === "api-contract-required") {
      await recordCheckResult({ stepId: step.id, type: step.type, contractId: null, status: "failed", reason: "API-contract and full-stack verification require at least one linked K Map contract." });
      continue;
    }
    if (step.type === "receipt-proof") {
      const receipt = (project.verificationReceipts ?? []).find((entry) => {
        if (!((entry.result === "Verified" || entry.status === "passed")
          && (entry.taskId === task.id || task.contractIds?.includes(entry.contractId))
          && entry.sourceRevision === startRevision)) return false;
        try { return options.acceptReceipt?.(entry, { project, task, sourceRevision: startRevision }) === true; }
        catch { return false; }
      });
      await recordCheckResult({ stepId: step.id, type: step.type, contractId: step.contractId, status: receipt ? "passed" : "failed", receiptId: receipt?.id ?? null, reason: receipt ? null : "No accepted VerificationReceipt matches the current Git revision and task scope." });
      continue;
    }
    if (step.type === "deployment-preflight") {
      const gate = await evaluateDeploymentGate(project, task, { checkEnvironment: options.checkEnvironmentHealth, acceptReceipt: options.acceptReceipt });
      task.deploymentGate = gate;
      await recordCheckResult({ stepId: step.id, type: step.type, contractId: step.contractId, status: gate.unlocked ? "passed" : "failed", reason: gate.reasons.join(" ") || null, deploymentGate: gate });
      continue;
    }
    if (step.type === "indexed-evidence") {
      const passed = Boolean(step.artifactIds?.length || task.contractIds?.length || task.findingIds?.length);
      await recordCheckResult({ stepId: step.id, type: step.type, contractId: step.contractId, status: passed ? "passed" : "failed", reason: passed ? null : "Link indexed source, findings, or contracts before closing discovery work." });
      continue;
    }
    if (!contract && step.type !== "test-log") {
      await recordCheckResult({ stepId: step.id, type: step.type, contractId: step.contractId, status: "failed", reason: "Linked contract was not found." });
      continue;
    }
    if (step.type === "api-replay") {
      const stateChangeAllowed = options.allowStateChangingReplay === true || options.approveStateChangingReplays === true;
      const approvedSnapshotHash = options.targetSnapshotHash ?? options.approvedTargetSnapshotHash;
      if (step.requiresStateChangeApproval && (!stateChangeAllowed || approvedSnapshotHash !== plan.targetSnapshotHash)) {
        await recordCheckResult({ stepId: step.id, type: step.type, contractId: contract.id, status: "skipped", reason: "State-changing API replay requires explicit developer authorization matching the frozen snapshot hash." });
        continue;
      }
      const request = requestForContract(project, contract, task);
      if (!request) {
        await recordCheckResult({ stepId: step.id, type: step.type, contractId: contract.id, status: "failed", reason: "No saved request is linked to this contract." });
        continue;
      }
      if (typeof options.executeApiReplay !== "function") {
        await recordCheckResult({ stepId: step.id, type: step.type, contractId: contract.id, status: "failed", reason: "API replay executor is unavailable." });
        continue;
      }
      try {
        const result = await options.executeApiReplay(request, { project, task, contract, step });
        replayResults.set(contract.id, result);
        const evidence = sanitizeEvidencePayload(replayEvidence(project, task, contract, request, result, startRevision, plan.environmentFingerprint));
        project.evidence.unshift(evidence);
        evidenceIds.push(evidence.id);
        replayEvidenceId ??= evidence.id;
        const passed = evidence.result.passed;
        if (passed) {
          const linkedTest = (project.sourceContext?.artifacts ?? []).find((artifact) => artifact.kind === "test" && task.artifactIds?.some((id) => id === artifact.id || id === `test:${artifact.id}`));
          promoteRuntimeEdge(project, { contractId: contract.id, handlerFile: contract.implementation?.source, testFile: linkedTest?.source, gitRevision: startRevision });
        }
        await recordCheckResult({ stepId: step.id, type: step.type, contractId: contract.id, status: passed ? "passed" : "failed", evidenceId: evidence.id, reason: passed ? null : (result?.error ?? `API replay returned HTTP ${result?.status ?? "error"}.`) });
      } catch (error) {
        await recordCheckResult({ stepId: step.id, type: step.type, contractId: contract.id, status: "failed", reason: error.message });
      }
      continue;
    }

    if (step.type === "test-log") {
      if (typeof options.executeTestCommand !== "function") {
        await recordCheckResult({ stepId: step.id, type: step.type, contractId: step.contractId, status: "failed", reason: "A linked test command is configured, but the test executor is unavailable." });
        continue;
      }
      try {
        const testResult = await options.executeTestCommand(step.command, { project, task, step });
        const exitCode = testResult?.exitCode ?? testResult?.code;
        const passed = testResult?.passed !== false && testResult?.timedOut !== true
          && (exitCode === 0 || (exitCode == null && testResult?.passed === true));
        const evidence = sanitizeEvidencePayload({
          id: newId("evidence"), projectId: project.id, taskId: task.id, contractId: step.contractId,
          contractRevisionId: contract?.currentRevisionId ?? null, type: "test-log", origin: "verification-runner",
          sourceRevision: startRevision, environmentFingerprint: plan.environmentFingerprint, recordedAt: isoNow(),
          request: { id: null, method: "TEST", route: String(typeof step.command === "string" ? step.command : step.command?.command ?? "linked test") },
          command: step.command, outputPreview: bodyPreview(testResult?.output ?? testResult?.stdout ?? testResult?.stderr ?? ""),
          result: { passed, exitCode: testResult?.exitCode ?? testResult?.code ?? null, timedOut: testResult?.timedOut === true, errorCode: testResult?.errorCode ?? null, durationMs: testResult?.durationMs ?? null }
        });
        project.evidence.unshift(evidence);
        evidenceIds.push(evidence.id);
        testEvidenceIds.push(evidence.id);
        await recordCheckResult({ stepId: step.id, type: step.type, contractId: step.contractId, status: passed ? "passed" : "failed", evidenceId: evidence.id, exitCode: evidence.result.exitCode, timedOut: evidence.result.timedOut, durationMs: evidence.result.durationMs, outputPreview: evidence.outputPreview, reason: passed ? null : evidence.result.timedOut ? "Linked test command timed out." : `Linked test command exited with ${evidence.result.exitCode ?? evidence.result.errorCode ?? "an error"}.` });
      } catch (error) {
        await recordCheckResult({ stepId: step.id, type: step.type, contractId: step.contractId, status: "failed", reason: error.message });
      }
      continue;
    }

    const replayResult = replayResults.get(contract.id);
    let validation;
    if (!replayResult) validation = { skipped: true, passed: false, reason: "Contract schema validation requires an executed API replay." };
    else if (typeof options.validateContractResponse === "function") validation = await options.validateContractResponse(replayResult, { project, task, contract, step });
    else validation = defaultContractValidation(project, contract, replayResult);
    validation ??= { passed: false, reason: "Contract schema validation returned no result." };
    const evidence = sanitizeEvidencePayload({
      id: newId("evidence"), projectId: project.id, taskId: task.id, contractId: contract.id,
      contractRevisionId: contract.currentRevisionId ?? null, type: "contract-diff", origin: "verification-runner",
      sourceRevision: startRevision, environmentFingerprint: plan.environmentFingerprint, recordedAt: isoNow(),
      request: { id: null, method: "DIFF", route: contract.route },
      findingIds: validation.findingIds ?? [], schemaIds: validation.schemaIds ?? [], missingFields: validation.missingFields ?? [], typeMismatches: validation.typeMismatches ?? [], result: { passed: validation.passed === true, skipped: validation.skipped === true }
    });
    project.evidence.unshift(evidence);
    evidenceIds.push(evidence.id);
    diffEvidenceId ??= evidence.id;
    await recordCheckResult({ stepId: step.id, type: step.type, contractId: contract.id, status: validation.skipped ? "skipped" : validation.passed ? "passed" : "failed", evidenceId: evidence.id, reason: validation.reason ?? null });
  }

  if (projectGitRevision(project) !== startRevision) {
    await recordCheckResult({ stepId: "revision-guard", type: "revision-guard", contractId: null, status: "failed", reason: "The repository revision changed while verification was running." });
  }
  const failed = checkResults.filter((result) => result.status === "failed").length;
  const skipped = checkResults.filter((result) => result.status === "skipped").length;
  const receiptResult = failed ? "Failed" : skipped ? "Verification pending" : "Verified";
  const primaryContractId = task.contractIds?.[0] ?? null;
  const primaryContract = project.contracts?.find((contract) => contract.id === primaryContractId) ?? null;
  const now = isoNow();
  const receipt = {
    id: newId("receipt"), taskId: task.id, contractId: primaryContractId,
    contractRevisionId: primaryContract?.currentRevisionId ?? null, sourceRevision: startRevision,
    contextPackId: options.contextPackId ?? task.contextPackId ?? null, handoffId: options.handoffId ?? null,
    environmentFingerprint: plan.environmentFingerprint, replayEvidenceId, diffEvidenceId,
    testEvidenceIds,
    checkResults: checkResults.map((result) => Object.freeze({ ...result })), result: receiptResult, verifiedAt: now
  };
  Object.freeze(receipt.checkResults);
  Object.freeze(receipt);
  project.verificationReceipts ??= [];
  project.verificationReceipts.unshift(receipt);
  task.verificationReceiptIds = [receipt.id, ...(task.verificationReceiptIds ?? []).filter((id) => id !== receipt.id)];
  project.verificationRuns ??= [];
  const runId = newId("verifyrun");
  project.verificationRuns.unshift({ id: runId, taskId: task.id, projectId: project.id,
    contextPackId: receipt.contextPackId, handoffId: receipt.handoffId, receiptId: receipt.id,
    planHash: plan.targetSnapshotHash, sourceRevision: startRevision,
    status: receiptResult === "Verified" ? "passed" : receiptResult === "Failed" ? "failed" : "incomplete",
    checks: checkResults.map(result => ({ ...result })), finishedAt: now });
  task.verificationRunIds = [runId, ...(task.verificationRunIds ?? []).filter(id => id !== runId)];
  task.runtimeEvidenceIds = [...new Set([...evidenceIds, ...(task.runtimeEvidenceIds ?? [])])];
  task.updatedAt = now;
  if (primaryContract) {
    const previousState = primaryContract.state;
    primaryContract.latestVerificationReceiptId = receipt.id;
    if (receiptResult === "Verified") primaryContract.state = "Verified";
    else if (receiptResult === "Failed" && previousState === "Verified") primaryContract.state = "Regressed";
    else if (receiptResult === "Verification pending") primaryContract.state = "Verification pending";
  }
  if (!options.deferTeamMemory) await saveTeamMemory(project);
  return { receipt, plan, checkResults, cancelled };
}

async function executeWorkspaceVerification(project,task,options) {
  const plan=ensureTaskVerificationPlan(project,task), checks=[], receipts=[], evidence=[];
  const scope=resolveTaskWorkspace(project,task);
  if(scope.errors.length) throw new Error(scope.errors.join(' '));
  if(options.targetSnapshotHash && options.targetSnapshotHash!==plan.targetSnapshotHash) throw new Error('Workspace verification plan changed. Review all repository targets again.');
  let cancelled=false;
  for(const memberPlan of plan.repositoryPlans) {
    if(await options.shouldCancel?.()) {cancelled=true;break;}
    const member=scope.projects.find(p=>p.project.id===memberPlan.projectId);
    const isolated=structuredClone({...member.project,evidence:[],verificationReceipts:[],tasks:[member.task]});
    const result=await executeTaskVerificationPlan(isolated,isolated.tasks[0],{
      ...options, deferTeamMemory:true, contextPackId:task.contextPackId,
      allowStateChangingReplay:options.allowStateChangingReplay===true && options.targetSnapshotHash===plan.targetSnapshotHash,
      approveStateChangingReplays:false,targetSnapshotHash:memberPlan.targetSnapshotHash,
      onProgress:progress=>options.onProgress?.({...progress,currentStepId:`${member.project.id}:${progress.currentStepId}`,completedChecks:checks.length,totalChecks:plan.steps.length}),
      onCheckResult:async check=>{const qualified={...check,stepId:`${member.project.id}:${check.stepId}`,projectId:member.project.id,environmentId:memberPlan.environmentId}; checks.push(qualified);await options.onCheckResult?.(qualified);}
    });
    receipts.push({...result.receipt,projectId:member.project.id});
    evidence.push(...isolated.evidence.map(e=>({...e,taskOwnerProjectId:project.id})));
    cancelled ||= result.cancelled;
  }
  for(const step of plan.steps.filter(s=>!checks.some(c=>c.stepId===s.id))) {
    const check={stepId:step.id,projectId:step.projectId,type:step.type,status:'skipped',reason:cancelled?'Verification cancelled.':step.type==='behavior-proof'?'Configure and run a test command in this repository to verify behavior. Indexed source alone is not proof.':'Repository check did not execute.'};
    checks.push(check);await options.onCheckResult?.(check);
  }
  if(ensureTaskVerificationPlan(project,task).targetSnapshotHash!==plan.targetSnapshotHash) checks.push({stepId:'workspace-revision-guard',type:'revision-guard',status:'failed',reason:'Workspace context changed during verification.'});
  const receipt={id:newId('receipt'),taskId:task.id,projectId:project.id,contractId:null,
    contextPackId:task.contextPackId,handoffId:options.handoffId??null,sourceRevision:projectGitRevision(project),
    workspace:plan.workspace,planHash:plan.targetSnapshotHash,repositoryReceipts:receipts,
    checkResults:checks,result:checks.some(c=>c.status==='failed')?'Failed':checks.some(c=>c.status==='skipped')||!checks.length?'Verification pending':'Verified',
    testEvidenceIds:evidence.map(e=>e.id),verifiedAt:isoNow(),environmentFingerprint:plan.environmentFingerprint};
  project.evidence??=[];project.evidence.unshift(...evidence);
  project.verificationReceipts??=[];project.verificationReceipts.unshift(receipt);
  task.verificationReceiptIds=[receipt.id,...(task.verificationReceiptIds??[])];
  project.verificationRuns??=[];
  const runId=newId('verifyrun');
  project.verificationRuns.unshift({id:runId,taskId:task.id,projectId:project.id,contextPackId:receipt.contextPackId,
    handoffId:receipt.handoffId,receiptId:receipt.id,planHash:plan.targetSnapshotHash,
    sourceRevision:receipt.sourceRevision,status:receipt.result==='Verified'?'passed':receipt.result==='Failed'?'failed':'incomplete',
    checks:checks.map(check=>({...check})),finishedAt:receipt.verifiedAt});
  task.verificationRunIds=[runId,...(task.verificationRunIds??[]).filter(id=>id!==runId)];
  task.runtimeEvidenceIds=[...new Set([...evidence.map(e=>e.id),...(task.runtimeEvidenceIds??[])])];
  task.updatedAt=isoNow();return {receipt,plan,checkResults:checks,cancelled};
}
