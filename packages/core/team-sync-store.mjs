import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { exportWorkspaceManifest } from "./workspace-manifest.mjs";
import { validateSourceFactPartition } from "./source-fact-partition.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requireUuid = (value, label) => { if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} must be a UUID`); return value; };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeJson = (value) => JSON.stringify(value);

export const SYNC_ENTITY_TYPES = Object.freeze([
  "task",
  "decision",
  "evidence",
  "comment",
  "receipt",
  "workspace",
  "milestone",
  "contract",
  "graph_node",
  "graph_edge",
  "handoff",
]);

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export class TeamSyncStore {
  constructor(db, file) { this.db = db; this.file = file; }
  close() { this.db.close(); }

  migrationStatus() {
    return this.db.prepare("select value from sync_meta where key = 'legacy_imported'").get()?.value ?? null;
  }

  projectLink(projectKey) {
    return this.db.prepare("select project_key, organization_id, workspace_id, device_id, actor_id, connected_at from team_project_links where project_key = ?").get(projectKey) ?? null;
  }

  saveProjectLink(projectKey, organizationId, workspaceId, deviceId = null, actorId = null) {
    requireUuid(organizationId, "organizationId"); requireUuid(workspaceId, "workspaceId");
    if (deviceId !== null) requireUuid(deviceId, "deviceId");
    if (actorId !== null) requireUuid(actorId, "actorId");
    this.db.prepare("insert into team_project_links (project_key, organization_id, workspace_id, device_id, actor_id, connected_at) values (?, ?, ?, ?, ?, ?) on conflict(project_key) do update set organization_id = excluded.organization_id, workspace_id = excluded.workspace_id, device_id = excluded.device_id, actor_id = excluded.actor_id, connected_at = excluded.connected_at")
      .run(projectKey, organizationId, workspaceId, deviceId, actorId, new Date().toISOString());
    return this.projectLink(projectKey);
  }

  localTaskFingerprint(projectKey, taskId) {
    return this.db.prepare("select fingerprint from team_local_task_fingerprints where project_key = ? and task_id = ?").get(projectKey, taskId)?.fingerprint ?? null;
  }

  saveLocalTaskFingerprint(projectKey, taskId, fingerprint) {
    this.db.prepare("insert into team_local_task_fingerprints (project_key, task_id, fingerprint) values (?, ?, ?) on conflict(project_key, task_id) do update set fingerprint = excluded.fingerprint")
      .run(projectKey, taskId, fingerprint);
  }

  localTaskBaseline(projectKey, taskId) {
    const row = this.db.prepare("select fields_json from team_local_task_baselines where project_key = ? and task_id = ?").get(projectKey, taskId);
    return row ? JSON.parse(row.fields_json) : null;
  }

  saveLocalTaskBaseline(projectKey, taskId, fields) {
    this.db.prepare("insert into team_local_task_baselines (project_key, task_id, fields_json) values (?, ?, ?) on conflict(project_key, task_id) do update set fields_json = excluded.fields_json")
      .run(projectKey, taskId, safeJson({ title: fields.title, status: fields.status }));
  }

  replaceSourceFacts(workspaceId, sourceId, revision, partitions) {
    requireUuid(workspaceId, "workspaceId");
    if (!/^src_[A-Za-z0-9_-]{8,100}$/.test(sourceId) || !/^[0-9a-f]{40}$/.test(revision) ||
        !Array.isArray(partitions) || partitions.length > 200) throw new Error("Invalid source fact scope");
    for (const partition of partitions) {
      if (!validateSourceFactPartition(partition) || (partition.sourceBindingId ?? partition.source_id) !== sourceId ||
          (partition.revision ?? partition.revision_commit) !== revision ||
          partition.workspaceId && partition.workspaceId !== workspaceId)
        throw new Error("Source fact partition failed integrity or scope validation");
    }
    transaction(this.db, () => {
      this.db.prepare("delete from team_source_fact_cache where workspace_id = ? and source_id = ? and revision_commit = ?")
        .run(workspaceId, sourceId, revision);
      const insert = this.db.prepare("insert into team_source_fact_cache(workspace_id,source_id,revision_commit,path,payload_json) values(?,?,?,?,?)");
      for (const partition of partitions) insert.run(workspaceId, sourceId, revision, partition.path, safeJson(partition));
    });
    return partitions.length;
  }

  sourceFacts(workspaceId, sourceId, revision) {
    requireUuid(workspaceId, "workspaceId");
    if (!/^src_[A-Za-z0-9_-]{8,100}$/.test(sourceId) || !/^[0-9a-f]{40}$/.test(revision)) throw new Error("Invalid source fact scope");
    return this.db.prepare("select payload_json from team_source_fact_cache where workspace_id = ? and source_id = ? and revision_commit = ? order by path")
      .all(workspaceId, sourceId, revision).map(row => JSON.parse(row.payload_json));
  }

  clearSourceFacts(workspaceId, sourceId) {
    requireUuid(workspaceId, "workspaceId");
    if (!/^src_[A-Za-z0-9_-]{8,100}$/.test(sourceId)) throw new Error("Invalid source fact scope");
    this.db.prepare("delete from team_source_fact_cache where workspace_id = ? and source_id = ?").run(workspaceId, sourceId);
  }

  enqueue(input) {
    if (!object(input) || input.schemaVersion !== 1) throw new Error("Unsupported team operation envelope");
    for (const field of ["operationId", "organizationId", "workspaceId", "deviceId", "actorId"]) requireUuid(input[field], field);
    const supported = (input.entityType === "task" && ["upsert", "patch", "context"].includes(input.action))
      || (["decision", "evidence", "comment", "receipt"].includes(input.entityType) && input.action === "append")
      || (input.entityType === "graph_edge" && input.action === "review" && requireUuid(input.payload?.edgeId, "edgeId") && typeof input.payload?.confirmed === "boolean" && input.baseVersion > 0);
    if (!supported || !object(input.payload)) throw new Error("Unsupported team operation");
    if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) throw new Error("Invalid operation base version");
    const payload = safeJson(input.payload);
    if (payload.length > 65536) throw new Error("Operation payload is too large");
    const existing = this.operation(input.operationId);
    if (existing) {
      if (existing.organization_id !== input.organizationId || existing.workspace_id !== input.workspaceId || existing.device_id !== input.deviceId || existing.actor_id !== input.actorId || existing.entity_type !== input.entityType || existing.action !== input.action || existing.base_version !== input.baseVersion || existing.payload_json !== payload) throw new Error("Operation ID was already used for a different write");
      return existing;
    }
    const createdAt = new Date().toISOString();
    this.db.prepare("insert or ignore into sync_outbox (operation_id, organization_id, workspace_id, device_id, actor_id, entity_type, action, base_version, payload_json, created_at, next_attempt_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.operationId, input.organizationId, input.workspaceId, input.deviceId, input.actorId, input.entityType, input.action, input.baseVersion, payload, createdAt, createdAt);
    return this.operation(input.operationId);
  }

  operation(operationId) {
    requireUuid(operationId, "operationId");
    const row = this.db.prepare("select * from sync_outbox where operation_id = ?").get(operationId);
    return row ? { ...row, payload: JSON.parse(row.payload_json) } : null;
  }

  dueOperations(limit = 50, now = new Date().toISOString()) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Batch limit must be 1–100");
    return this.db.prepare("select * from sync_outbox where status = 'pending' and next_attempt_at <= ? order by created_at, operation_id limit ?")
      .all(now, limit).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }

  dueOperationsFor(organizationId, limit = 50, now = new Date().toISOString()) {
    requireUuid(organizationId, "organizationId");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Batch limit must be 1–100");
    return this.db.prepare("select * from sync_outbox where organization_id = ? and status = 'pending' and next_attempt_at <= ? order by created_at, operation_id limit ?")
      .all(organizationId, now, limit).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }

  markAccepted(operationId) {
    requireUuid(operationId, "operationId");
    this.db.prepare("update sync_outbox set status = 'accepted', last_error = null where operation_id = ? and status <> 'accepted'").run(operationId);
    return this.operation(operationId);
  }

  markRetry(operationId, error, now = Date.now()) {
    requireUuid(operationId, "operationId");
    const current = this.operation(operationId);
    if (!current || current.status !== "pending") return current;
    const attempts = current.attempts + 1;
    const delay = Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 8));
    this.db.prepare("update sync_outbox set attempts = ?, next_attempt_at = ?, last_error = ? where operation_id = ? and status = 'pending'")
      .run(attempts, new Date(now + delay).toISOString(), String(error ?? "Sync failed").slice(0, 500), operationId);
    return this.operation(operationId);
  }

  markConflict(operationId, detail) {
    requireUuid(operationId, "operationId");
    this.db.prepare("update sync_outbox set status = 'conflict', last_error = ? where operation_id = ? and status = 'pending'").run(String(detail ?? "Conflict").slice(0, 500), operationId);
    return this.operation(operationId);
  }

  cursor(organizationId) {
    requireUuid(organizationId, "organizationId");
    return Number(this.db.prepare("select cursor from sync_cursors where organization_id = ?").get(organizationId)?.cursor ?? 0);
  }

  applyRemotePage(organizationId, events, nextCursor) {
    requireUuid(organizationId, "organizationId");
    if (!Array.isArray(events) || events.length > 500 || !Number.isSafeInteger(nextCursor) || nextCursor < 0) throw new Error("Invalid change page");
    return transaction(this.db, () => {
      let cursor = this.cursor(organizationId);
      for (const event of events) {
        if (!object(event) || !Number.isSafeInteger(event.sequence) || event.sequence <= cursor || !["created", "updated", "deleted"].includes(event.eventType) || !SYNC_ENTITY_TYPES.includes(event.entityType)) throw new Error("Change page is reordered or invalid");
        requireUuid(event.entityId, "entityId");
        if (event.eventType === "deleted") {
          this.db.prepare("insert into sync_entities (organization_id, entity_type, entity_id, payload_json, deleted, sequence) values (?, ?, ?, '{}', 1, ?) on conflict (organization_id, entity_type, entity_id) do update set payload_json = '{}', deleted = 1, sequence = excluded.sequence")
            .run(organizationId, event.entityType, event.entityId, event.sequence);
        } else {
          if (!object(event.payload)) throw new Error("A change payload is required");
          this.db.prepare("insert into sync_entities (organization_id, entity_type, entity_id, payload_json, deleted, sequence) values (?, ?, ?, ?, 0, ?) on conflict (organization_id, entity_type, entity_id) do update set payload_json = excluded.payload_json, deleted = 0, sequence = excluded.sequence")
            .run(organizationId, event.entityType, event.entityId, safeJson(event.payload), event.sequence);
        }
        cursor = event.sequence;
      }
      if (cursor !== nextCursor) throw new Error("Change cursor does not match the page");
      this.db.prepare("insert into sync_cursors (organization_id, cursor) values (?, ?) on conflict (organization_id) do update set cursor = excluded.cursor").run(organizationId, cursor);
      return cursor;
    });
  }

  replaceSnapshot(organizationId, entities, cursor) {
    requireUuid(organizationId, "organizationId");
    if (!Array.isArray(entities) || entities.length > 10_000 || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid team snapshot");
    return transaction(this.db, () => {
      this.db.prepare("delete from sync_entities where organization_id = ?").run(organizationId);
      const insert = this.db.prepare("insert into sync_entities (organization_id, entity_type, entity_id, payload_json, deleted, sequence) values (?, ?, ?, ?, ?, ?)");
      for (const entity of entities) {
        if (!object(entity) || !SYNC_ENTITY_TYPES.includes(entity.entityType)) throw new Error("Invalid snapshot entity");
        requireUuid(entity.entityId, "entityId");
        insert.run(organizationId, entity.entityType, entity.entityId, safeJson(entity.payload ?? {}), entity.deleted ? 1 : 0, cursor);
      }
      this.db.prepare("insert into sync_cursors (organization_id, cursor) values (?, ?) on conflict (organization_id) do update set cursor = excluded.cursor").run(organizationId, cursor);
      return cursor;
    });
  }

  clearOrganization(organizationId, reason = "Organization access is unavailable") {
    requireUuid(organizationId, "organizationId");
    return transaction(this.db, () => {
      this.db.prepare("delete from team_source_fact_cache where workspace_id in (select workspace_id from team_project_links where organization_id = ?)")
        .run(organizationId);
      this.db.prepare("delete from sync_entities where organization_id = ?").run(organizationId);
      this.db.prepare("delete from sync_cursors where organization_id = ?").run(organizationId);
      this.db.prepare("update sync_outbox set status = 'conflict', last_error = ? where organization_id = ? and status = 'pending'")
        .run(String(reason).slice(0, 500), organizationId);
    });
  }

  entity(organizationId, entityType, entityId) {
    requireUuid(organizationId, "organizationId"); requireUuid(entityId, "entityId");
    const row = this.db.prepare("select payload_json, deleted, sequence from sync_entities where organization_id = ? and entity_type = ? and entity_id = ?").get(organizationId, entityType, entityId);
    return row ? { payload: JSON.parse(row.payload_json), deleted: Boolean(row.deleted), sequence: row.sequence } : null;
  }

  entities(organizationId, entityType, { includeDeleted = false } = {}) {
    requireUuid(organizationId, "organizationId");
    const query = includeDeleted
      ? "select entity_id, payload_json, deleted, sequence from sync_entities where organization_id = ? and entity_type = ? order by sequence"
      : "select entity_id, payload_json, deleted, sequence from sync_entities where organization_id = ? and entity_type = ? and deleted = 0 order by sequence";
    return this.db.prepare(query).all(organizationId, entityType).map((row) => ({
      entityId: row.entity_id,
      payload: JSON.parse(row.payload_json),
      deleted: Boolean(row.deleted),
      sequence: row.sequence,
    }));
  }

  workspaceEntities(organizationId, workspaceId, entityType, { includeDeleted = false } = {}) {
    return this.entities(organizationId, entityType, { includeDeleted }).filter((e) => {
      const p = e.payload ?? {};
      return p.workspaceId === workspaceId || p.workspace_id === workspaceId;
    });
  }

  cachedWorkspaceProjection(organizationId, workspaceId) {
    requireUuid(organizationId, "organizationId");
    requireUuid(workspaceId, "workspaceId");
    const wsRow = this.entity(organizationId, "workspace", workspaceId);
    const wsPayload = wsRow && !wsRow.deleted ? wsRow.payload : { id: workspaceId, name: "Workspace", mode: "team" };

    const taskEntities = this.workspaceEntities(organizationId, workspaceId, "task");
    const contractEntities = this.workspaceEntities(organizationId, workspaceId, "contract");
    const nodeEntities = this.workspaceEntities(organizationId, workspaceId, "graph_node");
    const edgeEntities = this.workspaceEntities(organizationId, workspaceId, "graph_edge");
    const milestoneEntities = this.workspaceEntities(organizationId, workspaceId, "milestone");

    const projects = wsPayload.projects ?? [];
    return {
      workspace: { id: workspaceId, name: wsPayload.name ?? "Team Workspace", mode: "team", organizationId },
      projects: projects.map((p) => ({
        id: p.projectKey ?? p.id,
        name: p.displayName || p.name || p.repository || p.projectKey || p.id,
        kind: p.repository ? "GitHub repository" : "Local source",
        detail: p.remoteUrl || p.detail || "Source requires shared snapshot or online companion",
        repository: p.repository ?? null,
        remoteUrl: p.remoteUrl ?? null,
        sources: p.sources ?? [],
      })),
      tasks: taskEntities.map((t) => ({
        id: t.entityId,
        externalId: t.payload.externalId ?? t.entityId,
        title: t.payload.title ?? "",
        description: t.payload.description ?? "",
        status: t.payload.status ?? "open",
        version: t.payload.version ?? 0,
        projectId: t.payload.projectKey ?? t.payload.projectId ?? "",
        scope: t.payload.scope ?? [],
        revisionSet: t.payload.revisionSet ?? t.payload.revision_set ?? [],
      })),
      contracts: contractEntities.map((c) => ({
        id: c.entityId,
        projectId: c.payload.projectKey ?? c.payload.projectId ?? "",
        title: c.payload.title ?? `${c.payload.method ?? "API"} ${c.payload.route ?? ""}`.trim(),
        method: c.payload.method ?? "GET",
        route: c.payload.route ?? "",
        evidence: c.payload.evidence ?? "Contract inventory",
      })),
      targets: nodeEntities.map((n) => ({
        id: n.entityId,
        projectId: n.payload.projectKey ?? n.payload.projectId ?? "",
        label: n.payload.label ?? n.payload.nodeKey ?? "Node",
        kind: n.payload.kind ?? "Source",
        source: n.payload.sourceRef ?? `Commit ${n.payload.revisionCommit?.slice(0, 12) ?? ""}`,
      })),
      graph: {
        nodes: nodeEntities.map((n) => ({ id: n.entityId, ...n.payload })),
        edges: edgeEntities.map((e) => ({ id: e.entityId, ...e.payload })),
      },
      milestones: milestoneEntities.map((m) => ({ id: m.entityId, ...m.payload })),
      capabilities: {
        knowledge: "Synchronized local Team cache",
        contracts: "Synchronized contract inventory",
        verify: "Local or authorized CI runner",
        source: "Inspect pinned source via GitHub or companion checkout",
        agents: "Bounded IDE agent handoff available",
        settings: "Manage workspace resources in Team settings",
      },
    };
  }
}

export async function openTeamSyncStore(dataDir, { sourcePath = path.join(dataDir, "workspace.json") } = {}) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "team-sync.sqlite");
  const handle = await fs.open(file, "a", 0o600);
  await handle.close();
  await fs.chmod(file, 0o600);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec(`
      create table if not exists sync_meta (key text primary key, value text not null);
      create table if not exists legacy_workspaces (workspace_id text primary key, manifest_json text not null);
      create table if not exists legacy_tasks (project_id text not null, task_id text not null, title text not null, status text, primary key (project_id, task_id));
      create table if not exists sync_outbox (operation_id text primary key, organization_id text not null, workspace_id text not null, device_id text not null, actor_id text not null, entity_type text not null, action text not null, base_version integer not null, payload_json text not null, status text not null default 'pending' check (status in ('pending','accepted','conflict')), attempts integer not null default 0, next_attempt_at text not null, last_error text, created_at text not null);
      create index if not exists sync_outbox_due_idx on sync_outbox (status, next_attempt_at, created_at);
      create table if not exists sync_cursors (organization_id text primary key, cursor integer not null);
      create table if not exists sync_entities (organization_id text not null, entity_type text not null, entity_id text not null, payload_json text not null, deleted integer not null default 0, sequence integer not null, primary key (organization_id, entity_type, entity_id));
      create table if not exists team_source_fact_cache (workspace_id text not null, source_id text not null, revision_commit text not null, path text not null, payload_json text not null, primary key(workspace_id,source_id,revision_commit,path));
      create table if not exists team_project_links (project_key text primary key, organization_id text not null, workspace_id text not null, connected_at text not null);
      create table if not exists team_local_task_fingerprints (project_key text not null, task_id text not null, fingerprint text not null, primary key (project_key, task_id));
      create table if not exists team_local_task_baselines (project_key text not null, task_id text not null, fields_json text not null, primary key (project_key, task_id));
    `);
    const linkColumns = new Set(db.prepare("pragma table_info(team_project_links)").all().map((column) => column.name));
    if (!linkColumns.has("device_id")) db.exec("alter table team_project_links add column device_id text");
    if (!linkColumns.has("actor_id")) db.exec("alter table team_project_links add column actor_id text");
    const store = new TeamSyncStore(db, file);
    if (store.migrationStatus()) return store;
    let legacy = null;
    const backup = `${sourcePath}.before-team-sync.json`;
    try {
      await fs.access(backup);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        JSON.parse(await fs.readFile(sourcePath, "utf8"));
        const temporary = `${backup}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.copyFile(sourcePath, temporary, fsConstants.COPYFILE_EXCL);
          await fs.chmod(temporary, 0o600);
          const handle = await fs.open(temporary, "r");
          try { await handle.sync(); } finally { await handle.close(); }
          try { await fs.link(temporary, backup); }
          catch (linkError) { if (linkError.code !== "EEXIST") throw linkError; }
        } finally { await fs.unlink(temporary).catch((unlinkError) => { if (unlinkError.code !== "ENOENT") throw unlinkError; }); }
      } catch (sourceError) { if (sourceError.code !== "ENOENT") throw sourceError; }
    }
    try {
      legacy = JSON.parse(await fs.readFile(backup, "utf8"));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    transaction(db, () => {
      for (const group of legacy?.workspaceGroups ?? []) {
        const manifest = exportWorkspaceManifest(legacy, group.id);
        db.prepare("insert or replace into legacy_workspaces (workspace_id, manifest_json) values (?, ?)").run(group.id, safeJson(manifest));
      }
      for (const project of legacy?.projects ?? []) for (const task of project.tasks ?? project.summary?.tasks ?? []) {
        if (typeof task.id === "string" && typeof task.title === "string") db.prepare("insert or replace into legacy_tasks (project_id, task_id, title, status) values (?, ?, ?, ?)").run(project.id, task.id, task.title, task.status ?? null);
      }
      db.prepare("insert into sync_meta (key, value) values ('legacy_imported', ?)").run(new Date().toISOString());
    });
    return store;
  } catch (error) { db.close(); throw error; }
}
