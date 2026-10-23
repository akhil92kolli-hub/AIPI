// Shared browser/IDE explorer. All target identities and relationships come from the companion.
export function compactTargetLocation(value, endpoint = false) {
  let full = String(value ?? "").replaceAll("\\", "/");
  if (endpoint) {
    full = full.split(/[?#]/)[0];
    try { const url = new URL(full); full = url.origin + url.pathname; } catch {}
  }
  let location = full;
  if (endpoint) {
    try { location = new URL(full).pathname; } catch { location = full.replace(/^\{\{[^}]+\}\}/, ""); }
  }
  const segments = location.split("/").filter(Boolean);
  const short = segments.length > 2 ? `…/${segments.slice(-2).join("/")}` : location || "/";
  return { full, short };
}

export function targetLocationMarkup(value, esc, endpoint = false) {
  const { full, short } = compactTargetLocation(value, endpoint);
  if (!full) return '<small>Location not indexed</small>';
  return `<code class="target-location" title="${esc(full)}" aria-label="${esc(full)}">${esc(short)}</code>${short !== full ? `<details class="target-full-location"><summary>Full ${endpoint ? "endpoint" : "path"}</summary><code>${esc(full)}</code></details>` : ""}`;
}

// Import carries repository declarations only. Local project IDs, membership,
// versions and checkout paths always come from the selected local workspace.
export function resolveImportedWorkspaceManifest(local, imported, choices) {
  if (local?.schemaVersion !== 2 || imported?.schemaVersion !== 2 || !Array.isArray(local.resources) || !Array.isArray(imported.resources)) throw new Error("Unsupported workspace manifest");
  const source = new Map();
  for (const resource of imported.resources) {
    if (!resource || typeof resource.projectId !== "string" || source.has(resource.projectId)) throw new Error("Imported manifest has duplicate or missing project IDs");
    source.set(resource.projectId, resource);
  }
  const used = new Set();
  return { ...local, resources: local.resources.map((resource) => {
    const sourceId = choices[resource.projectId];
    if (!sourceId) return resource;
    if (!source.has(sourceId) || used.has(sourceId)) throw new Error("Choose each imported project at most once");
    used.add(sourceId);
    const binding = source.get(sourceId).repository;
    return { ...resource, repository: binding ? { provider: binding.provider, providerRepositoryId: binding.providerRepositoryId, remote: binding.remote, root: binding.root ?? "." } : null };
  }) };
}

function targetOwnership(target, state) {
  const owner = state.projects?.find(p => p.id === target.ref.projectId);
  const env = owner?.environments?.find(e => e.id === owner.activeEnvironmentId);
  const service = env?.services?.find(s => (s.id ?? s.variableKey) === target.ref.serviceId);
  const repository = target.root?.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  return [target.projectName ?? owner?.name, service ? `Service: ${service.name ?? service.variableKey}` : repository ? `Repository: ${repository}` : ["api", "request", "service"].includes(target.kind) ? "API service / project" : "Repository not linked", target.kind].filter(Boolean).join(" · ");
}

// Task creation and editing share this picker; it mutates only the supplied local draft.
export function createTaskTargetPicker({ api, esc, getState, getProjectId, getDraft, onChange }) {
  let draftId, groupId = "", query = "", kind = "all", items = [], selected = new Map(), related = [], coverage = [], error = "", loading = false, nextOffset = null, generation = 0;
  const groups = () => (getState().workspaceGroups ?? []).filter(g => g.projectIds.includes(getProjectId()));
  const host = () => document.querySelector("[data-task-target-picker]");
  const publish = () => {
    const draft = getDraft();
    const signature = () => JSON.stringify([draft.contractIds, draft.requestIds, draft.artifactIds, (draft.selectedTargets ?? []).map(t=>t.key)].map(ids => [...(ids ?? [])].sort()));
    const previous = signature();
    draft.selectedTargets = [...selected.values()];
    draft.workspaceGroupId = groupId;
    draft.contractIds = draft.selectedTargets.filter(t => t.ref.projectId === getProjectId() && t.kind === "api").map(t => t.ref.entityId);
    draft.requestIds = draft.selectedTargets.filter(t => t.ref.projectId === getProjectId() && t.kind === "request").map(t => t.ref.entityId);
    draft.artifactIds = draft.selectedTargets.filter(t => t.ref.projectId === getProjectId() && !["api", "request"].includes(t.kind)).map(t => t.ref.entityId);
    if (signature() !== previous) onChange?.();
  };
  function markup() {
    const row = (t, chosen = false) => `<article class="workspace-target-row"><div><strong>${esc(t.label)}</strong><small>${esc(targetOwnership(t, getState()))}</small>${targetLocationMarkup(t.source || t.route, esc, !t.source)}${t.reason ? `<small>${esc(t.reason)}</small>` : ""}</div><button type="button" class="secondary-button" data-task-target-toggle="${esc(t.key)}" aria-pressed="${selected.has(t.key)}" ${!chosen && t.kind === "service" ? 'disabled title="Select an API or source target"' : ""}>${selected.has(t.key) ? "Remove" : "Add"}</button></article>`;
    return `<div class="workspace-explorer-toolbar"><label class="field-label">Workspace<select class="field" data-task-target-group>${groups().map(g => `<option value="${esc(g.id)}" ${groupId === g.id ? "selected" : ""}>${esc(g.name)} · ${g.projectIds.length} project(s)</option>`).join("")}</select></label><label class="field-label">Find a page, component, API, or contract<input class="field" data-task-target-query maxlength="500" value="${esc(query)}" placeholder="Search names, routes, or files…"></label><button type="button" class="secondary-button" data-task-target-search>Search</button></div>
    <div class="workspace-explorer-filters">${[["all","All"],["ui","Pages & Components"],["apis","APIs & Contracts"],["files","Files & Schemas"],["tests","Tests"]].map(([id,label]) => `<button type="button" class="${kind === id ? "primary-button" : "secondary-button"}" data-task-target-kind="${id}" aria-pressed="${kind === id}">${label}</button>`).join("")}</div>
    <p class="supporting-copy">Workspace → repositories &amp; services → targets. Browse connected projects. Select context across connected projects. Each target keeps its repository ownership through handoff and checks.</p>
    ${coverage.filter(c => !c.indexedAt || c.scanStatus !== "complete").map(c => `<p class="workspace-coverage-note">${esc(c.name)}: ${esc(c.scanStatus || "not indexed")}. Saved APIs may still be available.</p>`).join("")}
    <p role="status">${loading ? "Searching workspace…" : `${items.length} results shown`}</p>${error ? `<p role="alert">${esc(error)} Your selection is preserved. <button type="button" data-task-target-search>Retry</button></p>` : ""}
    <div class="task-target-results">${items.map(t => row(t)).join("") || (!loading ? '<p>No indexed match. Try another name or refresh the source index in Tools.</p>' : "")}</div>${nextOffset !== null ? '<button type="button" class="secondary-button" data-task-target-more>Load more</button>' : ""}
    <section class="task-context-review"><h3>Selected context · ${selected.size}</h3><p class="supporting-copy">Only these targets are bound. You can change them here after task creation too.</p>${[...selected.values()].map(t => row(t, true)).join("") || "<p>No targets selected. You can continue with your objective and acceptance criteria.</p>"}
    ${related.length ? `<details><summary>Suggested related context · ${related.length}</summary><p>Indexed relationships, not automatically included.</p>${related.map(t => row(t)).join("")}</details>` : '<p class="supporting-copy">No additional indexed relationships found. This does not mean the implementation is missing.</p>'}</section>`;
  }
  function paint() { if (host()) host().innerHTML = markup(); }
  async function load(append = false) {
    const ticket = ++generation;
    loading = true; error = ""; paint();
    try {
      const result = await api(`/api/workspaces/${encodeURIComponent(groupId)}/targets?${new URLSearchParams({ q: query, kind, offset: String(append ? nextOffset ?? 0 : 0) })}`);
      if (ticket !== generation) return;
      items = append ? [...items, ...result.items] : result.items; coverage = result.coverage; nextOffset = result.nextOffset;
      const details = await Promise.allSettled([...selected.keys()].map(key => api(`/api/workspaces/${encodeURIComponent(groupId)}/target?${new URLSearchParams({ key })}`)));
      if (ticket !== generation) return;
      related = [...new Map(details.filter(r => r.status === "fulfilled").flatMap(r => r.value.related).filter(t => !selected.has(t.key) && t.kind !== "service" ).map(t => [t.key,t])).values()];
    } catch (e) { if (ticket === generation) error = e.message; }
    if (ticket === generation) { loading = false; paint(); }
  }
  async function mount() {
    const draft = getDraft();
    if (draftId !== draft.id) {
      generation++; draftId = draft.id; groupId = groups().find(g => g.id === draft.workspaceGroupId)?.id ?? groups()[0]?.id ?? "";
      query = ""; kind = "all"; items = []; related = []; selected = new Map((draft.selectedTargets ?? []).map(t => [t.key,t]));
      // Legacy tasks retain every selected ID, including unavailable references.
      if (!draft.selectedTargets) {
        const ticket = ++generation;
        try {
          let offset = 0, all = [];
          do {
            const result = await api(`/api/workspaces/${encodeURIComponent(groupId)}/targets?offset=${offset}&limit=100`);
            if (ticket !== generation) return;
            all.push(...result.items); offset = result.nextOffset;
          } while (offset !== null);
          const ids = { api: draft.contractIds ?? [], request: draft.requestIds ?? [] };
          for (const t of all) if ((draft.targetRefs ?? []).some(ref=>JSON.stringify(ref)===JSON.stringify(t.ref)) || (t.ref.projectId === getProjectId() && (ids[t.kind] ?? draft.artifactIds ?? []).includes(t.ref.entityId))) selected.set(t.key,t);
          for (const ref of draft.targetRefs ?? []) if (![...selected.values()].some(t=>JSON.stringify(t.ref)===JSON.stringify(ref))) {
            const key=`missing:qualified:${JSON.stringify(ref)}`;
            selected.set(key,{key,kind:ref.kind,label:ref.entityId,ref,reason:'Unavailable workspace target — reconnect it or remove it before verification'});
          }
          for (const [type, values] of [["api", draft.contractIds], ["request", draft.requestIds], ["artifact", draft.artifactIds]]) for (const id of values ?? []) {
            if (![...selected.values()].some(t => t.ref.entityId === id)) selected.set(`missing:${type}:${id}`, { key: `missing:${type}:${id}`, kind: type, label: id, reason: "Unavailable in current index — retained until you remove it", ref: { projectId: getProjectId(), entityId: id } });
          }
          if (!host() || getDraft() !== draft) return;
          publish();
        } catch (e) { error = e.message; paint(); return; }
      }
    }
    paint(); if (groupId) await load();
  }
  async function click(event) {
    const button = event.target.closest("[data-task-target-toggle],[data-task-target-search],[data-task-target-kind],[data-task-target-more]");
    if (!button) return false;
    if (button.dataset.taskTargetToggle) {
      const key = button.dataset.taskTargetToggle;
      if (selected.has(key)) selected.delete(key);
      else { const t = [...items,...related].find(t => t.key === key); if (!t || t.kind === "service") return true; if (selected.size >= 50) { error = "Select at most 50 targets."; paint(); return true; } selected.set(key,t); }
      publish(); paint(); await load();
    } else { if (button.dataset.taskTargetKind) kind = button.dataset.taskTargetKind; await load(button.hasAttribute("data-task-target-more")); }
    return true;
  }
  function input(event) { if (event.target.matches("[data-task-target-query]")) query = event.target.value; }
  async function change(event) { if (event.target.matches("[data-task-target-group]")) { groupId = event.target.value; getDraft().workspaceGroupId = groupId; await load(); } }
  return { mount, click, input, change, reset: () => { draftId = null; generation++; } };
}

export async function scanWorkspaceProjects({ projects, scanProject, canScan = () => true, shouldStop = () => false, onProgress = () => {} }) {
  const results = [];
  for (const project of projects) {
    if (shouldStop()) break;
    const roots = project.sourceContext?.roots ?? [];
    const result = { projectId: project.id, name: project.name, status: "running" };
    results.push(result);
    onProgress(results);
    if (!canScan(project.id)) Object.assign(result, { status: "skipped", message: "Open this project's IDE workspace to scan it." });
    else if (!roots.length) Object.assign(result, { status: "skipped", message: "Connect a source folder in project settings." });
    else {
      try {
        const scan = await scanProject(project.id, roots);
        Object.assign(result, { status: "complete", message: `${scan.filesScanned ?? 0} files scanned · ${scan.endpoints?.length ?? 0} APIs · ${scan.frontendCalls?.length ?? 0} callers` });
      } catch (error) { Object.assign(result, { status: "failed", message: error.message }); }
    }
    onProgress(results);
  }
  return results;
}

export function createWorkspaceExplorer({ api, esc, getState, getProjectId, render, toast, openModal, onTask, onTest, canOpenProject, refreshState }) {
  const views = new Map();
  let sequence = 0;
  let scanOperation = null;
  const view = () => {
    const projectId = getProjectId();
    if (!views.has(projectId)) {
      let saved = {};
      try { saved = JSON.parse(sessionStorage.getItem(`aipi:explore:${projectId}`) || "{}"); } catch {}
      views.set(projectId, { groupId: saved.groupId ?? "", query: saved.query ?? "", kind: saved.kind ?? "all", selected: new Map(), restoreKeys: Array.isArray(saved.selectedKeys) ? saved.selectedKeys.slice(0, 50) : [], items: [], status: "idle", error: "", detail: null, nextOffset: null, total: 0 });
    }
    const current = views.get(projectId);
    const groups = (getState().workspaceGroups ?? []).filter((group) => group.projectIds.includes(projectId));
    if (!groups.some((group) => group.id === current.groupId)) current.groupId = groups[0]?.id ?? "";
    return current;
  };
  const remember = (current) => {
    try { sessionStorage.setItem(`aipi:explore:${getProjectId()}`, JSON.stringify({ groupId: current.groupId, query: current.query, kind: current.kind, selectedKeys: current.restoreKeys.length ? current.restoreKeys : [...current.selected.keys()] })); } catch {}
  };
  const endpoint = (current, suffix) => `/api/workspaces/${encodeURIComponent(current.groupId)}/${suffix}`;
  const description = (target) => `${targetOwnership(target, getState())}${target.method ? ` · ${target.method}` : ""}`;

  async function scan() {
    if (scanOperation?.running) return;
    const current = view();
    const group = getState().workspaceGroups?.find(g => g.id === current.groupId);
    const projects = (getState().projects ?? []).filter(p => group?.projectIds.includes(p.id) && (!current.scanProjectId || current.scanProjectId === p.id));
    if (!projects.length) return;
    const operation = { running: true, stop: false, total: projects.length, results: [], groupId: current.groupId };
    scanOperation = operation;
    render();
    try {
      await scanWorkspaceProjects({ projects, canScan: canOpenProject, shouldStop: () => operation.stop,
        scanProject: (projectId, roots) => api('/api/scan', { method: 'POST', body: JSON.stringify({ projectId, roots }) }),
        onProgress: results => { operation.results = [...results]; render(); }
      });
      await refreshState();
      // Re-resolve selected identities after indexing; removed targets must not
      // silently survive as current source evidence.
      if (current.groupId === operation.groupId) {
        current.restoreKeys = [...current.selected.keys()];
        current.selected.clear();
      }
      if (view() === current) await load();
    } catch (error) { operation.error = error.message; }
    finally { operation.running = false; render(); }
  }

  async function load(append = false) {
    const current = view(), projectId = getProjectId(), generation = ++sequence;
    current.requestGeneration = generation;
    if (!current.groupId) return;
    current.status = "loading"; current.error = ""; remember(current); render();
    try {
      const params = new URLSearchParams({ q: current.query, kind: current.kind, offset: String(append ? current.nextOffset ?? 0 : 0) });
      const result = await api(`${endpoint(current, "targets")}?${params}`);
      if (current.requestGeneration !== generation) return;
      current.items = append ? [...current.items, ...result.items] : result.items;
      current.total = result.total; current.nextOffset = result.nextOffset; current.coverage = result.coverage;
      current.status = "ready";
      if (current.restoreKeys.length) {
        const restored = await Promise.allSettled(current.restoreKeys.map((key) => api(`${endpoint(current, "target")}?${new URLSearchParams({ key })}`)));
        if (current.requestGeneration !== generation) return;
        for (const result of restored) if (result.status === "fulfilled") current.selected.set(result.value.target.key, result.value.target);
        current.restoreKeys = [];
        if (restored.some((result) => result.status === "rejected")) current.error = "Some previously selected targets are unavailable. Review the remaining selection.";
      }
    } catch (error) {
      if (current.requestGeneration !== generation) return;
      current.status = "error"; current.error = error.message;
    }
    if (projectId === getProjectId()) { remember(current); render(); }
  }

  function markup() {
    const current = view();
    const groups = (getState().workspaceGroups ?? []).filter((group) => group.projectIds.includes(getProjectId()));
    const group = groups.find((entry) => entry.id === current.groupId);
    const selected = [...current.selected.values()];
    const owners = new Set(selected.map((target) => target.ref.projectId));
    const taskReady = selected.length > 0 && canOpenProject(getProjectId());
    const taskReason = selected.length && !taskReady ? "Open the task owner project in your IDE workspace." : "Select targets across repositories, then describe the change.";
    const row = (target, reason = target.reason) => `<article class="workspace-target-row"><div class="workspace-target-open"><strong>${esc(target.label || target.source || target.kind)}</strong><small>${esc(description(target))}</small>${targetLocationMarkup(target.source || target.route, esc, !target.source)}${reason ? `<small>${esc(reason)}</small>` : ""}</div><div class="workspace-target-actions">${["request", "api"].includes(target.kind) ? `<button type="button" class="primary-button" data-explorer-test="${esc(target.key)}" ${canOpenProject(target.ref.projectId) ? "" : "disabled"}>Test API</button>` : ""}<button type="button" class="secondary-button" data-explorer-select="${esc(target.key)}" ${target.kind === "service" ? 'disabled title="Select an API from this service"' : ""} aria-pressed="${current.selected.has(target.key)}" aria-label="${esc(`${current.selected.has(target.key) ? "Remove" : "Select"} ${target.label} in ${target.projectName}`)}">${current.selected.has(target.key) ? "Selected ✓" : "Select"}</button></div></article>`;
    return `<section class="workspace-explorer">
      <header class="page-heading"><div><p class="eyebrow">Product workspace</p><h1>Explore your application</h1><p>Workspace → repositories &amp; services → pages, components &amp; APIs. Browse a target to test it directly or select it for a task.</p></div><div class="action-row"><button class="primary-button" data-route="api-client">Open API Client</button><button class="secondary-button" data-explorer-export ${group ? "" : "disabled"}>Export manifest</button><label class="secondary-button explorer-import-button">Import manifest<input type="file" data-explorer-manifest-import accept="application/json,.json" hidden></label><button class="secondary-button" data-explorer-manage>Connect repositories &amp; services</button></div></header>
      <div class="workspace-explorer-toolbar"><label class="field-label">Workspace<select class="field" data-explorer-group>${groups.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === current.groupId ? "selected" : ""}>${esc(entry.name)} · ${entry.projectIds.length} project${entry.projectIds.length === 1 ? "" : "s"}</option>`).join("")}</select></label><label class="field-label">Find a page, component, API, or test<input class="field" data-explorer-query value="${esc(current.query)}" maxlength="500" placeholder="checkout, /orders, CheckoutForm…"></label><button class="primary-button" data-explorer-search ${current.status === "loading" ? "disabled" : ""}>${current.status === "loading" ? "Searching…" : "Search"}</button></div>
      <section class="workspace-scan" aria-label="Workspace source scanning"><div class="action-row"><label class="field-label">Scan scope<select class="field" data-explorer-scan-project ${scanOperation?.running ? "disabled" : ""}><option value="">All projects in this workspace</option>${(group?.projectIds ?? []).map(id => getState().projects.find(p => p.id === id)).filter(Boolean).map(p => `<option value="${esc(p.id)}" ${current.scanProjectId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label><button class="secondary-button" data-explorer-scan ${scanOperation?.running || !group ? "disabled" : ""}>${scanOperation?.running ? "Scanning…" : current.scanProjectId ? "Scan project" : "Scan workspace"}</button>${scanOperation?.running ? `<button class="quiet-button" data-explorer-scan-stop ${scanOperation.stop ? "disabled" : ""}>${scanOperation.stop ? "Stopping after current project…" : "Stop after current project"}</button>` : ""}</div><p class="supporting-copy">Refresh connected source folders to find pages, components, APIs, schemas and tests. Unchanged files reuse the previous index; detected relationships may need review.</p>${scanOperation?.groupId === current.groupId ? `<div role="status" aria-live="polite"><p>${scanOperation.results.filter(r => r.status !== "running").length} of ${scanOperation.total} projects processed${scanOperation.stop ? " · Stopped after current project" : ""}</p>${scanOperation.results.map(r => `<p><strong>${esc(r.name)}</strong> · ${esc(r.status)}${r.message ? ` — ${esc(r.message)}` : ""}</p>`).join("")}${scanOperation.error ? `<p role="alert">${esc(scanOperation.error)}</p>` : ""}</div>` : ""}</section>
      <div class="workspace-explorer-filters" aria-label="Target type">${[["all", "All"], ["ui", "Pages & Components"], ["apis", "APIs"], ["files", "Files & Schemas"], ["services", "Services"], ["tests", "Tests"]].map(([kind, label]) => `<button class="${current.kind === kind ? "primary-button" : "secondary-button"}" data-explorer-kind="${kind}" aria-pressed="${current.kind === kind}">${label}</button>`).join("")}</div>
      <p class="supporting-copy">${esc(group?.name ?? "Connect a project to begin")} · ${(group?.projectIds ?? []).map((id) => esc(getState().projects.find((p) => p.id === id)?.name ?? `${id} (unavailable)`)).join(" · ")}</p>
      ${(current.coverage ?? []).some((entry) => !entry.indexedAt || !entry.available || entry.scanStatus !== "complete") ? `<p class="workspace-coverage-note">Some sources are not fully indexed. Saved API requests are still available. ${current.coverage.filter((entry) => !entry.indexedAt || !entry.available || entry.scanStatus !== "complete").map((entry) => `${esc(entry.name)}: ${esc(entry.available ? entry.scanStatus : "unavailable")}`).join(" · ")}</p>` : ""}
      <div class="workspace-explorer-layout"><section aria-label="Matching targets"><p role="status">${current.status === "idle" ? "Search or browse the connected indexes." : current.status === "loading" ? "Searching workspace…" : `${current.total} matching targets`}</p>${current.error ? `<p role="alert">${esc(current.error)}</p><button class="secondary-button" data-explorer-search>Retry search</button>` : ""}<div class="workspace-target-list">${current.items.map((target) => row(target)).join("") || (current.status === "ready" ? '<p class="empty-message">No indexed match. Try a route, filename, or component name; check source indexing in project settings.</p>' : "")}</div>${current.nextOffset !== null ? '<button class="secondary-button" data-explorer-more>Load more</button>' : ""}</section>
      </div>${selected.length ? `<section class="workspace-selection-bar" aria-label="Selected targets"><div><strong role="status">${selected.length} target${selected.length === 1 ? "" : "s"} selected</strong><small>${taskReady ? "Review context and describe the change in the next step." : esc(taskReason)}</small></div>${selected.length === 2 ? '<button class="secondary-button" data-explorer-review>Review relationship</button>' : ""}<button class="primary-button" data-explorer-task ${taskReady ? "" : "disabled"}>Create task from selection</button></section>` : ""}</section>`;
  }

  async function manage() {
    const current = view();
    const existing = getState().workspaceGroups?.find((group) => group.id === current.groupId);
    if (!existing) { toast("Create a workspace before binding repositories."); return; }
    let manifest;
    try { ({ manifest } = await api(`/api/workspaces/${encodeURIComponent(existing.id)}/manifest`)); }
    catch (error) { toast(error.message); return; }
    const id = existing?.id ?? `wsg_${crypto.randomUUID()}`;
    const bindingFields = manifest.resources.map((resource) => {
      const binding = resource.repository ?? {};
      return `<fieldset class="workspace-binding" data-manifest-project="${esc(resource.projectId)}"><legend>${esc(resource.name)}</legend><p class="supporting-copy">Repository identity is portable. Local checkout paths and credentials stay on this device.</p><label class="field-label">GitHub repository ID<input class="field" data-binding-id value="${esc(binding.providerRepositoryId ?? "")}" inputmode="numeric" placeholder="123456789"></label><label class="field-label">Repository URL<input class="field" data-binding-remote value="${esc(binding.remote ?? "")}" placeholder="https://github.com/company/repository"></label><label class="field-label">Project path in repository<input class="field" data-binding-root value="${esc(binding.root ?? ".")}" placeholder=". or services/orders"></label></fieldset>`;
    }).join("");
    openModal("Connect projects to a workspace", `<p>Group frontend, backend, and API projects without merging their data. Repository bindings let teammates resolve the same project in their own checkout.</p><label class="field-label">Workspace name<input class="field" id="explorerWorkspaceName" value="${esc(existing?.name ?? "My application")}" maxlength="80"></label><div class="workspace-member-list">${getState().projects.map((project) => `<label class="task-check"><input type="checkbox" data-explorer-member value="${esc(project.id)}" ${existing?.projectIds.includes(project.id) || project.id === getProjectId() ? "checked" : ""} ${project.id === getProjectId() ? "disabled" : ""}><span>${esc(project.name)}<small>${esc(project.sourceContext?.roots?.[0]?.path ?? "API project · no source connected")}</small></span></label>`).join("")}</div><section class="workspace-bindings"><h3>Repository bindings</h3>${bindingFields}</section>`, "Save workspace", async () => {
      const projectIds = [...document.querySelectorAll("[data-explorer-member]:checked")].map((input) => input.value);
      const { workspace } = await api(`/api/workspaces/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name: document.getElementById("explorerWorkspaceName").value, projectIds, expectedVersion: existing?.version }) });
      // Membership is saved first. Bindings only operate on the confirmed group,
      // so an unchecked project can never be changed through the manifest editor.
      const latest = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/manifest`);
      for (const resource of latest.manifest.resources) {
        const fields = document.querySelector(`[data-manifest-project="${CSS.escape(resource.projectId)}"]`);
        if (!fields) continue;
        const providerRepositoryId = fields.querySelector("[data-binding-id]").value.trim();
        const remote = fields.querySelector("[data-binding-remote]").value.trim();
        const root = fields.querySelector("[data-binding-root]").value.trim();
        resource.repository = providerRepositoryId || remote || root && root !== "."
          ? { provider: "github", providerRepositoryId, remote, root: root || "." }
          : null;
      }
      const savedManifest = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/manifest`, { method: "PUT", body: JSON.stringify(latest.manifest) });
      const state = getState(); state.workspaceGroups ??= [];
      const index = state.workspaceGroups.findIndex((group) => group.id === id);
      if (index < 0) state.workspaceGroups.push(workspace); else state.workspaceGroups[index] = workspace;
      await refreshState();
      current.groupId = workspace.id; current.selected.clear(); current.restoreKeys = []; current.detail = null;
      await load(); toast(`${savedManifest.manifest.resources.filter(resource => resource.repository).length} repository binding(s) saved; project records remain separate.`);
    });
  }

  async function click(event) {
    const button = event.target.closest("[data-explorer-review],[data-explorer-search],[data-explorer-more],[data-explorer-kind],[data-explorer-detail],[data-explorer-select],[data-explorer-remove],[data-explorer-task],[data-explorer-test],[data-explorer-manage],[data-explorer-export],[data-explorer-scan],[data-explorer-scan-stop]");
    if (!button) return false;
    const current = view();
    try {
      if (button.hasAttribute('data-explorer-review')) {
        const pair = [...current.selected.values()];
        if (pair.length !== 2) throw new Error('Select exactly two targets to review a relationship.');
        const {relationships} = await api(endpoint(current,'relationships'));
        openModal('Review relationship', `<p>From <strong>${esc(pair[0].projectName)} · ${esc(pair[0].label)}</strong> to <strong>${esc(pair[1].projectName)} · ${esc(pair[1].label)}</strong>. Selection order determines direction.</p><label>Relationship<select id="relationshipType" class="field"><option>CALLS</option><option>IMPLEMENTS</option><option>TESTS</option><option>USES_SCHEMA</option></select></label><label>Decision<select id="relationshipDecision" class="field"><option value="approved">Approve static relationship</option><option value="rejected">Reject relationship</option></select></label><label>Evidence and source references<textarea id="relationshipEvidence" class="field" maxlength="4000" required></textarea></label><label>Reviewed by<input id="relationshipReviewer" class="field" maxlength="120" required></label><p>Approval records your review, not runtime proof. Source changes require review again.</p>`, 'Save review', async () => {
          const type = document.getElementById('relationshipType').value;
          const previous = relationships.find(r => r.fromKey === pair[0].key && r.toKey === pair[1].key && r.type === type);
          await api(endpoint(current,'relationships'),{method:'POST',body:JSON.stringify({fromKey:pair[0].key,toKey:pair[1].key,type,status:document.getElementById('relationshipDecision').value,evidence:document.getElementById('relationshipEvidence').value,reviewer:document.getElementById('relationshipReviewer').value,expectedVersion:previous?.version ?? 0})});
          toast('Relationship review saved. Runtime verification remains separate.');
        });
      }
      else if (button.hasAttribute("data-explorer-scan")) await scan();
      else if (button.hasAttribute("data-explorer-scan-stop")) { if (scanOperation) scanOperation.stop = true; render(); }
      else if (button.hasAttribute("data-explorer-manage")) await manage();
      else if (button.hasAttribute("data-explorer-export")) {
        const { manifest } = await api(endpoint(current, "manifest"));
        const blob = new Blob([JSON.stringify(manifest, null, 2) + "\\n"], { type: "application/json" });
        const download = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = download; anchor.download = `${manifest.name.replace(/[^A-Za-z0-9_.-]+/g, "-") || "aipi-workspace"}.aipi-workspace.json`;
        anchor.click(); URL.revokeObjectURL(download);
        toast("Portable workspace manifest downloaded.");
      }
      else if (button.hasAttribute("data-explorer-search")) await load();
      else if (button.hasAttribute("data-explorer-more")) await load(true);
      else if (button.dataset.explorerKind) { current.kind = button.dataset.explorerKind; await load(); }
      else if (button.dataset.explorerRemove) { current.selected.delete(button.dataset.explorerRemove); remember(current); render(); }
      else if (button.dataset.explorerSelect) {
        const key = button.dataset.explorerSelect;
        const target = [...current.items, ...(current.detail?.related ?? []), ...(current.detail ? [current.detail.target] : [])].find((item) => item.key === key);
        if (!target) throw new Error("Refresh the target list before selecting.");
        if (target.kind === "service") throw new Error("Choose an API request from this service to use as task context.");
        if (!current.selected.has(key) && current.selected.size >= 50) throw new Error("Select at most 50 targets for one task.");
        if (current.selected.has(key)) current.selected.delete(key); else current.selected.set(key, target);
        remember(current); render();
      } else if (button.dataset.explorerDetail) {
        const generation = ++sequence, projectId = getProjectId(); button.disabled = true;
        const detail = await api(`${endpoint(current, "target")}?${new URLSearchParams({ key: button.dataset.explorerDetail })}`);
        if (generation === sequence && projectId === getProjectId()) { current.detail = detail; render(); }
      } else if (button.dataset.explorerTest) {
        const { target } = await api(`${endpoint(current, "target")}?${new URLSearchParams({ key: button.dataset.explorerTest })}`);
        if (view() === current) await onTest(target);
      } else if (button.hasAttribute("data-explorer-task")) {
        button.disabled = true;
        const details = await Promise.all([...current.selected.keys()].map((key) => api(`${endpoint(current, "target")}?${new URLSearchParams({ key })}`)));
        if (view() === current) { await onTask(details.map((detail) => detail.target), current.groupId, details); button.disabled = false; }
      }
    } catch (error) { toast(error.message); button.disabled = false; }
    return true;
  }
  function input(event) {
    if (event.target.matches("[data-explorer-query]")) { const current = view(); current.query = event.target.value; remember(current); }
  }
  async function change(event) {
    if (event.target.matches("[data-explorer-manifest-import]")) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        if (file.size > 250_000) throw new Error("Workspace manifests must be 250 KB or smaller.");
        const manifest = JSON.parse(await file.text());
        const current = view();
        if (!current.groupId || manifest.schemaVersion !== 2 || !Array.isArray(manifest.resources)) throw new Error("Choose a workspace and a valid schema-v2 manifest.");
        const { manifest: local } = await api(endpoint(current, "manifest"));
        const sources = manifest.resources;
        const rows = local.resources.map((resource) => {
          const match = sources.find((candidate) => candidate.projectId === resource.projectId)
            ?? sources.find((candidate) => candidate.name === resource.name && candidate.repository?.remote === resource.repository?.remote);
          return `<label class="field-label">${esc(resource.name)} · local ${esc(resource.projectId)}<select class="field" data-import-project="${esc(resource.projectId)}"><option value="">Keep current binding</option>${sources.map((candidate) => `<option value="${esc(candidate.projectId)}" ${match?.projectId === candidate.projectId ? "selected" : ""}>${esc(candidate.name)} · ${esc(candidate.repository?.remote ?? "unbound")} · ${esc(candidate.projectId)}</option>`).join("")}</select></label>`;
        }).join("");
        openModal("Resolve imported workspace", `<p>Map each imported project to an existing local project. Unmapped projects keep their current binding. This changes repository declarations only; choose local checkouts separately.</p><p>Import: <strong>${esc(manifest.name ?? "Workspace")}</strong> · ${sources.length} project(s)</p><div class="workspace-bindings">${rows}</div><p id="modalError" class="modal-error" hidden></p>`, "Import bindings", async () => {
          const choices = Object.fromEntries([...document.querySelectorAll("[data-import-project]")].map((select) => [select.dataset.importProject, select.value]));
          const resolved = resolveImportedWorkspaceManifest(local, manifest, choices);
          await api(endpoint(current, "manifest"), { method: "PUT", body: JSON.stringify(resolved) });
          await refreshState(); current.selected.clear(); current.restoreKeys = []; await load();
          toast("Repository bindings imported. Resolve local checkouts before running local checks.");
        });
      } catch (error) { toast(`Manifest import failed: ${error.message}`); }
      finally { event.target.value = ""; }
      return;
    }
    if (event.target.matches("[data-explorer-scan-project]")) { view().scanProjectId = event.target.value; render(); return; }
    if (!event.target.matches("[data-explorer-group]")) return;
    const current = view(); current.groupId = event.target.value; current.scanProjectId = ""; current.selected.clear(); current.restoreKeys = []; current.detail = null; current.items = []; await load();
  }
  return { markup, load, click, input, change, isIdle: () => view().status === "idle" };
}
