import crypto from "node:crypto";
import { teamProjectPreview, teamTaskExternalId } from "./team-onboarding.mjs";

function fingerprint(task) {
  return crypto.createHash("sha256").update(JSON.stringify([task.title, task.status])).digest("hex");
}

function stableUuid(value) {
  const hex = crypto.createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function rememberLinkedTasks(store, preview) {
  for (const task of preview.tasks) {
    store.saveLocalTaskFingerprint(preview.projectKey, task.id, fingerprint(task));
    store.saveLocalTaskBaseline(preview.projectKey, task.id, task);
  }
}

// Only changed metadata fields leave the device. An absent baseline on an old
// installation is reconstructed only when the cloud row matches its fingerprint.
export function reconcileLocalTeamTasks(store, state) {
  const result = { queued: 0, waiting: 0, conflicts: 0, organizationIds: [] };
  const queuedOrganizations = new Set();
  for (const project of state.projects ?? []) {
    const link = store.projectLink(project.id);
    if (!link?.device_id || !link?.actor_id) continue;
    const preview = teamProjectPreview(state, project.id);
    const remote = store.db.prepare("select payload_json from sync_entities where organization_id = ? and entity_type = 'task' and deleted = 0")
      .all(link.organization_id).map((row) => JSON.parse(row.payload_json));
    const outbox = store.db.prepare("select status, base_version, payload_json from sync_outbox where organization_id = ? and workspace_id = ? and entity_type = 'task'")
      .all(link.organization_id, link.workspace_id).map((row) => ({ status: row.status, baseVersion: row.base_version, payload: JSON.parse(row.payload_json) }));
    for (const task of preview.tasks) {
      const currentFingerprint = fingerprint(task);
      const externalId = teamTaskExternalId(link.organization_id, link.workspace_id, project.id, task.id);
      const previous = outbox.filter((entry) => entry.payload.externalId === externalId);
      if (previous.some((entry) => entry.status === "conflict")) { result.conflicts++; continue; }
      if (previous.some((entry) => entry.status === "pending")) { result.waiting++; continue; }
      if (currentFingerprint === store.localTaskFingerprint(project.id, task.id)) continue;
      const cloud = remote.find((entry) => entry.externalId === externalId && entry.workspaceId === link.workspace_id);
      if (!cloud && previous.some((entry) => entry.status === "accepted")) { result.waiting++; continue; }
      const baseVersion = Number(cloud?.version ?? 0);
      if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) { result.conflicts++; continue; }
      if (previous.some((entry) => entry.status === "accepted" && entry.baseVersion >= baseVersion)) { result.waiting++; continue; }
      let baseline = store.localTaskBaseline(project.id, task.id);
      if (!baseline && cloud && fingerprint(cloud) === store.localTaskFingerprint(project.id, task.id)) baseline = { title: cloud.title, status: cloud.status };
      if (!baseline && cloud) { result.conflicts++; continue; }
      const patch = cloud ? Object.fromEntries(["title", "status"].filter((field) => task[field] !== baseline[field]).map((field) => [field, task[field]]))
        : { title: task.title, status: task.status };
      if (!Object.keys(patch).length) {
        store.saveLocalTaskFingerprint(project.id, task.id, currentFingerprint);
        store.saveLocalTaskBaseline(project.id, task.id, task);
        continue;
      }
      if (cloud && Object.keys(patch).some((field) => cloud[field] !== baseline[field] && cloud[field] !== patch[field])) { result.conflicts++; continue; }
      store.enqueue({ schemaVersion: 1,
        operationId: stableUuid(`local:${link.organization_id}:${link.workspace_id}:${project.id}:${task.id}:${baseVersion}:${currentFingerprint}`),
        organizationId: link.organization_id, workspaceId: link.workspace_id,
        deviceId: link.device_id, actorId: link.actor_id, entityType: "task", action: "patch", baseVersion,
        payload: { externalId, projectKey: project.id, patch } });
      store.saveLocalTaskFingerprint(project.id, task.id, currentFingerprint);
      store.saveLocalTaskBaseline(project.id, task.id, task);
      result.queued++;
      queuedOrganizations.add(link.organization_id);
    }
  }
  result.organizationIds = [...queuedOrganizations];
  return result;
}
