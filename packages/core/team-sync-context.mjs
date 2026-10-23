const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveCachedTeamContext(store, organizationId, taskId, limit = 25) {
  if (!UUID.test(organizationId) || !UUID.test(taskId) || !Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("Invalid team context request");
  const task = store.entity(organizationId, "task", taskId);
  if (!task || task.deleted) throw new Error("Task is not available in the local team cache");
  const records = (type) => store.db.prepare(`select payload_json from sync_entities where organization_id = ? and entity_type = ? and deleted = 0 and json_extract(payload_json, '$.taskId') = ? order by sequence desc limit 500`)
    .all(organizationId, type, taskId).map((row) => JSON.parse(row.payload_json));
  const decisions = records("decision");
  const superseded = new Set(decisions.map((entry) => entry.supersedesId).filter(Boolean));
  const currentDecisions = decisions.filter((entry) => !superseded.has(entry.id)).slice(0, limit);
  const freshness = (entry) => ({ ...entry, freshness: JSON.stringify(entry.revisionSet ?? []) === JSON.stringify(task.payload.revisionSet ?? []) ? "current" : "stale" });
  const dependencies = task.payload.dependencies ?? [];
  const unresolvedDependencies = dependencies.filter((externalId) => {
    const row = store.db.prepare("select payload_json from sync_entities where organization_id = ? and entity_type = 'task' and deleted = 0 and json_extract(payload_json, '$.externalId') = ? limit 1")
      .get(organizationId, externalId);
    return !row || JSON.parse(row.payload_json).status !== "completed";
  });
  const workspace = store.entity(organizationId, "workspace", task.payload.workspaceId);
  return {
    task: task.payload, workspace: workspace?.deleted ? null : workspace?.payload ?? null,
    projects: workspace?.deleted ? [] : workspace?.payload?.projects ?? [],
    decisions: currentDecisions, comments: records("comment").slice(0, limit),
    evidence: records("evidence").slice(0, limit).map(freshness),
    receipts: records("receipt").slice(0, limit).map(freshness),
    unresolvedDependencies, changeCursor: store.cursor(organizationId),
    source: "local-team-cache", resolvedAt: new Date().toISOString(),
  };
}
