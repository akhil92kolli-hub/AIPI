-- Retain acknowledgments independently from a bounded, prefix-pruned event log.
begin;

alter table public.team_accepted_operations
  add column ack_entity_type text,
  add column ack_entity_id uuid,
  add column ack_version bigint,
  add column ack_sequence bigint;
update public.team_accepted_operations a set
  ack_entity_type = e.entity_type,
  ack_entity_id = e.entity_id,
  ack_version = nullif(e.payload ->> 'version', '')::bigint,
  ack_sequence = e.sequence
from public.team_change_events e
where e.organization_id = a.organization_id and e.operation_id = a.operation_id;

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
    select a.ack_entity_id, a.ack_version, a.ack_sequence
    into task_id, task_version, change_sequence
    from public.team_accepted_operations a
    where a.organization_id = p_organization_id and a.operation_id = p_operation_id
      and a.ack_entity_type = 'task';
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
  update public.team_accepted_operations set ack_entity_type = 'task',
    ack_entity_id = v_task.id, ack_version = v_task.version, ack_sequence = v_sequence
    where organization_id = p_organization_id and operation_id = p_operation_id;
  task_id := v_task.id;
  task_version := v_task.version;
  change_sequence := v_sequence;
  was_duplicate := false;
  return next;
end;
$$;


create or replace function public.apply_team_append_operation(
  p_organization_id uuid, p_workspace_id uuid, p_device_id uuid,
  p_operation_id uuid, p_entity_type text, p_payload jsonb
)
returns table (entity_id uuid, change_sequence bigint, was_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_task uuid;
  v_fingerprint text;
  v_existing text;
  v_payload jsonb;
  v_supersedes uuid;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not exists (select 1 from public.team_devices d where d.id = p_device_id
    and d.organization_id = p_organization_id and d.user_id = v_actor and d.revoked_at is null) then
    raise exception 'DEVICE_REVOKED_OR_UNKNOWN' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_workspaces w where w.id = p_workspace_id
    and w.organization_id = p_organization_id
    and private.organization_role_for(w.organization_id) in ('owner', 'admin', 'developer')) then
    raise exception 'WORKSPACE_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_entity_type not in ('decision', 'evidence', 'comment', 'receipt')
    or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 65536 then
    raise exception 'INVALID_APPEND_OPERATION' using errcode = '22023'; end if;
  if p_payload ? 'taskId' and nullif(p_payload ->> 'taskId', '') is not null then
    v_task := (p_payload ->> 'taskId')::uuid;
    if not exists (select 1 from public.team_tasks t where t.id = v_task and t.workspace_id = p_workspace_id) then
      raise exception 'TASK_OUTSIDE_WORKSPACE' using errcode = '42501'; end if;
  end if;
  if p_entity_type in ('comment', 'receipt') and v_task is null then
    raise exception 'TASK_REQUIRED' using errcode = '22023'; end if;
  v_fingerprint := pg_catalog.md5(p_entity_type || ':' || p_workspace_id::text || ':' || p_payload::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text, 0));
  insert into public.team_accepted_operations
    (organization_id, device_id, operation_id, actor_id, request_fingerprint)
  values (p_organization_id, p_device_id, p_operation_id, v_actor, v_fingerprint)
  on conflict (organization_id, operation_id) do nothing;
  if not found then
    select a.request_fingerprint into v_existing from public.team_accepted_operations a
      where a.organization_id = p_organization_id and a.operation_id = p_operation_id;
    if v_existing is distinct from v_fingerprint then
      raise exception 'OPERATION_ID_REUSED' using errcode = '40001'; end if;
    select a.ack_entity_id, a.ack_sequence into entity_id, change_sequence
      from public.team_accepted_operations a where a.organization_id = p_organization_id
        and a.operation_id = p_operation_id and a.ack_entity_type = p_entity_type;
    if entity_id is null then raise exception 'ACCEPTED_OPERATION_EVENT_MISSING' using errcode = '55000'; end if;
    was_duplicate := true;
    return next;
    return;
  end if;

  if p_entity_type = 'decision' then
    if char_length(trim(coalesce(p_payload ->> 'body', ''))) not between 1 and 16000
      or jsonb_typeof(coalesce(p_payload -> 'sourceRefs', '[]'::jsonb)) <> 'array' then
      raise exception 'INVALID_DECISION' using errcode = '22023'; end if;
    v_supersedes := nullif(p_payload ->> 'supersedesId', '')::uuid;
    if v_supersedes is not null and not exists (select 1 from public.team_decisions d
      where d.id = v_supersedes and d.workspace_id = p_workspace_id and d.task_id is not distinct from v_task) then
      raise exception 'INVALID_SUPERSEDED_DECISION' using errcode = '22023'; end if;
    insert into public.team_decisions (workspace_id, task_id, body, source_refs, supersedes_id, created_by)
      values (p_workspace_id, v_task, p_payload ->> 'body', coalesce(p_payload -> 'sourceRefs', '[]'::jsonb), v_supersedes, v_actor)
      returning id into entity_id;
    select jsonb_build_object('id', d.id, 'workspaceId', d.workspace_id, 'taskId', d.task_id,
      'body', d.body, 'sourceRefs', d.source_refs, 'supersedesId', d.supersedes_id,
      'createdBy', d.created_by, 'createdAt', d.created_at)
      into v_payload from public.team_decisions d where d.id = entity_id;
  elsif p_entity_type = 'evidence' then
    if p_payload ->> 'kind' not in ('declared', 'static', 'runtime', 'verification', 'ai_suggestion')
      or char_length(trim(coalesce(p_payload ->> 'producer', ''))) not between 1 and 160
      or jsonb_typeof(coalesce(p_payload -> 'revisionSet', '[]'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(p_payload -> 'payload', '{}'::jsonb)) <> 'object' then
      raise exception 'INVALID_EVIDENCE' using errcode = '22023'; end if;
    insert into public.team_evidence (workspace_id, task_id, kind, producer, revision_set, payload, created_by)
      values (p_workspace_id, v_task, p_payload ->> 'kind', p_payload ->> 'producer',
        coalesce(p_payload -> 'revisionSet', '[]'::jsonb), coalesce(p_payload -> 'payload', '{}'::jsonb), v_actor)
      returning id into entity_id;
    select jsonb_build_object('id', e.id, 'workspaceId', e.workspace_id, 'taskId', e.task_id,
      'kind', e.kind, 'producer', e.producer, 'revisionSet', e.revision_set,
      'payload', e.payload, 'createdBy', e.created_by, 'createdAt', e.created_at)
      into v_payload from public.team_evidence e where e.id = entity_id;
  elsif p_entity_type = 'comment' then
    if char_length(trim(coalesce(p_payload ->> 'body', ''))) not between 1 and 16000 then
      raise exception 'INVALID_COMMENT' using errcode = '22023'; end if;
    insert into public.team_comments (workspace_id, task_id, body, created_by)
      values (p_workspace_id, v_task, p_payload ->> 'body', v_actor) returning id into entity_id;
    select jsonb_build_object('id', c.id, 'workspaceId', c.workspace_id, 'taskId', c.task_id,
      'body', c.body, 'createdBy', c.created_by, 'createdAt', c.created_at)
      into v_payload from public.team_comments c where c.id = entity_id;
  else
    if p_payload ->> 'result' not in ('passed', 'failed', 'inconclusive')
      or char_length(trim(coalesce(p_payload ->> 'summary', ''))) not between 1 and 4000
      or jsonb_typeof(coalesce(p_payload -> 'revisionSet', '[]'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(p_payload -> 'sourceRefs', '[]'::jsonb)) <> 'array' then
      raise exception 'INVALID_RECEIPT' using errcode = '22023'; end if;
    insert into public.team_receipts (workspace_id, task_id, result, summary, revision_set, source_refs, created_by)
      values (p_workspace_id, v_task, p_payload ->> 'result', p_payload ->> 'summary',
        coalesce(p_payload -> 'revisionSet', '[]'::jsonb),
        coalesce(p_payload -> 'sourceRefs', '[]'::jsonb), v_actor) returning id into entity_id;
    select jsonb_build_object('id', r.id, 'workspaceId', r.workspace_id, 'taskId', r.task_id,
      'result', r.result, 'summary', r.summary, 'revisionSet', r.revision_set,
      'sourceRefs', r.source_refs, 'createdBy', r.created_by, 'createdAt', r.created_at)
      into v_payload from public.team_receipts r where r.id = entity_id;
  end if;
  insert into public.team_change_events
    (organization_id, workspace_id, operation_id, entity_type, entity_id, event_type, payload)
    values (p_organization_id, p_workspace_id, p_operation_id, p_entity_type, entity_id, 'created', v_payload)
    returning sequence into change_sequence;
  update public.team_accepted_operations set ack_entity_type = p_entity_type,
    ack_entity_id = entity_id, ack_sequence = change_sequence
    where organization_id = p_organization_id and operation_id = p_operation_id;
  was_duplicate := false;
  return next;
end;
$$;

create or replace function public.apply_team_task_context_operation(
  p_organization_id uuid, p_workspace_id uuid, p_device_id uuid,
  p_operation_id uuid, p_task_id uuid, p_base_version bigint,
  p_owner_id uuid, p_scope jsonb, p_dependencies jsonb, p_provenance jsonb
)
returns table (task_id uuid, task_version bigint, change_sequence bigint, was_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_task public.team_tasks%rowtype;
  v_fingerprint text;
  v_existing text;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not exists (select 1 from public.team_devices d where d.id = p_device_id
    and d.organization_id = p_organization_id and d.user_id = v_actor and d.revoked_at is null) then
    raise exception 'DEVICE_REVOKED_OR_UNKNOWN' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_workspaces w where w.id = p_workspace_id
    and w.organization_id = p_organization_id
    and private.organization_role_for(w.organization_id) in ('owner', 'admin', 'developer')) then
    raise exception 'WORKSPACE_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_base_version < 1 or jsonb_typeof(p_scope) <> 'array'
    or jsonb_typeof(p_dependencies) <> 'array' or jsonb_typeof(p_provenance) <> 'object'
    or jsonb_array_length(p_scope) > 32 or jsonb_array_length(p_dependencies) > 100
    or octet_length(p_scope::text) > 16000 or octet_length(p_provenance::text) > 8000 then
    raise exception 'INVALID_TASK_CONTEXT' using errcode = '22023'; end if;
  if p_owner_id is not null and not exists (select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id and m.user_id = p_owner_id) then
    raise exception 'OWNER_OUTSIDE_ORGANIZATION' using errcode = '42501'; end if;
  if exists (select 1 from jsonb_array_elements(p_scope) item
    where jsonb_typeof(item) <> 'object' or coalesce(item ->> 'projectKey', '') !~ '^prj_[A-Za-z0-9_-]{4,100}$'
      or not exists (select 1 from public.team_workspace_projects p
        where p.workspace_id = p_workspace_id and p.project_key = item ->> 'projectKey')) then
    raise exception 'SCOPE_OUTSIDE_WORKSPACE' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_dependencies) dep
    where dep !~ '^task_[A-Za-z0-9_-]{4,100}$') then
    raise exception 'INVALID_DEPENDENCY' using errcode = '22023'; end if;

  v_fingerprint := pg_catalog.md5(p_workspace_id::text || ':' || p_task_id::text || ':' ||
    p_base_version::text || ':' || coalesce(p_owner_id::text, '') || ':' ||
    p_scope::text || ':' || p_dependencies::text || ':' || p_provenance::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text, 0));
  insert into public.team_accepted_operations
    (organization_id, device_id, operation_id, actor_id, request_fingerprint)
  values (p_organization_id, p_device_id, p_operation_id, v_actor, v_fingerprint)
  on conflict (organization_id, operation_id) do nothing;
  if not found then
    select a.request_fingerprint into v_existing from public.team_accepted_operations a
      where a.organization_id = p_organization_id and a.operation_id = p_operation_id;
    if v_existing is distinct from v_fingerprint then
      raise exception 'OPERATION_ID_REUSED' using errcode = '40001'; end if;
    select a.ack_entity_id, a.ack_version, a.ack_sequence
      into task_id, task_version, change_sequence from public.team_accepted_operations a
      where a.organization_id = p_organization_id and a.operation_id = p_operation_id
        and a.ack_entity_type = 'task';
    if task_id is null then raise exception 'ACCEPTED_OPERATION_EVENT_MISSING' using errcode = '55000'; end if;
    was_duplicate := true;
    return next;
    return;
  end if;

  select * into v_task from public.team_tasks where id = p_task_id
    and workspace_id = p_workspace_id for update;
  if not found then raise exception 'TASK_NOT_FOUND' using errcode = '42501'; end if;
  if v_task.version <> p_base_version then raise exception 'VERSION_CONFLICT' using errcode = '40001'; end if;
  update public.team_tasks set owner_id = p_owner_id, scope = p_scope,
    dependencies = p_dependencies, provenance = p_provenance,
    version = version + 1, updated_at = now()
    where id = p_task_id returning * into v_task;
  insert into public.team_change_events
    (organization_id, workspace_id, operation_id, entity_type, entity_id, event_type, payload)
  values (p_organization_id, p_workspace_id, p_operation_id, 'task', v_task.id, 'updated',
    jsonb_build_object('id', v_task.id, 'workspaceId', v_task.workspace_id,
      'externalId', v_task.external_id, 'title', v_task.title, 'description', v_task.description,
      'status', v_task.status, 'ownerId', v_task.owner_id, 'revisionSet', v_task.revision_set,
      'scope', v_task.scope, 'dependencies', v_task.dependencies,
      'provenance', v_task.provenance, 'version', v_task.version,
      'updatedAt', v_task.updated_at)) returning sequence into change_sequence;
  update public.team_accepted_operations set ack_entity_type = 'task',
    ack_entity_id = v_task.id, ack_version = v_task.version, ack_sequence = change_sequence
    where organization_id = p_organization_id and operation_id = p_operation_id;
  task_id := v_task.id;
  task_version := v_task.version;
  was_duplicate := false;
  return next;
end;
$$;

create function public.prune_team_change_events(
  p_organization_id uuid, p_before timestamptz, p_limit integer default 1000
)
returns table (deleted_count integer, floor_sequence bigint)
language plpgsql security definer set search_path = '' as $$
declare v_deleted integer := 0; v_max bigint := 0;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if private.organization_role_for(p_organization_id) not in ('owner', 'admin') then
    raise exception 'RETENTION_ACCESS_DENIED' using errcode = '42501'; end if;
  if p_limit not between 1 and 10000 or p_before is null then
    raise exception 'INVALID_RETENTION_REQUEST' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text, 0));
  -- Only retire a contiguous prefix. A surviving event must never fall below
  -- the floor, even if its created_at is newer than a higher sequence.
  with ordered as (
    select e.sequence, pg_catalog.bool_and(
      e.created_at < least(p_before, now() - interval '30 days')
      and (e.operation_id is null or exists (
        select 1 from public.team_accepted_operations a
        where a.organization_id = p_organization_id and a.operation_id = e.operation_id
          and a.ack_sequence = e.sequence
      ))) over (order by e.sequence rows unbounded preceding) as can_delete
    from (select * from public.team_change_events
      where organization_id = p_organization_id order by sequence limit p_limit) e
  ), removed as (
    delete from public.team_change_events e where e.organization_id = p_organization_id
      and e.sequence in (select sequence from ordered where can_delete)
    returning e.sequence
  ) select count(*)::integer, coalesce(max(sequence), 0)
    into v_deleted, v_max from removed;
  if v_deleted > 0 then
    insert into public.team_sync_floors (organization_id, floor_sequence)
      values (p_organization_id, v_max)
    on conflict (organization_id) do update
      set floor_sequence = greatest(public.team_sync_floors.floor_sequence, excluded.floor_sequence),
          updated_at = now();
  end if;
  deleted_count := v_deleted;
  select coalesce(f.floor_sequence, 0) into floor_sequence
    from public.team_sync_floors f where f.organization_id = p_organization_id;
  floor_sequence := coalesce(floor_sequence, 0);
  return next;
end;
$$;
revoke all on function public.prune_team_change_events(uuid,timestamptz,integer) from public, anon;
grant execute on function public.prune_team_change_events(uuid,timestamptz,integer) to authenticated;

commit;
