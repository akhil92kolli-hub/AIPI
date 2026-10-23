import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-verification-route-"));
process.env.AIPI_DATA = path.join(temp, "data");
process.env.AIPI_PORT = "0";
process.env.AIPI_MAX_PORT = "0";
const { mutateState, loadState } = await import("../scripts/workspace-store.mjs");
const { startDashboard } = await import("../scripts/dashboard-server.mjs");
let dashboard;
try {
  await mutateState((state) => {
    state.projects = [{
      id: "verify-project", name: "Verify route test", requests: [], tasks: [], environments: [{ id: "dev", name: "Development", variables: [{ key: "baseUrl", value: "http://example.test", enabled: true }] }], activeEnvironmentId: "dev",
      sourceContext: { roots: [{ kind: "workspace", path: temp }], gitRevision: "route123", endpoints: [{ id: "health-handler", method: "GET", path: "/health", source: "server.ts", line: 2 }], integrations: [], schemas: [{ id: "health-schema", endpointId: "health-handler", fields: [] }], findings: [], git: [] }
    }];
    state.activeProjectId = "verify-project";
  });
  const project = (await loadState()).projects[0];
  const contract = project.contracts.find((entry) => entry.route === "/health");
  dashboard = await startDashboard({ executeRequest: async () => ({ ok: true, passed: true, status: 200, headers: { Authorization: "must-redact" }, body: "{}", json: {} }) });
  const directPage = await fetch(`${dashboard.url}/projects/verify-project`);
  assert.equal(directPage.status, 200, "direct project navigation serves the dashboard shell");
  const sessionCookie = directPage.headers.get("set-cookie")?.split(";")[0];
  assert.match(sessionCookie ?? "", /^aipi_session=/, "direct project navigation refreshes the local session cookie");
  const cookieApiResponse = await fetch(`${dashboard.url}/api/state`, { headers: { cookie: sessionCookie } });
  assert.equal(cookieApiResponse.status, 200, "the UI can call protected APIs after direct project navigation");
  const headers = { authorization: `Bearer ${dashboard.token}`, "content-type": "application/json" };
  const taskResponse = await fetch(`${dashboard.url}/api/projects/verify-project/contracts/${contract.id}/task-draft`, { method: "POST", headers });
  assert.equal(taskResponse.status, 201);
  const { task } = await taskResponse.json();
  const contextResponse = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/context`, {
    method: "POST", headers, body: JSON.stringify({ tokenBudget: 2400, level: "working" })
  });
  assert.equal(contextResponse.status, 200, "context alias prepares a bounded task context");
  const context = await contextResponse.json();
  assert.ok(context.manifest, "context preparation includes a manifest");

  const previewResponse = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/verify`, { headers });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.ok(Array.isArray(preview.plan.steps), "verification previews always include steps");
  assert.deepEqual(preview.steps, preview.plan.steps, "legacy preview consumers receive the same safe steps array");
  const compatibilityPreviewResponse = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/verification-plan`, { headers });
  assert.equal(compatibilityPreviewResponse.status, 200, "verification-plan alias is available");
  assert.ok(Array.isArray((await compatibilityPreviewResponse.json()).plan.steps));
  const verificationResponse = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/verify`, { method: "POST", headers, body: JSON.stringify({ allowStateChangingReplay: false, targetSnapshotHash: preview.plan.targetSnapshotHash }) });
  assert.equal(verificationResponse.status, 200);
  const verification = await verificationResponse.json();
  assert.equal(verification.ok, true);
  assert.equal(verification.receipt.result, "Verified");
  assert.equal(verification.checkResults.length, 2);
  assert.ok((await loadState()).projects[0].verificationReceipts.some((entry) => entry.id === verification.receipt.id));
  const jobStart = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/verification-jobs`, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "route-job-1", targetSnapshotHash: preview.plan.targetSnapshotHash }) });
  assert.equal(jobStart.status, 202);
  const { job: startedJob } = await jobStart.json();
  let job;
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/verification-jobs/${startedJob.id}`, { headers });
    job = (await response.json()).job;
    if (["completed", "failed", "stale", "cancelled"].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.ok(job.receiptId);
  assert.equal(job.progress.completed, job.progress.total);
  const replay = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/verification-jobs`, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "route-job-1", targetSnapshotHash: preview.plan.targetSnapshotHash }) });
  assert.equal((await replay.json()).replayed, true, "repeating a request returns its existing job");
  await mutateState((state) => {
    const savedTask = state.projects[0].tasks.find((entry) => entry.id === task.id);
    savedTask.testCommand = { command: "node", args: ["-e", "console.log('bounded-test-output')"], cwd: ".", timeoutMs: 10000 };
  });
  const testPlanResponse = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/verify`, { headers });
  const testPlan = (await testPlanResponse.json()).plan;
  const testJobStart = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/verification-jobs`, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "route-job-test-output", targetSnapshotHash: testPlan.targetSnapshotHash }) });
  const { job: testJobStarted } = await testJobStart.json();
  let testJob;
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${dashboard.url}/api/projects/verify-project/tasks/${task.id}/verification-jobs/${testJobStarted.id}`, { headers });
    testJob = (await response.json()).job;
    if (["completed", "failed", "stale", "cancelled"].includes(testJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(testJob.status, "completed", JSON.stringify(testJob));
  assert.ok(testJob.checkResults.some((check) => check.outputPreview?.includes("bounded-test-output")), "bounded test output survives in the persisted per-check result for reconnects");
  console.log("Verification HTTP route and persistence passed");
} finally {
  if (dashboard) await new Promise((resolve) => dashboard.server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
