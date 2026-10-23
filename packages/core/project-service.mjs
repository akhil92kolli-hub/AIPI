import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultProject, mutateState } from "../../scripts/workspace-store.mjs";
import { appendTimelineEvent } from "./timeline.mjs";

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409, code: "CONFLICT" });
}

// Both transports use this operation. The idempotency record commits with the
// project, before optional indexing, so scan failure cannot duplicate creation.
export async function createProjectRecord(input, actor = "developer") {
  const key = input.idempotencyKey;
  if (key !== undefined && (typeof key !== "string" || !/^[\w-]{8,128}$/.test(key))) {
    throw Object.assign(new Error("Invalid idempotency key"), { statusCode: 400, code: "INVALID_ARGUMENT" });
  }
  const payload = {
    name: String(input.name ?? "New project").trim(), goal: String(input.goal ?? ""),
    description: String(input.description ?? "").trim(),
    technologyStack: [...new Set((Array.isArray(input.technologyStack) ? input.technologyStack : []).map((tag) => String(tag).trim()).filter(Boolean))],
    environmentName: String(input.environmentName || "Development"), baseUrl: String(input.baseUrl || "http://localhost:3000"),
    roots: (input.roots ?? []).map((root) => ({ kind: root.kind ?? "workspace", path: path.resolve(root.path) }))
  };
  if (!payload.name) throw Object.assign(new Error("Project name is required"), { statusCode: 400 });
  if (payload.name.length > 64) throw Object.assign(new Error("Project names must be 64 characters or fewer"), { statusCode: 400, code: "INVALID_ARGUMENT" });
  if (payload.goal.length > 2000 || payload.description.length > 4000 || payload.technologyStack.length > 20 || payload.technologyStack.some((tag) => tag.length > 64)) {
    throw Object.assign(new Error("Project purpose, description, or technology stack exceeds the allowed length"), { statusCode: 400, code: "INVALID_ARGUMENT" });
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return mutateState(async (state) => {
    state.projectCreations ??= {};
    const previous = key ? state.projectCreations[`create:${key}`] : null;
    if (previous) {
      if (previous.digest !== digest) throw conflict("Idempotency key was already used with different project details");
      const project = state.projects.find((entry) => entry.id === previous.projectId);
      if (!project) throw conflict("Previously created project was deleted; use a new creation key");
      return { project, created: false, roots: payload.roots };
    }
    const normalizedName = payload.name.normalize("NFKC").toLocaleLowerCase("en-US");
    if (state.projects.some((entry) => entry.name.normalize("NFKC").toLocaleLowerCase("en-US") === normalizedName)) {
      throw Object.assign(new Error(`A workspace named "${payload.name}" already exists. Choose a unique name or open the existing project.`), { statusCode: 409, code: "PROJECT_NAME_EXISTS" });
    }
    for (const root of payload.roots) {
      if (!(await fs.stat(root.path)).isDirectory()) throw Object.assign(new Error("Workspace path must be a directory"), { statusCode: 400 });
    }
    const project = defaultProject(payload.name);
    project.description = payload.description || payload.goal;
    project.summary.goal = payload.goal || project.summary.goal;
    project.summary.libraries = payload.technologyStack;
    project.environments[0].name = payload.environmentName;
    project.environments[0].variables[0].value = payload.baseUrl;
    state.projects.push(project);
    state.activeProjectId = project.id;
    if (key) state.projectCreations[`create:${key}`] = { digest, projectId: project.id, createdAt: project.createdAt };
    appendTimelineEvent(state, { projectId: project.id, type: "project", severity: "success", actor, title: "Project created", summary: `${project.name} was created.`, tags: [], source: { kind: "project-service" }, evidence: { sourceRoots: payload.roots.length } });
    return { project, created: true, roots: payload.roots };
  });
}

// Evidence belongs to execution services, never a general UI state replacement.
export function preserveProjectEvidence(incoming, existing) {
  if (!Array.isArray(incoming)) throw Object.assign(new Error("projects must be an array"), { statusCode: 400 });
  const ids = new Set();
  for (const project of incoming) {
    if (!project?.id || ids.has(project.id)) throw conflict("Project IDs must be present and unique");
    ids.add(project.id);
  }
  for (const project of existing) {
    if ((project.verificationRuns ?? []).length && !ids.has(project.id)) throw conflict("Projects with verification evidence cannot be removed through general state updates");
  }
  return incoming.map((project) => {
    const stored = existing.find((entry) => entry.id === project.id);
    const verificationRuns = stored?.verificationRuns ?? [];
    const tasks = (project.tasks ?? []).map((task) => ({ ...task, projectId: project.id, verificationRunIds: verificationRuns.filter((run) => run.taskId === task.id).map((run) => run.id) }));
    for (const task of stored?.tasks ?? []) {
      if (verificationRuns.some((run) => run.taskId === task.id) && !tasks.some((entry) => entry.id === task.id)) throw conflict("Tasks with verification evidence cannot be removed through general state updates");
    }
    return { ...project, tasks, verificationRuns, agentFindings: stored?.agentFindings ?? [] };
  });
}
