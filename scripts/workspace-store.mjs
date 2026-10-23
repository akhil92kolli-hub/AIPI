import {normalizeWorkspaceIdentity} from "../packages/core/workspace-identity.mjs";
import { normalizeTasks } from "../packages/core/task-context.mjs";
import { materializeContractEvidence } from "../packages/core/contracts-evidence.mjs";
import { runPostIndexBootstrapper } from "../packages/core/post-index-bootstrapper.mjs";
import { hydrateProjectTeamMemory, syncProjectTeamMemory } from "../packages/core/team-memory.mjs";
import { projectGitRevision } from "../packages/core/verification-runner.mjs";
import { buildProjectKnowledgeGraph } from "../packages/core/knowledge-graph.mjs";
import { markStaleTaskContexts, refreshAndPrepareTaskContext } from "../packages/core/context-freshness.mjs";
import { sanitizeEvidencePayload } from "../packages/core/security-redactor.mjs";
import { normalizeWorkspaceGroups } from "../packages/core/workspace-groups.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { bindTaskWorkspace, crossRepositoryTask } from "../packages/core/task-workspace.mjs";
import { hydrateStateSecrets, protectStateSecrets, redactStateSecrets } from "../packages/core/secret-vault.mjs";
import { appendTimelineEvent, migrateTimeline } from "../packages/core/timeline.mjs";

const DATA_DIR = (process.env.AIPI_DATA || process.env.API_FORGE_DATA) && (process.env.AIPI_DATA || process.env.API_FORGE_DATA) !== "${PLUGIN_DATA}"
  ? (process.env.AIPI_DATA || process.env.API_FORGE_DATA)
  : path.join(os.homedir(), ".api-forge");
const DATA_FILE = path.join(DATA_DIR, "workspace.json");
const LOCK_FILE = path.join(DATA_DIR, "workspace.lock");
// Mutations can scan and rebuild project context while holding this lock. Keep
// other AIPI processes waiting long enough for those operations to finish;
// the lock is shared across IDE windows because they share workspace.json.
const WORKSPACE_LOCK_TIMEOUT_MS = 120_000;
const WORKSPACE_LOCK_STALE_MS = Math.max(1_000, Number(process.env.AIPI_WORKSPACE_LOCK_STALE_MS) || 60_000);
let mutationQueue = Promise.resolve();

export const newId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

export function defaultRequest(name = "New request") {
  return {
    id: newId("req"), name, method: "GET", url: "{{baseUrl}}/",
    params: [], headers: [],
    auth: { type: "none", token: "", username: "", password: "", key: "", value: "", placement: "header" },
    body: { type: "json", content: "{\n  \"hello\": \"world\"\n}" },
    certificates: { ca: "", clientCert: "", clientKey: "", rejectUnauthorized: true },
    scripts: { pre: "", post: "" },
    docs: "",
    assertions: [], retry: { enabled: false, attempts: 2, delayMs: 500, statuses: "408,425,429,500,502,503,504" }
  };
}

export function defaultProject(name = "My API") {
  const environmentId = newId("env");
  return {
    id: newId("prj"), name, description: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    activeEnvironmentId: environmentId,
    environments: [{ id: environmentId, name: "Development", variables: [{ key: "baseUrl", value: "http://localhost:3000", enabled: true, secret: false }] }],
    requests: [defaultRequest("Health check")],
    contracts: [],
    contractRevisions: [],
    evidence: [],
    findings: [],
    knowledgeGraph: { nodes: [], edges: [] },
    verificationReceipts: [],
    collections: [],
    contextPacks: [],
    retrievalTelemetry: [],
    gitBinding: null,
    sourceContext: {
      roots: [], scanStatus: "not-scanned", lastScannedAt: null, filesScanned: 0,
      frameworks: [], endpoints: [], frontendCalls: [], integrations: [], schemas: [], findings: [], git: []
    },
    summary: {
      goal: "Map, test, and verify this project's API integrations.",
      libraries: [], iterations: [], tasks: [
        { id: newId("task"), title: "Connect source context", status: "next" },
        { id: newId("task"), title: "Discover and test APIs", status: "planned" }
      ]
    }
  };
}

function normalizeProject(project, history = []) {
  const sourceContext = project.sourceContext ?? {};
  const summary = project.summary ?? {};
  const normalized = {
    ...project,
    environments: (project.environments ?? []).map((environment) => ({
      ...environment,
      name: /^statging$/i.test(environment.name ?? "") ? "Staging" : environment.name
    })),
    gitBinding: project.gitBinding ?? null,
    contracts: project.contracts ?? [],
    contractRevisions: project.contractRevisions ?? [],
    evidence: project.evidence ?? [],
    findings: project.findings ?? [],
    knowledgeGraph: {
      nodes: project.knowledgeGraph?.nodes ?? [],
      edges: project.knowledgeGraph?.edges ?? []
    },
    verificationReceipts: project.verificationReceipts ?? [],
    collections: project.collections ?? [],
    contextPacks: project.contextPacks ?? [],
    retrievalTelemetry: project.retrievalTelemetry ?? [],
    sourceContext: {
      roots: [], scanStatus: "not-scanned", lastScannedAt: null, filesScanned: 0,
      frameworks: [], endpoints: [], frontendCalls: [], integrations: [], schemas: [], findings: [], git: [],
      ...sourceContext
    },
    summary: {
      goal: project.description || "Map, test, and verify this project's API integrations.",
      libraries: [], iterations: [], tasks: [],
      ...summary
    }
  };
  normalized.sourceContext.roots = [...new Map((normalized.sourceContext.roots ?? []).map((root) => [`${root.kind}:${path.resolve(root.path ?? ".")}`, root])).values()];
  if (normalized.sourceContext.roots.length > 1) {
    const stableRoots = normalized.sourceContext.roots.filter((root) => !path.resolve(root.path ?? ".").startsWith(path.resolve(os.tmpdir())));
    if (stableRoots.length) normalized.sourceContext.roots = stableRoots;
  }
  const isTemporaryRoot = (value) => {
    const resolved = path.resolve(value ?? ".");
    return resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
      || /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/(?:tmp\.|aipi-)/.test(resolved)
      || /^\/tmp\/(?:tmp\.|aipi-)/.test(resolved);
  };
  normalized.ephemeralWorkspace = normalized.sourceContext.roots.length > 0 && normalized.sourceContext.roots.every((root) => isTemporaryRoot(root.path));
  normalizeTasks(normalized);
  const persistedBootstrapEvidence = normalized.evidence.filter((entry) => ["post-index-bootstrapper", "verification-runner", "otel-live"].includes(entry.origin));
  const persistedBootstrapFindings = normalized.findings.filter((entry) => ["post-index-bootstrapper", "otel-live"].includes(entry.origin) || entry.generatedBy === "post-index-bootstrapper");
  materializeContractEvidence(normalized, history);
  normalized.evidence.push(...persistedBootstrapEvidence.filter((entry) => !normalized.evidence.some((candidate) => candidate.id === entry.id)));
  for (const entry of persistedBootstrapFindings) {
    const current = normalized.findings.find((candidate) => candidate.id === entry.id);
    if (current) Object.assign(current, { ...entry, ...current, bootstrapFingerprint: entry.bootstrapFingerprint, generatedBy: "post-index-bootstrapper" });
    else normalized.findings.push(entry);
  }
  return normalized;
}

export async function hydrateAndBootstrapProject(project, history = []) {
  const before = JSON.stringify(project);
  const normalized = normalizeProject(project, history);
  const teamMemory = await hydrateProjectTeamMemory(normalized);
  const result = runPostIndexBootstrapper(normalized, { history });
  buildProjectKnowledgeGraph(normalized, teamMemory);
  markStaleTaskContexts(normalized);
  let refreshedContexts = 0;
  for (const task of normalized.tasks ?? []) {
    if (crossRepositoryTask(normalized, task)) continue; // Refresh with the complete workspace after hydration.
    if (task.contextStatus !== "stale") continue;
    try { await refreshAndPrepareTaskContext(normalized, task); refreshedContexts += 1; }
    catch { task.contextStatus = "stale"; }
  }

  const currentRevision = projectGitRevision(normalized);
  let staleContracts = 0;
  for (const contract of normalized.contracts ?? []) {
    if (contract.state !== "Verified" || !contract.latestVerificationReceiptId) continue;
    const receipt = normalized.verificationReceipts?.find((entry) => entry.id === contract.latestVerificationReceiptId);
    if (receipt && receipt.sourceRevision !== currentRevision) {
      contract.state = "Stale";
      staleContracts += 1;
    }
  }

  const changed = result.changed || staleContracts > 0 || refreshedContexts > 0 || JSON.stringify(normalized) !== before;
  if (result.changed || staleContracts > 0 || refreshedContexts > 0) {
    try {
      normalized.teamMemory = { ...(await syncProjectTeamMemory(normalized)), inheritedRequests: teamMemory.requests.length, inheritedReceipts: teamMemory.receipts.length, warnings: teamMemory.warnings, staleContracts, syncedAt: new Date().toISOString() };
    } catch (error) {
      normalized.teamMemory = { written: false, error: error.message, warnings: teamMemory.warnings, staleContracts, syncedAt: new Date().toISOString() };
    }
  }
  return { project: normalized, changed };
}

function initialState() {
  const project = defaultProject("Starter project");
  const state = { version: 2, revision: 0, activeProjectId: project.id, projects: [project], history: [], activity: [], handoffs: [], timeline: [] };
  appendTimelineEvent(state, { projectId: project.id, type: "project", actor: "aipi", title: "Project created", summary: `${project.name} is ready for source discovery and API testing.`, tags: ["local"] });
  return state;
}

export async function loadState(persistMigrations = true) {
  try {
    const persistedState = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    const state = await hydrateStateSecrets(persistedState);
    state.history ??= [];
    let migrated = false;
    const projects = [];
    for (const project of state.projects ?? []) {
      const hydrated = await hydrateAndBootstrapProject(project, state.history);
      migrated ||= hydrated.changed;
      projects.push(hydrated.project);
    }
    state.projects = projects;
    normalizeWorkspaceGroups(state);
    migrated = normalizeWorkspaceIdentity(state) || migrated;
    state.deviceCheckoutBindings ??= [];
    state.activeProjectId = state.projects.some((entry) => entry.id === state.activeProjectId) ? state.activeProjectId : state.projects[0]?.id;
    state.activity ??= [];
    state.handoffs ??= [];
    state.timeline = migrateTimeline(state);
    state.version = Math.max(Number(state.version) || 1, 2);
    state.revision = Math.max(Number(state.revision) || 0, 0);
    // Re-read under the writer lock before persisting a migration: a read-only
    // request may have hydrated a snapshot while another request changed it.
    if (migrated && persistMigrations) return mutateState(() => {});
    return bindTaskWorkspace(state);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = initialState();
    await saveState(state, persistMigrations);
    return bindTaskWorkspace(state);
  }
}

async function acquireWorkspaceLock() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + WORKSPACE_LOCK_TIMEOUT_MS;
  let lastOwner = "unknown";
  while (true) {
    try {
      const handle = await fs.open(LOCK_FILE, "wx", 0o600);
      const owner = `${process.pid}:${crypto.randomUUID()}`;
      await handle.writeFile(`${owner}\n`);
      let heartbeatQueue = Promise.resolve();
      const heartbeat = setInterval(() => {
        heartbeatQueue = heartbeatQueue.then(() => handle.utimes(new Date(), new Date())).catch((error) => {
          console.error(`AIPI workspace lock heartbeat failed: ${error.message}`);
        });
      }, Math.max(1000, Math.floor(WORKSPACE_LOCK_STALE_MS / 3)));
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        await heartbeatQueue;
        await handle.close();
        const currentOwner = await fs.readFile(LOCK_FILE, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
        if (currentOwner.trim() === owner) await fs.unlink(LOCK_FILE).catch((error) => { if (error.code !== "ENOENT") throw error; });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(LOCK_FILE).catch(() => null);
      const owner = await fs.readFile(LOCK_FILE, "utf8").catch((readError) => readError.code === "ENOENT" ? "" : Promise.reject(readError));
      lastOwner = owner.trim() || "unknown";
      if (stat && Date.now() - stat.mtimeMs > WORKSPACE_LOCK_STALE_MS) {
        const ownerPid = Number.parseInt(owner, 10);
        let ownerAlive = false;
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
          try {
            process.kill(ownerPid, 0);
            ownerAlive = true;
          } catch (probeError) {
            ownerAlive = probeError.code !== "ESRCH";
          }
        }
        const currentStat = await fs.stat(LOCK_FILE).catch(() => null);
        const currentOwner = await fs.readFile(LOCK_FILE, "utf8").catch((readError) => readError.code === "ENOENT" ? "" : Promise.reject(readError));
        if (!ownerAlive && currentStat?.ino === stat.ino && currentOwner === owner) {
          await fs.unlink(LOCK_FILE).catch((unlinkError) => { if (unlinkError.code !== "ENOENT") throw unlinkError; });
          continue;
        }
      }
      if (Date.now() >= deadline) throw new Error(`AIPI workspace state is still being updated by process ${lastOwner} after ${Math.round(WORKSPACE_LOCK_TIMEOUT_MS / 1000)} seconds. Wait for that operation to finish, then retry.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function writeState(state) {
  normalizeWorkspaceGroups(state);
  normalizeWorkspaceIdentity(state);
  const sanitizedState = {
    ...state,
    history: (state.history ?? []).map((entry) => sanitizeEvidencePayload(entry)),
    projects: (state.projects ?? []).map((project) => ({
      ...project,
      evidence: (project.evidence ?? []).map((entry) => sanitizeEvidencePayload(entry)),
      sourceContext: { ...project.sourceContext, runtimeTraces: (project.sourceContext?.runtimeTraces ?? []).map((entry) => sanitizeEvidencePayload(entry)) }
    }))
  };
  const protectedState = await protectStateSecrets(sanitizedState);
  const snapshot = `${JSON.stringify(protectedState, null, 2)}\n`;
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  // Preserve the original protected bytes once, before the additive overlay is published.
  // This runs inside the writer lock; a failed backup prevents the migration write.
  try {
    const previous = await fs.readFile(DATA_FILE, "utf8");
    if (!JSON.parse(previous).identitySchemaVersion) {
      try { await fs.writeFile(`${DATA_FILE}.before-source-identities.json`, previous, {flag:"wx",mode:0o600}); }
      catch(error) { if(error.code!=="EEXIST")throw error; }
    }
    if (!JSON.parse(previous).workspaceSchemaVersion) {
      try { await fs.writeFile(`${DATA_FILE}.before-workspace-groups.json`, previous, { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${DATA_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, snapshot, { mode: 0o600 });
  await fs.rename(temporary, DATA_FILE);
}

export async function saveState(state, acquireLock = true) {
  // The cross-process lock already serializes writes. A second in-process
  // queue deadlocks when its head waits for a lock held by a mutation whose
  // save is queued behind it.
  const release = acquireLock ? await acquireWorkspaceLock() : null;
  try { await writeState(state); }
  finally { await release?.(); }
}

export async function mutateState(mutator) {
  const operation = mutationQueue.catch(() => {}).then(async () => {
    const release = await acquireWorkspaceLock();
    try {
      const state = await loadState(false);
      const result = await mutator(state);
      state.revision = Math.max(Number(state.revision) || 0, 0) + 1;
      await saveState(state, false);
      return result ?? state;
    } finally { await release(); }
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function addHistory(entry) {
  return mutateState((state) => {
    const project = state.projects.find((candidate) => candidate.id === entry.projectId);
    const vaultValues = (project?.environments ?? []).flatMap((environment) => environment.variables ?? []).filter((variable) => variable.secret && typeof variable.value === "string").map((variable) => variable.value);
    state.history.unshift(sanitizeEvidencePayload({ id: newId("log"), createdAt: new Date().toISOString(), ...entry }, vaultValues));
    state.history = state.history.slice(0, 500);
    const log = state.history[0];
    const result = log.result ?? {};
    appendTimelineEvent(state, {
      id: `evt_${log.id}`, projectId: log.projectId, createdAt: log.createdAt, type: "run",
      severity: result.ok && result.passed !== false && !result.error ? "success" : "danger", actor: "aipi",
      title: `${log.requestName || "API request"} ${result.ok && result.passed !== false && !result.error ? "succeeded" : "failed"}`,
      summary: result.status ? `HTTP ${result.status} · ${log.method} ${log.url}` : (result.error || `${log.method} ${log.url}`),
      tags: [log.method, result.status ? `HTTP ${result.status}` : "network"].filter(Boolean),
      source: { kind: "run", ref: log.id, requestId: log.requestId },
      evidence: { status: result.status ?? null, elapsedMs: result.elapsed_ms ?? null, attempts: result.attempts ?? 1, assertionsPassed: (result.assertions ?? []).filter((assertion) => assertion.passed).length, assertionsTotal: (result.assertions ?? []).length, diagnosis: result.diagnosis?.category ?? null, contractStatus: result.contractDiff?.status ?? null }
    });
    return state.history[0];
  });
}

export function variablesFor(project, override = {}) {
  const environment = project?.environments?.find((item) => item.id === project.activeEnvironmentId) ?? project?.environments?.[0];
  const variables = Object.fromEntries((environment?.variables ?? []).filter((row) => row.enabled !== false && row.key).map((row) => [row.key, row.value]));
  const enabledServices = (environment?.services ?? []).filter((service) => service.enabled !== false && service.variableKey && service.baseUrl);
  const services = Object.fromEntries(enabledServices.map((service) => [service.variableKey, service.baseUrl]));
  const serviceVariables = Object.fromEntries(enabledServices.flatMap((service) => (service.variables ?? [])
    .filter((row) => row.enabled !== false && row.key)
    .map((row) => [`${service.variableKey}.${row.key}`, row.value])));
  return { ...variables, ...services, ...serviceVariables, ...override };
}

export function publicState(state) {
  const { projectCreations, ...visible } = state;
  return redactStateSecrets({ ...visible, timeline: (state.timeline ?? []).slice(0, 500) });
}

export { DATA_DIR, DATA_FILE };
