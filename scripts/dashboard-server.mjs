import {workspaceIdentity,saveSourceBinding,attachSourceCheckout} from "../packages/core/workspace-identity.mjs";
import {reconcileTeamRepositories} from "../packages/core/team-repository-reconcile.mjs";
import {projectGitBinding,saveProjectGitBinding} from "../packages/core/project-git-bindings.mjs";
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import { watch as watchFileSystem } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import net from "node:net";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { addHistory, DATA_DIR, DATA_FILE, defaultProject, defaultRequest, loadState, mutateState, newId, publicState, variablesFor } from "./workspace-store.mjs";
import { captureGitEvidence, configureGitBinding, inspectGitBinding, inspectRemoteGitSync, planGitPublish, publishGitHead } from "../packages/core/git-evidence.mjs";
import { appendTimelineEvent, timelineForProject, workspaceChangeEvent } from "../packages/core/timeline.mjs";
import { deleteSecretForScope, initializeSecretStorage, preserveRedactedStateSecrets, rotateSecretStorageKey, secretStorageStatus, storeEncryptedSecretForScope, storeSecretForScope } from "../packages/core/secret-vault.mjs";
import { discoverRouteHandlers } from "../packages/contract-engine/route-adapters.mjs";
import { httpCalls } from "../packages/contract-engine/http-source.mjs";
import { incrementalSourceIndex } from "../packages/contract-engine/incremental-index.mjs";
import { normalizeOtelMetrics, normalizeOtelTraces, summarizeOtelBatch } from "../packages/local-observer/otel.mjs";
import { readTraffic, startTrafficProxy } from "../packages/local-observer/index.mjs";
import { startPairingClient } from "../packages/local-observer/pairing-client.mjs";
import { createProjectRecord, preserveProjectEvidence } from "../packages/core/project-service.mjs";
import { normalizeWorkspaceGroups, saveWorkspaceGroup, searchWorkspaceTargets, getWorkspaceTarget, relationshipReviews, reviewWorkspaceRelationship, workspaceGroup, buildWorkspaceProjection } from "../packages/core/workspace-groups.mjs";
import { canonicalGithubRepositoryRemote, exportWorkspaceManifest, normalizeRepositoryBinding, saveWorkspaceManifest, saveWorkspaceCheckoutBinding, verifyGithubRepositoryIdentity, workspaceCheckoutBindings } from "../packages/core/workspace-manifest.mjs";
import { openTeamSyncStore } from "../packages/core/team-sync-store.mjs";
import { syncTeamOnce } from "../packages/core/team-sync-client.mjs";
import { createTeamSessionManager } from "../packages/core/team-session-manager.mjs";
import { saveTeamSession, loadTeamSession, deleteTeamSession } from "../packages/core/team-session-credentials.mjs";
import { resolveCachedTeamContext } from "../packages/core/team-sync-context.mjs";
import { TeamOnboardingTickets, teamProjectPreview, teamWorkspacePreview, enqueueInitialTeamTasks, teamTaskExternalId, teamTaskStatus } from "../packages/core/team-onboarding.mjs";
import { exchangeTeamOAuthCode } from "../packages/core/team-oauth.mjs";
import { rememberLinkedTasks, reconcileLocalTeamTasks } from "../packages/core/team-local-reconcile.mjs";
import { synthesizeTaskFromFinding, synthesizeTaskFromContract } from "../packages/core/contracts-evidence.mjs";
import { runPostIndexBootstrapper } from "../packages/core/post-index-bootstrapper.mjs";
import { hydrateProjectTeamMemory, syncProjectTeamMemory } from "../packages/core/team-memory.mjs";
import { ensureTaskVerificationPlan, executeTaskVerificationPlan } from "../packages/core/verification-runner.mjs";
import { buildProjectKnowledgeGraph, discoverTaskContext, findGraphBlindSpots, promoteRuntimeEdge, traverseKnowledgeGraph } from "../packages/core/knowledge-graph.mjs";
import { taskArtifacts } from "../packages/core/task-context.mjs";
import { refreshAndPrepareTaskContext } from "../packages/core/context-freshness.mjs";
import { markImportedPayloadUntrusted } from "../packages/core/security-redactor.mjs";
import { ingestOtelEvidence } from "../packages/core/otel-evidence-ingestor.mjs";
import { generateObservedVitest } from "../packages/contract-engine/index.mjs";
import { writeRegressionTest } from "../packages/test-generators/index.mjs";
import { normalizeTaskIntent, supportedTaskIntents } from "../packages/core/task-intent.mjs";
import { buildCommitPack } from "../packages/core/commit-pack.mjs";
import { evaluateDeploymentGate } from "../packages/core/deployment-gate.mjs";
import { evaluateReleaseCompatibility } from "../packages/core/release-compatibility.mjs";
import { buildPublishImpactReview, issuePublishReviewToken, acceptPublishReviewToken } from "../packages/core/publish-impact-review.mjs";
import { proposeTasksFromAssessment } from "../packages/core/task-proposals.mjs";
import { createTaskVerificationJob, markInterruptedVerificationJobs, requestVerificationJobCancellation, runTaskVerificationJob } from "../packages/core/verification-jobs.mjs";
import { runLocalChangeAssessmentTool, readLocalAssessmentSnapshot, readLocalAssessmentEvidenceKey, getOrCreateLocalAssessmentEvidenceKey } from "../packages/core/change-assessment-tools.mjs";
import { assessLocalWorkspaceChange } from "../packages/core/change-assessment.mjs";
import { reviewAssessmentChecks, executeReviewedAssessment, acceptLocalAssessmentEvidence } from "../packages/core/assessment-proof.mjs";
import { createVerificationPackageManifest } from "../packages/core/verification-package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = path.join(ROOT, "ui");
const HOST = "127.0.0.1";
function basePort() { return Number(process.env.AIPI_PORT || process.env.API_FORGE_PORT || 49152); }
function maxPort() { return Number(process.env.AIPI_MAX_PORT || basePort() + 8); }
let dashboardUrl = `http://${HOST}:${basePort()}`;
const sessionToken = process.env.AIPI_TOKEN || `sec_${crypto.randomBytes(18).toString("base64url")}`;
const defaultAllowedOrigins = ["https://app.aipi.dev", "https://app.aipi.website", "https://aipi.website", "https://www.aipi.website", "https://aipi.ceo-935.workers.dev", "https://aipi-team-cloud.ceo-935.workers.dev"];
const configuredOrigins = String(process.env.AIPI_APP_ORIGIN || "").split(",");
const allowedOrigins = new Set([...defaultAllowedOrigins, ...configuredOrigins].map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean));
let outboundPairing = null;
let outboundPairingStatus = { status: "offline" };
const sourceScanOperations = new Map();
let runtimeMeshGateway = { server: null, status: "stopped", projectId: null, environmentId: null, port: null, startedAt: null, lastError: null };
const trafficRecorders = new Map();
const projectWatchers = new Map();
const projectWatchDebounce = new Map();
const execFileAsync = promisify(execFile);

export async function executeLinkedTestCommand(project, configuredCommand) {
  const specification = typeof configuredCommand === "string"
    ? { command: configuredCommand.trim().split(/\s+/)[0], args: configuredCommand.trim().split(/\s+/).slice(1) }
    : configuredCommand;
  const roots = [...new Set((project.sourceContext?.roots ?? []).map(r => r.path))];
  const root = specification?.repositoryRoot ?? (roots.length === 1 ? roots[0] : null);
  if (!root || !roots.includes(root)) throw new Error("Choose an explicit registered repositoryRoot for this test command when the project has multiple roots.");
  if (!specification?.command || /[/\\]/.test(specification.command)) throw new Error("Linked test commands must name an executable without a path.");
  const resolvedRoot = await fs.realpath(path.resolve(root));
  const commandCwd = path.resolve(resolvedRoot, specification.cwd ?? ".");
  const lexicalRelative = path.relative(resolvedRoot, commandCwd);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) throw new Error("Linked test command cwd must remain inside the repository root.");
  const realCwd = await fs.realpath(commandCwd);
  const realRelative = path.relative(resolvedRoot, realCwd);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error("Linked test command cwd resolves outside the repository root.");
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|COOKIE|PRIVATE[_-]?KEY|API[_-]?KEY)/i.test(key)));
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(specification.command, specification.args ?? [], { cwd: realCwd, env: inheritedEnvironment, encoding: "utf8", timeout: Math.min(300_000, Number(specification.timeoutMs) || 120_000), maxBuffer: 2_000_000 });
    return { passed: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, durationMs: Date.now() - startedAt, timedOut: false };
  } catch (error) {
    const timedOut = error.killed === true || error.code === "ETIMEDOUT";
    return { passed: false, exitCode: Number(error.code) || 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, output: `${error.stdout ?? ""}${error.stderr ?? error.message}`, durationMs: Date.now() - startedAt, timedOut, errorCode: String(error.code ?? "") };
  }
}

export async function discoverProjectCheckCatalog(project) {
  const rootEntry = project.sourceContext?.roots?.find((entry) => entry.kind === "workspace") ?? project.sourceContext?.roots?.[0];
  if (!rootEntry?.path) return [];
  let root;
  let packageFile;
  try {
    root = await fs.realpath(rootEntry.path);
    packageFile = await fs.realpath(path.join(root, "package.json"));
    const relative = path.relative(root, packageFile);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return [];
  } catch { return []; }
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(packageFile, "utf8")); }
  catch { return []; }
  const scripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const names = Object.keys(scripts).filter((name) => /^(test|check|lint|typecheck|verify)(?:$|[:.-])/i.test(name) && /^[A-Za-z][A-Za-z0-9:._-]{0,79}$/.test(name)).slice(0, 40);
  let manager = String(manifest.packageManager ?? "").split("@")[0].toLowerCase();
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) {
    const lockFiles = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"];
    for (const lock of lockFiles) {
      try { await fs.access(path.join(root, lock)); manager = lock.startsWith("pnpm") ? "pnpm" : lock.startsWith("yarn") ? "yarn" : lock.startsWith("bun") ? "bun" : "npm"; break; }
      catch {}
    }
  }
  manager ||= "npm";
  return names.map((script) => ({
    id: `${manager}:${script}`,
    name: script,
    command: { command: manager, args: manager === "npm" ? ["run", script] : ["run", script], cwd: "." },
    packageFile: path.relative(root, packageFile),
    source: "package.json",
    trust: "review-required",
    scriptPreview: String(scripts[script]).slice(0, 240)
  }));
}

function projectAndAuthorizedRoot(state, projectId, requestedRoot) {
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const roots = project.sourceContext?.roots ?? [];
  const requested = path.resolve(String(requestedRoot || roots[0]?.path || ""));
  const authorized = roots.find((entry) => path.resolve(entry.path) === requested);
  if (!authorized) throw Object.assign(new Error("Select a source root authorized for this project"), { statusCode: 403, code: "SOURCE_NOT_AUTHORIZED" });
  return { project, root: authorized.path };
}

function publishSourceScan(projectId, update) {
  const previous = sourceScanOperations.get(projectId) ?? {};
  const operation = {
    projectId,
    status: "running",
    phase: "Preparing source scan",
    progress: 0,
    startedAt: previous.startedAt ?? new Date().toISOString(),
    ...previous,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  sourceScanOperations.set(projectId, operation);
  return operation;
}

export function sourceScanStatus(projectId) {
  return sourceScanOperations.get(projectId) ?? { projectId, status: "idle", phase: "Ready", progress: 0 };
}

const mime = { ".png": "image/png", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };

function json(response, status, payload) {
  response.writeHead(status, { "content-type": mime[".json"], "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie ?? "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) return decodeURIComponent(cookie.slice(separator + 1).trim());
  }
  return null;
}

function hasLocalSession(request) {
  return request.headers.authorization === `Bearer ${sessionToken}` || cookieValue(request, "aipi_session") === sessionToken;
}

async function bodyJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 10_000_000) throw new Error("Request payload is too large");
  }
  return text ? JSON.parse(text) : {};
}

function environmentServices(environment) {
  if (environment?.services?.length) return environment.services.filter((entry) => entry.enabled !== false);
  const baseUrl = (environment?.variables ?? []).find((entry) => entry.key === "baseUrl" && entry.enabled !== false)?.value;
  return baseUrl ? [{ id: "primary", name: "Application", variableKey: "baseUrl", baseUrl, proxyPolicy: "direct", enabled: true }] : [];
}

function runtimeMeshConfig(environment) {
  const services = environmentServices(environment);
  const configured = environment?.runtimeMesh ?? {};
  const routes = Array.isArray(configured.routes) ? configured.routes : services.map((service, index) => ({ id: `mesh_route_${service.id}`, pattern: index === 0 ? "/api/*" : `/${service.variableKey}/*`, serviceId: service.id, targetPath: "/", stripPrefix: index !== 0, authPolicy: "preserve" }));
  return { gatewayPort: Number(configured.gatewayPort) || 8080, routes, policies: { autoForward: true, enforceTls: false, logUnmapped: true, webhookTunnel: false, ...(configured.policies ?? {}) } };
}

function meshRouteMatches(pattern, pathname) {
  if (!String(pattern).startsWith("/")) return false;
  if (pattern.endsWith("*")) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern;
}

function meshTargetUrl(route, service, incomingUrl) {
  const target = new URL(service.baseUrl);
  const prefix = route.pattern.endsWith("*") ? route.pattern.slice(0, -1) : route.pattern;
  const suffix = route.stripPrefix ? incomingUrl.pathname.slice(prefix.length) : incomingUrl.pathname;
  const root = String(route.targetPath || "/").replace(/\/+$/, "");
  target.pathname = `${root}/${String(suffix || "").replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  target.search = incomingUrl.search;
  return target;
}

function runtimeMeshErrorMessage(error) {
  const direct = String(error?.message ?? '').trim();
  if (direct) return direct;
  const nested = Array.isArray(error?.errors) ? error.errors.map((entry) => String(entry?.message ?? entry?.code ?? '').trim()).filter(Boolean) : [];
  return nested.join('; ') || String(error?.cause?.message ?? error?.code ?? 'The upstream service is unavailable.');
}

function meshStatus() {
  const { server, ...status } = runtimeMeshGateway;
  return { ...status, listening: Boolean(server?.listening) };
}

function trafficRecorderStatus(projectId) {
  const recorder = trafficRecorders.get(projectId);
  return recorder ? { status: "recording", projectId, url: recorder.url, target: recorder.target, startedAt: recorder.startedAt, captured: recorder.captured ?? 0, captureAuth: recorder.captureAuth === true } : { status: "stopped", projectId, captured: 0, captureAuth: false };
}

async function searchIndexedWorkspaceFiles(project, queryWords, limit = 12) {
  const matches = [];
  const seen = new Set();
  for (const root of project.sourceContext?.roots ?? []) {
    let cache;
    try { cache = JSON.parse(await fs.readFile(path.join(root.path, ".api-forge", "cache", "source-index-v1.json"), "utf8")); }
    catch { continue; }
    for (const [source, record] of Object.entries(cache.files ?? {})) {
      const result = record?.result ?? {};
      const haystack = `${source} ${JSON.stringify(result)}`.toLowerCase();
      const matchedTerms = queryWords.filter((word) => haystack.includes(word));
      if (!matchedTerms.length) continue;
      const relationship = result.frontendCalls?.length ? "Frontend API caller"
        : result.endpoints?.length ? "Backend route or handler"
        : result.schemas?.length ? "Schema or data model"
        : result.artifacts?.some((entry) => ["component", "page"].includes(entry.kind)) ? "Frontend component or page"
        : result.artifacts?.some((entry) => entry.kind === "test") ? "Test file"
        : "Indexed workspace file";
      const kind = result.artifacts?.find((entry) => ["component", "page", "test", "model", "document"].includes(entry.kind))?.kind ?? "document";
      const nativeId = `workspace_${crypto.createHash("sha256").update(`${root.path}:${source}`).digest("hex").slice(0, 24)}`;
      const id = `${kind}:${nativeId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      matches.push({ id, nativeId, kind, label: path.basename(source), source, root: root.path, matchedTerms, relationship, materialize: true });
    }
  }
  return matches.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || a.source.localeCompare(b.source)).slice(0, limit);
}

async function stopTrafficRecorder(projectId) {
  const recorder = trafficRecorders.get(projectId);
  if (!recorder) return trafficRecorderStatus(projectId);
  await recorder.close();
  trafficRecorders.delete(projectId);
  return { status: "stopped", projectId, target: recorder.target, startedAt: recorder.startedAt, stoppedAt: new Date().toISOString(), captured: recorder.captured ?? 0 };
}

async function generateTrafficRegressionTests(root, records = []) {
  const generated = [];
  const seen = new Set();
  for (const record of records) {
    const method = String(record.request?.method ?? "GET").toUpperCase();
    const route = record.request?.route;
    if (!route || Number(record.response?.status) < 200 || Number(record.response?.status) >= 400) continue;
    const key = `${method} ${route}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fixture = await generateObservedVitest({ root, endpoint: route, method, name: `${method} ${route} observed contract` });
    const stem = `${method.toLowerCase()}-${route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root"}`.slice(0, 72);
    const relative = path.join("tests", "aipi-generated", `${stem}.contract.test.ts`);
    const target = path.resolve(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(target, fixture.content, { flag: "wx", mode: 0o600 }); generated.push({ method, route, path: relative, privacy: fixture.privacy }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return generated;
}

function sourceMatchesChangedFile(source, root, changedFile) {
  if (!source || !changedFile) return false;
  const normalized = String(source).replaceAll("\\", "/");
  const relative = String(changedFile).replaceAll("\\", "/");
  const absolute = path.resolve(root, changedFile).replaceAll("\\", "/");
  return normalized === relative || normalized === absolute || normalized.endsWith(`/${relative}`);
}

export function ignoredWatcherPath(root, changedFile) {
  const relative = String(changedFile ?? "").replaceAll("\\", "/");
  if (!relative || /(^|\/)(?:\.git|node_modules|\.api-forge|\.aipi|dist|build)(\/|$)/.test(relative)) return true;
  const absolute = path.resolve(root, changedFile);
  const dataDirectory = path.resolve(DATA_DIR);
  if (absolute === path.resolve(DATA_FILE) || absolute === path.join(dataDirectory, "workspace.lock") || absolute.startsWith(`${path.join(dataDirectory, "workspace.lock")}.stale-`)) return true;
  return dataDirectory !== path.resolve(root) && (absolute === dataDirectory || absolute.startsWith(`${dataDirectory}${path.sep}`));
}

async function recordWorkingTreeImpact(projectId, root, changedFiles) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : [changedFiles]).filter((file) => !ignoredWatcherPath(root, file)))];
  if (!files.length) return;
  await mutateState((state) => {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) return;
    const source = project.sourceContext ?? {};
    const artifacts = [...(source.endpoints ?? []), ...(source.frontendCalls ?? []), ...(source.schemas ?? []), ...(source.artifacts ?? [])].filter((entry) => files.some((file) => sourceMatchesChangedFile(entry.source, root, file)));
    const ids = new Set(artifacts.map((entry) => entry.id));
    const contracts = (project.contracts ?? []).filter((entry) => entry.sourceArtifactIds?.some((id) => ids.has(id)) || files.some((file) => sourceMatchesChangedFile(entry.implementation?.source, root, file)));
    const timestamp = new Date().toISOString();
    const relativeFiles = files.map((file) => path.relative(root, path.resolve(root, file))).slice(0, 50);
    source.workingTreeImpact = { changedFile: relativeFiles[0], changedFiles: relativeFiles, changedFileCount: files.length, affectedContractIds: contracts.map((entry) => entry.id), affectedRoutes: contracts.map((entry) => `${entry.method} ${entry.route}`), changedAt: timestamp, status: contracts.length ? "verification-required" : "no-indexed-contract", warning: contracts.length ? `${files.length} changed file${files.length === 1 ? "" : "s"} may affect linked contracts; request and response fields require revision verification.` : `${files.length} changed file${files.length === 1 ? "" : "s"} are outside the current API contract graph.` };
    for (const task of project.tasks ?? []) if (task.contractIds?.some((id) => source.workingTreeImpact.affectedContractIds.includes(id))) task.contextStatus = "stale";
    project.updatedAt = timestamp;
  });
}

async function syncProjectWatchers() {
  const state = await loadState();
  const desired = new Map(state.projects.flatMap((project) => (project.sourceContext?.roots ?? []).map((root) => [`${project.id}:${path.resolve(root.path)}`, { projectId: project.id, root: path.resolve(root.path) }])));
  for (const [key, watcher] of projectWatchers) if (!desired.has(key)) { watcher.close(); projectWatchers.delete(key); }
  for (const [key, value] of desired) {
    if (projectWatchers.has(key)) continue;
    try {
      const watcher = watchFileSystem(value.root, { recursive: true }, (_event, filename) => {
        if (ignoredWatcherPath(value.root, filename)) return;
        const debounceKey = `${value.projectId}:${value.root}`;
        const pending = projectWatchDebounce.get(debounceKey) ?? { files: new Set(), timer: null };
        pending.files.add(filename);
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          projectWatchDebounce.delete(debounceKey);
          recordWorkingTreeImpact(value.projectId, value.root, [...pending.files]).catch(() => {});
        }, 500);
        projectWatchDebounce.set(debounceKey, pending);
      });
      watcher.on("error", () => { watcher.close(); projectWatchers.delete(key); });
      projectWatchers.set(key, watcher);
    } catch {}
  }
}

async function closeRuntimeMeshGateway() {
  const active = runtimeMeshGateway.server;
  if (!active) return;
  await new Promise((resolve) => active.close(() => resolve()));
  runtimeMeshGateway = { ...runtimeMeshGateway, server: null, status: "stopped", port: null };
}

async function startRuntimeMeshGateway(projectId, environmentId) {
  const state = await loadState();
  const project = state.projects.find((entry) => entry.id === projectId);
  const environment = project?.environments?.find((entry) => entry.id === environmentId);
  if (!project || !environment) throw Object.assign(new Error("Runtime Mesh project environment was not found."), { statusCode: 404 });
  const mesh = runtimeMeshConfig(environment);
  const services = environmentServices(environment);
  if (!services.length) throw Object.assign(new Error("Add and enable at least one environment endpoint before starting Runtime Mesh."), { statusCode: 409 });
  if (services.some((service) => { try { const url = new URL(service.baseUrl); return ["127.0.0.1", "localhost", "::1"].includes(url.hostname) && Number(url.port || (url.protocol === "https:" ? 443 : 80)) === mesh.gatewayPort; } catch { return false; } })) {
    throw Object.assign(new Error(`Loopback port ${mesh.gatewayPort} is already assigned to an environment endpoint.`), { statusCode: 409 });
  }
  await closeRuntimeMeshGateway();
  const gateway = http.createServer(async (request, response) => {
    const started = Date.now();
    const incomingUrl = new URL(request.url, `http://${HOST}:${mesh.gatewayPort}`);
    const currentState = await loadState();
    const currentProject = currentState.projects.find((entry) => entry.id === projectId);
    const currentEnvironment = currentProject?.environments?.find((entry) => entry.id === environmentId);
    const currentMesh = runtimeMeshConfig(currentEnvironment);
    const currentServices = environmentServices(currentEnvironment);
    const route = currentMesh.routes.find((entry) => meshRouteMatches(entry.pattern, incomingUrl.pathname));
    const service = currentServices.find((entry) => entry.id === route?.serviceId);
    const origin = String(request.headers.origin ?? "");
    if (origin && /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "Origin");
    }
    response.setHeader("access-control-allow-headers", "authorization, content-type, x-api-key");
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (!route || !service) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "No Runtime Mesh route matches this path.", path: incomingUrl.pathname }));
      if (currentMesh.policies.logUnmapped) addHistory({ projectId, requestName: "Runtime Mesh unmapped request", method: request.method, url: incomingUrl.pathname, result: { ok: false, status: 404, elapsed_ms: Date.now() - started, error: "Unmapped Runtime Mesh path" } }).catch(() => {});
      return;
    }
    const target = meshTargetUrl(route, service, incomingUrl);
    if (currentMesh.policies.enforceTls && target.protocol !== "https:") {
      response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Runtime Mesh TLS policy rejected this target." }));
      return;
    }
    const headers = { ...request.headers, host: target.host, "x-aipi-mesh": "loopback" };
    delete headers.connection;
    delete headers["proxy-connection"];
    delete headers["content-length"];
    if (route.authPolicy === "strip") delete headers.authorization;
    if (route.authPolicy === "inject") {
      const credential = (service.variables ?? []).find((entry) => entry.enabled !== false && entry.secret && entry.authProfile);
      if (credential?.authProfile?.type === "bearer") headers.authorization = `Bearer ${credential.value}`;
      if (credential?.authProfile?.type === "basic") headers.authorization = `Basic ${Buffer.from(`${credential.authProfile.username ?? ""}:${credential.value}`).toString("base64")}`;
      if (credential?.authProfile?.type === "apiKey") headers[credential.authProfile.headerName] = credential.value;
    }
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(target, { method: request.method, headers, timeout: 30_000 }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers, "x-aipi-mesh-target": service.variableKey ?? service.id };
      delete responseHeaders["transfer-encoding"];
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
      upstreamResponse.on("end", () => addHistory({ projectId, requestName: `Runtime Mesh · ${service.name}`, method: request.method, url: `${incomingUrl.pathname}${incomingUrl.search}`, result: { ok: (upstreamResponse.statusCode ?? 500) < 400, status: upstreamResponse.statusCode, elapsed_ms: Date.now() - started, request: { url: target.href }, mesh: { environmentId, routeId: route.id, serviceId: service.id } } }).catch(() => {}));
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Runtime Mesh upstream timed out")));
    upstream.on("error", (error) => {
      const message = runtimeMeshErrorMessage(error);
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: message, target: service.name }));
      addHistory({ projectId, requestName: `Runtime Mesh · ${service.name}`, method: request.method, url: incomingUrl.pathname, result: { ok: false, status: 502, elapsed_ms: Date.now() - started, error: message, mesh: { environmentId, routeId: route.id, serviceId: service.id } } }).catch(() => {});
    });
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => { gateway.off("listening", onListening); reject(error); };
    const onListening = () => { gateway.off("error", onError); resolve(); };
    gateway.once("error", onError);
    gateway.once("listening", onListening);
    gateway.listen(mesh.gatewayPort, HOST);
  });
  runtimeMeshGateway = { server: gateway, status: "running", projectId, environmentId, port: mesh.gatewayPort, startedAt: new Date().toISOString(), lastError: null };
  return meshStatus();
}

function rowObject(rows = []) {
  return Object.fromEntries(rows.filter((row) => row.enabled !== false && row.key).map((row) => [row.key, row.value]));
}

export function parseEnvironmentFile(text) {
  const values = new Map();
  for (const [index, raw] of String(text).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!assignment) throw Object.assign(new Error(`Invalid .env assignment on line ${index + 1}.`), { statusCode: 400, code: "INVALID_ENV_FILE" });
    let value = assignment[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); }
      catch { throw Object.assign(new Error(`Invalid quoted .env value on line ${index + 1}.`), { statusCode: 400, code: "INVALID_ENV_FILE" }); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    values.set(assignment[1], value);
  }
  return [...values].map(([key, value]) => ({ key, value }));
}

function vaultScope(projectId, environmentId, key, serviceId = null, serviceVariableKey = null, serviceIndex = null, credentialRefId = null) {
  const environmentScope = `project:${projectId}:environment:${environmentId}`;
  const scope = serviceId === null && serviceVariableKey === null
    ? `${environmentScope}:variable:${key}`
    : `${environmentScope}:service:${serviceId ?? serviceVariableKey ?? serviceIndex}:variable:${key}`;
  return credentialRefId ? `${scope}:credential:${credentialRefId}` : scope;
}

function applyAuth(request, headers, query, variables = {}) {
  const auth = request.auth ?? { type: "none" };
  const secretValue = (value, reference) => {
    if (!reference) return value ?? "";
    const resolved = variables[reference];
    if (typeof resolved !== "string" || !resolved || resolved === "[REDACTED]") {
      throw Object.assign(new Error("The selected vault credential is unavailable in the active environment."), { code: "VAULT_CREDENTIAL_UNAVAILABLE" });
    }
    return resolved;
  };
  if (auth.type === "bearer") {
    const token = secretValue(auth.token, auth.tokenRef);
    if (token) headers.authorization = `Bearer ${token}`;
  }
  if (auth.type === "basic") {
    const password = secretValue(auth.password, auth.passwordRef);
    headers.authorization = `Basic ${Buffer.from(`${auth.username ?? ""}:${password}`).toString("base64")}`;
  }
  if (auth.type === "apiKey" && auth.key) {
    const value = secretValue(auth.value, auth.valueRef);
    if (auth.placement === "query") query[auth.key] = value;
    else headers[auth.key] = value;
  }
}

async function acquireOAuthToken(executeRequest, auth, variables) {
  let tokenUrl;
  try { tokenUrl = new URL(auth.tokenUrl); }
  catch { return { error: "Enter a valid HTTPS OAuth token URL." }; }
  if (tokenUrl.protocol !== "https:" || tokenUrl.username || tokenUrl.password || tokenUrl.hash) {
    return { error: "The OAuth token URL must use HTTPS and cannot include credentials or a fragment." };
  }
  if (typeof auth.clientId !== "string" || !auth.clientId.trim()) return { error: "Enter an OAuth client ID." };
  if (auth.clientAuthMethod && !["post", "basic"].includes(auth.clientAuthMethod)) return { error: "Choose a supported OAuth client authentication method." };
  if ((auth.scope !== undefined && typeof auth.scope !== "string") || (auth.audience !== undefined && typeof auth.audience !== "string")) {
    return { error: "OAuth scope and audience must be text values." };
  }
  const clientSecret = typeof auth.clientSecretRef === "string" ? variables[auth.clientSecretRef] : undefined;
  if (!auth.clientSecretRef || typeof clientSecret !== "string" || !clientSecret || clientSecret === "[REDACTED]") {
    return { error: "The selected OAuth client secret is unavailable in the active environment." };
  }

  const form = { grant_type: "client_credentials", client_id: auth.clientId.trim() };
  if (auth.scope?.trim()) form.scope = auth.scope.trim();
  if (auth.audience?.trim()) form.audience = auth.audience.trim();
  const headers = { accept: "application/json" };
  if (auth.clientAuthMethod === "basic") {
    const formEncode = (value) => new URLSearchParams({ value }).toString().slice("value=".length);
    headers.authorization = `Basic ${Buffer.from(`${formEncode(auth.clientId.trim())}:${formEncode(clientSecret)}`).toString("base64")}`;
  } else {
    form.client_secret = clientSecret;
  }
  try {
    const result = await executeRequest({
      name: "OAuth token request",
      method: "POST",
      url: tokenUrl.href,
      headers,
      body: form,
      body_type: "form",
      timeout_ms: 15000,
      max_response_bytes: 65536,
      variables: {},
      assertions: []
    }, {});
    if (!result || result.status < 200 || result.status >= 300 || result.error || result.truncated) {
      return { error: `OAuth token request failed${result?.status ? ` (HTTP ${result.status})` : ""}.` };
    }
    const payload = result.json ?? JSON.parse(result.body ?? "");
    if (typeof payload?.access_token !== "string" || !payload.access_token || /[\u0000-\u001f\u007f]/.test(payload.access_token) || String(payload.token_type ?? "Bearer").toLowerCase() !== "bearer") {
      return { error: "The OAuth server returned an invalid token response." };
    }
    return { token: payload.access_token };
  } catch {
    return { error: "The OAuth token request could not be completed." };
  }
}

function runScript(source, context, label) {
  if (!source?.trim()) return [];
  const logs = [];
  const sandbox = {
    ...context,
    console: { log: (...values) => logs.push(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")) },
    setVariable: (key, value) => { context.variables[key] = value; },
    getVariable: (key) => context.variables[key]
  };
  vm.runInNewContext(`"use strict";\n${source}`, sandbox, { timeout: 500, displayErrors: true, filename: `${label}.js` });
  return logs;
}

function prepareRequest(saved, variables) {
  const request = structuredClone(saved);
  const headers = rowObject(request.headers);
  const query = rowObject(request.params);
  applyAuth(request, headers, query, variables);
  if (!headers.authorization && variables.AIPI_CAPTURED_AUTHORIZATION) headers.authorization = variables.AIPI_CAPTURED_AUTHORIZATION;
  if (!headers.cookie && variables.AIPI_CAPTURED_COOKIE) headers.cookie = variables.AIPI_CAPTURED_COOKIE;
  let body;
  let bodyType = request.body?.type ?? "json";
  const content = request.body?.content ?? "";
  if (!["GET", "HEAD"].includes(request.method) && content !== "") {
    if (bodyType === "json") {
      try { body = JSON.parse(content); } catch { body = content; bodyType = "text"; }
    } else if (bodyType === "form") {
      try { body = JSON.parse(content); } catch { body = Object.fromEntries(new URLSearchParams(content)); }
    } else body = content;
  }
  const executable = {
    name: request.name, method: request.method, url: request.url, headers, query, body, body_type: bodyType,
    variables, assertions: request.assertions ?? [], timeout_ms: request.timeoutMs ?? 30000,
    max_response_bytes: request.maxResponseBytes ?? 500000,
    ca_certificate: request.certificates?.ca || undefined,
    client_certificate: request.certificates?.clientCert || undefined,
    client_key: request.certificates?.clientKey || undefined,
    reject_unauthorized: request.certificates?.rejectUnauthorized !== false
  };
  return { request, executable };
}

function diagnosisFor(result) {
  const status = result?.status;
  const body = String(result?.body ?? result?.error ?? "");
  const suggestions = [];
  let category = "Unknown failure";
  if (!result?.error && result?.ok && result?.passed !== false) {
    return { category: "Request completed", summary: `HTTP ${status} received successfully.`, suggestions: ["Review response data and contract assertions before promoting this request into an automated collection."], retryable: false };
  }
  if (result?.error) {
    category = /certificate|self.signed|unable to verify/i.test(body) ? "TLS certificate failure" : /timed out|abort/i.test(body) ? "Timeout" : /ENOTFOUND|getaddrinfo/i.test(body) ? "DNS failure" : /ECONNREFUSED/i.test(body) ? "Connection refused" : "Network failure";
  } else if (status === 400) { category = "Invalid request"; suggestions.push("Validate the body schema, content type, and required parameters."); }
  else if (status === 401) { category = "Authentication failed"; suggestions.push("Refresh credentials and verify the Authorization scheme."); }
  else if (status === 403) { category = "Authorization denied"; suggestions.push("Check scopes, roles, tenant context, and resource ownership."); }
  else if (status === 404) { category = "Route or resource not found"; suggestions.push("Check the base URL, path variables, API version, and resource identifier."); }
  else if (status === 409) { category = "State conflict"; suggestions.push("Review idempotency keys, resource version, and existing records."); }
  else if (status === 415) { category = "Unsupported media type"; suggestions.push("Set the Content-Type expected by the endpoint."); }
  else if (status === 422) { category = "Validation failed"; suggestions.push("Inspect field-level errors and compare the payload with the API schema."); }
  else if (status === 429) { category = "Rate limited"; suggestions.push("Respect Retry-After and use exponential backoff with jitter."); }
  else if (status >= 500) { category = "Server-side failure"; suggestions.push("Retry idempotent requests, correlate server logs, and capture a request ID."); }
  else if (result && result.passed === false) { category = "Assertion failure"; suggestions.push("Compare actual response fields with the expected contract."); }
  if (/html/i.test(result?.headers?.["content-type"] ?? "") && status >= 400) suggestions.push("The response is HTML; verify gateway, proxy, and route configuration.");
  if (result?.elapsed_ms > 3000) suggestions.push("The response is slow; inspect DNS, connection, server timing, and downstream dependencies.");
  if (!suggestions.length) suggestions.push("Inspect the response body, headers, and failed assertions for the first divergence.");
  return { category, summary: `${category}${status ? ` (HTTP ${status})` : ""}.`, suggestions, retryable: Boolean(result?.error || [408, 425, 429, 500, 502, 503, 504].includes(status)) };
}

async function executeSaved(executeRequest, project, savedRequest, options = {}) {
  const variables = variablesFor(project, options.variables);
  const prepared = prepareRequest(savedRequest, variables);
  const scriptLogs = [];
  if (savedRequest.auth?.type === "oauth") {
    const token = await acquireOAuthToken(executeRequest, savedRequest.auth, variables);
    if (token.error) {
      const result = { error: token.error, passed: false, attempts: 0, scriptLogs };
      result.diagnosis = diagnosisFor(result);
      return result;
    }
    prepared.executable.headers.authorization = `Bearer ${token.token}`;
  }
  try { scriptLogs.push(...runScript(savedRequest.scripts?.pre, { request: prepared.executable, variables }, "pre-request")); }
  catch (error) { return { error: `Pre-request script failed: ${error.message}`, passed: false, scriptLogs }; }
  const retry = savedRequest.retry ?? {};
  const maxAttempts = options.maxAttempts ?? (retry.enabled ? Math.max(1, Number(retry.attempts) + 1) : 1);
  const retryStatuses = String(retry.statuses ?? "408,425,429,500,502,503,504").split(",").map(Number);
  let result;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    try { result = await executeRequest(prepared.executable, variables); }
    catch (error) { result = { error: error.message, passed: false, assertions: [] }; }
    if (attempts >= maxAttempts || (!result.error && !retryStatuses.includes(result.status))) break;
    await new Promise((resolve) => setTimeout(resolve, Number(retry.delayMs ?? 500) * attempts));
  }
  result.attempts = attempts;
  result.scriptLogs = scriptLogs;
  try { result.scriptLogs.push(...runScript(savedRequest.scripts?.post, { response: result, variables }, "post-response")); }
  catch (error) { result.postScriptError = error.message; result.passed = false; }
  result.diagnosis = diagnosisFor(result);
  return result;
}

function parseScalar(text) {
  const value = text.trim();
  if (!value) return {};
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value.startsWith("[") || value.startsWith("{")) { try { return JSON.parse(value.replaceAll("'", '"')); } catch {} }
  return value;
}

function parseLooseYaml(text) {
  const lines = text.split(/\r?\n/).map((raw) => ({ raw, indent: raw.length - raw.trimStart().length, text: raw.trim() })).filter((line) => line.text && !line.text.startsWith("#"));
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const { indent, text: line } = lines[lineIndex];
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;
    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) continue;
      const itemText = line.slice(2);
      if (itemText.includes(":")) {
        const [key, ...rest] = itemText.split(":");
        const tail = rest.join(":").trim();
        const item = { [key.trim()]: tail ? parseScalar(tail) : {} };
        parent.push(item); stack.push({ indent, value: item });
      } else parent.push(parseScalar(itemText));
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const tail = line.slice(colon + 1).trim();
    if (tail) parent[key] = parseScalar(tail);
    else {
      const next = lines.slice(lineIndex + 1).find((candidate) => candidate.indent > indent);
      parent[key] = next?.text.startsWith("- ") ? [] : {};
      stack.push({ indent, value: parent[key], parent, key });
    }
  }
  return root;
}

function exampleFromSchema(schema = {}) {
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.type === "array") return [exampleFromSchema(schema.items ?? {})];
  if (schema.type === "object" || schema.properties) return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, exampleFromSchema(value)]));
  if (schema.type === "integer" || schema.type === "number") return 0;
  if (schema.type === "boolean") return false;
  return "string";
}

function importOpenApi(spec, projectName) {
  const project = defaultProject(projectName || spec.info?.title || "Imported API");
  project.description = spec.info?.description ?? "";
  const baseUrl = spec.servers?.[0]?.url ?? (spec.host ? `${spec.schemes?.[0] ?? "https"}://${spec.host}${spec.basePath ?? ""}` : "http://localhost:3000");
  project.environments[0].variables[0].value = baseUrl;
  project.requests = [];
  for (const [route, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      const request = defaultRequest(operation.summary || operation.operationId || `${method.toUpperCase()} ${route}`);
      request.method = method.toUpperCase();
      request.url = `{{baseUrl}}${route.replace(/\{([^}]+)\}/g, "{{$1}}")}`;
      request.docs = [operation.summary, operation.description].filter(Boolean).join("\n\n");
      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
      request.params = parameters.filter((item) => item.in === "query").map((item) => ({ key: item.name, value: item.example ?? item.schema?.example ?? "", enabled: item.required === true }));
      request.headers = parameters.filter((item) => item.in === "header").map((item) => ({ key: item.name, value: item.example ?? item.schema?.example ?? "", enabled: item.required === true }));
      const bodySchema = operation.requestBody?.content?.["application/json"]?.schema ?? parameters.find((item) => item.in === "body")?.schema;
      const bodyExample = operation.requestBody?.content?.["application/json"]?.example ?? (bodySchema ? exampleFromSchema(bodySchema) : undefined);
      if (bodySchema) request.body.schema = bodySchema;
      if (bodyExample !== undefined) request.body.content = JSON.stringify(bodyExample, null, 2);
      project.requests.push(markImportedPayloadUntrusted(request, "openapi"));
    }
  }
  if (!project.requests.length) project.requests.push(markImportedPayloadUntrusted(defaultRequest(), "openapi"));
  project.importMetadata = { untrustedData: true, source: "openapi", importedAt: new Date().toISOString() };
  return project;
}

async function importDocument(payload) {
  let text = payload.text;
  if (payload.url) {
    const url = new URL(payload.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Import URL must be an HTTP(S) URL without embedded credentials");
    const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true, verbatim: true });
    const blocked = addresses.some(({ address }) => {
      const value = address.toLowerCase();
      if (net.isIPv6(value)) return value === "::" || value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("::ffff:127.") || value.startsWith("::ffff:169.254.");
      const [a, b] = value.split(".").map(Number);
      return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    });
    if (blocked || /(^|\.)metadata\.google\.internal$/i.test(url.hostname)) throw new Error("Import URL resolves to a private, loopback, link-local, or metadata network target");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json, application/yaml, text/yaml, text/plain" } });
    if (!response.ok) throw new Error(`Import URL returned HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > 5_000_000) throw new Error("Import document exceeds the 5 MB limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 5_000_000) throw new Error("Import document exceeds the 5 MB limit");
    text = new TextDecoder().decode(bytes);
  }
  if (!text) throw new Error("Provide an OpenAPI/Swagger document or URL");
  let document;
  try { document = JSON.parse(text); }
  catch { document = parseLooseYaml(text); }
  if (!document.openapi && !document.swagger && !document.paths) throw new Error("The document does not look like OpenAPI or Swagger");
  return importOpenApi(document, payload.name);
}

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".sql", ".json", ".yaml", ".yml", ".md", ".mdx", ".prisma"]);
const IGNORED_DIRECTORIES = new Set([".git", ".next", ".api-forge", ".aipi", "node_modules", "dist", "build", "coverage", ".turbo", ".cache"]);

async function collectSourceFiles(root, limit = 4000) {
  const files = [];
  async function visit(directory) {
    if (files.length >= limit) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(target);
      } else if (entry.isFile() && (SOURCE_EXTENSIONS.has(path.extname(entry.name)) || entry.name.startsWith(".env"))) {
        files.push(target);
      }
    }
  }
  await visit(root);
  return files;
}

function relativeSource(root, file) {
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? file : relative;
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

function normalizeRoute(value) {
  return String(value ?? "")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/\$\{[^}]+\}/g, ":param")
    .replace(/\[[^\]]+\]/g, ":param")
    .replace(/:[A-Za-z0-9_]+/g, ":param")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "") || "/";
}

function recordMatches(pattern, text, makeEntry) {
  const results = [];
  for (const match of text.matchAll(pattern)) results.push(makeEntry(match));
  return results;
}

function splitSqlColumns(value) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) { parts.push(current); current = ""; }
    else current += character;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseSqlColumns(value) {
  return splitSqlColumns(value).map((raw) => raw.trim()).filter(Boolean).flatMap((definition) => {
    if (/^(constraint|primary\s+key|foreign\s+key|unique|check)\b/i.test(definition)) return [];
    const match = definition.match(/^["'`]?([\w-]+)["'`]?\s+([^\s,]+(?:\s+(?:precision|varying))?)/i);
    if (!match) return [];
    return [{ name: match[1], type: match[2], nullable: !/\bnot\s+null\b/i.test(definition), primaryKey: /\bprimary\s+key\b/i.test(definition), hasDefault: /\bdefault\b/i.test(definition) }];
  });
}

export function detectFromFile(file, root, text) {
  const relative = relativeSource(root, file);
  const endpoints = [];
  const frontendCalls = [];
  const schemas = [];
  const frameworks = new Set();

  if (/package\.json$/.test(relative)) {
    try {
      const pkg = JSON.parse(text);
      const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [dependency, framework] of [["next", "Next.js"], ["express", "Express"], ["hono", "Hono"], ["fastify", "Fastify"], ["@supabase/supabase-js", "Supabase"], ["@opentelemetry/api", "OpenTelemetry"], ["axios", "Axios"], ["vitest", "Vitest"], ["playwright", "Playwright"]]) {
        if (dependencies[dependency]) frameworks.add(framework);
      }
    } catch {}
  }

  if (!/\.(?:mdx?|prisma)$/.test(relative)) {
  for (const route of discoverRouteHandlers({ file: relative, text })) {
    endpoints.push({ id: newId("ep"), method: route.method, path: route.route, source: relative,
      line: route.line, endLine: route.endLine ?? null, rangeMethod: route.rangeMethod ?? null,
      framework: route.framework, adapter: route.adapter,
      confidence: route.confidence });
    frameworks.add(route.framework);
  }

  for (const call of httpCalls(relative, text)) frontendCalls.push({ ...call, id: newId("call"), source: relative });
  for (const entry of recordMatches(/axios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi, text, (match) => ({
    id: newId("call"), method: match[1].toUpperCase(), path: match[2], source: relative, line: lineFor(text, match.index), client: "Axios", confidence: match[2].includes("${") ? .45 : .92, resolution: match[2].includes("${") ? "dynamic-template" : "literal"
  }))) frontendCalls.push(entry);
  if (frontendCalls.some((entry) => entry.client === "Axios")) frameworks.add("Axios");

  if (/\.sql$/.test(relative)) {
    for (const match of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:["'`]?\w+["'`]?\.)?["'`]?([\w-]+)["'`]?\s*\(([\s\S]*?)\)\s*;/gi)) {
      schemas.push({ id: newId("schema"), name: match[1], kind: "table", source: relative, line: lineFor(text, match.index), confidence: .95, columns: parseSqlColumns(match[2]) });
    }
  }
  }
  const artifacts = [];
  const add = (kind, name, index = 0, route = undefined) => artifacts.push({ kind, name, source: relative, line: lineFor(text, index), route, confidence: .6, detectionMethod: "source-pattern", contentHash: crypto.createHash("sha256").update(text).digest("hex") });
  const posix = relative.replaceAll("\\", "/");
  if (/(?:^|\/)(?:app\/.*\/)?page\.[jt]sx?$/.test(posix)) add("page", posix, 0, "/" + posix.replace(/^.*?app\//, "").replace(/\/?page\.[jt]sx?$/, ""));
  if (/\.[jt]sx?$/.test(posix)) {
    for (const match of text.matchAll(/(?:export\s+(?:default\s+)?)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)\s*(?:\(|=)/g)) {
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(match[1])) add("component", match[1], match.index);
    }
    for (const match of text.matchAll(/(?:test|it)\s*\(\s*["'`]([^"'`]+)["'`]/g)) add("test", match[1], match.index);
    for (const match of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*z\.(?:object|enum|union|array)\s*\(/g)) add("contract", match[1], match.index);
  }
  if (/\.mdx?$/.test(posix)) add("document", text.match(/^#\s+(.+)$/m)?.[1] ?? posix);
  if (/\.prisma$/.test(posix)) for (const match of text.matchAll(/model\s+(\w+)\s*\{/g)) add("model", match[1], match.index);
  for (const entry of [...endpoints, ...frontendCalls, ...schemas]) entry.contentHash = crypto.createHash("sha256").update(text).digest("hex");
  return { endpoints, frontendCalls, schemas, artifacts, frameworks: [...frameworks] };
}

export function buildIntegrations(endpoints, frontendCalls) {
  const integrations = [];
  const matchedEndpointIds = new Set();
  for (const call of frontendCalls) {
    const unresolved = call.resolution === "dynamic-template" || /^(?:[a-z]+:)?\/\//i.test(call.path);
    const candidates = unresolved ? [] : endpoints.filter((endpoint) => endpoint.method === call.method && normalizeRoute(endpoint.path) === normalizeRoute(call.routePattern ?? call.path));
    const route = candidates.length === 1 ? candidates[0] : null;
    const inferred = ["wrapper-origin-unresolved", "parameterized-template"].includes(call.resolution);
    if (route) matchedEndpointIds.add(route.id);
    integrations.push({
      id: newId("integration"), callId: call.id, endpointId: route?.id ?? null,
      method: call.method, path: call.path,
      status: route ? inferred ? "candidate-link" : "healthy" : unresolved || candidates.length > 1 ? "unresolved-client-target" : "missing-backend",
      confirmationState: route && !inferred ? "confirmed" : "inferred",
      reason: candidates.length > 1 ? "Multiple handlers match; service ownership must be resolved" : inferred ? "Request pattern matches; destination and parameters need confirmation" : unresolved ? "Dynamic or external destination requires review" : undefined,
      confidence: route ? Math.min(call.confidence, route.confidence) : call.confidence
    });
  }
  for (const endpoint of endpoints.filter((entry) => !matchedEndpointIds.has(entry.id))) {
    integrations.push({ id: newId("integration"), endpointId: endpoint.id, callId: null, method: endpoint.method, path: endpoint.path, status: "unused-backend", confidence: endpoint.confidence });
  }
  return integrations;
}

export async function scanProjectSource(projectId, requestedRoots = []) {
  if (sourceScanOperations.get(projectId)?.status === "running") throw new Error("A source scan is already running for this project");
  publishSourceScan(projectId, { status: "running", phase: "Validating source roots", progress: 5, error: null });
  try {
    const roots = [];
    for (const input of requestedRoots) {
      const rawPath = String(typeof input === "string" ? input : input.path ?? "").trim();
      if (!rawPath) continue;
      const rootPath = path.resolve(rawPath);
      const stats = await fs.stat(rootPath);
      if (!stats.isDirectory()) throw new Error(`${rootPath} is not a directory`);
      roots.push({ kind: typeof input === "string" ? "workspace" : input.kind ?? "workspace", path: rootPath });
    }
    if (!roots.length) throw new Error("Add at least one local source folder");

    const endpoints = [];
    const frontendCalls = [];
    const schemas = [];
    const frameworks = new Set();
    let filesScanned = 0;
    const artifacts = [];
    const stableEntry = (kind, root, entry) => ({ ...entry, root, id: `${kind}_${crypto.createHash("sha256").update(JSON.stringify([root, entry.source, entry.line, entry.method, entry.path, entry.name, entry.kind])).digest("hex").slice(0, 24)}` });
    const indexing = { parsed: 0, cacheHits: 0, contentHits: 0, removed: 0, skippedLarge: 0, unreadable: 0 };
    for (const [rootIndex, root] of roots.entries()) {
      publishSourceScan(projectId, { phase: `Discovering files (${rootIndex + 1}/${roots.length})`, progress: 12 + Math.round(rootIndex / roots.length * 18), root: root.path });
      const files = await collectSourceFiles(root.path);
      filesScanned += files.length;
      publishSourceScan(projectId, { phase: `Indexing ${files.length} files (${rootIndex + 1}/${roots.length})`, progress: 30 + Math.round(rootIndex / roots.length * 42), filesDiscovered: filesScanned });
      const indexed = await incrementalSourceIndex({
        root: root.path,
        files,
        detect: (file, text) => detectFromFile(file, root.path, text),
      });
      for (const key of Object.keys(indexing)) indexing[key] += indexed.metrics[key] ?? 0;
      for (const detected of indexed.results) {
        detected.endpoints.forEach((entry) => endpoints.push(stableEntry("ep", root.path, entry)));
        detected.frontendCalls.forEach((entry) => frontendCalls.push(stableEntry("call", root.path, entry)));
        detected.schemas.forEach((entry) => schemas.push(stableEntry("schema", root.path, entry)));
        (detected.artifacts ?? []).forEach((entry) => artifacts.push(stableEntry(entry.kind, root.path, entry)));
        detected.frameworks.forEach((entry) => frameworks.add(entry));
      }
      publishSourceScan(projectId, { phase: `Indexed source root ${rootIndex + 1}/${roots.length}`, progress: 72 + Math.round((rootIndex + 1) / roots.length * 8), filesDiscovered: filesScanned });
    }
    publishSourceScan(projectId, { phase: "Mapping API relationships", progress: 84, filesDiscovered: filesScanned });
    const integrations = buildIntegrations(endpoints, frontendCalls);
    const findings = integrations.filter((entry) => entry.status !== "healthy").map((entry) => ({
      id: `finding_${crypto.createHash("sha256").update(JSON.stringify([entry.callId, entry.endpointId, entry.status])).digest("hex").slice(0, 24)}`, severity: entry.status === "missing-backend" ? "high" : "medium", type: entry.status,
      title: entry.status === "missing-backend" ? `No backend route found in the index for ${entry.method} ${entry.path}` : entry.status === "candidate-link" ? `Confirm service destination: ${entry.method} ${entry.path}` : entry.status === "unresolved-client-target" ? `Client target requires review: ${entry.method} ${entry.path}` : `No frontend consumer found in the index for ${entry.method} ${entry.path}`,
      integrationId: entry.id
    }));
    publishSourceScan(projectId, { phase: "Capturing Git revision", progress: 90 });
    const git = await Promise.all(roots.map(async (root) => ({ ...(await captureGitEvidence(root.path)), requestedRoot: root.path })));
    const scan = { roots, git, gitRevision: git.find((entry) => entry.commit)?.commit ?? null, scanStatus: "complete", lastScannedAt: new Date().toISOString(), filesScanned, indexing, frameworks: [...frameworks], endpoints, frontendCalls, integrations, schemas, artifacts, findings };
    publishSourceScan(projectId, { phase: "Saving project index", progress: 96 });
    await mutateState(async (state) => {
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) throw new Error("Project not found");
      const previousEndpoints = new Set((project.sourceContext?.endpoints ?? []).map((entry) => `${entry.method} ${entry.path}`));
      const discovered = endpoints.filter((entry) => !previousEndpoints.has(`${entry.method} ${entry.path}`));
      project.sourceContext = scan;
      if (project.gitBinding?.sourceRoot && !roots.some((entry) => path.resolve(entry.path) === path.resolve(project.gitBinding.sourceRoot))) project.gitBinding = null;
      project.updatedAt = new Date().toISOString();
      project.summary = {
        ...(project.summary ?? {}), libraries: [...frameworks],
        iterations: [...(project.summary?.iterations ?? []), { at: scan.lastScannedAt, label: `Indexed ${indexing.parsed} changed files (${indexing.cacheHits + indexing.contentHits} reused)` }].slice(-20)
      };
      const teamMemory = await hydrateProjectTeamMemory(project);
      runPostIndexBootstrapper(project, { history: state.history ?? [] });
      const launchReadinessTask = project.tasks?.find((entry) => entry.kind === "launch-readiness" && !entry.staleAt);
      if (launchReadinessTask) {
        const prepared = await refreshAndPrepareTaskContext(project, launchReadinessTask, { tokenBudget: 2400, level: "working" });
        prepared.contextPack.baselineEstimatedTokens = Math.max(prepared.contextPack.estimatedTokens, filesScanned * 700);
        prepared.contextPack.roiMethod = "bounded context tokens compared with a conservative 700-token-per-indexed-file estimate; not provider billing";
      }
      buildProjectKnowledgeGraph(project, teamMemory);
      try {
        project.teamMemory = { ...(await syncProjectTeamMemory(project)), inheritedRequests: teamMemory.requests.length, inheritedReceipts: teamMemory.receipts.length, warnings: teamMemory.warnings, syncedAt: scan.lastScannedAt };
      } catch (error) {
        project.teamMemory = { written: false, error: error.message, warnings: teamMemory.warnings, syncedAt: scan.lastScannedAt };
      }
      appendTimelineEvent(state, {
        projectId: project.id, createdAt: scan.lastScannedAt, type: "scan", severity: findings.some((entry) => entry.severity === "high") ? "warning" : "success", actor: "aipi",
        title: "Source intelligence refreshed",
        summary: `Scanned ${filesScanned} files, indexed ${endpoints.length} backend APIs and ${frontendCalls.length} callers; ${integrations.filter(entry => entry.status === "candidate-link").length} candidate links need review. ${findings.length} coverage findings recorded.`,
        tags: [...frameworks].slice(0, 6), source: { kind: "source-scan", roots: roots.map((entry) => entry.path) },
        evidence: { filesScanned, indexing, endpoints: endpoints.length, frontendCalls: frontendCalls.length, schemas: schemas.length, integrations: integrations.length, findings: findings.length, newEndpoints: discovered.map((entry) => `${entry.method} ${entry.path}`).slice(0, 25), git: git.map((entry) => ({ root: entry.requestedRoot, commit: entry.commit, branch: entry.branch, dirty: entry.dirty })) }
      });
    });
    publishSourceScan(projectId, { status: "complete", phase: "Index current", progress: 100, completedAt: scan.lastScannedAt, filesDiscovered: filesScanned });
    await syncProjectWatchers();
    return scan;
  } catch (error) {
    publishSourceScan(projectId, { status: "failed", phase: "Index failed", error: error.message });
    throw error;
  }
}

function corsOrigin(origin) {
  if (!origin) return null;
  const normalized = origin.replace(/\/$/, "");
  return normalized === dashboardUrl || allowedOrigins.has(normalized) ? normalized : null;
}

async function listenOnAvailablePort(server) {
  const start = basePort();
  const end = maxPort();
  for (let port = start; port <= end; port += 1) {
    const listening = await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, HOST);
    });
    if (listening) {
      dashboardUrl = `http://${HOST}:${server.address().port}`;
      return;
    }
  }
  throw new Error(`No available AIPI loopback port in ${start}-${end}`);
}

export async function startDashboard({ executeRequest, callTool } = {}) {
  await mutateState((state) => markInterruptedVerificationJobs(state));
  let teamSyncStore = null, teamSyncError = null;
  let teamSyncInFlight = false;
  const reconcileRepositories = (store, session) => reconcileTeamRepositories(store, {...session,loadState,mutateState,inspectGit:root=>inspectGitBinding(root,{})});
  const teamSessions = createTeamSessionManager({afterSync:reconcileRepositories});
  let teamSyncLiveStatus = null;
  const teamOnboardingTickets = new TeamOnboardingTickets();
  const activatePairing = (pairing) => {
    if (!/^wss:\/\//.test(String(pairing.websocketUrl ?? ""))) throw new Error("Pairing requires a secure WebSocket relay URL");
    outboundPairing?.close();
    outboundPairingStatus = { status: "connecting", sessionId: pairing.sessionId, expiresAt: pairing.expiresAt };
    outboundPairing = startPairingClient({
      websocketUrl: pairing.websocketUrl, secret: pairing.companionSecret,
      localUrl: dashboardUrl, localToken: sessionToken,
      onStatus: (next) => { outboundPairingStatus = { ...outboundPairingStatus, ...next }; },
    });
  };
  try { teamSyncStore = await openTeamSyncStore(DATA_DIR, { sourcePath: DATA_FILE }); }
  catch (error) { teamSyncError = error.message; console.error(`AIPI team cache unavailable; workspace.json remains usable: ${error.message}`); }
  const restoreTeamSessions = async () => {
    if (!teamSyncStore) return;
    const links = teamSyncStore.db.prepare("select distinct organization_id from team_project_links").all();
    await Promise.allSettled(links.map(async ({ organization_id: organizationId }) => {
      const saved = await loadTeamSession(organizationId);
      if (!saved) return;
      await teamSessions.connect(teamSyncStore, {
        organizationId, accessToken: saved.accessToken, refreshToken: saved.refreshToken,
        oauthClientId: saved.oauthClientId, expiresAt: saved.expiresAt,
        onSession: (next) => saveTeamSession(organizationId, next),
      }, { ifAbsent: true });
    }));
  };
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    const allowedOrigin = corsOrigin(origin);
    if (origin && !allowedOrigin) return json(response, 403, { error: "Origin is not paired with this AIPI companion" });
    if (allowedOrigin) response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
    response.setHeader("access-control-allow-private-network", "true");
    response.setHeader("vary", "Origin");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url, dashboardUrl);
    try {
      if (request.method === "GET" && url.pathname === "/launch") {
        const project = url.searchParams.get("project");
        const requestedReturn = url.searchParams.get("return");
        // Only allow a local, absolute path to avoid turning the companion into
        // an open redirect while preserving deep links from the dashboard.
        const safeReturn = requestedReturn && requestedReturn.startsWith("/") && !requestedReturn.startsWith("//") && !requestedReturn.startsWith("/launch")
          ? requestedReturn
          : null;
        const destination = safeReturn ?? (project ? `/projects/${encodeURIComponent(project)}` : "/projects");
        response.writeHead(302, {
          location: destination,
          "cache-control": "no-store",
          "set-cookie": `aipi_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`,
        });
        response.end();
        return;
      }
      if (request.method === "GET") {
        const legacyProjectRoute = url.pathname.match(/^\/projects\/([^/]+)\/(apis|map|logs|runs|tools\/graphify)(?:\/([^/]+))?\/?$/);
        if (legacyProjectRoute) {
          const [, encodedProjectId, section, encodedId] = legacyProjectRoute;
          const projectId = decodeURIComponent(encodedProjectId);
          const id = encodedId ? decodeURIComponent(encodedId) : null;
          const projectPath = `/projects/${encodeURIComponent(projectId)}`;
          let destination;

          if (section === "apis") destination = id
            ? `${projectPath}/kmaps/requests/${encodeURIComponent(id)}`
            : `${projectPath}/kmaps`;
          else if (section === "map" || section === "tools/graphify") destination = `${projectPath}/kmaps?view=chains${id ? `&node=${encodeURIComponent(id)}` : ""}`;
          else if (section === "logs") destination = `${projectPath}/kmaps?view=records`;
          else {
            const state = await loadState();
            const run = state.history?.find((entry) => entry.id === id && entry.projectId === projectId);
            destination = run?.requestId
              ? `${projectPath}/kmaps/contracts/${encodeURIComponent(run.requestId)}/evidence/${encodeURIComponent(id)}`
              : `${projectPath}/kmaps?view=records`;
          }

          response.writeHead(302, { location: destination, "cache-control": "no-store" });
          response.end();
          return;
        }
      }
      const loopbackOtelIngest = request.method === "POST" && url.pathname === "/api/otel/v1/traces";
      const browserOnboarding = ["/api/team-onboarding/preview", "/api/team-onboarding/git-status", "/api/team-onboarding/oauth-start", "/api/team-onboarding/oauth-complete"].includes(url.pathname);
      if (url.pathname.startsWith("/api/") && !loopbackOtelIngest && !browserOnboarding && !hasLocalSession(request)) return json(response, 401, { error: "AIPI local session token is required" });
      if (request.method === "POST" && url.pathname === "/api/team-onboarding/start") {
        const payload = await bodyJson(request);
        const current = await loadState();
        const preview = payload.workspaceGroupId ? teamWorkspacePreview(current, payload.workspaceGroupId) : teamProjectPreview(current, payload.projectKey);
        return json(response, 200, { ...teamOnboardingTickets.create(payload.workspaceGroupId ? {workspaceGroupId:preview.workspaceGroupId} : preview.projectKey), port: server.address()?.port ?? basePort() });
      }
      if (browserOnboarding) {
        if (!origin || !allowedOrigin) return json(response, 403, { error: "Open this pairing from the AIPI Team Cloud browser" });
        const ticket = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
        let record;
        try { record = teamOnboardingTickets.get(ticket); }
        catch (error) { return json(response, 410, { error: error.message }); }
        const preview = record.workspaceGroupId ? teamWorkspacePreview(await loadState(), record.workspaceGroupId) : teamProjectPreview(await loadState(), record.projectKey);
        const previews = record.workspaceGroupId ? preview.projects : [preview];
        if (request.method === "GET" && url.pathname === "/api/team-onboarding/preview")
          return json(response, 200, { ...preview, link: previews.map((item) => teamSyncStore?.projectLink(item.projectKey)).find(Boolean) ?? null });
        if(request.method==="GET"&&url.pathname==="/api/team-onboarding/git-status"){
          const projectKey=url.searchParams.get("projectKey"),sourceId=url.searchParams.get("sourceBindingId");
          if(!previews.some(item=>item.projectKey===projectKey))return json(response,403,{error:"Select this project in the companion before checking its checkout"});
          const current=await loadState();const project=current.projects.find(item=>item.id===projectKey);
          const source=project?.sourceBindings?.find(item=>item.id===sourceId);
          const root=project?.sourceContext?.roots?.find(item=>item.sourceBindingId===sourceId);
          if(!source||!root)return json(response,404,{error:"No authorized checkout for this source on this device"});
          const binding=projectGitBinding(project,root.path)??{};
          if(source.repository){
            const inspected=await inspectGitBinding(root.path,binding);
            const remote=inspected.remotes.find(remote=>canonicalGithubRepositoryRemote(remote.fetchUrl)===canonicalGithubRepositoryRemote(source.repository.remote));
            if(!remote||!inspected.repositoryRoot||(path.relative(inspected.repositoryRoot,root.path).split(path.sep).join('/')||'.')!==source.repository.root)
              return json(response,409,{error:"The local checkout does not match this repository and directory"});
            binding.remoteName=remote.name;
          }
          return json(response,200,await inspectRemoteGitSync(root.path,{...binding,targetBranch:url.searchParams.get("branch")||binding.targetBranch}));
        }
        if (request.method === "POST" && url.pathname === "/api/team-onboarding/oauth-start") {
          return json(response, 200, teamOnboardingTickets.beginOAuth(ticket));
        }
        if (request.method === "POST" && url.pathname === "/api/team-onboarding/oauth-complete") {
          if (!teamSyncStore) return json(response, 503, { error: teamSyncError || "Team cache unavailable" });
          const payload = await bodyJson(request);
          if (!/^[0-9a-f-]{36}$/i.test(payload.organizationId ?? "") || !/^[0-9a-f-]{36}$/i.test(payload.workspaceId ?? ""))
            return json(response, 400, { error: "Choose a valid team workspace" });
          let oauth;
          try { oauth = teamOnboardingTickets.verifyOAuth(ticket, payload.state); }
          catch (error) { return json(response, 400, { error: error.message }); }
          const session = await exchangeTeamOAuthCode({ code: payload.code, verifier: oauth.verifier });
          const cloudHeaders = { authorization: `Bearer ${session.access_token}` };
          const cloudGet = async (route) => {
            const result = await fetch(`https://mcp.aipi.website${route}`, { headers: cloudHeaders, signal: AbortSignal.timeout(15_000) });
            if (!result.ok) throw new Error(`Team access check failed (${result.status})`);
            return result.json();
          };
          const userResponse = await fetch("https://zwffmaxjbzuazopvorkv.supabase.co/auth/v1/user", {
            headers: { ...cloudHeaders, apikey: "sb_publishable_usDgSv1ntGAwQVpk2lenYQ_E06i1WYy" }, signal: AbortSignal.timeout(15_000),
          });
          if (!userResponse.ok) return json(response, 403, { error: "Team sign-in could not be verified" });
          const user = await userResponse.json();
          if (user.id !== payload.expectedUserId)
            return json(response, 403, { error: "You approved a different AIPI account. Sign in to the same account and retry." });
          const [organizations, workspaces, projects, devices] = await Promise.all([
            cloudGet("/api/team/organizations"),
            cloudGet(`/api/team/organizations/${payload.organizationId}/workspaces`),
            cloudGet(`/api/team/workspaces/${payload.workspaceId}/projects`),
            cloudGet(`/api/team/organizations/${payload.organizationId}/devices`),
          ]);
          if (!organizations.organizations?.some((entry) => entry.id === payload.organizationId) ||
              !workspaces.workspaces?.some((entry) => entry.id === payload.workspaceId) ||
              !previews.every((item) => projects.projects?.some((entry) => entry.project_key === item.projectKey)))
            return json(response, 403, { error: "This account cannot connect every project in the selected workspace" });
          const repositoryConflict = previews.find((item) => {
            const cloud = projects.projects.find((entry) => entry.project_key === item.projectKey);
            return item.repository && cloud?.provider_repository_id &&
              (String(cloud.provider_repository_id) !== item.repository.providerRepositoryId ||
                (cloud.repository_root ?? ".") !== item.repository.repositoryRoot);
          });
          if (repositoryConflict) return json(response, 409, { error: `${repositoryConflict.name} is bound to a different GitHub repository or path in Team. Review the project binding before pairing.` });
          const conflictingLink = previews.find((item) => {
            const link = teamSyncStore.projectLink(item.projectKey);
            return link && (link.organization_id !== payload.organizationId || link.workspace_id !== payload.workspaceId);
          });
          if (conflictingLink) return json(response, 409, { error: `${conflictingLink.name} is already paired with another Team workspace. Resolve that pairing before upgrading this workspace.` });
          const existing = teamSyncStore.projectLink(previews[0].projectKey);
          let deviceId = existing?.organization_id === payload.organizationId && existing.actor_id === user.id &&
            devices.devices?.some((entry) => entry.id === existing.device_id && !entry.revoked_at) ? existing.device_id : null;
          if (!deviceId) {
            const created = await fetch(`https://mcp.aipi.website/api/team/organizations/${payload.organizationId}/devices`, {
              method: "POST", headers: { ...cloudHeaders, "content-type": "application/json" },
              body: JSON.stringify({ label: `AIPI Companion ${crypto.randomUUID().slice(0, 8)}` }), signal: AbortSignal.timeout(15_000),
            });
            if (!created.ok) return json(response, 403, { error: "Could not register this companion with the team" });
            deviceId = (await created.json()).device?.id;
          }
          const imported = previews.reduce((total, item) => total + enqueueInitialTeamTasks(teamSyncStore, item, {
            organizationId: payload.organizationId, workspaceId: payload.workspaceId, deviceId, actorId: user.id,
          }), 0);
          let currentOAuthSession = session;
          const teamSyncSession = await teamSessions.connect(teamSyncStore, {
            organizationId: payload.organizationId, accessToken: session.access_token,
            refreshToken: session.refresh_token, oauthClientId: session.oauth_client_id, expiresAt: session.expires_at,
            onSession: (next) => { currentOAuthSession = next; return saveTeamSession(payload.organizationId, next); },
          });
          if (teamSyncSession.status().result?.error)
            return json(response, 502, { error: teamSyncSession.status().result.error, pending: imported });
          await saveTeamSession(payload.organizationId, currentOAuthSession);
          const cloudBindings = previews.map((item) => {
            const cloud = projects.projects.find((entry) => entry.project_key === item.projectKey);
            return { projectKey: item.projectKey, repository: cloud?.provider_repository_id && cloud?.remote_url
              ? normalizeRepositoryBinding({ provider: "github", providerRepositoryId: String(cloud.provider_repository_id),
                remote: cloud.remote_url, root: cloud.repository_root ?? "." }) : null };
          });
          await mutateState((next) => {
            const group = record.workspaceGroupId ? normalizeWorkspaceGroups(next).find((entry) => entry.id === record.workspaceGroupId) : null;
            if (record.workspaceGroupId && (!group || group.projectIds.length !== previews.length ||
                !previews.every((item) => group.projectIds.includes(item.projectKey))))
              throw Object.assign(new Error("Workspace membership changed during upgrade. Reopen the upgrade preview."), { statusCode: 409 });
            for (const binding of cloudBindings) {
              const project = next.projects.find((entry) => entry.id === binding.projectKey);
              if (!project) throw Object.assign(new Error("Project changed during upgrade. Reopen the upgrade preview."), { statusCode: 409 });
              if (!binding.repository) continue;
              const current = project.repositoryBinding;
              if (current && (current.providerRepositoryId !== binding.repository.providerRepositoryId ||
                  current.root !== binding.repository.root ||
                  canonicalGithubRepositoryRemote(current.remote) !== canonicalGithubRepositoryRemote(binding.repository.remote)))
                throw Object.assign(new Error(`${project.name} has a different local repository binding. Review it before pairing.`), { statusCode: 409 });
            }
            for (const binding of cloudBindings) {
              if (!binding.repository) continue;
              const project = next.projects.find((entry) => entry.id === binding.projectKey);
              if (!project.repositoryBinding) project.repositoryBinding = binding.repository;
            }
            if (group) {
              group.teamWorkspaceId = payload.workspaceId;
              group.teamOrganizationId = payload.organizationId;
              group.upgradedAt = new Date().toISOString();
            }
          });
          const links = previews.map((item) => {
            const link = teamSyncStore.saveProjectLink(item.projectKey, payload.organizationId, payload.workspaceId, deviceId, user.id);
            rememberLinkedTasks(teamSyncStore, item);
            return link;
          });
          teamOnboardingTickets.consume(ticket);
          return json(response, 200, { imported, link: links[0], links, sync: teamSyncSession.status(),
            pending: teamSyncStore.db.prepare("select count(*) as total from sync_outbox where organization_id = ? and workspace_id = ? and status = 'pending'").get(payload.organizationId, payload.workspaceId).total,
            conflicts: teamSyncStore.db.prepare("select count(*) as total from sync_outbox where organization_id = ? and workspace_id = ? and status = 'conflict'").get(payload.organizationId, payload.workspaceId).total });
        }
        return json(response, 405, { error: "Unsupported pairing request" });
      }
      if (request.method === "GET" && url.pathname === "/api/team-sync/status") {
        const organizationId = url.searchParams.get("organizationId");
        const projectId = url.searchParams.get("projectId");
        const link = projectId && teamSyncStore ? teamSyncStore.projectLink(projectId) : null;
        const countWhere = link ? " where organization_id = ? and workspace_id = ? and status = ?"
          : organizationId ? " where organization_id = ? and status = ?" : " where status = ?";
        const countFor = (status) => teamSyncStore?.db.prepare(`select count(*) as total from sync_outbox${countWhere}`)
          .get(...(link ? [link.organization_id, link.workspace_id, status] : organizationId ? [organizationId, status] : [status])).total ?? 0;
        return json(response, 200, {
          ready: Boolean(teamSyncStore), migration: teamSyncStore?.migrationStatus() ?? null,
          link: link ? { organizationId: link.organization_id, workspaceId: link.workspace_id, connectedAt: link.connected_at } : null,
          sessionActive: link ? Boolean(teamSessions.get(link.organization_id)) : organizationId ? Boolean(teamSessions.get(organizationId)) : teamSessions.activeOrganizationIds().length > 0,
          pending: projectId && !link ? 0 : countFor("pending"),
          conflicts: projectId && !link ? 0 : countFor("conflict"),
          cursor: organizationId && teamSyncStore ? teamSyncStore.cursor(organizationId) : null,
          syncing: teamSyncInFlight,
          realtime: teamSessions.status(link?.organization_id ?? organizationId) ?? (link || organizationId ? null : teamSyncLiveStatus),
          activeOrganizations: teamSessions.activeOrganizationIds(),
          error: teamSyncError,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/team-sync/tasks") {
        if (!teamSyncStore) return json(response, 503, { error: teamSyncError || "Team cache unavailable" });
        const projectId = url.searchParams.get("projectId");
        if (!projectId || !/^prj_[A-Za-z0-9_-]{4,100}$/.test(projectId)) return json(response, 400, { error: "Valid project key required" });
        const link = teamSyncStore.projectLink(projectId);
        if (!link) return json(response, 200, { linked: false, tasks: [] });
        const state = await loadState();
        const localTasks = state.projects?.find((project) => project.id === projectId)?.tasks ?? [];
        const localByExternalId = new Map(localTasks.map((task) => [
          teamTaskExternalId(link.organization_id, link.workspace_id, projectId, task.id),
          { id: task.id, status: teamTaskStatus(task.status) },
        ]));
        const rows = teamSyncStore.db.prepare("select entity_id, payload_json, sequence from sync_entities where organization_id = ? and entity_type = 'task' and deleted = 0 and json_extract(payload_json, '$.workspaceId') = ? order by sequence desc limit 200")
          .all(link.organization_id, link.workspace_id);
        return json(response, 200, { linked: true, workspaceId: link.workspace_id, tasks: rows.map((row) => {
          const task = JSON.parse(row.payload_json);
          const local = localByExternalId.get(task.externalId);
          return { id: row.entity_id, title: task.title, status: task.status, externalId: task.externalId,
            updatedAt: task.updatedAt, version: task.version, sequence: row.sequence,
            localTaskId: local?.id ?? null, localStatus: local?.status ?? null };
        }) });
      }
      if (request.method === "POST" && url.pathname === "/api/team-sync/connect") {
        if (!teamSyncStore) return json(response, 503, { error: teamSyncError || "Team cache unavailable" });
        const payload = await bodyJson(request);
        if (typeof payload.organizationId !== "string" || typeof payload.accessToken !== "string" || payload.accessToken.length > 8192)
          return json(response, 400, { error: "Organization and user session are required" });
        let rotatedSession = false;
        const teamSyncSession = await teamSessions.connect(teamSyncStore, {
          organizationId: payload.organizationId, accessToken: payload.accessToken,
          refreshToken: payload.refreshToken || null,
          onSession: (next) => { rotatedSession = true; return saveTeamSession(payload.organizationId, next); },
        });
        if (payload.refreshToken && !rotatedSession && !teamSyncSession.status().result?.error) {
          await saveTeamSession(payload.organizationId, { access_token: payload.accessToken, refresh_token: payload.refreshToken });
        }
        return json(response, 200, { organizationId: payload.organizationId, ...teamSyncSession.status() });
      }
      if (request.method === "POST" && url.pathname === "/api/team-sync/disconnect") {
        const payload = await bodyJson(request);
        const organizationId = payload.organizationId ?? teamSyncStore?.projectLink(payload.projectId)?.organization_id;
        if (typeof organizationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(organizationId))
          return json(response, 400, { error: "Valid organization ID or linked project ID required" });
        await teamSessions.disconnect(organizationId);
        await deleteTeamSession(organizationId);
        return json(response, 200, { disconnected: true, organizationId });
      }
      if (request.method === "POST" && url.pathname === "/api/team-sync/operations") {
        if (!teamSyncStore) return json(response, 503, { error: teamSyncError || "Team cache unavailable" });
        const operation = teamSyncStore.enqueue(await bodyJson(request));
        return json(response, 202, { operation });
      }
      if (request.method === "POST" && url.pathname === "/api/team-sync/run") {
        if (!teamSyncStore) return json(response, 503, { error: teamSyncError || "Team cache unavailable" });
        if (teamSyncInFlight) return json(response, 409, { error: "Team sync is already running" });
        const payload = await bodyJson(request);
        if (typeof payload.organizationId !== "string" || typeof payload.accessToken !== "string" || payload.accessToken.length > 8192)
          return json(response, 400, { error: "Organization and user session are required" });
        if (teamSessions.get(payload.organizationId)) return json(response, 409, { error: "Disconnect this team session before a one-shot sync" });
        teamSyncInFlight = true;
        try {
          const result = await syncTeamOnce(teamSyncStore, { baseUrl: "https://mcp.aipi.website",
            accessToken: payload.accessToken, organizationId: payload.organizationId });
          if(!result.error) result.repositoryBindings = await reconcileRepositories(teamSyncStore, {organizationId:payload.organizationId,accessToken:payload.accessToken});
          return json(response, 200, result);
        } finally { teamSyncInFlight = false; }
      }
      if (request.method === "GET" && url.pathname === "/api/team-sync/entities") {
        if (!teamSyncStore) return json(response, 503, { error: teamSyncError || "Team cache unavailable" });
        const organizationId = url.searchParams.get("organizationId");
        if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) return json(response, 400, { error: "Valid organization ID required" });
        const type = url.searchParams.get("type");
        if (type && !["task", "decision", "evidence", "comment", "receipt", "workspace"].includes(type))
          return json(response, 400, { error: "Unknown entity type" });
        const rows = type
          ? teamSyncStore.db.prepare("select entity_type, entity_id, payload_json, deleted, sequence from sync_entities where organization_id = ? and entity_type = ? order by sequence desc limit 200").all(organizationId, type)
          : teamSyncStore.db.prepare("select entity_type, entity_id, payload_json, deleted, sequence from sync_entities where organization_id = ? order by sequence desc limit 200").all(organizationId);
        return json(response, 200, { entities: rows.map((row) => ({ entityType: row.entity_type,
          entityId: row.entity_id, payload: JSON.parse(row.payload_json), deleted: Boolean(row.deleted), sequence: row.sequence })) });
      }
      if (request.method === "GET" && url.pathname === "/api/team-sync/context") {
        if (!teamSyncStore) return json(response, 503, { error: teamSyncError || "Team cache unavailable" });
        const organizationId = url.searchParams.get("organizationId");
        const taskId = url.searchParams.get("taskId");
        const limit = Number(url.searchParams.get("limit") ?? 25);
        return json(response, 200, resolveCachedTeamContext(teamSyncStore, organizationId, taskId, limit));
      }
      if (request.method === "GET" && url.pathname === "/api/connection") return json(response, 200, { connected: true, host: HOST, port: server.address()?.port ?? basePort(), companion: "local", protocolVersion: 2, protocol: "http-loopback", capabilities: { teamOnboarding: 1, teamSync: 1 }, pairing: outboundPairingStatus });
      if (request.method === "GET" && url.pathname === "/api/vault/status") return json(response, 200, await secretStorageStatus());
      if (request.method === "POST" && url.pathname === "/api/vault/initialize") {
        let vaultStatus;
        await mutateState(async (state) => {
          vaultStatus = await initializeSecretStorage();
          const project = state.projects.find((entry) => entry.id === state.activeProjectId) ?? state.projects[0];
          if (project) appendTimelineEvent(state, { projectId: project.id, type: "project", severity: "success", actor: "developer", title: "Encrypted secrets vault initialized", summary: "Environment and request credentials now use ECDH P-256 key agreement, HKDF SHA-256 derivation and AES-256-GCM authenticated encryption.", tags: ["vault", "encryption"], source: { kind: "vault-keyring" }, evidence: { keyId: vaultStatus.encryption.activeKey?.id, fingerprint: vaultStatus.encryption.activeKey?.fingerprint } });
          return state;
        });
        return json(response, 201, { status: vaultStatus, state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/vault/rotate") {
        const payload = await bodyJson(request);
        if (payload.confirm !== "ROTATE") return json(response, 400, { error: "Explicit vault key rotation confirmation is required" });
        let vaultStatus;
        await mutateState(async (state) => {
          vaultStatus = await rotateSecretStorageKey();
          const project = state.projects.find((entry) => entry.id === state.activeProjectId) ?? state.projects[0];
          if (project) appendTimelineEvent(state, { projectId: project.id, type: "project", severity: "success", actor: "developer", title: "Secrets vault identity rotated", summary: "Saved credentials were re-encrypted with a new active ECDH identity. Retired private keys remain in the OS credential store for recovery.", tags: ["vault", "key-rotation"], source: { kind: "vault-keyring" }, evidence: { keyId: vaultStatus.encryption.activeKey?.id, fingerprint: vaultStatus.encryption.activeKey?.fingerprint, retainedKeys: vaultStatus.encryption.retiredKeyCount } });
          return state;
        });
        return json(response, 200, { status: vaultStatus, state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/vault/credentials") {
        const payload = await bodyJson(request);
        const status = await secretStorageStatus();
        if (!status.available || !status.encryption?.initialized || !status.encryption.privateKeyAvailable) {
          return json(response, 503, { error: "Initialize the connected local secrets vault before adding credentials.", code: "VAULT_NOT_READY" });
        }
        const keyName = String(payload.keyName ?? "").trim();
        const scope = payload.scope === "service" ? "service" : payload.scope === "environment" ? "environment" : null;
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(keyName)) return json(response, 400, { error: "Credential names must use UPPER_SNAKE_CASE.", code: "INVALID_CREDENTIAL_NAME" });
        if (!scope) return json(response, 400, { error: "Choose an environment or service authentication scope.", code: "INVALID_CREDENTIAL_SCOPE" });
        const environmentIds = [...new Set((Array.isArray(payload.environmentIds) ? payload.environmentIds : [payload.environmentId]).filter(Boolean).map(String))];
        if (!environmentIds.length || environmentIds.length > 20 || (scope === "service" && environmentIds.length !== 1)) {
          return json(response, 400, { error: "Choose one or more environments; service credentials must target one environment.", code: "INVALID_CREDENTIAL_ENVIRONMENTS" });
        }
        const envelopeEntries = Array.isArray(payload.envelopes) ? payload.envelopes : [];
        const envelopeByEnvironment = new Map(envelopeEntries.map((entry) => [String(entry?.environmentId ?? ""), entry]));
        if (envelopeByEnvironment.size !== environmentIds.length || environmentIds.some((id) => !envelopeByEnvironment.has(id))) {
          return json(response, 400, { error: "Provide one locally encrypted credential envelope for each selected environment.", code: "INVALID_CREDENTIAL_ENVELOPE" });
        }
        if (envelopeEntries.some((entry) => !/^cred_[a-f0-9]{12,64}$/.test(String(entry?.credentialRefId ?? "")) || typeof entry?.envelope !== "string")) {
          return json(response, 400, { error: "Each encrypted envelope must include a valid one-time credential reference.", code: "INVALID_CREDENTIAL_REFERENCE" });
        }
        const profile = payload.authProfile ?? null;
        if (scope === "service" && (!profile || !["bearer", "apiKey", "basic"].includes(profile.type))) {
          return json(response, 400, { error: "Choose a supported service authentication profile.", code: "INVALID_AUTH_PROFILE" });
        }
        const credentialMetadata = {
          generic: { provider: "Custom", purpose: "Project secret" },
          github: { provider: "GitHub", purpose: "Source control & CI" },
          supabase: { provider: "Supabase", purpose: "Database platform" },
          cicd: { provider: "CI/CD", purpose: "Build & deployment" },
          cloud: { provider: "Cloud", purpose: "Infrastructure deployment" },
          registry: { provider: "Registry", purpose: "Artifact publishing" }
        };
        const credentialType = credentialMetadata[payload.credentialType] ? String(payload.credentialType) : "generic";
        const { provider, purpose } = credentialMetadata[credentialType];
        let savedCount = 0;
        const storedScopes = [];
        const replacedScopes = [];
        try {
          await mutateState(async (state) => {
          const owner = state.projects.find((entry) => entry.id === payload.projectId);
          if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          for (const environmentId of environmentIds) {
            const environment = owner.environments?.find((entry) => entry.id === environmentId);
            if (!environment) throw Object.assign(new Error("Environment not found in this project."), { statusCode: 404 });
            let variables = environment.variables ?? (environment.variables = []);
            let service = null;
            if (scope === "service") {
              service = environment.services?.find((entry) => entry.id === payload.serviceId);
              if (!service) throw Object.assign(new Error("Service not found in the selected environment."), { statusCode: 404 });
              variables = service.variables ?? (service.variables = []);
            }
            const now = new Date().toISOString();
            const existing = variables.find((entry) => entry.key === keyName);
            const encryptedEntry = envelopeByEnvironment.get(environmentId);
            const credentialRefId = encryptedEntry.credentialRefId;
            const authProfile = scope === "service" ? {
              type: profile.type,
              ...(profile.type === "apiKey" ? { headerName: String(profile.headerName ?? "").trim() } : {}),
              ...(profile.type === "basic" ? { username: String(profile.username ?? "").trim() } : {})
            } : undefined;
            if (authProfile?.type === "apiKey" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(authProfile.headerName)) {
              throw Object.assign(new Error("Enter a valid API key header name."), { statusCode: 400, code: "INVALID_AUTH_PROFILE" });
            }
            if (existing?.secret && typeof existing.value === "string") {
              replacedScopes.push(vaultScope(owner.id, environment.id, keyName, service?.id ?? null, service?.variableKey ?? null, service ? environment.services.indexOf(service) : null, existing.vaultCredential ? existing.credentialRefId : null));
            }
            const credentialScope = vaultScope(owner.id, environment.id, keyName, service?.id ?? null, service?.variableKey ?? null, service ? environment.services.indexOf(service) : null, credentialRefId);
            const value = await storeEncryptedSecretForScope(credentialScope, encryptedEntry.envelope);
            storedScopes.push(credentialScope);
            const record = {
              ...(existing ?? {}),
              key: keyName,
              value,
              enabled: true,
              secret: true,
              vaultCredential: true,
              credentialRefId,
              credentialType,
              provider,
              purpose,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
              lastRotatedAt: now,
              ...(authProfile ? { authProfile } : {})
            };
            const index = variables.findIndex((entry) => entry.key === keyName);
            if (index >= 0) variables[index] = record;
            else variables.push(record);
            savedCount += 1;
            if (service) service.updatedAt = now;
          }
          owner.updatedAt = new Date().toISOString();
          });
        } catch (error) {
          await Promise.all(storedScopes.map((credentialScope) => deleteSecretForScope(credentialScope)));
          throw error;
        }
        await Promise.all(replacedScopes.map((credentialScope) => deleteSecretForScope(credentialScope)));
        return json(response, 201, { saved: savedCount, state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/vault/import-env") {
        const payload = await bodyJson(request);
        const allowedFiles = new Set([".env", ".env.local", ".env.development", ".env.staging", ".env.production"]);
        const filename = String(payload.filename ?? "");
        if (!allowedFiles.has(filename)) return json(response, 400, { error: "Choose a supported local .env filename.", code: "INVALID_ENV_FILENAME" });
        const state = await loadState();
        const { project: owner, root } = projectAndAuthorizedRoot(state, payload.projectId, payload.sourceRoot);
        const environment = owner.environments?.find((entry) => entry.id === payload.environmentId);
        if (!environment) return json(response, 404, { error: "Environment not found in this project." });
        const target = path.resolve(root, filename);
        const realRoot = await fs.realpath(root);
        const realTarget = await fs.realpath(target);
        const relative = path.relative(realRoot, realTarget);
        if (relative.startsWith("..") || path.isAbsolute(relative) || path.basename(realTarget) !== filename) {
          return json(response, 403, { error: "The selected .env file must be inside an authorized source root.", code: "ENV_FILE_OUTSIDE_ROOT" });
        }
        const imported = parseEnvironmentFile(await fs.readFile(realTarget, "utf8"));
        if (!imported.length) return json(response, 400, { error: "The selected .env file contains no variable assignments.", code: "EMPTY_ENV_FILE" });
        const vault = await secretStorageStatus();
        if (!vault.available || !vault.encryption?.initialized || !vault.encryption.privateKeyAvailable) {
          return json(response, 503, { error: "Initialize the connected local secrets vault before importing credentials.", code: "VAULT_NOT_READY" });
        }
        const replacedScopes = [];
        await mutateState((current) => {
          const currentProject = current.projects.find((entry) => entry.id === owner.id);
          const currentEnvironment = currentProject?.environments?.find((entry) => entry.id === environment.id);
          if (!currentEnvironment) throw Object.assign(new Error("Environment changed during import."), { statusCode: 409 });
          currentEnvironment.variables ??= [];
          for (const entry of imported) {
            const previous = currentEnvironment.variables.find((variable) => variable.key === entry.key);
            const now = new Date().toISOString();
            if (previous?.secret && typeof previous.value === "string") {
              replacedScopes.push(vaultScope(owner.id, environment.id, entry.key, null, null, null, previous.vaultCredential ? previous.credentialRefId : null));
            }
            const next = { ...previous, ...entry, enabled: true, secret: true, vaultCredential: true, credentialRefId: newId("cred"), createdAt: previous?.createdAt ?? now, updatedAt: now, lastRotatedAt: now };
            const index = currentEnvironment.variables.findIndex((variable) => variable.key === entry.key);
            if (index >= 0) currentEnvironment.variables[index] = next;
            else currentEnvironment.variables.push(next);
          }
          currentProject.updatedAt = new Date().toISOString();
        });
        await Promise.all(replacedScopes.map((credentialScope) => deleteSecretForScope(credentialScope)));
        return json(response, 200, { imported: imported.length, keys: imported.map((entry) => entry.key), state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/vault/revoke") {
        const payload = await bodyJson(request);
        let scope = null;
        let removed = false;
        await mutateState(async (state) => {
          const owner = state.projects.find((entry) => entry.id === payload.projectId);
          const environment = owner?.environments?.find((entry) => entry.id === payload.environmentId);
          if (!owner || !environment) throw Object.assign(new Error("Project or environment not found."), { statusCode: 404 });
          let variables = environment.variables ?? [];
          let serviceId = null;
          let serviceVariableKey = null;
          let serviceIndex = null;
          if (payload.serviceId) {
            serviceIndex = (environment.services ?? []).findIndex((entry) => entry.id === payload.serviceId);
            const service = environment.services?.[serviceIndex];
            if (!service) throw Object.assign(new Error("Service not found in the selected environment."), { statusCode: 404 });
            variables = service.variables ?? [];
            serviceId = service.id;
            serviceVariableKey = service.variableKey;
          }
          const index = variables.findIndex((entry) => entry.key === payload.keyName && entry.credentialRefId === payload.credentialRefId);
          if (index < 0) throw Object.assign(new Error("Credential reference not found."), { statusCode: 404 });
          const credential = variables[index];
          scope = vaultScope(owner.id, environment.id, payload.keyName, serviceId, serviceVariableKey, serviceIndex, credential.vaultCredential ? credential.credentialRefId : null);
          variables.splice(index, 1);
          owner.updatedAt = new Date().toISOString();
          removed = true;
        });
        if (removed && scope) await deleteSecretForScope(scope);
        return json(response, 200, { removed, state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/vault/test-connection") {
        const payload = await bodyJson(request);
        const state = await loadState();
        const owner = state.projects.find((entry) => entry.id === payload.projectId);
        const environment = owner?.environments?.find((entry) => entry.id === payload.environmentId);
        const service = environment?.services?.find((entry) => entry.id === payload.serviceId);
        const credential = service?.variables?.find((entry) => entry.key === payload.keyName && entry.credentialRefId === payload.credentialRefId && entry.secret && entry.enabled !== false);
        if (!owner || !environment || !service || !credential) return json(response, 404, { error: "Service credential reference not found." });
        if (!credential.authProfile) return json(response, 400, { error: "This credential is not bound to a supported service authentication profile." });
        const auth = credential.authProfile.type === "bearer"
          ? { type: "bearer", tokenRef: `${service.variableKey}.${credential.key}` }
          : credential.authProfile.type === "basic"
            ? { type: "basic", username: credential.authProfile.username ?? "", passwordRef: `${service.variableKey}.${credential.key}` }
            : { type: "apiKey", key: credential.authProfile.headerName, valueRef: `${service.variableKey}.${credential.key}`, placement: "header" };
        const probe = {
          id: newId("req"), name: "Vault connectivity check", method: "HEAD", url: `{{${service.variableKey}}}`,
          headers: [], params: [], auth, body: { type: "text", content: "" }, retry: { enabled: false }, timeoutMs: 8000
        };
        const result = await executeSaved(executeRequest, owner, probe, { maxAttempts: 1 });
        return json(response, 200, {
          verified: Boolean(result?.status && !result.error),
          status: result?.status ?? null,
          elapsedMs: result?.elapsed_ms ?? null,
          checkedAt: new Date().toISOString(),
          summary: result?.status ? `HEAD request returned HTTP ${result.status}.` : "The companion could not complete the HEAD connectivity check."
        });
      }
      if (request.method === "POST" && url.pathname === "/api/pairing/connect") {
        const payload = await bodyJson(request);
        activatePairing({ websocketUrl: payload.websocketUrl, companionSecret: payload.secret,
          sessionId: payload.sessionId, expiresAt: payload.expiresAt });
        return json(response, 202, { accepted: true, pairing: outboundPairingStatus });
      }
      if (request.method === "POST" && url.pathname === "/api/otel/v1/traces") {
        if (!/application\/json/i.test(request.headers["content-type"] ?? "")) return json(response, 415, { error: "AIPI currently accepts OTLP/HTTP JSON traces. Configure OTEL_EXPORTER_OTLP_PROTOCOL=http/json." });
        const otlpPayload = await bodyJson(request);
        const spans = [...normalizeOtelTraces(otlpPayload), ...normalizeOtelMetrics(otlpPayload)].slice(0, 200).map((span) => markImportedPayloadUntrusted(span, "otel"));
        if (!spans.length) return json(response, 400, { error: "No OTLP spans or metric records were found in the request." });
        let projectId = null;
        let ingestionSummary = null;
        await mutateState(async (state) => {
          const project = state.projects.find((entry) => entry.id === state.activeProjectId) ?? state.projects[0];
          if (!project) return state;
          projectId = project.id;
          project.sourceContext ??= {};
          project.sourceContext.runtimeTraces = [...spans, ...(project.sourceContext.runtimeTraces ?? [])].slice(0, 200);
          const ingestion = ingestOtelEvidence(project, spans);
          ingestionSummary = {
            evidenceIds: ingestion.evidenceRecords.map((entry) => entry.id),
            contractIds: ingestion.contractsCreated.map((entry) => entry.id),
            findingIds: ingestion.findings.map((entry) => entry.id),
            taskIds: ingestion.tasks.map((entry) => entry.id),
            promotedEdgeIds: ingestion.promotedEdges.map((entry) => entry.id)
          };
          const summary = summarizeOtelBatch(spans);
          appendTimelineEvent(state, { projectId: project.id, type: "trace", severity: summary.failures ? "warning" : "info", actor: "local-observer", title: `Captured ${summary.spans} runtime span${summary.spans === 1 ? "" : "s"}`, summary: summary.routes.length ? summary.routes.join(", ") : "OTLP runtime evidence received.", tags: ["OpenTelemetry", ...summary.services].slice(0, 6), source: { kind: "otlp-http-json" }, evidence: summary });
          try { await syncProjectTeamMemory(project); } catch {}
          return state;
        });
        return json(response, 202, { accepted: spans.length, projectId, summary: summarizeOtelBatch(spans), ...ingestionSummary });
      }
      if (request.method === "POST" && url.pathname === "/api/tools/call") {
        if (!callTool) return json(response, 503, { error: "AIPI tool relay is unavailable" });
        const payload = await bodyJson(request);
        const toolName = payload.name ?? payload.tool;
        if (typeof toolName !== "string" || !toolName.trim()) return json(response, 400, { error: "A tool name is required" });
        return json(response, 200, await callTool(toolName, payload.arguments ?? payload.args ?? {}));
      }
      if (request.method === "GET" && url.pathname === "/api/runtime-mesh/status") {
        const projectId = url.searchParams.get("projectId");
        const environmentId = url.searchParams.get("environmentId");
        const status = meshStatus();
        return json(response, 200, status.projectId === projectId && status.environmentId === environmentId ? status : { status: "stopped", listening: false, projectId, environmentId, port: null, startedAt: null, lastError: null });
      }
      if (request.method === "POST" && url.pathname === "/api/runtime-mesh/reload") {
        const payload = await bodyJson(request);
        const status = await startRuntimeMeshGateway(String(payload.projectId ?? ""), String(payload.environmentId ?? ""));
        await mutateState((state) => {
          const owner = state.projects.find((entry) => entry.id === payload.projectId);
          const environment = owner?.environments?.find((entry) => entry.id === payload.environmentId);
          if (!environment) return;
          environment.runtimeMesh ??= {};
          environment.runtimeMesh.lastReloadedAt = status.startedAt;
          environment.runtimeMesh.generation = Math.max(Number(environment.runtimeMesh.generation) || 1, Number(payload.generation) || 1);
          owner.updatedAt = status.startedAt;
          appendTimelineEvent(state, { projectId: owner.id, type: "project", severity: "success", actor: "developer", title: "Runtime Mesh reloaded", summary: `Loopback gateway is listening on 127.0.0.1:${status.port} for ${environment.name}.`, tags: ["Runtime Mesh", "loopback"], source: { kind: "runtime-mesh", environmentId: environment.id }, evidence: { port: status.port, generation: environment.runtimeMesh.generation } });
        });
        return json(response, 200, { status, state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/runtime-mesh/stop") {
        await closeRuntimeMeshGateway();
        return json(response, 200, { status: meshStatus() });
      }
      const trafficRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/traffic\/(status|start|stop)$/);
      if (trafficRoute) {
        const projectId = decodeURIComponent(trafficRoute[1]);
        const action = trafficRoute[2];
        const current = await loadState();
        const owner = current.projects.find((entry) => entry.id === projectId);
        if (!owner) return json(response, 404, { error: "Project not found" });
        const root = owner.sourceContext?.roots?.find((entry) => entry.kind === "workspace")?.path ?? owner.sourceContext?.roots?.[0]?.path;
        if (!root) return json(response, 409, { error: "Connect and index a local workspace before recording traffic." });
        if (request.method === "GET" && action === "status") {
          const status = trafficRecorderStatus(projectId);
          status.captured = (await readTraffic(root, { limit: 500 })).filter((entry) => !status.startedAt || entry.observedAt >= status.startedAt).length;
          return json(response, 200, { status });
        }
        if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });
        if (action === "stop") {
          const status = await stopTrafficRecorder(projectId);
          const records = (await readTraffic(root, { limit: 500 })).filter((entry) => !status.startedAt || entry.observedAt >= status.startedAt);
          status.captured = records.length;
          status.generatedTests = await generateTrafficRegressionTests(root, records);
          await mutateState((state) => appendTimelineEvent(state, { projectId, type: "trace", severity: "info", actor: "developer", title: "Local traffic recording stopped", summary: `${status.captured} redacted request${status.captured === 1 ? "" : "s"} captured; ${status.generatedTests.length} anonymized regression test${status.generatedTests.length === 1 ? "" : "s"} generated.`, tags: ["traffic", "local", "redacted", "generated-test"], source: { kind: "traffic-recorder", files: status.generatedTests.map((entry) => entry.path) }, evidence: status }));
          return json(response, 200, { status });
        }
        const payload = await bodyJson(request);
        if (trafficRecorders.has(projectId)) return json(response, 200, { status: trafficRecorderStatus(projectId) });
        const environment = owner.environments?.find((entry) => entry.id === owner.activeEnvironmentId) ?? owner.environments?.[0];
        const target = String(payload.target ?? environmentServices(environment)[0]?.baseUrl ?? "").trim();
        let parsedTarget;
        try { parsedTarget = new URL(target); } catch { return json(response, 400, { error: "Configure a valid local baseUrl before recording traffic." }); }
        if (!['localhost', '127.0.0.1', '::1'].includes(parsedTarget.hostname)) return json(response, 400, { error: "The one-click recorder only proxies loopback targets. Use the explicit observer CLI for other destinations." });
        let authCaptured = false;
        const captureAuth = payload.captureAuth === true;
        if (captureAuth) {
          const vault = await secretStorageStatus();
          if (!vault.available || !vault.encryption?.initialized || !vault.encryption?.privateKeyAvailable) return json(response, 409, { error: "Initialize the local encrypted vault before capturing browser authentication.", code: "VAULT_NOT_READY" });
        }
        const proxy = await startTrafficProxy({ target: parsedTarget.toString(), root, port: 0, onRequestAuth: captureAuth ? async (headers) => {
          if (authCaptured) return;
          const secrets = [["AIPI_CAPTURED_AUTHORIZATION", headers.authorization], ["AIPI_CAPTURED_COOKIE", headers.cookie]].filter((entry) => entry[1]);
          if (!secrets.length) return;
          authCaptured = true;
          await mutateState(async (state) => {
            const project = state.projects.find((entry) => entry.id === projectId);
            const activeEnvironment = project?.environments?.find((entry) => entry.id === project.activeEnvironmentId) ?? project?.environments?.[0];
            if (!project || !activeEnvironment) return;
            activeEnvironment.variables ??= [];
            for (const [key, value] of secrets) {
              const credentialRefId = `cred_${crypto.createHash("sha256").update(`${projectId}:${activeEnvironment.id}:${key}`).digest("hex").slice(0, 20)}`;
              const scope = vaultScope(projectId, activeEnvironment.id, key, null, null, null, credentialRefId);
              const reference = await storeSecretForScope(scope, value);
              const existing = activeEnvironment.variables.find((entry) => entry.key === key);
              const record = { ...existing, key, value: reference, enabled: true, secret: true, vaultCredential: true, credentialRefId, credentialType: "browser-session", provider: "Local browser", purpose: "API replay session", createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), lastRotatedAt: new Date().toISOString() };
              const index = activeEnvironment.variables.findIndex((entry) => entry.key === key);
              if (index >= 0) activeEnvironment.variables[index] = record; else activeEnvironment.variables.push(record);
            }
            appendTimelineEvent(state, { projectId, type: "security", severity: "success", actor: "developer", title: "Local browser session captured", summary: `${secrets.length} authentication header${secrets.length === 1 ? "" : "s"} encrypted in the OS-backed vault for the active environment.`, tags: ["auth", "vault", "local"], source: { kind: "traffic-recorder" }, evidence: { keys: secrets.map(([key]) => key), plaintextPersisted: false } });
          });
        } : undefined });
        const startedAt = new Date().toISOString();
        trafficRecorders.set(projectId, { ...proxy, startedAt, captured: 0, captureAuth });
        const status = trafficRecorderStatus(projectId);
        await mutateState((state) => appendTimelineEvent(state, { projectId, type: "trace", severity: "success", actor: "developer", title: "Local traffic recording started", summary: `Open the app through ${status.url} to capture redacted request and response shapes.`, tags: ["traffic", "local", "redacted"], source: { kind: "traffic-recorder" }, evidence: status }));
        return json(response, 201, { status });
      }
      if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, publicState(await loadState()));
      if (request.method === "GET" && url.pathname === "/api/workspaces") {
        return json(response, 200, { workspaces: normalizeWorkspaceGroups(await loadState()) });
      }
      const changeAssessmentRoute = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/change-assessment(?:\/(review|execute|package))?$/);
      if (changeAssessmentRoute && request.method === "POST") {
        const state = await readLocalAssessmentSnapshot(DATA_DIR);
        const workspaceId = decodeURIComponent(changeAssessmentRoute[1]);
        const payload = await bodyJson(request);
        if (payload.workspace_id && payload.workspace_id !== workspaceId) return json(response, 400, { error: "Workspace selection does not match the requested route." });
        const members = new Set(state.workspaceGroups?.find(group => group.id === workspaceId)?.projectIds ?? []);
        const canReadProject = (id, currentState = state) => new Set(currentState.workspaceGroups?.find(group => group.id === workspaceId)?.projectIds ?? []).has(id);
        const args = { ...payload, workspace_id: workspaceId };
        if (changeAssessmentRoute[2]) {
          const allowed = new Set(['workspace_id', 'project_id', 'root_index', 'base_ref', 'head_ref', 'mode', 'change_id', 'review_hash', 'limit', 'share_source']);
          if (Object.keys(args).some(key => !allowed.has(key)) || !Number.isInteger(args.root_index ?? 0)
            || (args.root_index ?? 0) < 0 || (args.root_index ?? 0) > 31
            || !Number.isInteger(args.limit ?? 20) || (args.limit ?? 20) < 1 || (args.limit ?? 20) > 50
            || (changeAssessmentRoute[2] !== 'package' && args.share_source !== undefined)) return json(response, 400, { error: 'Unsupported assessment review request.' });
          const assessment = await assessLocalWorkspaceChange({ state, workspaceId,
            projectId: args.project_id, rootIndex: args.root_index ?? 0, baseRef: args.base_ref,
            headRef: args.head_ref, mode: args.mode ?? 'working-tree', changeId: args.change_id, canReadProject });
          if (changeAssessmentRoute[2] === 'review') {
            return json(response, 200, { review: reviewAssessmentChecks({ assessment, state, canRunProject: canReadProject }) });
          }
          if (changeAssessmentRoute[2] === 'package') {
            if (args.share_source !== true) return json(response, 400, { error: 'Explicit local source and command sharing selection is required.' });
            const review = reviewAssessmentChecks({ assessment, state, canRunProject: canReadProject });
            if (review.reviewHash !== args.review_hash) return json(response, 409, { error: 'The reviewed checks changed. Review the current plan.' });
            const manifest = createVerificationPackageManifest({ assessment, review, state,
              canShareProject: canReadProject });
            return json(response, 200, { manifest });
          }
          const key = await getOrCreateLocalAssessmentEvidenceKey(DATA_DIR);
          const executed = await executeReviewedAssessment({ assessment, state, canRunProject: canReadProject,
            approvedReviewHash: args.review_hash,
            executeCheck: (project, command) => executeLinkedTestCommand(project, command), signingKey: key,
            loadCurrentState: () => readLocalAssessmentSnapshot(DATA_DIR) });
          await mutateState(next => {
            const currentMembers = next.workspaceGroups?.find(group => group.id === workspaceId)?.projectIds ?? [];
            if (currentMembers.length !== members.size || currentMembers.some(id => !members.has(id))) {
              throw Object.assign(new Error('Workspace membership changed during execution. Reassess before saving results.'), { statusCode: 409 });
            }
            next.changeVerificationReceipts ??= [];
            next.changeVerificationEvidence ??= [];
            const existing = new Set(next.changeVerificationReceipts.map(item => item.id));
            const existingEvidence = new Set(next.changeVerificationEvidence.map(item => item.id));
            for (const artifact of executed.evidence) if (!existingEvidence.has(artifact.id)) next.changeVerificationEvidence.push(artifact);
            for (const receipt of executed.receipts) if (!existing.has(receipt.id)) next.changeVerificationReceipts.push(receipt);
          });
          const saved = await readLocalAssessmentSnapshot(DATA_DIR);
          const summary = await runLocalChangeAssessmentTool(saved, {
            workspace_id: workspaceId, project_id: args.project_id, root_index: args.root_index ?? 0,
            base_ref: args.base_ref, head_ref: args.head_ref, mode: args.mode ?? 'working-tree',
            change_id: args.change_id,
          }, canReadProject, receipt => acceptLocalAssessmentEvidence(receipt, key, saved.changeVerificationEvidence));
          return json(response, 200, { run: { id: executed.runId, interrupted: executed.interrupted,
            sourceChangedDuringRun: executed.sourceChangedDuringRun,
            receipts: executed.receipts.map(receipt => ({ id: receipt.id, projectId: receipt.projectId,
              componentId: receipt.componentId, requirementId: receipt.requirementId, status: receipt.status,
              evidenceIds: receipt.evidenceIds })) }, assessment: summary });
        }
        const key = await readLocalAssessmentEvidenceKey(DATA_DIR);
        const result = await runLocalChangeAssessmentTool(state, args, canReadProject,
          receipt => key ? acceptLocalAssessmentEvidence(receipt, key, state.changeVerificationEvidence) : false);
        return json(response, 200, { assessment: result });
      }
      const identityRoute = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/identity(?:\/projects\/([^/]+)\/sources(?:\/checkout)?)?$/);
      if(identityRoute){
        const workspaceId=decodeURIComponent(identityRoute[1]);
        if(request.method==="GET"&&!identityRoute[2])return json(response,200,{identity:workspaceIdentity(await loadState(),workspaceId)});
        if(request.method==="PUT"&&identityRoute[2]){
          const requestBody=await bodyJson(request);
          const projectId=decodeURIComponent(identityRoute[2]);
          if(url.pathname.endsWith("/checkout")){
            const {root}=projectAndAuthorizedRoot(await loadState(),projectId,requestBody.root);
            const inspection=await inspectGitBinding(root,{});
            return json(response,200,{checkout:await mutateState(state=>attachSourceCheckout(state,workspaceId,projectId,requestBody,inspection))});
          }
          return json(response,200,{source:await mutateState(state=>saveSourceBinding(state,workspaceId,projectId,requestBody))});
        }
      }
      const workspaceRoute = url.pathname.match(/^\/api\/workspaces\/([^/]+)(?:\/(targets|target|relationships|relationship-reviews|manifest|manifest-verify|checkouts|receipts|release-compatibility))?$/);
      if (workspaceRoute) {
        const workspaceId = decodeURIComponent(workspaceRoute[1]);
        if (workspaceRoute[2] === 'release-compatibility' && request.method === 'GET') {
          const state = await loadState();
          const group = workspaceGroup(state, workspaceId);
          const projectId = url.searchParams.get('projectId') || '';
          if (projectId && !group.projectIds.includes(projectId)) throw Object.assign(new Error('Project is not in this workspace'), { statusCode: 404 });
          const releaseCompatibility = evaluateReleaseCompatibility({ workspaceId,
            environmentId: url.searchParams.get('environmentId') || null,
            candidate: { projectId: projectId || null }, dependencies: [], observations: [], proofs: [],
            discoveryComplete: false, acceptObservation: () => false, acceptProof: () => false });
          return json(response, 200, { releaseCompatibility });
        }
        if (workspaceRoute[2] === "manifest-verify" && request.method === "POST") {
          const payload = await bodyJson(request);
          const state = await loadState();
          const group = normalizeWorkspaceGroups(state).find(entry => entry.id === workspaceId);
          const project = state.projects.find(entry => entry.id === payload.projectId && group?.projectIds.includes(entry.id));
          if (!project?.repositoryBinding) throw Object.assign(new Error("Bind this workspace project to a repository first"), { statusCode: 409 });
          const expected = JSON.stringify(project.repositoryBinding);
          const verified = await verifyGithubRepositoryIdentity(project.repositoryBinding, { token: process.env.AIPI_GITHUB_TOKEN ?? "" });
          await mutateState(next => {
            const target = next.projects.find(entry => entry.id === project.id);
            if (!target || JSON.stringify(target.repositoryBinding) !== expected) throw Object.assign(new Error("Repository binding changed while GitHub verification was running. Reload and retry."), { statusCode: 409 });
            target.repositoryBinding = verified;
          });
          return json(response, 200, { repository: verified });
        }
        if (workspaceRoute[2] === "checkouts" && request.method === "GET") {
          return json(response, 200, { checkouts: workspaceCheckoutBindings(await loadState(), workspaceId) });
        }
        if (workspaceRoute[2] === "checkouts" && request.method === "POST") {
          const payload = await bodyJson(request);
          const state = await loadState();
          const { root } = projectAndAuthorizedRoot(state, payload.projectId, payload.root);
          const inspection = await inspectGitBinding(root, {});
          return json(response, 200, { checkout: await mutateState(next => saveWorkspaceCheckoutBinding(next, workspaceId, { projectId: payload.projectId, root, label: payload.label }, inspection)) });
        }
        if (workspaceRoute[2] === "manifest" && request.method === "GET") {
          return json(response, 200, { manifest: exportWorkspaceManifest(await loadState(), workspaceId) });
        }
        if (workspaceRoute[2] === "manifest" && request.method === "PUT") {
          const payload = await bodyJson(request);
          return json(response, 200, { manifest: await mutateState(state => saveWorkspaceManifest(state, workspaceId, payload)) });
        }
        if ((workspaceRoute[2] === 'relationships' || workspaceRoute[2] === 'relationship-reviews') && request.method === 'GET') {
          return json(response, 200, { relationships: relationshipReviews(await loadState(), workspaceId) });
        }
        if ((workspaceRoute[2] === 'relationships' || workspaceRoute[2] === 'relationship-reviews') && request.method === 'POST') {
          const payload = await bodyJson(request);
          return json(response, 200, { relationship: await mutateState(state => reviewWorkspaceRelationship(state, workspaceId, payload)) });
        }
        if (workspaceRoute[2] === 'receipts' && request.method === 'POST') {
          const payload = await bodyJson(request);
          let receiptResult;
          await mutateState(async (state) => {
            const group = workspaceGroup(state, workspaceId);
            const targetProjectId = payload.projectId && group.projectIds.includes(payload.projectId)
              ? payload.projectId
              : group.projectIds[0];
            const project = state.projects?.find(p => p.id === targetProjectId);
            if (!project) throw Object.assign(new Error("Project not available"), { statusCode: 404 });
            project.verificationReceipts ??= [];
            receiptResult = {
              id: payload.id || `receipt_${crypto.randomUUID().slice(0, 16)}`,
              taskId: payload.taskId,
              status: 'unverified',
              claimedStatus: payload.status ?? null,
              kind: payload.kind ?? 'behavior',
              target: payload.target ?? null,
              claimedProducerId: payload.producerId ?? null,
              evidenceIds: [],
              authority: 'advisory',
              completedAt: new Date().toISOString()
            };
            project.verificationReceipts.unshift(receiptResult);
          });
          return json(response, 200, { ok: true, receipt: receiptResult });
        }
        if (request.method === "PUT" && !workspaceRoute[2]) {
          const payload = await bodyJson(request);
          const workspace = await mutateState((state) => saveWorkspaceGroup(state, payload, workspaceId));
          return json(response, 200, { workspace });
        }
        if (request.method === "GET" && !workspaceRoute[2]) {
          const state = await loadState();
          return json(response, 200, { workspaceModel: buildWorkspaceProjection(state, workspaceId) });
        }
        if (request.method === "GET" && workspaceRoute[2] === "targets") {
          const result = searchWorkspaceTargets(await loadState(), workspaceId, {
            query: url.searchParams.get("q") ?? "", kind: url.searchParams.get("kind") ?? "all",
            offset: url.searchParams.get("offset") ?? 0, limit: url.searchParams.get("limit") ?? 40
          });
          return json(response, 200, result);
        }
        if (request.method === "GET" && workspaceRoute[2] === "target") {
          return json(response, 200, getWorkspaceTarget(await loadState(), workspaceId, url.searchParams.get("key")));
        }
      }
      const workspaceTaskContextRoute = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tasks\/([^/]+)\/(context|context-pack)$/);
      if (workspaceTaskContextRoute) {
        const workspaceId = decodeURIComponent(workspaceTaskContextRoute[1]);
        const taskId = decodeURIComponent(workspaceTaskContextRoute[2]);
        const action = workspaceTaskContextRoute[3];
        const state = await loadState();
        const group = workspaceGroup(state, workspaceId);
        let ownerProject = null;
        let targetTask = null;
        for (const pId of group.projectIds) {
          const proj = state.projects?.find(p => p.id === pId);
          const t = proj?.tasks?.find(item => item.id === taskId);
          if (t) {
            ownerProject = proj;
            targetTask = t;
            break;
          }
        }
        if (!targetTask || !ownerProject) {
          return json(response, 404, { error: "Task not found in this workspace" });
        }
        if (request.method === "GET" && action === "context") {
          return json(response, 200, {
            task: targetTask,
            decisions: targetTask.decisions ?? [],
            evidence: targetTask.evidence ?? [],
            receipts: (ownerProject.verificationReceipts ?? []).filter(r => r.taskId === targetTask.id),
            comments: targetTask.comments ?? []
          });
        }
        if (request.method === "POST" && action === "context-pack") {
          const payload = await bodyJson(request);
          let prep;
          await mutateState(async (nextState) => {
            const nextProj = nextState.projects.find(p => p.id === ownerProject.id);
            const nextTask = nextProj?.tasks?.find(t => t.id === targetTask.id);
            prep = await refreshAndPrepareTaskContext(nextProj, nextTask, payload);
            nextProj.updatedAt = new Date().toISOString();
          });
          return json(response, 200, prep);
        }
      }
      const workspaceTasksRoute = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tasks(?:\/(append))?$/);
      if (request.method === "POST" && workspaceTasksRoute) {
        const workspaceId = decodeURIComponent(workspaceTasksRoute[1]);
        const isAppend = workspaceTasksRoute[2] === "append";
        const payload = await bodyJson(request);
        const state = await loadState();
        const group = workspaceGroup(state, workspaceId);
        if (isAppend) {
          const taskId = payload.taskId;
          let updatedTask;
          await mutateState(async (nextState) => {
            for (const pId of group.projectIds) {
              const proj = nextState.projects?.find(p => p.id === pId);
              const t = proj?.tasks?.find(item => item.id === taskId);
              if (t) {
                if (payload.type === 'comment' && payload.body) {
                  t.comments ??= [];
                  t.comments.push({
                    id: `cmt_${crypto.randomUUID().slice(0, 12)}`,
                    body: String(payload.body).trim(),
                    author: payload.author ?? 'Developer',
                    createdAt: new Date().toISOString()
                  });
                } else if (payload.type === 'decision' && payload.decision) {
                  t.decisions ??= [];
                  t.decisions.push({
                    id: `dec_${crypto.randomUUID().slice(0, 12)}`,
                    summary: String(payload.decision).trim(),
                    rationale: payload.rationale ?? '',
                    madeAt: new Date().toISOString()
                  });
                }
                t.updatedAt = new Date().toISOString();
                updatedTask = t;
                break;
              }
            }
          });
          if (!updatedTask) return json(response, 404, { error: "Task not found to append" });
          return json(response, 200, { ok: true, task: updatedTask });
        }
        let resultTask;
        await mutateState(async (nextState) => {
          if (payload.taskId) {
            for (const pId of group.projectIds) {
              const proj = nextState.projects?.find(p => p.id === pId);
              const t = proj?.tasks?.find(item => item.id === payload.taskId);
              if (t) {
                if (payload.status) t.status = payload.status;
                if (payload.title) t.title = payload.title;
                if (payload.description !== undefined) t.description = payload.description;
                t.version = (t.version ?? 0) + 1;
                t.updatedAt = new Date().toISOString();
                resultTask = t;
                break;
              }
            }
          } else {
            const targetProjectId = payload.projectId && group.projectIds.includes(payload.projectId)
              ? payload.projectId
              : group.projectIds[0];
            const proj = nextState.projects?.find(p => p.id === targetProjectId);
            if (!proj) throw new Error("Project not available");
            const newTask = {
              id: payload.id || `task_${crypto.randomUUID().slice(0, 12)}`,
              title: payload.title || "New Workspace Task",
              description: payload.description || "",
              status: payload.status || "open",
              version: 1,
              scope: payload.scope || group.projectIds.map(p => ({ projectKey: p })),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
            proj.tasks ??= [];
            proj.tasks.push(newTask);
            resultTask = newTask;
          }
        });
        return json(response, 200, { ok: true, task: resultTask });
      }
      const taskSearchRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/search-context$/);
      if (request.method === "POST" && taskSearchRoute) {
        const projectId = decodeURIComponent(taskSearchRoute[1]);
        const payload = await bodyJson(request);
        const query = String(payload.query ?? "").trim();
        if (query.length < 3 || query.length > 500) throw Object.assign(new Error("Search text must be between 3 and 500 characters."), { statusCode: 400 });
        const intent = normalizeTaskIntent(payload.intent ?? "api-contract", null);
        if (!intent) throw Object.assign(new Error(`Choose a supported task intent: ${supportedTaskIntents().join(", ")}.`), { statusCode: 400 });
        const savedState = await loadState();
        const savedProject = savedState.projects.find((entry) => entry.id === projectId);
        if (!savedProject) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
        const owner = structuredClone(savedProject);
        buildProjectKnowledgeGraph(owner, {
          pinnedEdges: owner.knowledgeGraph?.pinnedEdges ?? [],
          runtimeEdges: owner.knowledgeGraph?.edges?.filter((edge) => edge.provenance === "runtime") ?? [],
          rejectedEdgeIds: owner.knowledgeGraph?.rejectedEdgeIds ?? [],
          ignoredBlindSpotIds: owner.knowledgeGraph?.ignoredBlindSpotIds ?? []
        });
        const previewTask = { id: "draft-search-preview", title: query, description: query, intent, contractIds: [], artifactIds: [] };
        const discovery = discoverTaskContext(owner, previewTask, { maxContracts: 3, tokenBudget: 2400 });
        const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2))];
        const routeMention = query.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[A-Za-z0-9._~!$&'()*+,;=:@%{}\/-]+)/i);
        const normalizeRoute = (value) => String(value ?? "/").replace(/^\{\{[^}]+\}\}/, "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
        const openFindings = (contract) => (owner.findings ?? []).filter((finding) =>
          finding.contractId === contract.id && !["resolved", "dismissed", "closed"].includes(String(finding.status).toLowerCase()));
        const contractEntry = (contract) => {
          const route = contract.route ?? contract.normalizedPath ?? "/";
          const endpoint = (owner.sourceContext?.endpoints ?? []).find((entry) => contract.sourceArtifactIds?.includes(entry.id)
            || (entry.method === contract.method && normalizeRoute(entry.path) === normalizeRoute(route)));
          const implementation = contract.implementation ?? endpoint ?? {};
          const source = implementation.source ?? endpoint?.source ?? null;
          const findings = openFindings(contract);
          const haystack = `${contract.method} ${route} ${contract.name ?? ""} ${source ?? ""} ${findings.map((finding) => `${finding.title ?? ""} ${finding.description ?? ""}`).join(" ")}`.toLowerCase();
          const matchedTerms = words.filter((word) => haystack.includes(word));
          const exact = Boolean(routeMention && String(contract.method).toUpperCase() === routeMention[1].toUpperCase()
            && normalizeRoute(route) === normalizeRoute(routeMention[2]));
          return {
            contract: {
              id: contract.id, method: contract.method, route, normalizedPath: contract.normalizedPath,
              name: contract.name, state: contract.state, comparisonState: contract.comparisonState
            },
            source: { source, line: implementation.line ?? endpoint?.line ?? null, root: implementation.root ?? endpoint?.root ?? null },
            matchedTerms, exact, findings: findings.map((finding) => ({
              id: finding.id, title: finding.title, severity: finding.severity, status: finding.status
            })),
            reason: matchedTerms.length ? `Matched ${matchedTerms.join(", ")}` : findings.length ? `${findings.length} open finding${findings.length === 1 ? "" : "s"}` : `Status: ${contract.state ?? contract.comparisonState ?? "unverified"}`
          };
        };
        const rankedEntries = discovery.selectedContracts.map(contractEntry);
        const contractMatches = (owner.contracts ?? []).map(contractEntry)
          .filter((entry) => entry.exact || entry.matchedTerms.length)
          .sort((a, b) => Number(b.exact) - Number(a.exact) || b.matchedTerms.length - a.matchedTerms.length || b.findings.length - a.findings.length)
          .slice(0, 8);
        const discoverySuggestions = ["discovery", "full-stack"].includes(intent) ? rankedEntries.slice(0, 3) : [];
        const indexedSourceMatches = taskArtifacts(owner).map((artifact) => {
          const haystack = `${artifact.label} ${artifact.kind} ${artifact.source}`.toLowerCase();
          const matchedTerms = words.filter((word) => haystack.includes(word));
          const relationship = artifact.kind === "consumer" ? "Frontend API caller"
            : artifact.kind === "endpoint" ? "Backend route or handler"
            : ["component", "page"].includes(artifact.kind) ? "Frontend component or page"
            : artifact.kind === "schema" || artifact.kind === "model" ? "Schema or data model"
            : artifact.kind === "test" ? "Test file" : "Indexed source reference";
          return { ...artifact, matchedTerms, relationship, materialize: false };
        }).filter((artifact) => artifact.matchedTerms.length)
          .sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || a.source.localeCompare(b.source))
          .slice(0, 8);
        const workspaceMatches = await searchIndexedWorkspaceFiles(owner, words, 12);
        const sourceMatches = [...new Map([...indexedSourceMatches, ...workspaceMatches].map((entry) => [entry.id, entry])).values()].slice(0, 12);
        return json(response, 200, {
          query, intent, indexedAt: owner.sourceContext?.lastScannedAt ?? "not indexed",
          contractMatches, discoverySuggestions, sourceMatches,
          resultCount: contractMatches.length + sourceMatches.length,
          coverage: {
            roots: owner.sourceContext?.roots?.length ?? 0,
            filesScanned: owner.sourceContext?.filesScanned ?? 0,
            indexedReferences: taskArtifacts(owner).length,
            frontendCalls: owner.sourceContext?.frontendCalls?.length ?? 0,
            integrations: owner.sourceContext?.integrations?.length ?? 0,
            scope: "last-local-index"
          }
        });
      }
      const taskCreateRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks(?:\/([^/]+))?$/);
      if (request.method === "POST" && taskCreateRoute) {
        const projectId = decodeURIComponent(taskCreateRoute[1]);
        const taskId = taskCreateRoute[2] ? decodeURIComponent(taskCreateRoute[2]) : null;
        const payload = await bodyJson(request);
        let created;
        await mutateState(async (state) => {
          const owner = state.projects.find((entry) => entry.id === projectId);
          if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          const existingTask = taskId ? owner.tasks?.find((entry) => entry.id === taskId) : null;
          if (taskId && !existingTask) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
          if (existingTask && payload.expectedTaskUpdatedAt && existingTask.updatedAt !== payload.expectedTaskUpdatedAt) throw Object.assign(new Error("This task was changed elsewhere. Your edits are preserved; review the latest task before saving."), { statusCode: 409 });
          const input = taskId ? { ...existingTask, ...payload.task, id: taskId } : payload.task;
          if (!payload.selectionContext && input) {
            input.targetRefs = existingTask?.targetRefs ?? [];
            input.workspaceGroupId = existingTask?.workspaceGroupId ?? null;
          }
          if (payload.selectionContext) {
            const selection = payload.selectionContext;
            if (!input?.id || !Array.isArray(selection.targetKeys) || selection.targetKeys.length > 50) throw Object.assign(new Error("Select at most 50 targets."), { statusCode: 400 });
            const targets = selection.targetKeys.map((key) => getWorkspaceTarget(state, selection.workspaceGroupId, key).target);
            if (!state.workspaceGroups?.find(g => g.id === selection.workspaceGroupId)?.projectIds.includes(projectId) || targets.some(target => target.kind === "service")) throw Object.assign(new Error("Select source or API targets from a workspace containing the task's project."), { statusCode: 400 });
            const fingerprint = crypto.createHash("sha256").update(JSON.stringify([input, selection])).digest("hex");
            const previous = owner.tasks?.find((task) => task.id === input.id);
            if (previous && !taskId) {
              if (previous.selectionCreationFingerprint !== fingerprint) throw Object.assign(new Error("Task ID was already used for different input."), { statusCode: 409 });
              created = { task: previous, contextPack: owner.contextPacks?.find((pack) => pack.id === previous.contextPackId) };
              return;
            }
            input.workspaceGroupId = selection.workspaceGroupId;
            input.contextSelectionMode = "manual";
            input.targetRefs = targets.map((target) => target.ref);
            if (!taskId) input.selectionCreationFingerprint = fingerprint;
            input.contractIds = targets.filter((target) => target.ref.projectId === projectId && target.kind === "api").map((target) => target.ref.entityId);
            input.requestIds = targets.filter((target) => target.ref.projectId === projectId && target.kind === "request").map((target) => target.ref.entityId);
            input.artifactIds = targets.filter((target) => target.ref.projectId === projectId && !["api", "request"].includes(target.kind)).map((target) => target.ref.entityId);
            // Retain missing legacy references only when they already belong to this task.
            for (const ref of selection.retainedMissing ?? []) {
              if (ref.targetRef) {
                if (!existingTask?.targetRefs?.some(saved=>JSON.stringify(saved)===JSON.stringify(ref.targetRef))) throw Object.assign(new Error("Cannot add an unavailable workspace reference."),{statusCode:400});
                input.targetRefs.push(ref.targetRef); continue;
              }
              const field = ref.kind === "api" ? "contractIds" : ref.kind === "request" ? "requestIds" : "artifactIds";
              if (!existingTask?.[field]?.includes(ref.id)) throw Object.assign(new Error("Cannot add an unavailable reference."), { statusCode: 400 });
              input[field].push(ref.id);
            }
            delete input.selectedTargets;
            delete input.contextReview;
            delete input.contextMessage;
            delete input.agentSuggestions;
          }
          if (!input || typeof input !== "object" || !String(input.title ?? "").trim() || !String(input.description ?? "").trim()) {
            throw Object.assign(new Error("A task title and objective are required."), { statusCode: 400 });
          }
          if (String(input.title).trim().length > 240 || String(input.description).trim().length > 4000) {
            throw Object.assign(new Error("Task title must be at most 240 characters and objective at most 4,000 characters."), { statusCode: 400 });
          }
          const normalizedIntent = normalizeTaskIntent(input.intent ?? "api-contract", null);
          if (!normalizedIntent) {
            throw Object.assign(new Error("Choose a supported task intent."), { statusCode: 400 });
          }
          input.intent = normalizedIntent;
          if (input.priority && !["low", "medium", "high", "urgent"].includes(input.priority)) {
            throw Object.assign(new Error("Choose a supported task priority."), { statusCode: 400 });
          }
          let plannedContract = null;
          let plannedRequest = null;
          if (payload.plannedContract || input.intent === "new-contract") {
            if (!payload.plannedContract) throw Object.assign(new Error("A method and route path are required for a new API contract."), { statusCode: 400 });
            const spec = payload.plannedContract;
            const method = String(spec.method ?? "").toUpperCase();
            const route = String(spec.path ?? "").trim().replace(/\/+$/, "") || "/";
            if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || route.length > 500 || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%{}\/-]*$/.test(route) || route.includes("//")) {
              throw Object.assign(new Error("Enter a supported HTTP method and a valid absolute route path."), { statusCode: 400 });
            }
            const existingSpec = (owner.contracts ?? []).find((entry) => entry.method === method && (entry.route === route || entry.normalizedPath === route));
            if (existingSpec && existingSpec.state === "Planned" && (input.contractIds?.includes(existingSpec.id) || existingTask?.contractIds?.includes(existingSpec.id))) {
              plannedContract = existingSpec;
              plannedRequest = (owner.requests ?? []).find((entry) => entry.contractId === existingSpec.id) ?? null;
            } else if (existingSpec) {
              throw Object.assign(new Error(`${method} ${route} is already registered. Link the existing contract instead.`), { statusCode: 409 });
            }
            if (plannedContract) {
              // Reuse this task's already provisioned spec and saved request.
            } else {
            const parseExample = (value, label) => {
              if (!String(value ?? "").trim()) return undefined;
              if (String(value).length > 3000) throw Object.assign(new Error(`${label} must be at most 3,000 characters so the planned spec fits the task context budget.`), { statusCode: 400 });
              try { return JSON.parse(value); }
              catch { throw Object.assign(new Error(`${label} must be valid JSON.`), { statusCode: 400 }); }
            };
            const requestExample = parseExample(spec.requestExample, "Request example");
            const responseExample = parseExample(spec.responseExample, "Response example");
            const targetFile = String(spec.targetFile ?? "").trim();
            if (targetFile.length > 500 || (targetFile && (path.isAbsolute(targetFile) || path.win32.isAbsolute(targetFile) || targetFile.split(/[\\/]/).includes("..") || targetFile.includes("\0")))) {
              throw Object.assign(new Error("Target handler must be a project-relative path without parent-directory segments."), { statusCode: 400 });
            }
            const contractId = newId("contract");
            const revisionId = newId("contractrev");
            plannedContract = {
              id: contractId, projectId, method, route, normalizedPath: route, normalizedRoute: route,
              name: `${method} ${route}`, state: "Planned", comparisonState: "Planned",
              createdFrom: "task-spec", sourceArtifactIds: [], sourceRequestIds: [],
              implementation: { source: targetFile || null, line: null },
              expectedSchema: { request: requestExample ?? null, response: responseExample ?? null, targetFile: targetFile || null },
              currentRevisionId: revisionId, updatedAt: new Date().toISOString()
            };
            plannedRequest = defaultRequest(`${method} ${route}`);
            plannedRequest.contractId = contractId;
            plannedRequest.method = method;
            plannedRequest.url = `{{baseUrl}}${route.replace(/\{([^}]+)\}|:([A-Za-z0-9_]+)/g, (_, braced, colon) => `{{${braced ?? colon}}}`)}`;
            plannedRequest.body = { type: "json", content: requestExample === undefined || ["GET", "HEAD"].includes(method) ? "" : JSON.stringify(requestExample, null, 2), provenance: "task-spec" };
            plannedRequest.docs = `Planned API contract. ${targetFile ? `Target handler: ${targetFile}. ` : ""}Implement and re-index before replay.`;
            plannedRequest.assertions = [{ type: "status", equals: method === "POST" ? 201 : method === "DELETE" ? 204 : 200 }];
            plannedRequest.origin = "task-spec";
            plannedRequest.createdAt = plannedContract.updatedAt;
            owner.contracts ??= [];
            owner.requests ??= [];
            owner.collections ??= [];
            owner.contracts.push(plannedContract);
            owner.requests.push(plannedRequest);
            plannedContract.sourceRequestIds.push(plannedRequest.id);
            let suite = owner.collections.find((entry) => entry.id === "planned-api-suite");
            if (!suite) {
              suite = { id: "planned-api-suite", name: "Planned API Contracts", origin: "task-spec", stopOnFailure: false, executionOrder: [], requestIds: [], sharedVariables: {} };
              owner.collections.push(suite);
            }
            suite.executionOrder = [...new Set([...(suite.executionOrder ?? []), plannedRequest.id])];
            suite.requestIds = [...new Set([...(suite.requestIds ?? []), plannedRequest.id])];
            }
          }
          const milestoneTitle = String(input.milestoneTitle ?? "").trim();
          if (milestoneTitle.length > 240) throw Object.assign(new Error("Milestone title must be at most 240 characters."), { statusCode: 400 });
          let milestoneIds = Array.isArray(input.milestoneIds) ? input.milestoneIds : [];
          if (milestoneTitle) {
            let milestone = (owner.milestones ?? []).find((entry) => entry.title.toLowerCase() === milestoneTitle.toLowerCase());
            if (!milestone) {
              milestone = { id: newId("milestone"), title: milestoneTitle, description: "", targetDate: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
              owner.milestones ??= [];
              owner.milestones.push(milestone);
            }
            milestoneIds = [milestone.id];
          }
          if (milestoneIds.some((id) => !(owner.milestones ?? []).some((milestone) => milestone.id === id))) {
            throw Object.assign(new Error("Choose a milestone from this project."), { statusCode: 400 });
          }
          const contractIds = [...new Set([...(Array.isArray(input.contractIds) ? input.contractIds : []), ...(plannedContract ? [plannedContract.id] : [])])];
          if (contractIds.some((id) => !(owner.contracts ?? []).some((contract) => contract.id === id) && !existingTask?.contractIds?.includes(id))) {
            throw Object.assign(new Error("Choose contracts from this project."), { statusCode: 400 });
          }
          if (Array.isArray(input.acceptanceCriteria) && (input.acceptanceCriteria.length > 20 || input.acceptanceCriteria.some((criterion) => String(criterion).length > 500))) {
            throw Object.assign(new Error("Add at most 20 acceptance criteria, each no longer than 500 characters."), { statusCode: 400 });
          }
          const workspaceFileRefs = Array.isArray(input.workspaceFileRefs) ? input.workspaceFileRefs.slice(0, 12) : [];
          if (Array.isArray(input.workspaceFileRefs) && input.workspaceFileRefs.length > 12) {
            throw Object.assign(new Error("Link at most 12 workspace files to a task."), { statusCode: 400 });
          }
          owner.sourceContext ??= {};
          owner.sourceContext.artifacts ??= [];
          const materializedArtifactIds = [];
          for (const reference of workspaceFileRefs) {
            const root = path.resolve(String(reference.root ?? ""));
            const authorized = (owner.sourceContext.roots ?? []).some((entry) => path.resolve(entry.path) === root);
            const source = String(reference.source ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
            const kind = ["component", "page", "test", "model", "document"].includes(reference.kind) ? reference.kind : "document";
            if (!authorized || !source || path.isAbsolute(source) || source.split("/").includes("..") || source.includes("\0")) {
              throw Object.assign(new Error("Workspace file references must come from the current project's indexed source roots."), { statusCode: 400 });
            }
            let indexed = false;
            try {
              const cache = JSON.parse(await fs.readFile(path.join(root, ".api-forge", "cache", "source-index-v1.json"), "utf8"));
              indexed = Boolean(cache.files?.[source]);
            } catch {}
            if (!indexed) throw Object.assign(new Error("Re-index the project before linking this workspace file."), { statusCode: 409 });
            const nativeId = "workspace_" + crypto.createHash("sha256").update(root + ":" + source).digest("hex").slice(0, 24);
            const artifactId = kind + ":" + nativeId;
            if (!owner.sourceContext.artifacts.some((entry) => entry.id === nativeId && entry.kind === kind)) {
              owner.sourceContext.artifacts.push({ id: nativeId, kind, name: path.basename(source), source, root, provenance: "task-draft-index-search", indexedAt: owner.sourceContext.lastScannedAt ?? null });
            }
            materializedArtifactIds.push(artifactId);
          }
          const task = {
            ...(existingTask ?? {}), ...input, id: String(input.id || newId("task")), projectId,
            title: String(input.title).trim(), description: String(input.description).trim(),
            status: input.status ?? "planned", category: input.category ?? "feature",
            priority: input.priority ?? "medium", milestoneIds,
            contractIds,
            artifactIds: [...new Set([...(Array.isArray(input.artifactIds) ? input.artifactIds : []), ...materializedArtifactIds])],
            findingIds: Array.isArray(input.findingIds) ? input.findingIds : [],
            requestIds: [...new Set([...(Array.isArray(input.requestIds) ? input.requestIds : []), ...(plannedRequest ? [plannedRequest.id] : [])])],
            acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.map((entry) => String(entry).trim()).filter(Boolean) : [],
            createdAt: input.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          if (existingTask && JSON.stringify([existingTask.description, existingTask.artifactIds, existingTask.contractIds, existingTask.requestIds, existingTask.acceptanceCriteria, existingTask.targetRefs]) !== JSON.stringify([task.description, task.artifactIds, task.contractIds, task.requestIds, task.acceptanceCriteria, task.targetRefs])) {
            task.verificationScopeChangedAt = task.updatedAt;
          }
          delete task.milestoneTitle;
          delete task.workspaceFileRefs;
          owner.tasks ??= [];
          if (existingTask) owner.tasks[owner.tasks.indexOf(existingTask)] = task;
          else owner.tasks.push(task);
          let preparation;
          try { preparation = await refreshAndPrepareTaskContext(owner, task, { tokenBudget: 2400, level: "working" }); }
          catch (error) { task.contextStatus = "error"; task.contextError = error.message; preparation = { contextError: error.message }; }
          const commitPack = task.intent === "commit-pr" ? await buildCommitPack(owner, task) : null;
          if (commitPack) task.commitPack = commitPack;
          owner.updatedAt = task.updatedAt;
          await syncProjectTeamMemory(owner);
          appendTimelineEvent(state, {
            projectId, type: "decision", severity: "success", actor: "developer", title: existingTask ? "Task updated and context prepared" : "Task created with prepared context",
            summary: `${task.title} has prepared ${task.contractIds.length ? "contract and source" : "source and objective"} context plus a revision-linked verification plan.`,
            tags: ["task", task.intent ?? "discovery"],
            source: { kind: "task", ref: task.id },
            evidence: { taskId: task.id, contractIds: task.contractIds, contextPackId: task.contextPackId, verificationPlanId: task.verificationPlanId }
          });
          created = { task, plannedContract, plannedRequest, commitPack, ...preparation };
        });
        return json(response, taskId ? 200 : 201, { ...created, state: publicState(await loadState()) });
      }
      // `context` is retained as a stable, descriptive alias for clients that
      // predate the split between discovery and handoff preparation.  All
      // three operations deliberately use the same bounded preparation path:
      // a task must never expose a partially-shaped context response.
      const taskDiscoveryRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/(discover-context|prepare-context|context)$/);
      if (request.method === "POST" && taskDiscoveryRoute) {
        const payload = await bodyJson(request);
        let discovery;
        await mutateState(async (state) => {
          const owner = state.projects.find((entry) => entry.id === decodeURIComponent(taskDiscoveryRoute[1]));
          if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          const task = owner.tasks?.find((entry) => entry.id === decodeURIComponent(taskDiscoveryRoute[2]));
          if (!task) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
          discovery = await refreshAndPrepareTaskContext(owner, task, { tokenBudget: payload.tokenBudget, level: payload.level });
          owner.updatedAt = new Date().toISOString();
          await syncProjectTeamMemory(owner);
        });
        return json(response, 200, { ok: true, ...discovery });
      }
      const taskReleaseRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/(commit-pack|deployment-preflight)$/);
      if (request.method === "POST" && taskReleaseRoute) {
        let result;
        await mutateState(async (state) => {
          const owner = state.projects.find((entry) => entry.id === decodeURIComponent(taskReleaseRoute[1]));
          if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          const task = owner.tasks?.find((entry) => entry.id === decodeURIComponent(taskReleaseRoute[2]));
          if (!task) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
          if (taskReleaseRoute[3] === "commit-pack") {
            result = await buildCommitPack(owner, task);
            task.commitPack = result;
          } else {
            result = await evaluateDeploymentGate(owner, task, { checkEnvironment: async (target) => {
              const probe = defaultRequest("Deployment pre-flight health check");
              probe.method = "GET";
              probe.url = target;
              probe.timeoutMs = 8000;
              probe.retry = { enabled: false };
              return executeSaved(executeRequest, owner, probe, { maxAttempts: 1 });
            } });
            task.deploymentGate = result;
          }
          task.updatedAt = new Date().toISOString();
        });
        return json(response, 200, { ok: true, result });
      }
      const graphRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph$/);
      if (request.method === "GET" && graphRoute) {
        const state = await loadState();
        const owner = state.projects.find((entry) => entry.id === decodeURIComponent(graphRoute[1]));
        if (!owner) return json(response, 404, { error: "Project not found" });
        const graph = buildProjectKnowledgeGraph(owner, { pinnedEdges: owner.knowledgeGraph?.pinnedEdges ?? [], runtimeEdges: owner.knowledgeGraph?.edges?.filter((edge) => edge.provenance === "runtime") ?? [], rejectedEdgeIds: owner.knowledgeGraph?.rejectedEdgeIds ?? [], ignoredBlindSpotIds: owner.knowledgeGraph?.ignoredBlindSpotIds ?? [] });
        const blindSpots = findGraphBlindSpots(owner);
        const counts = blindSpots.reduce((summary, spot) => ({ ...summary, [spot.type]: (summary[spot.type] ?? 0) + 1 }), {});
        return json(response, 200, { graph, blindSpots, summary: { nodes: graph.nodes.length, edges: graph.edges.length, confirmedEdges: graph.edges.filter((edge) => edge.confirmationState === "confirmed").length, runtimeEdges: graph.edges.filter((edge) => edge.provenance === "runtime").length, blindSpots: blindSpots.length, counts } });
      }
      const graphTraverseRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph\/traverse$/);
      if (request.method === "GET" && graphTraverseRoute) {
        const state = await loadState();
        const owner = state.projects.find((entry) => entry.id === decodeURIComponent(graphTraverseRoute[1]));
        if (!owner) return json(response, 404, { error: "Project not found" });
        buildProjectKnowledgeGraph(owner, { pinnedEdges: owner.knowledgeGraph?.pinnedEdges ?? [], runtimeEdges: owner.knowledgeGraph?.edges?.filter((edge) => edge.provenance === "runtime") ?? [], rejectedEdgeIds: owner.knowledgeGraph?.rejectedEdgeIds ?? [], ignoredBlindSpotIds: owner.knowledgeGraph?.ignoredBlindSpotIds ?? [] });
        return json(response, 200, traverseKnowledgeGraph(owner, { nodeId: url.searchParams.get("nodeId"), direction: url.searchParams.get("direction") ?? "both", depth: url.searchParams.get("depth") ?? 2, minConfidence: url.searchParams.get("minConfidence") ?? .5 }));
      }
      const graphEdgeRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/graph\/edges\/(confirm|reject)$/);
      if (request.method === "POST" && graphEdgeRoute) {
        const payload = await bodyJson(request);
        let result;
        await mutateState(async (state) => {
          const owner = state.projects.find((entry) => entry.id === decodeURIComponent(graphEdgeRoute[1]));
          if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          const graph = owner.knowledgeGraph ?? buildProjectKnowledgeGraph(owner);
          const action = graphEdgeRoute[2];
          if (action === "reject") {
            if (payload.blindSpotId) graph.ignoredBlindSpotIds = [...new Set([...(graph.ignoredBlindSpotIds ?? []), payload.blindSpotId])];
            if (payload.edgeId) {
              graph.rejectedEdgeIds = [...new Set([...(graph.rejectedEdgeIds ?? []), payload.edgeId])];
              const edge = graph.edges.find((entry) => entry.id === payload.edgeId);
              if (edge) edge.confirmationState = "rejected";
            }
            result = { action, blindSpotId: payload.blindSpotId ?? null, edgeId: payload.edgeId ?? null };
          } else {
            let edge = graph.edges.find((entry) => entry.id === payload.edgeId);
            const fromNodeId = payload.fromNodeId ?? edge?.fromNodeId ?? edge?.from;
            const toNodeId = payload.toNodeId ?? edge?.toNodeId ?? edge?.to;
            if (!fromNodeId || !toNodeId || !graph.nodes.some((node) => node.id === fromNodeId) || !graph.nodes.some((node) => node.id === toNodeId)) throw Object.assign(new Error("Confirming an edge requires valid fromNodeId and toNodeId graph nodes."), { statusCode: 400 });
            edge ??= { id: payload.edgeId ?? `edge_${crypto.createHash("sha256").update(JSON.stringify([payload.type ?? "CALLS", fromNodeId, toNodeId])).digest("hex").slice(0, 24)}`, type: payload.type ?? "CALLS", fromNodeId, toNodeId, from: fromNodeId, to: toNodeId, sourceRevision: owner.sourceContext?.gitRevision ?? owner.sourceContext?.git?.find((entry) => entry.commit)?.commit ?? owner.sourceContext?.lastScannedAt };
            Object.assign(edge, { fromNodeId, toNodeId, from: fromNodeId, to: toNodeId, type: payload.type ?? edge.type, provenance: "manual", confidence: 1, confirmationState: "confirmed", confirmedBy: payload.confirmedBy ?? "developer", confirmedAt: new Date().toISOString(), stale: false });
            if (!graph.edges.some((entry) => entry.id === edge.id)) graph.edges.push(edge);
            graph.pinnedEdges = [...new Map([...(graph.pinnedEdges ?? []), edge].map((entry) => [entry.id, entry])).values()];
            if (payload.blindSpotId) graph.ignoredBlindSpotIds = (graph.ignoredBlindSpotIds ?? []).filter((id) => id !== payload.blindSpotId);
            if (edge.type === "TESTED_BY") for (const finding of owner.findings ?? []) if (finding.contractId === fromNodeId && /no indexed test|untested/i.test(`${finding.type} ${finding.title}`)) finding.status = "resolved";
            result = { action, edge };
          }
          graph.unresolvedEdges = findGraphBlindSpots(owner);
          await syncProjectTeamMemory(owner);
        });
        return json(response, 200, { ok: true, ...result });
      }
      // Keep the explicit verification-plan route compatible with clients
      // that request a preview separately from execution.  Returning the
      // envelope below (rather than the plan itself) lets all clients safely
      // consume `plan.steps`, while the top-level `steps` supports older
      // integrations that consumed the preview directly.
      const taskCheckCatalogRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/check-catalog$/);
      if (request.method === "GET" && taskCheckCatalogRoute) {
        const state = await loadState();
        const owner = state.projects.find((entry) => entry.id === decodeURIComponent(taskCheckCatalogRoute[1]));
        if (!owner) return json(response, 404, { error: "Project not found" });
        return json(response, 200, { checks: await discoverProjectCheckCatalog(owner), note: "Discovered package scripts are untrusted until individually reviewed and selected. AIPI never runs them during discovery." });
      }
      const taskCheckJobRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/verification-jobs(?:\/([^/]+))?(?:\/(cancel))?$/);
      if (taskCheckJobRoute) {
        const projectId = decodeURIComponent(taskCheckJobRoute[1]);
        const taskId = decodeURIComponent(taskCheckJobRoute[2]);
        const jobId = taskCheckJobRoute[3] ? decodeURIComponent(taskCheckJobRoute[3]) : null;
        if (request.method === "POST" && !jobId) {
          const payload = await bodyJson(request);
          let created;
          await mutateState((state) => {
            const owner = state.projects.find((entry) => entry.id === projectId);
            if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
            if (payload.handoffId && !state.handoffs?.some((entry) => entry.id === payload.handoffId && entry.projectId === projectId && entry.taskId === taskId && entry.contextPackId === owner.tasks?.find((task) => task.id === taskId)?.contextPackId)) throw Object.assign(new Error("The selected handoff does not match this task's current context generation."), { statusCode: 409 });
            created = createTaskVerificationJob(owner, taskId, payload);
          });
          if (!created.replayed) setImmediate(() => runTaskVerificationJob(created.job.id, {
            loadState, mutateState,
            createExecutors: ({ project, task }) => ({
              executeApiReplay: (savedRequest, { project: executionProject }) => executeSaved(executeRequest, executionProject, savedRequest, { maxAttempts: 1 }),
              executeTestCommand: (configuredCommand, { project: executionProject }) => executeLinkedTestCommand(executionProject, configuredCommand),
              checkEnvironmentHealth: async (target) => {
                const probe = defaultRequest("Deployment pre-flight health check");
                probe.method = "GET"; probe.url = target; probe.timeoutMs = 8000; probe.retry = { enabled: false };
                return executeSaved(executeRequest, project, probe, { maxAttempts: 1 });
              }
            })
          }).catch((error) => console.error("AIPI task verification job failed", error)));
          return json(response, created.replayed ? 200 : 202, { ok: true, replayed: created.replayed, job: created.job });
        }
        if (request.method === "GET" && jobId && !taskCheckJobRoute[4]) {
          const state = await loadState();
          const owner = state.projects.find((entry) => entry.id === projectId);
          if (!owner) return json(response, 404, { error: "Project not found" });
          const job = owner.verificationJobs?.find((entry) => entry.id === jobId && entry.taskId === taskId);
          if (!job) return json(response, 404, { error: "Verification job not found" });
          return json(response, 200, { ok: true, job });
        }
        if (request.method === "POST" && jobId && taskCheckJobRoute[4] === "cancel") {
          let result;
          await mutateState((state) => {
            const owner = state.projects.find((entry) => entry.id === projectId);
            if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
            result = requestVerificationJobCancellation(owner, taskId, jobId);
          });
          return json(response, 200, { ok: true, ...result });
        }
      }
      const taskVerificationRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/(verify|verification-plan)$/);
      if (request.method === "GET" && taskVerificationRoute) {
        let plan;
        await mutateState((state) => {
          const owner = state.projects.find((entry) => entry.id === decodeURIComponent(taskVerificationRoute[1]));
          if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          const task = owner.tasks?.find((entry) => entry.id === decodeURIComponent(taskVerificationRoute[2]));
          if (!task) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
          plan = ensureTaskVerificationPlan(owner, task);
        });
        // A malformed persisted plan must not reach a UI as `undefined`.
        // ensureTaskVerificationPlan regenerates the plan, and this final
        // normalization protects clients during migrations from older state.
        plan.steps = Array.isArray(plan.steps) ? plan.steps : [];
        plan.stepIds = Array.isArray(plan.stepIds) ? plan.stepIds : plan.steps.map((step) => step.id).filter(Boolean);
        return json(response, 200, { ok: true, plan, steps: plan.steps });
      }
      if (request.method === "POST" && taskVerificationRoute) {
        const payload = await bodyJson(request);
        let verification;
        await mutateState(async (state) => {
          const projectId = decodeURIComponent(taskVerificationRoute[1]);
          const taskId = decodeURIComponent(taskVerificationRoute[2]);
          const owner = state.projects.find((entry) => entry.id === projectId);
          if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          const task = owner.tasks?.find((entry) => entry.id === taskId);
          if (!task) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
          verification = await executeTaskVerificationPlan(owner, task, {
            allowStateChangingReplay: payload.allowStateChangingReplay === true || payload.approveStateChangingReplays === true,
            targetSnapshotHash: payload.targetSnapshotHash,
            contextPackId: task.contextPackId ?? null,
            handoffId: state.handoffs?.find((entry) => entry.projectId === projectId && entry.taskId === taskId && entry.contextPackId === task.contextPackId)?.id ?? null,
            executeApiReplay: (savedRequest, { project: executionProject }) => executeSaved(executeRequest, executionProject, savedRequest, { maxAttempts: 1 }),
            executeTestCommand: (configuredCommand, { project: executionProject }) => executeLinkedTestCommand(executionProject, configuredCommand),
            checkEnvironmentHealth: async (target) => {
              const probe = defaultRequest("Deployment pre-flight health check");
              probe.method = "GET"; probe.url = target; probe.timeoutMs = 8000; probe.retry = { enabled: false };
              return executeSaved(executeRequest, owner, probe, { maxAttempts: 1 });
            }
          });
          owner.updatedAt = new Date().toISOString();
          appendTimelineEvent(state, {
            projectId, type: "verification", severity: verification.receipt.result === "Verified" ? "success" : verification.receipt.result === "Failed" ? "danger" : "warning",
            actor: "developer", title: `Task verification ${verification.receipt.result.toLowerCase()}`,
            summary: `${task.title} produced receipt ${verification.receipt.id}.`, tags: ["verification", verification.receipt.result],
            source: { kind: "task", ref: task.id }, evidence: { receiptId: verification.receipt.id, checkResults: verification.checkResults }
          });
        });
        return json(response, 200, { ok: true, receipt: verification.receipt, plan: verification.plan, checkResults: verification.checkResults });
      }
      const contractTaskRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/contracts\/([^/]+)\/task-draft$/);
      if (request.method === "POST" && contractTaskRoute) {
        let result;
        await mutateState(state => {
          const owner = state.projects.find(item => item.id === decodeURIComponent(contractTaskRoute[1]));
          if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          result = synthesizeTaskFromContract(owner, decodeURIComponent(contractTaskRoute[2]));
          owner.updatedAt = new Date().toISOString();
        });
        return json(response, result.created ? 201 : 200, { ...result, state: publicState(await loadState()) });
      }
      const findingTaskRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/findings\/([^/]+)\/task-draft$/);
      if (request.method === "POST" && findingTaskRoute) {
        const projectId = decodeURIComponent(findingTaskRoute[1]);
        const findingId = decodeURIComponent(findingTaskRoute[2]);
        let result;
        await mutateState((state) => {
          const owner = state.projects.find((entry) => entry.id === projectId);
          if (!owner) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          result = synthesizeTaskFromFinding(owner, findingId);
          owner.updatedAt = new Date().toISOString();
          appendTimelineEvent(state, { projectId, type: "decision", severity: "info", actor: "aipi", title: result.created ? "AI task draft generated" : "Existing task draft reused", summary: `${result.task.title} is linked to finding ${findingId}.`, tags: ["task-synthesis", result.created ? "proposed" : "deduplicated"], source: { kind: "finding", ref: findingId }, evidence: { taskId: result.task.id, contextPackId: result.task.contextPackId, verificationPlanId: result.task.verificationPlanId } });
        });
        return json(response, result.created ? 201 : 200, { ...result, state: publicState(await loadState()) });
      }
      const findingTestRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/findings\/([^/]+)\/generate-test$/);
      if (request.method === "POST" && findingTestRoute) {
        const projectId = decodeURIComponent(findingTestRoute[1]);
        const findingId = decodeURIComponent(findingTestRoute[2]);
        const payload = await bodyJson(request);
        const current = await loadState();
        const owner = current.projects.find((entry) => entry.id === projectId);
        if (!owner) return json(response, 404, { error: "Project not found" });
        const finding = [...(owner.findings ?? []), ...(owner.sourceContext?.findings ?? [])].find((entry) => entry.id === findingId);
        if (!finding) return json(response, 404, { error: "Finding not found" });
        const integration = owner.sourceContext?.integrations?.find((entry) => entry.id === finding.integrationId);
        const contract = owner.contracts?.find((entry) => entry.id === finding.contractId)
          ?? owner.contracts?.find((entry) => entry.sourceArtifactIds?.includes(finding.endpointId ?? integration?.endpointId));
        const savedRequest = owner.requests?.find((entry) => entry.contractId === contract?.id)
          ?? owner.requests?.find((entry) => String(entry.method).toUpperCase() === String(contract?.method ?? integration?.method).toUpperCase() && normalizeRoute(entry.url) === normalizeRoute(contract?.route ?? integration?.path));
        if (!contract || !savedRequest) return json(response, 409, { error: "Index this route again so AIPI can synthesize its saved request before generating a test." });
        const environment = owner.environments?.find((entry) => entry.id === owner.activeEnvironmentId) ?? owner.environments?.[0];
        const baseUrl = variablesFor(owner).baseUrl ?? environmentServices(environment)[0]?.baseUrl ?? "http://localhost:3000";
        let localTarget = false;
        try { localTarget = ["localhost", "127.0.0.1", "::1"].includes(new URL(baseUrl).hostname); } catch {}
        const stateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(String(savedRequest.method).toUpperCase());
        if (stateChanging && !localTarget && payload.allowStateChange !== true) return json(response, 409, { error: "Running a generated state-changing test outside loopback requires explicit approval.", code: "STATE_CHANGE_APPROVAL_REQUIRED" });
        const root = owner.sourceContext?.roots?.find((entry) => entry.kind === "workspace")?.path ?? owner.sourceContext?.roots?.[0]?.path;
        if (!root) return json(response, 409, { error: "Connect a local workspace before generating tests." });
        const python = (owner.sourceContext?.frameworks ?? []).some((entry) => /fastapi|flask|django|python/i.test(entry));
        const framework = payload.framework ?? (python ? "pytest" : "node");
        const stem = `${String(savedRequest.method).toLowerCase()}-${normalizeRoute(savedRequest.url).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root"}`.slice(0, 72);
        const relativeTarget = payload.target ?? path.join("tests", "aipi-generated", framework === "pytest" ? `test_${stem.replaceAll("-", "_")}.py` : `${stem}.contract.test.mjs`);
        let target;
        try { target = await writeRegressionTest({ root, target: relativeTarget, request: savedRequest, environment: { baseUrl }, framework }); }
        catch (error) { if (error.code !== "EEXIST") throw error; target = path.resolve(root, relativeTarget); }
        const command = framework === "pytest" ? { command: "python3", args: ["-m", "pytest", relativeTarget, "-q"] } : { command: "node", args: ["--test", relativeTarget] };
        const execution = await executeLinkedTestCommand(owner, command);
        await mutateState(async (state) => {
          const project = state.projects.find((entry) => entry.id === projectId);
          const currentFinding = [...(project.findings ?? []), ...(project.sourceContext?.findings ?? [])].find((entry) => entry.id === findingId);
          if (currentFinding) { currentFinding.generatedTest = { framework, path: relativeTarget, passed: execution.passed, generatedAt: new Date().toISOString() }; if (execution.passed) currentFinding.status = "resolved"; }
          project.sourceContext.artifacts ??= [];
          const artifactId = `test_${crypto.createHash("sha256").update(target).digest("hex").slice(0, 24)}`;
          if (!project.sourceContext.artifacts.some((entry) => entry.id === artifactId)) project.sourceContext.artifacts.push({ id: artifactId, kind: "test", name: path.basename(target), source: path.relative(root, target), root, line: 1, generatedBy: "aipi", contractId: contract.id });
          appendTimelineEvent(state, { projectId, type: "change", severity: execution.passed ? "success" : "warning", actor: "developer", title: execution.passed ? "Generated regression test passed" : "Generated regression test needs attention", summary: `${framework} coverage for ${savedRequest.method} ${savedRequest.url} ${execution.passed ? "passed" : `exited ${execution.exitCode}`}.`, tags: [framework, "generated-test"], source: { kind: "generated-test", files: [relativeTarget], requestId: savedRequest.id }, evidence: { target: relativeTarget, passed: execution.passed, exitCode: execution.exitCode } });
          await syncProjectTeamMemory(project);
        });
        return json(response, execution.passed ? 201 : 422, { ok: execution.passed, framework, target: relativeTarget, execution, state: publicState(await loadState()) });
      }
      if (request.method === "GET" && url.pathname === "/api/scan-status") {
        return json(response, 200, sourceScanStatus(url.searchParams.get("projectId")));
      }
      if (request.method === "GET" && url.pathname === "/api/timeline") {
        const state = await loadState();
        const projectId = url.searchParams.get("projectId") || state.activeProjectId;
        const types = url.searchParams.getAll("type");
        const events = timelineForProject(state, projectId, { types, before: url.searchParams.get("before"), limit: url.searchParams.get("limit") || 100 });
        return json(response, 200, { events, nextBefore: events.at(-1)?.createdAt ?? null });
      }
      if (request.method === "PUT" && url.pathname === "/api/state") {
        const incoming = await bodyJson(request);
        let recordedEvent = null;
        let conflictState = null;
        await mutateState(async (state) => {
          if (Number(incoming.revision) !== Number(state.revision)) {
            conflictState = publicState(state);
            return;
          }
          if (Array.isArray(incoming.projects)) {
            for (const candidate of incoming.projects) {
              const existing = state.projects.find((entry) => entry.id === candidate.id);
              if (!existing || candidate.name === existing.name) continue;
              const displayName = String(candidate.name ?? "").trim();
              if (!displayName) throw Object.assign(new Error("Project name is required"), { statusCode: 400, code: "INVALID_ARGUMENT" });
              if (displayName.length > 64) throw Object.assign(new Error("Project names must be 64 characters or fewer"), { statusCode: 400, code: "INVALID_ARGUMENT" });
              const normalizedName = displayName.normalize("NFKC").toLocaleLowerCase("en-US");
              if (state.projects.some((entry) => entry.id !== candidate.id && entry.name.normalize("NFKC").toLocaleLowerCase("en-US") === normalizedName)) {
                throw Object.assign(new Error(`A workspace named "${displayName}" already exists. Choose a unique name or open the existing project.`), { statusCode: 409, code: "PROJECT_NAME_EXISTS" });
              }
            }
          }
          const previous = structuredClone(state);
          const merged = preserveRedactedStateSecrets(incoming, state);
          const timeline = state.timeline ?? [];
          state.version = Math.max(Number(incoming.version) || 1, 2);
          state.activeProjectId = merged.activeProjectId;
          state.projects = preserveProjectEvidence(merged.projects ?? state.projects, state.projects);
          state.timeline = timeline;
          for (const project of state.projects.filter((entry) => entry.sourceContext?.roots?.length)) {
            try { project.teamMemory = { ...(await syncProjectTeamMemory(project)), syncedAt: new Date().toISOString() }; }
            catch (error) { project.teamMemory = { written: false, error: error.message, syncedAt: new Date().toISOString() }; }
          }
          const event = workspaceChangeEvent(previous, state);
          if (event) recordedEvent = appendTimelineEvent(state, event);
        });
        if (conflictState) return json(response, 409, { error: "Workspace changed after this dashboard loaded", state: conflictState });
        return json(response, 200, { ok: true, event: recordedEvent, state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const payload = await bodyJson(request);
        const workspacePath = String(payload.workspacePath ?? "").trim();
        const creation = await createProjectRecord({ ...payload, roots: workspacePath ? [{ kind: "workspace", path: workspacePath }] : [] });
        let scanError;
        if (creation.created && creation.roots.length) {
          try { await scanProjectSource(creation.project.id, creation.roots); }
          catch (error) { scanError = error.message; }
        }
        const current = await loadState();
        return json(response, creation.created ? 201 : 200, { ...publicState(current).projects.find((entry) => entry.id === creation.project.id), ...(scanError ? { scanError } : {}) });
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (request.method === "DELETE" && projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        await mutateState((state) => {
          const projectIndex = state.projects.findIndex((entry) => entry.id === projectId);
          if (projectIndex < 0) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
          state.projects.splice(projectIndex, 1);
          state.history = (state.history ?? []).filter((entry) => entry.projectId !== projectId);
          state.activity = (state.activity ?? []).filter((entry) => entry.projectId !== projectId);
          state.handoffs = (state.handoffs ?? []).filter((entry) => entry.projectId !== projectId);
          state.timeline = (state.timeline ?? []).filter((entry) => entry.projectId !== projectId);
          if (state.activeProjectId === projectId) state.activeProjectId = state.projects[0]?.id;
        });
        sourceScanOperations.delete(projectId);
        return json(response, 200, { ok: true, deletedProjectId: projectId, state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/import") {
        const project = await importDocument(await bodyJson(request));
        await mutateState((state) => {
          const name = String(project.name ?? "").trim();
          if (!name) throw Object.assign(new Error("Project name is required"), { statusCode: 400, code: "INVALID_ARGUMENT" });
          if (name.length > 64) throw Object.assign(new Error("Project names must be 64 characters or fewer"), { statusCode: 400, code: "INVALID_ARGUMENT" });
          project.name = name;
          const normalizedName = name.normalize("NFKC").toLocaleLowerCase("en-US");
          if (state.projects.some((entry) => entry.name.normalize("NFKC").toLocaleLowerCase("en-US") === normalizedName)) {
            throw Object.assign(new Error(`A workspace named "${name}" already exists. Choose a unique name or open the existing project.`), { statusCode: 409, code: "PROJECT_NAME_EXISTS" });
          }
          state.projects.push(project);
          appendTimelineEvent(state, { projectId: project.id, type: "project", severity: "success", actor: "developer", title: "API definition imported", summary: `${project.requests.length} reusable API request${project.requests.length === 1 ? "" : "s"} imported into ${project.name}.`, tags: ["OpenAPI"], source: { kind: "import" }, evidence: { requestCount: project.requests.length } });
        }); return json(response, 201, project);
      }
      if (request.method === "POST" && url.pathname === "/api/scan") {
        const payload = await bodyJson(request);
        return json(response, 200, await scanProjectSource(payload.projectId, payload.roots));
      }
      if (request.method === "GET" && url.pathname === "/api/git/status") {
        const state = await loadState();
        const { project, root } = projectAndAuthorizedRoot(state, url.searchParams.get("projectId"), url.searchParams.get("root"));
        return json(response, 200, await inspectGitBinding(root, projectGitBinding(project, root) ?? {}));
      }
      if (request.method === "POST" && url.pathname === "/api/git/binding") {
        const payload = await bodyJson(request);
        const state = await loadState();
        const { project, root } = projectAndAuthorizedRoot(state, payload.projectId, payload.root);
        const configured = await configureGitBinding(root, payload);
        await mutateState((next) => {
          const target = next.projects.find((entry) => entry.id === project.id);
          saveProjectGitBinding(target, { sourceRoot: root, repositoryRoot: configured.root, remoteName: configured.remoteName, repositoryUrl: configured.repositoryUrl, targetBranch: configured.targetBranch, updatedAt: configured.updatedAt, status: configured.status });
          target.repositoryUrls = [...new Set([configured.repositoryUrl, ...(target.repositoryUrls ?? [])].filter(Boolean))];
          target.updatedAt = configured.updatedAt;
          appendTimelineEvent(next, { projectId: target.id, type: "project", severity: "success", actor: "developer", title: "Git publish target configured", summary: `${configured.remoteName}/${configured.targetBranch} is mapped to ${configured.repositoryUrl}.`, tags: ["Git", "GitHub"], source: { kind: "git-binding", root }, evidence: { repositoryRoot: configured.root, remoteName: configured.remoteName, targetBranch: configured.targetBranch, repositoryUrl: configured.repositoryUrl } });
        });
        return json(response, 200, { binding: configured, state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/git/publish-plan") {
        const payload = await bodyJson(request);
        const state = await loadState();
        const { project, root } = projectAndAuthorizedRoot(state, payload.projectId, payload.root);
        const binding = projectGitBinding(project, root);
        if (!binding) throw Object.assign(new Error("Configure a Git publish target for this source first"), { statusCode: 409, code: "BINDING_REQUIRED" });
        const plan = await planGitPublish(root, binding);
        const { fingerprint, review } = await buildPublishImpactReview({ state, projectId: project.id, root, plan });
        return json(response, 200, { ...plan, impactReview: review,
          reviewToken: plan.canPublish ? issuePublishReviewToken(fingerprint, sessionToken) : null });
      }
      if (request.method === "POST" && url.pathname === "/api/git/publish") {
        const payload = await bodyJson(request);
        if (payload.confirm !== "PUBLISH") throw Object.assign(new Error("Explicit publish confirmation is required"), { statusCode: 400, code: "CONFIRMATION_REQUIRED" });
        if (payload.acknowledgeImpact !== true) throw Object.assign(new Error("Review and acknowledge the current cross-repository impact before publishing."), { statusCode: 400, code: "IMPACT_ACKNOWLEDGMENT_REQUIRED" });
        const state = await loadState();
        const { project, root } = projectAndAuthorizedRoot(state, payload.projectId, payload.root);
        const binding = projectGitBinding(project, root);
        if (!binding) throw Object.assign(new Error("Configure a Git publish target for this source first"), { statusCode: 409, code: "BINDING_REQUIRED" });
        const currentPlan = await planGitPublish(root, binding);
        const { fingerprint, review, rawAssessments } = await buildPublishImpactReview({ state, projectId: project.id, root, plan: currentPlan });
        if (!acceptPublishReviewToken(payload.reviewToken, fingerprint, sessionToken)) {
          throw Object.assign(new Error("The publish impact review expired or changed. Review the current blast radius before publishing."), { statusCode: 409, code: "IMPACT_REVIEW_CHANGED" });
        }
        const result = await publishGitHead(root, binding, payload.expectedCommit);
        let followUpTasks = null;
        await mutateState((next) => {
          const target = next.projects.find((entry) => entry.id === project.id);
          saveProjectGitBinding(target, { ...projectGitBinding(target, root), lastPublishedAt: result.publishedAt, lastPublishedCommit: result.commit, status: "published" });
          target.updatedAt = result.publishedAt;
          appendTimelineEvent(next, { projectId: target.id, type: "project", severity: "success", actor: "developer", title: "Committed changes published", summary: `${result.currentBranch} at ${result.commit.slice(0, 8)} was pushed to ${result.remoteName}/${result.targetBranch}.`, tags: ["Git", "publish"], source: { kind: "git-publish", root: result.root }, evidence: { commit: result.commit, remoteName: result.remoteName, targetBranch: result.targetBranch, outgoingCount: result.outgoingCount, impactReviewStatus: review.status, impactReviewFingerprint: fingerprint } });
          if (payload.createFollowUpTasks === true) {
            const results = rawAssessments.map(assessment => {
              try { return proposeTasksFromAssessment(next, assessment.workspaceId, assessment); }
              catch { return { proposedCount: 0, replayedCount: 0,
                unresolvedConsumers: [{ projectId: null, status: 'proposal_unavailable', reason: 'Downstream task proposal could not be saved for this workspace.' }] }; }
            });
            followUpTasks = { proposedCount: results.reduce((sum, entry) => sum + entry.proposedCount, 0),
              replayedCount: results.reduce((sum, entry) => sum + entry.replayedCount, 0),
              unresolvedConsumers: results.flatMap(entry => entry.unresolvedConsumers ?? []) };
          }
        });
        return json(response, 200, { result, followUpTasks, state: publicState(await loadState()) });
      }
      if (request.method === "POST" && url.pathname === "/api/send") {
        const payload = await bodyJson(request); const state = await loadState();
        const project = state.projects.find((item) => item.id === payload.projectId);
        if (!project) return json(response, 404, { error: "Project not found" });
        const savedRequest = payload.request ?? project.requests.find((item) => item.id === payload.requestId);
        if (!savedRequest) return json(response, 404, { error: "Request not found" });
        const result = await executeSaved(executeRequest, project, savedRequest, { maxAttempts: payload.maxAttempts });
        const log = await addHistory({ projectId: project.id, requestId: savedRequest.id, requestName: savedRequest.name, method: savedRequest.method, url: savedRequest.url, result });
        if (result.ok) {
          await mutateState(async (next) => {
            const owner = next.projects.find((item) => item.id === project.id);
            if (!owner) return;
            const requestPath = (() => { try { return new URL(savedRequest.url, "http://aipi.local").pathname; } catch { return String(savedRequest.url ?? "").split("?")[0]; } })();
            const contract = owner.contracts?.find((entry) => entry.id === savedRequest.contractId)
              ?? owner.contracts?.find((entry) => String(entry.method).toUpperCase() === String(savedRequest.method).toUpperCase() && normalizeRoute(entry.route) === normalizeRoute(requestPath));
            if (!contract) return;
            const teamMemory = await hydrateProjectTeamMemory(owner);
            buildProjectKnowledgeGraph(owner, teamMemory);
            promoteRuntimeEdge(owner, {
              contractId: contract.id,
              handlerFile: contract.implementation?.source ?? owner.sourceContext?.endpoints?.find((endpoint) => endpoint.id === contract.sourceArtifactIds?.[0])?.source,
              gitRevision: owner.sourceContext?.gitRevision
            });
            await syncProjectTeamMemory(owner);
          });
        }
        return json(response, 200, { result, logId: log.id });
      }
      if (request.method === "POST" && url.pathname === "/api/diagnose") {
        const payload = await bodyJson(request); const state = await loadState();
        const log = state.history.find((item) => item.id === payload.logId);
        return log ? json(response, 200, diagnosisFor(log.result)) : json(response, 404, { error: "Log not found" });
      }
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, url: dashboardUrl, companion: "local", port: server.address()?.port ?? basePort() });
      if (request.method === "GET") {
        const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const target = path.resolve(UI_DIR, relative);
        if (!target.startsWith(`${UI_DIR}${path.sep}`) && target !== path.join(UI_DIR, "index.html")) return json(response, 403, { error: "Forbidden" });
        try {
          const content = await fs.readFile(target);
          if (path.extname(target) === ".html") response.setHeader("set-cookie", `aipi_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`);
          response.writeHead(200, { "content-type": mime[path.extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
          response.end(content); return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          if (!path.extname(url.pathname)) {
            const content = await fs.readFile(path.join(UI_DIR, "index.html"));
            response.setHeader("set-cookie", `aipi_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`);
            response.writeHead(200, { "content-type": mime[".html"], "cache-control": "no-store" });
            response.end(content); return;
          }
        }
      }
      json(response, 404, { error: "Not found" });
    } catch (error) { json(response, error.statusCode ?? 500, { error: error.message, ...(error.code ? { code: error.code } : {}) }); }
  });
  await listenOnAvailablePort(server);
  void restoreTeamSessions().catch((error) => { teamSyncLiveStatus = { result: { error: `Team sync restore: ${error.message}` } }; });
  await syncProjectWatchers();
  const freshnessTimer = setInterval(() => { runContextFreshnessPass().catch(() => {}); }, Math.max(5_000, Number(process.env.AIPI_FRESHNESS_INTERVAL_MS) || 15_000));
  freshnessTimer.unref?.();
  let reconcilingTeamTasks = false;
  const teamTaskTimer = setInterval(() => {
    if (!teamSyncStore || reconcilingTeamTasks) return;
    reconcilingTeamTasks = true;
    void loadState().then((state) => {
      const result = reconcileLocalTeamTasks(teamSyncStore, state);
      if (result.queued) return teamSessions.runAll(result.organizationIds);
    }).catch((error) => { teamSyncLiveStatus = { result: { error: `Local task sync: ${error.message}` } }; })
      .finally(() => { reconcilingTeamTasks = false; });
  }, 15_000);
  teamTaskTimer.unref?.();
  server.on("close", () => { clearInterval(freshnessTimer); clearInterval(teamTaskTimer); void (async () => { await teamSessions.close(); teamSyncStore?.close(); })(); closeRuntimeMeshGateway().catch(() => {}); for (const projectId of trafficRecorders.keys()) stopTrafficRecorder(projectId).catch(() => {}); for (const watcher of projectWatchers.values()) watcher.close(); projectWatchers.clear(); for (const pending of projectWatchDebounce.values()) clearTimeout(pending.timer); projectWatchDebounce.clear(); });
  return { server, url: dashboardUrl, token: sessionToken, port: server.address()?.port ?? basePort() };
}

export async function runContextFreshnessPass() {
  const snapshot = await loadState();
  const changes = [];
  for (const project of snapshot.projects ?? []) {
    for (const root of project.sourceContext?.roots ?? []) {
      const current = await captureGitEvidence(root.path);
      const previous = project.sourceContext?.git?.find((entry) => path.resolve(entry.requestedRoot ?? entry.root) === path.resolve(root.path));
      if (!current.available || (previous?.commit === current.commit && previous?.workingTreeFingerprint === current.workingTreeFingerprint)) continue;
      changes.push({ projectId: project.id, root: root.path, current: { ...current, requestedRoot: root.path } });
    }
  }
  if (!changes.length) return { changedProjects: 0, refreshedTasks: 0 };
  let refreshedTasks = 0;
  await mutateState(async (state) => {
    for (const group of Map.groupBy(changes, (entry) => entry.projectId).values()) {
      const project = state.projects.find((entry) => entry.id === group[0].projectId);
      if (!project) continue;
      project.sourceContext ??= {};
      project.sourceContext.git ??= [];
      for (const change of group) {
        const index = project.sourceContext.git.findIndex((entry) => path.resolve(entry.requestedRoot ?? entry.root) === path.resolve(change.root));
        if (index < 0) project.sourceContext.git.push(change.current); else project.sourceContext.git[index] = change.current;
      }
      project.sourceContext.gitRevision = project.sourceContext.git.find((entry) => entry.commit)?.commit ?? project.sourceContext.gitRevision;
      markStaleTaskContexts(project);
      for (const task of project.tasks ?? []) {
        if (task.contextStatus !== "stale") continue;
        await refreshAndPrepareTaskContext(project, task);
        refreshedTasks += 1;
      }
      project.updatedAt = new Date().toISOString();
      appendTimelineEvent(state, { projectId: project.id, type: "scan", severity: "warning", actor: "aipi", title: "Context freshness refreshed", summary: `${group.length} repository revision snapshot${group.length === 1 ? "" : "s"} changed; bounded task context was refreshed.`, tags: ["Context", "Git", "Freshness"], source: { kind: "context-freshness-daemon" }, evidence: { roots: group.map((entry) => entry.root), refreshedTasks } });
      try { await syncProjectTeamMemory(project); } catch {}
    }
  });
  return { changedProjects: new Set(changes.map((entry) => entry.projectId)).size, refreshedTasks };
}

export { dashboardUrl, diagnosisFor, executeSaved, importOpenApi };
