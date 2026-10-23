(() => {
  const vscode = acquireVsCodeApi();
  const CHANNEL = 'aipi.ide.v1';
  const pending = new Map();
  let requestId = 0;
  let snapshot = null;
  let activeTab = vscode.getState()?.activeTab || 'overview';
  let selectedTaskId = vscode.getState()?.selectedTaskId || null;
  let taskFilter = vscode.getState()?.taskFilter || 'proposed';
  let taskScreen = 'list';
  let milestoneEditingId = null;
  let mcpResult = null;
  let mcpBusy = false;
  let selectedContractId = null;
  let taskSearchTimer;
  let taskSearchResult = null;
  let selectedSourceRefs = [];
  let taskTextFilter = '';
  let busy = '';
  let agentText = '';
  let agentStatus = '';
  let currentStreamId = null;
  let refreshTimer;

  const app = document.getElementById('app');
  const toastNode = document.getElementById('toast');
  const logoUri = document.body.dataset.logo;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const request = (action, payload = {}, timeout = 125000) => new Promise((resolve, reject) => {
    const id = `webview-${++requestId}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`AIPI ${action} timed out.`)); }, timeout);
    pending.set(id, {resolve, reject, timer});
    vscode.postMessage({channel:CHANNEL, type:'request', id, action, payload});
  });
  function persist() { vscode.setState({activeTab, selectedTaskId, taskFilter}); }
  function toast(message) { toastNode.textContent = message; toastNode.hidden = false; clearTimeout(toastNode._timer); toastNode._timer = setTimeout(() => { toastNode.hidden = true; }, 3800); }
  function formatDate(value) { if (!value) return 'Not indexed'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Not indexed' : new Intl.RelativeTimeFormat(undefined, {numeric:'auto'}).format(Math.round((date - Date.now()) / 3600000), 'hour'); }
  function statusLabel(status) { return String(status || 'unknown').replaceAll('-', ' '); }
  function selectedTask() { return snapshot?.tasks?.find((entry) => entry.id === selectedTaskId) ?? null; }
  function icon(name) {
    const icons = {overview:'⌂', tasks:'✓', kmaps:'⌘', context:'◎', agent:'✦', refresh:'↻', wide:'↗', dashboard:'◫'};
    return `<span aria-hidden="true">${icons[name] || '•'}</span>`;
  }

  function shell(content) {
    const health = snapshot.health;
    return `<div class="panel-shell">
      <header class="topbar">
        <div class="brand"><img src="${esc(logoUri)}" alt=""><span><strong>${esc(snapshot.project.name)}</strong><small title="${esc(snapshot.project.root)}">${esc(snapshot.project.environment)} · local</small></span></div>
        <div class="header-actions"><button data-action="refresh" title="Refresh" aria-label="Refresh">${icon('refresh')}</button><button data-action="wide" title="Open as editor" aria-label="Open as editor">${icon('wide')}</button></div>
      </header>
      <div class="connection-strip ${health.status}"><span class="dot"></span><span>${health.status === 'ready' ? 'Workspace indexed' : health.status === 'attention' ? `${health.findings} findings need attention` : 'Index refresh recommended'}</span><time>${esc(formatDate(health.lastScannedAt))}</time></div>
      <main class="content" tabindex="-1">${content}</main>
      <nav class="tabs" aria-label="AIPI sections">${[['overview','Home'],['tasks','Tasks'],['kmaps','K Maps'],['settings','Settings'],['mcp','MCP'],['index','Index']].map(([id,label]) => `<button data-tab="${id}" class="${activeTab === id || (['context','agent'].includes(activeTab) && id === 'tasks') ? 'active' : ''}" aria-current="${activeTab === id ? 'page' : 'false'}"><span aria-hidden="true">${({overview:'⌂',tasks:'✓',kmaps:'◇',settings:'⚙',mcp:'⌘',index:'⌕'})[id]}</span><span>${label}</span>${id === 'tasks' && snapshot.taskCounts.proposed ? `<b>${snapshot.taskCounts.proposed}</b>` : ''}</button>`).join('')}</nav>
    </div>`;
  }

  function overview() {
    const editor = snapshot.editor;
    const next = snapshot.tasks.find((entry) => entry.status === 'in-progress') || snapshot.tasks.find((entry) => entry.status !== 'done');
    return `<section class="page-heading"><p class="eyebrow">Current IDE workspace</p><h1>${esc(snapshot.project.name)}</h1><p>AIPI keeps source evidence, task context and verification local to this window.</p></section>
      <section class="metrics" aria-label="Workspace health">
        <article><strong>${snapshot.health.contracts}</strong><span>Contracts</span><small>${snapshot.health.verifiedContracts} verified</small></article>
        <article><strong>${snapshot.health.findings}</strong><span>Findings</span><small>${snapshot.health.files} files indexed</small></article>
      </section>
      <section class="card editor-card"><div class="section-title"><span>Active editor</span>${editor ? `<button data-open-source="${esc(editor.path)}" data-line="${editor.line}">Open</button>` : ''}</div>${editor ? `<strong>${esc(editor.path)}</strong><small>${esc(editor.language || 'text')} · line ${editor.line}${editor.selection ? ` · ${editor.selection.length} selected characters` : ''}</small>${editor.diagnostics?.length ? `<p class="warning-copy">${editor.diagnostics.length} visible diagnostic${editor.diagnostics.length === 1 ? '' : 's'}</p>` : ''}` : '<p>No file from this workspace is active.</p>'}</section>
      <section class="card focus-card"><div class="section-title"><span>Next best action</span><i>${next ? esc(statusLabel(next.priority)) : 'clear'}</i></div>${next ? `<h2>${esc(next.title)}</h2><p>${esc(next.description || 'Prepare its bounded context and continue with the IDE agent.')}</p><button class="primary" data-select-task="${esc(next.id)}" data-go="context">Review context</button>` : '<h2>No open task</h2><p>Reindex the workspace to discover new contract and integration work.</p><button class="primary" data-action="reindex">Reindex workspace</button>'}</section>
      <div class="secondary-actions"><button data-action="reindex">Reindex</button><button data-action="dashboard">Full dashboard</button></div>`;
  }

  function tasks() {
    const counts = snapshot.taskCounts;
    const filters = [['all',snapshot.tasks.length],['active',counts.active],['completed',counts.completed],['failed',counts.failed],['proposed',counts.proposed]];
    const visible = snapshot.tasks.filter((task) => taskFilter === 'all'
      || (taskFilter === 'proposed' && task.status === 'proposed')
      || (taskFilter === 'active' && !['proposed','done','completed','failed','dismissed'].includes(task.status))
      || (taskFilter === 'completed' && ['done','completed'].includes(task.status))
      || (taskFilter === 'failed' && task.status === 'failed'))
      .filter((task) => !taskTextFilter || `${task.title} ${task.description}`.toLowerCase().includes(taskTextFilter.toLowerCase()));
    if (taskScreen === 'create' || taskScreen === 'edit') return taskForm();
    if (taskScreen === 'milestone') return milestoneForm();
    if (taskScreen === 'detail') return taskDetail();
    return `<section class="page-heading compact"><p class="eyebrow">Tasks & milestones</p><h1>Workspace tasks</h1><p>Manage milestone delivery and task evidence for this project.</p></section>
      <div class="secondary-actions"><button data-action="newTask">New task</button><button data-action="newMilestone">New milestone</button></div>
      <section class="compact-list"><h2>Milestones <small>${snapshot.milestones?.length ?? 0}</small></h2>${snapshot.milestones?.length ? snapshot.milestones.map((milestone) => {
        const linked = snapshot.taskRecords.filter((task) => task.milestoneIds.includes(milestone.id));
        const done = linked.filter((task) => ['done','completed'].includes(task.status)).length;
        return `<article class="compact-row"><button class="row-main" data-milestone-edit="${esc(milestone.id)}"><strong>${esc(milestone.title)}</strong><small>${done}/${linked.length} complete · ${esc(milestone.targetDate || 'No target date')}</small></button><button class="icon-action" title="Edit milestone" data-milestone-edit="${esc(milestone.id)}">Edit</button></article>`;
      }).join('') : '<p class="empty-inline">No milestones yet. Create one to group delivery work.</p>'}</section>
      <div class="segmented" role="group" aria-label="Task filter">${filters.map(([id,count]) => `<button data-filter="${id}" class="${taskFilter === id ? 'active' : ''}">${id[0].toUpperCase()+id.slice(1)} <b>${count}</b></button>`).join('')}</div>
      <label class="form-label task-search-label">Search tasks<input class="form-control" id="taskSearch" value="${esc(taskTextFilter)}" placeholder="Title or objective"></label>
      <section class="task-list">${visible.length ? visible.map((task) => {
        const record = snapshot.taskRecords.find((entry) => entry.id === task.id);
        const milestone = snapshot.milestones.find((entry) => record?.milestoneIds.includes(entry.id));
        return `<button class="task ${task.id === selectedTaskId ? 'selected' : ''}" data-select-task="${esc(task.id)}" data-go="tasks"><span class="task-top"><i class="priority ${esc(task.priority)}"></i><strong>${esc(task.title)}</strong><em>${esc(statusLabel(task.status))}</em></span><span>${esc(task.description || 'No description')}</span><small>${milestone ? `${esc(milestone.title)} · ` : 'No milestone · '}${task.artifactCount} artifacts · ${task.verification}</small></button>`;
      }).join('') : `<div class="empty"><strong>No ${esc(taskFilter)} tasks</strong><p>Change the filter or create a task.</p><button class="secondary" data-action="newTask">Create task</button></div>`}</section>
      ${snapshot.archivedTasks.length ? `<details class="compact-list" ${showArchivedTasks ? 'open' : ''}><summary>Archived tasks (${snapshot.archivedTasks.length})</summary>${snapshot.archivedTasks.map((task) => `<article class="compact-row"><div class="row-main"><strong>${esc(task.title)}</strong><small>${esc(statusLabel(task.status))} · archived ${esc(formatDate(task.archivedAt))}</small></div></article>`).join('')}</details>` : ''}`;
  }

  function taskDetail() {
    const task = snapshot.taskRecords.find((entry) => entry.id === selectedTaskId);
    if (!task) return '<div class="empty"><strong>Select a task</strong><p>Choose a task from the workspace list.</p></div>';
    const milestone = snapshot.milestones.find((entry) => task.milestoneIds.includes(entry.id));
    const linkedContracts = snapshot.contracts.filter((entry) => task.contractIds.includes(entry.id));
    return `<section class="page-heading compact"><button class="link-action" data-action="taskList">← All tasks</button><p class="eyebrow">${esc(statusLabel(task.priority))} priority · ${esc(statusLabel(task.status))}</p><h1>${esc(task.title)}</h1><p>${esc(task.description)}</p></section>
      <section class="card"><div class="section-title"><span>Delivery</span><button data-action="editTask">Edit</button></div><small>Milestone</small><strong class="detail-value">${esc(milestone?.title ?? 'No milestone')}</strong><small>Intent · ${esc(statusLabel(task.intent))}</small><small>Due · ${esc(task.dueDate || 'Not set')}</small></section>
      <section class="card"><div class="section-title"><span>Contracts & proof</span></div>${linkedContracts.length ? linkedContracts.map((contract) => `<div class="contract-mini"><b>${esc(contract.method)} ${esc(contract.route)}</b><small>${esc(contract.state)}</small></div>`).join('') : '<p class="empty-inline">No K Map contract linked.</p>'}<strong class="detail-value">Acceptance criteria</strong>${task.acceptanceCriteria.length ? `<ul class="criteria-list">${task.acceptanceCriteria.map((criterion) => `<li>${esc(criterion)}</li>`).join('')}</ul>` : '<p class="empty-inline">No acceptance criteria.</p>'}</section>
      <section class="card"><small>Context · ${esc(statusLabel(task.contextStatus))}</small><strong class="detail-value">${task.artifactCount} linked artifacts · ${task.estimatedTokens} estimated tokens</strong><small>Verification · ${esc(task.verification)}</small></section>
      ${task.status === 'proposed' ? '<button class="primary" data-action="approveTask">Approve task</button>' : `<div class="workflow-actions"><button class="primary" data-action="discoverTask" ${busy ? 'disabled' : ''}>Discover & refresh context</button><button class="secondary" data-action="prepare" ${busy ? 'disabled' : ''}>Prepare IDE handoff</button><button class="secondary" data-action="verifyTask" ${busy ? 'disabled' : ''}>Review & run verification</button><button class="secondary" data-action="continueAgent">Continue to agent</button><button class="secondary" data-action="${task.status === 'in-progress' ? 'completeTask' : 'startTask'}">${task.status === 'in-progress' ? 'Mark complete' : 'Start task'}</button></div>`}
      <button class="link-action danger-link" data-action="archiveTask">Archive task</button>`;
  }

  function taskForm() {
    const editing = taskScreen === 'edit';
    const task = editing ? snapshot.taskRecords.find((entry) => entry.id === selectedTaskId) : null;
    const intent = task?.intent ?? 'discovery';
    return `<form id="taskEditorForm" class="editor-form">
      <section class="page-heading compact"><button type="button" class="link-action" data-action="${editing ? 'taskDetail' : 'taskList'}">← Cancel</button><p class="eyebrow">Tasks / ${editing ? 'edit' : 'create'}</p><h1>${editing ? 'Edit task' : 'Create task'}</h1></section>
      <label class="form-label">Task intent<select class="form-control" name="intent">${[['api-contract','Fix / update API contract'],['new-contract','Design new API endpoint'],['discovery','Discovery / cross-cutting'],['ui-component','Build UI / frontend'],['full-stack','Build full-stack feature'],['commit-pr','Prepare commit & PR'],['deployment-automation','Deployment & release']].map(([value,label]) => `<option value="${value}" ${intent === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="form-label">Title *<input class="form-control" name="title" maxlength="240" required value="${esc(task?.title ?? '')}" placeholder="Improve order creation reliability"></label>
      <label class="form-label">Objective *<textarea class="form-control" name="description" maxlength="4000" rows="4" required>${esc(task?.description ?? '')}</textarea></label>
      <div class="form-grid"><label class="form-label">Priority<select class="form-control" name="priority">${['low','medium','high','urgent'].map((value) => `<option ${((task?.priority ?? 'medium') === value) ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="form-label">Milestone<select class="form-control" name="milestoneId"><option value="">No milestone</option>${snapshot.milestones.map((milestone) => `<option value="${esc(milestone.id)}" ${task?.milestoneIds.includes(milestone.id) ? 'selected' : ''}>${esc(milestone.title)}</option>`).join('')}</select></label></div>
      <label class="form-label">Search project evidence<input class="form-control" id="taskProjectSearch" placeholder="Search routes, findings, and source files"><small>Searches the current project’s local index; results do not leave the companion.</small></label><div id="taskSearchResults" class="task-search-results">${renderTaskSearchResults()}</div>
      <label class="form-label">Linked K Map contracts <small>Select relevant indexed routes.</small><span class="check-list">${snapshot.contracts.map((contract) => `<label><input type="checkbox" name="contractIds" value="${esc(contract.id)}" ${task?.contractIds.includes(contract.id) ? 'checked' : ''}><span>${esc(contract.method)} ${esc(contract.route)} <small>${esc(contract.state)}</small></span></label>`).join('') || '<small>No contracts indexed.</small>'}</span></label>
      <fieldset class="planned-fields" id="plannedFields" ${intent === 'new-contract' ? '' : 'hidden'}><legend>Planned endpoint spec</legend><div class="form-grid"><label class="form-label">Method<select class="form-control" name="plannedMethod">${['GET','POST','PUT','PATCH','DELETE'].map((method) => `<option ${(task?.plannedMethod ?? 'GET') === method ? 'selected' : ''}>${method}</option>`).join('')}</select></label><label class="form-label">Route<input class="form-control" name="plannedPath" value="${esc(task?.plannedPath ?? '')}" placeholder="/api/v1/orders"></label></div><label class="form-label">Target handler file<input class="form-control" name="targetFile" value="${esc(task?.targetFile ?? '')}" placeholder="src/routes/orders.ts"></label><div class="form-grid"><label class="form-label">Expected request JSON<textarea class="form-control" name="requestExample" rows="3" maxlength="3000" placeholder='{"id":"..."}'></textarea></label><label class="form-label">Expected response JSON<textarea class="form-control" name="responseExample" rows="3" maxlength="3000" placeholder='{"status":"ok"}'></textarea></label></div><small>The planned contract and saved API request are provisioned with the task.</small></fieldset>
      <label class="form-label">Due date<input class="form-control" type="date" name="dueDate" value="${esc(task?.dueDate ?? '')}"></label>
      <label class="form-label">Acceptance criteria <small>One criterion per line.</small><textarea class="form-control" name="criteria" rows="4" maxlength="4000">${esc(task?.acceptanceCriteria.join('\n') ?? '')}</textarea></label>
      <button class="primary" type="submit">${editing ? 'Save task' : 'Create task & prepare context'}</button></form>`;
  }

  function renderTaskSearchResults() {
    if (!taskSearchResult) return '<p class="empty-inline">Search by route, feature, or source filename to find evidence.</p>';
    const contracts = taskSearchResult.contractMatches ?? [];
    const sources = taskSearchResult.sourceMatches ?? [];
    return `${contracts.length ? `<strong>Matching routes</strong>${contracts.map((entry) => `<label class="search-result"><input type="checkbox" data-search-contract="${esc(entry.contract.id)}"><span><b>${esc(entry.contract.method)} ${esc(entry.contract.route)}</b><small>${esc(entry.reason)}</small></span></label>`).join('')}` : ''}
      ${sources.length ? `<strong>Matching files</strong>${sources.map((entry) => `<label class="search-result"><input type="checkbox" data-search-source="${esc(entry.id)}"><span><b>${esc(entry.source)}</b><small>${esc(entry.relationship ?? entry.kind)}${entry.line ? ` · line ${entry.line}` : ''}</small></span></label>`).join('')}` : ''}
      ${!contracts.length && !sources.length ? '<p class="empty-inline">No indexed matches. Try another term or continue with an unlinked task.</p>' : ''}`;
  }

  async function searchTaskEvidence(query) {
    clearTimeout(taskSearchTimer);
    taskSearchTimer = setTimeout(async () => {
      if (query.trim().length < 3) { taskSearchResult = null; const target = document.getElementById('taskSearchResults'); if (target) target.innerHTML = renderTaskSearchResults(); return; }
      const target = document.getElementById('taskSearchResults');
      if (target) target.innerHTML = '<p class="empty-inline">Searching the local project index…</p>';
      try {
        const result = await request('api',{
          path:`/api/projects/${encodeURIComponent(snapshot.project.id)}/tasks/search-context`,
          method:'POST',body:{query,intent:document.querySelector('#taskEditorForm [name="intent"]')?.value ?? 'discovery'}
        });
        if (document.getElementById('taskProjectSearch')?.value !== query) return;
        taskSearchResult = result;
        const output = document.getElementById('taskSearchResults');
        if (output) output.innerHTML = renderTaskSearchResults();
      } catch (error) {
        const output = document.getElementById('taskSearchResults');
        if (output) output.innerHTML = `<p class="task-form-error">${esc(error.message)}</p>`;
      }
    },260);
  }

  function milestoneForm() {
    const milestone = snapshot.milestones.find((entry) => entry.id === milestoneEditingId);
    return `<form id="milestoneForm" class="editor-form"><section class="page-heading compact"><button type="button" class="link-action" data-action="taskList">← Tasks</button><p class="eyebrow">Project milestone</p><h1>${milestone ? 'Edit milestone' : 'New milestone'}</h1></section>
      <label class="form-label">Name *<input class="form-control" name="title" maxlength="240" required value="${esc(milestone?.title ?? '')}"></label>
      <label class="form-label">Description<textarea class="form-control" name="description" maxlength="2000" rows="4">${esc(milestone?.description ?? '')}</textarea></label>
      <label class="form-label">Target date<input class="form-control" type="date" name="targetDate" value="${esc(milestone?.targetDate ?? '')}"></label>
      <button class="primary" type="submit">${milestone ? 'Save milestone' : 'Create milestone'}</button>${milestone ? '<button class="link-action danger-link" type="button" data-action="deleteMilestone">Delete milestone</button>' : ''}</form>`;
  }

  function kmaps() {
    return `<section class="page-heading compact"><p class="eyebrow">Indexed implementation map</p><h1>K Maps</h1><p>Open a referenced file directly in the IDE editor.</p></section>
      <section class="task-list">${snapshot.contracts?.length ? snapshot.contracts.map((contract) => `<article class="task kmap-card"><span class="task-top"><i class="method">${esc(contract.method)}</i><strong>${esc(contract.route)}</strong><em>${esc(statusLabel(contract.state))}</em></span>${contract.references.length ? `<div class="source-list">${contract.references.map((reference) => `<button data-open-source="${esc(reference.path)}" data-line="${reference.line}" title="Open in editor"><span>${esc(reference.kind)}</span><code>${esc(reference.source)}:${reference.line}</code></button>`).join('')}</div>` : '<small>No indexed source reference yet.</small>'}<button class="link-action" data-kmap-inspect="${esc(contract.id)}">Inspect contract with MCP</button></article>`).join('') : '<div class="empty"><strong>No contracts indexed</strong><p>Reindex this workspace to build K Maps.</p></div>'}</section>
      <section class="compact-list"><h2>Saved requests <small>${snapshot.requests?.length ?? 0}</small></h2>${snapshot.requests?.slice(0,60).map((entry) => `<article class="compact-row"><div class="row-main"><strong><span class="method-chip">${esc(entry.method)}</span> ${esc(entry.name)}</strong><small>${esc(entry.url)}</small></div></article>`).join('') || '<p class="empty-inline">No saved requests.</p>'}</section>
      <section class="compact-list"><h2>Collections & workflows <small>${snapshot.collections?.length ?? 0}</small></h2>${snapshot.collections?.map((entry) => `<article class="compact-row"><div class="row-main"><strong>${esc(entry.name)}</strong><small>${entry.requestCount} ordered requests · ${esc(entry.origin)}</small></div></article>`).join('') || '<p class="empty-inline">No collections yet.</p>'}</section>`;
  }

  function settings() {
    return `<section class="page-heading compact"><p class="eyebrow">Project configuration</p><h1>Settings</h1><p>Manage this local project and its active environment.</p></section>
      <form id="settingsForm" class="editor-form"><label class="form-label">Project name<input class="form-control" name="name" maxlength="120" required value="${esc(snapshot.settings.name)}"></label>
      <label class="form-label">Project goal<textarea class="form-control" name="goal" maxlength="2000" rows="4">${esc(snapshot.settings.goal)}</textarea></label>
      <label class="form-label">Active environment<select class="form-control" name="activeEnvironmentId">${snapshot.environments.map((entry) => `<option value="${esc(entry.id)}" ${entry.active ? 'selected' : ''}>${esc(entry.name)}</option>`).join('')}</select></label>
      <button class="primary" type="submit">Save project settings</button></form>
      <section class="compact-list"><h2>Environments <small>Secret values hidden</small></h2>${snapshot.environments.map((entry) => `<article class="compact-row"><div class="row-main"><strong>${esc(entry.name)}${entry.active ? ' · active' : ''}</strong><small>${entry.variableKeys.length} variables · ${entry.variableKeys.filter((item) => item.secret).length} secret</small></div></article>`).join('') || '<p class="empty-inline">No environments configured.</p>'}</section>
      <button class="secondary" data-action="dashboard">Open complete dashboard settings</button>`;
  }

  const safeMcpTools = [
    ['get_project_context','Project context'],['list_tasks','List tasks'],['get_task_candidates','Task candidates'],
    ['get_contract_kmap','Inspect contract'],['list_contract_evidence','Contract evidence'],
    ['search_knowledge_graph','Search knowledge graph'],['find_graph_blind_spots','Find graph gaps'],
    ['get_project_timeline','Project timeline'],['get_secret_storage_status','Local vault status']
  ];

  function mcp() {
    return `<section class="page-heading compact"><p class="eyebrow">Model Context Protocol</p><h1>MCP tools</h1><p>Run read-oriented AIPI tools scoped to this project.</p></section>
      <form id="mcpForm" class="editor-form"><label class="form-label">Tool<select class="form-control" name="tool">${safeMcpTools.map(([id,label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
      <label class="form-label">Arguments JSON <small>project_id is added automatically.</small><textarea class="form-control" name="arguments" rows="4" spellcheck="false">{}</textarea></label>
      <button class="primary" type="submit" ${mcpBusy ? 'disabled' : ''}>${mcpBusy ? 'Running…' : 'Run MCP tool'}</button></form>
      ${mcpResult ? `<section class="card mcp-output"><div class="section-title"><span>${esc(mcpResult.tool)}</span><button data-action="clearMcp">Clear</button></div><pre>${esc(JSON.stringify(mcpResult.result,null,2))}</pre></section>` : ''}
      <section class="compact-list"><h2>Read-oriented tools</h2>${safeMcpTools.map(([id,label]) => `<article class="compact-row"><div class="row-main"><strong>${esc(label)}</strong><small>${esc(id)}</small></div></article>`).join('')}</section>`;
  }

  function indexView() {
    const index = snapshot.index;
    return `<section class="page-heading compact"><p class="eyebrow">Local source intelligence</p><h1>Index</h1><p>Scan and inspect indexed files and API coverage for this workspace.</p></section>
      <section class="metrics"><article><strong>${index.filesScanned}</strong><span>Files scanned</span><small>${snapshot.health.contracts} contracts</small></article><article><strong>${index.references.length}</strong><span>References shown</span><small>${index.roots.length} roots</small></article></section>
      <section class="card"><div class="section-title"><span>Index status</span><time>${esc(formatDate(index.lastScannedAt))}</time></div><strong>${index.lastScannedAt ? 'Indexed' : 'Not indexed'}</strong><small>${index.roots.map((root) => esc(root.path)).join('<br>') || 'No source roots registered'}</small></section>
      <button class="primary" data-action="reindex" ${busy === 'reindex' ? 'disabled' : ''}>${busy === 'reindex' ? 'Indexing workspace…' : 'Reindex current workspace'}</button>
      <section class="compact-list"><h2>Indexed evidence <small>${index.references.length} shown</small></h2>${index.references.map((item) => `<article class="compact-row"><button class="row-main" data-open-source="${esc(item.source)}" data-line="${item.line ?? 1}"><strong>${esc(item.name ?? item.source)}</strong><small>${esc(item.kind)} · ${esc(item.source)}${item.line ? `:${item.line}` : ''}</small></button></article>`).join('') || '<p class="empty-inline">No indexed references. Reindex to discover source files.</p>'}</section>`;
  }

  function contextView() {
    const task = selectedTask();
    if (!task) return `<section class="empty-page"><span class="empty-icon">◎</span><h1>Select a task</h1><p>Pick one task to build a bounded, freshness-checked handoff.</p><button class="primary" data-tab="tasks">Choose task</button></section>`;
    const ready = task.contextStatus === 'current';
    return `<section class="page-heading compact"><p class="eyebrow">Bounded handoff</p><h1>${esc(task.title)}</h1><p>${esc(task.description || 'Review linked implementation evidence before dispatch.')}</p></section>
      <section class="stage-list workflow-actions">
        <article class="${task.artifactCount ? 'done' : 'current'}"><span>1</span><div><strong>Discover task context</strong><small>Search local workspace symbols, K Maps and MCP knowledge-graph evidence.</small><button data-action="discoverTask" ${busy ? 'disabled' : ''}>${busy === 'discoverTask' ? '<span class="button-spinner"></span> Discovering…' : 'Discover context'}</button></div></article>
        <article class="${ready ? 'done' : 'current'}"><span>2</span><div><strong>Prepare & send context</strong><small>${task.artifactCount} linked artifacts · ${task.estimatedTokens} estimated tokens</small><button data-action="prepare" ${busy ? 'disabled' : ''}>${busy === 'prepare' ? '<span class="button-spinner"></span> Preparing…' : 'Send to coding agent'}</button></div></article>
        <article class="${task.verification !== 'Not run' ? 'done' : ''}"><span>3</span><div><strong>Review & run verification plan</strong><small>${esc(task.verification)} · ${task.acceptanceCount} acceptance checks</small><button data-action="verifyTask" ${busy ? 'disabled' : ''}>${busy === 'verifyTask' ? '<span class="button-spinner"></span> Verifying…' : 'Review & run'}</button></div></article>
      </section>
      <aside class="privacy"><strong>Local boundary</strong><p>Only this task, linked evidence, active editor selection and diagnostics enter the handoff. Secret values and other workspaces are excluded.</p></aside>
      ${task.status === 'proposed'
        ? `<button class="primary sticky-action" data-action="approveTask" data-task-id="${esc(task.id)}" ${busy ? 'disabled' : ''}>Approve task</button><p class="fine-print">Approval moves this proposal into the active plan. It does not change source code.</p>`
        : `<button class="secondary sticky-action" data-go="agent">Open agent handoff</button>`}`;
  }

  function agent() {
    const task = selectedTask();
    return `<section class="page-heading compact"><p class="eyebrow">IDE coding-agent bridge</p><h1>Continue with context</h1><p>${task ? `Selected: ${esc(task.title)}` : 'No task selected. AIPI will use workspace and active-editor context.'}</p></section>
      <section class="agent-output ${agentText ? 'has-output' : ''}" aria-live="polite"><div class="agent-output-head"><strong>${agentStatus || 'Handoff status'}</strong>${currentStreamId ? '<button data-action="cancelAgent">Stop</button>' : ''}</div>${agentText ? `<pre>${esc(agentText)}</pre>` : '<p>AIPI opens the IDE coding-agent chat with bounded evidence and a required post-edit verification loop.</p>'}</section>
      <form id="agentForm" class="agent-form"><label for="agentQuestion">Instruction</label><textarea id="agentQuestion" rows="4" placeholder="Implement the smallest safe correction and verify it…"></textarea><button class="primary" type="submit" ${currentStreamId ? 'disabled' : ''}>${currentStreamId ? '<span class="button-spinner"></span> Preparing handoff…' : 'Open coding agent with context'}</button></form>
      <p class="fine-print">The handoff is stored locally, opens the supported VS Code/Cursor agent chat, and requires a verified AIPI receipt before completion. If chat cannot open, the prompt remains in .aipi/active-context.md and on the clipboard.</p>`;
  }

  function render() {
    if (!snapshot) return;
    if (selectedTaskId && !snapshot.tasks.some((task) => task.id === selectedTaskId)) selectedTaskId = null;
    const content = activeTab === 'tasks' ? tasks() : activeTab === 'kmaps' ? kmaps() : activeTab === 'context' ? contextView() : activeTab === 'agent' ? agent() : activeTab === 'settings' ? settings() : activeTab === 'mcp' ? mcp() : activeTab === 'index' ? indexView() : overview();
    app.innerHTML = shell(content);
    persist();
  }

  function renderError(error) {
    const missing = error.code === 'COMPANION_NOT_RUNNING' || /not running|companion/i.test(error.message);
    app.innerHTML = `<main class="onboarding"><img src="${esc(logoUri)}" alt="AIPI"><p class="eyebrow">IDE workspace companion</p><h1>${missing ? 'Start AIPI locally' : 'Panel unavailable'}</h1><p>${esc(error.message)}</p>${missing ? '<button class="primary" data-action="initialize">Initialize in terminal</button><button class="secondary" data-action="connect">I started it — connect</button>' : '<button class="primary" data-action="connect">Try again</button>'}<small>No project data is uploaded by this extension.</small></main>`;
  }

  async function load(action = 'bootstrap') {
    busy = action;
    try { snapshot = await request(action); busy = ''; render(); }
    catch (error) { busy = ''; renderError(error); }
  }

  window.addEventListener('message', ({data}) => {
    if (data?.channel !== CHANNEL) return;
    if (data.type === 'response') {
      const entry = pending.get(data.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(Object.assign(new Error(data.error?.message || 'AIPI bridge failed.'), data.error));
      return;
    }
    if (data.type === 'event') {
      if (['refreshRequested','workspaceChanged','editorChanged'].includes(data.event)) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => load('refresh'), 120); }
      if (data.event === 'sourceChanged') toast('Source changed. Reindex before relying on verification evidence.');
      return;
    }
    if (data.type === 'stream') {
      currentStreamId = data.streamId;
      if (data.phase === 'started') { agentText = ''; agentStatus = data.payload.message; }
      else if (data.phase === 'context') agentStatus = `Context ready · ${data.payload.artifacts} artifacts · ${data.payload.tokens} tokens`;
      else if (data.phase === 'model') agentStatus = `${data.payload.name || data.payload.family || 'IDE model'} responding…`;
      else if (data.phase === 'delta') agentText += data.payload.text || '';
      else if (data.phase === 'completed') { if (data.payload.text && !agentText) agentText = data.payload.text; agentStatus = data.payload.message || 'Complete'; currentStreamId = null; }
      else if (data.phase === 'cancelled') { agentStatus = 'Stopped'; currentStreamId = null; }
      else if (data.phase === 'failed') { agentStatus = 'Could not continue'; agentText += `${agentText ? '\n\n' : ''}${data.payload.message}`; currentStreamId = null; }
      if (activeTab === 'agent') render();
    }
  });

  document.addEventListener('click', async (event) => {
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) { activeTab = tab; if (tab === 'tasks') taskScreen = 'list'; render(); return; }
    const filter = event.target.closest('[data-filter]')?.dataset.filter;
    if (filter) { taskFilter = filter; render(); return; }
    const select = event.target.closest('[data-select-task]');
    if (select) { selectedTaskId = select.dataset.selectTask; activeTab = select.dataset.go || activeTab; taskScreen = 'detail'; render(); return; }
    const milestone = event.target.closest('[data-milestone-edit]');
    if (milestone) { milestoneEditingId = milestone.dataset.milestoneEdit; taskScreen = 'milestone'; activeTab = 'tasks'; render(); return; }
    const contract = event.target.closest('[data-kmap-inspect]');
    if (contract) {
      const selected = snapshot.contracts.find((entry) => entry.id === contract.dataset.kmapInspect);
      mcpResult = null; activeTab = 'mcp'; render();
      selectedContractId = selected.id;
      const args = {project_id:snapshot.project.id, contract_id:selected.id};
      try { mcpResult = {tool:'get_contract_kmap',result:await request('api',{path:'/api/tools/call',method:'POST',body:{name:'get_contract_kmap',arguments:args}})}; render(); }
      catch (error) { toast(error.message); }
      return;
    }
    const go = event.target.closest('[data-go]')?.dataset.go;
    if (go) { activeTab = go; render(); return; }
    const source = event.target.closest('[data-open-source]');
    if (source) { request('openSource', {path:source.dataset.openSource, line:Number(source.dataset.line) || 1}).catch((error) => toast(error.message)); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    try {
      if (action === 'refresh') await load('refresh');
      else if (action === 'reindex') { busy = action; render(); snapshot = await request('reindex'); busy = ''; render(); toast('Workspace index refreshed.'); }
      else if (action === 'wide') await request('wide');
      else if (action === 'dashboard') await request('openDashboard');
      else if (action === 'initialize') { await request('initializeCompanion'); toast('AIPI initialization opened in the terminal.'); }
      else if (action === 'connect') await load('connect');
      else if (action === 'newTask') { taskScreen = 'create'; activeTab = 'tasks'; selectedTaskId = null; render(); }
      else if (action === 'newMilestone') { milestoneEditingId = null; taskScreen = 'milestone'; activeTab = 'tasks'; render(); }
      else if (action === 'taskList') { taskScreen = 'list'; render(); }
      else if (action === 'taskDetail') { taskScreen = 'detail'; render(); }
      else if (action === 'editTask') { taskScreen = 'edit'; render(); }
      else if (action === 'continueAgent') { activeTab = 'agent'; render(); }
      else if (action === 'deleteMilestone') {
        if (confirm('Delete this milestone? Linked tasks must be moved first.')) {
          snapshot = await request('removeMilestone',{milestoneId:milestoneEditingId});
          milestoneEditingId = null; taskScreen = 'list'; render(); toast('Milestone deleted.');
        }
      } else if (action === 'clearMcp') { mcpResult = null; render(); }
      else if (action === 'approveTask') { busy = action; render(); snapshot = await request('updateTaskStatus', {taskId:selectedTaskId, status:'planned'}); busy = ''; render(); toast('Task approved and moved to the active plan.'); }
      else if (action === 'completeTask') { snapshot = await request('updateTaskStatus',{taskId:selectedTaskId,status:'done'}); taskScreen='detail'; render(); toast('Task marked complete.'); }
      else if (action === 'startTask') { snapshot = await request('updateTaskStatus',{taskId:selectedTaskId,status:'in-progress'}); taskScreen='detail'; render(); toast('Task moved to in progress.'); }
      else if (action === 'archiveTask') {
        if (confirm('Archive this task? It will remain available in project history.')) {
          snapshot = await request('archiveTask',{taskId:selectedTaskId});
          selectedTaskId = null; taskScreen='list'; render(); toast('Task archived.');
        }
      }
      else if (action === 'discoverTask') { busy = action; render(); const result = await request('discoverTaskContext', {taskId:selectedTaskId}); busy = ''; snapshot = await request('refresh'); render(); toast(`Discovery linked ${result.task?.artifactIds?.length ?? 0} artifacts; ${result.search?.matches ?? 0} graph matches reviewed.`); }
      else if (action === 'prepare') { busy = 'prepare'; render(); const result = await request('prepareHandoff', {taskId:selectedTaskId, openChat:true}); busy = ''; snapshot = await request('refresh'); render(); toast(result.chatOpened ? 'Context sent to the IDE coding agent.' : `Context ready: ${result.context.artifacts} artifacts, about ${result.context.tokens} tokens.`); }
      else if (action === 'verifyTask') { busy = action; render(); const result = await request('verifyTask', {taskId:selectedTaskId}); busy = ''; snapshot = await request('refresh'); render(); toast(`Verification ${result.receipt?.result || 'completed'}; receipt saved locally.`); }
      else if (action === 'cancelAgent' && currentStreamId) await request('cancelAgent', {streamId:currentStreamId});
    } catch (error) { busy = ''; render(); toast(error.message); }
  });

  document.addEventListener('submit', async (event) => {
    if (event.target.id === 'taskEditorForm') {
      event.preventDefault();
      const form = new FormData(event.target);
      const editing = taskScreen === 'edit';
      const current = editing ? snapshot.taskRecords.find((entry) => entry.id === selectedTaskId) : null;
      const task = {
        ...(current ?? {}), title:String(form.get('title') ?? '').trim(), description:String(form.get('description') ?? '').trim(),
        intent:String(form.get('intent') ?? 'discovery'), priority:String(form.get('priority') ?? 'medium'),
        status:current?.status ?? 'planned',
        milestoneIds:form.get('milestoneId') ? [String(form.get('milestoneId'))] : [],
        contractIds:form.getAll('contractIds').map(String),
        dueDate:String(form.get('dueDate') ?? ''),
        acceptanceCriteria:String(form.get('criteria') ?? '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
      };
      if (!task.title || !task.description) { toast('Enter both a task title and objective.'); return; }
      const payload = {task};
      if (task.intent === 'new-contract') payload.plannedContract = {
        method:String(form.get('plannedMethod') ?? 'GET'),
        path:String(form.get('plannedPath') ?? '').trim(),
        targetFile:String(form.get('targetFile') ?? '').trim(),
        requestExample:String(form.get('requestExample') ?? ''),
        responseExample:String(form.get('responseExample') ?? '')
      };
      task.workspaceFileRefs = selectedSourceRefs;
      busy = 'saveTask'; render();
      try {
        const route = `/api/projects/${encodeURIComponent(snapshot.project.id)}/tasks${editing ? `/${encodeURIComponent(selectedTaskId)}` : ''}`;
        const result = await request('api',{path:route,method:'POST',body:payload});
        selectedTaskId = result.task?.id ?? selectedTaskId;
        snapshot = await request('refresh'); taskScreen = 'detail'; busy = ''; render();
        toast(editing ? 'Task and context updated.' : 'Task created; context and verification plan prepared.');
      } catch (error) { busy = ''; render(); toast(error.message); }
      return;
    }
    if (event.target.id === 'milestoneForm') {
      event.preventDefault();
      const form = new FormData(event.target);
      try {
        const result = await request('saveMilestone',{
          id:milestoneEditingId || undefined,title:String(form.get('title') ?? '').trim(),
          description:String(form.get('description') ?? '').trim(),targetDate:String(form.get('targetDate') ?? '')
        });
        snapshot = result.snapshot; milestoneEditingId = null; taskScreen='list'; render(); toast('Milestone saved.');
      } catch (error) { toast(error.message); }
      return;
    }
    if (event.target.id === 'settingsForm') {
      event.preventDefault();
      const form = new FormData(event.target);
      try {
        snapshot = await request('saveProjectSettings',{
          name:String(form.get('name') ?? '').trim(),goal:String(form.get('goal') ?? '').trim(),
          activeEnvironmentId:String(form.get('activeEnvironmentId') ?? '')
        });
        render(); toast('Project settings saved.');
      } catch (error) { toast(error.message); }
      return;
    }
    if (event.target.id === 'mcpForm') {
      event.preventDefault();
      const form = new FormData(event.target);
      let args;
      try { args = JSON.parse(String(form.get('arguments') ?? '{}')); }
      catch { toast('Arguments must be valid JSON.'); return; }
      if (!args || Array.isArray(args) || typeof args !== 'object') { toast('Arguments must be a JSON object.'); return; }
      const tool = String(form.get('tool') ?? '');
      if (!safeMcpTools.some(([id]) => id === tool)) { toast('Choose a read-oriented MCP tool.'); return; }
      args.project_id = snapshot.project.id;
      if (['get_task_candidates','get_task_context','get_task_verification_plan','get_verification_report'].includes(tool) && selectedTaskId && !args.task_id) args.task_id = selectedTaskId;
      if (['get_contract_kmap','list_contract_evidence'].includes(tool) && selectedContractId && !args.contract_id) args.contract_id = selectedContractId;
      mcpBusy = true; render();
      try {
        mcpResult = {tool,result:await request('api',{path:'/api/tools/call',method:'POST',body:{name:tool,arguments:args}})};
        mcpBusy = false; render();
      } catch (error) { mcpBusy = false; render(); toast(error.message); }
      return;
    }
    if (event.target.id !== 'agentForm') return;
    event.preventDefault();
    const question = document.getElementById('agentQuestion').value.trim();
    if (!question) { toast('Write a message for the IDE agent.'); return; }
    agentText = ''; agentStatus = 'Starting…'; render();
    try { const result = await request('runAgent', {taskId:selectedTaskId, question}); currentStreamId = result.streamId; render(); }
    catch (error) { currentStreamId = null; agentStatus = 'Could not start'; agentText = error.message; render(); }
  });

  document.addEventListener('change', (event) => {
    if (event.target.name !== 'intent' || !event.target.closest('#taskEditorForm')) return;
    const planned = document.getElementById('plannedFields');
    if (planned) planned.hidden = event.target.value !== 'new-contract';
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'taskProjectSearch') searchTaskEvidence(event.target.value);
    if (event.target.id === 'taskSearch') {
      taskTextFilter = event.target.value;
      const cursor = event.target.selectionStart;
      render();
      const input = document.getElementById('taskSearch');
      input?.focus();
      input?.setSelectionRange(cursor,cursor);
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-search-contract]')) {
      const id = event.target.dataset.searchContract;
      const linked = [...document.querySelectorAll('#taskEditorForm input[name="contractIds"]')].find((input) => input.value === id);
      if (linked) linked.checked = event.target.checked;
    }
    if (event.target.matches('[data-search-source]')) {
      const id = event.target.dataset.searchSource;
      const reference = taskSearchResult?.sourceMatches?.find((entry) => entry.id === id);
      if (!reference) return;
      selectedSourceRefs = event.target.checked
        ? [...selectedSourceRefs.filter((entry) => entry.source !== reference.source || entry.root !== reference.root), {root:reference.root,source:reference.source,kind:reference.kind}]
        : selectedSourceRefs.filter((entry) => entry.source !== reference.source || entry.root !== reference.root);
    }
  });

  load();
})();
