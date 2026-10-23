const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const exactRoutes = new Set([
  'GET /health', 'GET /api/connection', 'GET /api/state', 'PUT /api/state',
  'POST /api/team-onboarding/start',
  'GET /api/team-sync/status', 'GET /api/team-sync/tasks',
  'POST /api/projects', 'POST /api/scan', 'GET /api/scan-status', 'GET /api/timeline',
  'GET /api/git/status', 'POST /api/git/binding', 'POST /api/git/publish-plan',
  'POST /api/git/publish', 'POST /api/send', 'POST /api/diagnose', 'POST /api/tools/call',
  'GET /api/vault/status', 'POST /api/vault/initialize', 'POST /api/vault/rotate',
  'POST /api/vault/credentials', 'POST /api/vault/import-env', 'POST /api/vault/revoke',
  'POST /api/vault/test-connection',
  'GET /api/runtime-mesh/status', 'POST /api/runtime-mesh/reload', 'POST /api/runtime-mesh/stop'
]);

const routePatterns = [
  ['GET', /^\/api\/workspaces(?:\/[^/]+(?:\/(?:targets|target|relationships|relationship-reviews|checkouts|manifest|release-compatibility|tasks\/[^/]+\/context))?)?$/],
  ['POST', /^\/api\/workspaces\/[^/]+\/(?:relationships|relationship-reviews|receipts|tasks(?:\/(?:append|[^/]+\/context-pack))?)$/],
  ['POST', /^\/api\/workspaces\/[^/]+\/change-assessment$/],
  ['POST', /^\/api\/workspaces\/[^/]+\/change-assessment\/(?:review|execute|package)$/],
  ['DELETE', /^\/api\/projects\/[^/]+$/],
  ['GET', /^\/api\/projects\/[^/]+\/traffic\/status$/],
  ['POST', /^\/api\/projects\/[^/]+\/traffic\/(?:start|stop)$/],
  ['POST', /^\/api\/projects\/[^/]+\/tasks\/search-context$/],
  ['GET', /^\/api\/projects\/[^/]+\/check-catalog$/],
  ['GET', /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/verification-jobs\/[^/]+$/],
  ['POST', /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/verification-jobs(?:\/[^/]+\/cancel)?$/],
  ['POST', /^\/api\/projects\/[^/]+\/tasks$/],
  ['POST', /^\/api\/projects\/[^/]+\/tasks\/[^/]+$/],
  ['POST', /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/(?:discover-context|prepare-context|context)$/],
  ['POST', /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/(?:commit-pack|deployment-preflight)$/],
  ['GET', /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/(?:verify|verification-plan)$/],
  ['POST', /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/(?:verify|verification-plan)$/],
  ['GET', /^\/api\/projects\/[^/]+\/graph$/],
  ['GET', /^\/api\/projects\/[^/]+\/graph\/traverse$/],
  ['POST', /^\/api\/projects\/[^/]+\/graph\/edges\/(?:confirm|reject)$/],
  ['POST', /^\/api\/projects\/[^/]+\/contracts\/[^/]+\/task-draft$/],
  ['POST', /^\/api\/projects\/[^/]+\/findings\/[^/]+\/(?:task-draft|generate-test)$/]
];

const allowedTools = new Set([
  'get_task_candidates', 'get_artifact_evidence', 'get_project_context', 'list_tasks',
  'get_task_context', 'find_task_artifacts', 'get_context_pack_manifest', 'get_contract_kmap',
  'list_contract_evidence', 'verify_contract_revision', 'get_task_verification_plan',
  'verify_task_changes', 'get_verification_report', 'get_endpoint_context', 'diff_contract',
  'get_run_evidence', 'get_project_timeline', 'get_secret_storage_status', 'generate_fixture',
  'verify_changes', 'report_agent_finding', 'search_knowledge_graph', 'traverse_upstream',
  'traverse_downstream', 'find_graph_blind_spots', 'analyze_and_repair_contract',
  'discover_task_context', 'prepare_task_handoff', 'propose_tasks_from_context', 'review_and_run_task_verification',
  'start_task_check_job', 'get_task_check_job', 'cancel_task_check_job', 'record_handoff_dispatch',
  'create_handoff', 'get_latest_handoff', 'complete_handoff',
  'aipi_get_cross_repo_contracts', 'aipi_check_impact', 'aipi_get_handoff',
  'get_workspace_manifest', 'list_workspace_checkouts'
]);

class CompanionClient {
  constructor(options = {}) {
    this.connectionFile = options.connectionFile || process.env.AIPI_CONNECTION_FILE || path.join(os.homedir(), '.api-forge', 'daemon.json');
    this.timeoutMs = options.timeoutMs || 120000;
  }

  isAllowed(route, method) {
    const pathname = new URL(route, 'http://127.0.0.1').pathname;
    return exactRoutes.has(`${method} ${pathname}`)
      || routePatterns.some(([candidateMethod, pattern]) => candidateMethod === method && pattern.test(pathname));
  }

  async connection() {
    let contents;
    try { contents = await fs.readFile(this.connectionFile, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('AIPI companion is not running for this user.'), {code:'COMPANION_NOT_RUNNING'});
      throw error;
    }
    let connection;
    try { connection = JSON.parse(contents); }
    catch { throw new Error('The AIPI companion connection file is invalid. Restart the companion from the AIPI panel.'); }
    const url = new URL(connection.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || !connection.token) {
      throw new Error('Invalid local companion connection');
    }
    return {url, token:connection.token, pid:Number.isSafeInteger(connection.pid) ? connection.pid : null};
  }

  async request(route, method = 'GET', body) {
    if (route === '/api/tools/call' && !allowedTools.has(body?.name)) throw new Error('Tool is not available through the panel bridge');
    if (!this.isAllowed(route, method)) throw new Error('Unsupported companion operation');
    const connection = await this.connection();
    let response;
    try { response = await fetch(new URL(route, connection.url.origin), {
      method,
      redirect:'error',
      signal:AbortSignal.timeout(this.timeoutMs),
      headers:{authorization:`Bearer ${connection.token}`, 'content-type':'application/json'},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})
    }); }
    catch (error) {
      // A timeout means a companion is listening but busy (for example, scanning while holding the
      // workspace lock). Report it separately so callers never start a second companion for it.
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw Object.assign(new Error(`AIPI local companion at ${connection.url.origin} did not respond within ${Math.round(this.timeoutMs / 1000)} seconds. It may be busy; another companion was not started.`), {code:'COMPANION_BUSY', cause:error});
      }
      if (error?.cause?.code === 'ECONNREFUSED' && connection.pid > 0) {
        try { process.kill(connection.pid, 0); }
        catch (check) {
          if (check.code === 'ESRCH') throw Object.assign(new Error('AIPI local companion is no longer running.'), {code:'COMPANION_UNAVAILABLE', cause:error});
        }
      }
      throw Object.assign(new Error('AIPI local companion could not be reached; its status is uncertain, so no replacement was started.'), {code:'COMPANION_UNKNOWN', cause:error});
    }
    let payload;
    try { payload = await response.json(); }
    catch { payload = {error:`Companion returned an invalid response (${response.status})`}; }
    if (!response.ok) throw Object.assign(new Error(payload.error || `Companion returned ${response.status}`), {status:response.status, payload});
    return payload;
  }
}

module.exports = {CompanionClient, allowedTools};
