-- M3 first slice: authenticated, idempotent task writes with one transaction
-- for the domain row, accepted operation, and cursor event.
begin;

alter table public.team_change_events
  add column payload jsonb not null default '{}'::jsonb
  check (jsonb_typeof(payload) = 'object');
create unique index team_change_events_org_operation_idx
  on public.team_change_events (organization_id, operation_id) where operation_id is not null;

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
            'ownerId', v_task.owner_id, 'revisionSet', v_task.revision_set, 'version', v_task.version,
            'updatedAt', v_task.updated_at))
  returning sequence into v_sequence;
  task_id := v_task.id;
  task_version := v_task.version;
  change_sequence := v_sequence;
  was_duplicate := false;
  return next;
end;
$$;
revoke all on function public.apply_team_task_operation(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,bigint) from public, anon;
grant execute on function public.apply_team_task_operation(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,bigint) to authenticated;

commit;
