-- Bounded atomic feed, Realtime invalidation, complete collaboration snapshots.
begin;

create or replace function public.apply_team_task_operation(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_device_id uuid,
  p_operation_id uuid,
  p_external_id text,
  p_title text,
  p_description text,
  p_status text,
  p_revision_set jsonb,
  p_base_version bigint
)
returns table (task_id uuid, task_version bigint, change_sequence bigint, was_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_task public.team_tasks%rowtype;
  v_sequence bigint;
  v_created boolean := false;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not exists (
    select 1 from public.team_devices device
    where device.id = p_device_id and device.organization_id = p_organization_id
      and device.user_id = v_actor and device.revoked_at is null
  ) then raise exception 'DEVICE_REVOKED_OR_UNKNOWN' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.team_workspaces workspace
    where workspace.id = p_workspace_id and workspace.organization_id = p_organization_id
      and private.organization_role_for(workspace.organization_id) in ('owner', 'admin', 'developer')
  ) then raise exception 'WORKSPACE_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_base_version < 0 or p_base_version is null or p_external_id !~ '^task_[A-Za-z0-9_-]{4,100}$'
     or char_length(p_title) not between 1 and 500 or p_status not in ('proposed', 'open', 'in_progress', 'blocked', 'completed', 'archived')
     or jsonb_typeof(p_revision_set) <> 'array' then
    raise exception 'INVALID_TASK_OPERATION' using errcode = '22023';
  end if;

  -- Serialize event allocation by organization so a later commit cannot
  -- receive an earlier cursor and disappear behind a client's high-water mark.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text, 0));

  insert into public.team_accepted_operations (organization_id, device_id, operation_id, actor_id)
  values (p_organization_id, p_device_id, p_operation_id, v_actor)
  on conflict (organization_id, operation_id) do nothing;
  if not found then
    select event.entity_id, (event.payload ->> 'version')::bigint, event.sequence
    into task_id, task_version, change_sequence
    from public.team_change_events event
    where event.organization_id = p_organization_id and event.operation_id = p_operation_id;
    if task_id is null then raise exception 'ACCEPTED_OPERATION_EVENT_MISSING' using errcode = '55000'; end if;
    was_duplicate := true;
    return next;
    return;
  end if;

  select * into v_task from public.team_tasks
  where workspace_id = p_workspace_id and external_id = p_external_id for update;
  if not found then
    if p_base_version <> 0 then raise exception 'VERSION_CONFLICT' using errcode = '40001'; end if;
    insert into public.team_tasks (workspace_id, external_id, title, description, status, revision_set, created_by)
    values (p_workspace_id, p_external_id, p_title, coalesce(p_description, ''), p_status, p_revision_set, v_actor)
    returning * into v_task;
    v_created := true;
  else
    if v_task.version <> p_base_version then raise exception 'VERSION_CONFLICT' using errcode = '40001'; end if;
    update public.team_tasks
      set title = p_title, description = coalesce(p_description, ''), status = p_status,
          revision_set = p_revision_set, version = version + 1, updated_at = now()
      where id = v_task.id returning * into v_task;
  end if;

  insert into public.team_change_events (organization_id, workspace_id, operation_id, entity_type, entity_id, event_type, payload)
  values (p_organization_id, p_workspace_id, p_operation_id, 'task', v_task.id,
          case when v_created then 'created' else 'updated' end,
          jsonb_build_object('id', v_task.id, 'workspaceId', v_task.workspace_id, 'externalId', v_task.external_id,
            'title', v_task.title, 'description', v_task.description, 'status', v_task.status,
            'ownerId', v_task.owner_id, 'revisionSet', v_task.revision_set,
            'scope', v_task.scope, 'dependencies', v_task.dependencies,
            'provenance', v_task.provenance, 'version', v_task.version,
            'updatedAt', v_task.updated_at))
  returning sequence into v_sequence;
  task_id := v_task.id;
  task_version := v_task.version;
  change_sequence := v_sequence;
  was_duplicate := false;
  return next;
end;
$$;

create or replace function public.get_team_snapshot(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_snapshot jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if private.organization_role_for(p_organization_id) is null then
    raise exception 'ORGANIZATION_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- The high-water mark and rows are read by one statement under one MVCC
  -- snapshot. An event committed later will remain available to cursor pulls.
  with entities as (
    select 'workspace'::text as entity_type, w.id as entity_id,
      jsonb_build_object('id', w.id, 'organizationId', w.organization_id,
        'name', w.name, 'description', w.description, 'updatedAt', w.updated_at) as payload
    from public.team_workspaces w where w.organization_id = p_organization_id
    union all
    select 'task', t.id,
      jsonb_build_object('id', t.id, 'workspaceId', t.workspace_id,
        'externalId', t.external_id, 'title', t.title, 'description', t.description,
        'status', t.status, 'ownerId', t.owner_id, 'revisionSet', t.revision_set,
        'scope', t.scope, 'dependencies', t.dependencies, 'provenance', t.provenance,
        'version', t.version, 'updatedAt', t.updated_at)
    from public.team_tasks t join public.team_workspaces w on w.id = t.workspace_id
    where w.organization_id = p_organization_id
    union all
    select 'decision', d.id,
      jsonb_build_object('id', d.id, 'workspaceId', d.workspace_id,
        'taskId', d.task_id, 'body', d.body, 'sourceRefs', d.source_refs,
        'supersedesId', d.supersedes_id,
        'createdBy', d.created_by, 'createdAt', d.created_at)
    from public.team_decisions d join public.team_workspaces w on w.id = d.workspace_id
    where w.organization_id = p_organization_id
    union all
    select 'evidence', e.id,
      jsonb_build_object('id', e.id, 'workspaceId', e.workspace_id,
        'taskId', e.task_id, 'kind', e.kind, 'producer', e.producer,
        'revisionSet', e.revision_set, 'payload', e.payload,
        'createdBy', e.created_by, 'createdAt', e.created_at)
    from public.team_evidence e join public.team_workspaces w on w.id = e.workspace_id
    where w.organization_id = p_organization_id
    union all
    select 'comment', c.id,
      jsonb_build_object('id', c.id, 'workspaceId', c.workspace_id,
        'taskId', c.task_id, 'body', c.body, 'createdBy', c.created_by,
        'createdAt', c.created_at)
    from public.team_comments c join public.team_workspaces w on w.id = c.workspace_id
    where w.organization_id = p_organization_id
    union all
    select 'receipt', r.id,
      jsonb_build_object('id', r.id, 'workspaceId', r.workspace_id,
        'taskId', r.task_id, 'result', r.result, 'summary', r.summary,
        'revisionSet', r.revision_set, 'sourceRefs', r.source_refs,
        'createdBy', r.created_by, 'createdAt', r.created_at)
    from public.team_receipts r join public.team_workspaces w on w.id = r.workspace_id
    where w.organization_id = p_organization_id
  ), bounded as (
    select * from entities order by entity_type, entity_id limit 10001
  )
  select jsonb_build_object(
    'cursor', greatest(
      (select coalesce(max(sequence), 0) from public.team_change_events
        where organization_id = p_organization_id),
      (select coalesce(floor_sequence, 0) from public.team_sync_floors
        where organization_id = p_organization_id)),
    'entities', coalesce(jsonb_agg(jsonb_build_object(
      'entityType', b.entity_type, 'entityId', b.entity_id, 'payload', b.payload)
      order by b.entity_type, b.entity_id), '[]'::jsonb))
  into v_snapshot from bounded b;
  if jsonb_array_length(v_snapshot -> 'entities') > 10000 then
    raise exception 'TEAM_SNAPSHOT_TOO_LARGE' using errcode = '54000';
  end if;
  return v_snapshot;
end;
$$;

create function public.get_team_change_page(
  p_organization_id uuid, p_after bigint, p_limit integer default 100
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if private.organization_role_for(p_organization_id) is null then
    raise exception 'ORGANIZATION_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_after < 0 or p_limit not between 1 and 100 then
    raise exception 'INVALID_CHANGE_CURSOR' using errcode = '22023'; end if;
  -- Floor and page are read under one MVCC snapshot, including during pruning.
  with floor as (
    select coalesce((select floor_sequence from public.team_sync_floors
      where organization_id = p_organization_id), 0) as sequence
  ), rows as (
    select e.* from public.team_change_events e
      where e.organization_id = p_organization_id and e.sequence > p_after
      order by e.sequence asc limit p_limit + 1
  ), page as (
    select * from rows order by sequence asc limit p_limit
  )
  select jsonb_build_object('expired', p_after < floor.sequence,
    'events', coalesce((select jsonb_agg(jsonb_build_object(
      'sequence', e.sequence, 'organization_id', e.organization_id,
      'workspace_id', e.workspace_id, 'operation_id', e.operation_id,
      'entity_type', e.entity_type, 'entity_id', e.entity_id,
      'event_type', e.event_type, 'payload', e.payload, 'created_at', e.created_at)
      order by e.sequence) from page e), '[]'::jsonb),
    'nextCursor', coalesce((select max(sequence) from page), p_after),
    'hasMore', (select count(*) > p_limit from rows))
    into v_result from floor;
  return v_result;
end;
$$;
revoke all on function public.get_team_change_page(uuid,bigint,integer) from public, anon;
grant execute on function public.get_team_change_page(uuid,bigint,integer) to authenticated;

alter publication supabase_realtime add table public.team_change_events;

commit;
