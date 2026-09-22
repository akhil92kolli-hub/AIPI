import fs from "node:fs/promises";
import path from "node:path";
import { isSecretName } from "../core/index.mjs";

export const REPOSITORY_VERSION = 1;

function slug(value) {
  return String(value ?? "request").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "request";
}

export function repositoryRequest(request) {
  return {
    version: REPOSITORY_VERSION,
    id: request.id,
    name: request.name,
    request: {
      method: request.method,
      url: request.url,
      params: request.params ?? [],
      headers: (request.headers ?? []).map((entry) => isSecretName(entry.key) ? { ...entry, value: "" } : entry),
      auth: request.auth?.type && request.auth.type !== "none" ? { type: request.auth.type, placement: request.auth.placement, key: request.auth.key } : { type: "none" },
      body: request.body ?? { type: "json", content: "" }
    },
    assertions: request.assertions ?? [],
    retry: request.retry ?? { enabled: false },
    documentation: request.docs ?? ""
  };
}

export function validateRepositoryRequest(definition) {
  const errors = [];
  if (definition?.version !== REPOSITORY_VERSION) errors.push(`version must be ${REPOSITORY_VERSION}`);
  if (!definition?.name) errors.push("name is required");
  if (!definition?.request?.method) errors.push("request.method is required");
  if (!definition?.request?.url) errors.push("request.url is required");
  return { valid: errors.length === 0, errors };
}

export async function writeRepositoryProject(root, project) {
  const directory = path.join(path.resolve(root), ".api-forge");
  const requestsDirectory = path.join(directory, "requests");
  const environmentsDirectory = path.join(directory, "environments");
  await fs.mkdir(requestsDirectory, { recursive: true });
  await fs.mkdir(environmentsDirectory, { recursive: true });
  const projectDocument = {
    version: REPOSITORY_VERSION,
    id: project.id,
    name: project.name,
    description: project.description ?? "",
    goal: project.summary?.goal ?? "",
    sourceRoots: (project.sourceContext?.roots ?? []).map((entry) => ({ kind: entry.kind, path: path.relative(root, entry.path) || "." })),
    activeEnvironmentId: project.activeEnvironmentId
  };
  await fs.writeFile(path.join(directory, "project.json"), `${JSON.stringify(projectDocument, null, 2)}\n`, { mode: 0o600 });
  for (const environment of project.environments ?? []) {
    const document = { version: REPOSITORY_VERSION, id: environment.id, name: environment.name, variables: (environment.variables ?? []).map((entry) => ({ key: entry.key, enabled: entry.enabled !== false, secret: Boolean(entry.secret || isSecretName(entry.key)), ...((entry.secret || isSecretName(entry.key)) ? {} : { value: entry.value }) })) };
    await fs.writeFile(path.join(environmentsDirectory, `${slug(environment.name)}.json`), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  }
  const files = [];
  for (const request of project.requests ?? []) {
    const target = path.join(requestsDirectory, `${slug(request.name)}.api.json`);
    await fs.writeFile(target, `${JSON.stringify(repositoryRequest(request), null, 2)}\n`, { mode: 0o600 });
    files.push(target);
  }
  return { directory, files };
}

export async function readRepositoryProject(root) {
  const directory = path.join(path.resolve(root), ".api-forge");
  const project = JSON.parse(await fs.readFile(path.join(directory, "project.json"), "utf8"));
  const requestFiles = (await fs.readdir(path.join(directory, "requests"))).filter((entry) => entry.endsWith(".api.json"));
  const requests = [];
  for (const file of requestFiles) {
    const definition = JSON.parse(await fs.readFile(path.join(directory, "requests", file), "utf8"));
    const validation = validateRepositoryRequest(definition);
    if (!validation.valid) throw new Error(`${file}: ${validation.errors.join(", ")}`);
    requests.push(definition);
  }
  return { project, requests };
}
