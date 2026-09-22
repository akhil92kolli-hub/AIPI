const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

let state;
let selectedProjectId;
let selectedRequestId;
let apiFilter = "all";
let saveTimer;
let bridgeRequestId = 1;
const bridgeRequests = new Map();

function apiOrigin() {
  return window.__API_FORGE_ORIGIN__ ?? "";
}

async function api(path, options = {}) {
  const response = await fetch(`${apiOrigin()}${path}`, { headers: { "content-type": "application/json", ...(options.headers ?? {}) }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
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

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await api("/api/state", { method: "PUT", body: JSON.stringify(state) }); }
    catch (error) { toast(`Save failed: ${error.message}`); }
  }, 320);
}

function route() {
  const value = location.hash.replace(/^#\/?/, "");
  const [name = "project", id] = value.split("/");
  return { name: name || "project", id };
}

function navigate(target) {
  const next = target.startsWith("#") ? target : `#/${target.replace(/^\//, "")}`;
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

function codexContext(action = "contextual") {
  const current = project();
  const source = current.sourceContext ?? {};
  const currentRoute = route();
  const currentEnvironment = environment();
  const log = currentRoute.name === "run" ? state.history.find((entry) => entry.id === currentRoute.id) : null;
  const request = currentRoute.name === "request" ? requestItem(currentRoute.id) : log ? requestItem(log.requestId) : null;
  const runs = state.history.filter((entry) => entry.projectId === current.id);
  const instruction = ({
    "review-project": "Review the project setup, source coverage, environment readiness, and integration findings. Recommend the next highest-value action.",
    "test-apis": "Review the API inventory, identify the most important unverified integrations, and propose a safe test plan before running anything state-changing.",
    "review-integrations": "Review the frontend-to-backend integration map, prioritize mismatches using source evidence and confidence, and propose the smallest verification plan.",
    "review-runs": "Review recent API runs, group failures by likely cause, and recommend the smallest next checks.",
    "diagnose-run": "Diagnose this run from its saved evidence. Explain the first failing layer and propose a fix plan before changing code or retrying a state-changing request.",
    "plan-project": "Turn the current project evidence into a concise plan-build-test workflow, including frontend/backend/schema gaps and the next implementation tasks.",
    contextual: "Review the current API Forge screen and continue the most useful project, test, diagnosis, or implementation task in Codex chat."
  })[action] ?? "Review this API Forge context and continue the work in Codex chat.";
  const context = {
    project: { id: current.id, name: current.name, goal: current.summary?.goal ?? "" },
    screen: currentRoute.name,
    environment: { id: currentEnvironment?.id, name: currentEnvironment?.name, variableKeys: (currentEnvironment?.variables ?? []).map((entry) => entry.key).filter(Boolean) },
    source: {
      roots: (source.roots ?? []).map((entry) => ({ kind: entry.kind, path: entry.path })),
      lastScannedAt: source.lastScannedAt ?? null,
      filesScanned: source.filesScanned ?? 0,
      frameworks: source.frameworks ?? [],
      inventory: { endpoints: source.endpoints?.length ?? 0, frontendCalls: source.frontendCalls?.length ?? 0, schemas: source.schemas?.length ?? 0, integrations: source.integrations?.length ?? 0 },
      findings: (source.findings ?? []).slice(0, 12).map((entry) => ({ id: entry.id, severity: entry.severity, type: entry.type, title: entry.title }))
    },
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
  return `Continue this API Forge task in Codex chat.\n\n${instruction}\n\nUse the API Forge MCP tools with the IDs below to read authoritative local state and evidence. Do not ask me to restate information already saved in API Forge. Do not expose credentials or secret environment values. Do not retry POST, PUT, PATCH, or DELETE without my authorization.\n\nContext:\n${JSON.stringify(context, null, 2)}`;
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
      await window.openai.sendFollowUpMessage({ prompt, title: "Continue with API Forge" });
      toast("Context sent to Codex chat");
      return;
    }
    if (window.parent !== window) {
      await bridgeRequest("ui/message", { role: "user", content: [{ type: "text", text: prompt }] });
      toast("Context sent to Codex chat");
      return;
    }
  } catch (error) {
    console.warn("API Forge could not reach the Codex chat bridge", error);
  }
  await copyCodexContext(prompt);
}

function shell(content, currentRoute) {
  const current = project();
  const activeRoot = ["request"].includes(currentRoute.name) ? "apis" : ["run"].includes(currentRoute.name) ? "runs" : currentRoute.name;
  return `
    <div class="app-shell">
      <header class="app-bar">
        <button class="brand-button" data-route="project" aria-label="Open project overview"><span>API</span> Forge</button>
        <div class="context-controls">
          <div class="project-control"><label class="sr-only" for="projectSelect">Project</label>
          <select id="projectSelect" class="context-select">${state.projects.map((entry) => `<option value="${entry.id}" ${entry.id === current.id ? "selected" : ""}>${esc(entry.name)}</option>`).join("")}</select>
          <button class="add-project-button" id="createProjectButton" aria-label="Create project" title="Create project">+</button></div>
          <label class="sr-only" for="environmentSelect">Environment</label>
          <select id="environmentSelect" class="context-select environment-select">${current.environments.map((entry) => `<option value="${entry.id}" ${entry.id === current.activeEnvironmentId ? "selected" : ""}>${esc(entry.name)}</option>`).join("")}</select>
        </div>
      </header>
      <main class="route-view" data-route-name="${esc(currentRoute.name)}">${content}</main>
      <button class="chat-launcher" data-codex-action="contextual" aria-label="Send this screen's context to Codex chat"><span>✦</span> Ask Codex</button>
      <nav class="bottom-nav" aria-label="Primary navigation">
        ${[["project", "Project"], ["apis", "APIs"], ["map", "Map"], ["runs", "Runs"], ["summary", "Summary"]].map(([target, label]) => `<button class="nav-item ${activeRoot === target ? "active" : ""}" data-route="${target}" ${activeRoot === target ? 'aria-current="page"' : ""}><span>${label}</span></button>`).join("")}
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
  if (currentRoute.name === "project") content = renderProject();
  else if (currentRoute.name === "apis") content = renderApis();
  else if (currentRoute.name === "request") content = renderRequest(currentRoute.id);
  else if (currentRoute.name === "map") content = renderIntegrationMap();
  else if (currentRoute.name === "runs") content = renderRuns();
  else if (currentRoute.name === "run") content = renderRun(currentRoute.id);
  else if (currentRoute.name === "summary") content = renderSummary();
  else content = renderProject();
  $("#app").className = "";
  $("#app").innerHTML = shell(content, currentRoute);
}

function renderProject() {
  const current = project();
  const source = current.sourceContext ?? {};
  const healthy = (source.integrations ?? []).filter((entry) => entry.status === "healthy").length;
  const findings = source.findings ?? [];
  const runs = state.history.filter((entry) => entry.projectId === current.id);
  return `
    <section class="page-heading">
      <div><p class="eyebrow">Local project</p><h1>${esc(current.name)}</h1><p>${esc(current.summary?.goal || "Connect source, discover APIs, and verify every integration.")}</p></div>
      <button class="primary-button" data-codex-action="review-project">Review setup</button>
    </section>

    <section class="project-picker section-block">
      <div class="section-heading"><div><p class="eyebrow">Workspace</p><h2>${state.projects.length} project${state.projects.length === 1 ? "" : "s"}</h2></div><button class="secondary-button" id="createProjectPageButton">New project</button></div>
      <div class="project-list">${state.projects.map((entry) => {
        const active = entry.id === current.id;
        const lastScan = entry.sourceContext?.lastScannedAt;
        return `<button class="project-row ${active ? "active" : ""}" data-select-project="${entry.id}" ${active ? 'aria-current="true"' : ""}><span class="project-avatar">${esc(entry.name.slice(0, 1).toUpperCase())}</span><span><strong>${esc(entry.name)}</strong><small>${entry.requests.length} request${entry.requests.length === 1 ? "" : "s"} · ${lastScan ? `scanned ${formatDate(lastScan)}` : "not scanned"}</small></span><b>${active ? "Current" : "Open"}</b></button>`;
      }).join("")}</div>
    </section>

    <section class="health-strip" aria-label="Project API health">
      <button data-route="apis"><strong>${source.endpoints?.length ?? 0}</strong><span>Backend APIs</span></button>
      <button data-route="apis"><strong>${source.frontendCalls?.length ?? 0}</strong><span>Frontend calls</span></button>
      <button data-route="map"><strong>${healthy}</strong><span>Matched</span></button>
      <button data-route="runs"><strong>${runs.length}</strong><span>Local runs</span></button>
    </section>

    <section class="section-block">
      <div class="section-heading"><div><p class="eyebrow">Source context</p><h2>${source.lastScannedAt ? `${source.filesScanned} files indexed` : "Connect your codebase"}</h2></div><button class="quiet-button" id="scanSourceSecondary">Edit</button></div>
      ${source.roots?.length ? `<div class="source-list">${source.roots.map((entry) => `<div class="source-row"><div><strong>${esc(entry.kind)}</strong><span>${esc(entry.path)}</span></div><span class="status-text success">Included</span></div>`).join("")}</div>` : `<div class="empty-message"><h3>Give Codex the missing context</h3><p>Add frontend, backend, schema, tests, or a local Git clone. API Forge scans locally and stores only derived metadata.</p><button class="secondary-button" id="connectSourceEmpty">Choose folders</button></div>`}
      ${source.frameworks?.length ? `<div class="tag-row">${source.frameworks.map((entry) => `<span class="tag">${esc(entry)}</span>`).join("")}</div>` : ""}
      <p class="supporting-copy">${source.lastScannedAt ? `Last scanned ${formatDate(source.lastScannedAt)}.` : "Remote Git cloning is staged for a later release; use an existing local clone today."}</p>
    </section>

    <section class="section-block">
      <div class="section-heading"><div><p class="eyebrow">Environment</p><h2>${esc(environment()?.name ?? "Development")}</h2></div><button class="quiet-button" id="manageVariablesButton">Manage</button></div>
      <div class="variable-summary">${(environment()?.variables ?? []).slice(0, 4).map((entry) => `<div><span>${esc(entry.key)}</span><strong>${entry.secret ? "Secret set" : esc(entry.value || "Not set")}</strong></div>`).join("") || `<p>No environment variables configured.</p>`}</div>
    </section>

    <section class="section-block">
      <div class="section-heading"><div><p class="eyebrow">Needs attention</p><h2>${findings.length ? `${findings.length} integration finding${findings.length === 1 ? "" : "s"}` : "Everything found is aligned"}</h2></div><button class="quiet-button" data-route="apis">View APIs</button></div>
      ${findings.length ? `<div class="finding-list">${findings.slice(0, 4).map((entry) => `<button data-route="apis"><span class="status-mark ${statusClass(entry.type)}">${entry.severity === "high" ? "High" : "Check"}</span><span>${esc(entry.title)}</span></button>`).join("")}</div>` : `<p class="supporting-copy">Scan source and run discovered APIs to build verified integration health.</p>`}
    </section>`;
}

function endpointRows() {
  const current = project();
  const discovered = current.sourceContext?.endpoints ?? [];
  const rows = current.requests.map((entry) => ({ kind: "request", id: entry.id, method: entry.method, path: entry.url, name: entry.name, status: state.history.some((log) => log.projectId === current.id && log.requestId === entry.id && log.result?.ok) ? "healthy" : "untested", source: "Saved request" }));
  const known = new Set(rows.map((entry) => `${entry.method}:${entry.path}`));
  for (const endpoint of discovered) {
    if (!known.has(`${endpoint.method}:{{baseUrl}}${endpoint.path}`) && !known.has(`${endpoint.method}:${endpoint.path}`)) rows.push({ kind: "discovered", id: endpoint.id, method: endpoint.method, path: endpoint.path, name: endpoint.path, status: "untested", source: endpoint.source, endpoint });
  }
  return rows;
}

function renderApis() {
  const integrations = project().sourceContext?.integrations ?? [];
  let rows = endpointRows();
  if (apiFilter !== "all") rows = rows.filter((entry) => entry.status === apiFilter || integrations.some((integration) => integration.method === entry.method && integration.path === entry.path && integration.status === apiFilter));
  return `
    <section class="page-heading compact-heading"><div><p class="eyebrow">API inventory</p><h1>Requests</h1><p>Inspect discovered routes here, then plan and run tests with Codex.</p></div><button class="primary-button" data-codex-action="test-apis">Test with Codex</button></section>
    <section class="filter-bar"><label><span class="sr-only">Filter APIs</span><select id="apiFilter">${[["all", "All APIs"], ["healthy", "Matched"], ["untested", "Untested"], ["missing-backend", "Missing backend"], ["unused-backend", "No consumer"]].map(([value, label]) => `<option value="${value}" ${apiFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><span>${rows.length} shown</span></section>
    <section class="api-list">${rows.length ? rows.map((entry) => `<button class="api-row" ${entry.kind === "request" ? `data-request-id="${entry.id}"` : `data-discovered-id="${entry.id}"`}><div class="api-row-main">${methodBadge(entry.method)}<div><strong>${esc(entry.name)}</strong><span>${esc(entry.path)}</span></div></div><div class="api-row-meta"><span>${esc(entry.source)}</span><span class="status-text ${statusClass(entry.status)}">${statusLabel(entry.status)}</span></div></button>`).join("") : `<div class="empty-message"><h3>No APIs in this view</h3><p>Connect source code or create a request manually.</p><button class="secondary-button" id="emptyNewRequest">Create request</button></div>`}</section>`;
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
  return `
    <section class="request-route-head"><button class="back-button" data-route="apis">Back to APIs</button><div><p class="eyebrow">Request</p><input id="requestName" class="title-input" value="${esc(item.name)}" aria-label="Request name"></div></section>
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
    </section>`;
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

function renderRuns() {
  const logs = state.history.filter((entry) => entry.projectId === project().id);
  return `<section class="page-heading compact-heading"><div><p class="eyebrow">Local evidence</p><h1>Runs</h1><p>Every attempt stays on this machine with its response, assertions, and diagnosis.</p></div><button class="primary-button" data-codex-action="review-runs">Review with Codex</button></section><section class="run-list">${logs.length ? logs.map((entry) => `<button class="run-row" data-log-id="${entry.id}"><div>${methodBadge(entry.method)}<div><strong>${esc(entry.requestName)}</strong><span>${esc(entry.url)}</span></div></div><div><span class="status-text ${entry.result?.ok ? "success" : "danger"}">${entry.result?.status ?? "Error"}</span><span>${formatDate(entry.createdAt)}</span></div></button>`).join("") : `<div class="empty-message"><h3>No local runs yet</h3><p>Ask Codex to choose and run a safe first test, or open APIs to compose one manually.</p><button class="secondary-button" data-codex-action="test-apis">Plan first test</button></div>`}</section>`;
}

function renderRun(id) {
  const log = state.history.find((entry) => entry.id === id);
  if (!log) return `<div class="empty-message"><h2>Run not found</h2><button class="secondary-button" data-route="runs">Back to runs</button></div>`;
  const result = log.result ?? {};
  const success = Boolean(result.ok && result.passed !== false);
  const body = result.json ? JSON.stringify(result.json, null, 2) : result.body ?? result.error ?? "No response body";
  return `
    <section class="request-route-head"><button class="back-button" data-route="runs">Back to runs</button><div><p class="eyebrow">Run evidence</p><h1>${esc(log.requestName)}</h1></div></section>
    <section class="run-hero ${success ? "success-surface" : "failure-surface"}"><div><p class="eyebrow">${success ? "Run completed" : "Run needs attention"}</p><h2>${methodBadge(log.method)} ${esc(result.request?.url ?? log.url)}</h2><p>${result.status ? `HTTP ${result.status}` : "Network error"} · ${result.elapsed_ms ?? 0} ms · ${formatDate(log.createdAt)}</p></div><button class="secondary-button" data-rerun-log="${log.id}">Run again</button></section>
    <section class="timeline" aria-label="Run timeline">
      <div class="timeline-step"><span class="step-label">1</span><div><h3>Connected</h3><p>${result.error ? esc(result.error) : `Reached ${esc(hostFor(result.request?.url ?? log.url))}`}</p></div><span>${Math.max(1, Math.round((result.elapsed_ms ?? 0) * .2))} ms</span></div>
      <div class="timeline-step"><span class="step-label">2</span><div><h3 class="${success ? "success-text" : "danger-text"}">${result.status ? `${result.status} ${result.status_text ?? ""}` : "Request failed"}</h3><p>${result.truncated ? "Response captured with truncation" : "Response captured locally"}</p></div><span>${result.elapsed_ms ?? 0} ms</span></div>
      <div class="timeline-step"><span class="step-label">3</span><div><h3>${result.assertions?.filter((entry) => entry.passed).length ?? 0} of ${result.assertions?.length ?? 0} assertions passed</h3><div class="check-list">${result.assertions?.length ? result.assertions.map((entry) => `<p class="${entry.passed ? "success-text" : "danger-text"}">${entry.passed ? "Passed" : "Failed"}: ${esc(entry.type)}</p>`).join("") : `<p>No assertions configured</p>`}</div></div></div>
      <div class="timeline-step response-step"><span class="step-label">4</span><div><div class="inline-heading"><h3>Response preview</h3><button class="quiet-button" data-copy-response>Copy</button></div><pre>${esc(body)}</pre></div></div>
    </section>
    <section class="codex-summary"><p class="eyebrow">Codex-ready evidence</p><h2>${esc(result.diagnosis?.category ?? (success ? "Request completed" : "Request failed"))}</h2><p>${esc(result.diagnosis?.summary ?? (success ? "The endpoint returned successfully. Add assertions to turn this run into a reusable contract." : "Review the response evidence and relevant source context before changing code."))}</p>${result.diagnosis?.suggestions?.length ? `<ul>${result.diagnosis.suggestions.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul>` : ""}<div class="action-row"><button class="primary-button" data-codex-action="diagnose-run">Ask Codex to continue</button><button class="secondary-button" data-save-contract="${log.requestId}">Save as contract</button></div></section>`;
}

function renderSummary() {
  const current = project();
  const source = current.sourceContext ?? {};
  const tasks = current.summary?.tasks ?? [];
  return `
    <section class="page-heading compact-heading"><div><p class="eyebrow">Project intelligence</p><h1>Summary</h1><p>Living context for Codex, documentation, and implementation status.</p></div><button class="primary-button" data-codex-action="plan-project">Plan with Codex</button></section>
    <section class="section-block"><p class="eyebrow">Project goal</p><textarea id="projectGoal" class="goal-input">${esc(current.summary?.goal ?? "")}</textarea></section>
    <section class="section-block"><div class="section-heading"><div><p class="eyebrow">Detected architecture</p><h2>${source.frameworks?.length ? source.frameworks.join(", ") : "Scan source to detect libraries"}</h2></div></div><div class="summary-grid"><div><strong>${source.endpoints?.length ?? 0}</strong><span>Backend endpoints</span></div><div><strong>${source.frontendCalls?.length ?? 0}</strong><span>Frontend calls</span></div><div><strong>${source.schemas?.length ?? 0}</strong><span>Database objects</span></div><div><strong>${source.integrations?.filter((entry) => entry.status === "healthy").length ?? 0}</strong><span>Verified matches</span></div></div></section>
    <section class="section-block"><div class="section-heading"><div><p class="eyebrow">Implementation status</p><h2>Plan, build, test</h2></div></div><div class="task-list">${tasks.length ? tasks.map((entry) => `<div><span class="task-status">${esc(entry.status)}</span><strong>${esc(entry.title)}</strong></div>`).join("") : `<p class="supporting-copy">Connect source to generate API-specific tasks and iteration history.</p>`}</div></section>
    <section class="section-block"><div class="section-heading"><div><p class="eyebrow">Recent iterations</p><h2>${current.summary?.iterations?.length ?? 0} recorded</h2></div></div><div class="iteration-list">${(current.summary?.iterations ?? []).slice().reverse().map((entry) => `<div><strong>${esc(entry.label)}</strong><span>${formatDate(entry.at)}</span></div>`).join("") || `<p class="supporting-copy">Scans, verified runs, and code corrections will appear here.</p>`}</div></section>`;
}

function openModal(title, body, confirmLabel, onConfirm) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = body;
  $("#modalConfirm").textContent = confirmLabel;
  $("#modalConfirm").onclick = async (event) => {
    event.preventDefault();
    try { await onConfirm(); $("#modal").close(); }
    catch (error) { toast(error.message); }
  };
  $("#modal").showModal();
}

function openSourceModal() {
  const roots = project().sourceContext?.roots?.length ? project().sourceContext.roots : [{ kind: "workspace", path: "" }];
  openModal("Connect source context", `<p class="modal-intro">Add local folders or an existing local Git clone. API Forge scans source locally; secret values and file contents are not copied into project metadata.</p><div id="sourceRootList">${roots.map(sourceRootRow).join("")}</div><button type="button" class="quiet-button" id="addSourceRoot">Add another folder</button><p class="supporting-copy">Remote Git cloning will arrive later. Paste the path to a local clone for now.</p>`, "Scan source", async () => {
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
  openModal("Environment variables", `<label class="field-label">Environment name<input class="field" id="environmentName" value="${esc(env.name)}"></label><div id="environmentVariables">${keyRows(env.variables ?? [], "environment")}</div><p class="supporting-copy">Secrets are masked in reports. Remove credentials before sharing plugin data.</p>`, "Save variables", async () => {
    env.name = $("#environmentName").value.trim() || env.name;
    await api("/api/state", { method: "PUT", body: JSON.stringify(state) });
    render();
  });
}

function openCreateProjectModal() {
  openModal("Create project", `<p class="modal-intro">Create a local API workspace. You can connect more frontend, backend, database, test, or documentation folders afterward.</p>
    <label class="field-label">Project name<input class="field" id="newProjectName" autocomplete="off" placeholder="Billing service"></label>
    <label class="field-label">Project goal<textarea class="text-input compact-input" id="newProjectGoal" placeholder="Verify frontend, backend, and database API contracts."></textarea></label>
    <div class="two-column-fields"><label class="field-label">Environment<input class="field" id="newEnvironmentName" value="Development"></label><label class="field-label">Base URL<input class="field" id="newBaseUrl" value="http://localhost:3000" spellcheck="false"></label></div>
    <label class="field-label">Local workspace folder <span class="optional-label">Optional</span><input class="field" id="newWorkspacePath" placeholder="/absolute/path/to/project" spellcheck="false"></label>
    <p class="supporting-copy">The optional folder is scanned locally. API Forge stores derived route metadata, not source contents.</p>`, "Create project", async () => {
    const name = $("#newProjectName").value.trim();
    if (!name) throw new Error("Enter a project name");
    const workspacePath = $("#newWorkspacePath").value.trim();
    $("#modalConfirm").disabled = true;
    $("#modalConfirm").textContent = "Creating…";
    const created = await api("/api/projects", { method: "POST", body: JSON.stringify({
      name,
      goal: $("#newProjectGoal").value.trim(),
      environmentName: $("#newEnvironmentName").value.trim(),
      baseUrl: $("#newBaseUrl").value.trim()
    }) });
    if (workspacePath) await api("/api/scan", { method: "POST", body: JSON.stringify({ projectId: created.id, roots: [{ kind: "workspace", path: workspacePath }] }) });
    state = await api("/api/state");
    selectedProjectId = created.id;
    selectedRequestId = project()?.requests[0]?.id;
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
    await api("/api/state", { method: "PUT", body: JSON.stringify(state) });
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
  const requestButton = event.target.closest("[data-request-id]");
  if (requestButton) { selectedRequestId = requestButton.dataset.requestId; navigate(`request/${selectedRequestId}`); return; }
  const discovered = event.target.closest("[data-discovered-id]");
  if (discovered) { createFromDiscovered(discovered.dataset.discoveredId); return; }
  const log = event.target.closest("[data-log-id]");
  if (log) { navigate(`run/${log.dataset.logId}`); return; }
  const projectButton = event.target.closest("[data-select-project]");
  if (projectButton) { selectedProjectId = projectButton.dataset.selectProject; selectedRequestId = project()?.requests[0]?.id; navigate("project"); render(); return; }
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
  if (event.target.closest("#createProjectButton, #createProjectPageButton")) { openCreateProjectModal(); return; }
  if (event.target.closest("#newRequestButton, #emptyNewRequest")) { newRequest(); return; }
  if (event.target.closest("#runRequestButton")) { await runRequest(); return; }
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
  if (event.target.id === "projectSelect") { selectedProjectId = event.target.value; selectedRequestId = project()?.requests[0]?.id; render(); return; }
  if (event.target.id === "environmentSelect") { project().activeEnvironmentId = event.target.value; scheduleSave(); render(); return; }
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
  state = await api("/api/state");
  selectedProjectId = state.projects[0]?.id;
  selectedRequestId = project()?.requests[0]?.id;
  if (!location.hash) location.hash = "#/project";
  render();
}

init().catch((error) => { $("#app").innerHTML = `<div class="fatal-error"><h1>API Forge could not start</h1><pre>${esc(error.stack)}</pre></div>`; });
