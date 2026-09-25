import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { hydrateStateSecrets, protectStateSecrets, redactStateSecrets } from "../packages/core/secret-vault.mjs";
import { appendTimelineEvent, migrateTimeline } from "../packages/core/timeline.mjs";

const DATA_DIR = (process.env.AIPI_DATA || process.env.API_FORGE_DATA) && (process.env.AIPI_DATA || process.env.API_FORGE_DATA) !== "${PLUGIN_DATA}"
  ? (process.env.AIPI_DATA || process.env.API_FORGE_DATA)
  : path.join(os.homedir(), ".api-forge");
const DATA_FILE = path.join(DATA_DIR, "workspace.json");
let saveQueue = Promise.resolve();
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

function normalizeProject(project) {
  const sourceContext = project.sourceContext ?? {};
  const summary = project.summary ?? {};
  return {
    ...project,
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
}

function initialState() {
  const project = defaultProject("Starter project");
  const state = { version: 2, revision: 0, activeProjectId: project.id, projects: [project], history: [], activity: [], handoffs: [], timeline: [] };
  appendTimelineEvent(state, { projectId: project.id, type: "project", actor: "aipi", title: "Project created", summary: `${project.name} is ready for source discovery and API testing.`, tags: ["local"] });
  return state;
}

export async function loadState() {
  try {
    const persistedState = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    const state = await hydrateStateSecrets(persistedState);
    state.projects = (state.projects ?? []).map(normalizeProject);
    state.activeProjectId = state.projects.some((entry) => entry.id === state.activeProjectId) ? state.activeProjectId : state.projects[0]?.id;
    state.history ??= [];
    state.activity ??= [];
    state.handoffs ??= [];
    state.timeline = migrateTimeline(state);
    state.version = Math.max(Number(state.version) || 1, 2);
    state.revision = Math.max(Number(state.revision) || 0, 0);
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = initialState();
    await saveState(state);
    return state;
  }
}

export async function saveState(state) {
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const protectedState = await protectStateSecrets(state);
    const snapshot = `${JSON.stringify(protectedState, null, 2)}\n`;
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${DATA_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, snapshot, { mode: 0o600 });
    await fs.rename(temporary, DATA_FILE);
  });
  return saveQueue;
}

export async function mutateState(mutator) {
  const operation = mutationQueue.catch(() => {}).then(async () => {
    const state = await loadState();
    const result = await mutator(state);
    state.revision = Math.max(Number(state.revision) || 0, 0) + 1;
    await saveState(state);
    return result ?? state;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function addHistory(entry) {
  return mutateState((state) => {
    state.history.unshift({ id: newId("log"), createdAt: new Date().toISOString(), ...entry });
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
  return { ...variables, ...override };
}

export function publicState(state) {
  return redactStateSecrets({ ...state, timeline: (state.timeline ?? []).slice(0, 500) });
}

export { DATA_DIR, DATA_FILE };
