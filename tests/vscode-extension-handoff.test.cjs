const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const {EventEmitter} = require('node:events');

const waitUntil = async (predicate, message, timeout = 1500) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function main() {
  const originalHome = process.env.HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-vscode-bridge-'));
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipi-vscode-other-'));
  process.env.HOME = root;
  let outsideFile;
  const sourceFile = path.join(root, 'src', 'handler.ts');
  await fs.mkdir(path.dirname(sourceFile), {recursive:true});
  await fs.writeFile(sourceFile, 'line one\nline two\nline three\n', 'utf8');

  const workspaceFolder = {name:'test-workspace', uri:{scheme:'file', fsPath:root}};
  const otherWorkspaceFolder = {name:'AIPI Test Workspace', uri:{scheme:'file', fsPath:otherRoot}};
  const workspaceFolders = [workspaceFolder];
  let activeEditorChanged;
  let selectionChanged;
  let companionState = {
    version:2,
    revision:1,
    activeProjectId:'other-project',
    projects:[
      {
        id:'test-project', name:'test-workspace', summary:{goal:'Keep APIs healthy.'}, activeEnvironmentId:'env', environments:[{id:'env', name:'Development', variables:[{key:'baseUrl',value:'http://localhost:3000',secret:false},{key:'API_TOKEN',value:'never expose',secret:true}]}],
        sourceContext:{roots:[{kind:'workspace', path:root}], filesScanned:7, lastScannedAt:'2026-10-16T08:00:00.000Z', findings:[{id:'finding', severity:'high', status:'open'}], endpoints:[{id:'endpoint', method:'GET', path:'/api/users', source:'src/handler.ts', root, line:2}]},
        contracts:[{id:'contract', method:'GET', route:'/api/users', state:'Untested', sourceArtifactIds:['endpoint']}],
        requests:[{id:'request',name:'List users',method:'GET',url:'{{baseUrl}}/api/users',contractId:'contract'}],
        collections:[{id:'collection',name:'Smoke suite',requestIds:['request']}], milestones:[],
        tasks:[{id:'task', title:'Fix handler', description:'Align the handler and contract.', status:'planned', priority:'high', artifactIds:['endpoint:endpoint'], acceptanceCriteria:['Request passes']}],
        contextPacks:[], verificationReceipts:[]
      },
      {id:'other-project', name:'other-workspace', sourceContext:{roots:[{kind:'workspace', path:otherRoot}]}, tasks:[]}
    ],
    timeline:[{id:'current-event', projectId:'test-project', title:'Indexed'}, {id:'other-event', projectId:'other-project', title:'Other'}]
  };
  const prepared = {
    ok:true,
    manifest:{id:'context', artifacts:[{id:'endpoint:endpoint', kind:'endpoint', source:'src/handler.ts', root, line:2, endLine:3}], findings:[], requests:[], telemetry:{estimatedTokens:420}, freshness:{status:'current'}, unresolvedQuestions:[], coverage:'Bounded context.'},
    contextPack:{id:'context', artifactIds:['endpoint:endpoint'], estimatedTokens:420},
    task:{id:'task', title:'Fix handler'}
  };

  const opened = [];
  const posted = [];
  const apiCalls = [];
  const projectCreations = [];
  const registered = new Map();
  const commands = new Map();
  let receiveMessage;
  let clipboardText = '';
  let chatPrompt = '';
  let externalUrl = '';
  let wideOpenCount = 0;
  let widePanel;
  let terminalCommand = '';
  let terminalCwd = '';
  let terminalExecutesImmediately = true;
  let companionAvailable = true;
  let companionBusy = false;
  let teamOnboardingAvailable = false;
  const settings = {};
  let spawnedCompanion;
  const cache = new Map();

  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  class Selection extends Range { get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; } get active() { return this.end; } }
  class CancellationTokenSource {
    constructor() { this.token = {isCancellationRequested:false}; }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }

  const vscode = {
    workspace:{
      isTrusted:true,
      workspaceFolders,
      getWorkspaceFolder:(uri) => uri?.fsPath?.startsWith(otherRoot) ? otherWorkspaceFolder : uri?.fsPath?.startsWith(root) ? workspaceFolder : undefined,
      onDidSaveTextDocument:() => ({dispose(){}}),
      getConfiguration:() => ({get:(key, fallback) => Object.hasOwn(settings, key) ? settings[key] : fallback, inspect:(key) => ({globalValue:settings[key], workspaceValue:settings[`workspace:${key}`], defaultValue:[]})})
    },
    window:{
      activeTextEditor:null,
      registerWebviewViewProvider:(id, provider) => { registered.set(id, provider); return {dispose(){}}; },
      createWebviewPanel:() => { wideOpenCount++; widePanel = {webview:{options:null, asWebviewUri:(uri) => ({toString:() => `vscode-webview://${uri.fsPath}`}), onDidReceiveMessage(){}, postMessage(){}}, onDidDispose(){}}; return widePanel; },
      onDidChangeActiveTextEditor:(handler) => { activeEditorChanged = handler; return {dispose(){}}; },
      onDidChangeTextEditorSelection:(handler) => { selectionChanged = handler; return {dispose(){}}; },
      showTextDocument:async (document, options) => {
        const editor = {document, selection:options.selection, revealRange(range) { this.revealed = range; }};
        opened.push({document, options, editor});
        return editor;
      },
      showInformationMessage:async () => {},
      showWarningMessage:async (_message, options, action) => options?.modal ? action : undefined,
      showErrorMessage:async () => {},
      createOutputChannel:() => ({append(){}, appendLine(){}, show(){}, dispose(){}}),
      createTerminal:(options) => ({show(){}, sendText(text, addNewLine) { terminalCommand = text; terminalCwd = options.cwd.fsPath; terminalExecutesImmediately = addNewLine; }})
    },
    commands:{
      registerCommand:(id, handler) => { commands.set(id, handler); return {dispose(){}}; },
      getCommands:async () => ['workbench.action.chat.open'],
      executeCommand:async (command, args) => {
        if (command === 'workbench.action.chat.open') chatPrompt = args.query;
        else if (commands.has(command)) return commands.get(command)(args);
      }
    },
    languages:{getDiagnostics:() => []},
    lm:{selectChatModels:async () => [{name:'Test model', family:'test', vendor:'test', sendRequest:async () => ({text:(async function* () { yield 'Checked '; yield 'the handler.'; })()})}]},
    LanguageModelChatMessage:{User:(text) => ({role:'user', text})},
    CancellationTokenSource,
    env:{
      clipboard:{writeText:async (text) => { clipboardText = text; }},
      openExternal:async (uri) => { externalUrl = uri.toString(); }
    },
    Uri:{
      joinPath:(base, ...parts) => ({fsPath:path.join(base.fsPath, ...parts), toString(){return this.fsPath;}}),
      file:(fsPath) => ({scheme:'file', fsPath, toString(){return fsPath;}}),
      parse:(value) => ({toString:() => value})
    },
    Position,
    Range,
    Selection,
    ViewColumn:{Active:1},
    TextEditorRevealType:{InCenter:1}
  };
  vscode.workspace.openTextDocument = async (uri) => {
    const text = await fs.readFile(uri.fsPath, 'utf8');
    const lines = text.trimEnd().split('\n');
    return {uri, languageId:'typescript', lineCount:lines.length, lineAt:(line) => ({text:lines[line] ?? ''}), getText:() => text};
  };

  const mockSpawn = (command, args, options) => {
    spawnedCompanion = {command, args, options};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { companionAvailable = true; if (!args.includes('daemon')) child.emit('exit', 0, null); });
    return child;
  };
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'node:child_process') return {...originalLoad.call(this, request, parent, isMain), spawn:mockSpawn};
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const extensionPath = require.resolve('../extensions/vscode/src/extension.cjs');
    delete require.cache[extensionPath];
    const {activate, buildSnapshot, buildAgentPrompt, within, requireTeamCompanion} = require(extensionPath);
    assert.throws(() => requireTeamCompanion({connected:true,protocolVersion:2}), /Update the AIPI extension/);
    assert.doesNotThrow(() => requireTeamCompanion({connected:true,protocolVersion:2,capabilities:{teamOnboarding:1}}));
    const {CompanionClient, allowedTools} = require('../extensions/vscode/src/CompanionClient.cjs');
    const originalConnectionFile = process.env.AIPI_CONNECTION_FILE;
    const isolatedConnectionFile = path.join(root, 'isolated-daemon.json');
    process.env.AIPI_CONNECTION_FILE = isolatedConnectionFile;
    assert.equal(new CompanionClient().connectionFile, isolatedConnectionFile);
    assert.equal(new CompanionClient({connectionFile:'explicit.json'}).connectionFile, 'explicit.json');
    if (originalConnectionFile === undefined) delete process.env.AIPI_CONNECTION_FILE;
    else process.env.AIPI_CONNECTION_FILE = originalConnectionFile;
    const client = new CompanionClient();
    const missingClient = new CompanionClient({connectionFile:path.join(root, 'missing-daemon.json')});
    await assert.rejects(missingClient.request('/api/connection'), (error) => error.code === 'COMPANION_NOT_RUNNING');
    await assert.rejects(client.request('/api/tools/call', 'POST', {name:'unregistered_tool'}), /not available through the panel bridge/);
    assert.ok(['report_agent_finding','search_knowledge_graph','discover_task_context','prepare_task_handoff','review_and_run_task_verification','create_handoff','complete_handoff','start_task_check_job','get_task_check_job','cancel_task_check_job','record_handoff_dispatch','aipi_get_cross_repo_contracts','aipi_check_impact','aipi_get_handoff','get_workspace_manifest','list_workspace_checkouts'].every((name) => allowedTools.has(name)),
      'bounded graph, finding, handoff and daily facade tools pass the bridge allowlist');
    assert.equal(client.isAllowed('/api/projects/project/tasks/task/prepare-context', 'POST'), true, 'task context route is allowed');
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/targets', 'GET'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/release-compatibility', 'GET'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce', 'GET'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/relationships', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/relationship-reviews', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/tasks', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/tasks/append', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/tasks/task_1/context', 'GET'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/tasks/task_1/context-pack', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/receipts', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/change-assessment', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/change-assessment/review', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/change-assessment/execute', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/change-assessment/package', 'POST'), true);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/change-assessment/execute', 'GET'), false);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce/change-assessment', 'PUT'), false);
    assert.equal(client.isAllowed('/api/workspaces/wsg_commerce', 'PUT'), false, 'IDE cannot broaden workspace membership');
    assert.equal(client.isAllowed('/api/projects/project/tasks/task/verify', 'POST'), true, 'task verification route is allowed');
    assert.equal(client.isAllowed('/api/projects/project/tasks', 'POST'), true, 'task creation route is allowed');
    assert.equal(client.isAllowed('/api/projects/project/tasks/task', 'POST'), true, 'task update route is allowed');
    assert.equal(client.isAllowed('/api/projects/project/tasks/search-context', 'POST'), true, 'read-only task project search is allowed');
    assert.equal(client.isAllowed('/api/team-onboarding/start', 'POST'), true, 'IDE can request a scoped Team Cloud handoff');
    assert.equal(client.isAllowed('/api/team-sync/status?projectId=test-project', 'GET'), true, 'IDE can read its project-scoped team sync status');
    assert.equal(client.isAllowed('/api/projects/project/tasks/task/commit-pack', 'POST'), true, 'task release packs are available to the shared dashboard');
    assert.equal(client.isAllowed('/api/projects/project/graph/edges/confirm', 'POST'), true, 'K Map relationship review is available to the shared dashboard');
    assert.equal(client.isAllowed('/api/projects/project/findings/finding/generate-test', 'POST'), true, 'generated test execution is available to the task workspace');
    assert.equal(client.isAllowed('/api/runtime-mesh/status?projectId=project', 'GET'), true, 'project settings can inspect runtime mesh status');
    assert.equal(client.isAllowed('/api/projects/project/delete', 'POST'), false, 'unregistered project routes remain blocked');
    assert.equal(within(root, sourceFile), true);
    assert.equal(within(root, otherRoot), false);

    const unitSnapshot = buildSnapshot(companionState.projects[0], companionState, null, {connected:true});
    assert.equal(unitSnapshot.taskCounts.active, 1);
    assert.equal(unitSnapshot.health.findings, 1);
    assert.equal(JSON.stringify(unitSnapshot.environments).includes('value'), false, 'the webview snapshot exposes variable names but never environment secret values');
    const unitPrompt = buildAgentPrompt({project:companionState.projects[0], task:companionState.projects[0].tasks[0], prepared, editor:null, question:'Fix it'});
    assert.match(unitPrompt, /bounded context/i);
    assert.match(unitPrompt, /src\/handler\.ts/);
    assert.match(unitPrompt, /get_task_verification_plan/);
    assert.match(unitPrompt, /aggregate Verified receipt/);
    assert.match(unitPrompt, /start_task_check_job/);
    assert.match(unitPrompt, /complete_handoff with the verified receipt ID/);

    await fs.mkdir(path.join(root, '.api-forge'), {recursive:true});
    await fs.writeFile(path.join(root, '.api-forge', 'daemon.json'), JSON.stringify({url:'http://127.0.0.1:49157', token:'local-test-token', pid:99999999}));
    global.fetch = async (url, options = {}) => {
      assert.equal(options.headers.authorization, 'Bearer local-test-token', 'the extension host authenticates companion requests');
      const parsed = new URL(url);
      const route = parsed.pathname;
      apiCalls.push({route, method:options.method ?? 'GET', body:options.body});
      if (route === '/api/connection') {
        if (!companionAvailable) throw Object.assign(new Error('fetch failed'), {cause:{code:'ECONNREFUSED'}});
        if (companionBusy) throw Object.assign(new Error('The operation was aborted due to timeout'), {name:'TimeoutError'});
        return {ok:true, status:200, json:async () => ({connected:true, protocolVersion:2, capabilities:teamOnboardingAvailable ? {teamOnboarding:1} : {}})};
      }
      if (route === '/api/team-onboarding/start') return {ok:true, status:200, json:async () => ({projectKey:'test-project',port:49157,ticket:'a'.repeat(43),expiresAt:new Date(Date.now() + 600_000).toISOString()})};
      if (route === '/api/team-sync/status') return {ok:true, status:200, json:async () => ({ready:true,link:null,pending:0,conflicts:0})};
      if (route === '/api/projects' && options.method === 'POST') {
        const creation = JSON.parse(options.body);
        projectCreations.push(creation);
        const project = {id:'other-project', name:creation.name, sourceContext:{roots:[{kind:'workspace',path:creation.workspacePath}]}, tasks:[]};
        companionState.projects.push(project);
        return {ok:true, status:201, json:async () => project};
      }
      if (route === '/api/tools/call') {
        const body = JSON.parse(options.body);
        assert.equal(body.arguments.project_id, 'test-project');
        if (body.name === 'search_knowledge_graph') return {ok:true, status:200, json:async () => ({isError:false, structuredContent:{nodes:[{id:'endpoint'}], citationIds:['endpoint']}})};
        if (body.name !== 'create_handoff') return {ok:true, status:200, json:async () => ({isError:false, structuredContent:{tool:body.name}})};
        assert.equal(body.name, 'create_handoff');
        assert.equal(body.arguments.task_id, 'task');
        return {ok:true, status:200, json:async () => ({isError:false, structuredContent:{handoff:{id:'handoff-task'}}})};
      }
      if (/\/discover-context$/.test(route)) {
        const project = companionState.projects.find((entry) => entry.id === 'test-project');
        const task = project.tasks.find((entry) => entry.id === 'task');
        task.artifactIds = ['endpoint:endpoint'];
        return {ok:true, status:200, json:async () => ({ok:true, task, contextPack:{estimatedTokens:320}})};
      }
      if (/\/prepare-context$/.test(route)) {
        const project = companionState.projects.find((entry) => entry.id === 'test-project');
        const task = project.tasks.find((entry) => entry.id === 'task');
        task.contextStatus = 'current';
        task.contextPack = prepared.contextPack;
        return {ok:true, status:200, json:async () => prepared};
      }
      if (/\/verify$/.test(route) && options.method === 'GET') return {ok:true, status:200, json:async () => ({ok:true, plan:{targetSnapshotHash:'sha256:test', steps:[{type:'test-log', command:{command:'npm', args:['run','test'], cwd:'.'}, required:true, status:'planned', requiresStateChangeApproval:false}]}})};
      if (/\/verify$/.test(route) && options.method === 'POST') return {ok:true, status:200, json:async () => ({ok:true, receipt:{id:'receipt', result:'Verified'}})};
      if (route === '/api/state' && options.method === 'PUT') {
        companionState = JSON.parse(options.body);
        companionState.revision++;
        return {ok:true, status:200, json:async () => ({ok:true, state:companionState})};
      }
      return {ok:true, status:200, json:async () => companionState};
    };

    const subscriptions = [];
    activate({
      extensionUri:{fsPath:path.resolve(__dirname, '../extensions/vscode')},
      subscriptions,
      workspaceState:{update:async (key, value) => cache.set(key, value)}
    });
    const provider = registered.get('aipi.workspace');
    assert.ok(provider, 'AIPI sidebar provider is registered');
    assert.ok(commands.has('aipi.initialize') && commands.has('aipi.openWide') && commands.has('aipi.openDashboard'), 'IDE commands are registered');
    const extensionRoot = path.resolve(__dirname, '../extensions/vscode');
    const extensionManifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
    assert.equal(extensionManifest.contributes.viewsContainers.activitybar[0].icon, 'media/activity.svg', 'the AIPI activity-bar container uses its theme-aware SVG logo');
    assert.equal(extensionManifest.contributes.views.aipi[0].icon, 'media/aipi-logo.png', 'the sidebar view uses the product logo');
    assert.match(await fs.readFile(path.join(extensionRoot, 'src/extension.cjs'), 'utf8'), /companion\/scripts\/aipi-cli-bundle\.mjs/, 'the extension starts its bundled companion without opening a browser');
    const dashboardScript = await fs.readFile(path.resolve(__dirname, '../ui/app.js'), 'utf8');
    assert.match(dashboardScript, /message\?\.type === "aipi:refresh" && ideHost/, 'IDE refresh updates the current view without reloading its webview');
    assert.doesNotMatch(dashboardScript, /message\?\.type === "aipi:refresh"\) location\.reload\(\)/, 'IDE refresh cannot blank the panel through a full webview reload');
    for (const command of ['aipi.initialize', 'aipi.connectWorkspace', 'aipi.openWide', 'aipi.openDashboard', 'aipi.openTeamCloud', 'aipi.refresh', 'aipi.rescan', 'aipi.assessWorkingChanges', 'aipi.openRepairHandoff', 'aipi.reviewRequiredChecks', 'aipi.inspectDeploymentBlocker']) {
      assert.ok(extensionManifest.activationEvents.includes(`onCommand:${command}`), `${command} activates the extension when invoked`);
      assert.ok(commands.has(command), `${command} is registered by the extension host`);
    }

    const webview = {
      cspSource:'vscode-webview:',
      options:null,
      html:'',
      asWebviewUri:(uri) => ({toString:() => `vscode-webview://${uri.fsPath}`}),
      onDidReceiveMessage:(handler) => { receiveMessage = handler; },
      postMessage:(message) => { posted.push(message); }
    };
    await provider.resolveWebviewView({webview, onDidDispose(){}});
    assert.match(webview.html, /aipi\.ide\.v1/);
    assert.match(webview.html, /media\/app\.js/, 'the extension renders the shared full-dashboard bundle');
    assert.match(webview.html, /media\/styles\.css/, 'the extension renders the shared dashboard styles');
    assert.match(webview.html, /Content-Security-Policy/);
    assert.doesNotMatch(webview.html, /local-test-token/, 'the daemon token never enters webview HTML');
    const css = await fs.readFile(path.resolve(__dirname, '../extensions/vscode/media/panel.css'), 'utf8');
    assert.match(css, /overflow-x:hidden/);
    assert.match(css, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
    assert.match(css, /@media\(max-width:340px\)/);

    const send = async (action, payload = {}, id = action) => {
      await receiveMessage({channel:'aipi.ide.v1', type:'request', id, action, payload});
      const response = posted.findLast((entry) => entry.type === 'response' && entry.id === id);
      assert.ok(response, `bridge returned ${id}`);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      return response.result;
    };

    const sendDashboard = async (action, payload = {}, id = `dashboard-${action}`) => {
      await receiveMessage({type:'aipi:request', id, action, ...payload});
      const response = posted.findLast((entry) => entry.type === 'aipi:response' && entry.id === id);
      assert.ok(response, `full dashboard bridge returned ${id}`);
      if (response.error) throw Object.assign(new Error(response.error), {status:response.status, payload:response.payload});
      return response.result;
    };

    const snapshot = await send('bootstrap');
    assert.equal(snapshot.project.id, 'test-project');
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.contracts.length, 1, 'the native panel receives a scoped K Map inventory');
    assert.equal(snapshot.contracts[0].references[0].path, sourceFile, 'K Map source references resolve to editor-openable workspace files');
    assert.equal(snapshot.requests[0].id, 'request', 'K Maps includes saved requests');
    assert.equal(snapshot.collections[0].requestCount, 1, 'K Maps includes workflow collections');
    assert.equal(snapshot.settings.goal, 'Keep APIs healthy.');
    assert.equal(snapshot.agentCapabilities.vscodeChat, true, 'the extension reports the detected chat adapter instead of assuming an agent is available');
    assert.ok(snapshot.agentCapabilities.targets.includes('Workspace context file + clipboard'));
    assert.equal(snapshot.environments[0].variableKeys.some((entry) => entry.key === 'API_TOKEN' && entry.value), false, 'environment snapshots never expose secret values');
    assert.equal(snapshot.taskRecords[0].acceptanceCriteria[0], 'Request passes');
    assert.equal(cache.get('aipi.ide.snapshot.v1').project.id, 'test-project', 'a sanitized local workspace cache is stored');

    await vscode.commands.executeCommand('aipi.assessWorkingChanges');
    assert.ok(posted.some((entry) => entry.type === 'openObject' && entry.payload?.view === 'explore' && entry.payload?.section === 'assessment'));
    await vscode.commands.executeCommand('aipi.openRepairHandoff');
    assert.ok(posted.some((entry) => entry.type === 'openObject' && entry.payload?.view === 'tasks' && entry.payload?.section === 'context'));
    await vscode.commands.executeCommand('aipi.reviewRequiredChecks');
    assert.ok(posted.some((entry) => entry.type === 'openObject' && entry.payload?.view === 'tasks' && entry.payload?.section === 'checks'));
    await vscode.commands.executeCommand('aipi.inspectDeploymentBlocker');
    assert.ok(posted.some((entry) => entry.type === 'openObject' && entry.payload?.view === 'kmaps' && entry.payload?.section === 'compatibility'));

    const terminal = await send('openTaskTerminal', {taskId:'task', command:{command:'npm', args:['run','test'], cwd:'.'}, cwd:'.', planHash:'sha256:test'}, 'task-terminal');
    assert.equal(terminal.opened, true);
    assert.equal(terminalCwd, await fs.realpath(root), 'reviewed checks open in the connected workspace');
    assert.equal(terminalCommand, "npm 'run' 'test'");
    assert.equal(terminalExecutesImmediately, false, 'terminal stages the reviewed command without claiming or starting a test run');
    await assert.rejects(send('openTaskTerminal', {taskId:'task', command:{command:'npm',args:['run','test'],cwd:'..'},cwd:'..',planHash:'sha256:test'}, 'terminal-outside-root'), /inside the connected workspace/);
    await assert.rejects(send('openTaskTerminal', {taskId:'task', command:{command:'npm;rm',args:[]},cwd:'.',planHash:'sha256:test'}, 'terminal-shell-command'), /named executable/);
    terminalCommand = '';

    const scoped = await send('api', {path:'/api/state', method:'GET'}, 'scoped-state');
    assert.deepEqual(scoped.projects.map((entry) => entry.id), ['test-project']);
    assert.deepEqual(scoped.timeline.map((entry) => entry.id), ['current-event']);
    const dashboardState = await sendDashboard('api', {path:'/api/state', method:'GET'});
    assert.deepEqual(dashboardState.projects.map((entry) => entry.id), ['test-project'], 'the shared dashboard uses the same scoped IDE API bridge');
    assert.equal((await send('api', {path:'/api/team-sync/status?projectId=test-project', method:'GET'}, 'team-status')).ready, true);
    await assert.rejects(send('api', {path:'/api/team-sync/status?projectId=other-project', method:'GET'}, 'foreign-team-status'), /current IDE workspace/);
    companionState.workspaceGroups = [{id:'wsg_security',projectIds:['test-project','other-project']}];
    assert.deepEqual((await send('api',{path:'/api/workspaces',method:'GET'},'workspace-list')).workspaces,[], 'Unopened repositories are not exposed');
    await assert.rejects(send('api',{path:'/api/workspaces/wsg_security/targets',method:'GET'},'workspace-targets'),/Open every repository/);
    await assert.rejects(send('api',{path:'/api/workspaces/wsg_security/change-assessment',method:'POST',body:{project_id:'test-project',base_ref:'HEAD'}},'workspace-assess-denied'),/Open every repository/);
    await assert.rejects(send('api',{path:'/api/workspaces/wsg_security/change-assessment/review',method:'POST',body:{project_id:'test-project',base_ref:'HEAD'}},'workspace-review-denied'),/Open every repository/);
    await assert.rejects(send('api',{path:'/api/workspaces/wsg_security/change-assessment/execute',method:'POST',body:{project_id:'test-project',base_ref:'HEAD',review_hash:'sha256:example'}},'workspace-execute-denied'),/Open every repository/);
    await assert.rejects(send('api',{path:'/api/workspaces/wsg_security/change-assessment/package',method:'POST',body:{project_id:'test-project',base_ref:'HEAD',review_hash:'sha256:example',share_source:true}},'workspace-package-denied'),/Open every repository/);
    companionState.projects[0].tasks[0].targetRefs = [{projectId:'other-project',entityId:'foreign',kind:'page'}];
    await assert.rejects(send('prepareHandoff',{taskId:'task'},'foreign-handoff'),/outside the trusted open IDE workspace/);
    companionState.projects[0].tasks[0].targetRefs = [];
    companionState.workspaceGroups = [];
    await assert.rejects(send('api', {path:'/api/state', method:'PUT', body:{...scoped, projects:[...scoped.projects, {id:'other-project'}]}}, 'cross-project'), /only save the current workspace project/);
    await send('api', {path:'/api/projects/test-project/tasks/task', method:'POST', body:{task:{title:'Scoped edit'}}}, 'task-update');
    assert.ok(apiCalls.some((call) => call.route === '/api/projects/test-project/tasks/task' && call.method === 'POST'));
    await send('api', {path:'/api/projects/test-project/tasks/search-context', method:'POST', body:{query:'GET /api/users'}}, 'task-search');
    assert.ok(apiCalls.some((call) => call.route === '/api/projects/test-project/tasks/search-context' && call.method === 'POST'));
    await assert.rejects(send('api', {path:'/api/projects/other-project/tasks/search-context', method:'POST', body:{query:'GET /api/users'}}, 'cross-project-search'), /outside the current IDE workspace/);
    await assert.rejects(send('api', {path:'/api/projects/other-project/tasks/task', method:'POST', body:{task:{title:'Cross-project'}}}, 'cross-project-task'), /outside the current IDE workspace/);

    const savedMilestone = await send('saveMilestone',{title:'API Readiness',description:'Ship the core API checks.',targetDate:'2026-12-01'},'milestone-save');
    const milestoneId = savedMilestone.milestoneId;
    assert.equal(savedMilestone.snapshot.milestones[0].title,'API Readiness');
    await assert.rejects(send('removeMilestone',{milestoneId:'missing-milestone'},'missing-milestone'),/not found in this project/);
    const updatedSettings = await send('saveProjectSettings',{name:'AIPI Test Workspace',goal:'Keep local API evidence current.',activeEnvironmentId:'env'},'settings-save');
    assert.equal(updatedSettings.project.name,'AIPI Test Workspace');
    assert.equal(updatedSettings.settings.goal,'Keep local API evidence current.');
    await assert.rejects(send('saveProjectSettings',{activeEnvironmentId:'other-env'},'cross-project-environment'),/Choose an environment in this project/);
    const mcpResult = await send('api',{path:'/api/tools/call',method:'POST',body:{name:'get_project_context',arguments:{project_id:'test-project'}}},'scoped-mcp');
    assert.equal(mcpResult.structuredContent.tool,'get_project_context');
    const revisionVerification = await send('api',{path:'/api/tools/call',method:'POST',body:{name:'verify_contract_revision',arguments:{project_id:'test-project',contract_id:'contract'}}},'revision-verification');
    assert.equal(revisionVerification.structuredContent.tool,'verify_contract_revision','the required post-edit verification tool remains available through the scoped panel bridge');

    const discovery = await send('discoverTaskContext', {taskId:'task'}, 'discover-task');
    assert.equal(discovery.search.matches, 1, 'task discovery searches the MCP knowledge graph before preparing the chain');
    assert.ok(apiCalls.some((call) => /\/discover-context$/.test(call.route)), 'task discovery refreshes and persists bounded context');

    const handoff = await send('prepareHandoff', {taskId:'task'}, 'handoff');
    assert.equal(handoff.context.artifacts, 1);
    assert.equal(handoff.handoffId, 'handoff-task', 'the IDE handoff is persisted through the MCP backend');
    assert.ok(apiCalls.some((call) => call.route === '/api/tools/call' && JSON.parse(call.body).name === 'record_handoff_dispatch'), 'the actual chat/fallback dispatch outcome is persisted');
    const savedContext = await fs.readFile(path.join(root, '.aipi', 'active-context.md'), 'utf8');
    assert.match(savedContext, /Fix handler/);
    assert.match(savedContext, /src\/handler\.ts/);
    assert.equal(clipboardText, savedContext);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].editor.selection.start.line, 1);
    assert.equal(opened[0].editor.selection.end.line, 2);

    const statusSnapshot = await send('updateTaskStatus', {taskId:'task', status:'in-progress'}, 'task-status');
    assert.equal(statusSnapshot.tasks[0].status, 'in-progress', 'task lifecycle updates remain scoped to the IDE project');
    const verification = await send('verifyTask', {taskId:'task'}, 'verify-task');
    assert.equal(verification.receipt.result, 'Verified', 'task verification runs through the companion route');
    const verifyCall = apiCalls.findLast((call) => /\/verify$/.test(call.route) && call.method === 'POST');
    assert.ok(verifyCall, 'verification executes after plan review');

    const run = await send('runAgent', {taskId:'task', question:'Check the handler.'}, 'run-agent');
    await waitUntil(() => posted.some((entry) => entry.type === 'stream' && entry.streamId === run.streamId && entry.phase === 'completed'), 'agent stream did not complete');
    const completed = posted.findLast((entry) => entry.type === 'stream' && entry.streamId === run.streamId && entry.phase === 'completed');
    assert.equal(completed.payload.mode, 'chat-handoff', 'implementation work is handed to the IDE coding-agent chat instead of a tool-less language-model request');
    assert.equal(completed.payload.handoffId, 'handoff-task');
    assert.ok(posted.some((entry) => entry.type === 'stream' && entry.streamId === run.streamId && entry.phase === 'context'), 'stream reports bounded-context readiness');

    await send('openSource', {path:'src/handler.ts', line:2, endLine:3}, 'open');
    assert.equal(opened.at(-1).editor.selection.start.line, 1);
    outsideFile = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
    await fs.writeFile(outsideFile, 'keep unchanged', 'utf8');
    await assert.rejects(send('openSource', {path:outsideFile, line:1}, 'outside'), /inside the current AIPI workspace/);

    await fs.unlink(path.join(root, '.aipi', 'active-context.md'));
    await fs.symlink(outsideFile, path.join(root, '.aipi', 'active-context.md'));
    await assert.rejects(send('sendContextToAgent', {promptText:'must not overwrite', artifacts:[]}, 'symlink'), /regular file inside \.aipi/);
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'keep unchanged');

    await send('openDashboard', {}, 'dashboard');
    assert.equal(wideOpenCount, 1, 'the full AIPI workspace opens as a native editor panel without a browser URL');
    assert.equal(widePanel.iconPath.fsPath, path.join(extensionRoot, 'media', 'aipi-logo.png'), 'the editor tab uses the AIPI product logo');
    assert.equal(externalUrl, '', 'the IDE workflow does not expose or navigate to a companion URL');
    await assert.rejects(send('openTeamCloud', {}, 'old-team-companion'), /Update the AIPI extension/);
    assert.equal(externalUrl, '', 'an older companion does not open a broken Team Cloud handoff');
    teamOnboardingAvailable = true;
    await send('openTeamCloud', {}, 'team-companion');
    assert.match(externalUrl, /\/(workspace\/connect|team)#project=test-project&port=49157&ticket=/);
    assert.doesNotMatch(externalUrl, /access_token|refresh_token/, 'browser handoff never puts team session tokens in the URL');
    externalUrl = '';
    companionAvailable = false;
    await send('initializeCompanion', {}, 'initialize');
    assert.equal(terminalCommand, '', 'companion setup is managed by the extension and does not require terminal interaction');
    assert.equal(spawnedCompanion.command, 'node', 'one-click setup uses the bundled companion');
    assert.deepEqual(spawnedCompanion.args, [path.join(extensionRoot, 'companion/scripts/aipi-cli-bundle.mjs'), 'open', '--no-open'], 'setup starts the shared companion without opening a browser');
    spawnedCompanion = undefined;
    companionBusy = true;
    await assert.rejects(send('initializeCompanion', {}, 'busy-companion'), /may be busy/);
    assert.equal(spawnedCompanion, undefined, 'a companion that times out is busy, not missing, so no second companion is started');
    companionBusy = false;
    settings['companion.autoStart'] = false;
    companionAvailable = false;
    await assert.rejects(send('initializeCompanion', {}, 'autostart-disabled'), /automatic start is disabled/);
    assert.equal(spawnedCompanion, undefined, 'disabled automatic start never launches a companion');
    settings['companion.autoStart'] = true;
    settings['companion.launchCommand'] = ['/usr/local/bin/node', '/opt/aipi/scripts/aipi-cli-bundle.mjs', 'open', '--no-open'];
    await send('initializeCompanion', {}, 'development-launch');
    assert.equal(spawnedCompanion.command, '/usr/local/bin/node', 'development launch command replaces the bundled launcher');
    assert.deepEqual(spawnedCompanion.args, ['/opt/aipi/scripts/aipi-cli-bundle.mjs', 'open', '--no-open']);
    settings['companion.launchCommand'] = ['/usr/local/bin/node', '/opt/aipi/scripts/aipi-cli-bundle.mjs', 'daemon'];
    companionAvailable = false;
    await send('initializeCompanion', {}, 'development-daemon');
    assert.equal(spawnedCompanion.args.at(-1), 'daemon', 'a long-running configured daemon becomes ready without exiting');
    delete settings['companion.launchCommand'];
    settings['workspace:companion.launchCommand'] = ['/untrusted/repository/command'];
    companionAvailable = false;
    await send('initializeCompanion', {}, 'untrusted-launch');
    assert.equal(spawnedCompanion.command, 'node', 'repository workspace settings cannot supply executable commands');
    delete settings['workspace:companion.launchCommand'];
    const beforeArchive = await send('api',{path:'/api/state',method:'GET'},'state-before-archive');
    beforeArchive.projects[0].tasks[0].milestoneIds = [milestoneId];
    await send('api',{path:'/api/state',method:'PUT',body:beforeArchive},'link-milestone');
    await assert.rejects(send('removeMilestone',{milestoneId},'delete-linked-milestone'),/Move linked tasks/);
    const unlinkMilestone = await send('api',{path:'/api/state',method:'GET'},'state-before-unlink');
    unlinkMilestone.projects[0].tasks[0].milestoneIds = [];
    await send('api',{path:'/api/state',method:'PUT',body:unlinkMilestone},'unlink-milestone');
    await send('removeMilestone',{milestoneId},'delete-milestone');
    const archived = await send('archiveTask',{taskId:'task'},'archive-task');
    assert.equal(archived.tasks.length,0);
    assert.equal(archived.archivedTasks[0].id,'task');

    const otherSource = path.join(otherRoot, 'src', 'other.ts');
    await fs.mkdir(path.dirname(otherSource), {recursive:true});
    await fs.writeFile(otherSource, 'other workspace source\n');
    workspaceFolders.push(otherWorkspaceFolder);
    companionState.workspaceGroups = [{id:'wsg_security',projectIds:['test-project','other-project']}];
    assert.equal((await send('api',{path:'/api/workspaces',method:'GET'},'open-group')).workspaces.length,1);
    await send('openSource',{path:otherSource,line:1},'registered-multi-root-source');
    companionState.projects[0].tasks[0].targetRefs = [{projectId:'other-project',entityId:'foreign',kind:'page'}];
    await assert.rejects(send('prepareHandoff',{taskId:'task',openChat:false},'registered-multi-root-handoff'),/regular file inside \.aipi/, 'Authorized roots proceed to the existing symlink guard');
    companionState.projects[0].tasks[0].targetRefs = [];
    companionState.workspaceGroups = [];
    companionState.projects = companionState.projects.filter((entry) => entry.id !== 'other-project');
    activeEditorChanged({document:{uri:{scheme:'file', fsPath:otherSource}}});
    activeEditorChanged({document:{uri:{scheme:'file', fsPath:otherSource}}});
    await waitUntil(() => posted.filter((entry) => entry.type === 'event' && entry.event === 'workspaceChanged' && entry.payload.projectId === 'other-project').length >= 2, 'overlapping active-editor changes did not finish binding the workspace');
    assert.equal(projectCreations.length, 1, 'overlapping connections register a workspace only once');
    assert.match(projectCreations[0].idempotencyKey, /^vscode-[a-f0-9]{32}$/);
    assert.notEqual(projectCreations[0].name, 'AIPI Test Workspace', 'same-named workspace folders receive distinct AIPI project names');
    await send('openSource', {path:otherSource, line:1}, 'open-other');
    await assert.rejects(send('openSource', {path:sourceFile, line:1}, 'old-workspace'), /inside the current AIPI workspace/);
    assert.equal(typeof selectionChanged, 'function', 'selection changes are bridged to the panel');
    assert.match(chatPrompt, /Check the handler\./, 'the bounded prompt opens in the IDE coding-agent chat');
    assert.match(chatPrompt, /verify_contract_revision/, 'the IDE agent receives the mandatory post-edit verification loop');
    console.log('VS Code/Cursor side-panel bridge, bounded handoff and agent stream passed');
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (outsideFile) await fs.rm(outsideFile, {force:true});
    await fs.rm(root, {recursive:true, force:true});
    await fs.rm(otherRoot, {recursive:true, force:true});
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
