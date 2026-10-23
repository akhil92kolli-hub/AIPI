import assert from "node:assert/strict";
import { createTeamSessionManager } from "../packages/core/team-session-manager.mjs";

const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const calls = [];
const manager = createTeamSessionManager({
  start: async (_store, options) => {
    calls.push(`start:${options.organizationId}`);
    const status = { result: { organizationId: options.organizationId } };
    options.onStatus(status);
    return {
      organizationId: options.organizationId,
      status: () => status,
      runNow: async () => { calls.push(`run:${options.organizationId}`); return status; },
      stop: async () => { calls.push(`stop:${options.organizationId}`); },
    };
  },
});

await Promise.all([manager.connect({}, { organizationId: orgA, accessToken: "a" }), manager.connect({}, { organizationId: orgB, accessToken: "b" })]);
assert.deepEqual(manager.activeOrganizationIds().sort(), [orgA, orgB]);
assert.equal(manager.status(orgB).result.organizationId, orgB);
await manager.connect({}, { organizationId: orgA, accessToken: "a2" });
assert.equal(calls.filter((call) => call === `stop:${orgA}`).length, 1, "reconnect replaces only its own account");
await manager.connect({}, { organizationId: orgA, accessToken: "stale-restored" }, { ifAbsent: true });
assert.equal(calls.filter((call) => call === `start:${orgA}`).length, 2, "late credential restoration cannot replace a fresh sign-in");
assert.equal(calls.filter((call) => call === `stop:${orgB}`).length, 0);
await manager.runAll();
assert.ok(calls.includes(`run:${orgA}`));
assert.ok(calls.includes(`run:${orgB}`));
const bRuns = calls.filter((call) => call === `run:${orgB}`).length;
await manager.runAll([orgA]);
assert.equal(calls.filter((call) => call === `run:${orgB}`).length, bRuns, "local edits wake only the affected account");
await manager.disconnect(orgA);
assert.equal(manager.get(orgA), null);
assert.ok(manager.get(orgB), "disconnect leaves another account live");
assert.equal(await manager.connect({}, { organizationId: orgA, accessToken: "old" }, { ifAbsent: true }), null,
  "a delayed startup restore cannot undo an explicit disconnect");
await manager.connect({}, { organizationId: orgA, accessToken: "new" });
assert.ok(manager.get(orgA), "a new explicit sign-in may reconnect the account");
await manager.close();
assert.equal(calls.filter((call) => call === `stop:${orgB}`).length, 1);
await assert.rejects(manager.connect({}, { organizationId: orgA, accessToken: "a" }), /stopped/);

const failing = createTeamSessionManager({ start: async () => { throw new Error("expired"); } });
await assert.rejects(failing.connect({}, { organizationId: orgA }), /expired/);
assert.match(failing.status(orgA).result.error, /expired/);
await failing.close();
console.log("Team sessions remain independent across accounts and restore failures are visible");
