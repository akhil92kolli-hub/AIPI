import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-task-pipeline-"));
process.env.AIPI_DATA = temp;
process.env.AIPI_PORT = "0";
process.env.AIPI_MAX_PORT = "0";
process.env.AIPI_FRESHNESS_INTERVAL_MS = "600000";
const { mutateState, loadState } = await import("../scripts/workspace-store.mjs");
const { discoverProjectCheckCatalog, executeLinkedTestCommand, startDashboard } = await import("../scripts/dashboard-server.mjs");
let dashboard;

try {
  await fs.mkdir(path.join(temp, ".api-forge", "cache"), { recursive: true });
  await fs.mkdir(path.join(temp, "src", "components"), { recursive: true });
  await fs.writeFile(path.join(temp, "src", "components", "AccountSettings.tsx"), "export function AccountSettings() { return null; }\n");
  await fs.writeFile(path.join(temp, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest run", "test:contract": "vitest run tests/contracts", lint: "eslint .", start: "node server.js", pretest: "echo untrusted" } }));
  await fs.writeFile(path.join(temp, ".api-forge", "cache", "source-index-v1.json"), JSON.stringify({ files: {
    "src/components/AccountSettings.tsx": { result: { artifacts: [{ kind: "component", name: "AccountSettings" }], frontendCalls: [], endpoints: [], schemas: [] } }
  } }));
  await mutateState((state) => {
    state.projects = [{
      id: "pipeline-project",
      name: "Task pipeline test",
      requests: [{ id: "users-request", name: "GET users", method: "GET", url: "{{baseUrl}}/api/users", contractId: "users-contract" }],
      tasks: [],
      milestones: [{ id: "launch", title: "Launch Readiness" }],
      contracts: [{
        id: "users-contract", method: "GET", route: "/api/users", state: "Mismatched",
        currentRevisionId: "users-revision", sourceArtifactIds: ["users-handler"],
        sourceRequestIds: ["users-request"], implementation: { source: "src/users.ts", line: 14 }
      }],
      findings: [],
      contextPacks: [],
      verificationPlans: [],
      sourceContext: {
        roots: [{ kind: "workspace", path: temp }],
        gitRevision: "test-revision",
        lastScannedAt: "2026-10-17T00:00:00.000Z",
        git: [{ root: temp, commit: "test-revision", dirty: false }],
        endpoints: [{ id: "users-handler", method: "GET", path: "/api/users", source: "src/users.ts", root: temp, line: 14 }],
        frontendCalls: [], integrations: [], schemas: [], artifacts: [],
        findings: [{ id: "users-finding", endpointId: "users-handler", method: "GET", path: "/api/users", type: "contract-schema-mismatch", title: "GET /api/users response schema mismatch", severity: "high" }]
      }
    }];
    state.activeProjectId = "pipeline-project";
  });

  dashboard = await startDashboard({
    executeRequest() { throw new Error("Task preparation must not execute API requests."); },
    callTool() { throw new Error("Task preparation must not dispatch an agent."); }
  });
  const catalog = await discoverProjectCheckCatalog((await loadState()).projects[0]);
  assert.deepEqual(catalog.map((check) => check.name), ["test", "test:contract", "lint"]);
  assert.equal(catalog[0].command.command, "pnpm");
  assert.deepEqual(catalog[0].command.args, ["run", "test"]);
  assert.equal(catalog[0].trust, "review-required", "discovery never implicitly trusts or executes package scripts");
  process.env.AIPI_TEST_SECRET = "must-not-reach-test-process";
  const safeExecution = await executeLinkedTestCommand({ sourceContext: { roots: [{ kind: "workspace", path: temp }] } }, { command: "node", args: ["-e", "console.log(process.env.AIPI_TEST_SECRET || 'redacted')"], timeoutMs: 10000 });
  assert.equal(safeExecution.passed, true);
  assert.match(safeExecution.output, /redacted/);
  assert.doesNotMatch(safeExecution.output, /must-not-reach-test-process/);
  const timedExecution = await executeLinkedTestCommand({ sourceContext: { roots: [{ kind: "workspace", path: temp }] } }, { command: "node", args: ["-e", "setTimeout(() => process.exit(0), 300)"], timeoutMs: 20 });
  assert.equal(timedExecution.passed, false);
  assert.equal(timedExecution.timedOut, true, "timeout is represented as a failed test result rather than a pass");
  const outsideTemp = path.join(path.dirname(temp), `${path.basename(temp)}-outside`);
  await fs.mkdir(outsideTemp, { recursive: true });
  await fs.mkdir(path.join(temp, "nested"), { recursive: true });
  try {
    await fs.symlink(outsideTemp, path.join(temp, "nested", "escape"));
    await assert.rejects(executeLinkedTestCommand({ sourceContext: { roots: [{ kind: "workspace", path: temp }] } }, { command: "node", args: ["-e", "process.exit(0)"], cwd: "nested/escape" }), /outside the repository root/);
  } catch (error) { if (!new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error.code)) throw error; }
  await fs.rm(outsideTemp, { recursive: true, force: true });
  delete process.env.AIPI_TEST_SECRET;
  const url = `http://127.0.0.1:${dashboard.port}/api/projects/pipeline-project/tasks`;
  const headers = { authorization: `Bearer ${dashboard.token}`, "content-type": "application/json" };

  const beforeSearch = (await loadState()).projects[0];
  const searchResponse = await fetch(`${url}/search-context`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "Fix GET /api/users response mismatch", intent: "fix-contract" })
  });
  assert.equal(searchResponse.status, 200);
  const search = await searchResponse.json();
  assert.equal(search.contractMatches[0].contract.id, "users-contract");
  assert.equal(search.contractMatches[0].source.source, "src/users.ts");
  assert.equal(search.contractMatches[0].source.line, 14);
  assert.ok(search.contractMatches[0].findings.some((finding) => finding.id === "users-finding"));
  assert.ok(search.sourceMatches.some((artifact) => artifact.id === "endpoint:users-handler"));
  const afterSearch = (await loadState()).projects[0];
  assert.deepEqual(afterSearch.tasks, beforeSearch.tasks, "draft search must not create or update tasks");
  assert.deepEqual(afterSearch.contextPacks, beforeSearch.contextPacks, "draft search must not persist a context pack");

  const uiSearchResponse = await fetch(`${url}/search-context`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "Build responsive account settings panel", intent: "ui-feature" })
  });
  assert.equal(uiSearchResponse.status, 200, "UI work is a supported task intent");
  const uiSearch = await uiSearchResponse.json();
  const accountSettings = uiSearch.sourceMatches.find((entry) => entry.source === "src/components/AccountSettings.tsx");
  assert.ok(accountSettings?.materialize, "search includes frontend files from the last workspace index");

  const uiTaskResponse = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ task: {
      id: "ui-only-task",
      title: "Build responsive account settings panel",
      description: "Create accessible settings controls that work in the IDE side panel and desktop dashboard.",
      intent: "ui-feature",
      contractIds: [],
      artifactIds: [accountSettings.id],
      workspaceFileRefs: [{ id: accountSettings.id, kind: accountSettings.kind, source: accountSettings.source, root: accountSettings.root }],
      acceptanceCriteria: []
    } })
  });
  assert.equal(uiTaskResponse.status, 201, "a UI task can be created without a K Map contract");
  const uiTask = await uiTaskResponse.json();
  assert.deepEqual(uiTask.task.contractIds, []);
  assert.ok(uiTask.task.artifactIds.includes(accountSettings.id));
  assert.equal(uiTask.task.contextStatus, "current");
  assert.match(uiTask.task.acceptanceCriteria.join(" "), /UI behavior|component/i);
  assert.doesNotMatch(uiTask.task.acceptanceCriteria.join(" "), /API replay/i);

  const existingResponse = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      task: {
        id: "existing-contract-task",
        title: "Fix GET /api/users response mismatch",
        description: "Make the handler response match the indexed schema.",
        intent: "fix-contract",
        contractIds: ["users-contract"],
        milestoneIds: ["launch"],
        acceptanceCriteria: []
      }
    })
  });
  assert.equal(existingResponse.status, 201);
  const existing = await existingResponse.json();
  assert.deepEqual(existing.task.contractIds, ["users-contract"]);
  assert.deepEqual(existing.task.findingIds, ["users-finding"]);
  assert.equal(existing.task.contextStatus, "current");
  assert.equal(existing.task.acceptanceCriteria.length, 3);
  assert.equal(existing.manifest.task.acceptanceCriteria.length, 3);
  assert.ok(existing.task.affectedChainIds.includes("users-contract"));
  assert.equal(existing.contextPack.tokenBudget, 2400);
  assert.ok(existing.contextPack.estimatedTokens <= 2400);
  assert.ok(existing.manifest.contracts.some((contract) => contract.id === "users-contract"));
  assert.ok(existing.plan.steps.length >= 2);
  const updatedResponse = await fetch(`${url}/existing-contract-task`, {
    method: "POST",
    headers,
    body: JSON.stringify({ task: { ...existing.task, description: "Keep the route response aligned and verify it." } })
  });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.task.id, "existing-contract-task");
  assert.equal(updated.task.contextStatus, "current");
  assert.ok(updated.plan.steps.length >= 2);

  const plannedResponse = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      task: {
        id: "planned-endpoint-task",
        title: "Design POST /api/orders/refund",
        description: "Add a refund endpoint with a validated request and response.",
        intent: "new-contract",
        contractIds: [],
        acceptanceCriteria: []
      },
      plannedContract: {
        method: "POST",
        path: "/api/orders/refund",
        requestExample: JSON.stringify({ orderId: "order-123" }),
        responseExample: JSON.stringify({ status: "refunded" }),
        targetFile: "src/routes/orders.ts"
      }
    })
  });
  assert.equal(plannedResponse.status, 201);
  const planned = await plannedResponse.json();
  assert.equal(planned.plannedContract.state, "Planned");
  assert.deepEqual(planned.plannedContract.expectedSchema.request, { orderId: "order-123" });
  assert.deepEqual(planned.plannedContract.expectedSchema.response, { status: "refunded" });
  assert.ok(planned.task.contractIds.includes(planned.plannedContract.id));
  assert.equal(planned.task.contextStatus, "current");
  assert.equal(planned.task.acceptanceCriteria.length, 3);
  assert.equal(planned.manifest.task.acceptanceCriteria.length, 3);
  assert.ok(planned.manifest.contracts.some((contract) => contract.id === planned.plannedContract.id && contract.expectedSchema.request.orderId === "order-123"));
  assert.ok(planned.task.requestIds.includes(planned.plannedRequest.id));
  assert.ok(planned.plan.steps.length >= 2);
  const plannedUpdateResponse = await fetch(`${url}/planned-endpoint-task`, {
    method: "POST",
    headers,
    body: JSON.stringify({ task: planned.task, plannedContract: {
      method: "POST",
      path: "/api/orders/refund",
      requestExample: JSON.stringify({ orderId: "order-123" }),
      responseExample: JSON.stringify({ status: "refunded" }),
      targetFile: "src/routes/orders.ts"
    } })
  });
  assert.equal(plannedUpdateResponse.status, 200);
  const plannedUpdate = await plannedUpdateResponse.json();
  assert.equal(plannedUpdate.plannedContract.id, planned.plannedContract.id);
  assert.equal(plannedUpdate.plannedRequest.id, planned.plannedRequest.id);

  const persisted = (await loadState()).projects[0];
  assert.ok(persisted.requests.some((request) => request.id === planned.plannedRequest.id && request.body.content.includes("order-123")));
  assert.ok(persisted.collections.find((collection) => collection.id === "planned-api-suite").requestIds.includes(planned.plannedRequest.id));

  const invalid = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      task: { id: "invalid-task", title: "Invalid spec", description: "Should be rejected.", intent: "new-contract" },
      plannedContract: { method: "POST", path: "/api/invalid", requestExample: "{bad json" }
    })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await loadState()).projects[0].tasks.some((task) => task.id === "invalid-task"), false);
  console.log("Task creation pipeline: existing-contract seeding, Planned K Map provisioning, bounded context and verification-plan preparation passed");
} finally {
  if (dashboard) await new Promise((resolve) => dashboard.server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
