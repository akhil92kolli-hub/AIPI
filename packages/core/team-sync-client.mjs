const fail = (message, status) => Object.assign(new Error(message), { status });

function legacyTaskPatch(store, operation) {
  const payload = operation.payload;
  if (operation.base_version === 0 || payload.description || payload.revisionSet?.length)
    return {title:payload.title,description:payload.description ?? "",status:payload.status ?? "open",revisionSet:payload.revisionSet ?? []};
  const rows = store.db.prepare("select payload_json from sync_entities where organization_id = ? and entity_type = 'task' and deleted = 0")
    .all(operation.organization_id);
  const cloud = rows.map((row) => JSON.parse(row.payload_json)).find((row) => row.workspaceId === operation.workspace_id && row.externalId === payload.externalId);
  if (!cloud || cloud.version !== operation.base_version)
    throw fail("Legacy task write needs review against the current cloud version", 409);
  const titleChanged = payload.title !== cloud.title;
  const statusChanged = payload.status !== undefined && payload.status !== cloud.status;
  if (titleChanged && statusChanged)
    throw fail("Legacy task write changed two fields without a safe baseline", 409);
  return titleChanged ? {title:payload.title} : {status:payload.status ?? cloud.status};
}

async function responseJson(response) {
  let value;
  try { value = await response.json(); } catch { value = {}; }
  if (!response.ok) throw fail(value.error || `Team API returned HTTP ${response.status}`, response.status);
  return value;
}

// Source facts use a separate explicit pull because the organization cursor
// cannot express per-repository GitHub grants. A denied pull evicts cached
// facts for that source before callers can reuse them.
export async function syncSourceFactsOnce(store, {baseUrl,accessToken,githubUserToken,workspaceId,sourceBindingId,revision,fetchImpl=fetch}) {
  if(!/^https:\/\//.test(baseUrl) || !accessToken || !githubUserToken ||
      !/^[0-9a-f-]{36}$/i.test(workspaceId ?? '') || !/^src_[A-Za-z0-9_-]{8,100}$/.test(sourceBindingId ?? '') ||
      !/^[0-9a-f]{40}$/.test(revision ?? '')) throw new Error('A pinned source and authenticated Team session are required');
  const url=`${baseUrl.replace(/\/$/,'')}/api/team/workspaces/${workspaceId}/sources/${sourceBindingId}/facts/list`;
  try {
    const data=await responseJson(await fetchImpl(url,{method:'POST',headers:{authorization:`Bearer ${accessToken}`,
      'content-type':'application/json'},body:JSON.stringify({githubUserToken,revision}),signal:AbortSignal.timeout(15_000)}));
    if(!Array.isArray(data.partitions))throw new Error('Source fact response is incomplete');
    return store.replaceSourceFacts(workspaceId,sourceBindingId,revision,data.partitions);
  } catch(error) {
    if([401,403,404].includes(error.status))store.clearSourceFacts(workspaceId,sourceBindingId);
    throw error;
  }
}

// One bounded pass. The caller schedules retries; operation IDs make a lost
// acknowledgment safe to resend without duplicating a server-side task write.
export async function syncTeamOnce(store, { baseUrl, accessToken, organizationId, fetchImpl = fetch, batchSize = 50, maxPages = 5, now = Date.now() }) {
  if (!/^https:\/\//.test(baseUrl) || !accessToken) throw new Error("A secure team endpoint and user session are required");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error("Invalid sync bounds");
  const root = baseUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  const result = { accepted: 0, duplicates: 0, conflicts: 0, retried: 0, pulled: 0, snapshots: 0, cursor: store.cursor(organizationId), error: null };
  const expiredCursors = new Set();
  for (const operation of store.dueOperationsFor(organizationId, batchSize, new Date(now).toISOString())) {
    try {
      const isGraphEdgeReview = operation.entity_type === "graph_edge" && operation.action === "review";
      const endpoint = operation.entity_type === "task"
        ? ["upsert", "patch"].includes(operation.action) ? "task" : operation.action === "context" ? "task-context" : null
        : operation.action === "append" && ["decision", "evidence", "comment", "receipt"].includes(operation.entity_type) ? "append"
        : isGraphEdgeReview ? "graph" : null;
      if (!endpoint) throw fail("Unsupported outbox operation", 422);

      let url;
      let body;
      const common = { schemaVersion: 1, operationId: operation.operation_id, deviceId: operation.device_id };
      if (isGraphEdgeReview) {
        url = `${root}/api/team/workspaces/${operation.workspace_id}/graph/edges/${operation.payload.edgeId}/review`;
        body = { ...common, baseVersion: operation.base_version, confirm: operation.payload.confirmed };
      } else {
        url = `${root}/api/team/organizations/${organizationId}/workspaces/${operation.workspace_id}/operations/${endpoint}`;
        body = endpoint === "task"
          ? { ...common, externalId: operation.payload.externalId,
            ...(operation.payload.projectKey ? {projectKey:operation.payload.projectKey} : {}),
            patch: operation.action === "patch" ? operation.payload.patch : legacyTaskPatch(store, operation),
            baseVersion: operation.base_version }
          : endpoint === "task-context"
            ? { ...common, taskId: operation.payload.taskId, baseVersion: operation.base_version,
              ownerId: operation.payload.ownerId ?? null, scope: operation.payload.scope ?? [],
              dependencies: operation.payload.dependencies ?? [], provenance: operation.payload.provenance ?? {} }
            : { ...common, payload: { entityType: operation.entity_type, ...operation.payload } };
      }

      const response = await fetchImpl(url, {
        method: "POST", headers, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(body),
      });
      const data = await responseJson(response);
      if (isGraphEdgeReview) {
        if (data.review?.id !== operation.payload.edgeId || data.review?.operationId !== operation.operation_id ||
            data.review?.version !== operation.base_version + 1 ||
            data.review?.confirmationState !== (operation.payload.confirmed ? "confirmed" : "rejected"))
          throw new Error("Graph review acknowledgment is incomplete");
        store.markAccepted(operation.operation_id);
        result.accepted += 1;
        if (data.review.wasDuplicate) result.duplicates += 1;
      } else {
        if (!(data.accepted?.task_id || data.accepted?.entity_id) || !Number.isSafeInteger(data.accepted.change_sequence)) throw new Error("Server acknowledgment is incomplete");
        store.markAccepted(operation.operation_id);
        result.accepted += 1;
        if (data.accepted.was_duplicate) result.duplicates += 1;
      }
    } catch (error) {
      if ([400, 403, 409, 422].includes(error.status)) { store.markConflict(operation.operation_id, error.message); result.conflicts += 1; result.error = error.message; }
      else { store.markRetry(operation.operation_id, error.message, now); result.retried += 1; result.error = error.message; }
    }
  }
  if (result.cursor === 0) {
    try {
      const snapshot = await responseJson(await fetchImpl(`${root}/api/team/organizations/${organizationId}/snapshot`, {
        headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(15_000),
      }));
      result.cursor = store.replaceSnapshot(organizationId, snapshot.entities, snapshot.cursor);
      result.snapshots += 1;
    } catch (error) {
      if (error.status === 403) store.clearOrganization(organizationId, error.message);
      result.error = error.message; return result;
    }
  }
  for (let page = 0; page < maxPages; page += 1) {
    try {
      const url = `${root}/api/team/organizations/${organizationId}/changes?after=${result.cursor}&limit=100`;
      const data = await responseJson(await fetchImpl(url, { headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(15_000) }));
      const events = (data.events ?? []).map((entry) => ({ sequence: entry.sequence, entityType: entry.entity_type, entityId: entry.entity_id, eventType: entry.event_type, payload: entry.payload }));
      result.cursor = store.applyRemotePage(organizationId, events, data.nextCursor);
      result.pulled += events.length;
      if (!data.hasMore) break;
      if (!events.length) throw new Error("Change feed reported more pages without events");
    } catch (error) {
      if (error.status === 410) {
        try {
          if (expiredCursors.has(result.cursor)) throw new Error("Snapshot did not advance the expired cursor");
          expiredCursors.add(result.cursor);
          const snapshot = await responseJson(await fetchImpl(`${root}/api/team/organizations/${organizationId}/snapshot`, {
            headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(15_000),
          }));
          result.cursor = store.replaceSnapshot(organizationId, snapshot.entities, snapshot.cursor);
          result.snapshots += 1;
          continue;
        } catch (snapshotError) {
          if (snapshotError.status === 403) store.clearOrganization(organizationId, snapshotError.message);
          result.error = snapshotError.message; break;
        }
      }
      if (error.status === 403) store.clearOrganization(organizationId, error.message);
      result.error = error.message; break;
    }
  }
  return result;
}
