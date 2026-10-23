-- Reject a reused task operation ID when its request differs from the accepted write.
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
  v_fingerprint text;
  v_existing text;
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

  v_fingerprint := pg_catalog.md5(p_workspace_id::text || ':' || p_external_id || ':' ||
    p_base_version::text || ':' || p_title || ':' || coalesce(p_description, '') || ':' ||
    p_status || ':' || p_revision_set::text);

  -- Serialize event allocation by organization so a later commit cannot
  -- receive an earlier cursor and disappear behind a client's high-water mark.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text, 0));

  insert into public.team_accepted_operations (organization_id, device_id, operation_id, actor_id, request_fingerprint)
  values (p_organization_id, p_device_id, p_operation_id, v_actor, v_fingerprint)
  on conflict (organization_id, operation_id) do nothing;
  if not found then
    select a.request_fingerprint into v_existing from public.team_accepted_operations a
      where a.organization_id = p_organization_id and a.operation_id = p_operation_id;
    if v_existing is not null and v_existing is distinct from v_fingerprint then
      raise exception 'OPERATION_ID_REUSED' using errcode = '40001'; end if;
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

commit;
