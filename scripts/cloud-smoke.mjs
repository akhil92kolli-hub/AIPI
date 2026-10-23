#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import app from "../cloud/worker.ts";

let configuredPairing;
const databaseRequests = [];
const emailRequests = [];
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  PAIRING: {
    idFromName: (name) => name,
    get: () => ({ fetch: async (request) => { configuredPairing = await request.json(); return new Response(null, { status: 204 }); } }),
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://example.supabase.co/auth/v1/user") {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-user-token");
    return Response.json({ id: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" });
  }
  if (url.startsWith("https://example.supabase.co/auth/v1/otp?")) {
    emailRequests.push({ url, body: JSON.parse(init.body) });
    return Response.json({});
  }
  if (url.startsWith("https://example.supabase.co/rest/v1/rpc/get_team_snapshot")) {
    databaseRequests.push({ url, method: init?.method ?? "GET", body: JSON.parse(init.body) });
    return Response.json({ cursor: 4, entities: [] });
  }
  if (url.startsWith("https://example.supabase.co/rest/v1/rpc/get_team_change_page")) {
    databaseRequests.push({ url, method: init?.method ?? "GET", body: JSON.parse(init.body) });
    return Response.json({ expired: false, events: [], nextCursor: 4, hasMore: false });
  }
  if (url.startsWith("https://example.supabase.co/rest/v1/rpc/resolve_team_task_context")) {
    databaseRequests.push({ url, method: init?.method ?? "GET", body: JSON.parse(init.body) });
    return Response.json({ task: { id: "00000000-0000-4000-8000-000000000003", title: "Trace checkout flow" }, decisions: [] });
  }
  if (url.startsWith("https://example.supabase.co/rest/v1/rpc/search_team_decisions")) {
    databaseRequests.push({ url, method: init?.method ?? "GET", body: JSON.parse(init.body) });
    return Response.json([]);
  }
  if (url.startsWith("https://example.supabase.co/rest/v1/rpc/prune_team_change_events")) {
    databaseRequests.push({ url, method: init?.method ?? "GET", body: JSON.parse(init.body) });
    return Response.json([{ deleted_count: 0, floor_sequence: 0 }]);
  }
  if (url.startsWith("https://example.supabase.co/rest/v1/rpc/accept_team_email_invitation")) {
    databaseRequests.push({ url, method: init?.method ?? "GET", body: JSON.parse(init.body) });
    return Response.json("00000000-0000-4000-8000-000000000002");
  }
  if (url.startsWith("https://example.supabase.co/rest/v1/team_sync_floors?")) return Response.json([]);
  if (url.startsWith("https://example.supabase.co/rest/v1/team_") || url.startsWith("https://example.supabase.co/rest/v1/organizations?") || url.startsWith("https://example.supabase.co/rest/v1/organization_memberships?") || url.startsWith("https://example.supabase.co/rest/v1/rpc/apply_team_")) {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-user-token");
    databaseRequests.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body ? JSON.parse(init.body) : null });
    return Response.json([{ id: "00000000-0000-4000-8000-000000000003" }]);
  }
  return originalFetch(input, init);
};

const health = await app.request("http://aipi.test/healthz", {}, env);
assert.equal(health.status, 200);
assert.equal((await health.json()).service, "aipi-remote");
const consent = await app.request("https://aipi.website/oauth/consent?authorization_id=test-id", {}, env);
assert.equal(consent.status, 307);
assert.equal(consent.headers.get("location"), "https://aipi.website/oauth/consent/?authorization_id=test-id");
const metadata = await app.request("http://aipi.test/.well-known/oauth-protected-resource", {}, env);
assert.equal(metadata.status, 200);
assert.deepEqual((await metadata.json()).authorization_servers, ["https://example.supabase.co/auth/v1"]);
const missingAuthMetadata = await app.request("http://aipi.test/.well-known/oauth-protected-resource", {}, { ...env, SUPABASE_URL: "" });
assert.equal(missingAuthMetadata.status, 503);

const organizationId = "00000000-0000-4000-8000-000000000002";
const workspaceId = "00000000-0000-4000-8000-000000000003";
const teamBase = `http://aipi.test/api/team/organizations/${organizationId}`;
const teamHeaders = { authorization: "Bearer test-user-token", "content-type": "application/json" };
const pullRequests = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/pull-requests`, { headers: teamHeaders }, env);
assert.equal(pullRequests.status, 200);
assert.ok(databaseRequests.at(-1).url.includes("team_pull_requests?"));
const releaseUrl = `http://aipi.test/api/team/workspaces/${workspaceId}/release-compatibility?projectId=prj_local`;
assert.equal((await app.request(releaseUrl, {}, env)).status, 401);
const releasePreview = await app.request(releaseUrl, { headers: teamHeaders }, env);
assert.equal(releasePreview.status, 200);
assert.equal(releasePreview.headers.get('cache-control'), 'no-store');
const releaseBody = (await releasePreview.json()).releaseCompatibility;
assert.equal(releaseBody.canDeploy, false);
assert.equal(releaseBody.previewReady, false);
assert.ok(releaseBody.pairs.every(pair => pair.status === 'unknown'));
const createdOrganization = await app.request("http://aipi.test/api/team/organizations", { method: "POST", headers: teamHeaders, body: JSON.stringify({ name: "Platform team" }) }, env);
assert.equal(createdOrganization.status, 201);
assert.equal(databaseRequests.at(-1).body.owner_id, "00000000-0000-4000-8000-000000000001");
const invitedMember = await app.request(`${teamBase}/members`, { method: "POST", headers: teamHeaders, body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000004", role: "developer" }) }, env);
assert.equal(invitedMember.status, 201);
assert.equal(databaseRequests.at(-1).body.role, "developer");
const invitation = await app.request(`${teamBase}/invitations`, { method: "POST", headers: teamHeaders,
  body: JSON.stringify({ email: "Developer@Example.com", role: "developer", workspaceId }) }, env);
assert.equal(invitation.status, 201);
assert.equal(databaseRequests.at(-1).body.email, "developer@example.com");
assert.equal(databaseRequests.at(-1).body.workspace_id, workspaceId);
assert.equal((await invitation.json()).delivered, true);
assert.equal(emailRequests.at(-1).body.email, "developer@example.com");
assert.match(emailRequests.at(-1).url, /redirect_to=/);
const pendingInvitations = await app.request("http://aipi.test/api/team/invitations/pending", { headers: teamHeaders }, env);
assert.equal(pendingInvitations.status, 200);
assert.match(databaseRequests.at(-1).url, /email=eq\.owner%40example.com/);
const acceptedInvitation = await app.request("http://aipi.test/api/team/invitations/00000000-0000-4000-8000-000000000005/accept", { method: "POST", headers: teamHeaders }, env);
assert.equal(acceptedInvitation.status, 200);
assert.equal((await acceptedInvitation.json()).organizationId, organizationId);
const anonymousWorkspaces = await app.request(`${teamBase}/workspaces`, {}, env);
assert.equal(anonymousWorkspaces.status, 401);
const workspaces = await app.request(`${teamBase}/workspaces`, { headers: teamHeaders }, env);
assert.equal(workspaces.status, 200);
assert.equal((await workspaces.json()).workspaces.length, 1);
const createdWorkspace = await app.request(`${teamBase}/workspaces`, {
  method: "POST", headers: teamHeaders, body: JSON.stringify({ name: "Platform" }),
}, env);
assert.equal(createdWorkspace.status, 201);
assert.deepEqual(databaseRequests.at(-1).body, { organization_id: organizationId, created_by: "00000000-0000-4000-8000-000000000001", name: "Platform", description: null });
const createdDevice = await app.request(`${teamBase}/devices`, {
  method: "POST", headers: teamHeaders, body: JSON.stringify({ label: "Developer laptop" }),
}, env);
assert.equal(createdDevice.status, 201);
assert.deepEqual(databaseRequests.at(-1).body, { organization_id: organizationId, user_id: "00000000-0000-4000-8000-000000000001", label: "Developer laptop" });
const listedDevices = await app.request(`${teamBase}/devices`, { headers: teamHeaders }, env);
assert.equal(listedDevices.status, 200);
assert.match(databaseRequests.at(-1).url, /user_id=eq\.00000000-0000-4000-8000-000000000001/);
const policyUpdated = await app.request(`${teamBase}/source-policy`, {
  method: "PUT", headers: teamHeaders, body: JSON.stringify({ sharingMode: "snippets" }),
}, env);
assert.equal(policyUpdated.status, 410);
const workspacePolicyUpdated = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/source-policy`, {
  method: "PUT", headers: teamHeaders, body: JSON.stringify({ sharingMode: "snippets" }),
}, env);
assert.equal(workspacePolicyUpdated.status, 200);
assert.equal(databaseRequests.at(-1).body.sharing_mode, "snippets");
const unsignedWebhook = await app.request("http://aipi.test/api/github/webhook", {
  method: "POST", body: JSON.stringify({ action: "opened" }),
}, env);
assert.equal(unsignedWebhook.status, 503);
const boundProject = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/projects/prj_abcd`, {
  method: "PUT", headers: teamHeaders, body: JSON.stringify({ providerRepositoryId: "123456789", repository: "company/platform", remoteUrl: "https://github.com/company/platform", repositoryRoot: "services/api" }),
}, env);
assert.equal(boundProject.status, 503);
const unboundProject = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/projects/prj_local`, {
  method: "PUT", headers: teamHeaders, body: "{}",
}, env);
assert.equal(unboundProject.status, 200);
assert.deepEqual(databaseRequests.at(-1).body, { workspace_id: workspaceId, project_key: "prj_local", display_name: null });
assert.match(databaseRequests.at(-1).headers.prefer, /resolution=ignore-duplicates/);
const invalidProject = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/projects/prj_abcd`, {
  method: "PUT", headers: teamHeaders, body: JSON.stringify({ providerRepositoryId: "123456789", repository: "company/platform", remoteUrl: "https://github.com/company/platform", repositoryRoot: "../outside" }),
}, env);
assert.equal(invalidProject.status, 400);
const mismatchedProject = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/projects/prj_abcd`, {
  method: "PUT", headers: teamHeaders, body: JSON.stringify({ providerRepositoryId: "123456789", repository: "company/other", remoteUrl: "https://github.com/company/platform" }),
}, env);
assert.equal(mismatchedProject.status, 400);
const taskCreated = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/tasks`, {
  method: "POST", headers: teamHeaders, body: JSON.stringify({ externalId: "task_abcd", title: "Trace checkout flow", revisionSet: [{ projectKey: "prj_abcd", commit: "a".repeat(40) }] }),
}, env);
assert.equal(taskCreated.status, 410);
assert.match((await taskCreated.json()).error, /operation endpoint/);
const taskUpdated = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/tasks/${workspaceId}`, {
  method: "PATCH", headers: teamHeaders, body: JSON.stringify({ expectedVersion: 1, status: "in_progress" }),
}, env);
assert.equal(taskUpdated.status, 410);
const decisionCreated = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/decisions`, {
  method: "POST", headers: teamHeaders, body: JSON.stringify({ taskId: workspaceId, body: "Use the canonical checkout." }),
}, env);
assert.equal(decisionCreated.status, 410);
const evidenceCreated = await app.request(`http://aipi.test/api/team/workspaces/${workspaceId}/evidence`, {
  method: "POST", headers: teamHeaders, body: JSON.stringify({ taskId: workspaceId, kind: "verification", producer: "ci", payload: { status: "passed" } }),
}, env);
assert.equal(evidenceCreated.status, 410);
const deviceRevoked = await app.request(`${teamBase}/devices/${workspaceId}`, { method: "DELETE", headers: teamHeaders }, env);
assert.equal(deviceRevoked.status, 200);
assert.match(databaseRequests.at(-1).url, /user_id=eq\./);
const submittedOperation = await app.request(`${teamBase}/workspaces/${workspaceId}/operations/task`, {
  method: "POST", headers: teamHeaders, body: JSON.stringify({ schemaVersion: 1, operationId: "00000000-0000-4000-8000-000000000005", deviceId: "00000000-0000-4000-8000-000000000006", externalId: "task_abcd", title: "Trace checkout flow", baseVersion: 0 }),
}, env);
assert.equal(submittedOperation.status, 200);
assert.equal(databaseRequests.at(-1).body.p_base_version, 0);
assert.equal(databaseRequests.at(-1).body.p_operation_id, "00000000-0000-4000-8000-000000000005");
const sourceRevisionOperation = await app.request(`${teamBase}/workspaces/${workspaceId}/operations/task`, {
  method: "POST", headers: teamHeaders, body: JSON.stringify({ schemaVersion: 1,
    operationId: "00000000-0000-4000-8000-000000000643",
    deviceId: "00000000-0000-4000-8000-000000000006", externalId: "task_abcd",
    patch: { revisionSet: [{ projectKey: "prj_abcd", sourceBindingId: "src_first12345678",
      commit: "a".repeat(40) }] }, baseVersion: 1 }),
}, env);
assert.equal(sourceRevisionOperation.status, 200);
assert.equal(databaseRequests.at(-1).body.p_patch.revisionSet[0].sourceBindingId, "src_first12345678");
const changes = await app.request(`${teamBase}/changes?after=4&limit=25`, { headers: teamHeaders }, env);
assert.equal(changes.status, 200);
assert.equal(databaseRequests.at(-1).body.p_after, 4);
const pruned = await app.request(`${teamBase}/changes/prune`, { method: "POST", headers: teamHeaders,
  body: JSON.stringify({ before: "2026-09-01T00:00:00Z" }) }, env);
assert.equal(pruned.status, 200);
assert.equal((await pruned.json()).retention.deleted_count, 0);
const appendedComment = await app.request(`${teamBase}/workspaces/${workspaceId}/operations/append`, {
  method: "POST", headers: teamHeaders, body: JSON.stringify({ schemaVersion: 1,
    operationId: "00000000-0000-4000-8000-000000000007", deviceId: "00000000-0000-4000-8000-000000000006",
    payload: { entityType: "comment", taskId: workspaceId, body: "Ready for review" } }),
}, env);
assert.equal(appendedComment.status, 200);
assert.equal(databaseRequests.at(-1).body.p_entity_type, "comment");
const contextUpdated = await app.request(`${teamBase}/workspaces/${workspaceId}/operations/task-context`, {
  method: "POST", headers: teamHeaders, body: JSON.stringify({ schemaVersion: 1,
    operationId: "00000000-0000-4000-8000-000000000008", deviceId: "00000000-0000-4000-8000-000000000006",
    taskId: workspaceId, baseVersion: 1, ownerId: null, scope: [], dependencies: [], provenance: {} }),
}, env);
assert.equal(contextUpdated.status, 200);
assert.equal(databaseRequests.at(-1).body.p_base_version, 1);
const resolvedContext = await app.request(`${teamBase}/tasks/${workspaceId}/context?limit=10`, { headers: teamHeaders }, env);
assert.equal(resolvedContext.status, 200);
assert.equal((await resolvedContext.json()).task.title, "Trace checkout flow");
const searchedDecisions = await app.request(`${teamBase}/decisions/search?q=checkout`, { headers: teamHeaders }, env);
assert.equal(searchedDecisions.status, 200);
assert.deepEqual((await searchedDecisions.json()).decisions, []);
const snapshot = await app.request(`${teamBase}/snapshot`, { headers: teamHeaders }, env);
assert.equal(snapshot.status, 200);
assert.deepEqual(await snapshot.json(), { cursor: 4, entities: [] });

for (const file of [
  new URL("../supabase/migrations/20261009081926_restrict_organization_role_lookup.sql", import.meta.url),
  new URL("../supabase/schema.sql", import.meta.url),
]) {
  const schema = await fs.readFile(file, "utf8");
  assert.match(schema, /organization_role_for[\s\S]*?and p_user_id\s*=\s*\(select auth\.uid\(\)\)/i,
    `${file.pathname} must limit role lookups to the authenticated user`);
}

const rpcExposureMigration = await fs.readFile(new URL("../supabase/migrations/20261009082113_revoke_rls_auto_enable_public_execute.sql", import.meta.url), "utf8");
assert.match(rpcExposureMigration, /revoke all on function public\.rls_auto_enable\(\) from public, anon, authenticated/i);

const unauthenticated = await app.request("http://aipi.test/mcp", { method: "POST" }, env);
assert.equal(unauthenticated.status, 401);
assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);

const paired = await app.request("https://aipi.test/pair/sessions", { method: "POST", headers: { authorization: "Bearer test-user-token" } }, env);
assert.equal(paired.status, 201);
const pairing = await paired.json();
assert.equal(pairing.transport, "websocket-relay");
assert.match(pairing.websocketUrl, /^wss:\/\/aipi\.test\/pair\//);
assert.notEqual(pairing.companionSecret, pairing.dashboardSecret);
assert.equal(configuredPairing.sessionId, pairing.sessionId);

const initialized = await app.request("http://aipi.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-user-token" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cloud-smoke", version: "1" } },
  }),
}, env);
assert.equal(initialized.status, 200);
const responseText = await initialized.text();
const jsonText = initialized.headers.get("content-type")?.includes("text/event-stream")
  ? responseText.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}"
  : responseText;
const payload = JSON.parse(jsonText);
assert.equal(payload.result?.serverInfo?.name, "aipi-remote");

const listed = await app.request("http://aipi.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-user-token" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
}, env);
assert.equal(listed.status, 200);
const listedText = await listed.text();
const listedJson = JSON.parse(listed.headers.get("content-type")?.includes("text/event-stream")
  ? listedText.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}"
  : listedText);
const toolNames = listedJson.result.tools.map((tool) => tool.name);
assert.equal(toolNames.includes("list_contract_versions"), true);
assert.equal(toolNames.includes("list_registry_audit"), true);
assert.equal(toolNames.includes("list_organization_members"), true);
assert.equal(toolNames.includes("set_retention_policy"), true);
assert.equal(toolNames.includes("apply_retention_policy"), true);
assert.equal(toolNames.includes("resolve_team_task_context"), true);
assert.equal(toolNames.includes("search_team_decisions"), true);

const resolvedByAgent = await app.request("http://aipi.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-user-token" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "resolve_team_task_context", arguments: { organizationId, taskId: workspaceId, limit: 10 },
  } }),
}, env);
assert.equal(resolvedByAgent.status, 200);
const agentText = await resolvedByAgent.text();
const agentResult = JSON.parse(resolvedByAgent.headers.get("content-type")?.includes("text/event-stream")
  ? agentText.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}" : agentText);
assert.equal(agentResult.result.structuredContent.context.task.title, "Trace checkout flow");

const smokeFetch = globalThis.fetch;
env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
const storedHead = "a".repeat(40);
const storedBase = "c".repeat(40);
let liveHead = "b".repeat(40);
let comparisonReads = 0;
let consumerRead = true;
let sourceRead = true;
let hiddenWorkspaceExists = false;
let missingSubscription = false;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/rest/v1/team_pull_requests?")) return Response.json([{ id: workspaceId,
    organization_id: organizationId, workspace_id: workspaceId, installation_id: 99,
    provider_repository_id: "123456789", repository: "company/platform", number: 7,
    base_sha: storedBase, head_sha: storedHead, changed_project_key:"prj_abcd",changed_node_key:"GET /orders",
    revision_set: [{projectKey:"prj_abcd",commit:storedHead},{projectKey:"prj_consumer",commit:storedBase}] }],
    {headers:{"content-range":"0-0/1"}});
  if (url.includes("/rest/v1/team_github_installations?select=organization_id")) return Response.json([]);
  if (url.includes("/rest/v1/team_github_installations?")) return Response.json([{ installation_id: 99 }],
    {headers:{"content-range":"0-0/1"}});
  if (url.includes("/rest/v1/team_github_user_identities?")) {
    if (init?.method === "POST") return new Response(null, { status: 201 });
    return Response.json([{ github_user_id: 3 }]);
  }
  if (url.includes("/rest/v1/team_ci_receipts?")) {
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer test-service-role-key");
    return Response.json([{provider_repository_id:"987654321",check_name:"checkout-test",head_sha:storedBase,
      conclusion:"success",producer_app_id:22,environment:"ci",source_url:"https://github.com/company/frontend/runs/1"}]);
  }
  if (url.includes("/rest/v1/rpc/get_team_snapshot")) return Response.json({cursor:1,
    entities:[{entityType:"workspace",entityId:workspaceId}]});
  if (url.includes("/rest/v1/team_workspace_subscriptions?")) return Response.json(missingSubscription ? [] : [{
    workspace_id:workspaceId,organization_id:organizationId,plan:"trial",status:"trialing",
    trial_started_at:"2026-01-31T12:00:00Z",trial_ends_at:"2026-04-30T12:00:00Z",
  }],{headers:{"content-range":missingSubscription?"*/0":"0-0/1"}});
  if (url.includes("/rest/v1/organization_memberships?select=role")) return Response.json([{role:"owner"}]);
  if (/\/rest\/v1\/(?:organizations|organization_memberships|team_entitlements|team_source_policies|team_usage_months|team_devices|team_ci_producers)\?/.test(url))
    return Response.json([{id:organizationId,name:"Company"}],{headers:{"content-range":"0-0/1"}});
  if (url.includes("/rest/v1/rpc/broker_publish_team_graph")) {
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer test-service-role-key");
    const body=JSON.parse(init.body);
    assert.equal(body.p_actor_id,"00000000-0000-4000-8000-000000000001");
    return Response.json({nodesProcessed:body.p_nodes.length,edgesProcessed:body.p_edges.length});
  }
  if (url.includes("/rest/v1/rpc/broker_review_team_graph_edge_operation")) {
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer test-service-role-key");
    const body=JSON.parse(init.body);
    assert.equal(body.p_base_version,1);
    return Response.json({id:body.p_edge_id,confirmationState:"confirmed",version:2,
      operationId:body.p_operation_id,wasDuplicate:false});
  }
  if (url.includes("/rest/v1/team_workspaces?")) return Response.json([{id:workspaceId,organization_id:organizationId},
    ...(hiddenWorkspaceExists&&new Headers(init?.headers).get("authorization")==="Bearer test-service-role-key"
      ?[{id:"00000000-0000-4000-8000-000000000617",organization_id:organizationId}]:[])]);
  if (url.includes("/rest/v1/team_workspace_projects?")) return Response.json(url.includes("repository_root")
    ? [{ project_key: "prj_abcd", repository_root: "." }]
    : [{project_key:"prj_abcd",provider_repository_id:"123456789",repository:"company/platform"},
      {project_key:"prj_consumer",provider_repository_id:"987654321",repository:"company/frontend"}]);
  if (url.includes("/rest/v1/team_graph_nodes?")) {
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer test-service-role-key");
    return Response.json([
    {id:"orders-node",project_key:"prj_abcd",node_key:"GET /orders",kind:"contract",label:"Orders",source_ref:"app.py:4",revision_commit:storedBase},
    {id:"frontend-node",project_key:"prj_consumer",node_key:"Checkout",kind:"caller",label:"Checkout",source_ref:"Checkout.tsx:7",revision_commit:storedBase},
    ]);
  }
  if (url.includes("/rest/v1/team_graph_edges?")) {
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer test-service-role-key");
    return Response.json([{id:"00000000-0000-4000-8000-000000000616",from_node_id:"orders-node",to_node_id:"frontend-node",
      evidence_kind:"static",confirmation_state:"confirmed",revision_set:[],source_refs:["Checkout.tsx:7"],required_checks:["checkout-test"]}]);
  }
  if (url === "https://api.github.com/user") return Response.json({ id: 3, login: "owner" });
  if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "github-user-token-for-smoke", expires_in: 3600 });
  if (url.includes("/user/installations/99/repositories?")) return Response.json({ repositories: [
    ...(sourceRead?[{id:123456789,full_name:"company/platform",permissions:{pull:true}}]:[]),
    ...(consumerRead?[{id:987654321,full_name:"company/frontend",permissions:{pull:true}}]:[])] });
  if (url.includes("/user/installations?")) return Response.json({ installations: [
    { id: 99, app_id: 1, account: {login:"company"} },
    { id: 100, app_id: 1, account: {login:"another-company"} }] });
  if (url.endsWith("/repos/company/platform/pulls/7")) return Response.json({ head: { sha: liveHead }, base: { sha: storedBase } });
  if (url.includes("/repos/company/platform/contents/openapi.json?ref=")) {
    const old = url.endsWith(storedBase);
    const document = {openapi:"3.1.0",paths:{"/orders":{get:{responses:{200:{content:{"application/json":{
      schema:{type:"object",properties:old?{id:{type:"string"},total:{type:"number"}}:{id:{type:"string"}}}}}}}}}}};
    const content = Buffer.from(JSON.stringify(document)).toString("base64");
    return Response.json({type:"file",size:Buffer.byteLength(JSON.stringify(document)),encoding:"base64",content});
  }
  if (url.includes("/repos/company/platform/compare/")) { comparisonReads++; return Response.json({ files: [
    {filename:"app.py",patch:"@@ -4 +4 @@"},{filename:"openapi.json",patch:"@@ -1 +1 @@"}], total_commits: 1 }); }
  return smokeFetch(input, init);
};
const githubOAuthEnv = { ...env, GITHUB_APP_CLIENT_ID: "test-client-id", GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  GITHUB_APP_CALLBACK_URL: "https://app.aipi.website/team/github-callback", GITHUB_OAUTH_STATE_SECRET: "test-state-secret" };
const githubStart = await app.request("http://aipi.test/api/team/github/oauth/start", { method: "POST", headers: teamHeaders,
  body: JSON.stringify({ returnTo: "/team" }) }, githubOAuthEnv);
assert.equal(githubStart.status, 200);
const githubState = (await githubStart.json()).state;
const githubExchange = await app.request("http://aipi.test/api/team/github/oauth/exchange", { method: "POST", headers: teamHeaders,
  body: JSON.stringify({ code: "test-github-code-1234567890", state: githubState }) }, githubOAuthEnv);
assert.equal(githubExchange.status, 200, "a 201 empty PostgREST identity write must complete GitHub authorization");
assert.equal((await githubExchange.json()).githubUser.login, "owner");
const availableInstallations = await app.request(`${teamBase}/github/available-installations`, {
  headers: { ...teamHeaders, "x-aipi-github-user-token": "github-user-token-for-smoke" } }, { ...githubOAuthEnv, GITHUB_APP_ID: "1" });
assert.equal(availableInstallations.status, 200);
assert.deepEqual((await availableInstallations.json()).installations.map((item) => [item.id, item.connected]), [[99, true], [100, false]]);
const connectedInstallation = await app.request(`${teamBase}/github/installations`, { method: "POST", headers: teamHeaders,
  body: JSON.stringify({ installationId: 99, githubUserToken: "github-user-token-for-smoke" }) },
  { ...githubOAuthEnv, GITHUB_APP_ID: "1" });
assert.equal(connectedInstallation.status, 201, "user-verified installation linking must not depend on an App private key");
const inaccessibleInstallation = await app.request(`${teamBase}/github/installations`, { method: "POST", headers: teamHeaders,
  body: JSON.stringify({ installationId: 101, githubUserToken: "github-user-token-for-smoke" }) },
  { ...githubOAuthEnv, GITHUB_APP_ID: "1" });
assert.equal(inaccessibleInstallation.status, 403);
const assessRequest = { method: "POST", headers: teamHeaders,
  body: JSON.stringify({ githubUserToken: "github-user-token-for-smoke" }) };
const assessmentUrl = `http://aipi.test/api/team/pull-requests/${workspaceId}/assess`;
const staleAssessment = await app.request(assessmentUrl, assessRequest, { ...env, GITHUB_APP_ID: "1" });
assert.equal(staleAssessment.status, 409);
assert.equal((await staleAssessment.json()).currentHead, liveHead);
assert.equal(comparisonReads, 0, "a stale PR must not run an assessment");
liveHead = storedHead;
const currentAssessment = await app.request(assessmentUrl, assessRequest, { ...env, GITHUB_APP_ID: "1" });
assert.equal(currentAssessment.status, 200);
const currentBody = (await currentAssessment.json()).assessment;
assert.equal(currentBody.comparison.headSha, storedHead);
assert.equal(currentBody.ledger.components.some(component=>component.projectId==="prj_consumer"),true);
assert.equal(currentBody.semanticComparisons[0].changes[0].kind,"property_removed");
assert.equal(comparisonReads, 1);
const graphUrl=`http://aipi.test/api/team/workspaces/${workspaceId}/graph`;
const graphHeaders={...teamHeaders,"x-aipi-github-user-token":"github-user-token-for-smoke"};
const graphPreflight=await app.request(graphUrl,{method:"OPTIONS",headers:{origin:"https://aipi.website",
  "access-control-request-method":"GET","access-control-request-headers":"authorization,x-aipi-github-user-token"}},{...env,GITHUB_APP_ID:"1"});
assert.match(graphPreflight.headers.get("access-control-allow-headers")||"",/x-aipi-github-user-token/);
const readableGraph=await app.request(graphUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"});
assert.equal(readableGraph.status,200);
assert.equal((await readableGraph.json()).nodes.length,2);
const publishUrl=`http://aipi.test/api/team/workspaces/${workspaceId}/graph/publish`;
const publishRequest={method:"POST",headers:graphHeaders,body:JSON.stringify({nodes:[{projectKey:"prj_consumer",
  nodeKey:"Checkout",kind:"caller",label:"Checkout",revisionCommit:storedBase}],edges:[]})};
assert.equal((await app.request(publishUrl,publishRequest,{...env,GITHUB_APP_ID:"1"})).status,200);
const reviewUrl=`http://aipi.test/api/team/workspaces/${workspaceId}/graph/edges/00000000-0000-4000-8000-000000000616/review`;
const reviewRequest={method:"POST",headers:graphHeaders,body:JSON.stringify({schemaVersion:1,
  operationId:"00000000-0000-4000-8000-000000000641",deviceId:"00000000-0000-4000-8000-000000000642",
  baseVersion:1,confirm:true})};
assert.equal((await app.request(reviewUrl,reviewRequest,{...env,GITHUB_APP_ID:"1"})).status,200);
const graphWithoutGithubGrant=await app.request(graphUrl,{headers:teamHeaders},{...env,GITHUB_APP_ID:"1"});
assert.deepEqual((await graphWithoutGithubGrant.json()).nodes,[]);
const impactUrl=`http://aipi.test/api/team/workspaces/${workspaceId}/impact`;
const impactRequest={method:"POST",headers:graphHeaders,body:JSON.stringify({changedProjectKey:"prj_abcd",changedNodeKey:"GET /orders",
  revisionSet:[{projectKey:"prj_abcd",commit:storedHead}]})};
const readableImpact=await app.request(impactUrl,impactRequest,{...env,GITHUB_APP_ID:"1"});
assert.equal(readableImpact.status,200);
assert.equal((await readableImpact.json()).report.affected[0].projectKey,"prj_consumer");
const reportUrl=`http://aipi.test/api/team/pull-requests/${workspaceId}/report`;
liveHead="b".repeat(40);
assert.equal((await app.request(reportUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"})).status,409,
  "a PR report must not use an earlier webhook head after a new push");
liveHead=storedHead;
const candidateReport=await app.request(reportUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"});
assert.equal(candidateReport.status,200);
assert.equal((await candidateReport.json()).report.status,"unverified","CI success alone cannot complete Team proof");
assert.equal((await app.request(reportUrl,{headers:teamHeaders},{...env,GITHUB_APP_ID:"1"})).status,403);
const exportUrl=`http://aipi.test/api/team/organizations/${organizationId}/export`;
assert.equal((await app.request(exportUrl,{headers:teamHeaders},{...env,GITHUB_APP_ID:"1"})).status,403,
  "full export requires a current grant for every bound repository");
const authorizedExport=await app.request(exportUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"});
assert.equal(authorizedExport.status,200);
const exported=await authorizedExport.json();
assert.equal(exported.graphNodes.length,2);
assert.equal(exported.receipts.length,1);
assert.equal(exported.subscriptions[0].trial_ends_at,"2026-04-30T12:00:00Z",
  "expired trial dates remain exportable while repository rights hold");
missingSubscription=true;
assert.equal((await app.request(exportUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"})).status,409,
  "export refuses to omit a workspace subscription");
missingSubscription=false;
hiddenWorkspaceExists=true;
assert.equal((await app.request(exportUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"})).status,403,
  "organization export cannot silently omit an inaccessible workspace");
hiddenWorkspaceExists=false;
consumerRead = false;
assert.equal((await app.request(publishUrl,publishRequest,{...env,GITHUB_APP_ID:"1"})).status,403);
assert.equal((await app.request(reviewUrl,reviewRequest,{...env,GITHUB_APP_ID:"1"})).status,403);
const revokedAssessment = await app.request(assessmentUrl, assessRequest, { ...env, GITHUB_APP_ID: "1" });
assert.equal(revokedAssessment.status, 200);
const revokedBody = (await revokedAssessment.json()).assessment;
assert.equal(revokedBody.coverage.restrictedScope,true);
assert.equal(JSON.stringify(revokedBody).includes("Checkout"),false);
assert.equal(JSON.stringify(revokedBody).includes("checkout-test"),false);
assert.equal(revokedBody.ledger.status,"unknown");
const revokedGraph=await app.request(graphUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"});
assert.equal(revokedGraph.status,200);
assert.equal(JSON.stringify(await revokedGraph.json()).includes("Checkout"),false);
const revokedImpact=await app.request(impactUrl,impactRequest,{...env,GITHUB_APP_ID:"1"});
assert.equal(revokedImpact.status,200);
assert.deepEqual((await revokedImpact.json()).report.affected,[]);
const revokedReport=await app.request(reportUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"});
assert.equal(revokedReport.status,200);
assert.equal(JSON.stringify(await revokedReport.json()).includes("checkout-test"),false);
assert.equal((await app.request(exportUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"})).status,403,
  "full export must fail when any bound consumer grant is revoked");
sourceRead = false;
const sourceRevoked = await app.request(assessmentUrl, assessRequest, { ...env, GITHUB_APP_ID: "1" });
assert.equal(sourceRevoked.status,403);
assert.equal(comparisonReads,2,"source revocation must stop before comparison reads");
const noBoundGraph=await app.request(graphUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"});
assert.equal((await noBoundGraph.json()).nodes.length,0);
assert.equal((await app.request(impactUrl,impactRequest,{...env,GITHUB_APP_ID:"1"})).status,403);
assert.equal((await app.request(reportUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"})).status,403);
assert.equal((await app.request(exportUrl,{headers:graphHeaders},{...env,GITHUB_APP_ID:"1"})).status,403);

globalThis.fetch = originalFetch;

console.log("AIPI Cloudflare/Hono MCP smoke test passed");
