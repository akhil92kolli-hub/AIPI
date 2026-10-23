import assert from "node:assert/strict";
import { resolveImportedWorkspaceManifest } from "../ui/workspace-explorer.js";

const local = { schemaVersion: 2, workspaceId: "wsg_local", membershipVersion: 3, bindingVersion: 2, resources: [
  { projectId: "prj_api1", name: "API", repository: null },
  { projectId: "prj_web1", name: "Web", repository: null },
] };
const imported = { schemaVersion: 2, workspaceId: "wsg_other", resources: [
  { projectId: "prj_remote_api", name: "API", repository: { provider: "github", providerRepositoryId: "123", remote: "https://github.com/org/api", root: "services/api", localPath: "/private/repo", token: "secret" }, localPath: "/private/repo" },
  { projectId: "prj_remote_web", name: "Web", repository: null },
] };
const resolved = resolveImportedWorkspaceManifest(local, imported, { prj_api1: "prj_remote_api", prj_web1: "prj_remote_web" });
assert.equal(resolved.workspaceId, "wsg_local");
assert.equal(resolved.bindingVersion, 2);
assert.deepEqual(resolved.resources.map((entry) => entry.projectId), ["prj_api1", "prj_web1"]);
assert.equal(resolved.resources[0].repository.remote, "https://github.com/org/api");
assert.equal(JSON.stringify(resolved).includes("/private/repo"), false);
assert.equal(JSON.stringify(resolved).includes("secret"), false);
assert.throws(() => resolveImportedWorkspaceManifest(local, imported, { prj_api1: "prj_remote_api", prj_web1: "prj_remote_api" }), /at most once/);
assert.throws(() => resolveImportedWorkspaceManifest(local, imported, { prj_api1: "unknown" }), /at most once/);
console.log("Imported workspace resolution preserves local identity and rejects duplicate mappings");
