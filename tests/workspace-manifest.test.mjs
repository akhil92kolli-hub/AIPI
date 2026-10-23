import assert from "node:assert/strict";
import { canonicalGithubRepositoryRemote, exportWorkspaceManifest, normalizeRepositoryBinding, saveWorkspaceCheckoutBinding, saveWorkspaceManifest, verifyGithubRepositoryIdentity, workspaceCheckoutBindings } from "../packages/core/workspace-manifest.mjs";

const state = {
  projects: [
    { id: "api", name: "API", gitBinding: { root: "/private/checkout", repositoryUrl: "https://secret@github.com/org/api" } },
    { id: "web", name: "Web" }
  ],
  workspaceGroups: [
    { id: "wsg_product", name: "Product", projectIds: ["api", "web"], version: 1 },
    { id: "wsg_shared", name: "Shared", projectIds: ["api"], version: 1 }
  ]
};
const binding = { provider: "github", providerRepositoryId: "123", remote: "https://github.com/org/platform.git", root: "services/api" };
const manifest = exportWorkspaceManifest(state, "wsg_product");
assert.equal(JSON.stringify(manifest).includes("secret"), false);
assert.equal(JSON.stringify(manifest).includes("/private"), false);
manifest.resources[0].repository = { ...binding, localPath: "/private/checkout", token: "secret", identityStatus: "verified" };
const saved = saveWorkspaceManifest(state, "wsg_product", manifest);
assert.equal(saved.bindingVersion, 1);
assert.equal(saved.resources[0].repository.identityStatus, "declared");
assert.equal(saved.resources[0].repository.remote, "https://github.com/org/platform");
assert.equal(JSON.stringify(saved).includes("secret"), false);
assert.equal(exportWorkspaceManifest(state, "wsg_shared").bindingVersion, 1);
assert.throws(() => saveWorkspaceManifest(state, "wsg_product", manifest), { statusCode: 409 });
assert.equal(saveWorkspaceManifest(state, "wsg_product", saved).bindingVersion, 1);
for (const root of ["../api", "/tmp/api", "a/../b", "C:\\repo", "a//b", "./api"]) {
  assert.throws(() => normalizeRepositoryBinding({ ...binding, root }), { statusCode: 400 });
}
for (const remote of ["https://token@github.com/org/repo", "https://github.com/org/repo?token=x", "https://evil.test/org/repo", "file:///repo"]) {
  assert.throws(() => normalizeRepositoryBinding({ ...binding, remote }), { statusCode: 400 });
}
const before = JSON.stringify(state);
const invalid = structuredClone(saved);
invalid.resources[0].repository = null;
invalid.resources[1].repository = { ...binding, root: "../escape" };
assert.throws(() => saveWorkspaceManifest(state, "wsg_product", invalid), { statusCode: 400 });
assert.equal(JSON.stringify(state), before, "Validation must complete before any bindings change");
const foreign = structuredClone(saved);
foreign.resources[1].projectId = "foreign";
assert.throws(() => saveWorkspaceManifest(state, "wsg_product", foreign), { statusCode: 400 });
assert.equal(JSON.stringify(state), before);
const duplicate = structuredClone(saved);
duplicate.resources[1].projectId = "api";
assert.throws(() => saveWorkspaceManifest(state, "wsg_product", duplicate), { statusCode: 400 });
assert.equal(canonicalGithubRepositoryRemote("git@github.com:Org/Platform.git"), "https://github.com/org/platform");
const verified = await verifyGithubRepositoryIdentity(binding, { fetchImpl: async () => new Response(JSON.stringify({ html_url: "https://github.com/org/platform", full_name: "org/platform" }), { status: 200 }) });
assert.equal(verified.identityStatus, "verified");
assert.equal(verified.providerName, "org/platform");
state.projects[0].repositoryBinding = verified;
const verifiedManifest = exportWorkspaceManifest(state, "wsg_product");
const verifiedVersion = verifiedManifest.bindingVersion;
saveWorkspaceManifest(state, "wsg_product", verifiedManifest);
assert.equal(state.projects[0].repositoryBinding.identityStatus, "verified", "An unchanged manifest keeps GitHub verification");
assert.equal(exportWorkspaceManifest(state, "wsg_product").bindingVersion, verifiedVersion);
const changedManifest = exportWorkspaceManifest(state, "wsg_product");
changedManifest.resources[0].repository.root = "services/new-api";
assert.throws(() => saveWorkspaceManifest(state, "wsg_product", changedManifest), {statusCode:409});
assert.equal(state.projects[0].repositoryBinding.identityStatus, "verified", "A directory change cannot repurpose an existing source identity");
state.projects[0].repositoryBinding = verified;
await assert.rejects(() => verifyGithubRepositoryIdentity(binding, { fetchImpl: async () => new Response(JSON.stringify({ html_url: "https://github.com/other/repository" }), { status: 200 }) }), { statusCode: 409 });
const checkout = saveWorkspaceCheckoutBinding(state, "wsg_product", { projectId: "api", root: "/device-a/api" }, {
  repositoryRoot: "/device-a/api", commit: "a".repeat(40), branch: "main",
  remotes: [{ name: "origin", fetchUrl: "git@github.com:org/platform.git" }]
});
assert.equal(checkout.remoteName, "origin");
assert.equal(workspaceCheckoutBindings(state, "wsg_product")[0].root, "/device-a/api");
assert.equal(workspaceCheckoutBindings(state, "wsg_shared")[0].root, "/device-a/api");
saveWorkspaceCheckoutBinding(state, "wsg_product", { projectId: "api", root: "/device-a/api-feature", label: "Feature worktree" }, {
  repositoryRoot: "/device-a/api-feature", commit: "b".repeat(40), branch: "feature/team",
  remotes: [{ name: "origin", fetchUrl: "https://github.com/org/platform.git" }]
});
assert.equal(workspaceCheckoutBindings(state, "wsg_product").length, 2, "A project can resolve to multiple local worktrees");
assert.throws(() => saveWorkspaceCheckoutBinding(state, "wsg_product", { projectId: "api", root: "/device-a/api" }, {
  repositoryRoot: "/device-a/api", commit: "a".repeat(40), remotes: [{ name: "origin", fetchUrl: "https://github.com/other/repository" }]
}), { statusCode: 409 });
console.log("Portable manifests: identity, path isolation, atomic validation, and shared-project concurrency passed");
