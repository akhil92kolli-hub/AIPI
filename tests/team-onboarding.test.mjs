import assert from "node:assert/strict";
import { TeamOnboardingTickets, enqueueInitialTeamTasks, localRepositorySuggestion, teamProjectPreview, teamWorkspacePreview, teamTaskStatus } from "../packages/core/team-onboarding.mjs";

const projectKey = "prj_abcdefgh";
const state = { projects: [{ id: projectKey, name: "Orders", sourceContext: { roots: [{ path: "/private/source" }] },
  environments: [{ variables: [{ key: "SECRET", value: "do-not-share" }] }],
  tasks: [{ id: "task_one", title: "Fix checkout", status: "planned", description: "Sensitive notes" },
    { id: "task_two", title: "Verify payment", status: "done" }] }] };
const preview = teamProjectPreview(state, projectKey);
assert.equal(teamTaskStatus("in-progress"), "in_progress");
assert.equal(teamTaskStatus("in-review"), "in_review");
const multi = teamWorkspacePreview({projects:[...state.projects,{id:"prj_react",name:"React",tasks:[{id:"task_ui",title:"Update caller",status:"in-review"}]}],workspaceGroups:[{id:"wsg_12345678",name:"Commerce",projectIds:[projectKey,"prj_react"]}]},"wsg_12345678");
assert.equal(multi.projects.length,2);
assert.equal(multi.taskCount,3);
assert.equal(multi.projects[1].tasks[0].status,"in_review");
assert.deepEqual(preview.tasks.map(({ title, status }) => [title, status]), [["Fix checkout", "open"], ["Verify payment", "completed"]]);
assert.doesNotMatch(JSON.stringify(preview), /do-not-share|Sensitive notes|\/private\/source/);
assert.equal(preview.repository, null);
assert.equal(preview.candidateRemoteUrl, null);
const hinted = teamProjectPreview({projects:[{...state.projects[0], gitBinding:{repositoryUrl:"git@github.com:Acme/Orders.git",sourceRoot:"/private/source"}}]},projectKey);
assert.equal(hinted.candidateRemoteUrl,"https://github.com/acme/orders");
assert.equal(hinted.candidateRepositoryRoot,null);
assert.doesNotMatch(JSON.stringify(hinted), /\/private\/source/);
const nested = localRepositorySuggestion({gitBinding:{repositoryUrl:"git@github.com:Acme/Orders.git",
  repositoryRoot:"/private/repo",sourceRoot:"/private/repo/apps/orders"}});
assert.deepEqual(nested,{remoteUrl:"https://github.com/acme/orders",repositoryRoot:"apps/orders"});
assert.equal(localRepositorySuggestion({gitBinding:{repositoryUrl:"https://github.com/acme/orders",
  repositoryRoot:"/private/repo",sourceRoot:"/private/another"}}).repositoryRoot,null);
const tickets = new TeamOnboardingTickets();
const issued = tickets.create(projectKey, 1000);
assert.equal(tickets.get(issued.ticket, 1001).projectKey, projectKey);
assert.equal(tickets.consume(issued.ticket, 1001).projectKey, projectKey);
assert.throws(() => tickets.get(issued.ticket, 1002), /expired/i);
const expired = tickets.create(projectKey, 1000);
assert.throws(() => tickets.get(expired.ticket, 601001), /expired/i);
const oauthTicket = tickets.create(projectKey, 1000);
const oauth = tickets.beginOAuth(oauthTicket.ticket, 1001);
assert.match(oauth.url, /^https:\/\/zwffmaxjbzuazopvorkv\.supabase\.co\/auth\/v1\/oauth\/authorize\?/);
assert.equal(new URL(oauth.url).searchParams.get("code_challenge_method"), "S256");
assert.equal(tickets.verifyOAuth(oauthTicket.ticket, oauth.state, 1002).projectKey, projectKey);
assert.throws(() => tickets.verifyOAuth(oauthTicket.ticket, "x".repeat(43), 1002), /did not match/);

const operations = new Map();
const store = { enqueue(input) {
  const previous = operations.get(input.operationId);
  if (previous) assert.deepEqual(previous, input);
  operations.set(input.operationId, input);
} };
const ids = { organizationId: "11111111-1111-4111-a111-111111111111", workspaceId: "22222222-2222-4222-a222-222222222222",
  deviceId: "33333333-3333-4333-a333-333333333333", actorId: "44444444-4444-4444-a444-444444444444" };
assert.equal(enqueueInitialTeamTasks(store, preview, ids), 2);
assert.equal(enqueueInitialTeamTasks(store, preview, ids), 2);
assert.equal(operations.size, 2, "reopening onboarding must not duplicate initial task operations");
for (const operation of operations.values()) {
  assert.match(operation.operationId, /^[0-9a-f-]{36}$/);
  assert.match(operation.payload.externalId, /^task_[0-9a-f]{32}$/);
  assert.equal(operation.action, "patch");
  assert.deepEqual(Object.keys(operation.payload.patch).sort(), ["status", "title"]);
}
console.log("Team onboarding preview, ticket, and idempotent import passed");
