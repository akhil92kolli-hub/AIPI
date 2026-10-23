import crypto from "node:crypto";
import { bindTaskWorkspace } from "./task-workspace.mjs";
import { normalizeTasks } from "./task-context.mjs";
import { ensureTaskVerificationPlan, executeTaskVerificationPlan, projectGitRevision } from "./verification-runner.mjs";

export const verificationJobRuntimeId = `runner_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
const newId = () => `checkjob_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const now = () => new Date().toISOString();

export function createTaskVerificationJob(project, taskId, input) {
  normalizeTasks(project);
  const task = project.tasks.find((entry) => entry.id === taskId);
  if (!task) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
  const idempotencyKey = String(input.idempotencyKey ?? "").trim().slice(0, 128);
  if (!idempotencyKey) throw new Error("An idempotency key is required to start task checks safely.");
  const plan = ensureTaskVerificationPlan(project, task);
  if (input.contextPackId && input.contextPackId !== task.contextPackId) throw Object.assign(new Error("The task context generation changed. Review the refreshed plan before running checks."), { statusCode: 409, code: "CONTEXT_STALE" });
  if (!input.targetSnapshotHash || input.targetSnapshotHash !== plan.targetSnapshotHash) throw Object.assign(new Error("The verification plan changed. Review the current plan before running checks."), { statusCode: 409, code: "PLAN_STALE" });
  const prior = (project.verificationJobs ?? []).find((entry) => entry.taskId === task.id && entry.idempotencyKey === idempotencyKey);
  if (prior) {
    if (prior.targetSnapshotHash !== plan.targetSnapshotHash || prior.allowStateChangingReplay !== (input.allowStateChangingReplay === true)) throw Object.assign(new Error("This idempotency key was already used for a different verification request."), { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });
    return { job: prior, replayed: true };
  }
  project.verificationJobs ??= [];
  const timestamp = now();
  const job = {
    id: newId(), projectId: project.id, taskId: task.id, status: "queued",
    contextPackId: task.contextPackId ?? null, handoffId: input.handoffId ?? null,
    idempotencyKey, targetSnapshotHash: plan.targetSnapshotHash,
    sourceRevision: plan.gitRevision, environmentFingerprint: plan.environmentFingerprint,
    plan: structuredClone(plan), allowStateChangingReplay: input.allowStateChangingReplay === true,
    approval: { actor: input.approvedBy ?? "developer", targetSnapshotHash: plan.targetSnapshotHash, allowStateChangingReplay: input.allowStateChangingReplay === true, approvedAt: timestamp, oneRun: true },
    checkResults: [], progress: { completed: 0, total: plan.steps.length, currentStepId: null },
    createdAt: timestamp, updatedAt: timestamp
  };
  project.verificationJobs.unshift(job);
  project.verificationJobs = project.verificationJobs.slice(0, 100);
  return { job, replayed: false };
}

export async function runTaskVerificationJob(jobId, { loadState, mutateState, createExecutors }) {
  let initial = await loadState();
  const initialProject = initial.projects.find((entry) => entry.verificationJobs?.some((job) => job.id === jobId));
  const initialJob = initialProject?.verificationJobs.find((job) => job.id === jobId);
  if (!initialJob || !["queued", "running"].includes(initialJob.status)) return initialJob ?? null;
  if (initialJob.status === "running" && initialJob.runnerInstanceId !== verificationJobRuntimeId) return initialJob;
  const timestamp = now();
  await mutateState((state) => {
    const project = state.projects.find((entry) => entry.id === initialProject.id);
    const job = project?.verificationJobs?.find((entry) => entry.id === jobId);
    if (!job || job.status !== "queued") return;
    job.status = "running";
    job.startedAt = timestamp;
    job.updatedAt = timestamp;
    job.runnerInstanceId = verificationJobRuntimeId;
  });

  initial = await loadState();
  const project = initial.projects.find((entry) => entry.id === initialProject.id);
  const job = project?.verificationJobs?.find((entry) => entry.id === jobId);
  if (!project || !job || job.status !== "running" || job.runnerInstanceId !== verificationJobRuntimeId) return job ?? null;
  const task = project.tasks?.find((entry) => entry.id === job.taskId);
  if (!task) return failJob(mutateState, project.id, jobId, "Task was removed before checks started.");
  const workingState = bindTaskWorkspace(structuredClone(initial));
  const workingProject = workingState.projects.find(p=>p.id===project.id);
  const workingTask = workingProject.tasks.find((entry) => entry.id === task.id);
  const plan = ensureTaskVerificationPlan(workingProject, workingTask);
  if (plan.targetSnapshotHash !== job.targetSnapshotHash) return failJob(mutateState, project.id, jobId, "The reviewed verification plan is stale.", "stale");

  let result;
  try {
    result = await executeTaskVerificationPlan(workingProject, workingTask, {
      ...(await createExecutors({ project: workingProject, task: workingTask })),
      allowStateChangingReplay: job.approval.allowStateChangingReplay,
      targetSnapshotHash: job.approval.targetSnapshotHash,
      contextPackId: job.contextPackId, handoffId: job.handoffId,
      shouldCancel: async () => {
        const current = await loadState();
        return Boolean(current.projects.find((entry) => entry.id === project.id)?.verificationJobs?.find((entry) => entry.id === jobId)?.cancelRequestedAt);
      },
      onProgress: async (progress) => mutateState((state) => {
        const currentJob = state.projects.find((entry) => entry.id === project.id)?.verificationJobs?.find((entry) => entry.id === jobId);
        if (!currentJob || currentJob.status !== "running") return;
        currentJob.progress = { ...currentJob.progress, ...progress };
        currentJob.updatedAt = now();
      }),
      onCheckResult: async (check) => mutateState((state) => {
        const currentJob = state.projects.find((entry) => entry.id === project.id)?.verificationJobs?.find((entry) => entry.id === jobId);
        if (!currentJob || currentJob.status !== "running") return;
        currentJob.checkResults = [...currentJob.checkResults.filter((entry) => entry.stepId !== check.stepId), structuredClone(check)];
        currentJob.progress = { ...currentJob.progress, completed: currentJob.checkResults.length };
        currentJob.updatedAt = now();
      })
    });
  } catch (error) {
    return failJob(mutateState, project.id, jobId, error.message);
  }

  const finishedAt = now();
  let finalJob;
  await mutateState((state) => {
    const liveProject = state.projects.find((entry) => entry.id === project.id);
    const liveJob = liveProject?.verificationJobs?.find((entry) => entry.id === jobId);
    const liveTask = liveProject?.tasks?.find((entry) => entry.id === job.taskId);
    if (!liveProject || !liveJob || !liveTask) throw new Error("Verification job or task disappeared before results could be saved.");
    const livePlan = ensureTaskVerificationPlan(liveProject, liveTask);
    if (livePlan.targetSnapshotHash !== job.targetSnapshotHash || projectGitRevision(liveProject) !== job.sourceRevision) {
      liveJob.status = "stale";
      liveJob.error = "The repository, task, environment, or verification plan changed during execution. Results were not attached as current proof.";
      liveJob.finishedAt = finishedAt;
      liveJob.updatedAt = finishedAt;
      finalJob = liveJob;
      return;
    }
    const evidenceIds = [...new Set([result.receipt.replayEvidenceId, result.receipt.diffEvidenceId, ...(result.receipt.testEvidenceIds ?? []), ...result.checkResults.map((entry) => entry.evidenceId)].filter(Boolean))];
    const newEvidence = workingProject.evidence.filter((entry) => evidenceIds.includes(entry.id) && !liveProject.evidence?.some((saved) => saved.id === entry.id));
    liveProject.evidence ??= [];
    liveProject.evidence.unshift(...newEvidence);
    liveProject.verificationReceipts ??= [];
    if (!liveProject.verificationReceipts.some((entry) => entry.id === result.receipt.id)) liveProject.verificationReceipts.unshift(result.receipt);
    liveProject.verificationRuns ??= [];
    const run = {
      id: jobId, taskId: job.taskId, projectId: project.id, contextPackId: job.contextPackId, handoffId: job.handoffId, status: result.cancelled ? "cancelled" : result.receipt.result === "Verified" ? "passed" : result.receipt.result === "Failed" ? "failed" : "incomplete",
      sourceRevision: job.sourceRevision, environmentFingerprint: job.environmentFingerprint,
      planId: job.plan.id, planHash: job.targetSnapshotHash, startedAt: job.startedAt, finishedAt,
      checks: result.checkResults, skipped: result.checkResults.filter((entry) => entry.status === "skipped"), receiptId: result.receipt.id
    };
    liveProject.verificationRuns.unshift(run);
    liveTask.verificationPlan = structuredClone(result.plan);
    liveTask.verificationReceiptIds = [result.receipt.id, ...(liveTask.verificationReceiptIds ?? []).filter((id) => id !== result.receipt.id)];
    liveTask.verificationRunIds = [jobId, ...(liveTask.verificationRunIds ?? []).filter((id) => id !== jobId)];
    liveTask.runtimeEvidenceIds = [...new Set([...evidenceIds, ...(liveTask.runtimeEvidenceIds ?? [])])];
    liveTask.updatedAt = finishedAt;
    for (const updatedContract of workingProject.contracts ?? []) {
      if (!liveTask.contractIds?.includes(updatedContract.id)) continue;
      const target = liveProject.contracts?.find((entry) => entry.id === updatedContract.id);
      if (target) Object.assign(target, { state: updatedContract.state, latestVerificationReceiptId: updatedContract.latestVerificationReceiptId });
    }
    liveProject.updatedAt = finishedAt;
    liveJob.status = result.cancelled ? "cancelled" : "completed";
    liveJob.result = result.receipt.result;
    liveJob.receiptId = result.receipt.id;
    liveJob.checkResults = result.checkResults;
    liveJob.progress = { completed: result.checkResults.length, total: job.plan.steps.length, currentStepId: null };
    liveJob.finishedAt = finishedAt;
    liveJob.updatedAt = finishedAt;
    finalJob = liveJob;
  });
  return finalJob;
}

export async function requestVerificationJobCancellation(project, taskId, jobId) {
  const job = project.verificationJobs?.find((entry) => entry.id === jobId && entry.taskId === taskId);
  if (!job) throw Object.assign(new Error("Verification job not found"), { statusCode: 404 });
  if (["completed", "failed", "cancelled", "stale", "interrupted"].includes(job.status)) return { job, cancelled: false };
  job.cancelRequestedAt = now();
  job.updatedAt = job.cancelRequestedAt;
  if (job.status === "queued") {
    job.status = "cancelled";
    job.finishedAt = job.cancelRequestedAt;
  }
  return { job, cancelled: true };
}

export function markInterruptedVerificationJobs(state) {
  let changed = false;
  const timestamp = now();
  for (const project of state.projects ?? []) for (const job of project.verificationJobs ?? []) {
    if (!["queued", "running"].includes(job.status) || job.runnerInstanceId === verificationJobRuntimeId) continue;
    job.status = "interrupted";
    job.error = "The companion restarted before this verification job finished. Start a new reviewed run to continue.";
    job.finishedAt = timestamp;
    job.updatedAt = timestamp;
    changed = true;
  }
  return changed;
}

async function failJob(mutateState, projectId, jobId, message, status = "failed") {
  let failed;
  await mutateState((state) => {
    const job = state.projects.find((entry) => entry.id === projectId)?.verificationJobs?.find((entry) => entry.id === jobId);
    if (!job) return;
    job.status = status;
    job.error = message;
    job.finishedAt = now();
    job.updatedAt = job.finishedAt;
    failed = job;
  });
  return failed ?? null;
}
