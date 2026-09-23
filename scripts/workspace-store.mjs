import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = (process.env.AIPI_DATA || process.env.API_FORGE_DATA) && (process.env.AIPI_DATA || process.env.API_FORGE_DATA) !== "${PLUGIN_DATA}"
  ? (process.env.AIPI_DATA || process.env.API_FORGE_DATA)
  : path.join(os.homedir(), ".api-forge");
const DATA_FILE = path.join(DATA_DIR, "workspace.json");
let saveQueue = Promise.resolve();

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
      frameworks: [], endpoints: [], frontendCalls: [], integrations: [], schemas: [], findings: []
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
      frameworks: [], endpoints: [], frontendCalls: [], integrations: [], schemas: [], findings: [],
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
  return { version: 1, activeProjectId: project.id, projects: [project], history: [] };
}

export async function loadState() {
  try {
    const state = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    state.projects = (state.projects ?? []).map(normalizeProject);
    state.activeProjectId = state.projects.some((entry) => entry.id === state.activeProjectId) ? state.activeProjectId : state.projects[0]?.id;
    state.history ??= [];
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = initialState();
    await saveState(state);
    return state;
  }
}

export async function saveState(state) {
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${DATA_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, snapshot, { mode: 0o600 });
    await fs.rename(temporary, DATA_FILE);
  });
  return saveQueue;
}

export async function mutateState(mutator) {
  const state = await loadState();
  const result = await mutator(state);
  await saveState(state);
  return result ?? state;
}

export async function addHistory(entry) {
  return mutateState((state) => {
    state.history.unshift({ id: newId("log"), createdAt: new Date().toISOString(), ...entry });
    state.history = state.history.slice(0, 500);
    return state.history[0];
  });
}

export function variablesFor(project, override = {}) {
  const environment = project?.environments?.find((item) => item.id === project.activeEnvironmentId) ?? project?.environments?.[0];
  const variables = Object.fromEntries((environment?.variables ?? []).filter((row) => row.enabled !== false && row.key).map((row) => [row.key, row.value]));
  return { ...variables, ...override };
}

export function publicState(state) {
  return state;
}

export { DATA_DIR, DATA_FILE };
