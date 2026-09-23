const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

let state;
let selectedProjectId;
let selectedRequestId;
let apiFilter = "all";
let timelineFilter = "all";
let saveTimer;
let bridgeRequestId = 1;
const bridgeRequests = new Map();
let localConnection = null;

function apiOrigin() {
  const params = new URLSearchParams(location.search);
  return window.__API_FORGE_ORIGIN__ ?? (params.get("port") ? `http://127.0.0.1:${Number(params.get("port"))}` : "");
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (localConnection?.token) headers.authorization = `Bearer ${localConnection.token}`;
  const response = await fetch(`${apiOrigin()}${path}`, { headers, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function connectLocalCompanion() {
  const params = new URLSearchParams(location.search);
  const suppliedToken = params.get("token");
  if (suppliedToken) {
    localConnection = { connected: true, token: suppliedToken, companion: "local", port: params.get("port") };
    try { sessionStorage.setItem("aipi:local-token", suppliedToken); } catch {}
  }
  if (!localConnection?.token) {
    try {
      const rememberedToken = sessionStorage.getItem("aipi:local-token");
      if (rememberedToken) localConnection = { connected: true, token: rememberedToken, companion: "local" };
    } catch {}
  }
  const response = await fetch(`${apiOrigin()}/api/connection`);
  const connection = await response.json();
  if (!response.ok) throw new Error(connection.error || `Companion connection failed (${response.status})`);
  localConnection = { ...connection, token: localConnection?.token || connection.token };
  try { sessionStorage.setItem("aipi:local-token", localConnection.token); } catch {}
}

function bridgeRequest(method, params) {
  const id = bridgeRequestId++;
  window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bridgeRequests.delete(id); reject(new Error("Codex chat bridge is unavailable")); }, 4000);
    bridgeRequests.set(id, { resolve, reject, timer });
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return;
  const pending = bridgeRequests.get(message.id);
  if (!pending) return;
  bridgeRequests.delete(message.id);
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(message.error.message ?? "Codex rejected the message"));
  else pending.resolve(message.result);
}, { passive: true });

function project() {
  return state.projects.find((entry) => entry.id === selectedProjectId) ?? state.projects[0];
}

function selectProject(projectId) {
  selectedProjectId = projectId;
  state.activeProjectId = projectId;
  try { localStorage.setItem("api-forge:selectedProject", projectId); } catch {}
  selectedRequestId = project()?.requests[0]?.id;
  scheduleSave();
}

function requestItem(id = selectedRequestId) {
  return project()?.requests.find((entry) => entry.id === id) ?? project()?.requests[0];
}

function environment() {
  const current = project();
  return current?.environments.find((entry) => entry.id === current.activeEnvironmentId) ?? current?.environments[0];
}

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 2200);
}

function mergeRecordedEvent(result) {
  if (!result?.event || (state.timeline ?? []).some((event) => event.id === result.event.id)) return;
  state.timeline ??= [];
  state.timeline.unshift(result.event);
}

async function persistState() {
  const result = await api("/api/state", { method: "PUT", body: JSON.stringify(state) });
  mergeRecordedEvent(result);
  return result;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await persistState();
    }
    catch (error) { toast(`Save failed: ${error.message}`); }
  }, 320);
}

function route() {
  const value = location.hash.replace(/^#\/?/, "");
  const [name = "home", id] = value.split("/");
  return { name: name || "home", id };
}

function navigate(target) {
  const next = target.startsWith("#") ? target : `#/${target.replace(/^\//, "")}`;
  window.scrollTo({ top: 0, left: 0 });
  if (location.hash === next) render();
  else location.hash = next;
}

function statusLabel(status) {
  return ({ healthy: "Matched", "missing-backend": "Missing backend", "unused-backend": "No consumer", failing: "Failing", untested: "Untested" })[status] ?? status ?? "Unverified";
}

function statusClass(status) {
  if (["healthy", "success", "ok"].includes(status)) return "success";
  if (["missing-backend", "failing", "failed", "error"].includes(status)) return "danger";
  return "warning";
}

function formatDate(value) {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function hostFor(value) {
  try { return new URL(value).host || "local endpoint"; }
  catch { return "configured endpoint"; }
}

function methodBadge(method) {
  return `<span class="method-badge method-${esc(method)}">${esc(method)}</span>`;
}

function requestRuns(requestId) {
  return state.history
    .filter((entry) => entry.projectId === project().id && entry.requestId === requestId)
    .sort((left, right) => new Date(right.createdAt ?? 0) - new Date(left.createdAt ?? 0));
}

function lastRunStatus(log) {
  if (!log) return { label: "Not run", tone: "neutral" };
  const result = log.result ?? {};
  const status = Number(result.status);
  if (result.error || !result.ok) return { label: status ? `${status} Failed` : "Run failed", tone: "danger" };
  if (result.passed === false) return { label: status ? `${status} Contract failed` : "Contract failed", tone: "danger" };
  return { label: status ? `${status} Passed` : "Passed", tone: "success" };
}

function normalizedRoute(value) {
  const withoutVariable = String(value ?? "").replace(/^\{\{baseUrl\}\}/, "");
  try { return new URL(withoutVariable, "http://aipi.local").pathname; }
  catch { return withoutVariable.split("?")[0] || "/"; }
}

function matchStatusForRequest(item) {
  const current = project();
  const routePath = normalizedRoute(item.url);
  const integrations = current.sourceContext?.integrations ?? [];
  const integration = integrations.find((entry) => entry.method === item.method && normalizedRoute(entry.path) === routePath);
  if (integration) return integration.status;
  const endpoint = (current.sourceContext?.endpoints ?? []).find((entry) => entry.method === item.method && normalizedRoute(entry.path) === routePath);
  return endpoint ? "healthy" : "untested";
}

function runRow(entry) {
  const runStatus = lastRunStatus(entry);
  return `<button class="run-row" data-log-id="${entry.id}"><div>${methodBadge(entry.method)}<div><strong>${esc(entry.requestName)}</strong><span>${esc(entry.url)}</span></div></div><div><span class="status-tag ${runStatus.tone}">${esc(runStatus.label)}</span><span>${formatDate(entry.createdAt)}</span></div></button>`;
}

function activityRows(current) {
  return (state.timeline ?? []).filter((entry) => entry.projectId === current.id).map((entry) => ({ id: entry.id, kind: entry.type, title: entry.title, detail: entry.summary, createdAt: entry.createdAt, tone: entry.severity, route: entry.source?.kind === "run" ? undefined : entry.source?.route })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function activityRow(entry) {
  const label = ({ run: "Run", scan: "Scan", change: "Change", agent: "Agent", contract: "Contract", decision: "Decision", project: "Project", security: "Security", ci: "CI" })[entry.kind] ?? "Event";
  const target = entry.route ? `data-route="${entry.route}"` : "";
  return `<button class="activity-row" ${target}><span class="activity-kind ${entry.tone}">${label}</span><span class="activity-copy"><strong>${esc(entry.title)}</strong><small>${esc(entry.detail)}</small></span><time datetime="${esc(entry.createdAt)}">${esc(formatDate(entry.createdAt))}</time></button>`;
}

function projectCorrections(current = project()) {
  const source = current.sourceContext ?? {};
  const backend = [];
  const frontend = [];
  const schema = [];
  for (const finding of source.findings ?? []) {
    if (finding.type === "missing-backend") backend.push({ severity: finding.severity, title: finding.title, evidence: "Source scan" });
    if (finding.type === "unused-backend") frontend.push({ severity: finding.severity, title: finding.title, evidence: "Backend route has no detected consumer" });
  }
  const runs = state.history.filter((entry) => entry.projectId === current.id);
  for (const log of runs) {
    const status = Number(log.result?.status);
    if (status >= 500) backend.push({ severity: "high", title: `${log.requestName} returned HTTP ${status}`, evidence: `Run ${log.id}` });
    if ([400, 404, 415, 422].includes(status)) frontend.push({ severity: "high", title: `${log.requestName} needs request or route correction`, evidence: `HTTP ${status}` });
    if (log.result?.contractDiff?.status === "drift") {
      const diff = log.result.contractDiff;
      schema.push({ severity: "high", title: `${log.requestName} differs from ${diff.schema?.name ?? "schema"}`, evidence: `${diff.missingRequiredFields?.length ?? 0} missing · ${diff.unexpectedFields?.length ?? 0} unexpected · ${diff.typeMismatches?.length ?? 0} type mismatches` });
    }
  }
  if ((source.endpoints?.length ?? 0) > 0 && !(source.schemas?.length ?? 0)) schema.push({ severity: "medium", title: "No database schema evidence connected", evidence: "Add migrations or schema files" });
  const unique = (items) => items.filter((entry, index) => items.findIndex((candidate) => candidate.title === entry.title) === index);
  const corrections = { backend: unique(backend), frontend: unique(frontend), schema: unique(schema) };
  const count = corrections.backend.length + corrections.frontend.length + corrections.schema.length;
  return { corrections, count, status: !source.lastScannedAt ? "insufficient-evidence" : count ? "needs-attention" : "aligned-from-current-evidence", tracedRuns: runs.filter((entry) => entry.result?.trace).length, contractDiffs: runs.filter((entry) => entry.result?.contractDiff).length };
}

function codexContext(action = "contextual") {
  const current = project();
  const source = current.sourceContext ?? {};
  const currentRoute = route();
  const currentEnvironment = environment();
  const log = currentRoute.name === "run" ? state.history.find((entry) => entry.id === currentRoute.id) : null;
  const request = currentRoute.name === "request" ? requestItem(currentRoute.id) : log ? requestItem(log.requestId) : null;
  const runs = state.history.filter((entry) => entry.projectId === current.id);
  const intelligence = projectCorrections(current);
  const instruction = ({
    "review-project": "Review the project setup, source coverage, environment readiness, and integration findings. Recommend the next highest-value action.",
    "test-apis": "Review the API inventory, identify the most important unverified integrations, and propose a safe test plan before running anything state-changing.",
    "review-integrations": "Review the frontend-to-backend integration map, prioritize mismatches using source evidence and confidence, and propose the smallest verification plan.",
    "review-runs": "Review recent API runs, group failures by likely cause, and recommend the smallest next checks.",
    "diagnose-run": "Diagnose this run from its saved evidence. Explain the first failing layer and propose a fix plan before changing code or retrying a state-changing request.",
    "plan-project": "Turn the current project evidence into a concise plan-build-test workflow, including frontend/backend/schema gaps and the next implementation tasks.",
    contextual: "Review the current AIPI screen and continue the most useful project, test, diagnosis, or implementation task in Codex chat."
  })[action] ?? "Review this AIPI context and continue the work in Codex chat.";
  const context = {
    project: { id: current.id, name: current.name, goal: current.summary?.goal ?? "" },
    screen: currentRoute.name,
    environment: { id: currentEnvironment?.id, name: currentEnvironment?.name, variableKeys: (currentEnvironment?.variables ?? []).map((entry) => entry.key).filter(Boolean) },
    source: {
      roots: (source.roots ?? []).map((entry) => ({ kind: entry.kind, path: entry.path })),
      lastScannedAt: source.lastScannedAt ?? null,
      git: (source.git ?? []).map((entry) => ({ root: entry.requestedRoot ?? entry.root, commit: entry.commit, branch: entry.branch, dirty: entry.dirty })),
      filesScanned: source.filesScanned ?? 0,
      frameworks: source.frameworks ?? [],
      inventory: { endpoints: source.endpoints?.length ?? 0, frontendCalls: source.frontendCalls?.length ?? 0, schemas: source.schemas?.length ?? 0, integrations: source.integrations?.length ?? 0 },
      findings: (source.findings ?? []).slice(0, 12).map((entry) => ({ id: entry.id, severity: entry.severity, type: entry.type, title: entry.title }))
    },
    corrections: intelligence,
    savedRequests: current.requests.length,
    runs: runs.length,
    request: request ? { id: request.id, name: request.name, method: request.method, url: request.url, assertionCount: request.assertions?.length ?? 0 } : null,
    run: log ? {
      id: log.id, requestId: log.requestId, method: log.method, url: log.url, createdAt: log.createdAt,
      status: log.result?.status ?? null, elapsedMs: log.result?.elapsed_ms ?? null, passed: log.result?.passed ?? false,
      diagnosis: log.result?.diagnosis ?? null,
      assertions: (log.result?.assertions ?? []).map((entry) => ({ type: entry.type, passed: entry.passed }))
    } : null
  };
  return `Continue this AIPI task in Codex chat.\n\n${instruction}\n\nUse the AIPI MCP tools with the IDs below to read authoritative local state and evidence. Do not ask me to restate information already saved in AIPI. Do not expose credentials or secret environment values. Do not retry POST, PUT, PATCH, or DELETE without my authorization.\n\nContext:\n${JSON.stringify(context, null, 2)}`;
}

async function copyCodexContext(prompt) {
  try {
    await navigator.clipboard.writeText(prompt);
    toast("Chat bridge unavailable here. Context copied for Codex.");
  } catch {
    openModal("Continue in Codex chat", `<p class="modal-intro">Copy this redacted context into Codex chat.</p><textarea class="code-input codex-prompt" readonly>${esc(prompt)}</textarea>`, "Copy context", async () => {
      await navigator.clipboard.writeText(prompt);
      toast("Context copied for Codex");
    });
  }
}

async function sendToCodex(action = "contextual") {
  const prompt = codexContext(action);
  try {
    if (typeof window.openai?.sendFollowUpMessage === "function") {
      await window.openai.sendFollowUpMessage({ prompt, title: "Continue with AIPI" });
      toast("Context sent to Codex chat");
      return;
    }
    if (window.parent !== window) {
      await bridgeRequest("ui/message", { role: "user", content: [{ type: "text", text: prompt }] });
      toast("Context sent to Codex chat");
      return;
    }
  } catch (error) {
    console.warn("AIPI could not reach the Codex chat bridge", error);
  }
  await copyCodexContext(prompt);
}

async function copyHandoff(log) {
  const result = log?.result ?? {};
  const suggestions = result.diagnosis?.suggestions ?? [
    "Inspect the endpoint context and affected consumers.",
    "Compare the observed request with the source contract.",
    "Make the smallest safe correction and add a regression test.",
    "Re-run the request through AIPI and verify the result."
  ];
  const markdown = [
    `## AIPI Handoff: ${result.diagnosis?.category ?? "API integration issue"}`,
    "",
    "### Problem",
    result.diagnosis?.summary ?? result.error ?? `Request returned HTTP ${result.status ?? "an unexpected result"}.`,
    "",
    "### Evidence",
    `- Log: \`${log.id}\``,
    `- Request: \`${log.method} ${log.url}\``,
    `- Result: \`${result.status ? `HTTP ${result.status}` : result.error ?? "not available"}\``,
    "",
    "### Recommended action",
    ...suggestions.map((entry, index) => `${index + 1}. ${entry}`),
    "",
    "Use the AIPI MCP tools to inspect authoritative local evidence. Keep credentials and full response bodies out of the handoff.",
    "",
    `Handoff log ID: \`${log.id}\``
  ].join("\n");
  try {
    await navigator.clipboard.writeText(markdown);
    toast("Handoff copied for your IDE agent");
  } catch {
    openModal("AIPI handoff", `<p class="modal-intro">Paste this redacted handoff into your project agent chat.</p><textarea class="code-input codex-prompt" readonly>${esc(markdown)}</textarea>`, "Copy handoff", async () => {
      await navigator.clipboard.writeText(markdown);
      toast("Handoff copied");
    });
  }
}

function shell(content, currentRoute) {
  const activeRun = currentRoute.name === "run" ? state.history.find((entry) => entry.id === currentRoute.id) : null;
  const activeRoot = ["request"].includes(currentRoute.name) || (activeRun && project().requests.some((entry) => entry.id === activeRun.requestId)) ? "apis" : ["run"].includes(currentRoute.name) ? "logs" : currentRoute.name === "summary" ? "project" : currentRoute.name;
  return `
    <div class="app-shell">
      <header class="mobile-header">
        <button class="header-home ${activeRoot === "home" ? "active" : ""}" data-route="home" ${activeRoot === "home" ? 'aria-current="page"' : ""}>Home</button>
        <div class="header-actions"><span class="connection-pill ${localConnection?.connected ? "connected" : ""}">${localConnection?.connected ? "Local companion" : "Disconnected"}</span><button class="header-upgrade" id="upgradeButton">Upgrade</button><button class="header-settings" id="settingsButton">Settings</button></div>
      </header>
      <main class="route-view" data-route-name="${esc(currentRoute.name)}">${content}</main>
      <button class="chat-launcher" data-codex-action="contextual" aria-label="Send this screen's context to Codex chat"><span class="chat-spark">✦</span><span class="chat-label">Ask Codex</span></button>
      <nav class="bottom-nav" aria-label="Primary navigation">
        ${[["project", "Project"], ["apis", "APIs"], ["map", "Map"], ["logs", "Logs"]].map(([target, label]) => `<button class="nav-item ${activeRoot === target ? "active" : ""}" data-route="${target}" ${activeRoot === target ? 'aria-current="page"' : ""}><span>${label}</span></button>`).join("")}
      </nav>
    </div>`;
}

function render() {
  const current = project();
  if (!current) return;
  selectedProjectId = current.id;
  selectedRequestId = requestItem()?.id;
  const currentRoute = route();
  let content;
  if (currentRoute.name === "home") content = renderHome();
  else if (currentRoute.name === "project") content = renderProject();
  else if (currentRoute.name === "apis") content = renderApis();
  else if (currentRoute.name === "request") content = renderRequest(currentRoute.id);
  else if (currentRoute.name === "map") content = renderIntegrationMap();
  else if (currentRoute.name === "runs" || currentRoute.name === "logs") content = renderLogs();
  else if (currentRoute.name === "run") content = renderRun(currentRoute.id);
  else if (currentRoute.name === "summary") content = renderProject();
  else content = renderProject();
  $("#app").className = "";
  $("#app").innerHTML = shell(content, currentRoute);
}

function renderHome() {
  return `
    <section class="home-hero">
      <div class="product-mark"><img src="/aipi-logo.svg" alt="AIPI logo"><span class="logo-letter">A</span><span class="logo-neutral">i</span>-<span class="logo-letter">PI</span></div>
      <p class="eyebrow">Local API workspace</p>
      <h1>Your projects</h1>
      <p>Select a project to inspect its source, environments, APIs, and local run history.</p>
      <button class="primary-button large-button" id="createProjectPageButton">New project</button>
    </section>
    <section class="home-projects" aria-label="Projects">
      <div class="section-heading"><div><p class="eyebrow">Workspace</p><h2>${state.projects.length} project${state.projects.length === 1 ? "" : "s"}</h2></div></div>
      <div class="project-card-list">${state.projects.map((entry) => {
        const source = entry.sourceContext ?? {};
        const runs = state.history.filter((item) => item.projectId === entry.id).length;
        const env = entry.environments.find((item) => item.id === entry.activeEnvironmentId) ?? entry.environments[0];
        return `<button class="project-card" data-select-project="${entry.id}"><span class="project-avatar">${esc(entry.name.slice(0, 1).toUpperCase())}</span><span class="project-card-copy"><strong>${esc(entry.name)}</strong><small>${esc(entry.summary?.goal || entry.description || "API project")}</small><span class="project-card-meta">${esc(env?.name ?? "No environment")} · ${entry.requests.length} request${entry.requests.length === 1 ? "" : "s"} · ${runs} run${runs === 1 ? "" : "s"}</span></span><span class="project-card-arrow" aria-hidden="true">›</span></button>`;
      }).join("")}</div>
    </section>`;
}

function renderProject() {
  const current = project();
  const source = current.sourceContext ?? {};
  const healthy = (source.integrations ?? []).filter((entry) => entry.status === "healthy").length;
  const findings = source.findings ?? [];
  const runs = state.history.filter((entry) => entry.projectId === current.id);
  const evidenceStatus = !source.lastScannedAt ? "Not enough evidence yet" : findings.length ? `${findings.length} integration finding${findings.length === 1 ? "" : "s"}` : "Current source evidence is aligned";
  return `
    <section class="page-heading">
      <div><button class="text-back-button" data-route="home">All projects</button><p class="eyebrow">Project</p><h1>${esc(current.name)}</h1><p>${esc(current.summary?.goal || "Connect source, discover APIs, and verify every integration.")}</p></div>
      <button class="secondary-button" id="editProjectButton">Edit project</button>
    </section>

    <section class="health-strip" aria-label="Project API health">
      <button data-route="apis"><strong>${source.endpoints?.length ?? 0}</strong><span>Backend APIs</span></button>
      <button data-route="apis"><strong>${source.frontendCalls?.length ?? 0}</strong><span>Frontend calls</span></button>
      <button data-route="map"><strong>${healthy}</strong><span>Matched</span></button>
      <button data-route="logs"><strong>${runs.length}</strong><span>Activity logs</span></button>
    </section>

    <section class="section-block">
      <div class="section-heading"><div><p class="eyebrow">Project information</p><h2>About this workspace</h2></div><button class="quiet-button" id="editProjectSecondary">Edit</button></div>
      <div class="detail-list"><div><span>Description</span><strong>${esc(current.description || "No description added")}</strong></div><div><span>Project ID</span><strong>${esc(current.id)}</strong></div><div><span>Updated</span><strong>${formatDate(current.updatedAt)}</strong></div></div>
    </section>

    <section class="section-block">
      <div class="section-heading"><div><p class="eyebrow">Source context</p><h2>${source.lastScannedAt ? `${source.filesScanned} files indexed` : "Connect your codebase"}</h2></div><button class="quiet-button" id="scanSourceSecondary">Edit</button></div>
      ${source.roots?.length ? `<div class="source-list">${source.roots.map((entry) => `<div class="source-row"><div><strong>${esc(entry.kind)}</strong><span>${esc(entry.path)}</span></div><span class="status-text success">Included</span></div>`).join("")}</div>` : `<div class="empty-message"><h3>Give Codex the missing context</h3><p>Add frontend, backend, schema, tests, or a local Git clone. AIPI scans locally and stores only derived metadata.</p><button class="secondary-button" id="connectSourceEmpty">Choose folders</button></div>`}
      ${source.frameworks?.length ? `<div class="tag-row">${source.frameworks.map((entry) => `<span class="tag">${esc(entry)}</span>`).join("")}</div>` : ""}
      <p class="supporting-copy">${source.lastScannedAt ? `Last scanned ${formatDate(source.lastScannedAt)}.` : "Remote Git cloning is staged for a later release; use an existing local clone today."}</p>
    </section>

    <section class="section-block environment-section">
      <div class="section-heading"><div><p class="eyebrow">Environments</p><h2>${current.environments.length} configured</h2></div><button class="secondary-button" id="createEnvironmentButton">New environment</button></div>
      <div class="environment-list">${current.environments.map((entry) => {
        const active = entry.id === current.activeEnvironmentId;
        const baseUrl = entry.variables?.find((item) => item.key === "baseUrl")?.value;
        return `<div class="environment-card ${active ? "active" : ""}"><button class="environment-select-button" data-select-environment="${entry.id}"><span><strong>${esc(entry.name)}</strong><small>${esc(baseUrl || `${entry.variables?.length ?? 0} variables`)}</small></span><b>${active ? "Active" : "Use"}</b></button>${active ? `<button class="quiet-button" id="manageVariablesButton">Edit</button>` : ""}</div>`;
      }).join("")}</div>
    </section>

    <section class="section-block">
      <div class="section-heading"><div><p class="eyebrow">Evidence status</p><h2>${evidenceStatus}</h2></div><button class="quiet-button" data-route="apis">View APIs</button></div>
      ${findings.length ? `<div class="finding-list">${findings.slice(0, 4).map((entry) => `<button data-route="apis"><span class="status-mark ${statusClass(entry.type)}">${entry.severity === "high" ? "High" : "Check"}</span><span>${esc(entry.title)}</span></button>`).join("")}</div>` : `<p class="supporting-copy">${source.lastScannedAt ? "No source-level route mismatch is currently detected. Trace representative routes to verify runtime contracts." : "Connect source and database schema, then trace representative APIs before treating this project as aligned."}</p>`}
    </section>
    ${renderProjectSummary()}`;
}

function endpointRows() {
  const current = project();
  const discovered = current.sourceContext?.endpoints ?? [];
  const rows = current.requests.map((entry) => ({ kind: "request", id: entry.id, method: entry.method, path: entry.url, name: entry.name, status: matchStatusForRequest(entry), latestRun: requestRuns(entry.id)[0], source: "Saved request" }));
  const known = new Set(rows.map((entry) => `${entry.method}:${entry.path}`));
  for (const endpoint of discovered) {
    if (!known.has(`${endpoint.method}:{{baseUrl}}${endpoint.path}`) && !known.has(`${endpoint.method}:${endpoint.path}`)) rows.push({ kind: "discovered", id: endpoint.id, method: endpoint.method, path: endpoint.path, name: endpoint.path, status: "untested", source: endpoint.source, endpoint });
  }
  return rows;
}

function renderApis() {
  const current = project();
  const activeEnvironment = environment();
  const integrations = project().sourceContext?.integrations ?? [];
  let rows = endpointRows();
  if (apiFilter !== "all") rows = rows.filter((entry) => entry.status === apiFilter || integrations.some((integration) => integration.method === entry.method && integration.path === entry.path && integration.status === apiFilter));
  return `
    <section class="page-heading compact-heading"><div><p class="eyebrow">API inventory</p><h1>Requests</h1><p>Inspect discovered routes here, then plan and run tests with Codex.</p></div><button class="primary-button" data-codex-action="test-apis">Test with Codex</button></section>
    <section class="api-environment-bar"><label for="apiEnvironmentSelect"><span>Environment</span><select id="apiEnvironmentSelect">${current.environments.map((entry) => `<option value="${entry.id}" ${entry.id === current.activeEnvironmentId ? "selected" : ""}>${esc(entry.name)}</option>`).join("")}</select></label><div><span>Base URL</span><strong>${esc(activeEnvironment?.variables?.find((entry) => entry.key === "baseUrl")?.value || "Not configured")}</strong></div></section>
    <section class="filter-bar"><label><span class="sr-only">Filter APIs</span><select id="apiFilter">${[["all", "All APIs"], ["healthy", "Matched"], ["untested", "Untested"], ["missing-backend", "Missing backend"], ["unused-backend", "No consumer"]].map(([value, label]) => `<option value="${value}" ${apiFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><span>${rows.length} shown</span></section>
    <section class="api-list">${rows.length ? rows.map((entry) => {
      const runStatus = lastRunStatus(entry.latestRun);
      return `<button class="api-row" ${entry.kind === "request" ? `data-request-id="${entry.id}"` : `data-discovered-id="${entry.id}"`}><div class="api-row-main">${methodBadge(entry.method)}<div><strong>${esc(entry.name)}</strong><span>${esc(entry.path)}</span></div></div><div class="api-row-meta"><div class="api-row-tags"><span class="status-tag ${runStatus.tone}">${esc(runStatus.label)}</span><span class="status-tag ${statusClass(entry.status)}">${esc(statusLabel(entry.status))}</span></div>${entry.latestRun ? `<time class="api-run-time" datetime="${esc(entry.latestRun.createdAt)}">Last tested ${esc(formatDate(entry.latestRun.createdAt))}</time>` : `<span class="api-run-time">Never tested</span>`}</div></button>`;
    }).join("") : `<div class="empty-message"><h3>No APIs in this view</h3><p>Connect source code or create a request manually.</p><button class="secondary-button" id="emptyNewRequest">Create request</button></div>`}</section>
    <section class="section-block api-activity-preview"><div class="section-heading"><div><p class="eyebrow">Recent logs</p><h2>What changed around these APIs</h2></div><button class="quiet-button" data-route="logs">View all logs</button></div>${activityRows(current).slice(0, 4).map(activityRow).join("") || `<p class="supporting-copy">Runs, agent summaries, MCP context, and new APIs will appear here as work happens.</p>`}</section>`;
}

function renderIntegrationMap() {
  const source = project().sourceContext ?? {};
  const integrations = source.integrations ?? [];
  const endpoints = new Map((source.endpoints ?? []).map((entry) => [entry.id, entry]));
  const calls = new Map((source.frontendCalls ?? []).map((entry) => [entry.id, entry]));
  const schemas = source.schemas ?? [];
  return `
    <section class="page-heading compact-heading"><div><p class="eyebrow">Integration intelligence</p><h1>Integration Map</h1><p>Trace each consumer to implementation, schema evidence, tests, and runs.</p></div><button class="primary-button" data-codex-action="review-integrations">Review with Codex</button></section>
    <section class="map-overview">
      <div><strong>${integrations.filter((entry) => entry.status === "healthy").length}</strong><span>Healthy</span></div>
      <div><strong>${integrations.filter((entry) => entry.status === "missing-backend").length}</strong><span>Missing</span></div>
      <div><strong>${integrations.filter((entry) => entry.status === "unused-backend").length}</strong><span>Unused</span></div>
      <div><strong>${schemas.length}</strong><span>Schemas</span></div>
    </section>
    <section class="integration-list">${integrations.length ? integrations.map((entry) => {
      const endpoint = endpoints.get(entry.endpointId);
      const call = calls.get(entry.callId);
      return `<button class="integration-card" data-integration-id="${entry.id}">
        <div class="integration-head">${methodBadge(entry.method)}<strong>${esc(entry.path)}</strong><span class="status-text ${statusClass(entry.status)}">${statusLabel(entry.status)}</span></div>
        <div class="integration-flow">
          <span><small>Consumer</small>${call ? `${esc(call.source)}:${call.line}` : "Not detected"}</span>
          <b aria-hidden="true">→</b>
          <span><small>Implementation</small>${endpoint ? `${esc(endpoint.source)}:${endpoint.line}` : "Missing"}</span>
          <b aria-hidden="true">→</b>
          <span><small>Schema</small>${schemas[0] ? `${esc(schemas[0].source)}:${schemas[0].line}` : "Unlinked"}</span>
        </div>
        <p>Confidence ${Math.round((entry.confidence ?? 0) * 100)}% · scanned ${formatDate(source.lastScannedAt)}</p>
      </button>`;
    }).join("") : `<div class="empty-message"><h3>No integration evidence yet</h3><p>Connect source context, then ask Codex to scan and map frontend calls to backend routes.</p><button class="secondary-button" id="connectSourceEmpty">Connect source</button></div>`}</section>`;
}

function keyRows(rows, kind) {
  return `<div class="kv-list">${rows.map((entry, index) => `<div class="kv-row"><input type="checkbox" data-kv-enable="${kind}:${index}" ${entry.enabled !== false ? "checked" : ""} aria-label="Enable row"><input data-kv-key="${kind}:${index}" value="${esc(entry.key)}" placeholder="Key"><input data-kv-value="${kind}:${index}" value="${esc(entry.value)}" placeholder="Value"><button class="remove-button" data-kv-remove="${kind}:${index}" aria-label="Remove row">Remove</button></div>`).join("")}</div><button class="quiet-button add-row-button" data-kv-add="${kind}">Add row</button>`;
}

function renderRequest(id) {
  const item = requestItem(id);
  if (!item) return `<div class="empty-message"><h2>Request not found</h2><button class="secondary-button" data-route="apis">Back to APIs</button></div>`;
  selectedRequestId = item.id;
  const logs = requestRuns(item.id);
  const latestStatus = lastRunStatus(logs[0]);
  const matchStatus = matchStatusForRequest(item);
  return `
    <section class="request-route-head"><button class="back-button" data-route="apis">Back to APIs</button><div><p class="eyebrow">Request</p><input id="requestName" class="title-input" value="${esc(item.name)}" aria-label="Request name"><div class="request-statuses"><span class="status-tag ${latestStatus.tone}">${esc(latestStatus.label)}</span><span class="status-tag ${statusClass(matchStatus)}">${esc(statusLabel(matchStatus))}</span></div></div></section>
    <section class="request-composer">
      <div class="composer-row"><select id="methodSelect" class="method-select">${methods.map((method) => `<option ${method === item.method ? "selected" : ""}>${method}</option>`).join("")}</select><input id="urlInput" class="url-input" value="${esc(item.url)}" placeholder="{{baseUrl}}/api/resource" spellcheck="false"></div>
      <button class="run-button" id="runRequestButton">Run request <span>⌘↵</span></button>
    </section>
    <section class="configuration-list">
      <details><summary><span>Params</span><span>${item.params?.length ?? 0} configured</span></summary><div class="details-body">${keyRows(item.params ?? [], "params")}</div></details>
      <details><summary><span>Auth</span><span>${item.auth?.type === "none" ? "None" : esc(item.auth?.type ?? "None")}</span></summary><div class="details-body"><label class="field-label">Authentication<select id="authType" class="field">${[["none", "No auth"], ["bearer", "Bearer token"], ["basic", "Basic auth"], ["apiKey", "API key"]].map(([value, label]) => `<option value="${value}" ${item.auth?.type === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><div id="authFields">${renderAuthFields(item)}</div></div></details>
      <details><summary><span>Headers</span><span>${item.headers?.length ?? 0} configured</span></summary><div class="details-body">${keyRows(item.headers ?? [], "headers")}</div></details>
      <details><summary><span>Body</span><span>${item.body?.type ?? "json"}</span></summary><div class="details-body"><label class="field-label">Body type<select id="bodyType" class="field">${[["json", "JSON"], ["text", "Text"], ["form", "Form URL encoded"]].map(([value, label]) => `<option value="${value}" ${item.body?.type === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><textarea id="bodyContent" class="code-input" spellcheck="false">${esc(item.body?.content ?? "")}</textarea></div></details>
      <details><summary><span>Tests</span><span>${item.assertions?.length ?? 0} assertions</span></summary><div class="details-body">${renderAssertions(item.assertions ?? [])}</div></details>
      <details><summary><span>Advanced</span><span>Certificates, scripts, retry</span></summary><div class="details-body"><label class="toggle-row"><input type="checkbox" id="retryEnabled" ${item.retry?.enabled ? "checked" : ""}><span>Retry transient failures automatically</span></label><label class="field-label">Endpoint notes<textarea id="docsContent" class="text-input">${esc(item.docs ?? "")}</textarea></label></div></details>
    </section>
    <section class="api-runs-section" aria-labelledby="apiRunsHeading"><div class="api-runs-heading"><div><p class="eyebrow">Run evidence</p><h2 id="apiRunsHeading">Runs for this API</h2><p>${logs.length ? `${logs.length} local attempt${logs.length === 1 ? "" : "s"}, newest first.` : "Run this request to capture response and contract evidence."}</p></div><button class="secondary-button" id="runRequestSecondary">Run now</button></div><div class="run-list embedded-run-list">${logs.length ? logs.map(runRow).join("") : `<div class="empty-message compact-empty"><h3>No runs yet</h3><p>The first result will appear here and stay attached to this API.</p></div>`}</div></section>`;
}

function renderAuthFields(item) {
  const auth = item.auth ?? { type: "none" };
  if (auth.type === "bearer") return `<label class="field-label">Token<input class="field" id="authToken" type="password" value="${esc(auth.token ?? "")}" placeholder="Bearer token"></label>`;
  if (auth.type === "basic") return `<label class="field-label">Username<input class="field" id="authUsername" value="${esc(auth.username ?? "")}"></label><label class="field-label">Password<input class="field" id="authPassword" type="password" value="${esc(auth.password ?? "")}"></label>`;
  if (auth.type === "apiKey") return `<label class="field-label">Key name<input class="field" id="authKey" value="${esc(auth.key ?? "")}"></label><label class="field-label">Secret value<input class="field" id="authValue" type="password" value="${esc(auth.value ?? "")}"></label>`;
  return `<p class="supporting-copy">No Authorization header will be added.</p>`;
}

function renderAssertions(assertions) {
  return `<div class="assertion-list">${assertions.map((entry, index) => `<div class="assertion-row"><select data-test-type="${index}"><option value="status" ${entry.type === "status" ? "selected" : ""}>Status</option><option value="json_path" ${entry.type === "json_path" ? "selected" : ""}>JSON path</option><option value="header" ${entry.type === "header" ? "selected" : ""}>Header</option><option value="response_time" ${entry.type === "response_time" ? "selected" : ""}>Response time</option></select><input data-test-target="${index}" value="${esc(entry.path ?? entry.name ?? "")}" placeholder="Target"><input data-test-expected="${index}" value="${esc(entry.equals ?? entry.less_than_ms ?? "")}" placeholder="Expected"><button class="remove-button" data-test-remove="${index}">Remove</button></div>`).join("")}</div><button class="quiet-button add-row-button" id="addAssertionButton">Add assertion</button>`;
}

function timelineTypeLabel(type) {
  return ({ run: "Run", scan: "Scan", change: "Change", agent: "Agent", contract: "Contract", decision: "Decision", project: "Project", security: "Security", ci: "CI" })[type] ?? "Event";
}

function timelineDay(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const key = date.toDateString();
  if (key === today.toDateString()) return "Today";
  if (key === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(date);
}

function compactEvidence(value) {
  const entries = Object.entries(value ?? {}).filter(([, entry]) => entry !== null && entry !== undefined && entry !== "" && (!Array.isArray(entry) || entry.length));
  if (!entries.length) return "";
  return `<dl class="event-evidence">${entries.slice(0, 10).map(([key, entry]) => `<div><dt>${esc(key.replace(/([A-Z])/g, " $1"))}</dt><dd>${esc(typeof entry === "object" ? JSON.stringify(entry) : entry)}</dd></div>`).join("")}</dl>`;
}

function inlineRunEvidence(event) {
  const log = state.history.find((entry) => entry.id === event.source?.ref);
  if (!log) return "";
  const result = log.result ?? {};
  const body = result.json ? JSON.stringify(result.json, null, 2) : String(result.body ?? result.error ?? "No response body");
  return `<div class="inline-run-evidence"><div class="run-metrics"><span><b>${result.status ?? "—"}</b>HTTP status</span><span><b>${result.elapsed_ms ?? "—"}</b>Latency ms</span><span><b>${(result.assertions ?? []).filter((assertion) => assertion.passed).length}/${result.assertions?.length ?? 0}</b>Assertions</span></div><p>${esc(result.diagnosis?.summary ?? "Runtime evidence captured locally.")}</p><pre>${esc(body.slice(0, 2400))}${body.length > 2400 ? "\n… bounded preview" : ""}</pre><div class="event-actions"><button class="quiet-button" data-route="request/${esc(log.requestId)}">Open API</button><button class="quiet-button" data-rerun-log="${esc(log.id)}">Run again</button></div></div>`;
}

function timelineEvent(event) {
  return `<details class="project-event severity-${esc(event.severity)}"><summary><span class="event-marker" aria-hidden="true"></span><span class="event-main"><span class="event-meta"><b>${esc(timelineTypeLabel(event.type))}</b><span>${esc(event.actor)}</span><time datetime="${esc(event.createdAt)}">${esc(formatDate(event.createdAt))}</time></span><strong>${esc(event.title)}</strong><small>${esc(event.summary)}</small>${event.tags?.length ? `<span class="event-tags">${event.tags.map((tag) => `<i>${esc(tag)}</i>`).join("")}</span>` : ""}</span><span class="event-expand">⌄</span></summary><div class="event-body">${event.type === "run" ? inlineRunEvidence(event) : ""}${compactEvidence(event.evidence)}${event.source?.files?.length ? `<div class="event-files"><span>Affected files</span>${event.source.files.slice(0, 20).map((file) => `<code>${esc(file)}</code>`).join("")}</div>` : ""}</div></details>`;
}

function renderLogs() {
  const current = project();
  const allEvents = (state.timeline ?? []).filter((entry) => entry.projectId === current.id);
  const filters = [{ id: "all", label: "All" }, { id: "run", label: "Runs" }, { id: "change", label: "Changes" }, { id: "scan", label: "Scans" }, { id: "agent", label: "Agent" }, { id: "attention", label: "Needs attention" }];
  const entries = allEvents.filter((event) => timelineFilter === "all" || event.type === timelineFilter || (timelineFilter === "change" && ["change", "project", "decision", "contract"].includes(event.type)) || (timelineFilter === "agent" && ["agent", "decision"].includes(event.type)) || (timelineFilter === "attention" && ["warning", "danger"].includes(event.severity)));
  const grouped = entries.reduce((groups, event) => { const day = timelineDay(event.createdAt); (groups[day] ??= []).push(event); return groups; }, {});
  const failureCount = allEvents.filter((event) => event.severity === "danger").length;
  const changeCount = allEvents.filter((event) => ["change", "agent", "decision", "contract", "project"].includes(event.type)).length;
  return `<section class="page-heading compact-heading"><div><p class="eyebrow">Project source of truth</p><h1>Timeline</h1><p>Every meaningful run, source scan, configuration update, agent decision, contract verification, and CI signal—recorded locally as evidence for future analysis.</p></div><button class="primary-button" data-codex-action="review-runs">Analyze with Codex</button></section><section class="timeline-overview" aria-label="Timeline summary"><div><strong>${allEvents.length}</strong><span>Total events</span></div><div><strong>${allEvents.filter((event) => event.type === "run").length}</strong><span>API runs</span></div><div><strong>${changeCount}</strong><span>Recorded changes</span></div><div class="${failureCount ? "has-danger" : ""}"><strong>${failureCount}</strong><span>Failures</span></div></section><section class="timeline-controls"><div class="timeline-filters" aria-label="Filter timeline">${filters.map((filter) => `<button class="${timelineFilter === filter.id ? "active" : ""}" data-timeline-filter="${filter.id}">${filter.label}</button>`).join("")}</div><span>${entries.length} shown · local evidence</span></section><section class="project-timeline">${entries.length ? Object.entries(grouped).map(([day, events]) => `<section class="timeline-day"><h2><span>${esc(day)}</span><small>${events.length} event${events.length === 1 ? "" : "s"}</small></h2><div class="timeline-ledger">${events.map(timelineEvent).join("")}</div></section>`).join("") : `<div class="empty-message"><h3>No matching evidence</h3><p>Change the filter, run an API, scan source, or ask Codex to record an implementation decision.</p><button class="secondary-button" data-timeline-filter="all">Show all events</button></div>`}</section>`;
}

function renderRun(id) {
  const log = state.history.find((entry) => entry.id === id);
  if (!log) return `<div class="empty-message"><h2>Log not found</h2><button class="secondary-button" data-route="logs">Back to logs</button></div>`;
  const parentRequest = project().requests.find((entry) => entry.id === log.requestId);
  const result = log.result ?? {};
  const success = Boolean(result.ok && result.passed !== false);
  const body = result.json ? JSON.stringify(result.json, null, 2) : result.body ?? result.error ?? "No response body";
  return `
    <section class="request-route-head"><button class="back-button" data-route="${parentRequest ? `request/${parentRequest.id}` : "logs"}">${parentRequest ? "Back to API" : "Back to logs"}</button><div><p class="eyebrow">Log detail</p><h1>${esc(log.requestName)}</h1></div></section>
    <section class="run-hero ${success ? "success-surface" : "failure-surface"}"><div><p class="eyebrow">${success ? "Run completed" : "Run needs attention"}</p><h2>${methodBadge(log.method)} ${esc(result.request?.url ?? log.url)}</h2><p>${result.status ? `HTTP ${result.status}` : "Network error"} · ${result.elapsed_ms ?? 0} ms · ${formatDate(log.createdAt)}</p></div><button class="secondary-button" data-rerun-log="${log.id}">Run again</button></section>
    <section class="timeline" aria-label="Run timeline">
      <div class="timeline-step"><span class="step-label">1</span><div><h3>Connected</h3><p>${result.error ? esc(result.error) : `Reached ${esc(hostFor(result.request?.url ?? log.url))}`}</p></div><span>${Math.max(1, Math.round((result.elapsed_ms ?? 0) * .2))} ms</span></div>
      <div class="timeline-step"><span class="step-label">2</span><div><h3 class="${success ? "success-text" : "danger-text"}">${result.status ? `${result.status} ${result.status_text ?? ""}` : "Request failed"}</h3><p>${result.truncated ? "Response captured with truncation" : "Response captured locally"}</p></div><span>${result.elapsed_ms ?? 0} ms</span></div>
      <div class="timeline-step"><span class="step-label">3</span><div><h3>${result.assertions?.filter((entry) => entry.passed).length ?? 0} of ${result.assertions?.length ?? 0} assertions passed</h3><div class="check-list">${result.assertions?.length ? result.assertions.map((entry) => `<p class="${entry.passed ? "success-text" : "danger-text"}">${entry.passed ? "Passed" : "Failed"}: ${esc(entry.type)}</p>`).join("") : `<p>No assertions configured</p>`}</div></div></div>
      <div class="timeline-step response-step"><span class="step-label">4</span><div><div class="inline-heading"><h3>Response preview</h3><button class="quiet-button" data-copy-response>Copy</button></div><pre>${esc(body)}</pre></div></div>
    </section>
    <section class="codex-summary"><p class="eyebrow">Codex-ready evidence</p><h2>${esc(result.diagnosis?.category ?? (success ? "Request completed" : "Request failed"))}</h2><p>${esc(result.diagnosis?.summary ?? (success ? "The endpoint returned successfully. Add assertions to turn this run into a reusable contract." : "Review the response evidence and relevant source context before changing code."))}</p>${result.diagnosis?.suggestions?.length ? `<ul>${result.diagnosis.suggestions.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul>` : ""}<div class="action-row"><button class="primary-button" data-codex-action="diagnose-run">Ask Codex to continue</button><button class="secondary-button" data-copy-handoff="${log.id}">Copy handoff</button><button class="secondary-button" data-save-contract="${log.requestId}">Save as contract</button></div></section>`;
}

function renderProjectSummary() {
  const current = project();
  const source = current.sourceContext ?? {};
  const tasks = current.summary?.tasks ?? [];
  const intelligence = projectCorrections(current);
  const gitEvidence = source.git?.[0];
  const correctionCard = (label, items, empty) => `<article class="correction-card"><div><p class="eyebrow">${label}</p><strong>${items.length}</strong></div>${items.length ? `<div class="correction-list">${items.slice(0, 3).map((entry) => `<div><span class="severity-dot ${entry.severity === "high" ? "danger" : "warning"}"></span><p><b>${esc(entry.title)}</b><small>${esc(entry.evidence)}</small></p></div>`).join("")}</div>` : `<p class="correction-empty">${empty}</p>`}</article>`;
  return `
    <section class="summary-heading"><div><p class="eyebrow">Project summary</p><h2>${intelligence.status === "needs-attention" ? `${intelligence.count} correction${intelligence.count === 1 ? "" : "s"} need review` : intelligence.status === "insufficient-evidence" ? "Evidence is not complete yet" : "Current evidence is aligned"}</h2><p>Backend, frontend, and schema status derived from source scans and observed traffic.</p></div><button class="primary-button" data-codex-action="plan-project">Plan with Codex</button></section>
    <section class="evidence-strip"><div><span>Last source scan</span><strong>${formatDate(source.lastScannedAt)}</strong></div><div><span>Scanned revision</span><strong>${gitEvidence?.available ? `${esc(gitEvidence.commit?.slice(0, 8) ?? "unknown")}${gitEvidence.dirty ? " · changed" : ""}` : "Git unavailable"}</strong></div><div><span>Traced runs</span><strong>${intelligence.tracedRuns}</strong></div><div><span>Contract comparisons</span><strong>${intelligence.contractDiffs}</strong></div></section>
    <section class="correction-grid">${correctionCard("Backend problems", intelligence.corrections.backend, source.lastScannedAt ? "No backend problem detected in current evidence." : "Scan backend source to establish requirements.")}${correctionCard("Frontend corrections", intelligence.corrections.frontend, source.lastScannedAt ? "No frontend correction detected in current evidence." : "Connect frontend source to compare API usage.")}${correctionCard("Schema issues", intelligence.corrections.schema, source.schemas?.length ? "No schema drift detected in traced responses." : "Connect schema files to validate response contracts.")}</section>
    <section class="section-block"><p class="eyebrow">Project goal</p><textarea id="projectGoal" class="goal-input" aria-label="Project goal">${esc(current.summary?.goal ?? "")}</textarea></section>
    <section class="section-block"><div class="section-heading"><div><p class="eyebrow">Detected architecture</p><h2>${source.frameworks?.length ? source.frameworks.join(", ") : "Scan source to detect libraries"}</h2></div></div><div class="summary-grid"><div><strong>${source.endpoints?.length ?? 0}</strong><span>Backend endpoints</span></div><div><strong>${source.frontendCalls?.length ?? 0}</strong><span>Frontend calls</span></div><div><strong>${source.schemas?.length ?? 0}</strong><span>Database objects</span></div><div><strong>${source.integrations?.filter((entry) => entry.status === "healthy").length ?? 0}</strong><span>Verified matches</span></div></div></section>
    <section class="section-block"><div class="section-heading"><div><p class="eyebrow">Implementation status</p><h2>Plan, build, test</h2></div></div><div class="task-list">${tasks.length ? tasks.map((entry) => `<div><span class="task-status">${esc(entry.status)}</span><strong>${esc(entry.title)}</strong></div>`).join("") : `<p class="supporting-copy">Connect source to generate API-specific tasks and iteration history.</p>`}</div></section>
    <section class="section-block"><div class="section-heading"><div><p class="eyebrow">Recent iterations</p><h2>${current.summary?.iterations?.length ?? 0} recorded</h2></div></div><div class="iteration-list">${(current.summary?.iterations ?? []).slice().reverse().map((entry) => `<div><strong>${esc(entry.label)}</strong><span>${formatDate(entry.at)}</span></div>`).join("") || `<p class="supporting-copy">Scans, verified runs, and code corrections will appear here.</p>`}</div></section>`;
}

function openModal(title, body, confirmLabel, onConfirm) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = body;
  $("#modalConfirm").textContent = confirmLabel;
  $("#modalConfirm").disabled = false;
  $("#modalConfirm").onclick = async (event) => {
    event.preventDefault();
    try { await onConfirm(); $("#modal").close(); }
    catch (error) { toast(error.message); }
  };
  $("#modal").showModal();
}

function openSourceModal() {
  const roots = project().sourceContext?.roots?.length ? project().sourceContext.roots : [{ kind: "workspace", path: "" }];
  openModal("Connect source context", `<p class="modal-intro">Add local folders or an existing local Git clone. AIPI scans source locally; secret values and file contents are not copied into project metadata.</p><div id="sourceRootList">${roots.map(sourceRootRow).join("")}</div><button type="button" class="quiet-button" id="addSourceRoot">Add another folder</button><p class="supporting-copy">Remote Git cloning will arrive later. Paste the path to a local clone for now.</p>`, "Scan source", async () => {
    const sourceRoots = $$(".source-root-row", $("#modal")).map((row) => ({ kind: $("select", row).value, path: $("input", row).value.trim() })).filter((entry) => entry.path);
    if (!sourceRoots.length) throw new Error("Add at least one folder path");
    $("#modalConfirm").disabled = true;
    $("#modalConfirm").textContent = "Scanning…";
    await api("/api/scan", { method: "POST", body: JSON.stringify({ projectId: project().id, roots: sourceRoots }) });
    state = await api("/api/state");
    render();
    toast("Source context indexed locally");
  });
  $("#addSourceRoot").onclick = () => $("#sourceRootList").insertAdjacentHTML("beforeend", sourceRootRow({ kind: "backend", path: "" }));
}

function sourceRootRow(entry) {
  return `<div class="source-root-row"><select>${[["workspace", "Workspace"], ["frontend", "Frontend"], ["backend", "Backend"], ["database", "Database"], ["schemas", "API schemas"], ["tests", "Tests"], ["docs", "Documentation"]].map(([value, label]) => `<option value="${value}" ${value === entry.kind ? "selected" : ""}>${label}</option>`).join("")}</select><input value="${esc(entry.path)}" placeholder="/absolute/path/to/project"><button type="button" class="remove-button" data-remove-source>Remove</button></div>`;
}

function openVariablesModal() {
  const env = environment();
  openModal("Environment variables", `<label class="field-label">Environment name<input class="field" id="environmentName" value="${esc(env.name)}"></label><div id="environmentVariables">${keyRows(env.variables ?? [], "environment")}</div><p class="supporting-copy">Secret variables are stored in your OS credential vault and represented by opaque references in the local workspace. They stay redacted in agent reports and exports.</p>`, "Save variables", async () => {
    env.name = $("#environmentName").value.trim() || env.name;
    await persistState();
    render();
  });
}

function openCreateEnvironmentModal() {
  openModal("New environment", `<p class="modal-intro">Add a local, preview, staging, or production target for this project.</p>
    <label class="field-label">Environment name<input class="field" id="newEnvironmentName" autocomplete="off" placeholder="Staging"></label>
    <label class="field-label">Base URL<input class="field" id="newEnvironmentBaseUrl" value="http://localhost:3000" spellcheck="false" placeholder="https://api.example.com"></label>
    <p class="supporting-copy">You can add tokens and other variables after creating the environment.</p>`, "Create environment", async () => {
    const name = $("#newEnvironmentName").value.trim();
    const baseUrl = $("#newEnvironmentBaseUrl").value.trim();
    if (!name) throw new Error("Enter an environment name");
    const current = project();
    const created = { id: uid("env"), name, variables: baseUrl ? [{ key: "baseUrl", value: baseUrl, enabled: true, secret: false }] : [] };
    current.environments.push(created);
    current.activeEnvironmentId = created.id;
    current.updatedAt = new Date().toISOString();
    await persistState();
    render();
    toast(`${name} environment created`);
  });
  queueMicrotask(() => $("#newEnvironmentName")?.focus());
}

function openEditProjectModal() {
  const current = project();
  openModal("Edit project", `<label class="field-label">Project name<input class="field" id="editProjectName" value="${esc(current.name)}"></label>
    <label class="field-label">Project goal<textarea class="text-input compact-input" id="editProjectGoal">${esc(current.summary?.goal ?? "")}</textarea></label>
    <label class="field-label">Description<textarea class="text-input compact-input" id="editProjectDescription" placeholder="What does this project contain?">${esc(current.description ?? "")}</textarea></label>`, "Save changes", async () => {
    const name = $("#editProjectName").value.trim();
    if (!name) throw new Error("Enter a project name");
    current.name = name;
    current.description = $("#editProjectDescription").value.trim();
    current.summary ??= {};
    current.summary.goal = $("#editProjectGoal").value.trim();
    current.updatedAt = new Date().toISOString();
    await persistState();
    render();
    toast("Project updated");
  });
}

function openSettingsModal() {
  let startRoute = "home";
  try { startRoute = localStorage.getItem("aipi:startRoute") || "home"; } catch {}
  openModal("Settings", `<p class="modal-intro">Choose how AIPI opens in this Codex panel. Project data and run evidence remain local.</p>
    <label class="field-label">Start screen<select class="field" id="startRouteSetting"><option value="home" ${startRoute === "home" ? "selected" : ""}>Home</option><option value="project" ${startRoute === "project" ? "selected" : ""}>Current project</option></select></label>
    <div class="settings-note"><span>Storage</span><strong>Local workspace + OS credential vault</strong></div>
    <div class="settings-note"><span>Current project</span><strong>${esc(project().name)}</strong></div>`, "Save settings", async () => {
    try { localStorage.setItem("aipi:startRoute", $("#startRouteSetting").value); } catch {}
    toast("Settings saved");
  });
}

function openUpgradeModal() {
  openModal("Upgrade AIPI", `<p class="modal-intro">The local developer workspace is active. Team workspaces, shared collections, and hosted run history are planned for the upgrade tier.</p>
    <div class="upgrade-card"><p class="eyebrow">Coming next</p><h3>Team workspace</h3><ul><li>Shared API collections and contracts</li><li>Collaborative environments with secret controls</li><li>Hosted run history and CI checks</li></ul></div>
    <p class="supporting-copy">Billing is not connected in this local build.</p>`, "Got it", async () => {});
}

function openCreateProjectModal() {
  openModal("Create project", `<p class="modal-intro">Create a local API workspace. You can connect more frontend, backend, database, test, or documentation folders afterward.</p>
    <label class="field-label">Project name<input class="field" id="newProjectName" autocomplete="off" placeholder="Billing service"></label>
    <label class="field-label">Project goal<textarea class="text-input compact-input" id="newProjectGoal" placeholder="Verify frontend, backend, and database API contracts."></textarea></label>
    <div class="two-column-fields"><label class="field-label">Environment<input class="field" id="newEnvironmentName" value="Development"></label><label class="field-label">Base URL<input class="field" id="newBaseUrl" value="http://localhost:3000" spellcheck="false"></label></div>
    <label class="field-label">Local workspace folder <span class="optional-label">Optional</span><input class="field" id="newWorkspacePath" placeholder="/absolute/path/to/project" spellcheck="false"></label>
    <p class="supporting-copy">The optional folder is scanned locally. AIPI stores derived route metadata, not source contents.</p>`, "Create project", async () => {
    const name = $("#newProjectName").value.trim();
    if (!name) throw new Error("Enter a project name");
    const workspacePath = $("#newWorkspacePath").value.trim();
    $("#modalConfirm").disabled = true;
    $("#modalConfirm").textContent = "Creating…";
    const created = await api("/api/projects", { method: "POST", body: JSON.stringify({
      name,
      goal: $("#newProjectGoal").value.trim(),
      environmentName: $("#newEnvironmentName").value.trim(),
      baseUrl: $("#newBaseUrl").value.trim(),
      workspacePath
    }) });
    state = await api("/api/state");
    selectProject(created.id);
    navigate("project");
    render();
    toast(workspacePath ? "Project created and source indexed" : "Project created");
  });
  queueMicrotask(() => $("#newProjectName")?.focus());
}

function newRequest() {
  const item = { id: uid("req"), name: "New request", method: "GET", url: "{{baseUrl}}/", params: [], headers: [], auth: { type: "none", token: "", username: "", password: "", key: "", value: "", placement: "header" }, body: { type: "json", content: "" }, certificates: { ca: "", clientCert: "", clientKey: "", rejectUnauthorized: true }, scripts: { pre: "", post: "" }, docs: "", assertions: [{ type: "status", equals: 200 }], retry: { enabled: false, attempts: 2, delayMs: 500, statuses: "408,425,429,500,502,503,504" } };
  project().requests.push(item);
  selectedRequestId = item.id;
  scheduleSave();
  navigate(`request/${item.id}`);
}

function createFromDiscovered(id) {
  const endpoint = project().sourceContext?.endpoints?.find((entry) => entry.id === id);
  if (!endpoint) return;
  const item = { id: uid("req"), name: `${endpoint.method} ${endpoint.path}`, method: endpoint.method, url: `{{baseUrl}}${endpoint.path}`, params: [], headers: [], auth: { type: "none" }, body: { type: "json", content: "" }, certificates: { ca: "", clientCert: "", clientKey: "", rejectUnauthorized: true }, scripts: { pre: "", post: "" }, docs: `Discovered from ${endpoint.source}:${endpoint.line}`, assertions: [{ type: "status", equals: 200 }], retry: { enabled: false, attempts: 2, delayMs: 500, statuses: "408,425,429,500,502,503,504" } };
  project().requests.push(item);
  selectedRequestId = item.id;
  scheduleSave();
  navigate(`request/${item.id}`);
}

async function runRequest(id = selectedRequestId) {
  const item = requestItem(id);
  if (!item) return;
  const button = $("#runRequestButton");
  if (button) { button.disabled = true; button.textContent = "Running locally…"; }
  try {
    clearTimeout(saveTimer);
    await persistState();
    const payload = await api("/api/send", { method: "POST", body: JSON.stringify({ projectId: project().id, request: item }) });
    state = await api("/api/state");
    navigate(`run/${payload.logId}`);
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.innerHTML = "Run request <span>⌘↵</span>"; }
  }
}

document.addEventListener("click", async (event) => {
  const codexAction = event.target.closest("[data-codex-action]");
  if (codexAction) { await sendToCodex(codexAction.dataset.codexAction); return; }
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) { navigate(routeButton.dataset.route); return; }
  const timelineFilterButton = event.target.closest("[data-timeline-filter]");
  if (timelineFilterButton) { timelineFilter = timelineFilterButton.dataset.timelineFilter; render(); return; }
  const requestButton = event.target.closest("[data-request-id]");
  if (requestButton) { selectedRequestId = requestButton.dataset.requestId; navigate(`request/${selectedRequestId}`); return; }
  const discovered = event.target.closest("[data-discovered-id]");
  if (discovered) { createFromDiscovered(discovered.dataset.discoveredId); return; }
  const log = event.target.closest("[data-log-id]");
  if (log) { navigate(`run/${log.dataset.logId}`); return; }
  const handoff = event.target.closest("[data-copy-handoff]");
  if (handoff) { await copyHandoff(state.history.find((entry) => entry.id === handoff.dataset.copyHandoff)); return; }
  const projectButton = event.target.closest("[data-select-project]");
  if (projectButton) { selectProject(projectButton.dataset.selectProject); navigate("project"); render(); return; }
  const environmentButton = event.target.closest("[data-select-environment]");
  if (environmentButton) { project().activeEnvironmentId = environmentButton.dataset.selectEnvironment; project().updatedAt = new Date().toISOString(); scheduleSave(); render(); toast("Environment selected"); return; }
  const integrationButton = event.target.closest("[data-integration-id]");
  if (integrationButton) {
    const source = project().sourceContext ?? {};
    const integration = (source.integrations ?? []).find((entry) => entry.id === integrationButton.dataset.integrationId);
    const endpoint = (source.endpoints ?? []).find((entry) => entry.id === integration?.endpointId);
    const call = (source.frontendCalls ?? []).find((entry) => entry.id === integration?.callId);
    openModal("Integration evidence", `<div class="evidence-stack"><p><strong>${esc(integration?.method)} ${esc(integration?.path)}</strong></p><p>Consumer: ${call ? `${esc(call.source)}:${call.line}` : "Not detected"}</p><p>Implementation: ${endpoint ? `${esc(endpoint.source)}:${endpoint.line}` : "Not detected"}</p><p>Status: ${esc(statusLabel(integration?.status))}</p><p>Confidence: ${Math.round((integration?.confidence ?? 0) * 100)}%</p></div>`, "Ask Codex", async () => { await sendToCodex("review-integrations"); });
    return;
  }
  if (event.target.closest("#scanSourceSecondary, #connectSourceEmpty")) { openSourceModal(); return; }
  if (event.target.closest("#manageVariablesButton")) { openVariablesModal(); return; }
  if (event.target.closest("#createEnvironmentButton")) { openCreateEnvironmentModal(); return; }
  if (event.target.closest("#editProjectButton, #editProjectSecondary")) { openEditProjectModal(); return; }
  if (event.target.closest("#settingsButton")) { openSettingsModal(); return; }
  if (event.target.closest("#upgradeButton")) { openUpgradeModal(); return; }
  if (event.target.closest("#createProjectButton, #createProjectPageButton")) { openCreateProjectModal(); return; }
  if (event.target.closest("#newRequestButton, #emptyNewRequest")) { newRequest(); return; }
  if (event.target.closest("#runRequestButton, #runRequestSecondary")) { await runRequest(); return; }
  const rerun = event.target.closest("[data-rerun-log]");
  if (rerun) { const entry = state.history.find((item) => item.id === rerun.dataset.rerunLog); await runRequest(entry?.requestId); return; }
  if (event.target.closest("[data-save-contract]")) { toast("Saved request is ready for reuse and regression-test generation"); return; }
  if (event.target.closest("[data-copy-response]")) { const logEntry = state.history.find((entry) => entry.id === route().id); const value = logEntry?.result?.body ?? JSON.stringify(logEntry?.result?.json ?? {}, null, 2); try { await navigator.clipboard.writeText(value); toast("Response copied"); } catch { toast("Copy is unavailable in this panel"); } return; }
  const add = event.target.closest("[data-kv-add]");
  if (add) { const kind = add.dataset.kvAdd; const target = kind === "environment" ? environment().variables : requestItem()[kind]; target.push({ key: "", value: "", enabled: true, secret: false }); if (kind === "environment" && $("#modal").open) $("#environmentVariables").innerHTML = keyRows(target, "environment"); else render(); scheduleSave(); return; }
  const remove = event.target.closest("[data-kv-remove]");
  if (remove) { const [kind, index] = remove.dataset.kvRemove.split(":"); const target = kind === "environment" ? environment().variables : requestItem()[kind]; target.splice(Number(index), 1); if (kind === "environment" && $("#modal").open) $("#environmentVariables").innerHTML = keyRows(target, "environment"); else render(); scheduleSave(); return; }
  const removeSource = event.target.closest("[data-remove-source]");
  if (removeSource) removeSource.closest(".source-root-row").remove();
  const removeTest = event.target.closest("[data-test-remove]");
  if (removeTest) { requestItem().assertions.splice(Number(removeTest.dataset.testRemove), 1); render(); scheduleSave(); }
  if (event.target.closest("#addAssertionButton")) { requestItem().assertions.push({ type: "status", equals: 200 }); render(); scheduleSave(); }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "projectSelect") { selectProject(event.target.value); render(); return; }
  if (event.target.id === "environmentSelect") { project().activeEnvironmentId = event.target.value; scheduleSave(); render(); return; }
  if (event.target.id === "apiEnvironmentSelect") { project().activeEnvironmentId = event.target.value; project().updatedAt = new Date().toISOString(); scheduleSave(); render(); toast("API environment changed"); return; }
  if (event.target.id === "apiFilter") { apiFilter = event.target.value; render(); return; }
  const item = requestItem();
  if (!item) return;
  if (event.target.id === "methodSelect") item.method = event.target.value;
  if (event.target.id === "authType") { item.auth.type = event.target.value; $("#authFields").innerHTML = renderAuthFields(item); }
  if (event.target.id === "bodyType") item.body.type = event.target.value;
  if (event.target.id === "retryEnabled") item.retry.enabled = event.target.checked;
  if (event.target.dataset.kvEnable) { const [kind, index] = event.target.dataset.kvEnable.split(":"); const target = kind === "environment" ? environment().variables : item[kind]; target[Number(index)].enabled = event.target.checked; }
  if (event.target.dataset.testType !== undefined) item.assertions[Number(event.target.dataset.testType)] = { type: event.target.value, ...(event.target.value === "status" ? { equals: 200 } : {}) };
  scheduleSave();
});

document.addEventListener("input", (event) => {
  const item = requestItem();
  if (event.target.id === "projectGoal") { project().summary.goal = event.target.value; scheduleSave(); return; }
  if (!item) return;
  if (event.target.id === "requestName") item.name = event.target.value;
  if (event.target.id === "urlInput") item.url = event.target.value;
  if (event.target.id === "bodyContent") item.body.content = event.target.value;
  if (event.target.id === "docsContent") item.docs = event.target.value;
  for (const [id, key] of [["authToken", "token"], ["authUsername", "username"], ["authPassword", "password"], ["authKey", "key"], ["authValue", "value"]]) if (event.target.id === id) item.auth[key] = event.target.value;
  if (event.target.dataset.kvKey || event.target.dataset.kvValue) { const [kind, index] = (event.target.dataset.kvKey ?? event.target.dataset.kvValue).split(":"); const target = kind === "environment" ? environment().variables : item[kind]; target[Number(index)][event.target.dataset.kvKey ? "key" : "value"] = event.target.value; }
  if (event.target.dataset.testTarget !== undefined) { const test = item.assertions[Number(event.target.dataset.testTarget)]; if (test.type === "header") test.name = event.target.value; else test.path = event.target.value; }
  if (event.target.dataset.testExpected !== undefined) { const test = item.assertions[Number(event.target.dataset.testExpected)]; const value = event.target.value; if (test.type === "response_time") test.less_than_ms = Number(value); else test.equals = /^\d+$/.test(value) ? Number(value) : value; }
  scheduleSave();
});

window.addEventListener("hashchange", render);
window.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && route().name === "request") { event.preventDefault(); runRequest(); } });

async function init() {
  await connectLocalCompanion();
  state = await api("/api/state");
  let rememberedProjectId;
  try { rememberedProjectId = localStorage.getItem("api-forge:selectedProject"); } catch {}
  selectedProjectId = state.projects.some((entry) => entry.id === rememberedProjectId) ? rememberedProjectId : state.projects.some((entry) => entry.id === state.activeProjectId) ? state.activeProjectId : state.projects[0]?.id;
  selectedRequestId = project()?.requests[0]?.id;
  if (!location.hash) {
    let startRoute = "home";
    try { startRoute = localStorage.getItem("aipi:startRoute") || "home"; } catch {}
    location.hash = `#/${startRoute}`;
  }
  render();
}

init().catch((error) => {
  const hasLocalTarget = new URLSearchParams(location.search).has("port");
  $("#app").innerHTML = `<div class="fatal-error"><h1>${hasLocalTarget ? "Local companion unavailable" : "Open AIPI from your project"}</h1><p>${hasLocalTarget ? "The dashboard could not reach the local companion. Start it again, then refresh this page." : "Run <code>npx aipi open</code> from your project root. AIPI will start the local companion, add a short-lived token, and open this dashboard securely."}</p><div class="action-row"><a class="primary-button" href="http://127.0.0.1:49152/?port=49152">Try local companion</a><a class="secondary-button" href="/install.html">Read installation guide</a></div><small>${esc(error.message)}</small></div>`;
});
