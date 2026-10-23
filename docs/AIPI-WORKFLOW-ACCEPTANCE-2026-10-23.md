# AIPI user experience architecture and acceptance contract

For the current trusted-context, cross-repository impact and deployment-gating implementation sequence, see [the reconciled release plan](AIPI-TRUSTED-CROSS-REPO-RELEASE-PLAN-2026-10-23.md). This document retains ownership of canonical identity and additive migration requirements.

Updated 23 October 2026. This document supersedes the earlier ten-point workflow where it conflicted with the identity model below. Architecture completeness and implemented capability completeness are different: a working URL, schema or build does not establish end-to-end product acceptance.

## 1. Product model and terminology

AIPI is one workspace application with local and Team providers. The workspace is the collaboration, subscription, policy and cross-project analysis boundary. The IDE binds its view to explicitly trusted projects; the companion can switch workspaces. Team uses authorized shared data and available runners. Local use stays free and works without a cloud account or GitHub.

| Entity | Meaning | Identity / scope | Must not represent |
|---|---|---|---|
| Account / organization | Team membership and commercial ownership | Supabase organization UUID | A GitHub organization or repository |
| Workspace | Named collection of logical projects | Canonical UUID; existing `wsg_…` remains a local alias | A repository, a project or a checkout path |
| Project | Logical application, service or component | Stable `prj_…`, always authorized within workspace membership | The workspace itself or a GitHub repository ID |
| Source binding | Portable declaration of source used by one project | Stable `src_…`, project owner, kind, version | An absolute filesystem path or permission grant |
| Repository | Source-control identity | Provider + immutable provider repository ID | Repository display name, remote name or branch |
| Repository directory | A source binding's directory within its repository | Relative path such as `.` or `apps/api` | A separate repository or a machine path |
| Device | An installation participating in sync | Local device UUID; explicit cloud device registration | A user identity |
| Checkout | Device-local attachment of a source binding to an authorized folder | Stable `cko_…`, device, project, source binding | A portable source binding or cloud storage location |
| Revision | Exact source state referenced by knowledge/evidence | Project ID + source binding ID + immutable commit; explicit local working-state fingerprint when applicable | A branch name, task status or current HEAD assumption |
| User identity | AIPI account and optionally linked GitHub identity | Supabase user UUID and verified provider user ID | An invitation email inferred from a GitHub login |

Relationships:

- An account has workspaces; a workspace contains projects through explicit membership.
- A project has zero or more source bindings. An empty project is valid during setup.
- A source binding has kind `repository`, `local`, or `external`.
- A repository source declares immutable repository identity and a relative directory. One repository may serve several projects or bindings, including monorepos.
- A logical project may use several repositories. Adding another repository does not automatically create another logical project.
- A local source needs an authorized checkout. An external source has a credential-free endpoint and no Git checkout.
- A source binding can have different checkout paths on different devices. Paths and credentials never enter portable identity documents or cloud source records.
- A project can be included in several explicitly authorized workspaces. Project-only legacy links must prompt for a workspace when ambiguous.

Do not silently split a legacy multi-folder project. Existing tasks, contracts, evidence and history keep their project ownership. Create source identities for its folders; moving a source to a different logical project requires an explicit reference migration and review.

## 2. Identity invariants

1. Renaming a workspace, project, repository or folder cannot change its stable identity.
2. Repository names/URLs are display and transport metadata; immutable provider repository IDs identify repositories.
3. Source binding IDs are independent of device paths. New IDs are persisted once. The deterministic legacy primary source adapter is `src_` plus the first 24 hex characters of `md5('aipi:primary:' + projectId)`, identical in the local migration and SQL backfill.
4. A binding's established repository identity or relative directory is not silently reassigned. Add a new source and review affected references. Ordinary branch tracking can change without changing source identity.
5. A device checkout may attach only to a folder already authorized for the project. Repository remotes and the relative directory must match when attaching repository sources.
6. A repository declaration or Git remote hint does not prove current user access or successful verification.
7. Tasks may span projects. Revision sets must additionally identify source bindings, so two repositories in one project can have different commits.
8. Old clients retain their primary repository adapter. Multi-source operations must use source-aware adapters or return a visible unsupported/unknown result. Never use the primary repository's permissions to authorize another source.
9. Importing cloud source metadata must not invent a local checkout, replace remotes or grant filesystem access.
10. Authentication state, device credentials and GitHub access tokens must not appear in project IDs, URLs, portable manifests, graph labels or logs.

## 3. Storage and migration contract

### Local engine and IDE

The local workspace store retains existing `projects`, `workspaceGroups`, tasks and evidence. An additive identity schema introduces:

- `workspaceGroups[].canonicalId`: portable UUID for a new local workspace. `teamWorkspaceId`, when linked, identifies the explicitly selected cloud destination; the `wsg_…` local alias remains intact.
- `projects[].sourceBindings[]`: typed portable declarations with ID, name, repository/endpoint, and version.
- `sourceContext.roots[].sourceBindingId`: the authorized folder's source attachment.
- `deviceCheckoutBindings[]`: device-local checkout IDs and paths, source/project IDs and inspected Git state.
- Source-aware revision references with immutable commits.

Migration creates a protected-byte backup before persistence, runs under the existing workspace writer lock, preserves ownership, and is idempotent. Existing per-folder Git publishing configuration remains device-local. Legacy manifest v2 remains compatible; identity projection v3 includes portable workspace/project/source declarations and excludes checkouts.

The IDE invokes the companion engine rather than maintaining a second sync writer on the same device. Its trusted workspace roots continue to constrain filesystem operations and cross-project context. Multiple devices use separate registered sessions and checkout mappings.

### Supabase and cloud API

- `team_workspaces`: workspace UUID and account scope.
- `team_workspace_projects`: project membership and legacy primary binding adapter.
- `team_workspace_repositories`: provider repository metadata scoped to the workspace.
- `team_source_bindings`: stable source identity, project owner, kind, relative repository directory/endpoint, version.
- Existing task, graph and receipt tables retain their identities. Source-aware revisions and graph provenance must be introduced compatibly before multi-source analysis can be accepted.

Cloud tables do not store device checkout paths. Source mutations use a broker that rechecks AIPI workspace/account roles inside a transaction. Repository bindings additionally require current linked GitHub user and connected App installation access. RLS limits portable metadata reads to authorized workspace members. Source changes wake workspace sync.

The companion reads portable identity after authenticated sync. It can import missing source metadata without adding local paths. It attaches a primary repository locally only after matching an authorized checkout, and reports identity/path conflicts. Removed or changed bindings require review; they never erase local configuration automatically.

## 4. Routes

| Surface | Route | Behavior |
|---|---|---|
| Cloud | `/workspace` | Sign in, list accessible workspaces, create/import |
| Cloud | `/workspace/<workspace UUID>` | Existing workspace dashboard |
| Cloud | `/workspace/<workspace UUID>/manage/general` | Setup, source identities, repository mappings |
| Deprecated cloud | `/workspace/<workspace UUID>/manage/{environments,vault,policies,mesh}` | Redirect to General; no nonfunctional settings tabs are advertised |
| Cloud | `/workspace/connect` | Ticket-protected companion/IDE review and authorization |
| Local | `/workspaces/<wsg alias>` | Workspace view containing projects |
| Local | `/workspace/<prj key>` and `/projects/<prj key>` | Compatible project views; project keys retain project meaning |
| Legacy cloud | `/workspace/prj_…`, `/dashboard/prj_…` | Resolve only through accessible membership; prompt if ambiguous |
| Legacy website | `/dashboard/`, `/team` | Redirect to the cloud workspace launcher |

A project URL is not a cloud workspace identity. Do not rename an internal project record into a workspace merely by changing the URL prefix.

## 5. Corrected user journeys

### Create and connect

1. User signs in and sees only accessible workspaces.
2. Create offers an empty workspace, import from the running companion/IDE, or repository-backed setup. GitHub is optional for empty/local/external resources.
3. Local import is explicit: open the selected device's companion picker, choose the project/workspace, and review the metadata to share. Do not silently enumerate projects or scan loopback ports.
4. A new workspace opens setup. An existing workspace opens its dashboard; settings are always reachable.
5. User creates/selects a logical project and adds sources. For a repository, connect the GitHub identity/App, select an allowed repository and directory, then save the source binding.
6. Additional repositories can be new source bindings of the selected project, or sources of a new logical project. These are separate user choices.
7. User attaches a local checkout on each device through an authorized folder and repository/path validation. A cloud-created source can remain without a local checkout.

### Daily development and cloud access

Home, Explore, Tasks, K-Maps and Tools retain consistent concepts and navigation across providers. Shared components do not imply identical execution capability: filesystem operations need a companion; checks need an authorized local/CI runner; offline cloud source access needs an authorized GitHub read or shared snapshot. Unavailable capabilities must be visible and actionable.

On the same device the IDE and browser use the companion's writer/sync engine. Across devices use independent authenticated clients, idempotent operations, versions, durable retry and conflict review. A local-only project key cannot make unsynchronized source appear in the cloud.

### Change impact and proof

1. Pin each changed source binding to a revision.
2. Index contracts, callers, schemas and tests with source-binding provenance.
3. Traverse confirmed or appropriately qualified relationships across other accessible project sources.
4. Identify relevant checks and run them only on an authorized runner.
5. Record receipts against exact source revisions, requirements and evidence. Unknown/unreadable consumers remain coverage gaps.
6. A repository list, changed-file match or dependency candidate never establishes successful verification.

### Access and invitations

AIPI membership and GitHub permissions are distinct. Workspace membership does not automatically grant repository source access. Reads require applicable AIPI access and current repository read permission; code mutations additionally require repository write permission. App installation access is not a substitute for the user's rights.

An owner can discover eligible collaborators, select recipients and send explicit invitations. Do not infer email addresses from GitHub usernames or automatically invite every collaborator. A user joining AIPI still needs appropriate repository access.

## 6. Corrections to the original ten points

| Original points | Correction |
|---|---|
| 1, 6, 10 | Workspace, logical project, typed source binding, repository and checkout are separate entities. |
| 2 | Reuse UI concepts/components; gate capabilities by provider and permissions. |
| 3, 7 | Workspaces have their own UUIDs; `prj_` keys remain project identities and legacy aliases only. |
| 4 | Cloud creation must also work without a running companion. Local import is one explicit path. |
| 5 | GitHub setup is optional and source-specific. |
| 6 | Adding repositories is necessary input, not sufficient implementation of blast-radius analysis. |
| 7 | Setup for new/incomplete workspaces; dashboard for existing ones. |
| 8 | One companion writer per device; versioned independent clients across devices. |
| 9 | Separate AIPI membership, repository permission and consent to invite selected recipients. |
| 10 | Only repository-backed sources require Git; branches are tracking metadata, commits are revision identities. |

## 7. Implementation and acceptance status

Implemented identity foundation: additive local source/checkout identities and backup, portable v3 identity projection, local source/checkout APIs, canonical local workspace UUIDs with legacy aliases, requested UUID on cloud creation, cloud repository/source tables with primary backfill, role-checked source broker and GitHub-checked source API, source-selective cloud file reads, metadata reconciliation, and source registry views in the companion/IDE and cloud settings, and a shared Supabase browser client for the launcher, workspace routes, settings, dashboard and GitHub callback.

Compatibility guard: legacy project-only graph operations reject ambiguous multi-source projects rather than authorizing or assessing the wrong source. This is an explicit limitation, not completed multi-source impact support.

Remaining functional acceptance work:

- Complete release testing of the guided source setup across fresh signup, installed IDE clients and a running companion. Repository creation, source binding, branch/directory selection, duplicate handling and draft retry are implemented.
- Source-aware graph/contract publication, revisions, tombstones and receipt synchronization. The existing project-only graph format must be upgraded before the ambiguity guard can be removed.
- Monorepo fan-out and cross-repository assessments using those source-aware graphs.
- Capability-complete provider settings and verified local/cloud dashboard journeys.
- Collaborator discovery, recipient selection and invitation delivery.
- Two-device release acceptance, including offline edits, changed mappings, revoked rights, and replay of lost acknowledgments.

Mandatory scenario: create a workspace, add two logical projects, attach two repositories and a monorepo subfolder, add a local-only folder and external endpoint, attach checkouts on two devices at different paths, synchronize tasks and revision-pinned knowledge, assess a cross-source API change, run selected checks, record proof, revoke access and invite a selected teammate. Assert that IDs and ownership remain stable and no device paths or secrets reach portable/cloud data.

The architecture is defined by this contract. Overall product acceptance remains open until the functional scenarios pass; never report identity migrations or route checks as full user-experience completion.

## 8. Completion milestones and release gates

| Order | Deliverable | Acceptance gate | Current status |
|---|---|---|---|
| I1 | Stable workspace, project, source and checkout identities | Additive backup; repeated migration changes nothing; legacy writes preserve checkout IDs; repository/directory reassignment conflicts | Implemented and tested |
| I2 | Cloud identity registry and authenticated adapters | Same primary source ID locally and in SQL; RLS membership; GitHub checks on repository attachment; portable output excludes checkouts | Implemented; existing live primary binding verified |
| I3 | Guided setup and source declaration sync | Import every selected source without secrets; preserve operation IDs across signup, refresh and lost acknowledgments; attach device checkouts explicitly; surface deletions/conflicts | Source creation/retry, local picker, GitHub creation, branches, directory validation and alias reconciliation implemented. General rename/delete conflict workflows remain open |
| I4 | Source-aware knowledge and verification | Every indexed node, relation, revision and receipt resolves to its owning project/source; two repos in one project retain distinct pins; old records remain explicitly primary/unknown | Open; ambiguity guards are active |
| I5 | Daily-use capability parity | Five tabs work with actual authorized provider data; GitHub diff source paths resolve correctly for monorepos; missing runner/source is actionable | Partial; full end-to-end acceptance remains open |
| I6 | Team access and release acceptance | Selected collaborator invites; AIPI/GitHub permission intersection; revoked access; two-device offline/retry scenario; installed release artifacts verified | Partial; full scenario remains open |

Boundary naming: portable v3 project `id`, local `projectId`, and legacy cloud `projectKey` contain the same stable `prj_…` value. They never contain a workspace UUID. New graph/revision adapters must make this translation explicitly and preserve `sourceBindingId`; they must not infer sources from a project name or absolute path.

For I4, add source provenance to nodes and edges before enabling multi-source impact. Expand task/evidence/receipt revision validation and transactional source-ownership checks, then update the companion publisher, cloud broker, MCP/agent context and UI together. Backfill only records with an unambiguous primary origin; retain unknown provenance elsewhere. Do not stamp a primary source ID onto all historical multi-folder results.

For I3, do not publish Git-backed declarations using device tokens alone: bind them through a verified current GitHub user/App authorization. Treat a local remote as a candidate until confirmed. Keep source metadata mutations versioned and separate from Git commits, source upload and verification execution.

Release evidence must distinguish deployed cloud code from installed local clients. Building a companion tarball or VSIX does not update npm `@latest`, an installed extension, or a running companion. Reconnect using the updated client before claiming cross-surface release acceptance.


## 9. Source setup correction and verification — 23 October 2026

The old view rendered both a legacy project summary and the v3 source registry. Repeated “add another source” submissions could also create separate IDs for an identical project/repository/directory. The correction removes the repeated summary and enforces one active binding per `(workspace, project, repository ID, repository directory)`. Historical duplicate IDs remain stored as aliases; they are not deleted. Companion reconciliation redirects their checkout references without changing checkout IDs or paths.

The functional setup flow is now:

1. Open workspace General settings. Each logical project has one card, with its connected sources beneath it. Raw IDs are under Identity details.
2. Choose **Add project → From local companion or IDE**. Enter the running loopback URL, select **Use this project** on that device, review the destination workspace, and approve the existing secure OAuth flow. The destination is carried through the local picker. Only selected project metadata is exposed; other local projects are not enumerated by cloud JavaScript.
3. Choose **Add project → From GitHub** to create a logical project from an installed repository. Choose a tracking branch and a repository-relative directory. GitHub authorization and directory existence are checked before saving. Persisted draft IDs make retries safe.
4. For a local source, choose **Connect to GitHub**. This preserves its project/source identity. Repository rights are checked through the current GitHub user and connected installation.
5. For an existing logical project, choose **Add repository**. This creates an additional source, rather than replacing the primary repository or creating a new logical project accidentally. Re-selecting the same repository and directory acknowledges the existing binding.
6. **Change tracking branch** changes tracking metadata, never repository identity or directory. The selected GitHub commit is recorded. This is a last verified pin, not a claim that the local checkout is current.
7. **Check local checkout** requires a fresh project-scoped companion ticket. It matches the actual authorized checkout, queries the remote branch using `git ls-remote`, and compares it with local HEAD. It reports current/ahead/behind/diverged/unknown and dirty state. Missing local commit objects yield “fetch to compare”; cached refs never establish latest-remote freshness. The operation does not fetch, pull, push, commit, reset, or change working files.
8. After authenticated sync, newly added local/endpoint source declarations are retried from persisted local state using stable source IDs. New Git-backed declarations remain local placeholders in cloud until a user confirms GitHub access. Cloud metadata can be imported on another device without inventing a checkout path. Repository source rights are never asserted using a device token alone.
9. GitHub authorization returns to the originating workspace settings. Installation returns preserve that destination as an untrusted navigation hint; the server still verifies installation and repository access.
10. Cloud General settings contains real project/source, member and source-sharing controls. Nonfunctional environment, vault and mesh pages are removed from navigation and their old routes redirect to General.

Verified evidence for this correction:

- Isolated PostgreSQL migration and broker tests cover duplicate backfill and aliases, local-primary-to-GitHub binding, another monorepo source, exact retries, unchanged source identity across branch tracking, immutable directories, cross-project ownership, viewer denial and RLS.
- Two simulated independent device stores cover lost acknowledgments, newly added source declarations, unchanged tasks, distinct checkout paths, metadata-only import and revoked writes.
- Git fixtures cover current, ahead, behind, diverged, unknown and dirty states, and assert HEAD/working files remain unchanged.
- Live signed-in cloud checks saved `main` tracking on the existing AIPI source and repeated the same repository attachment. One source remained; the UI acknowledged that the existing source was kept.

These checks close the reported duplicate/form/settings defects and the source-setup paths. They do not establish source-aware graph/receipt synchronization or an installed two-device product release. Those remain explicit I4/I6 gates; do not describe the entire product as accepted on the basis of source-setup checks.
