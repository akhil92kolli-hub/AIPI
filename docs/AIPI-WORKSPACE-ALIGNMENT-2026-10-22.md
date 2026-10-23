# AIPI workspace alignment — 22 October 2026

Identity corrections in [the 23 October workflow contract](AIPI-WORKFLOW-ACCEPTANCE-2026-10-23.md) supersede conflicting resource/project assumptions below. Current trust, impact and deployment implementation priorities are reconciled in [the cross-repository release plan](AIPI-TRUSTED-CROSS-REPO-RELEASE-PLAN-2026-10-23.md).

## Product contract

A workspace is the collaboration, subscription and cross-project analysis boundary. It contains project resources. A resource represents a repository, a directory inside a repository, a local source folder or an external service. Keep those terms consistent in Local, IDE and Cloud.

AIPI project keys (`prj_…`) remain stable. They are not GitHub repository IDs. Existing links must continue to resolve. Cloud workspaces retain their UUIDs; a project key can be an alias only when exactly one accessible workspace contains it. If several do, ask the user to choose. Local-only data never becomes available merely because its key appears in a URL.

The five dashboard tabs remain Home, Explore, Tasks, K-Maps and Tools. Local and Cloud use the same shared workspace presentation. Available actions depend on the data provider and permissions. Cloud must identify unavailable local execution, secrets and runtime capabilities accurately.

Canonical Cloud routes:

- `/workspace`: authenticated workspace list and creation.
- `/workspace/<workspace UUID>`: dashboard with all project resources.
- `/workspace/<workspace UUID>/manage/general`: resource and repository mappings, access and subscription settings.
- `/workspace/<workspace UUID>/manage/{environments,vault,policies,mesh}`: settings routes with explicit current capability status.
- `/workspace/prj_…`: membership-checked compatibility alias.
- `/workspace/connect`: ticket-protected local/IDE import and OAuth review.
- Old `/team`, `/team/dashboard` and root-domain `/dashboard/...` links redirect to the workspace application. Existing OAuth callback URLs remain supported.

Local browser routes accept `/projects/...` and `/workspace/...`; newly generated browser links use `/workspace`. Existing IDE hash routes remain compatible.

## Implemented in this correction

1. Publish the current website build to the root and app domains. Remove the unsupported raw local UI at the public `/dashboard` URL through redirects.
2. Add the authenticated Cloud workspace launcher, creation and a local project selection entry point. Selecting a local project opens the companion's own picker; a website does not silently enumerate local projects or scan local ports.
3. Resolve project aliases through authenticated, RLS-filtered workspace membership. Ambiguous and inaccessible keys do not fall back to the last viewed workspace.
4. Open workspace settings after pairing and provide the dashboard link for that exact workspace.
5. Add an installed GitHub repository as a separate project resource in an existing workspace. Each resource retains a distinct `prj_` key and repository-relative root. Monorepo roots remain separate mappings.
6. Retain separate local Git publishing mappings per authorized source folder. Inspecting or publishing one root cannot inherit another root's remote. Existing primary mappings remain compatible.
7. Keep source and mutation checks on the server. Selecting a repository does not grant GitHub access; current user and App installation access are verified before binding.

## Remaining milestones and acceptance criteria

### W1 — Resource identity and bidirectional reconciliation

Introduce an explicit resource record linking local root ID, cloud resource ID, parent workspace and optional GitHub immutable repository ID + relative path. Preserve existing project/task IDs with an additive migration and a reviewable import preview. A local project containing several independent Git roots must migrate to several resources without duplicating its tasks, contracts or evidence. Additional filesystem roots are currently not automatically independent Cloud project resources.

Add cloud binding/version reconciliation to the companion sync protocol. A binding added after pairing must arrive on each authorized device, validate against local Git remotes, and either attach or raise a visible conflict. Device paths remain local. Mapping changes must never overwrite Git remotes. Two devices may independently map different checkout paths to the same cloud resource.

Acceptance: two repositories plus two monorepo subfolders, two devices, offline changes, retries and conflicting bindings. Exact resource and revision provenance must survive round trips.

### W2 — Feature and settings parity

Replace legacy task administration inside workspace settings with focused resources, environments, vault, policies and mesh panels. Reuse the local feature components through explicit local/cloud data adapters; shared tab markup alone does not establish full functional parity. Cloud environment/vault/mesh routes currently explain the capability boundary rather than claiming local execution is available.

Acceptance: the same Home/Explore/Tasks/K-Maps/Tools journeys against a local workspace and a cloud workspace, including permission-denied, companion-offline and missing-snapshot states. Preserve account/org/workspace selection across GitHub OAuth without accidental workspace substitution.

### W3 — Cross-repository impact and continuous knowledge

The current PR assessment endpoint requires exactly one project mapping for the changed repository; extend it to fan out over all relevant monorepo resource roots before claiming monorepo assessment parity. Track commits and branch references per resource. GitHub webhook jobs must index only the changed resource at the pinned revision, update knowledge/contracts, retain graph provenance and invalidate stale downstream receipts. Analyze consumers across the workspace's other resources. Report unknown or inaccessible consumers explicitly. Enable relevant local or CI checks and record revision-bound receipts; a dependency candidate is not a passed verification.

Acceptance: change an API contract in repo A, identify a confirmed consumer in repo B, run selected checks, and show precisely which commit and contract were verified. Repeated and out-of-order webhook deliveries must not duplicate or roll back knowledge.

### W4 — Access, invitations and delivery

Discover eligible collaborators through permissions supported by the installed GitHub App. GitHub usernames do not reliably provide email addresses; ask the workspace owner to select recipients and supply an address when required. Send only explicit invitations, retain existing invite acceptance and workspace roles, and recheck current repository permissions for writes. Do not automatically email every collaborator.

Finish workspace-scoped billing and entitlement enforcement, release the companion/extension updates, and run an authenticated end-to-end test: local init → select project → sign in → create/select cloud workspace → connect repo → add second repo → sync from two devices → assess cross-repo change → verify → invite selected teammate.

## Delivery notes

This correction repairs routing, workspace entry points and Git mapping storage. It does not claim automatic source upload, arbitrary remote filesystem access, cloud runtime execution, collaborator email discovery, complete component parity, or automatic cross-repository knowledge indexing. Those require the explicit data and execution capabilities above.
